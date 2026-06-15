import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateInCdpPage, recoverCookieBloatInCdp } from "./cdp";
import { chatGptOrigins } from "./cookies";
import { DEFAULT_MODEL, isReasoningLevel } from "./defaults";
import { EXIT, ProError } from "./errors";
import type { JobRecord, LimitsObservation } from "./jobs";
import { canonicalModelId, modelUsesThinkingEffort } from "./models";
import { isTokenFresh, loadSessionToken } from "./session-token";

const CHATGPT_CONVERSATION_ENDPOINT = "https://chatgpt.com/backend-api/f/conversation";
const DEFAULT_CDP_BASE = "http://127.0.0.1:9222";
const DEFAULT_RESEARCH_TASK_POLL_MS = 5_000;
const DEFAULT_RESEARCH_WIDGET_POLL_MS = 30_000;
const DEFAULT_RESEARCH_WIDGET_RATE_LIMIT_POLL_MS = 60_000;
const DEFAULT_BROWSER_REQUEST_TIMEOUT_MS = 30 * 60_000;
const MAX_REQUEST_TIMEOUT_MS = 24 * 60 * 60_000;
const DEEP_RESEARCH_CONNECTOR_ID = "connector_openai_deep_research";
const DEEP_RESEARCH_ROUTER_MODEL = "gpt-5-5";
const IMAGE_TASK_PREFIX = "image:";
const DEFAULT_IMAGE_POLL_MS = 3_000;
const DEFAULT_IMAGE_RATE_LIMIT_POLL_MS = 30_000;

type PageEvaluator = <T>(cdpBase: string, expression: string, timeoutMs?: number) => Promise<T>;

export interface TransportOptions {
  sessionTokenPath: string;
  cdpBase?: string;
  pageEvaluator?: PageEvaluator;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  artifactDir?: string;
  onLimits?: (observations: LimitsObservation[]) => void;
  onResearchTask?: (task: ResearchTask) => void | Promise<void>;
  onResearchTaskStatus?: (update: ResearchTaskStatusUpdate) => void | Promise<void>;
}

export interface ResearchTask {
  taskId: string;
  title?: string;
  conversationId?: string;
}

export interface ResearchTaskStatusUpdate extends ResearchTask {
  status: string;
}

export async function runChatGptJob(job: JobRecord, options: TransportOptions): Promise<string> {
  const session = await loadFreshSession(options.sessionTokenPath);
  const retries = integerOption(options.retries, 0, 0, 5) ?? 0;
  const retryDelayMs = integerOption(options.retryDelayMs, 500, 0, 60_000) ?? 500;
  let lastError: ProError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await postChatGptJob(job, { accountId: session.accountId }, options);
    } catch (error) {
      const proError = error instanceof ProError ? error : networkError(error);
      lastError = proError;
      if (attempt >= retries || !isRetryable(proError)) throw withAttemptDetails(proError, attempt + 1);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }

  throw lastError ?? new ProError("UPSTREAM_ERROR", "ChatGPT backend request failed.", { exitCode: EXIT.upstream });
}

export async function runChatGptResearchTask(task: ResearchTask, options: TransportOptions): Promise<string> {
  await loadFreshSession(options.sessionTokenPath);
  const retries = integerOption(options.retries, 0, 0, 5) ?? 0;
  const retryDelayMs = integerOption(options.retryDelayMs, 500, 0, 60_000) ?? 500;
  const timeoutMs = integerOption(options.timeoutMs, 0, 0, MAX_REQUEST_TIMEOUT_MS) ?? 0;
  let lastError: ProError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const evaluate = options.pageEvaluator ?? evaluateInCdpPage;
      const cdpBase = options.cdpBase ?? DEFAULT_CDP_BASE;
      if (isImageTask(task)) {
        const conversationId = imageConversationIdFromTask(task);
        if (!conversationId) {
          throw new ProError("IMAGE_TASK_UNAVAILABLE", "Image generation polling needs a saved conversation id.", {
            exitCode: EXIT.upstream,
            suggestions: ["Open the saved ChatGPT conversation to inspect the image generation."],
            details: { taskId: task.taskId, title: task.title },
          });
        }
        return await waitForImageResult(conversationId, evaluate, cdpBase, timeoutMs, options, {
          jobId: task.taskId.replace(IMAGE_TASK_PREFIX, "") || task.taskId,
          prompt: "",
          initialText: "",
        });
      }
      return await waitForResearchTask(task, evaluate, cdpBase, timeoutMs, options);
    } catch (error) {
      const proError = error instanceof ProError ? error : networkError(error);
      lastError = proError;
      if (attempt >= retries || !isRetryable(proError)) throw withAttemptDetails(proError, attempt + 1);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }

  throw lastError ?? new ProError("UPSTREAM_ERROR", "ChatGPT Deep Research task polling failed.", {
    exitCode: EXIT.upstream,
  });
}

async function loadFreshSession(sessionTokenPath: string): Promise<{ accountId: string }> {
  const session = await loadSessionToken(sessionTokenPath).catch(() => null);
  if (!session) {
    throw new ProError("SESSION_TOKEN_MISSING", "No ChatGPT session token is available.", {
      exitCode: EXIT.auth,
      suggestions: ["Run pro-cli auth capture from a logged-in ChatGPT CDP browser."],
    });
  }
  if (!isTokenFresh(session)) {
    throw new ProError("SESSION_TOKEN_EXPIRED", "The ChatGPT session token is expired.", {
      exitCode: EXIT.auth,
      suggestions: ["Run pro-cli auth capture again from a logged-in ChatGPT browser."],
    });
  }
  if (!session.accountId) {
    throw new ProError("ACCOUNT_ID_MISSING", "The ChatGPT account id is missing from the token.", {
      exitCode: EXIT.auth,
      suggestions: ["Run pro-cli auth capture again and confirm ChatGPT is logged in."],
    });
  }
  return { accountId: session.accountId };
}

async function postChatGptJob(
  job: JobRecord,
  session: { accountId: string },
  options: TransportOptions,
): Promise<string> {
  const timeoutMs = integerOption(options.timeoutMs ?? job.options.timeoutMs, 0, 0, MAX_REQUEST_TIMEOUT_MS) ?? 0;

  try {
    const evaluate = options.pageEvaluator ?? evaluateInCdpPage;
    const cdpBase = options.cdpBase ?? DEFAULT_CDP_BASE;
    let browserResult = await evaluate<BrowserFetchResult>(
      cdpBase,
      buildBrowserFetchExpression(buildRequestBody(job), session.accountId),
      timeoutMs || DEFAULT_BROWSER_REQUEST_TIMEOUT_MS,
    );
    if (!options.pageEvaluator && shouldRecoverCookieBloat(browserResult)) {
      const recovered = await recoverCookieBloatInCdp(cdpBase, chatGptOrigins(), timeoutMs || 10_000).catch(() => null);
      if (recovered?.deleted) {
        browserResult = await evaluate<BrowserFetchResult>(
          cdpBase,
          buildBrowserFetchExpression(buildRequestBody(job), session.accountId),
          timeoutMs || DEFAULT_BROWSER_REQUEST_TIMEOUT_MS,
        );
      }
    }

    if (browserResult.code === "CHATGPT_PAGE_MISSING") {
      throw new ProError("CHATGPT_PAGE_MISSING", "No logged-in ChatGPT page is available over CDP.", {
        exitCode: EXIT.auth,
        suggestions: [
          "Open the Chrome command from pro-cli auth command.",
          "Confirm the CDP Chrome window is on https://chatgpt.com/ and logged in.",
          "Pass --cdp if Chrome is using a non-default CDP port.",
        ],
        details: { cdpBase },
      });
    }

    if (browserResult.code === "CHATGPT_PAGE_LOGGED_OUT") {
      throw new ProError("CHATGPT_PAGE_LOGGED_OUT", "The ChatGPT CDP page is not logged in.", {
        exitCode: EXIT.auth,
        suggestions: [
          "Sign in to ChatGPT in the Chrome window from pro-cli auth command.",
          "Run pro-cli auth capture --cdp http://127.0.0.1:9222 --json after login.",
          "Retry pro-cli ask with the same --cdp value.",
        ],
        details: { status: browserResult.status },
      });
    }

    if (browserResult.code === "CHATGPT_PROBE_FAILED") {
      const status = browserResult.status;
      const suggestions =
        status === 431
          ? [
              "HTTP 431 indicates oversize request headers; the CDP Chrome profile likely has stale cookie buildup.",
              "Sign out of ChatGPT in the CDP window, sign back in to drop expired cookies, then run pro-cli auth capture --cdp http://127.0.0.1:9222 --json.",
              "If 431 persists, delete ~/.pro-cli/chrome-profile and rerun pro-cli auth command.",
            ]
          : [
              `The ChatGPT auth session probe failed with HTTP ${status}; pro-cli cannot tell whether the page is logged in.`,
              "Reload the CDP ChatGPT tab and retry. Run pro-cli doctor --json for diagnostics.",
            ];
      throw new ProError(
        "CHATGPT_PROBE_FAILED",
        `Could not determine ChatGPT login state from the CDP page (HTTP ${status}).`,
        {
          exitCode: EXIT.auth,
          suggestions,
          details: { status, preview: browserResult.body.slice(0, 240).replace(/\s+/g, " ") },
        },
      );
    }

    if (!browserResult.ok) {
      throw new ProError("UPSTREAM_REJECTED", `ChatGPT backend returned HTTP ${browserResult.status}.`, {
        exitCode: EXIT.upstream,
        suggestions: ["Run pro-cli auth capture again.", "Check whether the ChatGPT Pro usage limit is reached."],
        details: {
          status: browserResult.status,
          preview: browserResult.body.slice(0, 160).replace(/\s+/g, " "),
        },
      });
    }

    const model = canonicalModelId(job.model);
    const parsed = readResponse(browserResult.body, options.onLimits, {
      allowEmptyWithConversation: model === "image",
    });
    if (model === "image") {
      if (parsed.text.toLowerCase().includes("image generation isn") && parsed.text.toLowerCase().includes("temporary chat")) {
        throw new ProError("IMAGE_TEMPORARY_UNAVAILABLE", "ChatGPT image generation is not available in temporary chats.", {
          exitCode: EXIT.upstream,
          suggestions: ["Use a saved ChatGPT conversation for image generation; omit --temporary."],
          details: { preview: parsed.text.slice(0, 240), conversationId: parsed.conversationId },
        });
      }
      if (!parsed.conversationId) {
        throw new ProError("IMAGE_CONVERSATION_MISSING", "ChatGPT did not return a conversation id for image generation.", {
          exitCode: EXIT.upstream,
          suggestions: ["Retry only if the user still needs a new real image generation."],
          details: { preview: parsed.text.slice(0, 240) },
        });
      }
      await options.onResearchTask?.({
        taskId: imageTaskId(parsed.conversationId),
        title: "Image generation",
        conversationId: parsed.conversationId,
      });
      return await waitForImageResult(parsed.conversationId, evaluate, cdpBase, timeoutMs, options, {
        jobId: job.id,
        prompt: job.prompt,
        initialText: parsed.text,
      });
    }
    if (model === "research") {
      const asyncTask = parsed.deepResearchWidget
        ?? parsed.asyncTask
        ?? (isDeepResearchAppToolCall(parsed.text) && parsed.conversationId
          ? await waitForResearchWidgetFromConversation(parsed.conversationId, evaluate, cdpBase)
          : null)
        ?? (isIncompleteResearchAcknowledgement(parsed.text) && parsed.conversationId
          ? await waitForResearchTaskFromConversation(parsed.conversationId, evaluate, cdpBase)
          : null);
      if (asyncTask?.taskId) {
        await options.onResearchTask?.(asyncTask);
        return await waitForResearchTask(asyncTask, evaluate, cdpBase, timeoutMs, options);
      }
      if (isDeepResearchAppToolCall(parsed.text)) {
        throw new ProError(
          "RESEARCH_WIDGET_UNAVAILABLE",
          "Deep Research started the connector widget but pro-cli could not find its widget session.",
          {
            exitCode: EXIT.upstream,
            suggestions: [
              "Open the saved ChatGPT conversation to inspect the Deep Research widget.",
              "Retry only if the user still needs a new real Deep Research run; every retry may spend Pro quota.",
            ],
            details: { conversationId: parsed.conversationId, preview: parsed.text.slice(0, 240) },
          },
        );
      }
    }
    validateCompletedResult(job, parsed.text);
    return parsed.text;
  } catch (error) {
    if (error instanceof ProError) throw error;
    throw networkError(error);
  }
}

