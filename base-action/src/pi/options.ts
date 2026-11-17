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

export function parseMaxTurns(raw?: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`max_turns must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function parsePiOptions(options: PiOptions): ParsedPiOptions {
  const argv: string[] = ["--mode", "json"];

  if (options.provider?.trim()) {
    argv.push("--provider", options.provider.trim());
  }
  if (options.model?.trim()) {
    argv.push("--model", options.model.trim());
  }
  if (options.noTools) {
    argv.push("--no-tools");
  } else {
    const allowed = splitList(options.allowedTools);
    if (allowed.length > 0) argv.push("--tools", allowed.join(","));
    const disallowed = splitList(options.disallowedTools);
    if (disallowed.length > 0) argv.push("--exclude-tools", disallowed.join(","));
  }
  if (options.systemPrompt?.trim()) {
    argv.push("--system-prompt", options.systemPrompt.trim());
  }
  if (options.appendSystemPrompt?.trim()) {
    const value = options.appendSystemPrompt.trim();
    argv.push(
      "--append-system-prompt",
      existsSync(value) ? value : value,
    );
  }
  // Project trust only when the caller decided the content is trusted.
  argv.push(options.approveProject ? "--approve" : "--no-approve");

  argv.push(...parseExtraArgs(options.piArgs));

  return {
    argv,
    ...(parseMaxTurns(options.maxTurns) !== undefined
      ? { maxTurns: parseMaxTurns(options.maxTurns) }
      : {}),
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
