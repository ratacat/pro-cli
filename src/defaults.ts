export const DEFAULT_MODEL = "gpt-5-6-pro";
export const DEFAULT_REASONING = "standard";
export const REASONING_LEVELS = ["min", "standard", "extended", "max"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}
