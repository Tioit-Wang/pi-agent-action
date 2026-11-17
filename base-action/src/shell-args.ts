/**
 * Shell-ish argument helpers shared by the action.
 *
 * Extracted from the deleted `parse-sdk-options.ts`: the tokenizer, the
 * metacharacter escaping and the accumulating-flag semantics are generic, while
 * the Claude SDK option mapping was not.
 */

import { parse as parseShellArgs } from "shell-quote";

// Flags that should accumulate multiple values instead of overwriting.
// Include both camelCase and hyphenated variants for compatibility.
const ACCUMULATING_FLAGS = new Set([
  "allowedTools",
  "allowed-tools",
  "disallowedTools",
  "disallowed-tools",
  "mcp-config",
  "add-dir",
  "tools",
  "exclude-tools",
]);

/** Delimiter used to join accumulated flag values. */
export const ACCUMULATE_DELIMITER = "\x00";

// shell-quote treats ()|&;<> as control operators and splits adjacent text
// around them into separate tokens (returned as `{op}` objects, which we then
// dropped). For CLI args these must be literal characters, so each metachar is
// escaped to a Unicode private-use codepoint before parsing and restored after.
const SHELL_META_PAIRS: [string, string][] = [
  ["(", "\uE000"],
  [")", "\uE001"],
  ["|", "\uE002"],
  ["&", "\uE003"],
  [";", "\uE004"],
  ["<", "\uE005"],
  [">", "\uE006"],
];
const SHELL_META_ESCAPE = new Map(SHELL_META_PAIRS);
const SHELL_META_UNESCAPE = new Map(SHELL_META_PAIRS.map(([k, v]) => [v, k]));
const SHELL_META_ESCAPE_RE = /[()|&;<>]/g;
const SHELL_META_UNESCAPE_RE = /[\uE000-\uE006]/g;

export function escapeShellMeta(s: string): string {
  return s.replace(SHELL_META_ESCAPE_RE, (c) => SHELL_META_ESCAPE.get(c)!);
}

export function unescapeShellMeta(s: string): string {
  return s.replace(SHELL_META_UNESCAPE_RE, (c) => SHELL_META_UNESCAPE.get(c)!);
}

/**
 * Strip comment lines from a shell argument string.
 * Lines whose first non-whitespace character is `#` are removed entirely;
 * inline `#` inside a quoted value is left to shell-quote.
 */
export function stripShellComments(input: string): string {
  return input
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/**
 * Tokenize an argument string exactly as the CLI receives it: full comment
 * lines removed, metacharacters escaped, shell-quote applied, glob operators
 * recovered as literal text.
 */
export function tokenizeArgs(input: string): string[] {
  return parseShellArgs(escapeShellMeta(stripShellComments(input)))
    .map((token) => {
      if (typeof token === "string") return unescapeShellMeta(token);
      if (token && typeof token === "object" && "pattern" in token) {
        return unescapeShellMeta((token as { pattern: string }).pattern);
      }
      return undefined;
    })
    .filter((token): token is string => typeof token === "string");
}

/**
 * Parse an argument string into an extra-args record.
 * Accumulating flags consume all consecutive non-flag values and are joined
 * with ACCUMULATE_DELIMITER; `--flag=value` keeps the value in the key name.
 */
export function parseArgsToExtraArgs(
  raw?: string,
): Record<string, string | null> {
  if (!raw?.trim()) return {};

  const result: Record<string, string | null> = {};
  const args = tokenizeArgs(raw);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) continue;

    const flag = arg.slice(2);
    const nextArg = args[i + 1];

    if (nextArg && !nextArg.startsWith("--")) {
      if (ACCUMULATING_FLAGS.has(flag)) {
        const values: string[] = [];
        while (i + 1 < args.length && !args[i + 1]?.startsWith("--")) {
          i++;
          values.push(args[i]!);
        }
        const joined = values.join(ACCUMULATE_DELIMITER);
        result[flag] = result[flag]
          ? `${result[flag]}${ACCUMULATE_DELIMITER}${joined}`
          : joined;
      } else {
        result[flag] = nextArg;
        i++;
      }
    } else {
      result[flag] = null;
    }
  }

  return result;
}
