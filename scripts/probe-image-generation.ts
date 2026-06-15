#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { evaluateInCdpPage } from "../src/cdp";
import { ensurePrivateDir, loadConfig, migrateLegacyDefaultHome, resolvePaths } from "../src/config";
import { buildEphemeralJob } from "../src/executor";
import { runChatGptJob } from "../src/transport";

interface BrowserFetchResult {
  ok: boolean;
  status: number;
  body: string;
  code?: string;
}

interface Candidate {
  path: string;
  kind: string;
  value: string;
  redacted: string;
}

const options = parseArgs(Bun.argv.slice(2));
const prompt = options.prompt.trim();
if (!prompt && !options.conversationId) {
  fail("Missing prompt. Example: bun scripts/probe-image-generation.ts --save \"Create one square image...\"");
}

await migrateLegacyDefaultHome(process.env);
const paths = resolvePaths(process.env, await loadConfig(process.env));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const probeDir = join(paths.home, "probes", "images", stamp);
await ensurePrivateDir(probeDir);

let browserResult: BrowserFetchResult | null = null;
let resultText: string | null = null;
let errorPayload: unknown = null;

if (!options.conversationId) {
  const job = buildEphemeralJob({
    prompt,
    model: options.model,
    reasoning: options.reasoning,
    options: {
      temporary: !options.save,
      instructions:
        "Use ChatGPT image generation tools when the user asks for an image. Do not answer with only a prompt. After generation, keep any text brief.",
      toolChoice: "auto",
      verbosity: "low",
    },
  });

  try {
    resultText = await runChatGptJob(job, {
      sessionTokenPath: paths.sessionTokenPath,
      cdpBase: options.cdpBase,
      timeoutMs: options.timeoutMs,
      pageEvaluator: async <T>(cdpBase: string, expression: string, timeoutMs?: number): Promise<T> => {
        const result = await evaluateInCdpPage<BrowserFetchResult>(cdpBase, expression, timeoutMs);
        browserResult = result;
        return result as T;
      },
    });
  } catch (error) {
    errorPayload = error instanceof Error
      ? { name: error.name, message: error.message, ...(isRecord(error) && "code" in error ? { code: error.code } : {}) }
      : String(error);
  }
}

const rawPath = join(probeDir, "stream.sse");
if (browserResult?.body) {
  await writePrivateFile(rawPath, browserResult.body);
}

const summary = summarizeStream(browserResult?.body ?? "");
const targetConversationId = options.conversationId ?? summary.conversationIds[0] ?? null;
const conversationProbe = targetConversationId
  ? await waitForConversationImages(options.cdpBase, targetConversationId, options.pollTimeoutMs).catch((error) => ({
      ok: false as const,
      status: 0,
      text: "",
      assets: [],
      error: error instanceof Error ? error.message : String(error),
    }))
  : null;
const conversationPath = conversationProbe?.text
  ? join(probeDir, "conversation.json")
  : null;
if (conversationPath && conversationProbe?.text) {
  await writePrivateFile(conversationPath, conversationProbe.text);
}

const downloadedImages = [];
if (conversationProbe?.ok) {
  for (const [index, asset] of conversationProbe.assets.entries()) {
    const download = await downloadImageAsset(options.cdpBase, asset.fileId);
    const ext = extensionForContentType(download.contentType);
    const out = join(probeDir, `image-${index + 1}.${ext}`);
    await writeFile(out, Buffer.from(download.base64, "base64"), { mode: 0o600 });
    downloadedImages.push({
      fileId: asset.fileId,
      out,
      contentType: download.contentType,
      bytes: download.bytes,
      width: asset.width,
      height: asset.height,
      title: asset.title,
      fileName: download.fileName ? basename(download.fileName) : null,
    });
  }
}

const summaryPath = join(probeDir, "summary.json");
await writePrivateFile(summaryPath, `${JSON.stringify({
  createdAt: new Date().toISOString(),
  model: options.model,
  savedConversation: options.save,
  targetConversationId,
  browserStatus: browserResult ? { ok: browserResult.ok, status: browserResult.status, code: browserResult.code } : null,
  resultText,
  error: errorPayload,
  conversation: conversationProbe
    ? {
        ok: conversationProbe.ok,
        status: conversationProbe.status,
        path: conversationPath,
        assetCount: conversationProbe.assets.length,
        error: "error" in conversationProbe ? conversationProbe.error : undefined,
      }
    : null,
  downloadedImages,
  ...summary,
}, null, 2)}\n`);

