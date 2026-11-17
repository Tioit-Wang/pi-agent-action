/**
 * Parser and summarizer for the Pi agent's JSON event stream.
 *
 * `pi --mode json` writes strict JSONL to stdout: one session header record,
 * then session events, then exit. Records are separated by LF only, so this
 * module deliberately does not use Node's readline (it also splits on Unicode
 * line/paragraph separators, which are legal inside JSON strings).
 *
 * Reference: node_modules/@earendil-works/pi-coding-agent/docs/json.md
 */

export type PiEvent = {
  type: string;
  [key: string]: unknown;
};

export type PiAssistantMessage = {
  role: "assistant";
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: number | { total?: number };
  };
  [key: string]: unknown;
};

export type PiEventSummary = {
  /** Session id from the header record, used for `session_id` and resume. */
  sessionId?: string;
  /** Number of completed assistant turns. */
  numTurns: number;
  /** Final assistant text, from the authoritative last `message_end`. */
  finalText?: string;
  /** True when `agent_settled` arrived, i.e. Pi has no automatic work left. */
  settled: boolean;
  /** True when the run was aborted (signal, max turns, timeout). */
  aborted: boolean;
  /** Provider/runtime errors collected from the stream. */
  errors: string[];
  /** Last assistant stop reason, e.g. `stop`, `error`, `aborted`. */
  stopReason?: string;
  /** Accumulated usage of every assistant message. */
  usage: { input: number; output: number; totalTokens: number; cost: number };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Extract plain text from an assistant message's content blocks. */
export function assistantText(message: PiAssistantMessage): string {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
}

function usageCost(cost: PiAssistantMessage["usage"]): number {
  if (typeof cost?.cost === "number") return cost.cost;
  const total = asRecord(cost?.cost)?.total;
  return typeof total === "number" ? total : 0;
}

/**
 * Parse one stdout line. Returns undefined for blank or malformed records;
 * a truncated final line is a normal outcome when the process is killed, so
 * callers must tolerate gaps instead of failing the whole run.
 */
export function parseEventLine(line: string): PiEvent | undefined {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!trimmed.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const record = asRecord(parsed);
    if (!record || typeof record.type !== "string") return undefined;
    return record as PiEvent;
  } catch {
    return undefined;
  }
}

/**
 * Incremental collector: feed raw lines, then read a summary. Keeping this as a
 * class-free factory makes it usable from tests without spawning Pi.
 */
export function createEventCollector() {
  const events: PiEvent[] = [];
  const summary: PiEventSummary = {
    numTurns: 0,
    settled: false,
    aborted: false,
    errors: [],
    usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
  };
  let malformed = 0;

  function pushLine(line: string): PiEvent | undefined {
    const event = parseEventLine(line);
    if (!event) {
      if (line.trim()) malformed += 1;
      return undefined;
    }
    events.push(event);
    apply(event);
    return event;
  }

  function apply(event: PiEvent): void {
    switch (event.type) {
      case "session": {
        const id = event.id;
        if (typeof id === "string" && id) summary.sessionId = id;
        return;
      }
      case "message_end": {
        const message = asRecord(event.message) as
          | PiAssistantMessage
          | undefined;
        if (message?.role !== "assistant") return;
        const text = assistantText(message);
        if (text) summary.finalText = text;
        if (typeof message.stopReason === "string") {
          summary.stopReason = message.stopReason;
          if (message.stopReason === "error") {
            summary.errors.push("Assistant message stopped with an error");
          }
          if (message.stopReason === "aborted") summary.aborted = true;
        }
        const usage = message.usage;
        if (usage) {
          summary.usage.input += usage.input ?? 0;
          summary.usage.output += usage.output ?? 0;
          summary.usage.totalTokens += usage.totalTokens ?? 0;
          summary.usage.cost += usageCost(usage);
        }
        return;
      }
      case "turn_end": {
        summary.numTurns += 1;
        return;
      }
      case "agent_settled": {
        summary.settled = true;
        if (event.aborted === true) summary.aborted = true;
        return;
      }
      case "error": {
        const reason = event.reason ?? event.error;
        summary.errors.push(
          typeof reason === "string" ? reason : JSON.stringify(reason ?? {}),
        );
        return;
      }
      case "auto_retry_end": {
        if (event.success === false) {
          const message = event.finalError ?? "provider retries exhausted";
          summary.errors.push(
            typeof message === "string" ? message : JSON.stringify(message),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  return {
    pushLine,
    events: () => events,
    summary: () => ({ ...summary, errors: [...summary.errors] }),
    malformedCount: () => malformed,
  };
}

/**
 * Best-effort structured output replacement.
 *
 * Pi has no `--json-schema` equivalent, so the prompt asks for a single JSON
 * object and we extract the last fenced-or-bare JSON object from the final
 * assistant text. Returns undefined when nothing parseable is present, which
 * the caller surfaces as a failure (same contract as claude-code-action).
 */
export function extractJsonObject(text: string): unknown | undefined {
  if (!text) return undefined;

  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let match = fenced.exec(text); match; match = fenced.exec(text)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  candidates.push(text.trim());

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]!;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    const slice = candidate.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      continue;
    }
  }
  return undefined;
}
