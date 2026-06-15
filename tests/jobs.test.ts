import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { ProError } from "../src/errors";
import { JobStore, redactJob, type JobRecord } from "../src/jobs";

async function withStore<T>(fn: (store: JobStore, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-jobs-test-"));
  const store = await JobStore.open(join(dir, "jobs.sqlite"));
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("job store: create and read", () => {
  test("create produces a redacted record (prompt cleared, preview kept) but persists prompt internally", async () => {
    await withStore(async (store) => {
      const created = store.create({
        prompt: "the actual sensitive prompt body",
        model: "gpt-5-5-pro",
        reasoning: "standard",
        options: { temporary: true },
      });

      // Returned record is redacted for stdout safety.
      expect(created.id).toMatch(/^job_[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(created.status).toBe("queued");
      expect(created.prompt).toBe(""); // cleared
      expect(created.promptPreview).toBe("the actual sensitive prompt body");
      expect(created.model).toBe("gpt-5-5-pro");
      expect(created.reasoning).toBe("standard");
      expect(created.options).toEqual({ temporary: true });
      expect(created.result).toBeNull();
      expect(created.error).toBeNull();
      expect(created.hasResult).toBe(false);
      expect(created.createdAt).toBe(created.updatedAt);
      expect(() => new Date(created.createdAt).toISOString()).not.toThrow();

      // But internal get() returns the unredacted record (used by the daemon
      // and result endpoint).
      const internal = store.get(created.id);
      expect(internal.prompt).toBe("the actual sensitive prompt body");
      expect(internal.status).toBe("queued");
    });
  });

  test("get throws JOB_NOT_FOUND for an unknown id", async () => {
    await withStore(async (store) => {
      try {
        store.get("job_does_not_exist");
        throw new Error("Expected JOB_NOT_FOUND.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("JOB_NOT_FOUND");
        expect(proError.suggestions[0]).toContain("pro-cli job list");
      }
    });
  });

  test("create generates unique ids across calls", async () => {
    await withStore(async (store) => {
      const ids = new Set<string>();
      for (let i = 0; i < 8; i += 1) {
        const job = store.create({ prompt: `p${i}`, model: "gpt-5-5-pro", reasoning: "standard", options: {} });
        ids.add(job.id);
      }
      expect(ids.size).toBe(8);
    });
  });

  test("list orders by created_at DESC and respects limit", async () => {
    await withStore(async (store) => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        // Force distinct timestamps even on fast systems.
        await wait(2);
        ids.push(store.create({ prompt: `p${i}`, model: "gpt-5-5-pro", reasoning: "standard", options: {} }).id);
      }
      const listed = store.list(3);
      expect(listed).toHaveLength(3);
      // Most recently created should be first.
      expect(listed[0].id).toBe(ids[ids.length - 1]);
      expect(listed[1].id).toBe(ids[ids.length - 2]);
      expect(listed[2].id).toBe(ids[ids.length - 3]);
      // List items are redacted (prompt cleared).
      for (const job of listed) expect(job.prompt).toBe("");
    });
  });
});

describe("job store: status transitions", () => {
  test("markRunning moves a queued job to running and updates updatedAt", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "x", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      await wait(2);
      const running = store.markRunning(created.id);
      expect(running.status).toBe("running");
      expect(Date.parse(running.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    });
  });

  test("markRunning does not revive terminal jobs", async () => {
    await withStore(async (store) => {
      const succeeded = store.create({ prompt: "a", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      store.markRunning(succeeded.id);
      store.markSucceeded(succeeded.id, "ok");

      const failed = store.create({ prompt: "b", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      store.markRunning(failed.id);
      store.markFailed(failed.id, new ProError("BOOM", "failed"));

      const cancelled = store.create({ prompt: "c", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      store.cancel(cancelled.id);

      expect(store.markRunning(succeeded.id).status).toBe("succeeded");
      expect(store.markRunning(failed.id).status).toBe("failed");
      expect(store.markRunning(cancelled.id).status).toBe("cancelled");
      expect(store.get(succeeded.id).result).toBe("ok");
      expect(JSON.parse(store.get(failed.id).error as string).code).toBe("BOOM");
    });
  });

  test("markSucceeded only writes when current status is running (regression: late success after cancel)", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "x", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      store.markRunning(created.id);
      store.cancel(created.id);
      // Late success arrives after cancellation — must NOT overwrite.
      store.markSucceeded(created.id, "late result");
      const job = store.get(created.id);
      expect(job.status).toBe("cancelled");
      expect(job.result).toBeNull();
      expect(job.error).not.toBeNull();
      const errorPayload = JSON.parse(job.error as string);
      expect(errorPayload.code).toBe("CANCELLED");
    });
  });

  test("markFailed only writes when current status is running", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "x", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      store.markRunning(created.id);
      store.cancel(created.id);
      const failure = new ProError("LATE_FAILURE", "Pretend the worker died.");
      store.markFailed(created.id, failure);
      const job = store.get(created.id);
      expect(job.status).toBe("cancelled"); // unchanged
      const errorPayload = JSON.parse(job.error as string);
      expect(errorPayload.code).toBe("CANCELLED"); // not LATE_FAILURE
    });
  });

  test("markSucceeded from running stores result and clears error", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "x", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      store.markRunning(created.id);
      store.markSucceeded(created.id, "Here is the answer.");
      const job = store.get(created.id);
      expect(job.status).toBe("succeeded");
      expect(job.result).toBe("Here is the answer.");
      expect(job.error).toBeNull();
    });
  });

  test("markFailed from running writes a JSON error payload with code/message/suggestions", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "x", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      store.markRunning(created.id);
      const failure = new ProError("UPSTREAM_REJECTED", "ChatGPT returned 500.", {
        suggestions: ["Retry later."],
        details: { status: 500 },
      });
      store.markFailed(created.id, failure);
      const job = store.get(created.id);
      expect(job.status).toBe("failed");
      const payload = JSON.parse(job.error as string);
      expect(payload.code).toBe("UPSTREAM_REJECTED");
      expect(payload.message).toBe("ChatGPT returned 500.");
      expect(payload.suggestions).toEqual(["Retry later."]);
      expect(payload.details).toEqual({ status: 500 });
    });
  });

  test("cancel is idempotent on terminal statuses (succeeded/failed/cancelled stay)", async () => {
    await withStore(async (store) => {
      const a = store.create({ prompt: "a", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      const b = store.create({ prompt: "b", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      store.markRunning(a.id);
      store.markSucceeded(a.id, "ok");
      store.markRunning(b.id);
      store.markFailed(b.id, new ProError("X", "x"));

      const aCancel = store.cancel(a.id);
      const bCancel = store.cancel(b.id);
      expect(aCancel.status).toBe("succeeded");
      expect(bCancel.status).toBe("failed");
      // Result/error preserved.
      expect(store.get(a.id).result).toBe("ok");
      expect(store.get(b.id).status).toBe("failed");
    });
  });

  test("cancel can run from queued (no markRunning required)", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "x", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      const cancelled = store.cancel(created.id);
      expect(cancelled.status).toBe("cancelled");
    });
  });
});