console.log(JSON.stringify({
  ok: errorPayload === null || downloadedImages.length > 0,
  probeDir,
  rawPath: browserResult?.body ? rawPath : null,
  conversationPath,
  summaryPath,
  browserStatus: browserResult ? { ok: browserResult.ok, status: browserResult.status, code: browserResult.code } : null,
  resultText,
  error: errorPayload,
  images: downloadedImages,
  conversation: conversationProbe
    ? {
        ok: conversationProbe.ok,
        status: conversationProbe.status,
        assetCount: conversationProbe.assets.length,
        error: "error" in conversationProbe ? conversationProbe.error : undefined,
      }
    : null,
  summary: {
    frameCount: summary.frameCount,
    eventTypes: summary.eventTypes,
    conversationIds: summary.conversationIds,
    messageRoles: summary.messageRoles,
    contentTypes: summary.contentTypes,
    candidateCount: summary.candidates.length,
    candidates: summary.candidates.slice(0, 40).map(({ path, kind, redacted }) => ({ path, kind, redacted })),
  },
}, null, 2));

interface ProbeOptions {
  cdpBase: string;
  model: string;
  reasoning: string;
  save: boolean;
  timeoutMs: number;
  pollTimeoutMs: number;
  conversationId: string | null;
  prompt: string;
}

function parseArgs(args: string[]): ProbeOptions {
  const parsed: ProbeOptions = {
    cdpBase: "http://127.0.0.1:9222",
    model: "gpt-5-5-pro",
    reasoning: "standard",
    save: false,
    timeoutMs: 10 * 60_000,
    pollTimeoutMs: 3 * 60_000,
    conversationId: null,
    prompt: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--save") {
      parsed.save = true;
      continue;
    }
    if (arg === "--temporary") {
      parsed.save = false;
      continue;
    }
    if (
      arg === "--cdp" ||
      arg === "--model" ||
      arg === "--reasoning" ||
      arg === "--timeout" ||
      arg === "--poll-timeout" ||
      arg === "--conversation"
    ) {
      const value = args[index + 1];
      if (!value) fail(`Missing value for ${arg}.`);
      index += 1;
      if (arg === "--cdp") parsed.cdpBase = value;
      else if (arg === "--model") parsed.model = value;
      else if (arg === "--reasoning") parsed.reasoning = value;
      else if (arg === "--timeout") parsed.timeoutMs = readPositiveInteger(value, "--timeout");
      else if (arg === "--poll-timeout") parsed.pollTimeoutMs = readPositiveInteger(value, "--poll-timeout");
      else parsed.conversationId = value;
      continue;
    }
    parsed.prompt = [parsed.prompt, arg].filter(Boolean).join(" ");
  }

  return parsed;
}

interface ConversationFetchResult {
  ok: boolean;
  status: number;
  text: string;
}

interface ImageAsset {
  fileId: string;
  assetPointer: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  title: string | null;
}

async function waitForConversationImages(
  cdpBase: string,
  conversationId: string,
  timeoutMs: number,
): Promise<ConversationFetchResult & { assets: ImageAsset[] }> {
  const startedAt = Date.now();
  let last: ConversationFetchResult | null = null;
  while (true) {
    last = await fetchConversation(cdpBase, conversationId);
    if (last.ok) {
      const payload = parseJson(last.text);
      const assets = extractImageAssets(payload);
      if (assets.length > 0) return { ...last, assets };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { ...(last ?? { ok: false, status: 0, text: "" }), assets: [] };
    }
    await sleep(3_000);
  }
}

async function fetchConversation(cdpBase: string, conversationId: string): Promise<ConversationFetchResult> {
  return await evaluateInCdpPage<ConversationFetchResult>(
    cdpBase,
    `(${async function(id: string): Promise<ConversationFetchResult> {
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
      return { ok: response.ok, status: response.status, text: await response.text() };
    }.toString()})(${JSON.stringify(conversationId)})`,
    30_000,
  );
}

function extractImageAssets(payload: unknown): ImageAsset[] {
  const assets: ImageAsset[] = [];
  const mapping = isRecord(payload) && isRecord(payload.mapping) ? payload.mapping : {};
  for (const node of Object.values(mapping)) {
    if (!isRecord(node) || !isRecord(node.message)) continue;
    const message = node.message;
    const metadata = isRecord(message.metadata) ? message.metadata : {};
    const title = stringField(metadata.image_gen_title);
    const content = isRecord(message.content) ? message.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (!isRecord(part) || part.content_type !== "image_asset_pointer") continue;
      const assetPointer = stringField(part.asset_pointer);
      const fileId = assetPointer?.replace(/^sediment:\/\//, "");
      if (!assetPointer || !fileId) continue;
      assets.push({
        fileId,
        assetPointer,
        width: typeof part.width === "number" ? part.width : null,
        height: typeof part.height === "number" ? part.height : null,
        sizeBytes: typeof part.size_bytes === "number" ? part.size_bytes : null,
        title,
      });
    }
  }
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.fileId)) return false;
    seen.add(asset.fileId);
    return true;
  });
}

interface DownloadResult {
  contentType: string;
  bytes: number;
  base64: string;
  fileName: string | null;
}

