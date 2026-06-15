import { readFile } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { flagBoolean, flagString, parseArgs } from "./args";
import {
  captureAuth,
  defaultCdpBase,
  detectLegacyArtifacts,
  detectPortCollision,
  getAuthStatus,
  getBrowserSessionStatus,
  hideProCliChromeWindow,
  resetAuthProfile,
  showProCliChromeWindow,
} from "./auth";
import { loadConfig, migrateLegacyDefaultHome, resolvePaths, saveConfig } from "./config";
import {
  ensureDaemonRunning,
  getDaemonStatus,
  runDaemonServer,
  stopDaemon,
  type DaemonClient,
} from "./daemon";
import { DEFAULT_MODEL, DEFAULT_REASONING, REASONING_LEVELS, isReasoningLevel } from "./defaults";
import { EXIT, ProError, toProError } from "./errors";
import { buildEphemeralJob, executeEphemeralJob } from "./executor";
import { JobStore, redactJob } from "./jobs";
import { fetchAccountSummary } from "./limits";
import {
  canonicalModelId,
  listModels,
  modelRequiresSavedConversation,
  modelUsesThinkingEffort,
  NO_REASONING,
} from "./models";
import { runOdds, type AggregateMethod } from "./odds";
import { loadSchema, runStructured } from "./structured";
import type { CliIO } from "./output";
import { writeError, writeSuccess } from "./output";
import { updateProCli } from "./update";

const HELP_TEXT =
  "pro-cli: ChatGPT Pro CLI\nask: direct blocking query, no job DB\nodds: probability of YES, integer 0-100\nlimits: plan + observed counters\njob create --wait: durable blocking query\njob wait: waits until done\nupdate: fast-forward install\nTimeouts: --timeout is the ChatGPT/research task window; Deep Research defaults to 1800000ms (30m) and rejects smaller values. --wait-timeout/--soft-timeout only control local daemon waiting; omit them to wait until terminal.\nUse --json for agents.";
