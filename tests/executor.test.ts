import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { resolvePaths } from "../src/config";
import { ProError } from "../src/errors";
import {
  buildEphemeralJob,
  executeClaimedJob,
  waitForJob,
  waitForTerminalJob,
  waitTimeoutError,
} from "../src/executor";
import { JobStore } from "../src/jobs";

async function withStore<T>(fn: (store: JobStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-executor-test-"));
  const store = await JobStore.open(join(dir, "jobs.sqlite"));
  try {
    return await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("job waiting", () => {
  test("soft wait returns current job state when the timeout expires", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "large prompt",
        model: "gpt-5-5-pro",
        reasoning: "extended",
        options: {},
      });

      const outcome = await waitForJob(store, created.id, 1, 25);

      expect(outcome.timedOut).toBe(true);
      expect(outcome.status).toBe("queued");
      expect(outcome.job.id).toBe(created.id);
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(1);
      expect(outcome.timeoutMs).toBe(1);
      expect(outcome.pollMs).toBe(25);
    });
  });

  test("hard wait timeout includes current status and retry guidance", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "large prompt",
        model: "gpt-5-5-pro",
        reasoning: "extended",
        options: {},
      });

      try {
        await waitForTerminalJob(store, created.id, 1, 25);
        throw new Error("Expected wait timeout.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("WAIT_TIMEOUT");
        expect(proError.message).toContain("still queued");
        expect(proError.suggestions[0]).toContain(`pro-cli job wait ${created.id} --json`);
        expect(proError.details?.status).toBe("queued");
        expect(proError.details?.timeoutMs).toBe(1);
      }
    });
  });

  test("waitForJob returns immediately when the job is already succeeded", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "x",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: {},
      });
      store.markRunning(created.id);
      store.markSucceeded(created.id, "done");

      const t0 = Date.now();
      const outcome = await waitForJob(store, created.id, 5_000, 100);
      const elapsed = Date.now() - t0;

      expect(outcome.timedOut).toBe(false);
      expect(outcome.status).toBe("succeeded");
      expect(outcome.job.result).toBe("done");
      // Should not have polled — we returned on first check.
      expect(elapsed).toBeLessThan(80);
    });
  });

  test("waitForJob returns immediately when the job is already failed", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "x",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: {},
      });
      store.markRunning(created.id);
      store.markFailed(created.id, new ProError("BOOM", "blew up"));

      const outcome = await waitForJob(store, created.id, 5_000, 100);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.status).toBe("failed");
    });
  });

  test("waitForJob returns immediately when the job is already cancelled", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "x",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: {},
      });
      store.cancel(created.id);

      const outcome = await waitForJob(store, created.id, 5_000, 100);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.status).toBe("cancelled");
    });
  });

  test("waitForJob actually polls and returns when the job becomes terminal mid-wait", async () => {
    await withStore(async (store) => {
      // Regression guard: if the polling loop were broken to never re-fetch
      // (e.g. early return), the job would still be 'running' when the wait
      // returns. We explicitly check it picks up the terminal transition.
      const created = store.create({
        prompt: "x",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: {},
      });
      store.markRunning(created.id);

      // Flip to succeeded after ~50ms while waitForJob polls every 20ms.
      const flipper = setTimeout(() => store.markSucceeded(created.id, "ok"), 50);
      try {
        const outcome = await waitForJob(store, created.id, 1_500, 20);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.status).toBe("succeeded");
        expect(outcome.job.result).toBe("ok");
        // We should have polled at least twice (>= 40ms before pickup).
        expect(outcome.elapsedMs).toBeGreaterThanOrEqual(40);
      } finally {
        clearTimeout(flipper);
      }
    });
  });

  test("waitForJob with timeoutMs=0 means no timeout (terminal state still returns)", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "x",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: {},
      });
      store.markRunning(created.id);
      const flipper = setTimeout(() => store.markSucceeded(created.id, "done"), 30);
      try {
        const outcome = await waitForJob(store, created.id, 0, 10);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.status).toBe("succeeded");
      } finally {
        clearTimeout(flipper);
      }
    });
  });

  test("waitForJob propagates JOB_NOT_FOUND when the id is missing", async () => {
    await withStore(async (store) => {
      try {
        await waitForJob(store, "job_missing", 10, 5);
        throw new Error("Expected JOB_NOT_FOUND.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        expect((error as ProError).code).toBe("JOB_NOT_FOUND");
      }
    });
  });

  test("waitForTerminalJob returns the unredacted terminal record on success", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "x",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: {},
      });
      store.markRunning(created.id);
      store.markSucceeded(created.id, "result text");
      const job = await waitForTerminalJob(store, created.id, 1_000, 10);
      expect(job.status).toBe("succeeded");
      expect(job.result).toBe("result text");
      expect(job.id).toBe(created.id);
    });
  });
});