async function downloadImageAsset(cdpBase: string, fileId: string): Promise<DownloadResult> {
  const result = await evaluateInCdpPage<DownloadResult & { ok: boolean; status: number; error?: string }>(
    cdpBase,
    `(${async function(id: string): Promise<DownloadResult & { ok: boolean; status: number; error?: string }> {
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
          referrer: location.href,
          headers: {
            accept: "application/json",
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
        },
      );
      const metadata = (await metadataResponse.json().catch(() => null)) as {
        download_url?: unknown;
        file_name?: unknown;
      } | null;
      if (!metadataResponse.ok || typeof metadata?.download_url !== "string") {
        return {
          ok: false,
          status: metadataResponse.status,
          error: "download metadata did not include download_url",
          contentType: "",
          bytes: 0,
          base64: "",
          fileName: null,
        };
      }
      const imageResponse = await fetch(metadata.download_url, {
        credentials: "include",
        referrer: location.href,
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
    }.toString()})(${JSON.stringify(fileId)})`,
    60_000,
  );
  if (!result.ok || !result.contentType.startsWith("image/")) {
    throw new Error(`Image download failed for ${fileId}: HTTP ${result.status} ${result.error ?? result.contentType}`);
  }
  return result;
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "bin";
}

function summarizeStream(raw: string): {
  frameCount: number;
  eventTypes: string[];
  conversationIds: string[];
  messageRoles: string[];
  contentTypes: string[];
  candidates: Candidate[];
} {
  const events = parseSseEvents(raw);
  const candidates: Candidate[] = [];
  const eventTypes = new Set<string>();
  const conversationIds = new Set<string>();
  const messageRoles = new Set<string>();
  const contentTypes = new Set<string>();

  for (const event of events) {
    if (isRecord(event)) {
      const type = stringField(event.type);
      if (type) eventTypes.add(type);
      const conversationId = readConversationId(event);
      if (conversationId) conversationIds.add(conversationId);
      const message = readMessage(event);
      if (message) {
        const author = isRecord(message.author) ? message.author : {};
        const role = stringField(author.role);
        if (role) messageRoles.add(role);
        const content = isRecord(message.content) ? message.content : {};
        const contentType = stringField(content.content_type);
        if (contentType) contentTypes.add(contentType);
      }
    }
    visit(event, "$", candidates, 0);
  }

  return {
    frameCount: events.length,
    eventTypes: [...eventTypes].sort(),
    conversationIds: [...conversationIds].sort(),
    messageRoles: [...messageRoles].sort(),
    contentTypes: [...contentTypes].sort(),
    candidates: dedupeCandidates(candidates),
  };
}

function parseSseEvents(raw: string): unknown[] {
  return raw
    .replace(/\r\n?/g, "\n")
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

function visit(value: unknown, path: string, candidates: Candidate[], depth: number): void {
  if (depth > 14) return;
  if (typeof value === "string") {
    const kind = classifyCandidate(path, value);
    if (kind) candidates.push({ path, kind, value, redacted: redactCandidate(value) });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, candidates, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visit(child, `${path}.${key}`, candidates, depth + 1);
  }
}

function classifyCandidate(path: string, value: string): string | null {
  const lowerPath = path.toLowerCase();
  const lowerValue = value.toLowerCase();
  if (/^https?:\/\//.test(value)) {
    if (
      lowerValue.includes("image") ||
      lowerValue.includes("oaiusercontent") ||
      lowerValue.includes("/files/") ||
      /\.(png|jpg|jpeg|webp)(\?|$)/.test(lowerValue)
    ) {
      return "url";
    }
  }
  if (/^file-[a-z0-9_-]+$/i.test(value)) return "file_id";
  if (/^(file-service|sandbox):/i.test(value)) return "asset_pointer";
  if (
    lowerPath.includes("image") ||
    lowerPath.includes("asset") ||
    lowerPath.includes("file") ||
    lowerPath.includes("download") ||
    lowerPath.includes("attachment") ||
    lowerPath.includes("generation")
  ) {
    if (value.length > 0 && value.length < 2000) return "metadata";
  }
  return null;
}

function redactCandidate(value: string): string {
  if (!/^https?:\/\//.test(value)) {
    return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  }
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? "?..." : ""}`;
  } catch {
    return value.slice(0, 180);
  }
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.path}\0${candidate.kind}\0${candidate.redacted}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readConversationId(event: Record<string, unknown>): string | null {
  if (typeof event.conversation_id === "string") return event.conversation_id;
  const value = event.v;
  if (isRecord(value) && typeof value.conversation_id === "string") return value.conversation_id;
  return null;
}

function readMessage(event: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(event.message)) return event.message;
  const value = event.v;
  if (isRecord(value) && isRecord(value.message)) return value.message;
  return null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flag} must be a positive integer.`);
  return parsed;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
