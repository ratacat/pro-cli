import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RuntimePaths } from "./config";
import { EXIT, ProError, toProError } from "./errors";
import { JobStore, redactJob, type JobRecord, type JobStatus, type LimitsObservation, type ResearchTaskRecord } from "./jobs";
import {
  runChatGptJob,
  runChatGptResearchTask,
  type ResearchTask,
  type TransportOptions,
} from "./transport";

interface ExecutorTransports {
  runJob?: (job: JobRecord, options: TransportOptions) => Promise<string>;
  runResearchTask?: (task: ResearchTask, options: TransportOptions) => Promise<string>;
}

export async function executeClaimedJob(
  store: JobStore,
  job: JobRecord,
  paths: RuntimePaths,
  transports: ExecutorTransports = {},
): Promise<Record<string, unknown>> {
  const observations: LimitsObservation[] = [];
  const runJob = transports.runJob ?? runChatGptJob;
  const runResearchTask = transports.runResearchTask ?? runChatGptResearchTask;
  try {
    const transportOptions: TransportOptions = {
      sessionTokenPath: paths.sessionTokenPath,
      cdpBase: stringFromOption(job.options.cdpBase),
      timeoutMs: numberFromOption(job.options.timeoutMs),
      retries: numberFromOption(job.options.retries),
      retryDelayMs: numberFromOption(job.options.retryDelayMs),
      artifactDir: join(paths.home, "images", job.id),
      onLimits: (entries) => observations.push(...entries),
      onResearchTask: (task) => {
        store.upsertResearchTask(job.id, task);
      },
      onResearchTaskStatus: (update) => {
        store.updateResearchTaskStatus(job.id, update.status);
      },
    };
    const existingTask = store.getResearchTask(job.id);
    const result = existingTask
      ? await runResearchTask(researchTaskForTransport(existingTask), transportOptions)
      : await runJob(job, transportOptions);
    if (observations.length > 0) store.recordLimits(observations, job.id);
    const completed = store.markSucceeded(job.id, result);
    return { job: redactJob(completed), result };
  } catch (error) {
    const proError = toProError(error);
    if (store.getResearchTask(job.id) && shouldDeferResearchTaskError(proError)) {
      store.deferResearchTask(job.id, proError, researchTaskRetryDelayMs(proError));
      return {
        job: redactJob(store.get(job.id)),
        error: proError.toPayload(),
        deferred: true,
      };
    }
    return {
      job: redactJob(store.markFailed(job.id, proError)),
      error: proError.toPayload(),
    };
  }
}

function researchTaskForTransport(task: ResearchTaskRecord): ResearchTask {
  return {
    taskId: task.taskId,
    ...(task.title ? { title: task.title } : {}),
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
  };
}

function shouldDeferResearchTaskError(error: ProError): boolean {
  return [
    "RESEARCH_TASK_INCOMPLETE",
    "RESEARCH_TASK_UNAVAILABLE",
    "RESEARCH_WIDGET_UNAVAILABLE",
    "IMAGE_TASK_INCOMPLETE",
    "IMAGE_ASSETS_UNAVAILABLE",
    "IMAGE_DOWNLOAD_UNAVAILABLE",
    "NETWORK_ERROR",
    "REQUEST_TIMEOUT",
    "STREAM_INCOMPLETE",
    "CDP_TIMEOUT",
    "CHATGPT_PAGE_MISSING",
    "CHATGPT_PAGE_LOGGED_OUT",
    "SESSION_TOKEN_MISSING",
    "SESSION_TOKEN_EXPIRED",
  ].includes(error.code);
}

function researchTaskRetryDelayMs(error: ProError): number {
  if (["CHATGPT_PAGE_MISSING", "CHATGPT_PAGE_LOGGED_OUT", "SESSION_TOKEN_MISSING", "SESSION_TOKEN_EXPIRED"].includes(error.code)) {
    return 60_000;
  }
  const status = error.details?.status;
  if (typeof status === "number" && (status === 429 || status >= 500)) return 30_000;
  return 5_000;
}