const DEFAULT_RESEARCH_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 10 * 60_000;
const MAX_REQUEST_TIMEOUT_MS = 24 * 60 * 60_000;

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(argv);
  const mode = {
    json: flagBoolean(parsed.flags, "json") || (!flagBoolean(parsed.flags, "no-json") && !io.stdoutIsTTY),
  };

  try {
    const [command, subcommand, ...rest] = parsed.positionals;
    if (flagBoolean(parsed.flags, "version") || command === "version") {
      io.stdout(`pro-cli ${packageJson.version}\n`);
      return EXIT.success;
    }

    if (
      !command ||
      flagBoolean(parsed.flags, "help") ||
      command === "help" ||
      command === "--help"
    ) {
      writeSuccess(io, mode, { text: HELP_TEXT, commands: commandList() });
      return EXIT.success;
    }

    if (command === "update") {
      writeSuccess(io, mode, updateProCli());
      return EXIT.success;
    }

    await migrateLegacyDefaultHome(io.env);
    const config = await loadConfig(io.env);
    const paths = resolvePaths(io.env, config);

    switch (command) {
      case "setup": {
        const auth = await getAuthStatus(paths);
        const port = flagString(parsed.flags, "port") ?? "9222";
        writeSuccess(io, mode, buildSetupGuide(auth, paths.home, port));
        return EXIT.success;
      }
      case "auth": {
        if (subcommand === "status") {
          writeSuccess(io, mode, await getAuthStatus(paths));
          return EXIT.success;
        }
        if (subcommand === "command") {
          writeSuccess(io, mode, buildAuthCommand(paths.home, flagString(parsed.flags, "port") ?? "9222"));
          return EXIT.success;
        }
        if (subcommand === "capture") {
          const cdpBase = defaultCdpBase(flagString(parsed.flags, "port"), flagString(parsed.flags, "cdp"));
          const jsonPath = flagString(parsed.flags, "out") ?? paths.cookieJsonPath;
          const jarPath = flagString(parsed.flags, "jar") ?? paths.cookieJarPath;
          const tokenPath = flagString(parsed.flags, "token-out") ?? paths.sessionTokenPath;
          const status = await captureAuth({
            cdpBase,
            jsonPath,
            jarPath,
            tokenPath,
            dryRun: flagBoolean(parsed.flags, "dry-run"),
          });
          await saveConfig(io.env, {
            ...config,
            cookieJsonPath: jsonPath,
            cookieJarPath: jarPath,
            sessionTokenPath: tokenPath,
          });
          writeSuccess(io, mode, status);
          return EXIT.success;
        }
        if (subcommand === "reset") {
          const port = flagString(parsed.flags, "port") ?? "9222";
          const result = await resetAuthProfile({
            home: paths.home,
            port,
            noBackup: flagBoolean(parsed.flags, "no-backup"),
            noLaunch: flagBoolean(parsed.flags, "no-launch"),
            keepBackups: parseIntegerFlag(parsed.flags, "keep-backups", 5, 0, 100),
          });
          writeSuccess(io, mode, result);
          return EXIT.success;
        }
        if (subcommand === "hide") {
          const cdpBase = defaultCdpBase(flagString(parsed.flags, "port"), flagString(parsed.flags, "cdp"));
          const result = await hideProCliChromeWindow(cdpBase);
          writeSuccess(io, mode, result);
          return EXIT.success;
        }
        if (subcommand === "show") {
          const cdpBase = defaultCdpBase(flagString(parsed.flags, "port"), flagString(parsed.flags, "cdp"));
          const result = await showProCliChromeWindow(cdpBase);
          writeSuccess(io, mode, result);
          return EXIT.success;
        }
        throw invalidArgs("Unknown auth command.", [
          "Use pro-cli auth status, pro-cli auth command, pro-cli auth capture, pro-cli auth reset, pro-cli auth hide, or pro-cli auth show.",
        ]);
      }
      case "models": {
        writeSuccess(io, mode, await listModels({ sessionTokenPath: paths.sessionTokenPath }));
        return EXIT.success;
      }
      case "limits": {
        const cdp = flagString(parsed.flags, "cdp");
        const port = flagString(parsed.flags, "port");
        const cdpBase = cdp || port ? defaultCdpBase(port, cdp) : undefined;
        const account = await fetchAccountSummary(cdpBase);
        const store = await JobStore.open(paths.dbPath);
        try {
          const observed = store.latestLimits();
          writeSuccess(io, mode, {
            account,
            observedLimits: observed,
            note:
              observed.length === 0
                ? "No limits observed yet. Make a pro-cli ask/odds/job call; per-feature counters arrive in the stream metadata."
                : "Per-feature counters captured from the most recent stream that included them. Pro chat throttling is adaptive and not exposed here.",
          });
          return EXIT.success;
        } finally {
          store.close();
        }
      }
      case "ask": {
        const prompt = await promptFromArgs([subcommand, ...rest].filter(Boolean), io.cwd);
        const askModel = resolveModel(flagString(parsed.flags, "model") ?? config.defaultModel ?? DEFAULT_MODEL);
        const askReasoning = resolveRequestReasoning(askModel, parsed.flags, config.defaultReasoning);
        const askOptions = await collectRequestOptions(parsed.flags, io.cwd, ASK_REQUEST_FLAGS, "ask");
        applyModelConversationRequirements(askOptions, parsed.flags, askModel);
        applyModelTimeoutDefaults(askOptions, parsed.flags, askModel);
        const schemaRaw = flagString(parsed.flags, "schema");
        const formatHint = flagString(parsed.flags, "format");
        if (schemaRaw && formatHint) {
          throw invalidArgs("Use --schema or --format, not both.", ["Pick one structured-output flag."]);
        }
        if (schemaRaw || formatHint) {
          const schema = schemaRaw ? await loadSchema(schemaRaw, io.cwd) : undefined;
          const schemaRetries = parseIntegerFlag(parsed.flags, "schema-retries", 1, 0, 5);
          const structured = await runStructured(prompt, {
            schema,
            formatHint,
            retries: schemaRetries,
            runner: async (wrappedPrompt) => {
              const job = buildEphemeralJob({
                prompt: wrappedPrompt,
                model: askModel,
                reasoning: askReasoning,
                options: askOptions,
              });
              const outcome = await executeEphemeralJob(job, paths);
              if (isRecord(outcome.error)) {
                throw new ProError(
                  typeof outcome.error.code === "string" ? outcome.error.code : "STRUCTURED_RUNNER_FAILED",
                  typeof outcome.error.message === "string" ? outcome.error.message : "ChatGPT request failed.",
                  { exitCode: EXIT.upstream },
                );
              }
              return typeof outcome.result === "string" ? outcome.result : "";
            },
          });
          if (flagBoolean(parsed.flags, "json")) {
            writeSuccess(io, { json: true }, {
              parsed: structured.parsed,
              raw: structured.raw,
              attempts: structured.attempts,
            });
          } else {
            io.stdout(`${JSON.stringify(structured.parsed, null, 2)}\n`);
          }
          return EXIT.success;
        }
        const job = buildEphemeralJob({
          prompt,
          model: askModel,
          reasoning: askReasoning,
          options: askOptions,
        });
        const outcome = await executeEphemeralJob(job, paths);
        if (isRecord(outcome.error)) {
          const error = proErrorFromPayload(outcome.error, outcome.exitCode);
          writeError(io, mode, error);
          return error.exitCode;
        }
        writeSuccess(io, mode, outcome);
        return EXIT.success;
      }
      case "odds": {
        const question = await promptFromArgs([subcommand, ...rest].filter(Boolean), io.cwd);
        const samples = parseIntegerFlag(parsed.flags, "samples", 1, 1, 25);
        const parseRetries = parseIntegerFlag(parsed.flags, "parse-retries", 2, 0, 5);
        const aggregate = resolveAggregate(flagString(parsed.flags, "aggregate") ?? "mean");
        const allowFifty = flagBoolean(parsed.flags, "allow-fifty");
        const contextRaw = flagString(parsed.flags, "context");
        const context = contextRaw ? await readMaybeAtFile(contextRaw, io.cwd) : undefined;
        const baseRequestOptions = await collectRequestOptions(
          parsed.flags,
          io.cwd,
          ODDS_REQUEST_FLAGS,
          "odds",
        );
        const oddsModel = resolveModel(flagString(parsed.flags, "model") ?? config.defaultModel ?? DEFAULT_MODEL);
        applyModelConversationRequirements(baseRequestOptions, parsed.flags, oddsModel);
        applyModelTimeoutDefaults(baseRequestOptions, parsed.flags, oddsModel);
        const result = await runOdds({
          question,
          context,
          model: oddsModel,
          reasoning: resolveRequestReasoning(oddsModel, parsed.flags, config.defaultReasoning),
          samples,
          aggregate,
          allowFifty,
          parseRetries,
          baseRequestOptions,
          paths,
        });
        if (flagBoolean(parsed.flags, "json")) {
          writeSuccess(io, { json: true }, {
            probability: result.probability,
            probabilityRaw: result.probabilityRaw,
            samples: result.samples,
            aggregate: result.aggregate,
            parseFailures: result.parseFailures,
            rejectedFifties: result.rejectedFifties,
            allowFifty: result.allowFifty,
            model: result.model,
            reasoning: result.reasoning,
            jobIds: result.jobIds,
            attempts: result.attempts,
          });
        } else {
          io.stdout(`${result.probability}\n`);
        }
        return EXIT.success;
      }
      case "job": {
        if (subcommand === "create") {
          const waitRequested = flagBoolean(parsed.flags, "wait");
          if (!waitRequested && hasWaitOptionFlags(parsed.flags)) {
            throw invalidArgs("Wait options require --wait.", [
              "Use pro-cli job create @prompt.md --wait --soft-timeout <ms> --json.",
            ]);
          }
          if (waitRequested && flagBoolean(parsed.flags, "no-start")) {
            throw invalidArgs("Cannot wait for a job without starting the daemon.", [
              "Remove --no-start or remove --wait.",
            ]);
          }
          const jobSchemaRaw = flagString(parsed.flags, "schema");
          const jobFormatHint = flagString(parsed.flags, "format");
          if (jobSchemaRaw && jobFormatHint) {
            throw invalidArgs("Use --schema or --format, not both.", ["Pick one structured-output flag."]);
          }
          if ((jobSchemaRaw || jobFormatHint) && !waitRequested) {
            throw invalidArgs("Structured output requires --wait.", [
              "Add --wait so retries can read the result, or run pro-cli ask --schema.",
            ]);
          }
          const userPrompt = await promptFromArgs(rest, io.cwd);
          const jobModel = resolveModel(flagString(parsed.flags, "model") ?? config.defaultModel ?? DEFAULT_MODEL);
          const jobOptions = await collectRequestOptions(parsed.flags, io.cwd, JOB_CREATE_FLAGS, "job create");
          applyModelConversationRequirements(jobOptions, parsed.flags, jobModel);
          applyModelTimeoutDefaults(jobOptions, parsed.flags, jobModel);
          const input = {
            prompt: userPrompt,
            model: jobModel,
            reasoning: resolveRequestReasoning(jobModel, parsed.flags, config.defaultReasoning),
            options: jobOptions,
          };
          if (!flagBoolean(parsed.flags, "no-start")) {
            const daemon = await ensureDaemonRunning(paths, io);
            if (waitRequested && (jobSchemaRaw || jobFormatHint)) {
              const schema = jobSchemaRaw ? await loadSchema(jobSchemaRaw, io.cwd) : undefined;
              const schemaRetries = parseIntegerFlag(parsed.flags, "schema-retries", 1, 0, 5);
              const waitOptions = parseWaitOptions(parsed.flags);
              const jobIds: string[] = [];
              const structured = await runStructured(userPrompt, {
                schema,
                formatHint: jobFormatHint,
                retries: schemaRetries,
                runner: async (wrappedPrompt) => {
                  const created = await daemon.client.createJob({ ...input, prompt: wrappedPrompt });
                  const jobId = jobIdFromPayload(created);
                  jobIds.push(jobId);
                  const waitResult = await waitForDaemonJob(paths, io, daemon.client, jobId, waitOptions);
                  const waited = waitResult.payload;
                  if (!isRecord(waited.job) || waited.job.status !== "succeeded") {
                    throw new ProError("STRUCTURED_RUNNER_FAILED", "Job did not reach succeeded status.", {
                      exitCode: EXIT.upstream,
                      details: { jobId, waited },
                    });
                  }
                  const fetched = await waitResult.client.result(jobId);
                  return typeof fetched.result === "string" ? fetched.result : "";
                },
              });
              writeSuccess(io, mode, {
                parsed: structured.parsed,
                raw: structured.raw,
                attempts: structured.attempts,
                jobIds,
                daemon: { started: daemon.started, status: daemon.status },
              });
              return EXIT.success;
            }
            const created = await daemon.client.createJob(input);
            if (waitRequested) {
              const waitOptions = parseWaitOptions(parsed.flags);
              const jobId = jobIdFromPayload(created);
              const waitResult = await waitForDaemonJob(paths, io, daemon.client, jobId, waitOptions);
              const waited = waitResult.payload;
              throwIfTerminalJobFailure(waited, jobId);
              writeSuccess(io, mode, {
                ...waited,
                ...(await resultIfSucceeded(waitResult.client, jobId, waited)),
                daemon: { started: daemon.started, status: daemon.status },
              });
              return EXIT.success;
            }
            writeSuccess(io, mode, {
              ...created,
              daemon: { started: daemon.started, status: daemon.status },
            });
            return EXIT.success;
          }
          const store = await JobStore.open(paths.dbPath);
          try {
            const job = store.create(input);
            writeSuccess(io, mode, { job, daemon: { started: false } });
            return EXIT.success;
          } finally {
            store.close();
          }
        }
        if (subcommand === "status") {
          const jobId = rest[0];
          if (!jobId) throw invalidArgs("Missing job id.", ["Use pro-cli job status <job-id>."]);
          const store = await JobStore.open(paths.dbPath);
          try {
            writeSuccess(io, mode, { job: redactJob(store.get(jobId)) });
            return EXIT.success;
          } finally {
            store.close();
          }
        }
        if (subcommand === "result") {
          const jobId = rest[0];
          if (!jobId) throw invalidArgs("Missing job id.", ["Use pro-cli job result <job-id>."]);
          const store = await JobStore.open(paths.dbPath);
          try {
            const job = store.get(jobId);
            if (job.status !== "succeeded") {
              throw new ProError("JOB_NOT_READY", `Job ${jobId} is ${job.status}.`, {
                exitCode: EXIT.notFound,
                suggestions: ["Run pro-cli job wait <job-id> or pro-cli job status <job-id>."],
              });
            }
            writeSuccess(io, mode, { jobId, result: job.result });
            return EXIT.success;
          } finally {
            store.close();
          }
        }
        if (subcommand === "wait") {
          const jobId = rest[0];
          if (!jobId) throw invalidArgs("Missing job id.", ["Use pro-cli job wait <job-id>."]);
          const waitOptions = parseWaitOptions(parsed.flags);
          const daemon = await ensureDaemonRunning(paths, io);
          const waitResult = await waitForDaemonJob(paths, io, daemon.client, jobId, waitOptions);
          const waited = waitResult.payload;
          throwIfTerminalJobFailure(waited, jobId);
          writeSuccess(io, mode, waited);
          return EXIT.success;
        }
        if (subcommand === "cancel") {
          const jobId = rest[0];
          if (!jobId) throw invalidArgs("Missing job id.", ["Use pro-cli job cancel <job-id>."]);
          const daemon = await ensureDaemonRunning(paths, io);
          writeSuccess(io, mode, await daemon.client.cancel(jobId));
          return EXIT.success;
        }
        if (subcommand === "list") {
          const limit = Number(flagString(parsed.flags, "limit") ?? "20");
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
            throw invalidArgs("Invalid --limit.", ["Use --limit between 1 and 200."]);
          }
          const store = await JobStore.open(paths.dbPath);
          try {
            writeSuccess(io, mode, { jobs: store.list(limit) });
            return EXIT.success;
          } finally {
            store.close();
          }
        }
        throw invalidArgs("Unknown job command.", [
          "Use pro-cli job create, job status, job wait, job result, job cancel, or job list.",
        ]);
      }
      case "daemon": {
        if (subcommand === "serve") {
          await runDaemonServer(paths, {
            port: parseOptionalIntegerFlag(parsed.flags, "port", 0, 65_535),
            pollMs: parseIntegerFlag(parsed.flags, "poll-ms", 500, 25, 60_000),
            idleTimeoutMs: parseOptionalIntegerFlag(parsed.flags, "idle-timeout", 1, 24 * 60 * 60_000),
          });
          return EXIT.success;
        }
        if (subcommand === "start" || subcommand === "restart") {
          if (subcommand === "restart") await stopDaemon(paths);
          const daemon = await ensureDaemonRunning(paths, io);
          writeSuccess(io, mode, { daemon: { started: daemon.started, status: daemon.status } });
          return EXIT.success;
        }
        if (subcommand === "status") {
          writeSuccess(io, mode, { daemon: await getDaemonStatus(paths) });
          return EXIT.success;
        }
        if (subcommand === "stop") {
          writeSuccess(io, mode, { daemon: await stopDaemon(paths) });
          return EXIT.success;
        }
        throw invalidArgs("Unknown daemon command.", [
          "Use pro-cli daemon start, pro-cli daemon status, pro-cli daemon stop, or pro-cli daemon restart.",
        ]);
      }
      case "config": {
        if (subcommand === "get") {
          writeSuccess(io, mode, {
            config,
            defaults: { model: DEFAULT_MODEL, reasoning: DEFAULT_REASONING },
            paths: redactPaths(paths),
          });
          return EXIT.success;
        }
        if (subcommand === "set") {
          const [key, value] = rest;
          if (!key || !value) throw invalidArgs("Missing config key/value.", ["Use pro-cli config set model gpt-5-5-pro."]);
          const next = { ...config };
          if (key === "model") next.defaultModel = resolveModel(value);
          else if (key === "reasoning") next.defaultReasoning = resolveReasoning(value);
          else throw invalidArgs(`Unknown config key ${key}.`, ["Supported keys: model, reasoning."]);
          await saveConfig(io.env, next);
          writeSuccess(io, mode, { config: next });
          return EXIT.success;
        }
        throw invalidArgs("Unknown config command.", ["Use pro-cli config get or pro-cli config set."]);
      }
      case "doctor": {
        const auth = await getAuthStatus(paths);
        const cdpBase = defaultCdpBase(flagString(parsed.flags, "port"), flagString(parsed.flags, "cdp"));
        const browserSession = await getBrowserSessionStatus(
          cdpBase,
          parseIntegerFlag(parsed.flags, "timeout", 3_000, 1, 60_000),
        );
        const authReady = auth.tokenStatus === "present" && auth.accountIdPresent;
        const ready = authReady && browserSession.status === "present";
        const cdpPort = new URL(cdpBase).port || "9222";
        const profileDir = join(paths.home, "chrome-profile");
        writeSuccess(io, mode, {
          auth,
          browserSession,
          daemon: await getDaemonStatus(paths),
          ready,
          next: buildDoctorNext(authReady, browserSession.status, cdpBase),
          portCollision: detectPortCollision(cdpPort, profileDir),
          legacyArtifacts: await detectLegacyArtifacts(),
          storage: { home: paths.home, dbPath: paths.dbPath },
          transport: {
            status: ready ? "configured" : "auth_required",
            endpoint: "https://chatgpt.com/backend-api/f/conversation",
          },
          safety: safetySummary(),
        });
        return EXIT.success;
      }
      default:
        throw invalidArgs(`Unknown command ${command}.`, ["Run pro-cli help."]);
    }
  } catch (error) {
    const proError = toProError(error);
    writeError(io, mode, proError);
    return proError.exitCode;
  }
}

