/**
 * Runs the Pi coding agent non-interactively and normalizes its output into the
 * same result shape the rest of the action consumes.
 *
 * Replaces base-action/src/run-claude-sdk.ts (Claude Agent SDK) with a `pi`
 * subprocess. Pi's contract: `pi --mode json <prompt>` writes strict JSONL to
 * stdout and exits. See node_modules/@earendil-works/pi-coding-agent/docs/json.md
 */

import * as core from "@actions/core";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { writeExecutionFile } from "../execution-file";
import {
  createEventCollector,
  extractJsonObject,
  type PiEvent,
  type PiEventSummary,
} from "./events";
import { buildPromptArgs, type ParsedPiOptions } from "./options";

export type PiProgress = {
  /** Completed assistant turns so far. */
  turns: number;
  elapsedMs: number;
  /** Last tool that finished, e.g. `bash`. */
  lastTool?: string;
  totalTokens: number;
};

export type PiRunResult = {
  executionFile?: string;
  sessionId?: string;
  conclusion: "success" | "failure";
  structuredOutput?: string;
  /** Final assistant text, used by the caller for summaries and links. */
  finalText?: string;
  usage?: PiEventSummary["usage"];
  /** Completed assistant turns, reported even when the run fails. */
  numTurns?: number;
  /** Why the run failed, in user-facing words. */
  error?: string;
  /** True when the caller aborted the run. */
  cancelled?: boolean;
};

export type PiRunInput = {
  promptPath: string;
  promptText: string;
  parsed: ParsedPiOptions;
  /** Extra environment for the child (agent dir, provider secret, ...). */
  env?: Record<string, string>;
  /** Executable or absolute path for the `pi` binary. */
  piExecutable?: string;
  /** When set, the final message must contain a JSON object matching this schema. Pi has no --json-schema flag. */
  jsonSchema?: string;
  /** Test seam: replaces child_process.spawn. */
  spawnImpl?: typeof spawn;
  /** Called after each completed turn so the caller can publish progress. */
  onProgress?: (progress: PiProgress) => void;
  /** Aborting kills the child and turns the run into a cancelled failure. */
  signal?: AbortSignal;
};

const DEFAULT_PI_EXECUTABLE = "pi";

/** Keys that carry the arguments of a tool call, whichever name Pi uses. */
const TOOL_ARG_KEYS = ["args", "input", "arguments", "parameters"];

/** Longest string kept verbatim inside a logged argument. */
const MAX_ARG_STRING = 240;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "***"],
  [/\b(github_pat_[A-Za-z0-9_]{20,})/g, "***"],
  [/\b(sk-[A-Za-z0-9]{16,})/g, "***"],
  [
    /((?:"?(?:api[_-]?key|token|password|secret|authorization)"?\s*[:=]\s*"?))[^\s"',}]{8,}/gi,
    "$1***",
  ],
];

/** Mask credentials before a tool argument reaches a public job log. */
export function redactForLog(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    text,
  );
}

/**
 * Shrink a tool argument into something safe and useful to log: paths, patterns
 * and commands survive, file bodies and other large blobs become `<N chars>`.
 */
export function summarizeArgs(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_ARG_STRING
      ? `<${value.length} chars>`
      : redactForLog(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => summarizeArgs(item, depth + 1));
  }
  if (value && typeof value === "object" && depth < 2) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 12)
        .map(([key, item]) => [key, summarizeArgs(item, depth + 1)]),
    );
  }
  return "…";
}

function toolArgs(event: PiEvent): unknown {
  for (const key of TOOL_ARG_KEYS) {
    const value = event[key];
    if (value === undefined || value === null) continue;
    return summarizeArgs(value);
  }
  return undefined;
}

/**
 * The trimmed event stream written to the job log. `show_full_output` prints the
 * raw records instead; this is the always-on view, so it keeps the tool name and
 * its arguments — a log of tool names alone cannot tell a reader what a twenty
 * minute run was doing.
 */
