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

export type PiRunResult = {
  executionFile?: string;
  sessionId?: string;
  conclusion: "success" | "failure";
  structuredOutput?: string;
  /** Final assistant text, used by the caller for summaries and links. */
  finalText?: string;
  usage?: PiEventSummary["usage"];
};

export type PiRunInput = {
  promptPath: string;
  promptText: string;
  parsed: ParsedPiOptions;
  /** Extra environment for the child (agent dir, provider secret, ...). */
  env?: Record<string, string>;
  /** Executable or absolute path for the `pi` binary. */
  piExecutable?: string;
  /** When set, the run must return a JSON object; Pi has no --json-schema. */
  hasJsonSchema?: boolean;
  /** Test seam: replaces child_process.spawn. */
  spawnImpl?: typeof spawn;
};

const DEFAULT_PI_EXECUTABLE = "pi";

function sanitizeEventLine(event: PiEvent): string | null {
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
    case "tool_execution_end": {
      return JSON.stringify(
        {
          type: "tool_execution_end",
          toolName: event.toolName,
          isError: event.isError === true,
          durationMs: event.durationMs,
        },
        null,
        2,
      );
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
  const promptText =
    input.promptText ??
    (await readFile(input.promptPath, "utf-8").catch(() => ""));
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

  const child = spawnProcess(executable, argv, {
    env: { ...process.env, ...(input.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    // Windows resolves the npm shim (`pi.cmd`) only through a shell; Linux and
    // macOS runners, which the action targets, spawn the binary directly.
    shell: process.platform === "win32",
  });

  function handleLine(line: string): void {
    const event = collector.pushLine(line);
    if (!event) return;

    if (input.parsed.showFullOutput) {
      console.log(JSON.stringify(event, null, 2));
    } else {
      const sanitized = sanitizeEventLine(event);
      if (sanitized) console.log(sanitized);
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
    ...(executionFile ? { executionFile } : {}),
    ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
    ...(summary.finalText ? { finalText: summary.finalText } : {}),
    usage: summary.usage,
  };

  if (summary.sessionId) {
    core.info(`Set session_id: ${summary.sessionId}`);
  }

  if (exitCode !== 0 && !maxTurnsExceeded) {
    const detail = summary.errors.join(", ") || stderrBuffer.trim().split("\n").pop() || "unknown error";
    throw new Error(`Pi execution failed (exit ${exitCode}): ${detail}`);
  }
  if (maxTurnsExceeded) {
    throw new Error(
      `Pi reported ${summary.numTurns} turns, exceeding the configured maximum of ${input.parsed.maxTurns}`,
    );
  }
  if (summary.aborted) {
    throw new Error("Pi run was aborted before it settled");
  }
  if (summary.errors.length > 0) {
    throw new Error(`Pi execution failed: ${summary.errors.join(", ")}`);
  }
  if (!summary.settled) {
    throw new Error(
      "Pi exited without an agent_settled event; the run did not complete",
    );
  }

  if (input.hasJsonSchema) {
    const structured = summary.finalText
      ? extractJsonObject(summary.finalText)
      : undefined;
    if (!structured) {
      throw new Error(
        "json_schema was provided but Pi did not return a parsable JSON object",
      );
    }
    result.structuredOutput = JSON.stringify(structured);
    core.info(
      `Set structured_output with ${Object.keys(structured as object).length} field(s)`,
    );
  }

  result.conclusion = "success";
  return result;
}
