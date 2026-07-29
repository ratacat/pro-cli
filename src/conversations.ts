import { EXIT, ProError } from "./errors";
import { isTokenFresh, loadSessionToken } from "./session-token";

export interface ConversationSummary {
  id: string;
  title: string | null;
  createTime: string | null;
  updateTime: string | null;
  isArchived: boolean;
}

export interface ConversationListResult {
  total: number | null;
  conversations: ConversationSummary[];
}

export interface ConversationPatchOutcome {
  id: string;
  ok: boolean;
  status: number;
}

const CONVERSATIONS_ENDPOINT = "https://chatgpt.com/backend-api/conversations";
const CONVERSATION_ENDPOINT = "https://chatgpt.com/backend-api/conversation";

async function authorizedHeaders(sessionTokenPath: string): Promise<Record<string, string>> {
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
  return {
    authorization: `Bearer ${session.accessToken}`,
    ...(session.accountId ? { "chatgpt-account-id": session.accountId } : {}),
    accept: "application/json",
    origin: "https://chatgpt.com",
    referer: "https://chatgpt.com/",
    "user-agent": "pro-cli/0.1",
  };
}

export async function listConversations(options: {
  sessionTokenPath: string;
  limit?: number;
  offset?: number;
}): Promise<ConversationListResult> {
  const headers = await authorizedHeaders(options.sessionTokenPath);
  const limit = options.limit ?? 28;
  const offset = options.offset ?? 0;
  const response = await fetch(
    `${CONVERSATIONS_ENDPOINT}?offset=${offset}&limit=${limit}&order=updated`,
    { headers },
  );
  if (!response.ok) {
    throw new ProError("CONVERSATIONS_UNAVAILABLE", `ChatGPT conversations returned HTTP ${response.status}.`, {
      exitCode: EXIT.upstream,
      suggestions: ["Run pro-cli auth capture again if the session expired."],
      details: { status: response.status },
    });
  }
  const payload = (await response.json().catch(() => null)) as
    | { items?: unknown; total?: unknown }
    | null;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const conversations: ConversationSummary[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    conversations.push({
      id: record.id,
      title: typeof record.title === "string" ? record.title : null,
      createTime: typeof record.create_time === "string" ? record.create_time : null,
      updateTime: typeof record.update_time === "string" ? record.update_time : null,
      isArchived: record.is_archived === true,
    });
  }
  return {
    total: typeof payload?.total === "number" ? payload.total : null,
    conversations,
  };
}

async function patchConversations(
  sessionTokenPath: string,
  conversationIds: string[],
  patch: Record<string, unknown>,
): Promise<ConversationPatchOutcome[]> {
  const headers = await authorizedHeaders(sessionTokenPath);
  const outcomes: ConversationPatchOutcome[] = [];
  for (const id of conversationIds) {
    const response = await fetch(`${CONVERSATION_ENDPOINT}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => null);
    outcomes.push({
      id,
      ok: response?.ok === true,
      status: response?.status ?? 0,
    });
  }
  return outcomes;
}

export async function archiveConversations(options: {
  sessionTokenPath: string;
  conversationIds: string[];
}): Promise<ConversationPatchOutcome[]> {
  return patchConversations(options.sessionTokenPath, options.conversationIds, { is_archived: true });
}

export async function deleteConversations(options: {
  sessionTokenPath: string;
  conversationIds: string[];
}): Promise<ConversationPatchOutcome[]> {
  return patchConversations(options.sessionTokenPath, options.conversationIds, { is_visible: false });
}