function invalidArgs(message: string, suggestions: string[]): ProError {
  return new ProError("INVALID_ARGS", message, { exitCode: EXIT.invalidArgs, suggestions });
}

function proErrorFromPayload(error: Record<string, unknown>, exitCode: unknown): ProError {
  return new ProError(
    typeof error.code === "string" ? error.code : "UPSTREAM_ERROR",
    typeof error.message === "string" ? error.message : "ChatGPT request failed.",
    {
      exitCode: isExitCode(exitCode) ? exitCode : EXIT.upstream,
      suggestions: Array.isArray(error.suggestions)
        ? error.suggestions.filter((item): item is string => typeof item === "string")
        : [],
      details: isRecord(error.details) ? error.details : undefined,
    },
  );
}

function isExitCode(value: unknown): value is (typeof EXIT)[keyof typeof EXIT] {
  return typeof value === "number" && Object.values(EXIT).includes(value as (typeof EXIT)[keyof typeof EXIT]);
}

function commandList(): string[] {
  return [
    "setup",
    "update",
    "auth command",
    "auth status",
    "auth capture",
    "auth reset",
    "auth hide",
    "auth show",
    "models",
    "ask",
    "odds",
    "limits",
    "job create",
    "job status",
    "job wait",
    "job result",
    "job cancel",
    "job list",
    "daemon start",
    "daemon status",
    "daemon stop",
    "config get",
    "doctor",
  ];
}

