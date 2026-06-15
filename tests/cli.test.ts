import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { runCli } from "../src/app";
import { EXIT, ProError } from "../src/errors";
import { JobStore } from "../src/jobs";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "pro-query-test-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function run(args: string[], options: { tty?: boolean; home?: string } = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdoutIsTTY: options.tty ?? false,
    env: { PRO_CLI_HOME: options.home },
    cwd: process.cwd(),
  });
  return { code, stdout, stderr };
}

describe("robot-mode CLI", () => {
  test("prints compact help with no args for TTY users", async () => {
    const result = await run([], { tty: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pro-cli: ChatGPT Pro CLI");
    expect(result.stdout).toContain("ask: direct blocking query");
    expect(result.stdout).toContain("job create --wait: durable blocking query");
    expect(result.stdout).toContain("job wait: waits until done");
    expect(result.stdout).toContain("update: fast-forward install");
    expect(result.stdout).toContain("Deep Research defaults to 1800000ms");
    expect(result.stdout).toContain("--wait-timeout/--soft-timeout only control local daemon waiting");
    expect(result.stdout.length).toBeLessThan(520);
    expect(result.stderr).toBe("");
  });

  test("prints compact help with --help for TTY users", async () => {
    const result = await run(["--help"], { tty: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("pro-cli: ChatGPT Pro CLI");
    expect(result.stdout).toContain("ask: direct blocking query");
    expect(result.stdout).toContain("job create --wait: durable blocking query");
    expect(result.stdout).toContain("job wait: waits until done");
    expect(result.stdout).toContain("update: fast-forward install");
    expect(result.stdout).toContain("Deep Research defaults to 1800000ms");
    expect(result.stdout).toContain("--wait-timeout/--soft-timeout only control local daemon waiting");
    expect(result.stdout.length).toBeLessThan(520);
    expect(result.stderr).toBe("");
  });

  test("auto-switches to JSON when stdout is not a TTY", async () => {
    const result = await run([], { tty: false });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data.text).toContain("ask: direct blocking query");
    expect(payload.data.commands).toContain("update");
    expect(payload.data.commands).toContain("auth capture");
  });

  test("prints version for install verification", async () => {
    const result = await run(["--version"], { tty: false });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^pro-cli \d+\.\d+\.\d+\n$/);
    expect(result.stderr).toBe("");
  });

  test("emits structured JSON errors and invalid-args exit code", async () => {
    const result = await run(["missing-command", "--json"], { tty: true });

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("INVALID_ARGS");
    expect(payload.error.suggestions).toContain("Run pro-cli help.");
  });

  test("setup gives a safe first-run path without secrets", async () => {
    await withHome(async (home) => {
      const result = await run(["setup", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("secret");
      const payload = JSON.parse(result.stdout);
      expect(payload.data.ready).toBe(false);
      expect(payload.data.steps.map((step: { id: string }) => step.id)).toEqual([
        "install",
        "open-chatgpt",
        "capture-auth",
        "doctor",
      ]);
      expect(payload.data.steps[1].command).toContain("chrome-profile");
      expect(payload.data.steps[2].command).toContain("pro-cli auth capture");
      expect(payload.data.steps[3].command).toContain("pro-cli doctor");
      expect(payload.data.safety.rawValuesPrinted).toBe(false);
      expect(JSON.stringify(payload.data)).not.toMatch(/Reply with OK|smoke-test/i);
    });
  });

  test("setup is readable for TTY users", async () => {
    await withHome(async (home) => {
      const result = await run(["setup"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("pro-cli needs a logged-in ChatGPT browser session");
      expect(result.stdout).toContain("[todo] open-chatgpt");
      expect(result.stdout).toContain("pro-cli auth capture");
      expect(result.stdout).toContain("pro-cli doctor");
      expect(result.stdout).not.toMatch(/Reply with OK|smoke-test/i);
      expect(result.stdout).not.toContain("{\"ready\"");
    });
  });

  test("auth command prints dedicated profile launch and capture commands", async () => {
    await withHome(async (home) => {
      const result = await run(["auth", "command", "--port", "9333", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.command).toContain("chrome-profile");
      expect(payload.data.command).toContain("9333");
      expect(payload.data.captureCommand).toBe("pro-cli auth capture --cdp http://127.0.0.1:9333 --json");
      expect(payload.data.safety).toContain("dedicated");
    });
  });

  test("reports missing auth without raw cookie values", async () => {
    await withHome(async (home) => {
      const result = await run(["auth", "status", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.status).toBe("missing");
      expect(payload.data.rawValuesPrinted).toBe(false);
      expect(payload.data.cookieCount).toBe(0);
    });
  });

  test("summarizes existing cookie export without printing values", async () => {
    await withHome(async (home) => {
      const cookiePath = join(home, "cookies", "chatgpt.json");
      await mkdir(join(home, "cookies"), { recursive: true });
      await writeFile(
        cookiePath,
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          source: "pro-cli-cdp",
          targetUrl: "https://chatgpt.com/",
          origins: ["https://chatgpt.com/"],
          cookies: [
            {
              name: "__Secure-next-auth.session-token",
              value: "secret-value",
              domain: "chatgpt.com",
              path: "/",
              secure: true,
              httpOnly: true,
            },
          ],
        }),
      );

      const result = await run(["auth", "status", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("secret-value");
      const payload = JSON.parse(result.stdout);
      expect(payload.data.status).toBe("present");
      expect(payload.data.cookieCount).toBe(1);
      expect(payload.data.names).toEqual(["__Secure-next-auth.session-token"]);
    });
  });

  test("creates durable async jobs with redacted prompt preview", async () => {
    await withHome(async (home) => {
      const createdResult = await run(
        ["job", "create", "hello", "from", "agent", "--no-start", "--condensed-response", "250", "--json"],
        {
          tty: true,
          home,
        },
      );

      expect(createdResult.code).toBe(0);
      const created = JSON.parse(createdResult.stdout);
      const jobId = created.data.job.id;
      expect(created.data.job.status).toBe("queued");
      expect(created.data.job.model).toBe("gpt-5-5-pro");
      expect(created.data.job.reasoning).toBe("standard");
      expect(created.data.daemon.started).toBe(false);
      expect(created.data.job.prompt).toBe("");
      expect(created.data.job.promptPreview).toBe("hello from agent");
      expect(created.data.job.options.condensedResponseTokens).toBe(250);

      const status = await run(["job", "status", jobId, "--json"], { tty: true, home });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout).data.job.id).toBe(jobId);
    });
  });

  test("creates durable GPT-4.5 and Deep Research jobs without reasoning effort", async () => {
    await withHome(async (home) => {
      const gpt45 = await run(["job", "create", "hello", "--no-start", "--model", "4.5", "--json"], {
        tty: true,
        home,
      });
      const deepResearch = await run(
        ["job", "create", "hello", "--no-start", "--model", "Deep Research", "--json"],
        { tty: true, home },
      );

      expect(gpt45.code).toBe(0);
      expect(deepResearch.code).toBe(0);
      expect(JSON.parse(gpt45.stdout).data.job).toMatchObject({
        model: "gpt-4-5",
        reasoning: "none",
        options: { temporary: true },
      });
      expect(JSON.parse(deepResearch.stdout).data.job).toMatchObject({
        model: "research",
        reasoning: "standard",
        options: { temporary: false, timeoutMs: 1_800_000 },
      });
    });
  });

  test("ask reports missing session token without durable job storage", async () => {
    await withHome(async (home) => {
      const result = await run(["ask", "hello", "--json"], { tty: true, home });

      expect(result.code).toBe(3);
      expect(result.stdout).toBe("");
      const payload = JSON.parse(result.stderr);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe("SESSION_TOKEN_MISSING");
      await expect(access(join(home, "jobs.sqlite"))).rejects.toThrow();
    });
  });

  test("config permission errors do not fall through to INTERNAL_ERROR", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await withHome(async (home) => {
      const configPath = join(home, "config.json");
      await writeFile(configPath, "{}");
      await chmod(configPath, 0);
      try {
        const result = await run(["doctor", "--json"], { tty: true, home });

        expect(result.code).toBe(3);
        expect(result.stdout).toBe("");
        const payload = JSON.parse(result.stderr);
        expect(payload.error.code).toBe("CONFIG_UNREADABLE");
        expect(payload.error.message).toContain(configPath);
        expect(payload.error.suggestions.join("\n")).toContain("pro-cli doctor --json");
        expect(payload.error.suggestions.join("\n")).toContain("smoke-test");
        expect(payload.error.suggestions.join("\n")).not.toContain("Run with --json");
      } finally {
        await chmod(configPath, 0o600).catch(() => undefined);
      }
    });
  });

  test("daemon status is stopped before startup", async () => {
    await withHome(async (home) => {
      const result = await run(["daemon", "status", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.daemon.state).toBe("stopped");
      expect(payload.data.daemon.home).toBe(home);
      expect(payload.data.daemon.endpointPath).toContain("pro-cli-");
    });
  });

  test("ask executes without durable job storage and returns the full result", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, "tokens"), { recursive: true });
      await writeFile(
        join(home, "tokens", "chatgpt-session.json"),
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          source: "pro-cli-cdp-page",
          accessToken: fakeJwt(),
          accountId: "acct_test",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );

      let expression = "";
      installFakeCdp(conversationStream("OK"), (script) => {
        expression = script;
      });

      const result = await run(
        [
          "ask",
          "hello",
          "--json",
          "--reasoning",
          "extended",
          "--verbosity",
          "low",
          "--timeout",
          "1000",
          "--retries",
          "1",
          "--retry-delay",
          "0",
        ],
        { tty: true, home },
      );

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.job.status).toBe("succeeded");
      expect(payload.data.job.prompt).toBe("");
      expect(payload.data.job.options.temporary).toBe(true);
      expect(payload.data.result).toBe("OK");
      expect(payload.data.agentInstruction).toContain("data.result is the primary deliverable");
      expect(payload.data.agentInstruction).toContain("preserve Pro's prose language");
      expect(payload.data.resultStats).toMatchObject({
        chars: 2,
        approximateTokens: 1,
        fullRelayThresholdChars: 6000,
        fullRelayThresholdApproxTokens: 1500,
      });
      await expect(access(join(home, "jobs.sqlite"))).rejects.toThrow();
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("gpt-5-5-pro");
      expect(requestBody.thinking_effort).toBe("extended");
      expect(requestBody.verbosity).toBe("low");
      expect(requestBody.history_and_training_disabled).toBe(true);
      expect(requestBody).not.toHaveProperty("text");
    });
  });

  test("ask supports condensed_response token budget alias", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      let expression = "";
      installFakeCdp(conversationStream("Short answer."), (script) => {
        expression = script;
      });

      const result = await run(["ask", "explain this", "--json", "--condensed_response=500"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.job.options.condensedResponseTokens).toBe(500);
      const requestBody = requestBodyFromExpression(expression);
      const messages = requestBody.messages as Array<{ content: { parts: string[] } }>;
      const prompt = messages[0].content.parts[0];
      expect(prompt).toContain("Condensed response mode");
      expect(prompt).toContain("approximately 500 tokens or fewer");
      expect(prompt).toContain("explain this");
    });
  });

  test("rejects conflicting condensed response aliases", async () => {
    await withHome(async (home) => {
      const result = await run(
        ["ask", "hello", "--condensed-response", "250", "--condensed_response=500", "--json"],
        { tty: true, home },
      );

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("one condensed response flag");
    });
  });

  test("defaults to Pro standard reasoning", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      let expression = "";
      installFakeCdp(conversationStream("OK"), (script) => {
        expression = script;
      });

      const result = await run(["ask", "hello", "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("gpt-5-5-pro");
      expect(requestBody.thinking_effort).toBe("standard");
    });
  });

  test("ask connects GPT-4.5 without a thinking effort", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      let expression = "";
      installFakeCdp(conversationStream("OK"), (script) => {
        expression = script;
      });

      const result = await run(["ask", "hello", "--model", "gpt-4.5", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.job.model).toBe("gpt-4-5");
      expect(payload.data.job.reasoning).toBe("none");
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("gpt-4-5");
      expect(requestBody).not.toHaveProperty("thinking_effort");
    });
  });

  test("ask connects Deep Research without a thinking effort", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      let expression = "";
      installFakeCdp(conversationStream("OK"), (script) => {
        expression = script;
      });

      const result = await run(["ask", "hello", "--model", "deep-research", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.job.model).toBe("research");
      expect(payload.data.job.reasoning).toBe("standard");
      expect(payload.data.job.options.temporary).toBe(false);
      expect(payload.data.job.options.timeoutMs).toBe(1_800_000);
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("gpt-5-5");
      expect(requestBody).not.toHaveProperty("thinking_effort");
      expect(requestBody.system_hints).toEqual(["connector:connector_openai_deep_research"]);
      const messages = requestBody.messages as Array<{ metadata: Record<string, unknown> }>;
      expect(messages[0].metadata).toMatchObject({
        selected_sources: ["web"],
        system_hints: ["connector:connector_openai_deep_research"],
        deep_research_version: "standard",
        venus_model_variant: "standard",
      });
      expect(requestBody).not.toHaveProperty("history_and_training_disabled");
    });
  });

  test("ask connects Deep Research with extended thinking", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      let expression = "";
      installFakeCdp(conversationStream("OK"), (script) => {
        expression = script;
      });

      const result = await run(
        ["ask", "hello", "--model", "deep-research", "--reasoning", "extended", "--json"],
        { tty: true, home },
      );

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.job.model).toBe("research");
      expect(payload.data.job.reasoning).toBe("extended");
      expect(payload.data.job.options.temporary).toBe(false);
      expect(payload.data.job.options.timeoutMs).toBe(1_800_000);
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("gpt-5-5");
      expect(requestBody).not.toHaveProperty("thinking_effort");
      expect(requestBody.system_hints).toEqual(["connector:connector_openai_deep_research"]);
      const messages = requestBody.messages as Array<{ metadata: Record<string, unknown> }>;
      expect(messages[0].metadata).toMatchObject({
        selected_sources: ["web"],
        system_hints: ["connector:connector_openai_deep_research"],
        deep_research_version: "standard",
        venus_model_variant: "standard",
      });
      expect(requestBody).not.toHaveProperty("history_and_training_disabled");
    });
  });

  test("rejects temporary chats for Deep Research", async () => {
    await withHome(async (home) => {
      const result = await run(
        ["ask", "hello", "--model", "deep-research", "--temporary", "--json"],
        { tty: true, home },
      );

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("Deep Research does not support temporary chats");
    });
  });

  test("image jobs default to saved conversations and a ten minute timeout", async () => {
    await withHome(async (home) => {
      const result = await run(
        ["job", "create", "a blue paper boat", "--no-start", "--model", "image", "--json"],
        { tty: true, home },
      );

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.job.model).toBe("image");
      expect(payload.data.job.reasoning).toBe("standard");
      expect(payload.data.job.options.temporary).toBe(false);
      expect(payload.data.job.options.timeoutMs).toBe(600_000);
    });
  });

  test("rejects temporary chats for image generation", async () => {
    await withHome(async (home) => {
      const result = await run(
        ["ask", "a blue paper boat", "--model", "image", "--temporary", "--json"],
        { tty: true, home },
      );

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("Image generation does not support temporary chats");
    });
  });

  test("rejects Deep Research timeout values below thirty minutes", async () => {
    await withHome(async (home) => {
      const result = await run(
        ["ask", "hello", "--model", "deep-research", "--timeout", "1000", "--json"],
        { tty: true, home },
      );

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("Deep Research --timeout must be at least 1800000ms");
      expect(payload.error.suggestions.join("\n")).toContain("--wait-timeout");
    });
  });

  test("rejects explicit reasoning for GPT-4.5", async () => {
    await withHome(async (home) => {
      const result = await run(
        ["ask", "hello", "--model", "gpt-4-5", "--reasoning", "extended", "--json"],
        { tty: true, home },
      );

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("does not support --reasoning");
    });
  });

  test("rejects model auto", async () => {
    await withHome(async (home) => {
      const result = await run(["ask", "hello", "--model", "auto", "--json"], { tty: true, home });

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("Invalid --model");
    });
  });

  test("rejects repeated single-value request flags instead of falling back to defaults", async () => {
    await withHome(async (home) => {
      const result = await run(
        ["ask", "hello", "--model", "gpt-a", "--model", "gpt-b", "--json"],
        { tty: true, home },
      );

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("Repeated --model");
    });
  });

  test("ask can opt into saved and continued conversations", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      let expression = "";
      installFakeCdp(conversationStream("OK"), (script) => {
        expression = script;
      });

      const result = await run(
        [
          "ask",
          "continue this",
          "--json",
          "--save",
          "--conversation",
          "conv_123",
          "--parent",
          "msg_456",
          "--reasoning",
          "extended",
        ],
        { tty: true, home },
      );

      expect(result.code).toBe(0);
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.conversation_id).toBe("conv_123");
      expect(requestBody.parent_message_id).toBe("msg_456");
      expect(requestBody.model).toBe("gpt-5-5-pro");
      expect(requestBody).not.toHaveProperty("history_and_training_disabled");
      expect(requestBody.thinking_effort).toBe("extended");
    });
  });

  test("continuing a conversation requires conversation and parent ids together", async () => {
    await withHome(async (home) => {
      const result = await run(["job", "create", "hello", "--conversation", "conv_123", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("both ids");
    });
  });

  test("job create cannot wait with no-start", async () => {
    await withHome(async (home) => {
      const result = await run(["job", "create", "hello", "--wait", "--no-start", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("without starting the daemon");
    });
  });

  test("job create rejects wait options without wait mode", async () => {
    await withHome(async (home) => {
      const result = await run(["job", "create", "hello", "--soft-timeout", "1000", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("Wait options require --wait");
    });
  });

  test("job wait rejects mixed timeout modes before contacting the daemon", async () => {
    await withHome(async (home) => {
      const result = await run(
        ["job", "wait", "job_fake", "--wait-timeout", "1", "--soft-timeout", "1", "--json"],
        { tty: true, home },
      );

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("Choose one wait timeout mode");
    });
  });

  test("job create --wait reports terminal failed jobs as top-level JSON errors", async () => {
    await withHome(async (home) => {
      try {
        const result = await run(["job", "create", "hello", "--wait", "--json", "--wait-timeout", "5000"], {
          tty: true,
          home,
        });

        expect(result.code).toBe(EXIT.auth);
        expect(result.stdout).toBe("");
        const payload = JSON.parse(result.stderr);
        expect(payload.ok).toBe(false);
        expect(payload.error.code).toBe("SESSION_TOKEN_MISSING");
        expect(payload.error.details.jobStatus).toBe("failed");
        expect(payload.error.details.job.id).toMatch(/^job_/);
        expect(payload.error.details.waited.wait.status).toBe("failed");
      } finally {
        await run(["daemon", "stop", "--json"], { tty: true, home });
      }
    });
  });

  test("job wait reports terminal failed jobs as top-level JSON errors", async () => {
    await withHome(async (home) => {
      const store = await JobStore.open(join(home, "jobs.sqlite"));
      let jobId = "";
      try {
        const created = store.create({
          prompt: "hello",
          model: "gpt-5-5-pro",
          reasoning: "standard",
          options: {},
        });
        jobId = created.id;
        store.markRunning(jobId);
        store.markFailed(
          jobId,
          new ProError("CHATGPT_PROBE_FAILED", "Could not determine ChatGPT login state from the CDP page (HTTP 431).", {
            exitCode: EXIT.auth,
            suggestions: ["HTTP 431 indicates oversize request headers."],
            details: { status: 431 },
          }),
        );
      } finally {
        store.close();
      }

      try {
        const result = await run(["job", "wait", jobId, "--json"], { tty: true, home });

        expect(result.code).toBe(EXIT.auth);
        expect(result.stdout).toBe("");
        const payload = JSON.parse(result.stderr);
        expect(payload.ok).toBe(false);
        expect(payload.error.code).toBe("CHATGPT_PROBE_FAILED");
        expect(payload.error.message).toContain("HTTP 431");
        expect(payload.error.suggestions).toContain("HTTP 431 indicates oversize request headers.");
        expect(payload.error.details.status).toBe(431);
        expect(payload.error.details.jobStatus).toBe("failed");
        expect(payload.error.details.job.id).toBe(jobId);
        expect(payload.error.details.waited.wait.status).toBe("failed");
      } finally {
        await run(["daemon", "stop", "--json"], { tty: true, home });
      }
    });
  });

  test("job wait soft timeout remains top-level success for non-terminal jobs", async () => {
    await withHome(async (home) => {
      const store = await JobStore.open(join(home, "jobs.sqlite"));
      let jobId = "";
      try {
        const created = store.create({
          prompt: "hello",
          model: "gpt-5-5-pro",
          reasoning: "standard",
          options: {},
        });
        jobId = created.id;
        store.markRunning(jobId);
      } finally {
        store.close();
      }

      try {
        const result = await run(["job", "wait", jobId, "--soft-timeout", "1", "--poll-ms", "25", "--json"], {
          tty: true,
          home,
        });

        expect(result.code).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.ok).toBe(true);
        expect(payload.data.job.status).toBe("running");
        expect(payload.data.wait.timedOut).toBe(true);
      } finally {
        await run(["daemon", "stop", "--json"], { tty: true, home });
      }
    });
  });

  test("job wait reconnects after DAEMON_UNAVAILABLE during a long wait", async () => {
    await withHome(async (home) => {
      const runtime = await writeDaemonEndpoint(home);
      const store = await JobStore.open(join(home, "jobs.sqlite"));
      let jobId = "";
      try {
        const created = store.create({
          prompt: "hello",
          model: "gpt-5-5-pro",
          reasoning: "standard",
          options: {},
        });
        jobId = created.id;
        store.markRunning(jobId);
      } finally {
        store.close();
      }

      let healthCalls = 0;
      let waitCalls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname === "/health") {
          healthCalls += 1;
          return Response.json({ ok: true, data: { state: "running", pid: process.pid, home } });
        }
        if (url.pathname === `/jobs/${jobId}/wait`) {
          waitCalls += 1;
          if (waitCalls === 1) throw new TypeError("socket closed");
          return Response.json({
            ok: true,
            data: {
              job: {
                id: jobId,
                status: "succeeded",
                prompt: "",
                model: "gpt-5-5-pro",
                reasoning: "standard",
                options: {},
                result: null,
                error: null,
                createdAt: "2026-05-20T00:00:00.000Z",
                updatedAt: "2026-05-20T00:00:01.000Z",
                promptPreview: "hello",
                resultPreview: "done",
                hasResult: true,
              },
              wait: { status: "succeeded", timedOut: false, elapsedMs: 25, timeoutMs: 1000, pollMs: 25 },
            },
          });
        }
        return Response.json({ ok: false, error: { code: "UNEXPECTED", message: url.pathname, suggestions: [] } }, { status: 404 });
      }) as typeof fetch;

      try {
        const result = await run(["job", "wait", jobId, "--wait-timeout", "1000", "--poll-ms", "25", "--json"], {
          tty: true,
          home,
        });

        expect(result.code).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.ok).toBe(true);
        expect(payload.data.job.status).toBe("succeeded");
        expect(waitCalls).toBe(2);
        expect(healthCalls).toBeGreaterThanOrEqual(2);
      } finally {
        await rm(runtime.dir, { recursive: true, force: true });
      }
    });
  });

  test("job create --wait reconnects after DAEMON_UNAVAILABLE without creating a second job", async () => {
    await withHome(async (home) => {
      const runtime = await writeDaemonEndpoint(home);
      const jobId = "job_wait_reconnect";
      let createCalls = 0;
      let waitCalls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname === "/health") {
          return Response.json({ ok: true, data: { state: "running", pid: process.pid, home } });
        }
        if (url.pathname === "/jobs" && init?.method === "POST") {
          createCalls += 1;
          return Response.json({
            ok: true,
            data: {
              job: {
                id: jobId,
                status: "queued",
                prompt: "",
                model: "gpt-5-5-pro",
                reasoning: "standard",
                options: { temporary: true },
                result: null,
                error: null,
                createdAt: "2026-05-20T00:00:00.000Z",
                updatedAt: "2026-05-20T00:00:00.000Z",
                promptPreview: "hello",
                hasResult: false,
              },
              daemon: { accepted: true },
            },
          });
        }
        if (url.pathname === `/jobs/${jobId}/wait`) {
          waitCalls += 1;
          if (waitCalls === 1) throw new TypeError("connection reset");
          return Response.json({
            ok: true,
            data: {
              job: {
                id: jobId,
                status: "succeeded",
                prompt: "",
                model: "gpt-5-5-pro",
                reasoning: "standard",
                options: { temporary: true },
                result: null,
                error: null,
                createdAt: "2026-05-20T00:00:00.000Z",
                updatedAt: "2026-05-20T00:00:01.000Z",
                promptPreview: "hello",
                resultPreview: "done",
                hasResult: true,
              },
              wait: { status: "succeeded", timedOut: false, elapsedMs: 25, timeoutMs: 1000, pollMs: 25 },
            },
          });
        }
        if (url.pathname === `/jobs/${jobId}/result`) {
          return Response.json({ ok: true, data: { jobId, result: "done" } });
        }
        return Response.json({ ok: false, error: { code: "UNEXPECTED", message: url.pathname, suggestions: [] } }, { status: 404 });
      }) as typeof fetch;

      try {
        const result = await run(["job", "create", "hello", "--wait", "--wait-timeout", "1000", "--poll-ms", "25", "--json"], {
          tty: true,
          home,
        });

        expect(result.code).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.ok).toBe(true);
        expect(payload.data.job.id).toBe(jobId);
        expect(payload.data.result).toBe("done");
        expect(createCalls).toBe(1);
        expect(waitCalls).toBe(2);
      } finally {
        await rm(runtime.dir, { recursive: true, force: true });
      }
    });
  });

  test("job result includes relay guidance for agents", async () => {
    await withHome(async (home) => {
      const store = await JobStore.open(join(home, "jobs.sqlite"));
      let jobId = "";
      try {
        const created = store.create({
          prompt: "hello",
          model: "gpt-5-5-pro",
          reasoning: "standard",
          options: {},
        });
        jobId = created.id;
        store.markRunning(jobId);
        store.markSucceeded(jobId, "Full Pro answer.");
      } finally {
        store.close();
      }

      const result = await run(["job", "result", jobId, "--json"], { tty: true, home });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.result).toBe("Full Pro answer.");
      expect(payload.data.agentInstruction).toContain("prefer relaying it in full");
      expect(payload.data.resultStats.chars).toBe("Full Pro answer.".length);
    });
  });

  test("ask prints plain text result for TTY users", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, "tokens"), { recursive: true });
      await writeFile(
        join(home, "tokens", "chatgpt-session.json"),
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          source: "pro-cli-cdp-page",
          accessToken: fakeJwt(),
          accountId: "acct_test",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
      installFakeCdp(conversationStream("OK"));

      const result = await run(["ask", "hello"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("OK\n");
    });
  });

  test("ask recovers once from ChatGPT cookie bloat", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      let deleted = 0;
      let navigated = false;
      installCookieBloatRecoveryCdp(() => {
        deleted += 1;
      }, () => {
        navigated = true;
      });

      const result = await run(["ask", "hello", "--json", "--timeout", "10"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).data.result).toBe("OK");
      expect(deleted).toBe(1);
      expect(navigated).toBe(true);
    });
  });

  test("ask recovers once from HTTP 431 auth-probe cookie bloat", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      let deleted = 0;
      let navigated = false;
      installCookieBloatRecoveryCdp(
        () => {
          deleted += 1;
        },
        () => {
          navigated = true;
        },
        {
          ok: false,
          status: 431,
          code: "CHATGPT_PROBE_FAILED",
          body: "ChatGPT auth session probe returned HTTP 431.",
        },
      );

      const result = await run(["ask", "hello", "--json", "--timeout", "10"], { tty: true, home });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).data.result).toBe("OK");
      expect(deleted).toBe(1);
      expect(navigated).toBe(true);
    });
  });

  test("rejects unsupported request flags instead of silently ignoring them", async () => {
    await withHome(async (home) => {
      const result = await run(["job", "create", "hello", "--temperature", "0.2", "--json"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      expect(payload.error.message).toContain("Unsupported --temperature");
    });
  });

  test("doctor refuses ready when the CDP ChatGPT page is logged out", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      installFakeCdpValue({
        status: 200,
        hasAccessToken: false,
        origin: "https://chatgpt.com",
      });

      const result = await run(["doctor", "--json", "--timeout", "1000"], { tty: true, home });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.auth.tokenStatus).toBe("present");
      expect(payload.data.browserSession.status).toBe("logged_out");
      expect(payload.data.ready).toBe(false);
      expect(payload.data.transport.status).toBe("auth_required");
      expect(payload.data.next.command).toContain("pro-cli auth capture");
    });
  });

  test("doctor reports ready only when stored auth and live browser session are both present", async () => {
    await withHome(async (home) => {
      await writeSessionToken(home);
      installFakeCdpValue({
        status: 200,
        hasAccessToken: true,
        origin: "https://chatgpt.com",
      });

      const result = await run(["doctor", "--json", "--cdp", "http://127.0.0.1:9555"], {
        tty: true,
        home,
      });

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.browserSession.status).toBe("present");
      expect(payload.data.browserSession.cdpBase).toBe("http://127.0.0.1:9555");
      expect(payload.data.ready).toBe(true);
      expect(payload.data.transport.status).toBe("configured");
      expect(payload.data.next.command).toContain("--cdp http://127.0.0.1:9555");
      expect(payload.data.next.command).not.toContain("Reply with OK");
      expect(JSON.stringify(payload.data.next).toLowerCase()).not.toContain("smoke");
      expect(result.stdout).not.toContain("header.");
    });
  });

  test("doctor reports probe_failed (NOT logged_out) when the probe returns a non-200/401 status", async () => {
    // Regression guard: before the probe_failed split, HTTP 431 was
    // collapsed into logged_out, sending users down the wrong remediation.
    await withHome(async (home) => {
      await writeSessionToken(home);
      installFakeCdpValue({
        status: 431,
        hasAccessToken: false,
        origin: "https://chatgpt.com",
      });

      const result = await run(["doctor", "--json", "--timeout", "1000"], { tty: true, home });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.browserSession.status).toBe("probe_failed");
      expect(payload.data.browserSession.httpStatus).toBe(431);
      // The 431-specific suggestion mentions cookies (not "sign in again").
      expect(
        payload.data.browserSession.suggestions.some((s: string) =>
          s.toLowerCase().includes("cookie"),
        ),
      ).toBe(true);
      // doctor.next still points at auth capture as the recovery action.
      expect(payload.data.next.command).toContain("pro-cli auth capture");
    });
  });

  test("doctor includes portCollision and legacyArtifacts diagnostic fields", async () => {
    // These fields were added to surface the failure modes that caused
    // today's incident. They must appear in every doctor report so agents
    // can act on them without guessing.
    await withHome(async (home) => {
      await writeSessionToken(home);
      installFakeCdpValue({ status: 200, hasAccessToken: true, origin: "https://chatgpt.com" });
      const result = await run(["doctor", "--json", "--cdp", "http://127.0.0.1:65432"], {
        tty: true,
        home,
      });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);

      expect(payload.data.portCollision).toBeDefined();
      expect(typeof payload.data.portCollision.inUse).toBe("boolean");
      expect(typeof payload.data.portCollision.conflict).toBe("boolean");
      expect(Array.isArray(payload.data.portCollision.listeners)).toBe(true);
      expect(payload.data.portCollision.port).toBe("65432");

      expect(payload.data.legacyArtifacts).toBeDefined();
      expect(typeof payload.data.legacyArtifacts.legacyHomeExists).toBe("boolean");
      expect(typeof payload.data.legacyArtifacts.legacyProfileExists).toBe("boolean");
      expect(typeof payload.data.legacyArtifacts.legacyHome).toBe("string");
      expect(typeof payload.data.legacyArtifacts.legacyProfileDir).toBe("string");
    });
  });

  test("auth command output includes portCollision so agents can detect dual-Chrome races", async () => {
    await withHome(async (home) => {
      const result = await run(["auth", "command", "--port", "9444", "--json"], {
        tty: true,
        home,
      });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.portCollision).toBeDefined();
      expect(payload.data.portCollision.port).toBe("9444");
      expect(payload.data.profileDir).toContain("chrome-profile");
    });
  });

  test("auth reset --no-launch --no-backup deletes the chrome profile dir", async () => {
    // Regression guard: --no-backup must actually delete the profile, not
    // silently fall through to backup mode (would mask "delete" intent).
    await withHome(async (home) => {
      await mkdir(join(home, "chrome-profile", "Default"), { recursive: true });
      await writeFile(join(home, "chrome-profile", "Default", "Cookies"), "dummy");

      const result = await run(["auth", "reset", "--no-launch", "--no-backup", "--json"], {
        tty: true,
        home,
      });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.removed.mode).toBe("delete");
      expect(payload.data.removed.from).toBe(join(home, "chrome-profile"));
      expect(payload.data.launched).toBeNull();
      // The profile dir is gone, no backup created.
      const remaining = await listEntries(home);
      expect(remaining).not.toContain("chrome-profile");
      expect(remaining.filter((e) => e.startsWith("chrome-profile.backup-"))).toHaveLength(0);
    });
  });

  test("auth reset (default) backs up the profile dir to chrome-profile.backup-<ts>", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, "chrome-profile", "Default"), { recursive: true });
      await writeFile(join(home, "chrome-profile", "Default", "marker"), "preserve me");

      const result = await run(["auth", "reset", "--no-launch", "--json"], { tty: true, home });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.removed.mode).toBe("backup");
      expect(payload.data.removed.to).toMatch(/chrome-profile\.backup-\d{8}-\d{6}/);
      // Backup contents preserved.
      const preserved = await readFile(
        join(payload.data.removed.to, "Default", "marker"),
        "utf8",
      );
      expect(preserved).toBe("preserve me");
    });
  });

  test("auth reset reports mode=missing and does not crash when no profile exists", async () => {
    await withHome(async (home) => {
      const result = await run(["auth", "reset", "--no-launch", "--json"], { tty: true, home });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.removed.mode).toBe("missing");
      expect(payload.data.killedPids).toEqual([]);
    });
  });

  test("auth reset --keep-backups N prunes older backups beyond N", async () => {
    await withHome(async (home) => {
      // Pre-seed three older backups, then trigger a reset that creates a
      // fourth. With --keep-backups 2, the two oldest must be pruned.
      await mkdir(join(home, "chrome-profile", "Default"), { recursive: true });
      const old = [
        "chrome-profile.backup-20000101-000000",
        "chrome-profile.backup-20000102-000000",
        "chrome-profile.backup-20000103-000000",
      ];
      for (const name of old) {
        await mkdir(join(home, name), { recursive: true });
        await writeFile(join(home, name, "marker"), name);
      }

      const result = await run(
        ["auth", "reset", "--no-launch", "--keep-backups", "2", "--json"],
        { tty: true, home },
      );
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      const prunedNames = (payload.data.prunedBackups as string[]).map((path) => basename(path)).sort();
      expect(prunedNames).toEqual([
        "chrome-profile.backup-20000101-000000",
        "chrome-profile.backup-20000102-000000",
      ]);
      const remaining = (await listEntries(home)).filter((e) => e.startsWith("chrome-profile.backup-"));
      expect(remaining.sort()).toEqual([
        basename(payload.data.removed.to as string),
        "chrome-profile.backup-20000103-000000",
      ].sort());
    });
  });

  test("auth hide moves the chatgpt window off-screen via Browser.setWindowBounds", async () => {
    await withHome(async (home) => {
      const observed = installAuthHideShowCdp();

      const result = await run(["auth", "hide", "--json"], { tty: true, home });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.targetId).toBe("CHATGPT_TAB");
      expect(payload.data.windowId).toBe(771965498);
      expect(payload.data.after.left).toBe(-32000);
      expect(payload.data.after.top).toBe(-32000);
      expect(payload.data.note.toLowerCase()).toContain("off-screen");
      // CDP methods called in order: get window, then set bounds.
      expect(observed.methods).toEqual([
        "Browser.getWindowForTarget",
        "Browser.setWindowBounds",
      ]);
      // The setWindowBounds params include the off-screen coords.
      const setParams = observed.params[1] as { bounds: { left: number; top: number } };
      expect(setParams.bounds.left).toBe(-32000);
      expect(setParams.bounds.top).toBe(-32000);
    });
  });

  test("auth show restores the window to a sensible centered position", async () => {
    await withHome(async (home) => {
      const observed = installAuthHideShowCdp();

      const result = await run(["auth", "show", "--json"], { tty: true, home });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.data.after.left).toBe(100);
      expect(payload.data.after.top).toBe(100);
      expect(payload.data.after.width).toBeGreaterThan(0);
      expect(payload.data.after.height).toBeGreaterThan(0);
      expect(payload.data.note.toLowerCase()).toContain("restored");

      const setParams = observed.params[1] as { bounds: { left: number; top: number } };
      expect(setParams.bounds.left).toBe(100);
      expect(setParams.bounds.top).toBe(100);
    });
  });

  test("auth hide fails clearly when no chatgpt.com tab is available", async () => {
    await withHome(async (home) => {
      // CDP is reachable but there is no chatgpt.com tab to operate on.
      globalThis.fetch = (async (url: string | URL | Request) => {
        const target = String(url);
        if (target.endsWith("/json")) {
          return Response.json([
            { id: "OTHER", type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://other" },
          ]);
        }
        if (target.endsWith("/json/version")) {
          return Response.json({ webSocketDebuggerUrl: "ws://browser" });
        }
        return new Response("nope", { status: 500 });
      }) as unknown as typeof fetch;

      const result = await run(["auth", "hide", "--json"], { tty: true, home });
      expect(result.code).toBe(3); // EXIT.auth
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("CHATGPT_PAGE_MISSING");
    });
  });

  test("ask response includes the no-probe agent guidance (regression guard)", async () => {
    // A future refactor that drops the no-test-probe sentence would let
    // agents resume running smoke-tests against Pro and burning quota.
    await withHome(async (home) => {
      await writeSessionToken(home);
      installFakeCdp(conversationStream("Real answer."));
      const result = await run(["ask", "explain X", "--json"], { tty: true, home });
      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      const instruction = String(payload.data.agentInstruction).toLowerCase();
      expect(instruction).toContain("probe");
      expect(instruction).toContain("pro quota");
    });
  });

  test("unknown auth subcommand suggests the full subcommand list (status/command/capture/reset/hide/show)", async () => {
    await withHome(async (home) => {
      const result = await run(["auth", "bogus", "--json"], { tty: true, home });
      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr);
      expect(payload.error.code).toBe("INVALID_ARGS");
      const suggestion = (payload.error.suggestions[0] as string).toLowerCase();
      expect(suggestion).toContain("status");
      expect(suggestion).toContain("capture");
      expect(suggestion).toContain("reset");
      expect(suggestion).toContain("hide");
      expect(suggestion).toContain("show");
    });
  });
});

