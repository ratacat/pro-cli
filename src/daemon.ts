import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimePaths } from "./config";
import { ensurePrivateDir, writePrivateFile } from "./config";
import { EXIT, ProError, type ErrorPayload, type ExitCode, toProError } from "./errors";
import { executeClaimedJob, waitForJob, waitTimeoutError, type JobWaitOutcome } from "./executor";
import { JobStore, redactJob, type CreateJobInput } from "./jobs";
import type { CliIO } from "./output";

const DEFAULT_DAEMON_START_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_POLL_MS = 500;
const HEARTBEAT_MS = 2_000;

export interface DaemonEndpoint {
  version: 1;
  pid: number;
  port: number;
  token: string;
  home: string;
  startedAt: string;
  updatedAt: string;
  logPath: string;
}

export interface DaemonStatus {
  state: "running" | "stopped" | "stale";
  endpointPath: string;
  logPath: string;
  pid?: number;
  port?: number;
  home: string;
  updatedAt?: string;
  processAlive?: boolean;
  message?: string;
}

export interface DaemonStartResult {
  started: boolean;
  status: DaemonStatus;
  client: DaemonClient;
}

interface DaemonRuntimePaths {
  dir: string;
  endpointPath: string;
  logPath: string;
}

export class DaemonClient {
  constructor(private readonly endpoint: DaemonEndpoint) {}