function buildDoctorNext(
  authReady: boolean,
  browserStatus: Awaited<ReturnType<typeof getBrowserSessionStatus>>["status"],
  cdpBase: string,
): Record<string, string> {
  if (authReady && browserStatus === "present") {
    return {
      command: `pro-cli ask "<your prompt>" --cdp ${cdpBase} --json`,
      reason: "Stored auth and the live CDP ChatGPT page are ready; send the real request directly.",
    };
  }
  if (authReady && browserStatus === "logged_out") {
    return {
      command: `pro-cli auth capture --cdp ${cdpBase} --json`,
      reason: "The CDP ChatGPT page is reachable but logged out; sign in there, then recapture auth.",
    };
  }
  if (authReady && browserStatus === "probe_failed") {
    return {
      command: `pro-cli auth capture --cdp ${cdpBase} --json`,
      reason:
        "The CDP ChatGPT auth probe returned an unexpected HTTP status (often cookie bloat causing 431); sign out and back in, then recapture auth.",
    };
  }
  if (authReady && (browserStatus === "page_missing" || browserStatus === "cdp_unavailable")) {
    return {
      command: "pro-cli auth command --json",
      reason: "Stored auth exists, but no live ChatGPT CDP page is available.",
    };
  }
  return {
    command: "pro-cli setup --json",
    reason: "Auth is missing or expired; follow the setup steps.",
  };
}

