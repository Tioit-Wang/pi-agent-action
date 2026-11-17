import { describe, expect, test } from "bun:test";
import {
  PROMPT_ARGV_LIMIT,
  buildPromptArgs,
  parsePiOptions,
} from "../src/pi/options";

describe("parsePiOptions", () => {
  test("always selects the JSON event stream", () => {
    const { argv } = parsePiOptions({});
    expect(argv[0]).toBe("--mode");
    expect(argv[1]).toBe("json");
  });

  test("maps provider and model to CLI flags", () => {
    const { argv } = parsePiOptions({
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(argv).toContain("--provider");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("deepseek");
    expect(argv[argv.indexOf("--model") + 1]).toBe("deepseek-chat");
  });

  test("passes tool allowlists and denylists as comma separated values", () => {
    const { argv } = parsePiOptions({
      allowedTools: "read, grep ,find",
      disallowedTools: "bash,write",
    });
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,find");
    expect(argv[argv.indexOf("--exclude-tools") + 1]).toBe("bash,write");
  });

  test("noTools wins over an allowlist", () => {
    const { argv } = parsePiOptions({
      noTools: true,
      allowedTools: "read",
      disallowedTools: "bash",
    });
    expect(argv).toContain("--no-tools");
    expect(argv).not.toContain("--tools");
    expect(argv).not.toContain("--exclude-tools");
  });

  test("grants project trust only when asked", () => {
    expect(parsePiOptions({}).argv).toContain("--no-approve");
    expect(parsePiOptions({ approveProject: true }).argv).toContain(
      "--approve",
    );
  });

  test("appends pi_args words verbatim", () => {
    const { argv } = parsePiOptions({ piArgs: "--thinking high --offline" });
    expect(argv).toContain("--thinking");
    expect(argv).toContain("high");
    expect(argv).toContain("--offline");
  });

  test("rejects shell operators in pi_args instead of dropping them", () => {
    expect(() => parsePiOptions({ piArgs: "--offline > /tmp/out" })).toThrow(
      /unsupported shell construct/,
    );
  });

  test("parses max_turns as a positive integer", () => {
    expect(parsePiOptions({ maxTurns: "7" }).maxTurns).toBe(7);
    expect(() => parsePiOptions({ maxTurns: "0" })).toThrow(
      /positive integer/,
    );
    expect(() => parsePiOptions({ maxTurns: "many" })).toThrow(
      /positive integer/,
    );
  });

  test("treats show_full_output literally", () => {
    expect(parsePiOptions({ showFullOutput: "true" }).showFullOutput).toBe(true);
    expect(parsePiOptions({ showFullOutput: "yes" }).showFullOutput).toBe(
      false,
    );
  });
});

describe("buildPromptArgs", () => {
  test("sends a small prompt as the final message", () => {
    expect(buildPromptArgs("do the thing", "/tmp/p.txt")).toEqual([
      "--",
      "do the thing",
    ]);
  });

  test("attaches a large prompt as a file argument", () => {
    const prompt = "x".repeat(PROMPT_ARGV_LIMIT + 1);
    const args = buildPromptArgs(prompt, "/tmp/pi-prompt.txt");
    expect(args[1]).toBe("@/tmp/pi-prompt.txt");
    expect(args.some((arg) => arg === prompt)).toBe(false);
  });
});
