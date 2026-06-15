import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../src/jobs";
import { runChatGptJob, runChatGptResearchTask } from "../src/transport";
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

  test("uses the Deep Research connector request shape", async () => {
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
    });
  });

  test("uses saved ChatGPT conversations for image generation and downloads image assets", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const artifactDir = await mkdtemp(join(tmpdir(), "pro-image-artifacts-"));
      try {
        const calls: string[] = [];
        const tasks: string[] = [];
        const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
          calls.push(expression);
          if (expression.includes("/backend-api/conversation/")) {
            return {
              ok: true,
              status: 200,
              title: "Image generation request",
              asyncStatus: 4,
              assets: [
                {
                  fileId: "file_image_1",
                  assetPointer: "sediment://file_image_1",
                  width: 1024,
                  height: 1024,
                  sizeBytes: 9,
                  title: "Blue paper boat",
                  genId: "gen_image_1",
                },
              ],
            } as T;
          }
          if (expression.includes("/backend-api/files/download/")) {
            return {
              ok: true,
              status: 200,
              contentType: "image/png",
              bytes: 9,
              base64: Buffer.from("png-bytes").toString("base64"),
              fileName: "generated/boat.png",
            } as T;
          }
          return {
            ok: true,
            status: 200,
            body: imageLaunchStream("conversation-image"),
          } as T;
        });

        const result = await runChatGptJob(job({ model: "image", reasoning: "standard" }), {
          sessionTokenPath,
          pageEvaluator,
          artifactDir,
          onResearchTask: (task) => {
            tasks.push(task.taskId);
          },
        });

        const parsed = JSON.parse(result) as {
          type: string;
          conversationId: string;
          images: Array<{ path: string; fileId: string; width: number; height: number; title: string }>;
        };
        expect(parsed.type).toBe("image_generation");
        expect(parsed.conversationId).toBe("conversation-image");
        expect(parsed.images).toHaveLength(1);
        expect(parsed.images[0].fileId).toBe("file_image_1");
        expect(parsed.images[0].width).toBe(1024);
        expect(parsed.images[0].height).toBe(1024);
        expect(parsed.images[0].title).toBe("Blue paper boat");
        expect(await readFile(parsed.images[0].path, "utf8")).toBe("png-bytes");
        expect(tasks).toEqual(["image:conversation-image"]);

        const requestBody = requestBodyFromExpression(calls[0]);
        expect(requestBody.model).toBe("gpt-5-5-pro");
        expect(requestBody.history_and_training_disabled).toBeUndefined();
        expect((requestBody.messages as Array<{ content: { parts: string[] } }>)[0].content.parts[0])
          .toContain("Use ChatGPT image generation tools");
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    });
  });

  test("resumes a persisted image task without submitting a new conversation", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const artifactDir = await mkdtemp(join(tmpdir(), "pro-image-resume-"));
      try {
        const calls: string[] = [];
        const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
          calls.push(expression);
          if (expression.includes("/backend-api/conversation/")) {
            return {
              ok: true,
              status: 200,
              title: "Resumed image",
              asyncStatus: 4,
              assets: [
                {
                  fileId: "file_resumed_image",
                  assetPointer: "sediment://file_resumed_image",
                  width: 512,
                  height: 512,
                  sizeBytes: 7,
                  title: "Resumed image",
                  genId: "gen_resumed",
                },
              ],
            } as T;
          }
          if (expression.includes("/backend-api/files/download/")) {
            return {
              ok: true,
              status: 200,
              contentType: "image/png",
              bytes: 7,
              base64: Buffer.from("resume!").toString("base64"),
              fileName: "resumed.png",
            } as T;
          }
          throw new Error("Unexpected conversation submission.");
        });

        const result = await runChatGptResearchTask(
          { taskId: "image:conversation-resume", conversationId: "conversation-resume", title: "Resumed image" },
          { sessionTokenPath, pageEvaluator, artifactDir },
        );

        const parsed = JSON.parse(result) as { images: Array<{ path: string; fileId: string }> };
        expect(parsed.images[0].fileId).toBe("file_resumed_image");
        expect(await readFile(parsed.images[0].path, "utf8")).toBe("resume!");
        expect(calls.some((call) => call.includes("/backend-api/f/conversation"))).toBe(false);
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    });
  });

  test("rejects Deep Research acknowledgement-only responses as incomplete", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const acknowledgement = [
        "Understood. I'll conduct a deep, price-blind analysis comparing Stripe's private/public valuation outlook versus American Express's public market cap by December 31, 2026.",
        "",
        "This includes:",
        "- Stripe's likely valuation trajectory",
        "- American Express's valuation drivers",
        "- Resolution edge cases",
        "",
        "I'll return with a structured deep research report shortly.",
      ].join("\n");
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({ ok: true, status: 200, body: conversationStream(acknowledgement) }) as T);

      try {
        await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
          sessionTokenPath,
          pageEvaluator,
        });
        throw new Error("Expected INCOMPLETE_RESEARCH_ACK.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("INCOMPLETE_RESEARCH_ACK");
        expect(proError.message).toContain("acknowledgement");
        expect(proError.suggestions.join("\n")).toContain("gpt-5-5-pro");
        expect(proError.details?.model).toBe("research");
        expect(proError.details?.chars).toBe(acknowledgement.length);
      }
    });
  });

  test("returns completed Deep Research artifacts normally", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const report = [
        "Executive summary",
        "Stripe is the underdog but has a plausible right-tail path.",
        "",
        "Findings",
        "1. Stripe private-market signals remain below AXP's current market cap.",
        "2. AXP multiple compression is the main path for a Stripe win.",
        "",
        "Sources",
        "- Nasdaq Private Market",
        "- American Express investor relations",
      ].join("\n");
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({ ok: true, status: 200, body: conversationStream(report) }) as T);

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe(report);
    });
  });

  test("polls Deep Research async tasks and returns the final task message", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let taskCalls = 0;
      const launchedTasks: string[] = [];
      const statuses: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        if (expression.includes("/backend-api/task/")) {
          taskCalls += 1;
          return {
            ok: true,
            status: 200,
            body: {
              status: "completed",
              final_message: {
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["Final Deep Research report."] },
                status: "finished_successfully",
              },
            },
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: researchLaunchStream("deepresch_test", "I'll return with a structured deep research report shortly."),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
        onResearchTask: (task) => {
          launchedTasks.push(task.taskId);
        },
        onResearchTaskStatus: (update) => {
          statuses.push(update.status);
        },
      });

      expect(result).toBe("Final Deep Research report.");
      expect(taskCalls).toBe(1);
      expect(launchedTasks).toEqual(["deepresch_test"]);
      expect(statuses).toEqual(["completed"]);
    });
  });

  test("polls Deep Research connector widget state and returns the final report", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const calls: string[] = [];
      const launchedTasks: string[] = [];
      const statuses: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        calls.push(expression);
        if (expression.includes("/backend-api/conversation/")) {
          return {
            ok: true,
            status: 200,
            statusText: "completed",
            title: "Connector research",
            finalText: "Final connector report.",
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: deepResearchWidgetLaunchStream("conversation-widget", "widget-session-1"),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
        onResearchTask: (task) => {
          launchedTasks.push(task.taskId);
        },
        onResearchTaskStatus: (update) => {
          statuses.push(update.status);
        },
      });

      expect(result).toBe("Final connector report.");
      expect(launchedTasks).toEqual(["widget-session-1"]);
      expect(statuses).toEqual(["completed"]);
      expect(calls.some((call) => call.includes("/backend-api/conversation/"))).toBe(true);
      expect(calls.some((call) => call.includes("/backend-api/task/"))).toBe(false);
    });
  });

  test("polls Deep Research connector widgets when the launch stream has no assistant text", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const launchedTasks: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        if (expression.includes("/backend-api/conversation/")) {
          return {
            ok: true,
            status: 200,
            statusText: "completed",
            title: "Connector research",
            finalText: "Final report after metadata-only launch.",
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: deepResearchWidgetToolOnlyLaunchStream("conversation-widget", "widget-session-1"),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
        onResearchTask: (task) => {
          launchedTasks.push(task.taskId);
        },
      });

      expect(result).toBe("Final report after metadata-only launch.");
      expect(launchedTasks).toEqual(["widget-session-1"]);
    });
  });

  test("resumes polling a persisted Deep Research connector widget without submitting a new conversation", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const expressions: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        expressions.push(expression);
        expect(expression).toContain("/backend-api/conversation/");
        return {
          ok: true,
          status: 200,
          statusText: "completed",
          title: "Persisted connector research",
          finalText: "Recovered connector report.",
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "widget-session-2", title: "Persisted connector research", conversationId: "conversation-widget" },
        { sessionTokenPath, pageEvaluator },
      );

      expect(result).toBe("Recovered connector report.");
      expect(expressions).toHaveLength(1);
      expect(expressions[0]).not.toContain("/backend-api/f/conversation");
      expect(expressions[0]).not.toContain("/backend-api/task/");
    });
  });

  test("continues Deep Research connector widget polling after a transient CDP timeout", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          throw new ProError("CDP_TIMEOUT", "Chrome CDP command Runtime.evaluate timed out.");
        }
        return {
          ok: true,
          status: 200,
          statusText: "completed",
          title: "Connector timeout recovery",
          finalText: "Recovered connector report after CDP timeout.",
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "widget-session-timeout", title: "Timeout recovery", conversationId: "conversation-widget" },
        { sessionTokenPath, pageEvaluator, timeoutMs: 50 },
      );

      expect(result).toBe("Recovered connector report after CDP timeout.");
      expect(attempts).toBe(2);
    });
  });

  test("backs off and continues Deep Research connector widget polling after HTTP 429", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const statuses: string[] = [];
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false,
            status: 429,
            statusText: null,
            title: null,
            finalText: null,
            preview: '{"detail":"Too many requests"}',
          } as T;
        }
        return {
          ok: true,
          status: 200,
          statusText: "completed",
          title: "Connector rate-limit recovery",
          finalText: "Recovered connector report after rate limit.",
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "widget-session-rate-limited", title: "Rate-limit recovery", conversationId: "conversation-widget" },
        {
          sessionTokenPath,
          pageEvaluator,
          timeoutMs: 50,
          onResearchTaskStatus: (update) => {
            statuses.push(update.status);
          },
        },
      );

      expect(result).toBe("Recovered connector report after rate limit.");
      expect(attempts).toBe(2);
      expect(statuses).toEqual(["rate_limited", "completed"]);
    });
  });

  test("resumes polling a persisted Deep Research async task without submitting a new conversation", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const expressions: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        expressions.push(expression);
        expect(expression).toContain("/backend-api/task/");
        return {
          ok: true,
          status: 200,
          body: {
            status: "completed",
            final_message: {
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["Recovered final report."] },
              status: "finished_successfully",
            },
          },
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "deepresch_persisted", title: "Persisted research" },
        { sessionTokenPath, pageEvaluator },
      );

      expect(result).toBe("Recovered final report.");
      expect(expressions).toHaveLength(1);
      expect(expressions[0]).not.toContain("/backend-api/f/conversation");
    });
  });

  test("continues Deep Research polling after a transient CDP timeout", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          throw new ProError("CDP_TIMEOUT", "Chrome CDP command Runtime.evaluate timed out.");
        }
        return {
          ok: true,
          status: 200,
          body: {
            status: "completed",
            final_message: {
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["Recovered after CDP timeout."] },
              status: "finished_successfully",
            },
          },
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "deepresch_timeout", title: "Timeout recovery" },
        { sessionTokenPath, pageEvaluator, timeoutMs: 5 },
      );

      expect(result).toBe("Recovered after CDP timeout.");
      expect(attempts).toBe(2);
    });
  });

  test("recovers Deep Research task metadata from the saved conversation when the stream omits it", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const calls: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        calls.push(expression);
        if (expression.includes("/backend-api/conversation/")) {
          return {
            ok: true,
            status: 200,
            task: {
              taskId: "deepresch_from_conversation",
              title: "Recovered research task",
              conversationId: "async-conversation",
            },
          } as T;
        }
        if (expression.includes("/backend-api/task/")) {
          return {
            ok: true,
            status: 200,
            body: {
              status: "completed",
              final_message: {
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["Recovered report."] },
                status: "finished_successfully",
              },
            },
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: researchAckConversationStream("conversation-1", "I'll return with the report shortly."),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe("Recovered report.");
      expect(calls.some((call) => call.includes("/backend-api/conversation/"))).toBe(true);
      expect(calls.some((call) => call.includes("/backend-api/task/"))).toBe(true);
    });
  });

  test("recovers Deep Research task metadata when the acknowledgement is wrapped in research JSON", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const calls: string[] = [];
      const acknowledgementEnvelope = JSON.stringify({
        task_violates_safety_guidelines: false,
        user_def_doesnt_want_research: false,
        response: "Understood. I'll begin deep research now and get back to you shortly.",
        title: "Ceasefire research",
        prompt: "Conduct a price-blind deep analysis.",
      });
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        calls.push(expression);
        if (expression.includes("/backend-api/conversation/")) {
          return {
            ok: true,
            status: 200,
            task: {
              taskId: "deepresch_json_envelope",
              title: "Recovered JSON-envelope research task",
            },
          } as T;
        }
        if (expression.includes("/backend-api/task/")) {
          return {
            ok: true,
            status: 200,
            body: {
              status: "completed",
              final_message: {
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["Recovered JSON-envelope report."] },
                status: "finished_successfully",
              },
            },
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: researchAckConversationStream("conversation-2", acknowledgementEnvelope),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe("Recovered JSON-envelope report.");
      expect(calls.some((call) => call.includes("/backend-api/conversation/"))).toBe(true);
      expect(calls.some((call) => call.includes("/backend-api/task/"))).toBe(true);
    });
  });

  test("keeps Deep Research async tasks non-successful while the task is still running", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        if (expression.includes("/backend-api/task/")) {
          return {
            ok: true,
            status: 200,
            body: { status: "running", task_id: "deepresch_test", final_message: null, messages: [] },
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: researchLaunchStream("deepresch_test", "I'll return with a structured deep research report shortly."),
        } as T;
      });

      try {
        await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
          sessionTokenPath,
          pageEvaluator,
          timeoutMs: 1,
        });
        throw new Error("Expected RESEARCH_TASK_INCOMPLETE.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("RESEARCH_TASK_INCOMPLETE");
        expect(proError.details?.taskId).toBe("deepresch_test");
        expect(proError.details?.status).toBe("running");
      }
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