function buildSetupGuide(auth: Awaited<ReturnType<typeof getAuthStatus>>, home: string, port: string): Record<string, unknown> {
  const ready = auth.tokenStatus === "present" && auth.accountIdPresent;
  const authCommand = buildAuthCommand(home, port);
  return {
    ready,
    summary: ready ? "pro-cli is ready to query ChatGPT." : "pro-cli needs a logged-in ChatGPT browser session.",
    steps: [
      {
        id: "install",
        status: "done",
        command: "curl -fsSL https://raw.githubusercontent.com/ratacat/pro-cli/main/scripts/install.sh | bash",
        note: "Clones or updates ~/Projects/pro-cli and links the pro-cli binary.",
      },
      {
        id: "open-chatgpt",
        status: ready ? "done" : "todo",
        command: authCommand.command,
        note: "Starts the dedicated ~/.pro-cli Chrome profile with CDP enabled; keep this window open while pro-cli jobs run.",
      },
      {
        id: "capture-auth",
        status: ready ? "done" : "todo",
        command: authCommand.captureCommand,
        note: "Captures scoped cookies plus the page session token into private local files.",
      },
      {
        id: "doctor",
        status: ready ? "todo" : "blocked",
        command: `pro-cli doctor --cdp ${authCommand.cdp} --json`,
        note: "Checks stored auth and the live CDP ChatGPT page without spending Pro quota.",
      },
    ],
    auth,
    storage: {
      home,
      cookieJsonPath: auth.cookieJsonPath,
      sessionTokenPath: auth.sessionTokenPath,
    },
    safety: safetySummary(),
  };
}

function buildAuthCommand(home: string, port: string): Record<string, unknown> {
  const profileDir = join(home, "chrome-profile");
  const url = "https://chatgpt.com/";
  const cdp = `http://127.0.0.1:${port}`;
  const command =
    process.platform === "darwin"
      ? `open -na "Google Chrome" --args --user-data-dir=${shellQuote(profileDir)} --remote-debugging-port=${port} ${url}`
      : process.platform === "win32"
        ? `start "" chrome.exe --user-data-dir=${windowsQuote(profileDir)} --remote-debugging-port=${port} ${url}`
        : `google-chrome --user-data-dir=${shellQuote(profileDir)} --remote-debugging-port=${port} ${url}`;
  return {
    command,
    captureCommand: `pro-cli auth capture --cdp ${cdp} --json`,
    cdp,
    profileDir,
    port,
    portCollision: detectPortCollision(port, profileDir),
    safety: "Recommended profile is dedicated to pro-cli; keep it open for jobs and do not expose a normal browser profile over CDP.",
  };
}

function safetySummary(): Record<string, unknown> {
  return {
    rawValuesPrinted: false,
    storedLocally: true,
    fileModes: "0600 files, 0700 directories where supported",
    sentTo: ["https://chatgpt.com"],
    reminder: "Cookie and token files are sensitive; do not commit, paste, or share ~/.pro-cli.",
  };
}

