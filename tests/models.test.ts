import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { listModels } from "../src/models";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function withTokenFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-model-test-"));
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

describe("model discovery", () => {
  test("falls back to static models when no session token is available", async () => {
    const result = await listModels({ sessionTokenPath: "/tmp/pro-query-missing-token.json" });

    expect(result.source).toBe("static");
    expect(result.warning).toContain("No captured ChatGPT session token");
    expect(result.defaultModel).toBe("gpt-5-5-pro");
    expect(result.models.map((model) => model.id)).not.toContain("auto");
    expect(result.models.map((model) => model.id)).toContain("gpt-5-5-pro");
    expect(result.models.map((model) => model.id)).toContain("gpt-4-5");
    expect(result.models.find((model) => model.id === "research")).toMatchObject({
      label: "Deep Research",
      reasoningLevels: ["standard", "extended"],
      reasoningType: "pro",
      configurableThinkingEffort: true,
    });
  });

  test("loads live ChatGPT model catalog with bearer auth", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let authHeader = "";
      let accountHeader = "";
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        authHeader = headers.get("authorization") ?? "";
        accountHeader = headers.get("chatgpt-account-id") ?? "";
        return Response.json({
          default_model_slug: "gpt-5-5",
          model_picker_version: 2,
          models: [
            {
              slug: "gpt-5-5-pro",
              title: "GPT-5.5 Pro",
              max_tokens: 272000,
              reasoning_type: "pro",
              configurable_thinking_effort: true,
              thinking_efforts: [
                { thinking_effort: "standard", short_label: "Standard" },
                { thinking_effort: "extended", short_label: "Extended" },
              ],
              enabled_tools: [{ type: "python" }, { type: "web" }],
            },
          ],
        });
      }) as unknown as typeof fetch;

      const result = await listModels({ sessionTokenPath });

      expect(authHeader).toStartWith("Bearer ");
      expect(accountHeader).toBe("acct_test");
      expect(result.source).toBe("live");
      expect(result.defaultModel).toBe("gpt-5-5-pro");
      expect(result.chatgptDefaultModel).toBe("gpt-5-5");
      expect(result.modelPickerVersion).toBe(2);
      expect(result.models[0]).toMatchObject({
        id: "gpt-5-5-pro",
        label: "GPT-5.5 Pro",
        default: true,
        maxTokens: 272000,
        reasoningLevels: ["standard", "extended"],
        enabledTools: ["python", "web"],
      });
    });
  });

  test("calls the documented ChatGPT models endpoint", async () => {
    // Lock down which URL we hit so a refactor cannot silently retarget
    // it to a different (perhaps internal) endpoint.
    await withTokenFile(async (sessionTokenPath) => {
      let observedUrl = "";
      globalThis.fetch = (async (url: string | URL | Request) => {
        observedUrl = String(url);
        return Response.json({
          default_model_slug: "gpt-5-5",
          models: [{ slug: "gpt-5-5-pro", title: "GPT-5.5 Pro", reasoning_type: "pro" }],
        });
      }) as unknown as typeof fetch;
      const result = await listModels({ sessionTokenPath });
      expect(observedUrl).toBe("https://chatgpt.com/backend-api/models");
      expect(result.source).toBe("live");
    });
  });

  test("filters auto and malformed live model entries without dropping usable entries", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      globalThis.fetch = (async () =>
        Response.json({
          default_model_slug: "auto",
          models: [
            { slug: "auto", title: "Auto" },
            { slug: 123, title: "Bad slug" },
            { slug: "gpt-5-5-pro", title: "GPT-5.5 Pro", reasoning_type: "pro" },
          ],
        })) as unknown as typeof fetch;

      const result = await listModels({ sessionTokenPath });
      expect(result.source).toBe("live");
      expect(result.models.map((model) => model.id)).toEqual(["gpt-5-5-pro"]);
    });
  });

  test("overrides live Deep Research capability with observed web UI reasoning levels", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      globalThis.fetch = (async () =>
        Response.json({
          default_model_slug: "gpt-5-5",
          models: [
            {
              slug: "research",
              title: "Deep Research",
              reasoning_type: "none",
              thinking_efforts: [],
              configurable_thinking_effort: false,
            },
          ],
        })) as unknown as typeof fetch;

      const result = await listModels({ sessionTokenPath });

      expect(result.source).toBe("live");
      expect(result.models[0]).toMatchObject({
        id: "research",
        label: "Deep Research",
        reasoningLevels: ["standard", "extended"],
        reasoningType: "pro",
        configurableThinkingEffort: true,
      });
    });
  });

  test("falls back to static models on upstream HTTP error (does not crash)", async () => {
    // Regression guard: a 500 from the catalog endpoint should NOT block
    // the user from using known-good static models.
    await withTokenFile(async (sessionTokenPath) => {
      globalThis.fetch = (async () =>
        new Response("upstream broke", { status: 500 })) as unknown as typeof fetch;
      const result = await listModels({ sessionTokenPath });
      expect(result.source).toBe("static");
      expect(result.models.map((m) => m.id)).toContain("gpt-5-5-pro");
    });
  });

  test("falls back to static models when fetch itself rejects", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      globalThis.fetch = (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch;
      const result = await listModels({ sessionTokenPath });
      expect(result.source).toBe("static");
    });
  });

  test("falls back to static models when the live catalog has no usable entries", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      globalThis.fetch = (async () =>
        Response.json({
          default_model_slug: "gpt-5-5",
          models: [
            { slug: "auto", title: "Auto" },
            { slug: "missing-title" },
            { title: "Missing slug" },
          ],
        })) as unknown as typeof fetch;

      const result = await listModels({ sessionTokenPath });

      expect(result.source).toBe("static");
      expect(result.warning).toContain("no usable model entries");
      expect(result.models.map((model) => model.id)).toContain("gpt-5-5-pro");
    });
  });

  test("falls back to static models when the token lacks an account id and does not call fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-model-no-account-"));
    const path = join(dir, "token.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          source: "pro-cli-cdp-page",
          accessToken: fakeJwt(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return Response.json({ models: [] });
      }) as unknown as typeof fetch;

      const result = await listModels({ sessionTokenPath: path });

      expect(result.source).toBe("static");
      expect(result.warning).toContain("no account id");
      expect(fetchCalled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to static models for an expired session token (does not call fetch)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-model-expired-"));
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
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response("{}");
      }) as unknown as typeof fetch;
      const result = await listModels({ sessionTokenPath: path });
      expect(result.source).toBe("static");
      expect(fetchCalled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function fakeJwt(): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  };
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
}
