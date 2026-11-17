import { describe, expect, test } from "bun:test";
import {
  assistantText,
  createEventCollector,
  extractJsonObject,
  parseEventLine,
} from "../src/pi/events";
import { formatPiReport } from "../src/pi/report";

const lines = [
  '{"type":"session","version":3,"id":"session-1","cwd":"/repo"}',
  '{"type":"agent_start"}',
  '{"type":"turn_start"}',
  '{"type":"message_end","message":{"role":"user","content":"hi"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Done: "}],"stopReason":"toolUse","usage":{"input":10,"output":5,"totalTokens":15,"cost":{"total":0.002}}}}',
  '{"type":"tool_execution_end","toolCallId":"t1","toolName":"read","isError":false,"durationMs":12}',
  '{"type":"turn_end","message":{"role":"assistant"},"toolResults":[]}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done: all good."}],"stopReason":"stop","usage":{"input":4,"output":6,"totalTokens":10,"cost":{"total":0.001}}}}',
  '{"type":"turn_end","message":{"role":"assistant"},"toolResults":[]}',
  '{"type":"agent_settled","aborted":false}',
];

describe("parseEventLine", () => {
  test("parses a record and tolerates a trailing carriage return", () => {
    expect(parseEventLine('{"type":"turn_end"}\r')?.type).toBe("turn_end");
  });

  test("ignores blank and malformed records", () => {
    expect(parseEventLine("")).toBeUndefined();
    expect(parseEventLine("   ")).toBeUndefined();
    expect(parseEventLine('{"type":"turn_')).toBeUndefined();
    expect(parseEventLine('{"no_type":1}')).toBeUndefined();
  });
});

describe("createEventCollector", () => {
  test("summarizes session id, turns, final text, usage and settlement", () => {
    const collector = createEventCollector();
    for (const line of lines) collector.pushLine(line);
    const summary = collector.summary();

    expect(summary.sessionId).toBe("session-1");
    expect(summary.numTurns).toBe(2);
    expect(summary.finalText).toBe("Done: all good.");
    expect(summary.settled).toBe(true);
    expect(summary.aborted).toBe(false);
    expect(summary.errors).toEqual([]);
    expect(summary.usage).toEqual({
      input: 14,
      output: 11,
      totalTokens: 25,
      cost: 0.003,
    });
  });

  test("collects provider errors and aborts", () => {
    const collector = createEventCollector();
    collector.pushLine('{"type":"error","reason":"529 overloaded"}');
    collector.pushLine(
      '{"type":"auto_retry_end","success":false,"finalError":"terminated"}',
    );
    collector.pushLine('{"type":"agent_settled","aborted":true}');
    const summary = collector.summary();
    expect(summary.errors).toEqual(["529 overloaded", "terminated"]);
    expect(summary.aborted).toBe(true);
  });

  test("treats stopReason error as a failure without losing the text", () => {
    const collector = createEventCollector();
    collector.pushLine(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"stopReason":"error"}}',
    );
    const summary = collector.summary();
    expect(summary.finalText).toBe("partial");
    expect(summary.errors.length).toBe(1);
  });

  test("counts malformed lines separately", () => {
    const collector = createEventCollector();
    collector.pushLine("not json");
    collector.pushLine('{"type":"turn_end"}');
    expect(collector.malformedCount()).toBe(1);
    expect(collector.summary().numTurns).toBe(1);
  });
});

describe("assistantText", () => {
  test("joins text blocks and ignores thinking and tool calls", () => {
    expect(
      assistantText({
        role: "assistant",
        content: [
          { type: "thinking", text: "secret" } as never,
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
  });
});

describe("extractJsonObject", () => {
  test("reads a fenced JSON block", () => {
    expect(extractJsonObject('here you go\n```json\n{"a":1}\n```')).toEqual({
      a: 1,
    });
  });

  test("reads a bare JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  test("returns undefined when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeUndefined();
    expect(extractJsonObject("")).toBeUndefined();
  });
});

describe("formatPiReport", () => {
  test("reports session, turns, tool table and final response", () => {
    const collector = createEventCollector();
    for (const line of lines) collector.pushLine(line);
    const report = formatPiReport(collector.events());

    expect(report).toContain("## Pi Agent Report");
    expect(report).toContain("- Session: `session-1`");
    expect(report).toContain("- Turns: 2");
    expect(report).toContain("- Settled: yes");
    expect(report).toContain("| `read` | 1 | 0 |");
    expect(report).toContain("Done: all good.");
  });

  test("never throws on an empty event list", () => {
    expect(formatPiReport([])).toContain("## Pi Agent Report");
  });
});