function shouldRecoverCookieBloat(result: BrowserFetchResult): boolean {
  return result.status === 431 || result.body.includes("chrome-error://chromewebdata/");
}

interface BrowserFetchResult {
  ok: boolean;
  status: number;
  body: string;
  code?: "CHATGPT_PAGE_MISSING" | "CHATGPT_PAGE_LOGGED_OUT" | "CHATGPT_PROBE_FAILED";
}

function buildBrowserFetchExpression(requestBody: Record<string, unknown>, accountId: string): string {
  return `(${async function browserFetch(
    endpoint: string,
    body: Record<string, unknown>,
    account: string,
  ): Promise<BrowserFetchResult> {
    if (location.origin !== "https://chatgpt.com") {
      return {
        ok: false,
        status: 0,
        code: "CHATGPT_PAGE_MISSING",
        body: `Expected https://chatgpt.com, got ${location.href}`,
      };
    }

    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include", referrerPolicy: "no-referrer" });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    if (!sessionResponse.ok && sessionResponse.status !== 401) {
      return {
        ok: false,
        status: sessionResponse.status,
        code: "CHATGPT_PROBE_FAILED",
        body: `ChatGPT auth session probe returned HTTP ${sessionResponse.status}.`,
      };
    }
    if (typeof session?.accessToken !== "string" || !session.accessToken) {
      return {
        ok: false,
        status: sessionResponse.status,
        code: "CHATGPT_PAGE_LOGGED_OUT",
        body: "ChatGPT page session did not include an access token.",
      };
    }

    const accessToken = session.accessToken;
    const turnTraceId = crypto.randomUUID();
    const requestBody = withBrowserContext(body);
    const referrer = chatReferrer(requestBody);
    const prepareBody = buildPrepareBody(requestBody);
    const prepareResponse = await fetch("https://chatgpt.com/backend-api/f/conversation/prepare", {
      method: "POST",
      credentials: "include",
      referrer,
      headers: appHeaders("/f/conversation/prepare", accessToken, {
        "x-conduit-token": "no-token",
        "x-oai-turn-trace-id": turnTraceId,
      }),
      body: JSON.stringify(prepareBody),
    });
    const preparedConversation = (await prepareResponse.json().catch(() => null)) as
      | { conduit_token?: unknown }
      | null;
    const conduitToken =
      prepareResponse.ok && typeof preparedConversation?.conduit_token === "string"
        ? preparedConversation.conduit_token
        : null;

    const headers = {
      ...appHeaders("/f/conversation", accessToken, {
        accept: "text/event-stream",
        "x-oai-turn-trace-id": turnTraceId,
        ...(conduitToken ? { "x-conduit-token": conduitToken } : {}),
      }),
      ...(await chatRequirementsHeaders(accessToken, referrer)),
    };

    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      referrer,
      headers,
      body: JSON.stringify({ ...requestBody, client_prepare_state: prepareResponse.ok ? "sent" : "none" }),
    });
    let text = await response.text().catch((error) => String(error));
    if (response.ok) {
      const resumedText = await resumeHandoffStream(text, accessToken, turnTraceId, referrer);
      if (resumedText) text = `${text}\n\n${resumedText}`;
    }
    return { ok: response.ok, status: response.status, body: text };

    function appHeaders(
      routeName: string,
      accessToken: string,
      extraHeaders: Record<string, string> = {},
    ): Record<string, string> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "oai-language": navigator.language || "en-US",
        "OAI-Client-Version": document.documentElement.getAttribute("data-build") ?? "",
        "OAI-Client-Build-Number": document.documentElement.getAttribute("data-seq") ?? "",
        "OAI-Device-Id": readJsonString(localStorage.getItem("oai-did")) ?? readCookie("oai-did") ?? "",
        "OAI-Session-Id": readSessionId(),
        "X-OpenAI-Target-Path": `/backend-api${routeName}`,
        "X-OpenAI-Target-Route": `/backend-api${routeName}`,
        ...extraHeaders,
      };
      const integrityState = readCookie("__Secure-oai-is");
      if (integrityState) headers["X-OAI-IS"] = integrityState;
      return Object.fromEntries(Object.entries(headers).filter(([, value]) => value.length > 0));
    }

    function buildPrepareBody(body: Record<string, unknown>): Record<string, unknown> {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const firstMessage = messages[0] as {
        id?: unknown;
        author?: unknown;
        content?: { parts?: unknown };
      } | undefined;
      const partialQuery = firstMessage
        ? {
            id: firstMessage.id,
            author: firstMessage.author,
            content: {
              ...(firstMessage.content ?? {}),
              parts: Array.isArray(firstMessage.content?.parts) ? firstMessage.content.parts : [],
            },
          }
        : undefined;
      const {
        messages: _messages,
        enable_message_followups: _followups,
        paragen_cot_summary_display_override: _paragen,
        force_parallel_switch: _parallel,
        ...prepareBody
      } = body;
      return {
        ...prepareBody,
        fork_from_shared_post: false,
        partial_query: partialQuery,
        client_prepare_state: "none",
        client_contextual_info: { app_name: appNameFor(body) },
      };
    }

    function withBrowserContext(body: Record<string, unknown>): Record<string, unknown> {
      return {
        ...body,
        timezone_offset_min: new Date().getTimezoneOffset(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        client_contextual_info: {
          is_dark_mode: matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false,
          time_since_loaded: Math.round(performance.now()),
          page_height: document.documentElement.scrollHeight,
          page_width: document.documentElement.scrollWidth,
          pixel_ratio: window.devicePixelRatio,
          screen_height: screen.height,
          screen_width: screen.width,
          app_name: appNameFor(body),
        },
      };
    }

    function appNameFor(body: Record<string, unknown>): string {
      return body.history_and_training_disabled === true ? "chatgpt.com" : "chatgpt";
    }

    function chatReferrer(body: Record<string, unknown>): string {
      return body.history_and_training_disabled === true
        ? "https://chatgpt.com/?temporary-chat=true"
        : "https://chatgpt.com/";
    }

    async function resumeHandoffStream(
      streamText: string,
      accessToken: string,
      turnTraceId: string,
      referrer: string,
    ): Promise<string | null> {
      const handoff = readHandoff(streamText);
      if (!handoff) return null;
      for (const offset of [0, 1, 2]) {
        const resumeResponse = await fetch("https://chatgpt.com/backend-api/f/conversation/resume", {
          method: "POST",
          credentials: "include",
          referrer,
          headers: appHeaders("/f/conversation/resume", accessToken, {
            accept: "text/event-stream",
            "x-conduit-token": handoff.token,
            "x-oai-turn-trace-id": turnTraceId,
          }),
          body: JSON.stringify({ conversation_id: handoff.conversationId, offset }),
        });
        const resumeText = await resumeResponse.text().catch(() => "");
        if (resumeResponse.ok && resumeText.trim()) return resumeText;
        if (resumeResponse.status !== 404) return null;
      }
      return null;
    }

    function readHandoff(streamText: string): { conversationId: string; token: string } | null {
      let conversationId: string | null = null;
      let token: string | null = null;
      for (const event of readSseJsonEvents(streamText)) {
        if (!event || typeof event !== "object") continue;
        const record = event as { type?: unknown; conversation_id?: unknown; token?: unknown };
        if (record.type === "resume_conversation_token") {
          if (typeof record.conversation_id === "string") conversationId = record.conversation_id;
          if (typeof record.token === "string") token = record.token;
        }
        if (record.type === "stream_handoff" && typeof record.conversation_id === "string") {
          conversationId = record.conversation_id;
        }
      }
      return conversationId && token ? { conversationId, token } : null;
    }

    function readSseJsonEvents(streamText: string): unknown[] {
      return streamText
        .split("\n\n")
        .flatMap((frame) => {
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data || data === "[DONE]") return [];
          try {
            return [JSON.parse(data) as unknown];
          } catch {
            return [];
          }
        });
    }

    function readCookie(name: string): string | null {
      const prefix = `${name}=`;
      const cookie = document.cookie
        .split("; ")
        .find((item) => item.startsWith(prefix));
      return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
    }

    function readJsonString(value: string | null): string | null {
      if (!value) return null;
      try {
        const parsed = JSON.parse(value) as unknown;
        return typeof parsed === "string" ? parsed : null;
      } catch {
        return value;
      }
    }

    function readSessionId(): string {
      const bootstrap = (window as unknown as { CLIENT_BOOTSTRAP?: { sessionId?: unknown } }).CLIENT_BOOTSTRAP;
      if (typeof bootstrap?.sessionId === "string" && bootstrap.sessionId) return bootstrap.sessionId;
      const statsigKey = Object.keys(localStorage).find((key) => key.startsWith("statsig.session_id."));
      if (statsigKey) {
        try {
          const statsig = JSON.parse(localStorage.getItem(statsigKey) ?? "{}") as { sessionID?: unknown };
          if (typeof statsig.sessionID === "string" && statsig.sessionID) return statsig.sessionID;
        } catch {
          // Ignore malformed local client telemetry state.
        }
      }
      return crypto.randomUUID();
    }

    async function chatRequirementsHeaders(accessToken: string, referrer: string): Promise<Record<string, string>> {
      const requirementsToken = buildRequirementsToken();
      const prepareResponse = await fetch(
        "https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare",
        {
          method: "POST",
          credentials: "include",
          referrer,
          headers: appHeaders("/sentinel/chat-requirements/prepare", accessToken),
          body: JSON.stringify({ p: requirementsToken }),
        },
      );
      const prepared = (await prepareResponse.json().catch(() => null)) as PreparedChatRequirements | null;
      if (!prepareResponse.ok || !prepared) {
        return {};
      }

      const finalizeBody: Record<string, string> = {
        prepare_token: typeof prepared.prepare_token === "string" ? prepared.prepare_token : "",
      };
      const proofToken = buildProofToken(prepared);
      if (proofToken) finalizeBody.proofofwork = proofToken;
      const turnstileToken = await buildTurnstileToken(prepared, requirementsToken);
      if (turnstileToken) finalizeBody.turnstile = turnstileToken;

      const finalizeResponse = await fetch(
        "https://chatgpt.com/backend-api/sentinel/chat-requirements/finalize",
        {
          method: "POST",
          credentials: "include",
          referrer,
          headers: appHeaders("/sentinel/chat-requirements/finalize", accessToken),
          body: JSON.stringify(finalizeBody),
        },
      );
      const finalized = (await finalizeResponse.json().catch(() => null)) as
        | { token?: unknown }
        | null;
      if (!finalizeResponse.ok || typeof finalized?.token !== "string" || !finalized.token) {
        return {};
      }

      const headers: Record<string, string> = {
        "OpenAI-Sentinel-Chat-Requirements-Token": finalized.token,
      };
      if (proofToken) headers["OpenAI-Sentinel-Proof-Token"] = proofToken;
      if (turnstileToken) headers["OpenAI-Sentinel-Turnstile-Token"] = turnstileToken;
      const timing = sentinelTiming();
      if (timing) headers["OAI-Telemetry"] = timing;
      return headers;
    }

    function buildRequirementsToken(): string {
      return `gAAAAAC${generateRequirementsTokenAnswer()}`;
    }

    function buildProofToken(prepared: PreparedChatRequirements): string | null {
      const proof = prepared.proofofwork;
      if (!proof?.required) return null;
      if (typeof proof.seed !== "string" || typeof proof.difficulty !== "string") return null;
      return `gAAAAAB${generateProofAnswer(proof.seed, proof.difficulty)}`;
    }

    async function buildTurnstileToken(
      prepared: PreparedChatRequirements,
      requirementsToken: string,
    ): Promise<string | null> {
      const turnstile = prepared.turnstile;
      if (!turnstile?.required) return null;
      if (typeof turnstile.dx === "string" && turnstile.dx) {
        return await runDxProgram(requirementsToken, turnstile.dx).catch(() => null);
      }
      return null;
    }

    function sentinelTiming(): string | null {
      try {
        const sentinel = (window as unknown as { SentinelSDK?: { timing?: () => unknown } }).SentinelSDK;
        const timing = sentinel?.timing?.();
        return typeof timing === "string" ? timing : null;
      } catch {
        return null;
      }
    }

    async function runDxProgram(secret: string, dx: string): Promise<string> {
      const opXorAsync = 0;
      const opXor = 1;
      const opSet = 2;
      const opResolve = 3;
      const opReject = 4;
      const opAppend = 5;
      const opIndex = 6;
      const opCall = 7;
      const opCopy = 8;
      const opQueue = 9;
      const opWindow = 10;
      const opScriptMatch = 11;
      const opMap = 12;
      const opSafeCall = 13;
      const opJsonParse = 14;
      const opJsonStringify = 15;
      const opSecret = 16;
      const opCallSet = 17;
      const opAtob = 18;
      const opBtoa = 19;
      const opEqualsBranch = 20;
      const opDeltaBranch = 21;
      const opSubroutine = 22;
      const opIfDefined = 23;
      const opBind = 24;
      const opNoopA = 25;
      const opNoopB = 26;
      const opRemove = 27;
      const opNoopC = 28;
      const opLessThan = 29;
      const opDefineFunction = 30;
      const opMultiply = 33;
      const opAwait = 34;
      const opDivide = 35;
      const values = new Map<number, unknown>();
      let steps = 0;
      let chain = Promise.resolve();

      function serialize<T>(work: () => Promise<T> | T): Promise<T> {
        const next = chain.then(work, work);
        chain = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      }

      async function runQueue(): Promise<void> {
        const queue = values.get(opQueue) as unknown[][];
        while (Array.isArray(queue) && queue.length > 0) {
          const [opcode, ...args] = queue.shift() ?? [];
          const handler = values.get(Number(opcode)) as ((...args: unknown[]) => unknown) | undefined;
          const result = handler?.(...args);
          if (result && typeof (result as Promise<unknown>).then === "function") await result;
          steps += 1;
        }
      }

      function xor(value: string, key: string): string {
        let output = "";
        for (let index = 0; index < value.length; index += 1) {
          output += String.fromCharCode(value.charCodeAt(index) ^ key.charCodeAt(index % key.length));
        }
        return output;
      }

      function resetVm(): void {
        values.clear();
        values.set(opXorAsync, (program: unknown) => runDxProgram(String(values.get(Number(program))), secret));
        values.set(opXor, (target: unknown, key: unknown) =>
          values.set(Number(target), xor(String(values.get(Number(target))), String(values.get(Number(key))))),
        );
        values.set(opSet, (target: unknown, value: unknown) => values.set(Number(target), value));
        values.set(opAppend, (target: unknown, source: unknown) => {
          const current = values.get(Number(target));
          const next = values.get(Number(source));
          if (Array.isArray(current)) current.push(next);
          else values.set(Number(target), String(current) + String(next));
        });
        values.set(opRemove, (target: unknown, source: unknown) => {
          const current = values.get(Number(target));
          const next = values.get(Number(source));
          if (Array.isArray(current)) current.splice(current.indexOf(next), 1);
          else values.set(Number(target), Number(current) - Number(next));
        });
        values.set(opLessThan, (target: unknown, left: unknown, right: unknown) =>
          values.set(Number(target), Number(values.get(Number(left))) < Number(values.get(Number(right)))),
        );
        values.set(opMultiply, (target: unknown, left: unknown, right: unknown) =>
          values.set(Number(target), Number(values.get(Number(left))) * Number(values.get(Number(right)))),
        );
        values.set(opDivide, (target: unknown, left: unknown, right: unknown) => {
          const divisor = Number(values.get(Number(right)));
          values.set(Number(target), divisor === 0 ? 0 : Number(values.get(Number(left))) / divisor);
        });
        values.set(opIndex, (target: unknown, source: unknown, key: unknown) =>
          values.set(Number(target), (values.get(Number(source)) as Record<string, unknown>)[String(values.get(Number(key)))]),
        );
        values.set(opCall, (fn: unknown, ...args: unknown[]) =>
          (values.get(Number(fn)) as (...args: unknown[]) => unknown)(...args.map((arg) => values.get(Number(arg)))),
        );
        values.set(opCallSet, (target: unknown, fn: unknown, ...args: unknown[]) => {
          try {
            const result = (values.get(Number(fn)) as (...args: unknown[]) => unknown)(
              ...args.map((arg) => values.get(Number(arg))),
            );
            if (result && typeof (result as Promise<unknown>).then === "function") {
              return (result as Promise<unknown>)
                .then((value) => values.set(Number(target), value))
                .catch((error) => values.set(Number(target), String(error)));
            }
            values.set(Number(target), result);
          } catch (error) {
            values.set(Number(target), String(error));
          }
        });
        values.set(opSafeCall, (target: unknown, fn: unknown, ...args: unknown[]) => {
          try {
            (values.get(Number(fn)) as (...args: unknown[]) => unknown)(...args.map((arg) => values.get(Number(arg))));
          } catch (error) {
            values.set(Number(target), String(error));
          }
        });
        values.set(opCopy, (target: unknown, source: unknown) => values.set(Number(target), values.get(Number(source))));
        values.set(opWindow, window);
        values.set(opScriptMatch, (target: unknown, pattern: unknown) =>
          values.set(
            Number(target),
            (Array.from(document.scripts || [])
              .map((script) => script?.src?.match(String(values.get(Number(pattern)))))
              .filter((match) => match?.length)[0] ?? [])[0] ?? null,
          ),
        );
        values.set(opMap, (target: unknown) => values.set(Number(target), values));
        values.set(opJsonParse, (target: unknown, source: unknown) =>
          values.set(Number(target), JSON.parse(String(values.get(Number(source))))),
        );
        values.set(opJsonStringify, (target: unknown, source: unknown) =>
          values.set(Number(target), JSON.stringify(values.get(Number(source)))),
        );
        values.set(opAtob, (target: unknown) => values.set(Number(target), atob(String(values.get(Number(target))))));
        values.set(opBtoa, (target: unknown) => values.set(Number(target), btoa(String(values.get(Number(target))))));
        values.set(opEqualsBranch, (left: unknown, right: unknown, fn: unknown, ...args: unknown[]) =>
          values.get(Number(left)) === values.get(Number(right))
            ? (values.get(Number(fn)) as (...args: unknown[]) => unknown)(...args)
            : null,
        );
        values.set(opDeltaBranch, (left: unknown, right: unknown, threshold: unknown, fn: unknown, ...args: unknown[]) =>
          Math.abs(Number(values.get(Number(left))) - Number(values.get(Number(right)))) > Number(values.get(Number(threshold)))
            ? (values.get(Number(fn)) as (...args: unknown[]) => unknown)(...args)
            : null,
        );
        values.set(opIfDefined, (source: unknown, fn: unknown, ...args: unknown[]) =>
          values.get(Number(source)) === undefined
            ? null
            : (values.get(Number(fn)) as (...args: unknown[]) => unknown)(...args),
        );
        values.set(opBind, (target: unknown, source: unknown, key: unknown) => {
          const object = values.get(Number(source)) as Record<string, unknown>;
          const method = object[String(values.get(Number(key)))] as (...args: unknown[]) => unknown;
          values.set(Number(target), method.bind(object));
        });
        values.set(opAwait, (target: unknown, source: unknown) => {
          try {
            const promise = values.get(Number(source));
            return Promise.resolve(promise).then((value) => values.set(Number(target), value));
          } catch {
            return undefined;
          }
        });
        values.set(opSubroutine, (target: unknown, queue: unknown[]) => {
          const previous = [...(values.get(opQueue) as unknown[][])];
          values.set(opQueue, [...queue]);
          return runQueue()
            .catch((error) => values.set(Number(target), String(error)))
            .finally(() => values.set(opQueue, previous));
        });
        values.set(opNoopA, () => undefined);
        values.set(opNoopB, () => undefined);
        values.set(opNoopC, () => undefined);
      }

      return await serialize(
        () =>
          new Promise<string>((resolve, reject) => {
            resetVm();
            values.set(opSecret, secret);
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              resolve(String(steps));
            }, 500);
            values.set(opResolve, (value: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(btoa(String(value)));
            });
            values.set(opReject, (value: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(new Error(btoa(String(value))));
            });
            values.set(opDefineFunction, (target: unknown, returnSlot: unknown, argSlotsOrQueue: unknown, queueOrArgs: unknown) => {
              const hasArgSlots = Array.isArray(queueOrArgs);
              const argSlots = (hasArgSlots ? argSlotsOrQueue : []) as unknown[];
              const queue = (hasArgSlots ? queueOrArgs : argSlotsOrQueue) as unknown[];
              values.set(Number(target), (...args: unknown[]) => {
                if (settled) return undefined;
                const previous = [...(values.get(opQueue) as unknown[][])];
                if (hasArgSlots) {
                  for (let index = 0; index < argSlots.length; index += 1) {
                    values.set(Number(argSlots[index]), args[index]);
                  }
                }
                values.set(opQueue, [...queue]);
                return runQueue()
                  .then(() => values.get(Number(returnSlot)))
                  .catch((error) => String(error))
                  .finally(() => values.set(opQueue, previous));
              });
            });
            try {
              values.set(opQueue, JSON.parse(xor(atob(dx), secret)) as unknown[][]);
              runQueue().catch((error) => {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  resolve(btoa(`${steps}: ${error}`));
                }
              });
            } catch (error) {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(btoa(`${steps}: ${error}`));
              }
            }
          }),
      );
    }

    function generateRequirementsTokenAnswer(): string {
      try {
        const config = proofConfig();
        config[3] = 1;
        config[9] = 0;
        return encodeProofConfig(config);
      } catch (error) {
        return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${encodeProofConfig(String(error ?? "e"))}`;
      }
    }

    function generateProofAnswer(seed: string, difficulty: string): string {
      const start = performance.now();
      const config = proofConfig();
      for (let attempt = 0; attempt < 500_000; attempt += 1) {
        config[3] = attempt;
        config[9] = Math.round(performance.now() - start);
        const encoded = encodeProofConfig(config);
        if (fnvHash(`${seed}${encoded}`).substring(0, difficulty.length) <= difficulty) {
          return `${encoded}~S`;
        }
      }
      return `wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D${encodeProofConfig("e")}`;
    }

    function proofConfig(): unknown[] {
      const memory = (performance as Performance & { memory?: { jsHeapSizeLimit?: unknown } }).memory;
      return [
        (screen?.width ?? 0) + (screen?.height ?? 0),
        `${new Date()}`,
        memory?.jsHeapSizeLimit,
        Math.random(),
        navigator.userAgent,
        randomItem(Array.from(document.scripts).map((script) => script?.src).filter(Boolean)),
        Array.from(document.scripts || [])
          .map((script) => script?.src?.match("c/[^/]*/_"))
          .filter((match) => match?.length)[0]?.[0] ?? document.documentElement.getAttribute("data-build"),
        navigator.language,
        navigator.languages?.join(","),
        Math.random(),
        randomNavigatorProbe(),
        randomItem(Object.keys(document)),
        randomItem(Object.keys(window)),
        performance.now(),
        crypto.randomUUID(),
        [...new URLSearchParams(window.location.search).keys()].join(","),
        navigator?.hardwareConcurrency,
        performance.timeOrigin,
        Number("ai" in window),
        Number("createPRNG" in window),
        Number("cache" in window),
        Number("data" in window),
        Number("solana" in window),
        Number("dump" in window),
        Number("InstallTrigger" in window),
      ];
    }

    function randomNavigatorProbe(): string {
      const key = randomItem(Object.keys(Object.getPrototypeOf(navigator)));
      try {
        const value = (navigator as unknown as Record<string, unknown>)[key];
        return `${key}-${String(value)}`;
      } catch {
        return key;
      }
    }

    function randomItem(items: string[]): string {
      if (items.length === 0) return "";
      return items[Math.floor(Math.random() * items.length)] ?? "";
    }

    function encodeProofConfig(value: unknown): string {
      const json = JSON.stringify(value);
      if (window.TextEncoder) {
        return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
      }
      return btoa(unescape(encodeURIComponent(json)));
    }

    function fnvHash(value: string): string {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      hash ^= hash >>> 16;
      hash = Math.imul(hash, 2246822507) >>> 0;
      hash ^= hash >>> 13;
      hash = Math.imul(hash, 3266489909) >>> 0;
      hash ^= hash >>> 16;
      return (hash >>> 0).toString(16).padStart(8, "0");
    }
  }})(${JSON.stringify(CHATGPT_CONVERSATION_ENDPOINT)}, ${JSON.stringify(requestBody)}, ${JSON.stringify(accountId)})`;
}

interface PreparedChatRequirements {
  prepare_token?: unknown;
  proofofwork?: {
    required?: unknown;
    seed?: unknown;
    difficulty?: unknown;
  };
  turnstile?: {
    required?: unknown;
    dx?: unknown;
  };
}

function buildRequestBody(job: JobRecord): Record<string, unknown> {
  const requestedModel = canonicalModelId(job.model);
  const isResearch = requestedModel === "research";
  const isImage = requestedModel === "image";
  const prompt = isResearch ? buildResearchPrompt(job) : isImage ? buildImagePrompt(job) : buildConversationPrompt(job);
  const model = isResearch ? DEEP_RESEARCH_ROUTER_MODEL : isImage ? DEFAULT_MODEL : normalizeModel(job.model);
  const thinkingEffort = !isResearch && modelUsesThinkingEffort(model) ? normalizeReasoning(job.reasoning) : undefined;
  const conversationId = stringOption(job.options.conversationId);
  const parentMessageId = stringOption(job.options.parentMessageId) ?? "client-created-root";
  const temporary = booleanOption(job.options.temporary, !conversationId);
  const verbosity = stringOption(job.options.verbosity);
  const reasoningSummary = stringOption(job.options.reasoningSummary);
  const toolChoice = stringOption(job.options.toolChoice);
  const parallelTools =
    typeof job.options.parallelTools === "boolean" ? job.options.parallelTools : undefined;
  const body: Record<string, unknown> = {
    action: "next",
    messages: [
      {
        id: randomUUID(),
        author: { role: "user" },
        create_time: Math.floor(Date.now() / 1000),
        content: { content_type: "text", parts: [prompt] },
        metadata: isResearch ? deepResearchMessageMetadata() : {},
      },
    ],
    model,
    parent_message_id: parentMessageId,
    client_prepare_state: "none",
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    conversation_mode: { kind: "primary_assistant" },
    enable_message_followups: true,
    system_hints: isResearch ? [`connector:${DEEP_RESEARCH_CONNECTOR_ID}`] : [],
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: { app_name: "chatgpt" },
    paragen_cot_summary_display_override: "allow",
    force_parallel_switch: "auto",
  };

  if (conversationId) {
    body.conversation_id = conversationId;
  }
  if (temporary && !isImage) {
    body.history_and_training_disabled = true;
    body.client_contextual_info = { app_name: "chatgpt.com" };
  }
  if (verbosity) body.verbosity = verbosity;
  if (reasoningSummary) body.reasoning_summary = reasoningSummary;
  if (toolChoice) body.tool_choice = toolChoice;
  if (parallelTools !== undefined) {
    body.parallel_tools = parallelTools;
    body.force_parallel_switch = parallelTools ? "auto" : "none";
  }
  if (thinkingEffort) body.thinking_effort = thinkingEffort;

  return body;
}

function deepResearchMessageMetadata(): Record<string, unknown> {
  return {
    caterpillar_selected_sources: ["web"],
    developer_mode_connector_ids: [],
    selected_mcp_sources: [],
    selected_sources: ["web"],
    selected_github_repos: [],
    system_hints: [`connector:${DEEP_RESEARCH_CONNECTOR_ID}`],
    deep_research_version: "standard",
    venus_model_variant: "standard",
    serialization_metadata: { custom_symbol_offsets: [] },
  };
}

function buildResearchPrompt(job: JobRecord): string {
  const prompt = job.prompt.trim();
  const instructions = stringOption(job.options.instructions);
  if (!instructions?.trim()) return prompt;
  return `${instructions.trim()}\n\n${prompt}`;
}

function buildImagePrompt(job: JobRecord): string {
  const prompt = job.prompt.trim();
  const imageInstructions =
    "Use ChatGPT image generation tools to create image(s) from the user's prompt. Do not answer with only a revised prompt. After generation, keep any text brief.";
  const instructions = [
    imageInstructions,
    stringOption(job.options.instructions),
  ].filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
  return `${instructions.trim()}\n\n${prompt}`;
}

function buildConversationPrompt(job: JobRecord): string {
  const baseInstructions =
    stringOption(job.options.instructions) ??
    "You are a concise assistant responding to a terminal automation request.";
  const condensedResponseTokens = integerOption(
    job.options.condensedResponseTokens,
    undefined,
    1,
    100_000,
  );
  const instructions = [
    baseInstructions,
    condensedResponseTokens === undefined
      ? undefined
      : `Condensed response mode: keep the final answer to approximately ${condensedResponseTokens} tokens or fewer. Prioritize the user's requested deliverable, concrete decisions, and essential caveats. Do not add filler, broad background, or meta commentary about this limit.`,
  ].filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
  const prompt = job.prompt.trim();
  if (!instructions.trim()) return prompt;
  return `${instructions.trim()}\n\n${prompt}`;
}

interface ParsedConversationResponse {
  text: string;
  asyncTask: ResearchTask | null;
  deepResearchWidget: ResearchTask | null;
  conversationId: string | null;
}

function readResponse(
  raw: string,
  onLimits?: (observations: LimitsObservation[]) => void,
  options: { allowEmptyWithConversation?: boolean } = {},
): ParsedConversationResponse {
  let buffer = raw.replace(/\r\n?/g, "\n");
  let completedText: string | null = null;
  let asyncTask: ResearchTask | null = null;
  let deepResearchWidget: ResearchTask | null = null;
  let conversationId: string | null = null;
  let completed = false;
  const state: ResponseParseState = { acceptsTextContinuation: false, lastAppendText: null };

  let boundary = buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const event = parseSseFrame(frame);
    const parsed = readConversationEvent(event, state);
    if (parsed.text !== null) {
      completedText = mergeStreamText(completedText, parsed.text, parsed.append);
    }
    if (onLimits) {
      const observations = extractLimitsProgress(event);
      if (observations.length > 0) onLimits(observations);
    }
    conversationId = extractConversationId(event) ?? conversationId;
    asyncTask = extractAsyncResearchTask(event) ?? asyncTask;
    deepResearchWidget = extractDeepResearchWidgetTask(event, conversationId) ?? deepResearchWidget;
    completed = completed || parsed.completed;
    boundary = buffer.indexOf("\n\n");
  }

  if (buffer.trim()) {
    const event = parseSseFrame(buffer);
    const parsed = readConversationEvent(event, state);
    if (parsed.text !== null) {
      completedText = mergeStreamText(completedText, parsed.text, parsed.append);
    }
    if (onLimits) {
      const observations = extractLimitsProgress(event);
      if (observations.length > 0) onLimits(observations);
    }
    conversationId = extractConversationId(event) ?? conversationId;
    asyncTask = extractAsyncResearchTask(event) ?? asyncTask;
    deepResearchWidget = extractDeepResearchWidgetTask(event, conversationId) ?? deepResearchWidget;
    completed = completed || parsed.completed;
  }

  if (!completed) {
    throw new ProError("STREAM_INCOMPLETE", "ChatGPT stream ended before the conversation completed.", {
      exitCode: EXIT.network,
      suggestions: [
        "Retry the same real request only if the user still needs it; do not send a probe or smoke-test query.",
        "Increase --timeout if the request is large.",
        "Run pro-cli doctor --json to check local auth/browser health without spending Pro quota.",
      ],
      details: completedText ? { partialPreview: completedText.slice(0, 160) } : undefined,
    });
  }

  if (completedText === null && !asyncTask && !deepResearchWidget && !(options.allowEmptyWithConversation && conversationId)) {
    throw new ProError("EMPTY_RESPONSE", "ChatGPT completed without returning assistant text.", {
      exitCode: EXIT.upstream,
      suggestions: [
        "Retry the same real request only if the user still needs it; do not send a probe or smoke-test query.",
        "Run pro-cli doctor --json to check local auth/browser health without spending Pro quota.",
        "Check the job in ChatGPT if this persists.",
      ],
    });
  }

  return { text: completedText ?? "", asyncTask, deepResearchWidget, conversationId };
}

