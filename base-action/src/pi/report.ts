/**
 * Step-summary report for a Pi run.
 *
 * Replaces the Claude-specific `formatTurnsFromData` path: Pi's execution file
 * holds its native JSONL session events, not Claude SDK messages.
 */

import { assistantText, type PiEvent, type PiAssistantMessage } from "./events";

const MAX_TEXT_CHARS = 12_000;

type ToolStat = { name: string; count: number; errors: number };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncate(text: string, limit = MAX_TEXT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n… truncated (${text.length - limit} more characters)`;
}

export function summarizeTools(events: PiEvent[]): ToolStat[] {
  const stats = new Map<string, ToolStat>();
  for (const event of events) {
    if (event.type !== "tool_execution_end") continue;
    const name =
      typeof event.toolName === "string" ? event.toolName : "unknown";
    const entry = stats.get(name) ?? { name, count: 0, errors: 0 };
    entry.count += 1;
    if (event.isError === true) entry.errors += 1;
    stats.set(name, entry);
  }
  return [...stats.values()].sort((a, b) => b.count - a.count);
}

export function formatPiReport(events: PiEvent[]): string {
  const session = asRecord(events.find((event) => event.type === "session"));
  const sessionId = typeof session?.id === "string" ? session.id : "unknown";
  const turns = events.filter((event) => event.type === "turn_end").length;

  const assistantMessages = events
    .filter((event) => event.type === "message_end")
    .map((event) => asRecord(event.message) as PiAssistantMessage | undefined)
    .filter(
      (message): message is PiAssistantMessage => message?.role === "assistant",
    );
  const finalMessage = assistantMessages[assistantMessages.length - 1];
  const finalText = finalMessage ? assistantText(finalMessage) : "";

  const usage = assistantMessages.reduce(
    (totals, message) => ({
      input: totals.input + (message.usage?.input ?? 0),
      output: totals.output + (message.usage?.output ?? 0),
    }),
    { input: 0, output: 0 },
  );

  const tools = summarizeTools(events);
  const settled = events.some((event) => event.type === "agent_settled");
  const errors = events
    .filter((event) => event.type === "error")
    .map((event) => String(event.reason ?? event.error ?? "error"));

  const lines: string[] = ["## Pi Agent Report", ""];
  lines.push(`- Session: \`${sessionId}\``);
  lines.push(`- Turns: ${turns}`);
  lines.push(`- Settled: ${settled ? "yes" : "no"}`);
  lines.push(
    `- Tokens: ${usage.input} in / ${usage.output} out`,
  );
  if (errors.length > 0) {
    lines.push(`- Errors: ${errors.join("; ")}`);
  }

  if (tools.length > 0) {
    lines.push("", "### Tools", "", "| Tool | Calls | Errors |", "| --- | --- | --- |");
    for (const tool of tools) {
      lines.push(`| \`${tool.name}\` | ${tool.count} | ${tool.errors} |`);
    }
  }

  if (finalText) {
    lines.push("", "### Final response", "", truncate(finalText));
  }

  lines.push("");
  return lines.join("\n");
}