export async function executeEphemeralJob(
  job: JobRecord,
  paths: RuntimePaths,
): Promise<Record<string, unknown>> {
  const observations: LimitsObservation[] = [];
  try {
    const result = await runChatGptJob(job, {
      sessionTokenPath: paths.sessionTokenPath,
      cdpBase: stringFromOption(job.options.cdpBase),
      timeoutMs: numberFromOption(job.options.timeoutMs),
      retries: numberFromOption(job.options.retries),
      retryDelayMs: numberFromOption(job.options.retryDelayMs),
      artifactDir: join(paths.home, "images", job.id),
      onLimits: (entries) => observations.push(...entries),
    });
    if (observations.length > 0) await persistLimits(paths.dbPath, observations, job.id);
    return {
      job: redactJob({ ...job, status: "succeeded", result, updatedAt: new Date().toISOString() }),
      result,
    };
  } catch (error) {
    const proError = toProError(error);
    return {
      job: redactJob({
        ...job,
        status: "failed",
        error: JSON.stringify(proError.toPayload()),
        updatedAt: new Date().toISOString(),
      }),
      error: proError.toPayload(),
      exitCode: proError.exitCode,
    };
  }
}

async function persistLimits(
  dbPath: string,
  observations: LimitsObservation[],
  jobId: string,
): Promise<void> {
  const store = await JobStore.open(dbPath);
  try {
    store.recordLimits(observations, jobId);
  } finally {
    store.close();
  }
}

export function buildEphemeralJob(input: {
  prompt: string;
  model: string;
  reasoning: string;
  options: Record<string, unknown>;
}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: `ask_${randomUUID()}`,
    status: "running",
    prompt: input.prompt,
    model: input.model,
    reasoning: input.reasoning,
    options: input.options,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function waitForTerminalJob(
  store: JobStore,
  jobId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<JobRecord> {
  const outcome = await waitForJob(store, jobId, timeoutMs, pollMs);
  if (outcome.timedOut) throw waitTimeoutError(outcome);
  return outcome.job;
}

export interface JobWaitOutcome {
  job: JobRecord;
  status: JobStatus;
  timedOut: boolean;
  elapsedMs: number;
  timeoutMs: number;
  pollMs: number;
}

export async function waitForJob(
  store: JobStore,
  jobId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<JobWaitOutcome> {
  const start = Date.now();
  while (true) {
    const job = store.get(jobId);
    const elapsedMs = Date.now() - start;
    if (job.status !== "queued" && job.status !== "running") {
      return {
        job,
        status: job.status,
        timedOut: false,
        elapsedMs,
        timeoutMs,
        pollMs,
      };
    }
    if (timeoutMs > 0 && elapsedMs >= timeoutMs) {
      return {
        job,
        status: job.status,
        timedOut: true,
        elapsedMs,
        timeoutMs,
        pollMs,
      };
    }
    await sleep(pollMs);
  }
}

export function waitTimeoutError(outcome: JobWaitOutcome): ProError {
  return new ProError(
    "WAIT_TIMEOUT",
    `Job ${outcome.job.id} is still ${outcome.status} after ${formatDuration(outcome.elapsedMs)}.`,
    {
      exitCode: EXIT.timeout,
      suggestions: [
        `Run pro-cli job wait ${outcome.job.id} --json without --wait-timeout.`,
        `Run pro-cli job wait ${outcome.job.id} --soft-timeout ${outcome.timeoutMs} --json to poll without an error exit.`,
        `Use pro-cli job cancel ${outcome.job.id} --json if this job is stale.`,
      ],
      details: {
        job: redactJob(outcome.job),
        status: outcome.status,
        elapsedMs: outcome.elapsedMs,
        timeoutMs: outcome.timeoutMs,
        pollMs: outcome.pollMs,
      },
    },
  );
}

function numberFromOption(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringFromOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}