async function listEntries(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir).catch(() => [] as string[]);
}

function installAuthHideShowCdp(): { methods: string[]; params: Array<unknown> } {
  const observed = { methods: [] as string[], params: [] as unknown[] };
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/json")) {
      return Response.json([
        { id: "CHATGPT_TAB", type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://chatgpt-tab" },
      ]);
    }
    if (target.endsWith("/json/version")) {
      return Response.json({ webSocketDebuggerUrl: "ws://browser" });
    }
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;

  class FakeWebSocket extends EventTarget {
    constructor(_url: string) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(raw: string): void {
      const message = JSON.parse(raw) as { id: number; method: string; params?: unknown };
      observed.methods.push(message.method);
      observed.params.push(message.params);
      let result: unknown = {};
      if (message.method === "Browser.getWindowForTarget") {
        result = { windowId: 771965498, bounds: { left: 22, top: 47, width: 1200, height: 1011, windowState: "normal" } };
      }
      const response = { id: message.id, result };
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(response) })),
      );
    }
    close(): void {
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  return observed;
}

async function writeSessionToken(home: string): Promise<void> {
  await mkdir(join(home, "tokens"), { recursive: true });
  await writeFile(
    join(home, "tokens", "chatgpt-session.json"),
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "pro-cli-cdp-page",
      accessToken: fakeJwt(),
      accountId: "acct_test",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  );
}