async function waitForResearchTask(
  task: ResearchTask,
  evaluate: PageEvaluator,
  cdpBase: string,
  timeoutMs: number,
  options: TransportOptions,
): Promise<string> {
  if (isDeepResearchWidgetTask(task)) {
    return await waitForDeepResearchWidget(task, evaluate, cdpBase, timeoutMs, options);
  }

  const startedAt = Date.now();
  let transientPollFailures = 0;
  while (true) {
    const remainingMs = timeoutMs > 0 ? Math.max(1, timeoutMs - (Date.now() - startedAt)) : 30_000;
    let result: BrowserTaskFetchResult;
    try {
      result = await evaluate<BrowserTaskFetchResult>(
        cdpBase,
        buildResearchTaskFetchExpression(task.taskId),
        Math.min(remainingMs, 30_000),
      );
      transientPollFailures = 0;
    } catch (error) {
      const proError = error instanceof ProError ? error : networkError(error);
      transientPollFailures += 1;
      const elapsedMs = Date.now() - startedAt;
      if (!isResearchTaskPollRetryable(proError) || transientPollFailures > 3 || (timeoutMs > 0 && elapsedMs >= timeoutMs)) {
        throw proError;
      }
      await sleep(researchWidgetPollSleepMs(timeoutMs, startedAt));
      continue;
    }
    if (!result.ok) {
      throw new ProError("RESEARCH_TASK_UNAVAILABLE", `Deep Research task ${task.taskId} returned HTTP ${result.status}.`, {
        exitCode: EXIT.upstream,
        suggestions: [
          "Open the saved ChatGPT conversation to inspect the Deep Research task.",
          "Retry only if the user still needs a new real Deep Research run; every retry may spend Pro quota.",
        ],
        details: {
          taskId: task.taskId,
          status: result.status,
          preview: result.preview,
        },
      });
    }

    const body = isRecord(result.body) ? result.body : {};
    const status = stringField(body.status)?.toLowerCase() ?? "unknown";
    await options.onResearchTaskStatus?.({ ...task, status });
    if (isResearchTaskComplete(status)) {
      const finalText = readResearchTaskFinalText(body);
      if (finalText) return finalText;
      throw new ProError("RESEARCH_TASK_EMPTY", `Deep Research task ${task.taskId} completed without a final message.`, {
        exitCode: EXIT.upstream,
        suggestions: ["Open the saved ChatGPT conversation to inspect the completed Deep Research task."],
        details: { taskId: task.taskId, status },
      });
    }
    if (isResearchTaskFailed(status)) {
      throw new ProError("RESEARCH_TASK_FAILED", `Deep Research task ${task.taskId} is ${status}.`, {
        exitCode: EXIT.upstream,
        suggestions: ["Open the saved ChatGPT conversation to inspect the failed Deep Research task."],
        details: { taskId: task.taskId, status },
      });
    }
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      throw new ProError("RESEARCH_TASK_INCOMPLETE", `Deep Research task ${task.taskId} is still ${status}.`, {
        exitCode: EXIT.timeout,
        suggestions: [
          "Use a larger --timeout for long Deep Research tasks.",
          "Open the saved ChatGPT conversation if the task appears stuck.",
        ],
        details: {
          taskId: task.taskId,
          status,
          title: task.title,
          conversationId: task.conversationId,
          elapsedMs: Date.now() - startedAt,
          timeoutMs,
        },
      });
    }
    const sleepMs = timeoutMs > 0
      ? Math.min(DEFAULT_RESEARCH_TASK_POLL_MS, Math.max(1, timeoutMs - (Date.now() - startedAt)))
      : DEFAULT_RESEARCH_TASK_POLL_MS;
    await sleep(sleepMs);
  }
}

