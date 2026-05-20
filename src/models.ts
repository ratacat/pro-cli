import { DEFAULT_MODEL, REASONING_LEVELS } from "./defaults";
import { isTokenFresh, loadSessionToken } from "./session-token";

export interface ModelCapability {
  id: string;
  label: string;
  source: "static-unverified" | "live";
  reasoningLevels: string[];
  default?: boolean;
  maxTokens?: number;
  reasoningType?: string;
  configurableThinkingEffort?: boolean;
  enabledTools?: string[];
}

export interface ModelList {
  models: ModelCapability[];
  source: "static" | "live";
  warning?: string;
  defaultModel?: string;
  chatgptDefaultModel?: string;
  modelPickerVersion?: number;
}

interface LiveModelPayload {
  default_model_slug?: unknown;
  model_picker_version?: unknown;
  models?: unknown;
}

interface LiveModel {
  slug?: unknown;
  title?: unknown;
  max_tokens?: unknown;
  reasoning_type?: unknown;
  configurable_thinking_effort?: unknown;
  thinking_efforts?: unknown;
  enabled_tools?: unknown;
}

const MODEL_ID_ALIASES = new Map<string, string>([
  ["4.5", "gpt-4-5"],
  ["gpt 4.5", "gpt-4-5"],
  ["gpt-4.5", "gpt-4-5"],
  ["deep research", "research"],
  ["deep-research", "research"],
  ["deep_research", "research"],
]);

const STATIC_MODEL_CAPABILITIES: ModelCapability[] = [
  {
    id: "gpt-5-5-pro",
    label: "GPT-5.5 Pro",
    source: "static-unverified",
    reasoningLevels: ["standard", "extended"],
    default: true,
    reasoningType: "pro",
  },
  {
    id: "gpt-5-4-pro",
    label: "GPT-5.4 Pro",
    source: "static-unverified",
    reasoningLevels: ["standard", "extended"],
    reasoningType: "pro",
  },
  {
    id: "gpt-5-5-thinking",
    label: "GPT-5.5 Thinking",
    source: "static-unverified",
    reasoningLevels: [...REASONING_LEVELS],
    reasoningType: "reasoning",
  },
  {
    id: "gpt-4-5",
    label: "GPT-4.5",
    source: "static-unverified",
    reasoningLevels: [],
    reasoningType: "none",
  },
  {
    id: "research",
    label: "Deep Research",
    source: "static-unverified",
    reasoningLevels: [],
    reasoningType: "none",
  },
];

const STATIC_MODEL_BY_ID = new Map(STATIC_MODEL_CAPABILITIES.map((model) => [model.id, model]));

export const NO_REASONING = "none";

export function canonicalModelId(model: string): string {
  const trimmed = model.trim();
  return MODEL_ID_ALIASES.get(trimmed.toLowerCase()) ?? trimmed;
}

export function modelUsesThinkingEffort(model: string): boolean {
  const capability = STATIC_MODEL_BY_ID.get(canonicalModelId(model));
  return capability?.reasoningType !== "none";
}

export function modelRequiresSavedConversation(model: string): boolean {
  return canonicalModelId(model) === "research";
}

export async function listModels(options: { sessionTokenPath: string }): Promise<ModelList> {
  const session = await loadSessionToken(options.sessionTokenPath).catch(() => null);
  if (!session) {
    return listStaticModels("No captured ChatGPT session token is available.");
  }
  if (!isTokenFresh(session)) {
    return listStaticModels("The captured ChatGPT session token is expired.");
  }
  if (!session.accountId) {
    return listStaticModels("The captured ChatGPT session token has no account id.");
  }

  try {
    const response = await fetch("https://chatgpt.com/backend-api/models", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "chatgpt-account-id": session.accountId,
        accept: "application/json",
        origin: "https://chatgpt.com",
        referer: "https://chatgpt.com/",
        "user-agent": "pro-cli/0.1",
      },
    });

    if (!response.ok) {
      return listStaticModels(`Live model discovery returned HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as LiveModelPayload;
    const liveModels = parseLiveModels(payload);
    if (liveModels.length === 0) {
      return listStaticModels("Live model discovery returned no usable model entries.");
    }

    const chatgptDefaultModel =
      typeof payload.default_model_slug === "string" ? payload.default_model_slug : undefined;
    return {
      source: "live",
      defaultModel: DEFAULT_MODEL,
      ...(chatgptDefaultModel ? { chatgptDefaultModel } : {}),
      ...(typeof payload.model_picker_version === "number"
        ? { modelPickerVersion: payload.model_picker_version }
        : {}),
      models: liveModels.map((model) => ({
        ...model,
        default: model.id === DEFAULT_MODEL,
      })),
    };
  } catch {
    return listStaticModels("Live model discovery failed; using static fallback.");
  }
}

export function listStaticModels(warning?: string): ModelList {
  return {
    source: "static",
    defaultModel: DEFAULT_MODEL,
    models: STATIC_MODEL_CAPABILITIES.map((model) => ({
      ...model,
      reasoningLevels: [...model.reasoningLevels],
      ...(model.enabledTools ? { enabledTools: [...model.enabledTools] } : {}),
    })),
    warning: warning ?? "Live model discovery requires a captured ChatGPT session token.",
  };
}

function parseLiveModels(payload: LiveModelPayload): ModelCapability[] {
  const models = Array.isArray(payload.models) ? (payload.models as LiveModel[]) : [];
  return models
    .map((model) => {
      if (typeof model.slug !== "string" || typeof model.title !== "string") return null;
      const reasoningLevels = parseReasoningLevels(model.thinking_efforts, model.reasoning_type);
      const enabledTools = parseEnabledTools(model.enabled_tools);
      const capability: ModelCapability = {
        id: model.slug,
        label: model.title,
        source: "live",
        reasoningLevels,
        ...(typeof model.max_tokens === "number" ? { maxTokens: model.max_tokens } : {}),
        ...(typeof model.reasoning_type === "string" ? { reasoningType: model.reasoning_type } : {}),
        ...(typeof model.configurable_thinking_effort === "boolean"
          ? { configurableThinkingEffort: model.configurable_thinking_effort }
          : {}),
        ...(enabledTools.length > 0 ? { enabledTools } : {}),
      };
      return capability;
    })
    .filter((model): model is ModelCapability => model !== null && model.id !== "auto");
}

function parseReasoningLevels(value: unknown, reasoningType: unknown): string[] {
  if (reasoningType === "none") return [];
  if (!Array.isArray(value)) {
    if (reasoningType === "pro") return ["standard", "extended"];
    return [...REASONING_LEVELS];
  }
  const levels = value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const effort = (item as { thinking_effort?: unknown }).thinking_effort;
    return typeof effort === "string" ? [effort] : [];
  });
  return levels.length > 0 ? levels : [...REASONING_LEVELS];
}

function parseEnabledTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const tool = item as { id?: unknown; name?: unknown; type?: unknown };
    for (const candidate of [tool.id, tool.name, tool.type]) {
      if (typeof candidate === "string") return [candidate];
    }
    return [];
  });
}