async function promptFromArgs(args: string[], cwd: string): Promise<string> {
  const prompt = args.join(" ").trim();
  if (!prompt) throw invalidArgs("Missing prompt.", ["Use pro-cli ask \"prompt\" or pro-cli job create @prompt.md."]);
  if (prompt.startsWith("@") && !prompt.includes(" ")) {
    return readFile(new URL(prompt.slice(1), `file://${cwd}/`), "utf8");
  }
  return prompt;
}

async function collectRequestOptions(
  flags: Map<string, string | boolean | string[]>,
  cwd: string,
  allowedFlags: Set<string>,
  command: string,
): Promise<Record<string, unknown>> {
  rejectUnsupportedFlags(flags, allowedFlags, command);
  const options: Record<string, unknown> = {};
  setStringOption(options, "verbosity", flags, "verbosity", ["low", "medium", "high"]);
  setStringOption(options, "reasoningSummary", flags, "reasoning-summary", [
    "auto",
    "concise",
    "detailed",
    "none",
  ]);
  setStringOption(options, "toolChoice", flags, "tool-choice", ["auto", "none", "required"]);
  setIntegerOption(options, "timeoutMs", flags, "timeout", 1, MAX_REQUEST_TIMEOUT_MS);
  setIntegerOption(options, "retries", flags, "retries", 0, 5);
  setIntegerOption(options, "retryDelayMs", flags, "retry-delay", 0, 60_000);
  setIntegerAliasOption(
    options,
    "condensedResponseTokens",
    flags,
    "condensed-response",
    ["condensed_response"],
    1,
    100_000,
  );
  setBooleanOption(options, "parallelTools", flags, "parallel-tools");
  setConversationOptions(options, flags);
  const cdp = flagString(flags, "cdp");
  const port = flagString(flags, "port");
  if (cdp || port) options.cdpBase = defaultCdpBase(port, cdp);

  const instructions = flagString(flags, "instructions");
  const instructionsFile = flagString(flags, "instructions-file");
  if (instructions && instructionsFile) {
    throw invalidArgs("Use only one instructions source.", ["Pass --instructions or --instructions-file, not both."]);
  }
  if (instructions) {
    options.instructions = await readMaybeAtFile(instructions, cwd);
  }
  if (instructionsFile) {
    options.instructions = await readFile(new URL(instructionsFile, `file://${cwd}/`), "utf8");
  }
  return options;
}

const ASK_REQUEST_FLAGS = new Set([
  "json",
  "no-json",
  "model",
  "reasoning",
  "verbosity",
  "reasoning-summary",
  "tool-choice",
  "parallel-tools",
  "instructions",
  "instructions-file",
  "timeout",
  "retries",
  "retry-delay",
  "condensed-response",
  "condensed_response",
  "store",
  "save",
  "temporary",
  "no-temporary",
  "conversation",
  "parent",
  "cdp",
  "port",
  "schema",
  "format",
  "schema-retries",
]);

const JOB_CREATE_FLAGS = new Set([
  ...ASK_REQUEST_FLAGS,
  "no-start",
  "wait",
  "wait-timeout",
  "soft-timeout",
  "poll-ms",
]);

const ODDS_REQUEST_FLAGS = new Set([
  "json",
  "no-json",
  "model",
  "reasoning",
  "verbosity",
  "reasoning-summary",
  "tool-choice",
  "parallel-tools",
  "timeout",
  "retries",
  "retry-delay",
  "store",
  "save",
  "temporary",
  "no-temporary",
  "conversation",
  "parent",
  "cdp",
  "port",
  "context",
  "samples",
  "aggregate",
  "parse-retries",
  "allow-fifty",
]);

function resolveAggregate(value: string): AggregateMethod {
  if (value === "mean" || value === "median" || value === "trimmed-mean") return value;
  throw invalidArgs("Invalid --aggregate.", ["Allowed values: mean, median, trimmed-mean."]);
}

function setConversationOptions(
  options: Record<string, unknown>,
  flags: Map<string, string | boolean | string[]>,
): void {
  const conversationId = flagString(flags, "conversation");
  const parentMessageId = flagString(flags, "parent");
  if (conversationId || parentMessageId) {
    if (!conversationId || !parentMessageId) {
      throw invalidArgs("Continuing a conversation needs both ids.", [
        "Use --conversation <conversation-id> --parent <message-id>.",
      ]);
    }
    options.conversationId = conversationId;
    options.parentMessageId = parentMessageId;
  }

  const store = readBooleanFlag(flags, "store");
  const save = flagBoolean(flags, "save") || flagBoolean(flags, "no-temporary") || store === true;
  const temporary = flagBoolean(flags, "temporary") || store === false;
  if (save && temporary) {
    throw invalidArgs("Choose either temporary or saved chat mode.", [
      "Use --temporary for a temporary chat or --save for a saved conversation.",
    ]);
  }

  options.temporary = temporary || (!save && !conversationId);
}

function resolveReasoning(reasoning: string): string {
  if (isReasoningLevel(reasoning)) return reasoning;
  throw invalidArgs("Invalid --reasoning.", [`Allowed values: ${REASONING_LEVELS.join(", ")}.`]);
}

function resolveRequestReasoning(
  model: string,
  flags: Map<string, string | boolean | string[]>,
  configuredReasoning?: string,
): string {
  const explicitReasoning = flagString(flags, "reasoning");
  if (!modelUsesThinkingEffort(model)) {
    if (explicitReasoning !== undefined) {
      throw invalidArgs(`Model ${model} does not support --reasoning.`, [
        `Omit --reasoning for ${model}; ChatGPT's model catalog exposes no thinking_effort levels for it.`,
      ]);
    }
    return NO_REASONING;
  }
  return resolveReasoning(explicitReasoning ?? configuredReasoning ?? DEFAULT_REASONING);
}