async function waitForDeepResearchWidget(
  task: ResearchTask,
  evaluate: PageEvaluator,
  cdpBase: string,
  timeoutMs: number,
  options: TransportOptions,
): Promise<string> {
  if (!task.conversationId) {
    throw new ProError("RESEARCH_WIDGET_UNAVAILABLE", "Deep Research widget polling needs a saved conversation id.", {
      exitCode: EXIT.upstream,
      suggestions: ["Open the saved ChatGPT conversation to inspect the Deep Research widget."],
      details: { taskId: task.taskId, title: task.title },
    });
  }

  const startedAt = Date.now();
  let transientPollFailures = 0;
  while (true) {
    const remainingMs = timeoutMs > 0 ? Math.max(1, timeoutMs - (Date.now() - startedAt)) : 30_000;
    let result: BrowserWidgetFetchResult;
    try {
      result = await evaluate<BrowserWidgetFetchResult>(
        cdpBase,
        buildDeepResearchWidgetFetchExpression(task.conversationId, task.taskId),
        Math.min(remainingMs, 30_000),
      );
      transientPollFailures = 0;
    } catch (error) {
      const proError = error instanceof ProError ? error : networkError(error);
      transientPollFailures += 1;
      const elapsedMs = Date.now() - startedAt;
      if (!isResearchTaskPollRetryable(proError) || transientPollFailures > 3 || (timeoutMs > 0 && elapsedMs >= timeoutMs)) {
        throw proError;
      }
      const sleepMs = timeoutMs > 0
        ? Math.min(DEFAULT_RESEARCH_TASK_POLL_MS, Math.max(1, timeoutMs - elapsedMs))
        : DEFAULT_RESEARCH_TASK_POLL_MS;
      await sleep(sleepMs);
      continue;
    }
    if (!result.ok) {
      if (isTransientResearchWidgetStatus(result.status)) {
        const status = result.status === 429 ? "rate_limited" : `http_${result.status}`;
        await options.onResearchTaskStatus?.({ ...task, status });
        if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
          throw new ProError("RESEARCH_TASK_INCOMPLETE", `Deep Research widget ${task.taskId} is still ${status}.`, {
            exitCode: EXIT.timeout,
            suggestions: [
              "Use a larger --timeout for long Deep Research tasks.",
              "Open the saved ChatGPT conversation if the widget appears stuck.",
            ],
            details: {
              taskId: task.taskId,
              status,
              httpStatus: result.status,
              title: task.title,
              conversationId: task.conversationId,
              elapsedMs: Date.now() - startedAt,
              timeoutMs,
              preview: result.preview,
            },
          });
        }
        await sleep(researchWidgetPollSleepMs(timeoutMs, startedAt, result.status));
        continue;
      }
      throw new ProError(
        "RESEARCH_WIDGET_UNAVAILABLE",
        `Deep Research conversation ${task.conversationId} returned HTTP ${result.status}.`,
        {
          exitCode: EXIT.upstream,
          suggestions: ["Open the saved ChatGPT conversation to inspect the Deep Research widget."],
          details: { taskId: task.taskId, conversationId: task.conversationId, status: result.status, preview: result.preview },
        },
      );
    }

    const status = result.statusText?.toLowerCase() ?? "running";
    await options.onResearchTaskStatus?.({ ...task, status });
    if (status === "completed" && result.finalText) return result.finalText;
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new ProError("RESEARCH_TASK_FAILED", `Deep Research widget ${task.taskId} is ${status}.`, {
        exitCode: EXIT.upstream,
        suggestions: ["Open the saved ChatGPT conversation to inspect the failed Deep Research widget."],
        details: { taskId: task.taskId, conversationId: task.conversationId, status },
      });
    }
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      throw new ProError("RESEARCH_TASK_INCOMPLETE", `Deep Research widget ${task.taskId} is still ${status}.`, {
        exitCode: EXIT.timeout,
        suggestions: [
          "Use a larger --timeout for long Deep Research tasks.",
          "Open the saved ChatGPT conversation if the widget appears stuck.",
        ],
        details: {
          taskId: task.taskId,
          status,
          title: result.title ?? task.title,
          conversationId: task.conversationId,
          elapsedMs: Date.now() - startedAt,
          timeoutMs,
        },
      });
    }
    await sleep(researchWidgetPollSleepMs(timeoutMs, startedAt));
  }
}

