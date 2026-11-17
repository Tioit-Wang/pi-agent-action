import { describe, expect, test } from "bun:test";
import {
  redactForLog,
  summarizeArgs,
  summarizeEventForLog,
} from "../src/pi/run";

describe("summarizeEventForLog", () => {
  test("keeps the arguments of a tool call", () => {
    const line = summarizeEventForLog({
      type: "tool_execution_end",
      toolName: "grep",
      args: { pattern: "flashOfInvisible", path: "src/main" },
      isError: false,
      durationMs: 13,
    });

    expect(line).toContain('"toolName": "grep"');
    expect(line).toContain('"pattern": "flashOfInvisible"');
    expect(line).toContain('"path": "src/main"');
    expect(line).toContain('"durationMs": 13');
  });

  test("reads arguments from any of the names Pi uses", () => {
    for (const key of ["args", "input", "arguments", "parameters"]) {
      const line = summarizeEventForLog({
        type: "tool_execution_start",
        toolName: "read",
        [key]: { path: "README.md" },
      });

      expect(line).toContain('"path": "README.md"');
    }
  });

  test("logs tool calls carried by an assistant message", () => {
    const line = summarizeEventForLog({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", name: "bash", input: { command: "rg -n foo" } },
        ],
      },
    });

    expect(line).toContain('"toolName": "bash"');
    expect(line).toContain('"command": "rg -n foo"');
  });

  test("ignores assistant messages that call no tool", () => {
    expect(
      summarizeEventForLog({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    ).toBeNull();
  });

  test("hides file bodies behind their size", () => {
    const line = summarizeEventForLog({
      type: "tool_execution_end",
      toolName: "write",
      args: { path: "a.ts", content: "x".repeat(5000) },
    });

    expect(line).toContain('"path": "a.ts"');
    expect(line).toContain("<5000 chars>");
    expect(line).not.toContain("xxxx");
  });
});

describe("redactForLog", () => {
  test("masks credentials that appear in a command", () => {
    const text = redactForLog(
      "curl -H 'Authorization: bearer ghp_abcdefghijklmnopqrstuvwx' https://x",
    );

    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
    expect(text).toContain("***");
  });

  test("masks an inline assignment", () => {
    expect(redactForLog("OPENAI_API_KEY=sk-abcdef1234567890abcdef")).not.toContain(
      "sk-abcdef1234567890abcdef",
    );
  });

  test("leaves ordinary arguments alone", () => {
    expect(redactForLog("git status --short")).toBe("git status --short");
  });
});

describe("summarizeArgs", () => {
  test("keeps short scalars and counts arrays", () => {
    expect(summarizeArgs({ a: 1, b: true, c: null })).toEqual({
      a: 1,
      b: true,
      c: null,
    });
    expect(summarizeArgs(["x", "y"])).toEqual(["x", "y"]);
  });

  test("bounds deep structures", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    expect(JSON.stringify(summarizeArgs(deep))).not.toContain("d");
  });
});
