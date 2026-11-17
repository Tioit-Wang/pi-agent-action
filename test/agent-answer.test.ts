#!/usr/bin/env bun

import { describe, expect, test } from "bun:test";
import {
  PLACEHOLDER_ANSWER,
  stripAnalysisPreamble,
  withAgentAnswer,
} from "../src/github/operations/comments/agent-answer";

describe("stripAnalysisPreamble", () => {
  test("drops a leading analysis block and keeps the answer", () => {
    const answer = "<analysis>\nreading files\n</analysis>\n\nThe name is pi-desktop.";

    expect(stripAnalysisPreamble(answer)).toBe("The name is pi-desktop.");
  });

  test("keeps an analysis block that is not at the start", () => {
    const answer = "Answer first.\n\n<analysis>late</analysis>";

    expect(stripAnalysisPreamble(answer)).toBe(answer);
  });

  test("leaves an answer without an analysis block untouched", () => {
    expect(stripAnalysisPreamble("  plain answer\n")).toBe("plain answer");
  });
});

describe("withAgentAnswer", () => {
  test("replaces the placeholder the tracking comment carries", () => {
    const body = `Pi is working…\n\n---\n${PLACEHOLDER_ANSWER}`;

    expect(withAgentAnswer(body, "The name is pi-desktop.")).toBe(
      "Pi is working…\n\n---\nThe name is pi-desktop.",
    );
  });

  test("appends the answer when the comment has no placeholder", () => {
    const body = "Pi is working…\n\n---\n";

    expect(withAgentAnswer(body, "The name is pi-desktop.")).toBe(
      "Pi is working…\n\n---\n\nThe name is pi-desktop.",
    );
  });

  test("keeps the comment body when the agent produced no text", () => {
    const body = `Pi is working…\n\n---\n${PLACEHOLDER_ANSWER}`;

    expect(withAgentAnswer(body, undefined)).toBe(body);
    expect(withAgentAnswer(body, "   ")).toBe(body);
  });

  test("publishes the answer without the model's analysis preamble", () => {
    const body = PLACEHOLDER_ANSWER;

    expect(withAgentAnswer(body, "<analysis>why</analysis>\n\nDone.")).toBe(
      "Done.",
    );
  });
});
