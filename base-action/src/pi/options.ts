/**
 * Maps action inputs onto `pi` CLI arguments.
 *
 * Only arguments this action supports are accepted; anything else belongs in
 * `pi_args`, which is parsed with shell-quote and must expand to plain words so
 * a quoted value cannot smuggle in shell operators (the action never runs Pi
 * through a shell).
 */

import { existsSync } from "node:fs";
import { parse as shellParse } from "shell-quote";

export type PiOptions = {
  /** Extra raw arguments appended verbatim, e.g. `--thinking high`. */
  piArgs?: string;
  /** Provider id, e.g. `deepseek`. */
  provider?: string;
  /** Model id or pattern, e.g. `deepseek-chat`. */
  model?: string;
  /** Thinking level: off|minimal|low|medium|high|xhigh|max. Defaults to `high`. */
  thinking?: string;
  /** Comma-separated allowlist of tool names. */
  allowedTools?: string;
  /** Comma-separated denylist of tool names. */
  disallowedTools?: string;
  /** Abort on turn count above this value. Pi has no CLI equivalent. */
  maxTurns?: string;
  /** Replace Pi's default system prompt. */
  systemPrompt?: string;
  /** Append to Pi's system prompt (text or a file path). */
  appendSystemPrompt?: string;
  /** Run without any tools (tag mode / untrusted content). */
  noTools?: boolean;
  /** Trust project-local `.pi/` configuration for this run. */
  approveProject?: boolean;
  /** Log every raw event instead of a sanitized summary. */
  showFullOutput?: string;
};

export type ParsedPiOptions = {
  /** Arguments for the `pi` process, excluding the prompt. */
  argv: string[];
  /** Thinking level this run was started with. */
  thinking: ThinkingLevel;
  maxTurns?: number;
  showFullOutput: boolean;
};

/** Prompt text above this size is attached as `@file` instead of argv. */
export const PROMPT_ARGV_LIMIT = 100_000;

function splitList(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseExtraArgs(raw?: string): string[] {
  if (!raw?.trim()) return [];
  const parsed = shellParse(raw);
  const words: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string") {
      words.push(entry);
      continue;
    }
    // shell-quote yields objects for redirections, globs and env substitution.
    // None of those are meaningful for an argv array, and silently dropping them
    // would hide a workflow author's mistake.
    throw new Error(
      `pi_args contains an unsupported shell construct: ${JSON.stringify(entry)}. Pass plain command-line arguments only.`,
    );
  }
  return words;
}

/**
 * Turn budget for a run. An empty value, `0` or any negative number means "no
 * limit": Pi keeps going until it finishes. Anything else must be a positive
 * integer, because a silently ignored typo would either never stop or stop at
 * once.
 */
export function parseMaxTurns(raw?: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value)) {
    throw new Error(`max_turns must be an integer, got "${raw}"`);
  }
  if (value <= 0) return undefined;
  return value;
}

/** Thinking levels Pi accepts, cheapest first. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Pi's own default is `medium`. This action asks for `high` unless a workflow
 * says otherwise: issue triage and code answers gain more from the extra
 * deliberation than the extra tokens cost.
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

/**
 * Thinking level for a run. A blank value falls back to the action default. An
 * unknown level is rejected rather than passed through, because Pi clamps levels
 * a model does not support -- a typo would otherwise run at a different effort
 * than the workflow asked for, with nothing in the log to show it.
 */
export function parseThinkingLevel(raw?: string): ThinkingLevel {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_THINKING_LEVEL;
  const level = THINKING_LEVELS.find((candidate) => candidate === value);
  if (!level) {
    throw new Error(
      `thinking must be one of ${THINKING_LEVELS.join(", ")}, got "${raw}"`,
    );
  }
  return level;
}

export function parsePiOptions(options: PiOptions): ParsedPiOptions {
  const argv: string[] = ["--mode", "json"];
  const thinking = parseThinkingLevel(options.thinking);

  if (options.provider?.trim()) {
    argv.push("--provider", options.provider.trim());
  }
  if (options.model?.trim()) {
    argv.push("--model", options.model.trim());
  }
  argv.push("--thinking", thinking);
  if (options.noTools) {
    argv.push("--no-tools");
  } else {
    const allowed = splitList(options.allowedTools);
    if (allowed.length > 0) argv.push("--tools", allowed.join(","));
    const disallowed = splitList(options.disallowedTools);
    if (disallowed.length > 0)
      argv.push("--exclude-tools", disallowed.join(","));
  }
  if (options.systemPrompt?.trim()) {
    argv.push("--system-prompt", options.systemPrompt.trim());
  }
  if (options.appendSystemPrompt?.trim()) {
    const value = options.appendSystemPrompt.trim();
    argv.push("--append-system-prompt", existsSync(value) ? value : value);
  }
  // Project trust only when the caller decided the content is trusted.
  argv.push(options.approveProject ? "--approve" : "--no-approve");

  argv.push(...parseExtraArgs(options.piArgs));

  const maxTurns = parseMaxTurns(options.maxTurns);

  return {
    argv,
    thinking,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    showFullOutput: options.showFullOutput === "true",
  };
}

/**
 * Build the prompt arguments. Small prompts travel as the final message; large
 * ones are attached with `@file` because a single argv entry is capped at
 * 128 KiB on Linux.
 */
export function buildPromptArgs(
  promptText: string,
  promptPath: string,
): string[] {
  if (promptText.length <= PROMPT_ARGV_LIMIT) {
    return ["--", promptText];
  }
  return [
    "--",
    `@${promptPath}`,
    "Execute the instructions in the attached file.",
  ];
}