export function summarizeEventForLog(event: PiEvent): string | null {
  switch (event.type) {
    case "session": {
      return JSON.stringify(
        { type: "session", id: event.id, version: event.version },
        null,
        2,
      );
    }
    case "turn_end": {
      return JSON.stringify({ type: "turn_end" }, null, 2);
    }
    case "tool_execution_start":
    case "tool_execution_end": {
      const args = toolArgs(event);
      return JSON.stringify(
        {
          type: event.type,
          toolName: event.toolName,
          ...(args === undefined ? {} : { args }),
          isError: event.isError === true,
          durationMs: event.durationMs,
        },
        null,
        2,
      );
    }
    case "message_end": {
      // Some builds report tool calls only inside the assistant message, so log
      // those too and the parameters are visible whichever way Pi emits them.
      const message = event.message as
        | { role?: string; content?: unknown }
        | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) {
        return null;
      }
      const calls = (message.content as Array<Record<string, unknown>>)
        .filter(
          (block) =>
            block &&
            typeof block.type === "string" &&
            /tool_(use|call)/i.test(block.type),
        )
        .map((block) => ({
          toolName: block.name ?? block.toolName,
          args: summarizeArgs(block.input ?? block.args ?? block.arguments),
        }));
      return calls.length > 0
        ? JSON.stringify({ type: "assistant_tool_calls", calls }, null, 2)
        : null;
    }
    case "error":
    case "auto_retry_end": {
      return JSON.stringify(event, null, 2);
    }
    default:
      return null;
  }
}