describe("buildEphemeralJob", () => {
  test("produces a job with status=running and an ask_ id (not job_)", () => {
    // The id prefix matters: the daemon and store distinguish ask_* from
    // job_* records. ask_* must never end up in the persistent jobs table.
    const job = buildEphemeralJob({
      prompt: "ephemeral prompt",
      model: "gpt-5-5-pro",
      reasoning: "extended",
      options: { timeoutMs: 5000 },
    });
    expect(job.id).toMatch(/^ask_[0-9a-f]{8}-/);
    expect(job.status).toBe("running");
    expect(job.prompt).toBe("ephemeral prompt");
    expect(job.model).toBe("gpt-5-5-pro");
    expect(job.reasoning).toBe("extended");
    expect(job.options).toEqual({ timeoutMs: 5000 });
    expect(job.result).toBeNull();
    expect(job.error).toBeNull();
    expect(job.createdAt).toBe(job.updatedAt);
  });

  test("does not share state across calls (deep options copy by reference is fine, but ids differ)", () => {
    const a = buildEphemeralJob({ prompt: "a", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
    const b = buildEphemeralJob({ prompt: "b", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
    expect(a.id).not.toBe(b.id);
  });
});

describe("executeClaimedJob research task durability", () => {
  test("persists launched Deep Research task metadata before returning the final result", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "research", model: "research", reasoning: "extended", options: {} });
      const claimed = store.claimQueued(created.id);
      if (!claimed) throw new Error("Expected claimed job.");

      const result = await executeClaimedJob(store, claimed, testPaths(), {
        runJob: async (_job, options) => {
          await options.onResearchTask?.({
            taskId: "deepresch_started",
            title: "Research task",
            conversationId: "conversation-1",
          });
          await options.onResearchTaskStatus?.({ taskId: "deepresch_started", status: "completed" });
          return "final report";
        },
      });

      expect(result.result).toBe("final report");
      expect(store.get(created.id).status).toBe("succeeded");
      const task = store.getResearchTask(created.id);
      expect(task?.taskId).toBe("deepresch_started");
      expect(task?.conversationId).toBe("conversation-1");
      expect(task?.status).toBe("completed");
    });
  });

  test("resumes a stored Deep Research task instead of resubmitting the prompt", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "research", model: "research", reasoning: "extended", options: {} });
      store.markRunning(created.id);
      store.upsertResearchTask(created.id, { taskId: "deepresch_resume", title: "Stored task" });

      const result = await executeClaimedJob(store, store.get(created.id), testPaths(), {
        runJob: async () => {
          throw new Error("Prompt should not be resubmitted when a task id is stored.");
        },
        runResearchTask: async (task, options) => {
          expect(task.taskId).toBe("deepresch_resume");
          await options.onResearchTaskStatus?.({ ...task, status: "completed" });
          return "resumed final report";
        },
      });

      expect(result.result).toBe("resumed final report");
      expect(store.get(created.id).status).toBe("succeeded");
      expect(store.get(created.id).result).toBe("resumed final report");
      expect(store.getResearchTask(created.id)?.status).toBe("completed");
    });
  });

  test("defers transient polling failures without making the job terminal", async () => {
    for (const code of ["NETWORK_ERROR", "CDP_TIMEOUT", "RESEARCH_WIDGET_UNAVAILABLE"] as const) {
      await withStore(async (store) => {
        const created = store.create({ prompt: "research", model: "research", reasoning: "extended", options: {} });
        store.markRunning(created.id);
        store.upsertResearchTask(created.id, { taskId: "deepresch_resume" });

        const result = await executeClaimedJob(store, store.get(created.id), testPaths(), {
          runResearchTask: async () => {
            throw new ProError(code, "transient polling failure");
          },
        });

        expect(result.deferred).toBe(true);
        expect(store.get(created.id).status).toBe("running");
        const task = store.getResearchTask(created.id);
        expect(task?.status).toBe("deferred");
        expect(task?.nextPollAt).not.toBeNull();
        expect(JSON.parse(task?.lastError as string).code).toBe(code);
      });
    }
  });
});

describe("waitTimeoutError", () => {
  test("includes job, status, elapsedMs, timeoutMs, pollMs in details", () => {
    const error = waitTimeoutError({
      job: {
        id: "job_x",
        status: "running",
        prompt: "p",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: {},
        result: null,
        error: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      status: "running",
      timedOut: true,
      elapsedMs: 65_000,
      timeoutMs: 60_000,
      pollMs: 1000,
    });
    expect(error.code).toBe("WAIT_TIMEOUT");
    expect(error.message).toContain("still running");
    expect(error.message).toContain("1m 5s");
    expect(error.details?.elapsedMs).toBe(65_000);
    expect(error.details?.timeoutMs).toBe(60_000);
    expect(error.details?.pollMs).toBe(1000);
    // Suggestions name the job id and provide both polling and cancel paths.
    expect(error.suggestions.some((s) => s.includes("job_x"))).toBe(true);
    expect(error.suggestions.some((s) => s.includes("--soft-timeout"))).toBe(true);
    expect(error.suggestions.some((s) => s.includes("cancel"))).toBe(true);
  });

  test("formats sub-second durations in ms", () => {
    const error = waitTimeoutError({
      job: {
        id: "job_y",
        status: "queued",
        prompt: "p",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: {},
        result: null,
        error: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      status: "queued",
      timedOut: true,
      elapsedMs: 250,
      timeoutMs: 200,
      pollMs: 50,
    });
    expect(error.message).toContain("250ms");
  });

  test("formats whole-minute durations without trailing seconds", () => {
    const error = waitTimeoutError({
      job: {
        id: "job_z",
        status: "running",
        prompt: "p",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: {},
        result: null,
        error: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      status: "running",
      timedOut: true,
      elapsedMs: 120_000,
      timeoutMs: 120_000,
      pollMs: 1000,
    });
    expect(error.message).toMatch(/2m(?!\s\d)/);
  });
});

function testPaths() {
  return resolvePaths({ PRO_CLI_HOME: join(tmpdir(), "pro-executor-paths") });
}