function researchWidgetPollSleepMs(timeoutMs: number, startedAt: number, status?: number): number {
  const baseMs = status === 429 ? DEFAULT_RESEARCH_WIDGET_RATE_LIMIT_POLL_MS : DEFAULT_RESEARCH_WIDGET_POLL_MS;
  return timeoutMs > 0 ? Math.min(baseMs, Math.max(1, timeoutMs - (Date.now() - startedAt))) : baseMs;
}

function isTransientResearchWidgetStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

interface BrowserTaskFetchResult {
  ok: boolean;
  status: number;
  body: unknown;
  preview?: string;
}

interface BrowserWidgetFetchResult {
  ok: boolean;
  status: number;
  statusText: string | null;
  title: string | null;
  finalText: string | null;
  preview?: string;
}

async function waitForResearchTaskFromConversation(
  conversationId: string,
  evaluate: PageEvaluator,
  cdpBase: string,
): Promise<ResearchTask | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await evaluate<BrowserConversationTaskFetchResult>(
      cdpBase,
      buildConversationTaskFetchExpression(conversationId),
      30_000,
    );
    if (result.ok && result.task?.taskId) return result.task;
    if (!result.ok && result.status !== 404) return null;
    await sleep(1_000);
  }
  return null;
}

async function waitForResearchWidgetFromConversation(
  conversationId: string,
  evaluate: PageEvaluator,
  cdpBase: string,
): Promise<ResearchTask | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await evaluate<BrowserConversationWidgetFetchResult>(
      cdpBase,
      buildConversationWidgetFetchExpression(conversationId),
      30_000,
    );
    if (result.ok && result.task?.taskId) return result.task;
    if (!result.ok && result.status !== 404) return null;
    await sleep(1_000);
  }
  return null;
}

interface BrowserConversationTaskFetchResult {
  ok: boolean;
  status: number;
  task: ResearchTask | null;
  preview?: string;
}

interface BrowserConversationWidgetFetchResult {
  ok: boolean;
  status: number;
  task: ResearchTask | null;
  preview?: string;
}

interface BrowserImageAsset {
  fileId: string;
  assetPointer: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  title: string | null;
  genId: string | null;
}

interface BrowserImageAssetsFetchResult {
  ok: boolean;
  status: number;
  assets: BrowserImageAsset[];
  asyncStatus: number | null;
  title: string | null;
  preview?: string;
}

interface BrowserImageDownloadResult {
  ok: boolean;
  status: number;
  contentType: string;
  bytes: number;
  base64: string;
  fileName: string | null;
  error?: string;
}

interface ImageArtifact {
  fileId: string;
  path: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  title: string | null;
  fileName: string | null;
  genId: string | null;
}

