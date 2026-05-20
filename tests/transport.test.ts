import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../src/jobs";
import { runChatGptJob } from "../src/transport";
import { ProError } from "../src/errors";

async function withTokenFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-token-test-"));
  const path = join(dir, "token.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        source: "pro-cli-cdp-page",
        accessToken: fakeJwt(),
        accountId: "acct_test",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ChatGPT transport", () => {
  test("evaluates ChatGPT frontend conversation request inside the browser page", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let cdpBase = "";
      let expression = "";
      const pageEvaluator = (async <T>(base: string, script: string): Promise<T> => {
        cdpBase = base;
        expression = script;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        cdpBase: "http://127.0.0.1:9225",
        pageEvaluator,
      });

      expect(result).toBe("OK");
      expect(cdpBase).toBe("http://127.0.0.1:9225");
      expect(expression).toContain("https://chatgpt.com/backend-api/f/conversation");
      expect(expression).toContain("https://chatgpt.com/backend-api/f/conversation/prepare");
      expect(expression).toContain("https://chatgpt.com/backend-api/f/conversation/resume");
      expect(expression).toContain("https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare");
      expect(expression).toContain("OpenAI-Sentinel-Chat-Requirements-Token");
      expect(expression).not.toContain("codex/responses");
      expect(expression).toContain('"action":"next"');
      expect(expression).toContain('"model":"gpt-5-5-pro"');
      expect(expression).toContain('"thinking_effort":"standard"');
      expect(expression).toContain('"history_and_training_disabled":true');
      expect(expression).toContain("Use terse answers.\\n\\nReply with OK only.");
      expect(expression).not.toContain("header.");
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody).toMatchObject({
        action: "next",
        model: "gpt-5-5-pro",
        thinking_effort: "standard",
        history_and_training_disabled: true,
        verbosity: "high",
        reasoning_summary: "detailed",
        tool_choice: "none",
        parallel_tools: false,
        force_parallel_switch: "none",
      });
      const messages = requestBody.messages as Array<{ content: { parts: string[] } }>;
      expect(messages[0].content.parts[0]).toBe("Use terse answers.\n\nReply with OK only.");
    });
  });

  test("omits thinking_effort for GPT-4.5 requests", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let expression = "";
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        expression = script;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job({ model: "gpt-4.5", reasoning: "none" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe("OK");
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("gpt-4-5");
      expect(requestBody).not.toHaveProperty("thinking_effort");
    });
  });

  test("sends thinking_effort for Deep Research requests", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let expression = "";
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        expression = script;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job({ model: "deep-research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe("OK");
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("research");
      expect(requestBody.thinking_effort).toBe("extended");
    });
  });

  test("retries transient upstream failures", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 503, body: "busy" } as T;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        pageEvaluator,
        retries: 1,
        retryDelayMs: 0,
      });

      expect(result).toBe("OK");
      expect(attempts).toBe(2);
    });
  });

  test("retries incomplete response streams", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: true,
            status: 200,
            body: 'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["partial"]},"status":"in_progress"}}\n\n',
          } as T;
        }
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        pageEvaluator,
        retries: 1,
        retryDelayMs: 0,
      });

      expect(result).toBe("OK");
      expect(attempts).toBe(2);
    });
  });

  test("accepts streams that only mark completion with DONE", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["OK"]},"status":"in_progress"}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("reads CRLF-delimited SSE frames from upstream streams", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: conversationStream("OK").replace(/\n/g, "\r\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("surfaces upstream error events instead of treating DONE as success", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"type":"error","error":{"message":"usage limit reached"}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        }) as T);

      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
        throw new Error("Expected UPSTREAM_ERROR.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("UPSTREAM_ERROR");
        expect(proError.message).toBe("usage limit reached");
        expect(proError.details?.attempts).toBe(1);
      }
    });
  });

  test("empty completed responses tell agents not to spend quota on probes", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: ["data: [DONE]", ""].join("\n\n"),
        }) as T);

      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
        throw new Error("Expected EMPTY_RESPONSE.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        const suggestions = proError.suggestions.join("\n").toLowerCase();
        expect(proError.code).toBe("EMPTY_RESPONSE");
        expect(suggestions).toContain("same real request");
        expect(suggestions).toContain("smoke-test");
        expect(suggestions).toContain("pro-cli doctor --json");
      }
    });
  });

  test("reads patch-style /f/conversation streams", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"O"},{"p":"/message/content/parts/0","o":"append","v":"K"}]}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("reads resumed handoff streams appended after the initial response", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"type":"resume_conversation_token","token":"resume_token","conversation_id":"conv_test"}',
            'data: {"type":"stream_handoff","conversation_id":"conv_test"}',
            "data: [DONE]",
            "",
            'data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"O"},{"p":"/message/content/parts/0","o":"append","v":"K"}]}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("keeps accumulated patch text when final snapshots contain only a suffix", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"Open Chrome. "}',
            'data: {"v":"Run jobs. "}',
            'data: {"v":"Close it when done."}',
            'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["Close it when done."]},"status":"finished_successfully"}}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("Open Chrome. Run jobs. Close it when done.");
    });
  });

  test("deduplicates repeated continuation frames after path append events", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
            'data: {"v":"OK"}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("deduplicates repeated append snapshots after unrelated stream events", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
            'data: {"type":"metadata","v":{"ignored":true}}',
            'data: {"v":"OK"}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("maps non-OK upstream responses to structured errors", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({ ok: false, status: 429, body: "<html>limit</html>" }) as T);

      await expect(runChatGptJob(job(), { sessionTokenPath, pageEvaluator })).rejects.toThrow(ProError);
    });
  });

  test("fails early when the CDP ChatGPT page is logged out", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: false,
          status: 200,
          body: "ChatGPT page session did not include an access token.",
          code: "CHATGPT_PAGE_LOGGED_OUT",
        }) as T);

      await expect(runChatGptJob(job(), { sessionTokenPath, pageEvaluator })).rejects.toThrow(
        "The ChatGPT CDP page is not logged in.",
      );
    });
  });

  test("HTTP 431 from the auth probe surfaces as CHATGPT_PROBE_FAILED with cookie-bloat guidance", async () => {
    // Regression guard: before the probe_failed split this fired as
    // logged_out, which sent agents down the wrong remediation path. The
    // 431-specific message must mention cookie buildup, not "sign in again".
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: false,
          status: 431,
          body: "ChatGPT auth session probe returned HTTP 431.",
          code: "CHATGPT_PROBE_FAILED",
        }) as T);

      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
        throw new Error("Expected CHATGPT_PROBE_FAILED.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("CHATGPT_PROBE_FAILED");
        expect(proError.message).toContain("HTTP 431");
        expect(proError.suggestions.some((s) => s.toLowerCase().includes("cookie"))).toBe(true);
        expect(proError.suggestions.some((s) => s.includes("auth capture"))).toBe(true);
        expect(proError.details?.status).toBe(431);
      }
    });
  });

  test("non-431 probe failures still distinguish probe_failed from logged_out", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: false,
          status: 502,
          body: "ChatGPT auth session probe returned HTTP 502.",
          code: "CHATGPT_PROBE_FAILED",
        }) as T);

      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
        throw new Error("Expected CHATGPT_PROBE_FAILED.");
      } catch (error) {
        const proError = error as ProError;
        expect(proError.code).toBe("CHATGPT_PROBE_FAILED");
        expect(proError.suggestions.some((s) => s.includes("Reload the CDP ChatGPT tab"))).toBe(true);
        // 502 is NOT 431; do not inappropriately suggest cookie remediation.
        expect(proError.suggestions.some((s) => s.toLowerCase().includes("cookie"))).toBe(false);
      }
    });
  });

  test("the in-page auth probe pins referrerPolicy to no-referrer", async () => {
    // The 431 saga we shipped traced back to the in-page fetch inheriting
    // the page's full URL as Referer. If a refactor drops the explicit
    // referrerPolicy, oversize tracking URLs will inflate headers again.
    await withTokenFile(async (sessionTokenPath) => {
      let captured = "";
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        captured = expression;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
      expect(captured).toContain('referrerPolicy: "no-referrer"');
      // And the auth-session URL is also present (we expect both together).
      expect(captured).toContain("https://chatgpt.com/api/auth/session");
    });
  });

  test("retries on common transient 5xx upstream codes", async () => {
    // Lock down which codes get retried. A regression that narrows isRetryable
    // (e.g. only 503) would silently ship; verify 500/502/504 are also
    // retryable until we explicitly decide otherwise.
    for (const transientStatus of [500, 502, 504]) {
      await withTokenFile(async (sessionTokenPath) => {
        let attempts = 0;
        const pageEvaluator = (async <T>(): Promise<T> => {
          attempts += 1;
          if (attempts === 1) return { ok: false, status: transientStatus, body: "busy" } as T;
          return { ok: true, status: 200, body: conversationStream("OK") } as T;
        });
        const result = await runChatGptJob(job(), {
          sessionTokenPath,
          pageEvaluator,
          retries: 1,
          retryDelayMs: 0,
        });
        expect(result).toBe("OK");
        expect(attempts).toBe(2);
      });
    }
  });

  test("does NOT retry on 4xx authorization failures (would burn quota or amplify rate limits)", async () => {
    // 401 / 403 from the upstream conversation endpoint indicate auth has
    // gone bad; retrying just hammers the API. Verify the first attempt
    // throws and we did not silently retry.
    for (const fatalStatus of [401, 403]) {
      await withTokenFile(async (sessionTokenPath) => {
        let attempts = 0;
        const pageEvaluator = (async <T>(): Promise<T> => {
          attempts += 1;
          return { ok: false, status: fatalStatus, body: "<html>denied</html>" } as T;
        });
        await expect(
          runChatGptJob(job(), {
            sessionTokenPath,
            pageEvaluator,
            retries: 3,
            retryDelayMs: 0,
          }),
        ).rejects.toThrow(ProError);
        expect(attempts).toBe(1);
      });
    }
  });

  test("CHATGPT_PAGE_LOGGED_OUT and CHATGPT_PROBE_FAILED are NOT retried (terminal auth states)", async () => {
    for (const code of ["CHATGPT_PAGE_LOGGED_OUT", "CHATGPT_PROBE_FAILED"] as const) {
      await withTokenFile(async (sessionTokenPath) => {
        let attempts = 0;
        const pageEvaluator = (async <T>(): Promise<T> => {
          attempts += 1;
          return { ok: false, status: 431, body: "x", code } as T;
        });
        await expect(
          runChatGptJob(job(), { sessionTokenPath, pageEvaluator, retries: 3, retryDelayMs: 0 }),
        ).rejects.toThrow();
        expect(attempts).toBe(1);
      });
    }
  });

  test("missing session token throws SESSION_TOKEN_MISSING with auth exit code", async () => {
    try {
      await runChatGptJob(job(), { sessionTokenPath: "/tmp/nonexistent-token-file.json" });
      throw new Error("Expected SESSION_TOKEN_MISSING.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProError);
      const proError = error as ProError;
      expect(proError.code).toBe("SESSION_TOKEN_MISSING");
      expect(proError.suggestions[0]).toContain("auth capture");
    }
  });

  test("expired session token throws SESSION_TOKEN_EXPIRED", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-token-expired-"));
    const path = join(dir, "token.json");
    try {
      const expired = {
        version: 1,
        generatedAt: new Date().toISOString(),
        source: "pro-cli-cdp-page",
        accessToken: fakeJwt(),
        accountId: "acct_test",
        // Expired 1 hour ago.
        expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      };
      await writeFile(path, JSON.stringify(expired));
      try {
        await runChatGptJob(job(), { sessionTokenPath: path });
        throw new Error("Expected SESSION_TOKEN_EXPIRED.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        expect((error as ProError).code).toBe("SESSION_TOKEN_EXPIRED");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing accountId on the token throws ACCOUNT_ID_MISSING", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-token-no-account-"));
    const path = join(dir, "token.json");
    try {
      // JWT with no chatgpt_account_id claim.
      const noAccountJwt = [
        "header",
        Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
        "sig",
      ].join(".");
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          source: "pro-cli-cdp-page",
          accessToken: noAccountJwt,
          // accountId intentionally omitted
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
      try {
        await runChatGptJob(job(), { sessionTokenPath: path });
        throw new Error("Expected ACCOUNT_ID_MISSING.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        expect((error as ProError).code).toBe("ACCOUNT_ID_MISSING");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function job(patch: Partial<Pick<JobRecord, "model" | "reasoning">> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: "job_test",
    status: "running",
    prompt: "Reply with OK only.",
    model: patch.model ?? "gpt-5-5-pro",
    reasoning: patch.reasoning ?? "standard",
    options: {
      instructions: "Use terse answers.",
      verbosity: "high",
      reasoningSummary: "detailed",
      toolChoice: "none",
      parallelTools: false,
    },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fakeJwt(): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  };
  return ["header", base64Url(JSON.stringify(payload)), "sig"].join(".");
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function conversationStream(text: string): string {
  return [
    `data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(text)}]},"status":"finished_successfully"}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
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