function researchLaunchStream(taskId: string, acknowledgement: string): string {
  return [
    `data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(acknowledgement)}]},"status":"finished_successfully"}}`,
    `data: {"v":{"message":{"author":{"role":"tool"},"content":{"content_type":"text","parts":[""]},"status":"finished_successfully","metadata":{"async_task_id":${JSON.stringify(taskId)},"async_task_title":"Research task","async_task_type":"research"}}}}`,
    'data: {"type":"message_stream_complete"}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function deepResearchWidgetLaunchStream(conversationId: string, widgetSessionId: string): string {
  const toolCall = JSON.stringify({
    path: "/Deep Research App/implicit_link::connector_openai_deep_research/start",
    args: { user_query: "Research this." },
  });
  return [
    `data: {"conversation_id":${JSON.stringify(conversationId)},"message":{"author":{"role":"assistant"},"recipient":"api_tool.call_tool","content":{"content_type":"text","parts":[${JSON.stringify(toolCall)}]},"status":"finished_successfully"}}`,
    `data: {"v":{"message":{"author":{"role":"tool","name":"api_tool.call_tool"},"content":{"content_type":"code","text":"{}"},"status":"finished_successfully","metadata":{"chatgpt_sdk":{"widget_session_id":${JSON.stringify(widgetSessionId)},"resolved_pineapple_uri":"connectors://connector_openai_deep_research","attribution_id":"connector_openai_deep_research","widget_state":${JSON.stringify(JSON.stringify({ status: "waiting_for_user_response_on_plan", plan: { title: "Connector research" } }))}}}}}}`,
    'data: {"type":"message_stream_complete"}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function deepResearchWidgetToolOnlyLaunchStream(conversationId: string, widgetSessionId: string): string {
  return [
    `data: {"conversation_id":${JSON.stringify(conversationId)}}`,
    `data: {"v":{"message":{"author":{"role":"tool","name":"api_tool.call_tool"},"content":{"content_type":"code","text":"{}"},"status":"finished_successfully","metadata":{"chatgpt_sdk":{"widget_session_id":${JSON.stringify(widgetSessionId)},"resolved_pineapple_uri":"connectors://connector_openai_deep_research","attribution_id":"connector_openai_deep_research","widget_state":${JSON.stringify(JSON.stringify({ status: "waiting_for_user_response_on_plan", plan: { title: "Connector research" } }))}}}}}}`,
    'data: {"type":"message_stream_complete"}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function researchAckConversationStream(conversationId: string, acknowledgement: string): string {
  return [
    `data: {"conversation_id":${JSON.stringify(conversationId)},"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(acknowledgement)}]},"status":"finished_successfully"}}`,
    'data: {"type":"message_stream_complete"}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function imageLaunchStream(conversationId: string): string {
  return [
    `data: {"conversation_id":${JSON.stringify(conversationId)},"message":{"author":{"role":"tool","name":"image_gen"},"content":{"content_type":"multimodal_text","parts":[]},"status":"finished_successfully","metadata":{"ghostrider":{"status":"intermediate"}}}}`,
    `data: {"type":"server_ste_metadata","metadata":{"turn_use_case":"image gen"},"conversation_id":${JSON.stringify(conversationId)}}`,
    `data: {"type":"message_stream_complete","conversation_id":${JSON.stringify(conversationId)}}`,
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