interface ImageGenerationResult {
  type: "image_generation";
  conversationId: string;
  text: string | null;
  images: ImageArtifact[];
}

async function waitForImageResult(
  conversationId: string,
  evaluate: PageEvaluator,
  cdpBase: string,
  timeoutMs: number,
  options: TransportOptions,
  context: { jobId: string; prompt: string; initialText: string },
): Promise<string> {
  const artifactDir = options.artifactDir;
  if (!artifactDir) {
    throw new ProError("IMAGE_ARTIFACT_DIR_MISSING", "Image generation needs a local artifact directory.", {
      exitCode: EXIT.internal,
      suggestions: ["Retry through pro-cli ask or job create so artifact storage is configured."],
      details: { conversationId },
    });
  }

  const startedAt = Date.now();
  while (true) {
    const remainingMs = timeoutMs > 0 ? Math.max(1, timeoutMs - (Date.now() - startedAt)) : 30_000;
    const result = await evaluate<BrowserImageAssetsFetchResult>(
      cdpBase,
      buildImageAssetsFetchExpression(conversationId),
      Math.min(remainingMs, 30_000),
    );

    if (!result.ok) {
      if (isTransientImageStatus(result.status)) {
        const status = result.status === 429 ? "rate_limited" : `http_${result.status}`;
        await options.onResearchTaskStatus?.({
          taskId: imageTaskId(conversationId),
          title: result.title ?? "Image generation",
          conversationId,
          status,
        });
        if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
          throw imageIncompleteError(conversationId, status, timeoutMs, startedAt, result.preview);
        }
        await sleep(imagePollSleepMs(timeoutMs, startedAt, result.status));
        continue;
      }
      throw new ProError("IMAGE_ASSETS_UNAVAILABLE", `Image conversation ${conversationId} returned HTTP ${result.status}.`, {
        exitCode: EXIT.upstream,
        suggestions: ["Open the saved ChatGPT conversation to inspect the image generation."],
        details: { conversationId, status: result.status, preview: result.preview },
      });
    }

    if (result.assets.length > 0) {
      await options.onResearchTaskStatus?.({
        taskId: imageTaskId(conversationId),
        title: result.title ?? "Image generation",
        conversationId,
        status: "completed",
      });
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      const images: ImageArtifact[] = [];
      for (const [index, asset] of result.assets.entries()) {
        const download = await downloadImageAsset(asset.fileId, evaluate, cdpBase);
        const extension = imageExtension(download.contentType);
        const path = join(artifactDir, `image-${index + 1}.${extension}`);
        await writeFile(path, Buffer.from(download.base64, "base64"), { mode: 0o600 });
        images.push({
          fileId: asset.fileId,
          path,
          contentType: download.contentType,
          bytes: download.bytes,
          width: asset.width,
          height: asset.height,
          title: asset.title,
          fileName: fileBaseName(download.fileName),
          genId: asset.genId,
        });
      }
      const payload: ImageGenerationResult = {
        type: "image_generation",
        conversationId,
        text: context.initialText.trim() ? context.initialText : null,
        images,
      };
      return JSON.stringify(payload, null, 2);
    }

    const status = result.asyncStatus === 4 ? "final_without_assets" : "running";
    await options.onResearchTaskStatus?.({
      taskId: imageTaskId(conversationId),
      title: result.title ?? "Image generation",
      conversationId,
      status,
    });
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      throw imageIncompleteError(conversationId, status, timeoutMs, startedAt, result.preview);
    }
    await sleep(imagePollSleepMs(timeoutMs, startedAt));
  }
}

async function downloadImageAsset(
  fileId: string,
  evaluate: PageEvaluator,
  cdpBase: string,
): Promise<BrowserImageDownloadResult> {
  const result = await evaluate<BrowserImageDownloadResult>(
    cdpBase,
    buildImageDownloadExpression(fileId),
    60_000,
  );
  if (!result.ok || !result.contentType.startsWith("image/")) {
    throw new ProError("IMAGE_DOWNLOAD_UNAVAILABLE", `Image file ${fileId} could not be downloaded.`, {
      exitCode: EXIT.upstream,
      suggestions: ["Open the saved ChatGPT conversation to inspect or download the image manually."],
      details: {
        fileId,
        status: result.status,
        contentType: result.contentType,
        error: result.error,
      },
    });
  }
  return result;
}

function imageIncompleteError(
  conversationId: string,
  status: string,
  timeoutMs: number,
  startedAt: number,
  preview?: string,
): ProError {
  return new ProError("IMAGE_TASK_INCOMPLETE", `Image generation ${conversationId} is still ${status}.`, {
    exitCode: EXIT.timeout,
    suggestions: [
      "Use a larger --timeout for long image generations.",
      "Open the saved ChatGPT conversation if the image appears stuck.",
    ],
    details: {
      conversationId,
      status,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
      preview,
    },
  });
}

function imagePollSleepMs(timeoutMs: number, startedAt: number, status?: number): number {
  const baseMs = status === 429 ? DEFAULT_IMAGE_RATE_LIMIT_POLL_MS : DEFAULT_IMAGE_POLL_MS;
  return timeoutMs > 0 ? Math.min(baseMs, Math.max(1, timeoutMs - (Date.now() - startedAt))) : baseMs;
}

function isTransientImageStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isImageTask(task: ResearchTask): boolean {
  return task.taskId.startsWith(IMAGE_TASK_PREFIX);
}

function imageTaskId(conversationId: string): string {
  return `${IMAGE_TASK_PREFIX}${conversationId}`;
}

function imageConversationIdFromTask(task: ResearchTask): string | null {
  if (task.conversationId) return task.conversationId;
  if (task.taskId.startsWith(IMAGE_TASK_PREFIX)) return task.taskId.slice(IMAGE_TASK_PREFIX.length);
  return null;
}

function imageExtension(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "bin";
}

function fileBaseName(value: string | null): string | null {
  if (!value) return null;
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function validateCompletedResult(job: JobRecord, text: string): void {
  const model = canonicalModelId(job.model);
  if (model !== "research" || !isIncompleteResearchAcknowledgement(text)) return;
  throw new ProError(
    "INCOMPLETE_RESEARCH_ACK",
    "Deep Research returned only an acknowledgement instead of the completed research artifact.",
    {
      exitCode: EXIT.upstream,
      suggestions: [
        "Open the saved ChatGPT conversation to see whether Deep Research continued asynchronously.",
        "Retry only if the user still needs a new real Deep Research run; do not send probe or smoke-test queries.",
        "For an immediate terminal artifact, use --model gpt-5-5-pro --reasoning extended with a source packet while Deep Research async retrieval is unavailable.",
      ],
      details: {
        model,
        reasoning: job.reasoning,
        chars: text.length,
        preview: text.slice(0, 240),
      },
    },
  );
}

function isIncompleteResearchAcknowledgement(text: string): boolean {
  const trimmed = researchAcknowledgementCandidate(text).trim();
  if (!trimmed) return false;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 350) return false;

  const normalized = trimmed
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase();
  const promisesFutureWork =
    /\bi(?:'ll| will)\s+(?:begin|start|conduct|do|run|perform|research|investigate|look into|analy[sz]e|prepare|compile|return|provide|deliver)\b/.test(
      normalized,
    ) ||
    /\bi(?:'ll| will)\s+(?:get back|come back|follow up)\b/.test(normalized);
  if (!promisesFutureWork) return false;

  const explicitlyLater =
    /\b(?:shortly|once (?:complete|completed|done)|when (?:complete|completed|done)|after (?:the )?research)\b/.test(
      normalized,
    ) || /\b(?:get back|come back|follow up)\s+to you\b/.test(normalized) || /\bi(?:'ll| will)\s+return\b/.test(normalized);
  const hasCompletedResearchMarkers =
    /(?:^|\n)\s*(?:executive summary|findings|sources|references|claims|report|conclusion|recommendation|rationale)\s*:/i.test(
      trimmed,
    );
  return explicitlyLater && !hasCompletedResearchMarkers;
}

function researchAcknowledgementCandidate(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed) || typeof parsed.response !== "string") return text;
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    const title = typeof parsed.title === "string" ? parsed.title : "";
    const looksLikeResearchStartEnvelope =
      typeof parsed.task_violates_safety_guidelines === "boolean" ||
      typeof parsed.user_def_doesnt_want_research === "boolean" ||
      prompt.toLowerCase().includes("deep analysis") ||
      title.toLowerCase().includes("research");
    return looksLikeResearchStartEnvelope ? parsed.response : text;
  } catch {
    return text;
  }
}

