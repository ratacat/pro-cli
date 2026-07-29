import { EXIT, ProError } from "./errors";

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "no-json",
  "dry-run",
  "include-expired",
  "no-start",
  "save",
  "temporary",
  "no-temporary",
  "keep-conversation",
  "wait",
  "help",
  "version",
  "allow-fifty",
  "no-launch",
  "no-backup",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();
  let flagsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (flagsEnded) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      flagsEnded = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    if (!raw) {
      throw new ProError("INVALID_ARGS", "Empty flag is not valid.", {
        exitCode: EXIT.invalidArgs,
        suggestions: ["Use flags like --json or --model gpt-5-5-pro."],
      });
    }

    const [name, inlineValue] = raw.split(/=(.*)/s, 2);
    if (!name) {
      throw new ProError("INVALID_ARGS", `Invalid flag ${token}.`, {
        exitCode: EXIT.invalidArgs,
        suggestions: ["Use flags like --json or --model gpt-5-5-pro."],
      });
    }

    let value: string | boolean;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (BOOLEAN_FLAGS.has(name)) {
      value = true;
    } else {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new ProError("INVALID_ARGS", `Missing value for --${name}.`, {
          exitCode: EXIT.invalidArgs,
          suggestions: [`Pass --${name} <value>.`],
        });
      }
      value = next;
      index += 1;
    }

    const existing = flags.get(name);
    if (existing === true && value === true && BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else if (existing !== undefined) {
      flags.set(name, [String(existing), String(value)]);
    } else {
      flags.set(name, value);
    }
  }

  return { positionals, flags };
}

export function flagString(
  flags: Map<string, string | boolean | string[]>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  if (Array.isArray(value)) {
    throw new ProError("INVALID_ARGS", `Repeated --${name} is not valid here.`, {
      exitCode: EXIT.invalidArgs,
      suggestions: [`Pass --${name} only once.`],
    });
  }
  if (value === undefined || value === false) return undefined;
  if (value === true) return "true";
  return value;
}

export function flagBoolean(
  flags: Map<string, string | boolean | string[]>,
  name: string,
): boolean {
  return flags.get(name) === true;
}

export function flagStrings(
  flags: Map<string, string | boolean | string[]>,
  name: string,
): string[] {
  const value = flags.get(name);
  if (value === undefined || value === false) return [];
  if (Array.isArray(value)) return value;
  if (value === true) return ["true"];
  return [value];
}
