import { describe, expect, test } from "bun:test";
import {
  buildUsageFooter,
  formatTokenCount,
} from "../src/github/operations/comments/usage-footer";
import { updateCommentBody } from "../src/github/operations/comment-logic";

describe("formatTokenCount", () => {
  test("scales millions, thousands and small counts", () => {
    expect(formatTokenCount(1_290_000)).toBe("1.29M");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
    expect(formatTokenCount(84_000)).toBe("84k");
    expect(formatTokenCount(8_400)).toBe("8.4k");
    expect(formatTokenCount(512)).toBe("512");
    expect(formatTokenCount(0)).toBe("0");
  });
});

describe("buildUsageFooter", () => {
  test("collapses into a details block with the run facts", () => {
    const footer = buildUsageFooter({
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      durationMs: 1_163_000,
      turns: 51,
      inputTokens: 1_210_000,
      outputTokens: 84_000,
      priceInputPerMillion: 0.27,
      priceOutputPerMillion: 1.1,
    })!;

    expect(footer.startsWith("<details><summary>")).toBe(true);
    expect(footer).toContain("Run details · 19m 23s · 1.29M tokens");
    expect(footer).toContain(
      "- Executor: [pi-agent-action](https://github.com/Tioit-Wang/pi-agent-action)",
    );
    expect(footer).toContain("- Model: `deepseek/deepseek-v4.1-flash`");
    expect(footer).toContain("- Duration: 19m 23s (51 turns)");
    expect(footer).toContain("- Tokens: 1.29M (1.21M input, 84k output)");
    expect(footer).toContain("Estimated cost: ≈$0.42 ($0.27/M input, $1.1/M output)");
    expect(footer.endsWith("</details>")).toBe(true);
  });

  test("prefers the cost reported by the provider", () => {
    const footer = buildUsageFooter({
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      inputTokens: 10_000,
      costUsd: 0.48,
      priceInputPerMillion: 999,
    })!;

    expect(footer).toContain("≈$0.48");
    expect(footer).toContain("(reported by the provider)");
    expect(footer).not.toContain("999");
  });

  test("shows tokens without a cost when no price is known", () => {
    const footer = buildUsageFooter({
      model: "some-model",
      inputTokens: 1_500,
      outputTokens: 500,
    })!;

    expect(footer).toContain("2k tokens");
    expect(footer).not.toContain("cost");
  });

  test("says nothing when there is nothing to say", () => {
    expect(buildUsageFooter({})).toBeUndefined();
  });

  test("honours an explicit action URL", () => {
    const footer = buildUsageFooter({
      actionUrl: "https://example.test/fork",
      model: "m",
    })!;

    expect(footer).toContain("[pi-agent-action](https://example.test/fork)");
  });
});

describe("final comment body", () => {
  test("drops the live progress line from the answer", () => {
    const body = updateCommentBody({
      currentBody: `Pi is working… <img src="x" />

_turn 101 · 19m 23s · last tool \`read\`_

[View job run](https://example.test/run/1)`,
      actionFailed: false,
      executionDetails: null,
      jobUrl: "https://example.test/run/1",
      agentAnswer: undefined,
    } as never);

    expect(body).not.toContain("turn 101");
    expect(body).not.toContain("last tool");
  });

  test("appends the usage footer after the answer", () => {
    const footer = buildUsageFooter({ model: "m", inputTokens: 1000 })!;
    const body = updateCommentBody({
      currentBody: `Pi is working… <img src="x" />

I'll analyze this and get back to you.

[View job run](https://example.test/run/1)`,
      actionFailed: false,
      executionDetails: null,
      jobUrl: "https://example.test/run/1",
      usageFooter: footer,
    } as never);

    expect(body).toContain("<details><summary>");
    expect(body.trimEnd().endsWith("</details>")).toBe(true);
  });
});