export async function runPi(input: PiRunInput): Promise<PiRunResult> {
  const spawnProcess = input.spawnImpl ?? spawn;
  const jsonSchema = input.jsonSchema?.trim();
  const basePrompt =
    input.promptText ?? (await readFile(input.promptPath, "utf-8").catch(() => ""));
  // Pi has no schema flag, so the requirement travels in the prompt and the
  // object is extracted from the final assistant message.
  const promptText = jsonSchema
    ? `${basePrompt}\n\n## Required output\n\nReply with a single JSON object that conforms to this JSON Schema, and nothing else:\n\n\`\`\`json\n${jsonSchema}\n\`\`\``
    : basePrompt;
  const hasJsonSchema = Boolean(jsonSchema);
  const argv = [...input.parsed.argv, ...buildPromptArgs(promptText, input.promptPath)];
  const executable = input.piExecutable?.trim() || DEFAULT_PI_EXECUTABLE;

  if (!input.parsed.showFullOutput) {
    console.log("Running Pi agent (full output hidden for security)...");
    console.log(
      "Rerun with `show_full_output: true` for the raw event stream.",
    );
  }
  console.log(`Running Pi with prompt from file: ${input.promptPath}`);
  console.log(
    "Pi options:",
    JSON.stringify(
      { argv: argv.filter((arg) => arg !== promptText), provider: input.env ? Object.keys(input.env) : [] },
      null,
      2,
    ),
  );

  const collector = createEventCollector();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let maxTurnsExceeded = false;
  let killed = false;
  let cancelled = false;
  let lastTool: string | undefined;
  const startedAt = Date.now();

  const child = spawnProcess(executable, argv, {
    env: { ...process.env, ...(input.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    // Windows resolves the npm shim (`pi.cmd`) only through a shell; Linux and
    // macOS runners, which the action targets, spawn the binary directly.
    shell: process.platform === "win32",
  });

  // Cancellation comes from the runner (SIGTERM on a cancelled job) or from the
  // job timeout. Killing the child lets the caller publish what it has instead
  // of leaving the tracking comment stuck on "Pi is working…".
  const abortRun = (reason: string): void => {
    if (killed) return;
    cancelled = true;
    killed = true;
    core.warning(`${reason}; stopping Pi and reporting what it produced.`);
    child.kill("SIGTERM");
  };

  if (input.signal?.aborted) abortRun("The run was aborted");
  else input.signal?.addEventListener("abort", () => abortRun("The run was aborted"), { once: true });

  function handleLine(line: string): void {
    const event = collector.pushLine(line);
    if (!event) return;

    if (input.parsed.showFullOutput) {
      console.log(JSON.stringify(event, null, 2));
    } else {
      const sanitized = summarizeEventForLog(event);
      if (sanitized) console.log(sanitized);
    }
    // Tell the caller which tool is running and how far along the run is, so a
    // long run is observable instead of a silent 20 minutes in the job log.
    if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
      lastTool = event.toolName;
    }
    if (event.type === "turn_end") {
      const snapshot = collector.summary();
      input.onProgress?.({
        turns: snapshot.numTurns,
        elapsedMs: Date.now() - startedAt,
        ...(lastTool ? { lastTool } : {}),
        totalTokens: snapshot.usage.totalTokens,
      });
    }

    if (
      input.parsed.maxTurns !== undefined &&
      collector.summary().numTurns > input.parsed.maxTurns &&
      !killed
    ) {
      maxTurnsExceeded = true;
      killed = true;
      core.error(
        `Pi exceeded the configured max_turns of ${input.parsed.maxTurns}; stopping the run.`,
      );
      child.kill("SIGTERM");
    }
  }

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      handleLine(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
    // Bound memory: keep the tail, which is what a failure explanation needs.
    if (stderrBuffer.length > 64_000) {
      stderrBuffer = stderrBuffer.slice(-32_000);
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", (error) => {
      reject(new Error(`Failed to start Pi (${executable}): ${error.message}`));
    });
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (stdoutBuffer.trim()) handleLine(stdoutBuffer);

  const summary = collector.summary();
  const events = collector.events();
  const executionFile = await writeExecutionFile(events);

  if (stderrBuffer.trim()) {
    // Diagnostics only; the JSON stream on stdout is the source of truth.
    console.log("Pi stderr (tail):", stderrBuffer.trim().split("\n").slice(-20).join("\n"));
  }

  const result: PiRunResult = {
    conclusion: "failure",
    numTurns: summary.numTurns,
    ...(executionFile ? { executionFile } : {}),
    ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
    ...(summary.finalText ? { finalText: summary.finalText } : {}),
    ...(cancelled ? { cancelled: true } : {}),
    usage: summary.usage,
  };

  if (summary.sessionId) {
    core.info(`Set session_id: ${summary.sessionId}`);
  }

  // A failed run still returns its partial text and the reason, so the caller can
  // post both: the thread must never end on the "I'll analyze this" placeholder.
  const failure = cancelled
    ? "Run was cancelled before Pi finished"
    : maxTurnsExceeded
      ? `Pi reported ${summary.numTurns} turns, exceeding the configured maximum of ${input.parsed.maxTurns}`
      : exitCode !== 0
        ? `Pi execution failed (exit ${exitCode}): ${
            summary.errors.join(", ") ||
            stderrBuffer.trim().split("\n").pop() ||
            "unknown error"
          }`
        : summary.aborted
          ? "Pi run was aborted before it settled"
          : summary.errors.length > 0
            ? `Pi execution failed: ${summary.errors.join(", ")}`
            : !summary.settled
              ? "Pi exited without an agent_settled event; the run did not complete"
              : undefined;

  if (failure) {
    result.error = failure;
    core.error(failure);
    return result;
  }

  if (hasJsonSchema) {
    const structured = summary.finalText
      ? extractJsonObject(summary.finalText)
      : undefined;
    if (!structured) {
      result.error =
        "json_schema was provided but Pi did not return a parsable JSON object";
      core.error(result.error);
      return result;
    }
    result.structuredOutput = JSON.stringify(structured);
    core.info(
      `Set structured_output with ${Object.keys(structured as object).length} field(s)`,
    );
  }

  result.conclusion = "success";
  return result;
}