function buildResearchTaskFetchExpression(taskId: string): string {
  return `(${async function fetchResearchTask(id: string): Promise<BrowserTaskFetchResult> {
    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
      referrerPolicy: "no-referrer",
    });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
    const response = await fetch(
      `https://chatgpt.com/backend-api/task/${encodeURIComponent(id)}`,
      {
        credentials: "include",
        referrer: "https://chatgpt.com/",
        headers: {
          accept: "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
      },
    );
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      preview: text.replace(/\s+/g, " ").slice(0, 240),
    };
  }})(${JSON.stringify(taskId)})`;
}

function buildConversationWidgetFetchExpression(conversationId: string): string {
  return `(${async function fetchConversationWidget(id: string): Promise<BrowserConversationWidgetFetchResult> {
    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
      referrerPolicy: "no-referrer",
    });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
    const response = await fetch(
      `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`,
      {
        credentials: "include",
        referrer: "https://chatgpt.com/",
        headers: {
          accept: "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
      },
    );
    const body = (await response.json().catch(() => null)) as { mapping?: unknown } | null;
    const mapping = body && typeof body === "object" && body.mapping && typeof body.mapping === "object"
      ? body.mapping as Record<string, { message?: unknown }>
      : {};
    for (const node of Object.values(mapping)) {
      const task = readDeepResearchWidgetTaskFromMessage(node?.message, id);
      if (task) return { ok: response.ok, status: response.status, task };
    }
    return { ok: response.ok, status: response.status, task: null, preview: JSON.stringify(body).slice(0, 240) };

    function readDeepResearchWidgetTaskFromMessage(message: unknown, conversationId: string): ResearchTask | null {
      const metadata = (message as { metadata?: unknown } | undefined)?.metadata;
      if (!metadata || typeof metadata !== "object") return null;
      const sdk = (metadata as Record<string, unknown>).chatgpt_sdk;
      if (!sdk || typeof sdk !== "object") return null;
      const sdkRecord = sdk as Record<string, unknown>;
      const toolMetadata = sdkRecord.tool_response_metadata;
      const toolRecord = toolMetadata && typeof toolMetadata === "object" ? toolMetadata as Record<string, unknown> : {};
      const attributionId = typeof sdkRecord.attribution_id === "string" ? sdkRecord.attribution_id : "";
      const resolvedUri = typeof sdkRecord.resolved_pineapple_uri === "string" ? sdkRecord.resolved_pineapple_uri : "";
      if (attributionId !== "connector_openai_deep_research" && resolvedUri !== "connectors://connector_openai_deep_research") {
        return null;
      }
      const taskId =
        typeof sdkRecord.widget_session_id === "string" && sdkRecord.widget_session_id
          ? sdkRecord.widget_session_id
          : typeof toolRecord["openai/widgetSessionId"] === "string" && toolRecord["openai/widgetSessionId"]
            ? toolRecord["openai/widgetSessionId"] as string
            : typeof toolRecord.async_task_conversation_id === "string" && toolRecord.async_task_conversation_id
              ? toolRecord.async_task_conversation_id
              : "";
      if (!taskId) return null;
      const title = readWidgetTitle(sdkRecord.widget_state) || readWidgetTitle(toolRecord.venus_widget_state);
      return {
        taskId,
        ...(title ? { title } : {}),
        conversationId,
      };
    }

    function readWidgetTitle(raw: unknown): string | null {
      const state = parseState(raw);
      const plan = state && typeof state.plan === "object" && state.plan ? state.plan as Record<string, unknown> : null;
      return typeof plan?.title === "string" && plan.title ? plan.title : null;
    }

    function parseState(raw: unknown): Record<string, unknown> | null {
      if (raw && typeof raw === "object") return raw as Record<string, unknown>;
      if (typeof raw !== "string" || !raw.trim()) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    }
  }})(${JSON.stringify(conversationId)})`;
}

function buildDeepResearchWidgetFetchExpression(conversationId: string, taskId: string): string {
  return `(${async function fetchDeepResearchWidget(id: string, expectedTaskId: string): Promise<BrowserWidgetFetchResult> {
    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
      referrerPolicy: "no-referrer",
    });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
    const response = await fetch(
      `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`,
      {
        credentials: "include",
        referrer: "https://chatgpt.com/",
        headers: {
          accept: "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
      },
    );
    const body = (await response.json().catch(() => null)) as { mapping?: unknown } | null;
    const mapping = body && typeof body === "object" && body.mapping && typeof body.mapping === "object"
      ? body.mapping as Record<string, { message?: unknown }>
      : {};
    const candidates: Array<{ status: string | null; title: string | null; finalText: string | null; matched: boolean }> = [];
    for (const node of Object.values(mapping)) {
      candidates.push(...readWidgetCandidates(node?.message, expectedTaskId));
    }
    const matched = candidates.filter((candidate) => candidate.matched);
    const selected = [...matched, ...candidates]
      .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0] ?? null;
    return {
      ok: response.ok,
      status: response.status,
      statusText: selected?.status ?? null,
      title: selected?.title ?? null,
      finalText: selected?.finalText ?? null,
      preview: JSON.stringify(body).slice(0, 240),
    };

    function scoreCandidate(candidate: { status: string | null; finalText: string | null; matched: boolean }): number {
      return (candidate.matched ? 100 : 0) + (candidate.status === "completed" ? 10 : 0) + (candidate.finalText ? 1 : 0);
    }

    function readWidgetCandidates(
      message: unknown,
      expectedTaskId: string,
    ): Array<{ status: string | null; title: string | null; finalText: string | null; matched: boolean }> {
      const msg = message as { content?: { text?: unknown; parts?: unknown }; metadata?: unknown } | undefined;
      if (!msg) return [];
      const metadata = msg.metadata && typeof msg.metadata === "object" ? msg.metadata as Record<string, unknown> : {};
      const sdk = metadata.chatgpt_sdk && typeof metadata.chatgpt_sdk === "object"
        ? metadata.chatgpt_sdk as Record<string, unknown>
        : {};
      const toolMetadata = sdk.tool_response_metadata;
      const toolRecord = toolMetadata && typeof toolMetadata === "object" ? toolMetadata as Record<string, unknown> : {};
      const ids = [
        typeof sdk.widget_session_id === "string" ? sdk.widget_session_id : "",
        typeof toolRecord["openai/widgetSessionId"] === "string" ? toolRecord["openai/widgetSessionId"] as string : "",
        typeof toolRecord.async_task_conversation_id === "string" ? toolRecord.async_task_conversation_id : "",
      ].filter(Boolean);
      const matched = ids.includes(expectedTaskId);
      const states: unknown[] = [sdk.widget_state, metadata.venus_widget_state, toolRecord.venus_widget_state];
      const text = typeof msg.content?.text === "string"
        ? msg.content.text
        : Array.isArray(msg.content?.parts)
          ? msg.content.parts.filter((part): part is string => typeof part === "string").join("")
          : "";
      const textMatch = text.match(/The latest state of the widget is: (\\{[\\s\\S]*\\})/);
      if (textMatch?.[1]) states.push(textMatch[1]);
      return states.flatMap((raw) => {
        const state = parseState(raw);
        if (!state) return [];
        const finalText = readFinalText(state);
        const title = readTitle(state);
        const status = typeof state.status === "string" ? state.status : finalText ? "completed" : null;
        if (!status && !finalText && !title) return [];
        return [{ status, title, finalText, matched }];
      });
    }

    function parseState(raw: unknown): Record<string, unknown> | null {
      if (raw && typeof raw === "object") return raw as Record<string, unknown>;
      if (typeof raw !== "string" || !raw.trim()) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    }

    function readTitle(state: Record<string, unknown>): string | null {
      const plan = state.plan && typeof state.plan === "object" ? state.plan as Record<string, unknown> : null;
      return typeof plan?.title === "string" && plan.title ? plan.title : null;
    }

    function readFinalText(state: Record<string, unknown>): string | null {
      const report = state.report_message;
      const content = report && typeof report === "object" ? (report as { content?: unknown }).content : null;
      if (!content || typeof content !== "object") return null;
      const record = content as { parts?: unknown; text?: unknown };
      if (Array.isArray(record.parts)) {
        const text = record.parts.filter((part): part is string => typeof part === "string").join("");
        if (text.trim()) return text;
      }
      return typeof record.text === "string" && record.text.trim() ? record.text : null;
    }
  }})(${JSON.stringify(conversationId)}, ${JSON.stringify(taskId)})`;
}

function buildConversationTaskFetchExpression(conversationId: string): string {
  return `(${async function fetchConversationResearchTask(id: string): Promise<BrowserConversationTaskFetchResult> {
    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
      referrerPolicy: "no-referrer",
    });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
    const response = await fetch(
      `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`,
      {
        credentials: "include",
        referrer: "https://chatgpt.com/",
        headers: {
          accept: "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
      },
    );
    const body = (await response.json().catch(() => null)) as { mapping?: unknown } | null;
    const mapping = body && typeof body === "object" && body.mapping && typeof body.mapping === "object"
      ? body.mapping as Record<string, { message?: unknown }>
      : {};
    for (const node of Object.values(mapping)) {
      const message = node?.message as { metadata?: unknown } | undefined;
      const metadata = message?.metadata;
      if (!metadata || typeof metadata !== "object") continue;
      const record = metadata as Record<string, unknown>;
      const taskId = typeof record.async_task_id === "string" ? record.async_task_id : "";
      if (!taskId) continue;
      return {
        ok: response.ok,
        status: response.status,
        task: {
          taskId,
          ...(typeof record.async_task_title === "string" ? { title: record.async_task_title } : {}),
          ...(typeof record.async_task_conversation_id === "string"
            ? { conversationId: record.async_task_conversation_id }
            : {}),
        },
      };
    }
    return {
      ok: response.ok,
      status: response.status,
      task: null,
      preview: JSON.stringify(body).slice(0, 240),
    };
  }})(${JSON.stringify(conversationId)})`;
}

function buildImageAssetsFetchExpression(conversationId: string): string {
  return `(${async function fetchConversationImages(id: string): Promise<BrowserImageAssetsFetchResult> {
    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
      referrerPolicy: "no-referrer",
    });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
    const response = await fetch(
      `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`,
      {
        credentials: "include",
        referrer: "https://chatgpt.com/",
        headers: {
          accept: "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
      },
    );
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const mapping = record.mapping && typeof record.mapping === "object"
      ? record.mapping as Record<string, { message?: unknown }>
      : {};
    const assets: BrowserImageAsset[] = [];
    for (const node of Object.values(mapping)) {
      const message = node?.message as { content?: unknown; metadata?: unknown } | undefined;
      if (!message || typeof message !== "object") continue;
      const metadata = message.metadata && typeof message.metadata === "object"
        ? message.metadata as Record<string, unknown>
        : {};
      const content = message.content && typeof message.content === "object"
        ? message.content as { parts?: unknown }
        : {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const image = part as Record<string, unknown>;
        if (image.content_type !== "image_asset_pointer") continue;
        const assetPointer = typeof image.asset_pointer === "string" ? image.asset_pointer : "";
        const fileId = assetPointer.replace(/^sediment:\/\//, "");
        if (!assetPointer || !fileId) continue;
        const imageMetadata = image.metadata && typeof image.metadata === "object"
          ? image.metadata as Record<string, unknown>
          : {};
        const generation = imageMetadata.generation && typeof imageMetadata.generation === "object"
          ? imageMetadata.generation as Record<string, unknown>
          : {};
        assets.push({
          fileId,
          assetPointer,
          width: typeof image.width === "number" ? image.width : null,
          height: typeof image.height === "number" ? image.height : null,
          sizeBytes: typeof image.size_bytes === "number" ? image.size_bytes : null,
          title: typeof metadata.image_gen_title === "string" ? metadata.image_gen_title : null,
          genId: typeof generation.gen_id === "string" ? generation.gen_id : null,
        });
      }
    }
    const seen = new Set<string>();
    const deduped = assets.filter((asset) => {
      if (seen.has(asset.fileId)) return false;
      seen.add(asset.fileId);
      return true;
    });
    return {
      ok: response.ok,
      status: response.status,
      assets: deduped,
      asyncStatus: typeof record.async_status === "number" ? record.async_status : null,
      title: typeof record.title === "string" ? record.title : null,
      preview: text.replace(/\s+/g, " ").slice(0, 240),
    };
  }})(${JSON.stringify(conversationId)})`;
}

function buildImageDownloadExpression(fileId: string): string {
  return `(${async function downloadImageFile(id: string): Promise<BrowserImageDownloadResult> {
    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
      referrerPolicy: "no-referrer",
    });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
    const metadataResponse = await fetch(
      `https://chatgpt.com/backend-api/files/download/${encodeURIComponent(id)}`,
      {
        credentials: "include",
        referrer: "https://chatgpt.com/",
        headers: {
          accept: "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
      },
    );
    const metadata = (await metadataResponse.json().catch(() => null)) as
      | { download_url?: unknown; file_name?: unknown }
      | null;
    if (!metadataResponse.ok || typeof metadata?.download_url !== "string") {
      return {
        ok: false,
        status: metadataResponse.status,
        contentType: "",
        bytes: 0,
        base64: "",
        fileName: null,
        error: "download metadata did not include download_url",
      };
    }

    const imageResponse = await fetch(metadata.download_url, {
      credentials: "include",
      referrer: "https://chatgpt.com/",
    });
    const buffer = await imageResponse.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
    }
    return {
      ok: imageResponse.ok,
      status: imageResponse.status,
      contentType: imageResponse.headers.get("content-type") ?? "application/octet-stream",
      bytes: bytes.length,
      base64: btoa(binary),
      fileName: typeof metadata.file_name === "string" ? metadata.file_name : null,
    };
  }})(${JSON.stringify(fileId)})`;
}

function extractAsyncResearchTask(event: unknown): ResearchTask | null {
  if (!isRecord(event)) return null;
  const value = event.v as { message?: unknown } | undefined;
  const message = (event.message ?? value?.message) as { metadata?: unknown } | undefined;
  const metadata = message?.metadata;
  if (!isRecord(metadata)) return null;
  const taskId = stringField(metadata.async_task_id);
  if (!taskId) return null;
  return {
    taskId,
    ...(typeof metadata.async_task_title === "string" ? { title: metadata.async_task_title } : {}),
    ...(typeof metadata.async_task_conversation_id === "string"
      ? { conversationId: metadata.async_task_conversation_id }
      : {}),
  };
}

function extractDeepResearchWidgetTask(event: unknown, conversationId: string | null): ResearchTask | null {
  if (!isRecord(event)) return null;
  const value = event.v as { message?: unknown } | undefined;
  const message = (event.message ?? value?.message) as { metadata?: unknown } | undefined;
  const metadata = message?.metadata;
  if (!isRecord(metadata)) return null;
  const sdk = metadata.chatgpt_sdk;
  if (!isRecord(sdk)) return null;
  const toolMetadata = sdk.tool_response_metadata;
  const toolRecord = isRecord(toolMetadata) ? toolMetadata : {};
  const attributionId = stringField(sdk.attribution_id);
  const resolvedUri = stringField(sdk.resolved_pineapple_uri);
  if (attributionId !== DEEP_RESEARCH_CONNECTOR_ID && resolvedUri !== `connectors://${DEEP_RESEARCH_CONNECTOR_ID}`) {
    return null;
  }

  const taskId =
    stringField(sdk.widget_session_id)
    ?? stringField(toolRecord["openai/widgetSessionId"])
    ?? stringField(toolRecord.async_task_conversation_id);
  if (!taskId) return null;
  const title = readDeepResearchWidgetTitle(sdk.widget_state) ?? readDeepResearchWidgetTitle(toolRecord.venus_widget_state);
  return {
    taskId,
    ...(title ? { title } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

function extractConversationId(event: unknown): string | null {
  if (!isRecord(event)) return null;
  if (typeof event.conversation_id === "string" && event.conversation_id) return event.conversation_id;
  const value = event.v;
  if (isRecord(value) && typeof value.conversation_id === "string" && value.conversation_id) {
    return value.conversation_id;
  }
  return null;
}

function readResearchTaskFinalText(task: Record<string, unknown>): string | null {
  const finalText = readMessageContentText(task.final_message);
  if (finalText) return finalText;
  const messages = Array.isArray(task.messages) ? task.messages : [];
  for (const message of [...messages].reverse()) {
    const text = readMessageContentText(message);
    if (text) return text;
  }
  return null;
}

function isDeepResearchWidgetTask(task: ResearchTask): boolean {
  return !task.taskId.startsWith("deepresch_");
}

function isDeepResearchAppToolCall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return false;
    return stringField(parsed.path)?.includes(`/Deep Research App/implicit_link::${DEEP_RESEARCH_CONNECTOR_ID}/`) === true;
  } catch {
    return false;
  }
}