  async health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/health");
  }

  async createJob(input: CreateJobInput): Promise<Record<string, unknown>> {
    return this.request("POST", "/jobs", input);
  }

  async status(jobId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/jobs/${encodeURIComponent(jobId)}`);
  }

  async result(jobId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/jobs/${encodeURIComponent(jobId)}/result`);
  }

  async wait(
    jobId: string,
    timeoutMs: number,
    pollMs: number,
    softTimeout = false,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/wait`, {
      timeoutMs,
      pollMs,
      softTimeout,
    });
  }

  async cancel(jobId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  async jobs(limit: number): Promise<Record<string, unknown>> {
    return this.request("GET", `/jobs?limit=${encodeURIComponent(String(limit))}`);
  }

  async shutdown(): Promise<Record<string, unknown>> {
    return this.request("POST", "/shutdown");
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.endpoint.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.endpoint.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new ProError("DAEMON_UNAVAILABLE", "Cannot reach the pro-cli daemon.", {
        exitCode: EXIT.network,
        suggestions: ["Run pro-cli daemon start --json.", "Inspect the daemon log path from pro-cli daemon status --json."],
        cause: error,
      });
    }

    const payload = (await response.json().catch(() => null)) as
      | { ok: true; data: Record<string, unknown> }
      | { ok: false; error: ErrorPayload }
      | null;
    if (payload?.ok) return payload.data;
    if (payload?.ok === false) {
      throw new ProError(payload.error.code, payload.error.message, {
        exitCode: response.ok ? EXIT.internal : exitCodeForStatus(response.status),
        suggestions: payload.error.suggestions,
        details: payload.error.details,
      });
    }
    throw new ProError("DAEMON_BAD_RESPONSE", `pro-cli daemon returned HTTP ${response.status}.`, {
      exitCode: exitCodeForStatus(response.status),
      suggestions: ["Run pro-cli daemon restart --json."],
    });
  }
}

export async function ensureDaemonRunning(paths: RuntimePaths, io: CliIO): Promise<DaemonStartResult> {
  const connected = await connectDaemon(paths);
  if (connected) {
    return { started: false, status: connected.status, client: connected.client };
  }

  const before = await getDaemonStatus(paths);
  if (before.pid && before.processAlive) {
    try {
      process.kill(before.pid, "SIGTERM");
    } catch {
      // The process may have exited between status and restart.
    }
  }
  await startDaemonProcess(paths, io);

  const deadline = Date.now() + DEFAULT_DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const next = await connectDaemon(paths);
    if (next) return { started: true, status: next.status, client: next.client };
    await sleep(100);
  }

  const status = await getDaemonStatus(paths);
  throw new ProError("DAEMON_START_FAILED", "pro-cli daemon did not become ready.", {
    exitCode: EXIT.internal,
    suggestions: [
      "Run pro-cli daemon status --json.",
      `Inspect the daemon log: ${status.logPath}`,
    ],
    details: { status },
  });
}

export async function getDaemonStatus(paths: RuntimePaths): Promise<DaemonStatus> {
  const runtime = daemonRuntimePaths(paths.home);
  const endpoint = await readEndpoint(runtime.endpointPath).catch(() => null);
  if (!endpoint) {
    return { state: "stopped", endpointPath: runtime.endpointPath, logPath: runtime.logPath, home: paths.home };
  }
  if (endpoint.home !== paths.home) {
    return {
      state: "stale",
      endpointPath: runtime.endpointPath,
      logPath: runtime.logPath,
      home: paths.home,
      pid: endpoint.pid,
      port: endpoint.port,
      updatedAt: endpoint.updatedAt,
      processAlive: true,
      message: "Daemon endpoint belongs to a different PRO_CLI_HOME.",
    };
  }
  const client = new DaemonClient(endpoint);
  try {
    await client.health();
    return {
      state: "running",
      endpointPath: runtime.endpointPath,
      logPath: endpoint.logPath,
      home: paths.home,
      pid: endpoint.pid,
      port: endpoint.port,
      updatedAt: endpoint.updatedAt,
      processAlive: true,
    };
  } catch (error) {
    const processAlive = isProcessAlive(endpoint.pid);
    if (!processAlive) {
      return {
        state: "stopped",
        endpointPath: runtime.endpointPath,
        logPath: endpoint.logPath,
        home: paths.home,
        pid: endpoint.pid,
        port: endpoint.port,
        updatedAt: endpoint.updatedAt,
        processAlive,
        message: "Daemon pid is not running.",
      };
    }
    return {
      state: "stale",
      endpointPath: runtime.endpointPath,
      logPath: endpoint.logPath,
      home: paths.home,
      pid: endpoint.pid,
      port: endpoint.port,
      updatedAt: endpoint.updatedAt,
      processAlive,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function stopDaemon(paths: RuntimePaths): Promise<DaemonStatus> {
  const connected = await connectDaemon(paths);
  if (connected) {
    await connected.client.shutdown();
    await sleep(100);
  } else {
    const status = await getDaemonStatus(paths);
    if (status.pid && status.processAlive) {
      try {
        process.kill(status.pid, "SIGTERM");
      } catch {
        // The process may have exited between status and stop.
      }
    }
  }
  return getDaemonStatus(paths);
}

export async function runDaemonServer(
  paths: RuntimePaths,
  options: { port?: number; pollMs?: number; idleTimeoutMs?: number } = {},
): Promise<void> {
  await ensurePrivateDir(paths.home);
  const runtime = daemonRuntimePaths(paths.home);
  await ensurePrivateDir(runtime.dir);
  touchPrivateFile(runtime.logPath);
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const startedAt = new Date().toISOString();
  const store = await JobStore.open(paths.dbPath);
  let stopping = false;
  let pumping = false;
  let lastActivityAt = Date.now();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      if (!isAuthorized(request, token)) return jsonError(new ProError("DAEMON_UNAUTHORIZED", "Invalid daemon token."), 401);
      try {
        lastActivityAt = Date.now();
        const response = await routeDaemonRequest(request, store, paths, {
          pumpQueue,
          shutdown: () => {
            setTimeout(() => void shutdown(), 10);
          },
        });
        return jsonOk(response);
      } catch (error) {
        const proError = toProError(error);
        return jsonError(proError, httpStatusForError(proError));
      }
    },
  });

  async function writeEndpoint(): Promise<void> {
    const endpoint: DaemonEndpoint = {
      version: 1,
      pid: process.pid,
      port: server.port ?? 0,
      token,
      home: paths.home,
      startedAt,
      updatedAt: new Date().toISOString(),
      logPath: runtime.logPath,
    };
    await writePrivateFile(runtime.endpointPath, `${JSON.stringify(endpoint, null, 2)}\n`);
  }

  async function pumpQueue(): Promise<void> {
    if (pumping || stopping) return;
    pumping = true;
    try {
      while (!stopping) {
        const claimed = store.claimNextRunnable();
        if (!claimed) return;
        await executeClaimedJob(store, claimed, paths);
        lastActivityAt = Date.now();
      }
    } finally {
      pumping = false;
    }
  }

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    clearInterval(queuePoll);
    clearInterval(idleCheck);
    store.close();
    await unlink(runtime.endpointPath).catch(() => undefined);
    server.stop();
  }

  await writeEndpoint();
  const heartbeat = setInterval(() => void writeEndpoint(), HEARTBEAT_MS);
  const queuePoll = setInterval(() => void pumpQueue(), options.pollMs ?? DEFAULT_DAEMON_POLL_MS);
  const idleCheck = setInterval(() => {
    if (!options.idleTimeoutMs || pumping) return;
    if (Date.now() - lastActivityAt >= options.idleTimeoutMs) void shutdown();
  }, 1_000);
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await pumpQueue();
  while (!stopping) await sleep(1_000);
}

async function connectDaemon(paths: RuntimePaths): Promise<{ client: DaemonClient; status: DaemonStatus } | null> {
  const runtime = daemonRuntimePaths(paths.home);
  const endpoint = await readEndpoint(runtime.endpointPath).catch(() => null);
  if (!endpoint || endpoint.home !== paths.home) return null;
  const client = new DaemonClient(endpoint);
  try {
    await client.health();
    return {
      client,
      status: {
        state: "running",
        endpointPath: runtime.endpointPath,
        logPath: endpoint.logPath,
        home: paths.home,
        pid: endpoint.pid,
        port: endpoint.port,
        updatedAt: endpoint.updatedAt,
        processAlive: true,
      },
    };
  } catch {
    return null;
  }
}

async function startDaemonProcess(paths: RuntimePaths, io: CliIO): Promise<void> {
  const runtime = daemonRuntimePaths(paths.home);
  await ensurePrivateDir(runtime.dir);
  const logFd = openSync(runtime.logPath, "a", 0o600);
  const cliPath = new URL("./cli.ts", import.meta.url).pathname;
  const env = { ...process.env };
  for (const [key, value] of Object.entries(io.env)) {
    if (value !== undefined) env[key] = value;
  }
  const child = spawn(process.execPath, [cliPath, "daemon", "serve", "--json"], {
    cwd: io.cwd,
    detached: true,
    env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
}

function touchPrivateFile(path: string): void {
  const fd = openSync(path, "a", 0o600);
  closeSync(fd);
}

async function routeDaemonRequest(
  request: Request,
  store: JobStore,
  paths: RuntimePaths,
  control: { pumpQueue: () => Promise<void>; shutdown: () => void },
): Promise<Record<string, unknown>> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/health") {
    return { state: "running", pid: process.pid, home: paths.home };
  }
  if (request.method === "POST" && url.pathname === "/shutdown") {
    control.shutdown();
    return { state: "stopping" };
  }
  if (request.method === "POST" && url.pathname === "/jobs") {
    const input = createJobInputFromPayload(await readJsonBody(request));
    const job = store.create(input);
    queueMicrotask(() => void control.pumpQueue());
    return { job, daemon: { accepted: true } };
  }
  if (request.method === "GET" && url.pathname === "/jobs") {
    const limit = parseLimit(url.searchParams.get("limit"));
    return { jobs: store.list(limit) };
  }
  if (parts[0] !== "jobs" || !parts[1]) {
    throw new ProError("DAEMON_ROUTE_NOT_FOUND", `No daemon route for ${request.method} ${url.pathname}.`, {
      exitCode: EXIT.notFound,
    });
  }

  const jobId = decodeURIComponent(parts[1]);
  if (request.method === "GET" && parts.length === 2) {
    return { job: redactJob(store.get(jobId)) };
  }
  if (request.method === "GET" && parts[2] === "result") {
    const job = store.get(jobId);
    if (job.status !== "succeeded") {
      throw new ProError("JOB_NOT_READY", `Job ${jobId} is ${job.status}.`, {
        exitCode: EXIT.notFound,
        suggestions: ["Run pro-cli job wait <job-id> or pro-cli job status <job-id>."],
      });
    }
    return { jobId, result: job.result };
  }
  if (request.method === "POST" && parts[2] === "cancel") {
    return { job: store.cancel(jobId) };
  }
  if (request.method === "POST" && parts[2] === "wait") {
    const body = await readJsonBody(request);
    queueMicrotask(() => void control.pumpQueue());
    const outcome = await waitForJob(
      store,
      jobId,
      numberFromPayload(body.timeoutMs, 0),
      numberFromPayload(body.pollMs, DEFAULT_DAEMON_POLL_MS),
    );
    if (outcome.timedOut && body.softTimeout !== true) throw waitTimeoutError(outcome);
    return waitPayload(outcome);
  }

  throw new ProError("DAEMON_ROUTE_NOT_FOUND", `No daemon route for ${request.method} ${url.pathname}.`, {
    exitCode: EXIT.notFound,
  });
}

function daemonRuntimePaths(home: string): DaemonRuntimePaths {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 12);
  const root = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = join(root, `pro-cli-${uid}-${hash}`);
  return {
    dir,
    endpointPath: join(dir, "daemon.json"),
    logPath: join(dir, "daemon.log"),
  };
}

async function readEndpoint(path: string): Promise<DaemonEndpoint> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as DaemonEndpoint;
}

function isAuthorized(request: Request, token: string): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProError("INVALID_JSON", "Daemon request body must be a JSON object.", {
      exitCode: EXIT.invalidArgs,
    });
  }
  return parsed as Record<string, unknown>;
}

function createJobInputFromPayload(payload: Record<string, unknown>): CreateJobInput {
  if (
    typeof payload.prompt !== "string" ||
    typeof payload.model !== "string" ||
    typeof payload.reasoning !== "string" ||
    !isRecord(payload.options)
  ) {
    throw new ProError("INVALID_DAEMON_JOB", "Daemon job payload is missing prompt, model, reasoning, or options.", {
      exitCode: EXIT.invalidArgs,
    });
  }
  return {
    prompt: payload.prompt,
    model: payload.model,
    reasoning: payload.reasoning,
    options: payload.options,
  };
}

function parseLimit(raw: string | null): number {
  const limit = Number(raw ?? "20");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ProError("INVALID_ARGS", "Invalid --limit.", {
      exitCode: EXIT.invalidArgs,
      suggestions: ["Use --limit between 1 and 200."],
    });
  }
  return limit;
}

function numberFromPayload(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function waitPayload(outcome: JobWaitOutcome): Record<string, unknown> {
  return {
    job: redactJob(outcome.job),
    wait: {
      status: outcome.status,
      timedOut: outcome.timedOut,
      elapsedMs: outcome.elapsedMs,
      timeoutMs: outcome.timeoutMs,
      pollMs: outcome.pollMs,
    },
    ...(outcome.timedOut
      ? {
          next: {
            command: `pro-cli job wait ${outcome.job.id} --json`,
            reason: "The job is still running. Wait again without a timeout, or use another soft timeout poll.",
          },
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonOk(data: Record<string, unknown>): Response {
  return Response.json({ ok: true, data });
}

function jsonError(error: ProError, status: number): Response {
  return Response.json({ ok: false, error: error.toPayload() }, { status });
}

function httpStatusForError(error: ProError): number {
  if (error.exitCode === EXIT.invalidArgs) return 400;
  if (error.exitCode === EXIT.notFound) return 404;
  if (error.exitCode === EXIT.auth) return 401;
  if (error.exitCode === EXIT.timeout) return 408;
  return 500;
}

function exitCodeForStatus(status: number): ExitCode {
  if (status === 400) return EXIT.invalidArgs;
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if (status === 408) return EXIT.timeout;
  if (status >= 500) return EXIT.internal;
  return EXIT.network;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