describe("job store: claim semantics", () => {
  test("claimQueued atomically transitions queued→running exactly once", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "x", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      const first = store.claimQueued(created.id);
      const second = store.claimQueued(created.id);
      expect(first?.status).toBe("running");
      expect(second).toBeNull();
    });
  });

  test("claimQueued returns null when the job is in any non-queued state", async () => {
    await withStore(async (store) => {
      const created = store.create({ prompt: "x", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      store.markRunning(created.id);
      expect(store.claimQueued(created.id)).toBeNull();
    });
  });

  test("claimNextQueued picks the oldest queued job and skips non-queued ones", async () => {
    await withStore(async (store) => {
      const a = store.create({ prompt: "a", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      await wait(2);
      const b = store.create({ prompt: "b", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
      await wait(2);
      const c = store.create({ prompt: "c", model: "gpt-5-5-pro", reasoning: "standard", options: {} });

      // Simulate that `a` was already started and finished.
      store.markRunning(a.id);
      store.markSucceeded(a.id, "done");

      const next = store.claimNextQueued();
      expect(next?.id).toBe(b.id);
      expect(next?.status).toBe("running");

      const after = store.claimNextQueued();
      expect(after?.id).toBe(c.id);

      expect(store.claimNextQueued()).toBeNull();
    });
  });

  test("claimNextRunnable resumes a running job with a stored research task", async () => {
    await withStore(async (store) => {
      const running = store.create({ prompt: "research", model: "research", reasoning: "extended", options: {} });
      store.markRunning(running.id);
      store.upsertResearchTask(running.id, { taskId: "deepresch_resume", title: "Research task" });

      const runnable = store.claimNextRunnable();

      expect(runnable?.id).toBe(running.id);
      expect(runnable?.status).toBe("running");
    });
  });

  test("claimNextRunnable prefers queued jobs over resumable research tasks", async () => {
    await withStore(async (store) => {
      const running = store.create({ prompt: "research", model: "research", reasoning: "extended", options: {} });
      store.markRunning(running.id);
      store.upsertResearchTask(running.id, { taskId: "deepresch_resume" });
      await wait(2);
      const queued = store.create({ prompt: "new", model: "gpt-5-5-pro", reasoning: "standard", options: {} });

      const runnable = store.claimNextRunnable();

      expect(runnable?.id).toBe(queued.id);
      expect(runnable?.status).toBe("running");
      expect(store.get(running.id).status).toBe("running");
    });
  });

  test("claimNextRunnable skips deferred research tasks until nextPollAt", async () => {
    await withStore(async (store) => {
      const running = store.create({ prompt: "research", model: "research", reasoning: "extended", options: {} });
      store.markRunning(running.id);
      store.upsertResearchTask(running.id, { taskId: "deepresch_resume" });
      store.deferResearchTask(running.id, new ProError("NETWORK_ERROR", "offline"), 60_000);

      expect(store.claimNextRunnable()).toBeNull();
    });
  });
});

describe("job store: limits observations", () => {
  test("recordLimits + latestLimits returns the most recent observation per feature", async () => {
    await withStore(async (store) => {
      store.recordLimits([{ feature_name: "deep_research", remaining: 100, reset_after: "2026-06-01T00:00:00Z" }], "job_a");
      // Same observed_at would conflict; force a different timestamp.
      await wait(2);
      store.recordLimits(
        [
          { feature_name: "deep_research", remaining: 90, reset_after: "2026-06-02T00:00:00Z" },
          { feature_name: "odyssey", remaining: 5, reset_after: null },
        ],
        "job_b",
      );

      const latest = store.latestLimits();
      expect(latest).toHaveLength(2);
      const byName = Object.fromEntries(latest.map((l) => [l.featureName, l] as const));
      expect(byName.deep_research.remaining).toBe(90);
      expect(byName.deep_research.resetAfter).toBe("2026-06-02T00:00:00Z");
      expect(byName.deep_research.jobId).toBe("job_b");
      expect(byName.odyssey.remaining).toBe(5);
      expect(byName.odyssey.resetAfter).toBeNull();
    });
  });

  test("recordLimits is a no-op for an empty list", async () => {
    await withStore(async (store) => {
      store.recordLimits([], null);
      expect(store.latestLimits()).toEqual([]);
    });
  });

  test("latestLimits returns features sorted alphabetically", async () => {
    await withStore(async (store) => {
      store.recordLimits(
        [
          { feature_name: "z_feature", remaining: 1, reset_after: null },
          { feature_name: "a_feature", remaining: 1, reset_after: null },
          { feature_name: "m_feature", remaining: 1, reset_after: null },
        ],
        null,
      );
      const latest = store.latestLimits();
      expect(latest.map((l) => l.featureName)).toEqual(["a_feature", "m_feature", "z_feature"]);
    });
  });
});

describe("job store: persistence", () => {
  test("data survives close + reopen at the same path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-jobs-persist-"));
    const path = join(dir, "jobs.sqlite");
    let id = "";
    try {
      const first = await JobStore.open(path);
      try {
        const created = first.create({ prompt: "p", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
        first.markRunning(created.id);
        first.markSucceeded(created.id, "result body");
        id = created.id;
      } finally {
        first.close();
      }

      const second = await JobStore.open(path);
      try {
        const job = second.get(id);
        expect(job.status).toBe("succeeded");
        expect(job.result).toBe("result body");
        expect(job.prompt).toBe("p");
      } finally {
        second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("research task metadata survives close + reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-jobs-research-task-"));
    const path = join(dir, "jobs.sqlite");
    let id = "";
    try {
      const first = await JobStore.open(path);
      try {
        const created = first.create({ prompt: "p", model: "research", reasoning: "extended", options: {} });
        first.markRunning(created.id);
        first.upsertResearchTask(created.id, {
          taskId: "deepresch_persist",
          title: "Persistent research",
          conversationId: "conversation-1",
        });
        first.updateResearchTaskStatus(created.id, "running");
        id = created.id;
      } finally {
        first.close();
      }

      const second = await JobStore.open(path);
      try {
        const task = second.getResearchTask(id);
        expect(task?.taskId).toBe("deepresch_persist");
        expect(task?.title).toBe("Persistent research");
        expect(task?.conversationId).toBe("conversation-1");
        expect(task?.status).toBe("running");
      } finally {
        second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("opens cleanly when the parent directory does not exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-jobs-fresh-"));
    try {
      // Nested path must be created.
      const store = await JobStore.open(join(dir, "deep", "nested", "jobs.sqlite"));
      try {
        const created = store.create({ prompt: "p", model: "gpt-5-5-pro", reasoning: "standard", options: {} });
        expect(created.status).toBe("queued");
      } finally {
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("redactJob helper", () => {
  test("clears prompt/result and emits compact previews + hasResult flag", () => {
    const job: JobRecord = {
      id: "job_x",
      status: "succeeded",
      prompt: "Some\n\n\nlong\tprompt body".repeat(10),
      model: "gpt-5-5-pro",
      reasoning: "standard",
      options: {},
      result: "Result text",
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const redacted = redactJob(job);
    expect(redacted.prompt).toBe("");
    expect(redacted.result).toBeNull();
    expect(redacted.hasResult).toBe(true);
    expect(redacted.resultPreview).toBe("Result text");
    expect(redacted.promptPreview.length).toBeLessThanOrEqual(160);
    // Whitespace collapsed in preview.
    expect(redacted.promptPreview).not.toContain("\n");
    expect(redacted.promptPreview).not.toContain("\t");
  });

  test("omits resultPreview and sets hasResult=false when result is null", () => {
    const job: JobRecord = {
      id: "job_x",
      status: "queued",
      prompt: "p",
      model: "gpt-5-5-pro",
      reasoning: "standard",
      options: {},
      result: null,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const redacted = redactJob(job);
    expect(redacted.hasResult).toBe(false);
    expect("resultPreview" in redacted).toBe(false);
  });

  test("treats an empty-string result as a real result", () => {
    const job: JobRecord = {
      id: "job_x",
      status: "succeeded",
      prompt: "p",
      model: "gpt-5-5-pro",
      reasoning: "standard",
      options: {},
      result: "",
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const redacted = redactJob(job);
    expect(redacted.result).toBeNull();
    expect(redacted.hasResult).toBe(true);
    expect(redacted.resultPreview).toBe("");
  });

  test("truncates oversized previews with ellipsis", () => {
    const job: JobRecord = {
      id: "job_x",
      status: "queued",
      prompt: "x".repeat(500),
      model: "gpt-5-5-pro",
      reasoning: "standard",
      options: {},
      result: "y".repeat(500),
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const redacted = redactJob(job);
    expect(redacted.promptPreview.length).toBe(160);
    expect(redacted.promptPreview.endsWith("…")).toBe(true);
    expect(redacted.resultPreview!.length).toBe(240);
    expect(redacted.resultPreview!.endsWith("…")).toBe(true);
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
