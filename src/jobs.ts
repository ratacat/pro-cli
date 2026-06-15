import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { EXIT, ProError } from "./errors";
import { ensurePrivateDir } from "./config";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface CreateJobInput {
  prompt: string;
  model: string;
  reasoning: string;
  options: Record<string, unknown>;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  prompt: string;
  model: string;
  reasoning: string;
  options: Record<string, unknown>;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LimitsObservation {
  feature_name: string;
  remaining: number;
  reset_after: string | null;
}

export interface LimitsSnapshot {
  featureName: string;
  remaining: number;
  resetAfter: string | null;
  observedAt: string;
  jobId: string | null;
}

export interface ResearchTaskInput {
  taskId: string;
  title?: string;
  conversationId?: string;
}

export interface ResearchTaskRecord extends ResearchTaskInput {
  jobId: string;
  status: string;
  lastError: string | null;
  nextPollAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  status: JobStatus;
  prompt: string;
  model: string;
  reasoning: string;
  options_json: string;
  result: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ResearchTaskRow {
  job_id: string;
  task_id: string;
  title: string | null;
  conversation_id: string | null;
  status: string;
  last_error_json: string | null;
  next_poll_at: string | null;
  created_at: string;
  updated_at: string;
}

export class JobStore {
  private constructor(private readonly db: Database) {}

  static async open(path: string): Promise<JobStore> {
    await ensurePrivateDir(dirname(path));
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        options_json TEXT NOT NULL,
        result TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS limits_observations (
        feature_name TEXT NOT NULL,
        remaining REAL NOT NULL,
        reset_after TEXT,
        observed_at TEXT NOT NULL,
        job_id TEXT,
        PRIMARY KEY (feature_name, observed_at)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS research_tasks (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        title TEXT,
        conversation_id TEXT,
        status TEXT NOT NULL,
        last_error_json TEXT,
        next_poll_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS research_tasks_next_poll_idx
      ON research_tasks(next_poll_at)
    `);
    return new JobStore(db);
  }

  create(input: CreateJobInput): ReturnType<typeof redactJob> {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: `job_${randomUUID()}`,
      status: "queued",
      prompt: input.prompt,
      model: input.model,
      reasoning: input.reasoning,
      options: input.options,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO jobs
          (id, status, prompt, model, reasoning, options_json, result, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.status,
        job.prompt,
        job.model,
        job.reasoning,
        JSON.stringify(job.options),
        job.result,
        job.error,
        job.createdAt,
        job.updatedAt,
      );
    return redactJob(job);
  }

  get(id: string): JobRecord {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
    if (!row) {
      throw new ProError("JOB_NOT_FOUND", `No job exists for ${id}.`, {
        exitCode: EXIT.notFound,
        suggestions: ["Run pro-cli job list --json to list recent jobs."],
      });
    }
    return rowToJob(row);
  }

  list(limit: number): JobRecord[] {
    const rows = this.db
      .query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as JobRow[];
    return rows.map(rowToJob).map(redactJob);
  }

  cancel(id: string): JobRecord {
    const job = this.get(id);
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return redactJob(job);
    }
    this.update(id, {
      status: "cancelled",
      error: JSON.stringify({
        code: "CANCELLED",
        message: "Job was cancelled before completion.",
      }),
    });
    return redactJob(this.get(id));
  }

  markRunning(id: string): JobRecord {
    const now = new Date().toISOString();
    this.db
      .query("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run("running", now, id, "queued");
    return this.get(id);
  }

  claimQueued(id: string): JobRecord | null {
    const now = new Date().toISOString();
    const result = this.db
      .query("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run("running", now, id, "queued") as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(id) : null;
  }

  claimNextQueued(): JobRecord | null {
    const row = this.db
      .query("SELECT id FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1")
      .get("queued") as { id: string } | null;
    return row ? this.claimQueued(row.id) : null;
  }

  claimNextRunnable(): JobRecord | null {
    const queued = this.claimNextQueued();
    if (queued) return queued;

    const now = new Date().toISOString();
    const resumable = this.db
      .query(
        `SELECT jobs.id
         FROM jobs
         INNER JOIN research_tasks ON research_tasks.job_id = jobs.id
         WHERE jobs.status = ?
           AND (research_tasks.next_poll_at IS NULL OR research_tasks.next_poll_at <= ?)
         ORDER BY COALESCE(research_tasks.next_poll_at, jobs.updated_at) ASC, jobs.created_at ASC
         LIMIT 1`,
      )
      .get("running", now) as { id: string } | null;
    return resumable ? this.get(resumable.id) : null;
  }

  markSucceeded(id: string, result: string): JobRecord {
    this.finishRunning(id, { status: "succeeded", result, error: null });
    return this.get(id);
  }

  markFailed(id: string, error: ProError): JobRecord {
    this.finishRunning(id, {
      status: "failed",
      error: JSON.stringify(error.toPayload()),
    });
    return this.get(id);
  }

  recordLimits(observations: LimitsObservation[], jobId: string | null): void {
    if (observations.length === 0) return;
    const observedAt = new Date().toISOString();
    const insert = this.db.query(
      `INSERT OR REPLACE INTO limits_observations
        (feature_name, remaining, reset_after, observed_at, job_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const observation of observations) {
      insert.run(
        observation.feature_name,
        observation.remaining,
        observation.reset_after ?? null,
        observedAt,
        jobId,
      );
    }
  }

  latestLimits(): LimitsSnapshot[] {
    const rows = this.db
      .query(
        `SELECT feature_name, remaining, reset_after, observed_at, job_id
         FROM limits_observations
         WHERE (feature_name, observed_at) IN (
           SELECT feature_name, MAX(observed_at) FROM limits_observations GROUP BY feature_name
         )
         ORDER BY feature_name ASC`,
      )
      .all() as Array<{
        feature_name: string;
        remaining: number;
        reset_after: string | null;
        observed_at: string;
        job_id: string | null;
      }>;
    return rows.map((row) => ({
      featureName: row.feature_name,
      remaining: row.remaining,
      resetAfter: row.reset_after,
      observedAt: row.observed_at,
      jobId: row.job_id,
    }));
  }

  upsertResearchTask(jobId: string, task: ResearchTaskInput): ResearchTaskRecord {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO research_tasks
          (job_id, task_id, title, conversation_id, status, last_error_json, next_poll_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
          task_id = excluded.task_id,
          title = excluded.title,
          conversation_id = excluded.conversation_id,
          status = excluded.status,
          last_error_json = NULL,
          next_poll_at = NULL,
          updated_at = excluded.updated_at`,
      )
      .run(
        jobId,
        task.taskId,
        task.title ?? null,
        task.conversationId ?? null,
        "running",
        null,
        null,
        now,
        now,
      );
    return this.getResearchTask(jobId) as ResearchTaskRecord;
  }

  getResearchTask(jobId: string): ResearchTaskRecord | null {
    const row = this.db
      .query("SELECT * FROM research_tasks WHERE job_id = ?")
      .get(jobId) as ResearchTaskRow | null;
    return row ? rowToResearchTask(row) : null;
  }

  updateResearchTaskStatus(jobId: string, status: string): ResearchTaskRecord | null {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE research_tasks
         SET status = ?, last_error_json = NULL, next_poll_at = NULL, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(status, now, jobId);
    return this.getResearchTask(jobId);
  }

  deferResearchTask(jobId: string, error: ProError, delayMs: number): ResearchTaskRecord | null {
    const now = new Date();
    const nextPollAt = new Date(now.getTime() + delayMs).toISOString();
    this.db
      .query(
        `UPDATE research_tasks
         SET status = ?, last_error_json = ?, next_poll_at = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run("deferred", JSON.stringify(error.toPayload()), nextPollAt, now.toISOString(), jobId);
    return this.getResearchTask(jobId);
  }

  close(): void {
    this.db.close();
  }

  private update(
    id: string,
    patch: { status?: JobStatus; result?: string | null; error?: string | null },
  ): void {
    const job = this.get(id);
    const next = {
      status: patch.status ?? job.status,
      result: patch.result === undefined ? job.result : patch.result,
      error: patch.error === undefined ? job.error : patch.error,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .query("UPDATE jobs SET status = ?, result = ?, error_json = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.result, next.error, next.updatedAt, id);
  }

  private finishRunning(
    id: string,
    patch: { status: "succeeded" | "failed"; result?: string | null; error?: string | null },
  ): void {
    const job = this.get(id);
    const next = {
      status: patch.status,
      result: patch.result === undefined ? job.result : patch.result,
      error: patch.error === undefined ? job.error : patch.error,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .query(
        "UPDATE jobs SET status = ?, result = ?, error_json = ?, updated_at = ? WHERE id = ? AND status = ?",
      )
      .run(next.status, next.result, next.error, next.updatedAt, id, "running");
  }
}

export function redactJob(
  job: JobRecord,
): Omit<JobRecord, "result"> & { result: null; promptPreview: string; resultPreview?: string; hasResult: boolean } {
  return {
    ...job,
    prompt: "",
    result: null,
    promptPreview: compact(job.prompt, 160),
    ...(job.result !== null ? { resultPreview: compact(job.result, 240) } : {}),
    hasResult: job.result !== null,
  };
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    status: row.status,
    prompt: row.prompt,
    model: row.model,
    reasoning: row.reasoning,
    options: JSON.parse(row.options_json) as Record<string, unknown>,
    result: row.result,
    error: row.error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToResearchTask(row: ResearchTaskRow): ResearchTaskRecord {
  return {
    jobId: row.job_id,
    taskId: row.task_id,
    ...(row.title ? { title: row.title } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    status: row.status,
    lastError: row.last_error_json,
    nextPollAt: row.next_poll_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compact(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