async function writeDaemonEndpoint(home: string): Promise<{ dir: string; endpointPath: string; logPath: string }> {
  const runtime = daemonRuntimePathsForHome(home);
  await mkdir(runtime.dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  await writeFile(
    runtime.endpointPath,
    `${JSON.stringify(
      {
        version: 1,
        pid: process.pid,
        port: 49321,
        token: "test-token",
        home,
        startedAt: now,
        updatedAt: now,
        logPath: runtime.logPath,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return runtime;
}

function daemonRuntimePathsForHome(home: string): { dir: string; endpointPath: string; logPath: string } {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 12);
  const dir = join("/tmp", `pro-cli-${uid}-${hash}`);
  return {
    dir,
    endpointPath: join(dir, "daemon.json"),
    logPath: join(dir, "daemon.log"),
  };
}

function fakeJwt(): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  };
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
}

function installFakeCdp(body: string, onExpression?: (expression: string) => void): void {
  installFakeCdpValue({ ok: true, status: 200, body }, onExpression);
}

function installFakeCdpValue(value: unknown, onExpression?: (expression: string) => void): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/json")) {
      return Response.json([
        {
          type: "page",
          url: "https://chatgpt.com/",
          webSocketDebuggerUrl: "ws://fake-chatgpt-page",
        },
      ]);
    }
    if (target.endsWith("/json/version")) {
      return Response.json({ webSocketDebuggerUrl: "ws://fake-browser" });
    }
    return new Response("unexpected fetch", { status: 500 });
  }) as unknown as typeof fetch;

  class FakeWebSocket extends EventTarget {
    constructor(_url: string) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { id: number; params?: { expression?: string } };
      onExpression?.(message.params?.expression ?? "");
      const response = {
        id: message.id,
        result: {
          result: { value },
        },
      };
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(response) })),
      );
    }

    close(): void {
      this.dispatchEvent(new Event("close"));
    }
  }

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

function installCookieBloatRecoveryCdp(
  onDelete: () => void,
  onNavigate: () => void,
  firstEvaluation: Record<string, unknown> = {
    ok: false,
    status: 0,
    code: "CHATGPT_PAGE_MISSING",
    body: "Expected https://chatgpt.com, got chrome-error://chromewebdata/",
  },
): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/json")) {
      return Response.json([
        {
          type: "page",
          url: "https://chatgpt.com/",
          webSocketDebuggerUrl: "ws://fake-chatgpt-page",
        },
      ]);
    }
    if (target.endsWith("/json/version")) {
      return Response.json({ webSocketDebuggerUrl: "ws://fake-browser" });
    }
    return new Response("unexpected fetch", { status: 500 });
  }) as unknown as typeof fetch;

  let runtimeEvaluations = 0;
  class FakeWebSocket extends EventTarget {
    constructor(_url: string) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { id: number; method: string };
      let response: Record<string, unknown> = { id: message.id, result: {} };
      if (message.method === "Runtime.evaluate") {
        runtimeEvaluations += 1;
        response = {
          id: message.id,
          result: {
            result: {
              value:
                runtimeEvaluations === 1
                  ? firstEvaluation
                  : { ok: true, status: 200, body: conversationStream("OK") },
            },
          },
        };
      }
      if (message.method === "Network.getCookies") {
        response = {
          id: message.id,
          result: {
            cookies: [
              { name: "__Secure-next-auth.session-token", value: "x", domain: "chatgpt.com", path: "/" },
              { name: "conv_key_abc", value: "x", domain: "chatgpt.com", path: "/" },
            ],
          },
        };
      }
      if (message.method === "Network.deleteCookies") onDelete();
      if (message.method === "Page.navigate") onNavigate();
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(response) })),
      );
    }

    close(): void {
      this.dispatchEvent(new Event("close"));
    }
  }

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

function requestBodyFromExpression(expression: string): Record<string, unknown> {
  const marker = '})("https://chatgpt.com/backend-api/f/conversation", ';
  const start = expression.lastIndexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const bodyEnd = expression.lastIndexOf(', "acct_test")');
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return JSON.parse(expression.slice(bodyStart, bodyEnd)) as Record<string, unknown>;
}

function conversationStream(text: string): string {
  return [
    `data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(text)}]},"status":"finished_successfully"}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}