function applyModelConversationRequirements(
  options: Record<string, unknown>,
  flags: Map<string, string | boolean | string[]>,
  model: string,
): void {
  if (!modelRequiresSavedConversation(model)) return;
  const label = canonicalModelId(model) === "image" ? "Image generation" : "Deep Research";
  const store = readBooleanFlag(flags, "store");
  const requestedTemporary = flagBoolean(flags, "temporary") || store === false;
  if (requestedTemporary) {
    throw invalidArgs(`${label} does not support temporary chats.`, [
      `Remove --temporary or --store false; pro-cli uses a saved ChatGPT conversation for --model ${canonicalModelId(model)}.`,
    ]);
  }
  if (!options.conversationId) options.temporary = false;
}

function applyModelTimeoutDefaults(
  options: Record<string, unknown>,
  flags: Map<string, string | boolean | string[]>,
  model: string,
): void {
  const canonical = canonicalModelId(model);
  if (canonical !== "research" && canonical !== "image") return;
  const explicitTimeout = flagString(flags, "timeout");
  if (canonical === "image") {
    if (explicitTimeout === undefined) {
      options.timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS;
      return;
    }
    return;
  }
  if (explicitTimeout === undefined) {
    options.timeoutMs = DEFAULT_RESEARCH_TIMEOUT_MS;
    return;
  }
  if (typeof options.timeoutMs === "number" && options.timeoutMs >= DEFAULT_RESEARCH_TIMEOUT_MS) return;
  throw invalidArgs("Deep Research --timeout must be at least 1800000ms (30 minutes).", [
    "Omit --timeout to use the 30-minute Deep Research default.",
    "Use --timeout 1800000 or larger for Deep Research.",
    "Use --wait-timeout only to limit how long the local terminal waits; it does not stop the remote research task.",
  ]);
}

function resolveModel(model: string): string {
  const value = canonicalModelId(model);
  if (!value || value === "auto") {
    throw invalidArgs("Invalid --model.", [
      "Use a concrete model id such as gpt-5-5-pro, gpt-4-5, research, or image; or run pro-cli models --json.",
    ]);
  }
  return value;
}

function rejectUnsupportedFlags(
  flags: Map<string, string | boolean | string[]>,
  allowed: Set<string>,
  command: string,
): void {
  for (const key of flags.keys()) {
    if (!allowed.has(key)) {
      throw invalidArgs(`Unsupported --${key} for ${command}.`, [
        "Run pro-cli help or pro-cli models --json for supported request controls.",
      ]);
    }
  }
}

async function readMaybeAtFile(value: string, cwd: string): Promise<string> {
  if (value.startsWith("@") && !value.includes(" ")) {
    return readFile(new URL(value.slice(1), `file://${cwd}/`), "utf8");
  }
  return value;
}

function setStringOption(
  options: Record<string, unknown>,
  target: string,
  flags: Map<string, string | boolean | string[]>,
  source: string,
  allowed?: string[],
): void {
  const value = flagString(flags, source);
  if (value === undefined) return;
  if (allowed && !allowed.includes(value)) {
    throw invalidArgs(`Invalid --${source}.`, [`Allowed values: ${allowed.join(", ")}.`]);
  }
  options[target] = value;
}

function setIntegerOption(
  options: Record<string, unknown>,
  target: string,
  flags: Map<string, string | boolean | string[]>,
  source: string,
  min: number,
  max: number,
): void {
  const value = flagString(flags, source);
  if (value === undefined) return;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw invalidArgs(`Invalid --${source}.`, [`Use an integer between ${min} and ${max}.`]);
  }
  options[target] = number;
}

function setIntegerAliasOption(
  options: Record<string, unknown>,
  target: string,
  flags: Map<string, string | boolean | string[]>,
  primary: string,
  aliases: string[],
  min: number,
  max: number,
): void {
  const names = [primary, ...aliases];
  const present = names
    .map((name) => ({ name, value: flagString(flags, name) }))
    .filter((entry): entry is { name: string; value: string } => entry.value !== undefined);
  if (present.length === 0) return;
  const first = present[0];
  for (const entry of present.slice(1)) {
    if (entry.value !== first.value) {
      throw invalidArgs("Use only one condensed response flag.", [
        `Pass --${primary} <tokens> or --${aliases[0]}=<tokens>, not both.`,
      ]);
    }
  }
  const number = Number(first.value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw invalidArgs(`Invalid --${first.name}.`, [`Use an integer between ${min} and ${max}.`]);
  }
  options[target] = number;
}

function setBooleanOption(
  options: Record<string, unknown>,
  target: string,
  flags: Map<string, string | boolean | string[]>,
  source: string,
): void {
  const parsed = readBooleanFlag(flags, source);
  if (parsed === undefined) return;
  options[target] = parsed;
}

function readBooleanFlag(
  flags: Map<string, string | boolean | string[]>,
  source: string,
): boolean | undefined {
  const value = flagString(flags, source);
  if (value === undefined) return undefined;
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }
  throw invalidArgs(`Invalid --${source}.`, ["Use true or false."]);
}

interface WaitOptions {
  timeoutMs: number;
  pollMs: number;
  softTimeout: boolean;
}

function parseWaitOptions(flags: Map<string, string | boolean | string[]>): WaitOptions {
  const waitTimeout = flagString(flags, "wait-timeout");
  const softTimeout = flagString(flags, "soft-timeout");
  if (waitTimeout !== undefined && softTimeout !== undefined) {
    throw invalidArgs("Choose one wait timeout mode.", [
      "Use --wait-timeout for an error on timeout or --soft-timeout for ok:true polling.",
    ]);
  }
  return {
    timeoutMs:
      softTimeout !== undefined
        ? parseIntegerFlag(flags, "soft-timeout", 0, 1, 24 * 60 * 60_000)
        : parseIntegerFlag(flags, "wait-timeout", 0, 0, 24 * 60 * 60_000),
    pollMs: parseIntegerFlag(flags, "poll-ms", 500, 25, 60_000),
    softTimeout: softTimeout !== undefined,
  };
}