function readDeepResearchWidgetTitle(value: unknown): string | null {
  const state = parseDeepResearchWidgetState(value);
  const plan = state && isRecord(state.plan) ? state.plan : null;
  return stringField(plan?.title) ?? null;
}

function parseDeepResearchWidgetState(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readDeepResearchWidgetFinalText(state: Record<string, unknown>): string | null {
  const report = state.report_message;
  const text = readMessageContentText(report);
  if (text) return text;
  if (isRecord(report)) {
    const content = report.content;
    if (isRecord(content) && typeof content.text === "string" && content.text.trim()) return content.text;
  }
  return null;
}

function isResearchTaskComplete(status: string): boolean {
  return ["completed", "complete", "succeeded", "success", "done"].includes(status);
}

function isResearchTaskFailed(status: string): boolean {
  return ["failed", "failure", "error", "cancelled", "canceled"].includes(status);
}

interface ResponseParseState {
  acceptsTextContinuation: boolean;
  lastAppendText: string | null;
}

function mergeStreamText(current: string | null, next: string, append: boolean): string {
  if (append) {
    if (current && (current === next || current.endsWith(next))) return current;
    return `${current ?? ""}${next}`;
  }
  if (current && current.length > next.length && current.endsWith(next)) return current;
  return next;
}

export function extractLimitsProgress(event: unknown): LimitsObservation[] {
  if (!isRecord(event)) return [];
  const candidates: unknown[] = [];
  if (event.type === "conversation_detail_metadata") candidates.push(event);
  const value = event.v;
  if (isRecord(value) && value.type === "conversation_detail_metadata") candidates.push(value);
  if (isRecord(value) && Array.isArray((value as { limits_progress?: unknown }).limits_progress)) {
    candidates.push(value);
  }
  if (Array.isArray((event as { limits_progress?: unknown }).limits_progress)) candidates.push(event);

  const observations: LimitsObservation[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const progress = (candidate as { limits_progress?: unknown }).limits_progress;
    if (!Array.isArray(progress)) continue;
    for (const entry of progress) {
      if (!isRecord(entry)) continue;
      const featureName = entry.feature_name;
      const remaining = entry.remaining;
      const resetAfter = entry.reset_after;
      if (typeof featureName !== "string" || typeof remaining !== "number") continue;
      if (seen.has(featureName)) continue;
      seen.add(featureName);
      observations.push({
        feature_name: featureName,
        remaining,
        reset_after: typeof resetAfter === "string" ? resetAfter : null,
      });
    }
  }
  return observations;
}

function readConversationEvent(event: unknown, state: ResponseParseState): {
  text: string | null;
  completed: boolean;
  append: boolean;
} {
  if (!isRecord(event)) return { text: null, completed: false, append: false };
  if (event.type === "error") {
    throw new ProError("UPSTREAM_ERROR", readErrorMessage(event), {
      exitCode: EXIT.upstream,
      suggestions: ["Retry later or check usage limits."],
    });
  }
  const patchText = readPatchAppendText(event, state);
  if (patchText !== null) {
    return {
      text: patchText,
      append: true,
      completed: event.type === "done" || event.type === "message_stream_complete",
    };
  }
  const messageText = readConversationMessageText(event);
  return {
    text: messageText,
    append: false,
    completed: event.type === "done" || event.type === "message_stream_complete" || isConversationMessageDone(event),
  };
}

function parseSseFrame(frame: string): unknown {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) return null;
  if (data === "[DONE]") return { type: "done" };
  return JSON.parse(data) as unknown;
}

function readConversationMessageText(event: Record<string, unknown>): string | null {
  const value = event.v as { message?: unknown } | undefined;
  const message = (event.message ?? value?.message) as { author?: unknown } | undefined;
  const author = message?.author as { role?: unknown } | undefined;
  if (author?.role !== "assistant") return null;
  return readMessageContentText(message);
}

function readMessageContentText(message: unknown): string | null {
  const content = (message as { content?: { parts?: unknown } } | undefined)?.content;
  if (!Array.isArray(content?.parts)) return null;

  const parts = content.parts.filter((part): part is string => typeof part === "string");
  if (parts.length === 0) return null;
  return parts.join("");
}

function readPatchAppendText(event: Record<string, unknown>, state: ResponseParseState): string | null {
  if (event.o === "append" && isMessageContentPartPath(event.p) && typeof event.v === "string") {
    state.acceptsTextContinuation = true;
    return readNewAppendText(event.v, state);
  }
  if (typeof event.v === "string" && state.acceptsTextContinuation) {
    return readNewAppendText(event.v, state);
  }
  state.acceptsTextContinuation = false;
  state.lastAppendText = null;
  if (event.o !== "patch" || !Array.isArray(event.v)) return null;
  const chunks = event.v
    .filter((patch): patch is { o: unknown; p: unknown; v: unknown } => Boolean(patch) && typeof patch === "object")
    .filter(
      (patch) =>
        patch.o === "append" &&
        isMessageContentPartPath(patch.p) &&
        typeof patch.v === "string",
    )
    .map((patch) => patch.v);
  if (chunks.length === 0) return null;
  state.acceptsTextContinuation = true;
  return readNewAppendText(chunks.join(""), state);
}

function isMessageContentPartPath(path: unknown): boolean {
  return typeof path === "string" && /^\/message\/content\/parts\/\d+$/.test(path);
}

function readNewAppendText(text: string, state: ResponseParseState): string | null {
  if (text === state.lastAppendText) return null;
  state.lastAppendText = text;
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isConversationMessageDone(event: Record<string, unknown>): boolean {
  const value = event.v as { message?: unknown } | undefined;
  const message = (event.message ?? value?.message) as { status?: unknown; end_turn?: unknown } | undefined;
  return message?.status === "finished_successfully" || message?.end_turn === true;
}

function readErrorMessage(event: Record<string, unknown>): string {
  if (typeof event.error === "string") return event.error;
  const error = event.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" ? error.message : "ChatGPT backend returned an error event.";
}

function normalizeReasoning(reasoning: string): string {
  if (isReasoningLevel(reasoning)) return reasoning;
  throw new ProError("INVALID_REASONING", `Unsupported reasoning level ${reasoning}.`, {
    exitCode: EXIT.invalidArgs,
    suggestions: ["Use min, standard, extended, or max."],
  });
}

function normalizeModel(model: string): string {
  const value = canonicalModelId(model) || DEFAULT_MODEL;
  if (value === "auto") {
    throw new ProError("INVALID_MODEL", "The model auto is not supported.", {
      exitCode: EXIT.invalidArgs,
      suggestions: ["Use a concrete model id such as gpt-5-5-pro, gpt-4-5, or research."],
    });
  }
  return value;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerOption(
  value: unknown,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

function networkError(error: unknown): ProError {
  return new ProError("NETWORK_ERROR", "ChatGPT backend request failed before a response.", {
    exitCode: EXIT.network,
    suggestions: ["Check connectivity and retry.", "Run pro-cli auth status --json if this persists."],
    cause: error,
  });
}

function isRetryable(error: ProError): boolean {
  if (isAsyncArtifactError(error.code)) return false;
  if (["NETWORK_ERROR", "REQUEST_TIMEOUT", "STREAM_INCOMPLETE", "CDP_TIMEOUT"].includes(error.code)) return true;
  const status = error.details?.status;
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}

function isAsyncArtifactError(code: string): boolean {
  return (
    code.startsWith("IMAGE_") ||
    code.startsWith("RESEARCH_TASK_") ||
    code.startsWith("RESEARCH_WIDGET_") ||
    code === "INCOMPLETE_RESEARCH_ACK"
  );
}

function isResearchTaskPollRetryable(error: ProError): boolean {
  return ["CDP_TIMEOUT", "NETWORK_ERROR", "REQUEST_TIMEOUT"].includes(error.code);
}

function withAttemptDetails(error: ProError, attempts: number): ProError {
  return new ProError(error.code, error.message, {
    exitCode: error.exitCode,
    suggestions: error.suggestions,
    details: { ...(error.details ?? {}), attempts },
    cause: error,
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