function hasWaitOptionFlags(flags: Map<string, string | boolean | string[]>): boolean {
  return (
    flagString(flags, "wait-timeout") !== undefined ||
    flagString(flags, "soft-timeout") !== undefined ||
    flagString(flags, "poll-ms") !== undefined
  );
}

async function waitForDaemonJob(
  paths: ReturnType<typeof resolvePaths>,
  io: CliIO,
  initialClient: DaemonClient,
  jobId: string,
  options: WaitOptions,
): Promise<{ payload: Record<string, unknown>; client: DaemonClient }> {
  const startedAt = Date.now();
  let client = initialClient;
  while (true) {
    const timeoutMs = remainingWaitTimeout(options.timeoutMs, startedAt);
    try {
      const payload = await client.wait(jobId, timeoutMs, options.pollMs, options.softTimeout);
      return { payload, client };
    } catch (error) {
      if (!isDaemonUnavailable(error)) throw error;
      if (options.timeoutMs > 0 && Date.now() - startedAt >= options.timeoutMs) throw error;
      await sleep(100);
      client = (await ensureDaemonRunning(paths, io)).client;
    }
  }
}

function remainingWaitTimeout(timeoutMs: number, startedAt: number): number {
  if (timeoutMs === 0) return 0;
  return Math.max(1, timeoutMs - (Date.now() - startedAt));
}

function isDaemonUnavailable(error: unknown): boolean {
  return error instanceof ProError && error.code === "DAEMON_UNAVAILABLE";
}

function jobIdFromPayload(payload: Record<string, unknown>): string {
  const job = payload.job;
  if (isRecord(job) && typeof job.id === "string") return job.id;
  throw new ProError("DAEMON_BAD_RESPONSE", "Daemon create response did not include a job id.", {
    exitCode: EXIT.internal,
    suggestions: ["Run pro-cli daemon restart --json and retry."],
  });
}

function throwIfTerminalJobFailure(payload: Record<string, unknown>, fallbackJobId: string): void {
  const job = payload.job;
  if (!isRecord(job)) return;
  const status = typeof job.status === "string" ? job.status : "";
  if (status !== "failed" && status !== "cancelled") return;

  const parsed = parseJobErrorPayload(job.error);
  const code = stringValue(parsed.code) ?? (status === "cancelled" ? "JOB_CANCELLED" : "JOB_FAILED");
  const jobId = stringValue(job.id) ?? fallbackJobId;
  const message = stringValue(parsed.message) ?? `Job ${jobId} ${status}.`;
  const details = isRecord(parsed.details) ? parsed.details : {};
  throw new ProError(code, message, {
    exitCode: exitCodeForJobFailure(code, status),
    suggestions: stringArray(parsed.suggestions),
    details: {
      ...details,
      jobId,
      jobStatus: status,
      job,
      waited: payload,
    },
  });
}

function parseJobErrorPayload(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { message: raw };
  } catch {
    return { message: raw };
  }
}

function exitCodeForJobFailure(code: string, status: string): (typeof EXIT)[keyof typeof EXIT] {
  if (status === "cancelled") return EXIT.upstream;
  if (
    [
      "ACCOUNT_ID_MISSING",
      "CDP_EVALUATION_FAILED",
      "CDP_UNAVAILABLE",
      "CHATGPT_PAGE_LOGGED_OUT",
      "CHATGPT_PAGE_MISSING",
      "CHATGPT_PROBE_FAILED",
      "SESSION_TOKEN_EXPIRED",
      "SESSION_TOKEN_MISSING",
    ].includes(code)
  ) {
    return EXIT.auth;
  }
  if (code === "NETWORK_ERROR") return EXIT.network;
  if (code === "WAIT_TIMEOUT") return EXIT.timeout;
  if (code === "INVALID_ARGS" || code === "INVALID_JSON") return EXIT.invalidArgs;
  if (code === "JOB_NOT_FOUND" || code === "JOB_NOT_READY") return EXIT.notFound;
  if (code === "INTERNAL_ERROR" || code === "DAEMON_BAD_RESPONSE") return EXIT.internal;
  return EXIT.upstream;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function resultIfSucceeded(
  client: { result: (jobId: string) => Promise<Record<string, unknown>> },
  jobId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const job = payload.job;
  if (!isRecord(job) || job.status !== "succeeded") return {};
  const result = await client.result(jobId);
  return typeof result.result === "string" ? { result: result.result } : {};
}

function parseIntegerFlag(
  flags: Map<string, string | boolean | string[]>,
  source: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = flagString(flags, source);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw invalidArgs(`Invalid --${source}.`, [`Use an integer between ${min} and ${max}.`]);
  }
  return number;
}

function parseOptionalIntegerFlag(
  flags: Map<string, string | boolean | string[]>,
  source: string,
  min: number,
  max: number,
): number | undefined {
  const value = flagString(flags, source);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw invalidArgs(`Invalid --${source}.`, [`Use an integer between ${min} and ${max}.`]);
  }
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactPaths(paths: { home: string; configPath: string; dbPath: string }): {
  home: string;
  configPath: string;
  dbPath: string;
} {
  return {
    home: paths.home,
    configPath: paths.configPath,
    dbPath: paths.dbPath,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
