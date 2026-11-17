import { describe, expect, test } from "bun:test";
import type { TriageConfig } from "../src/triage/config";
import {
  buildDuplicateComments,
  duplicateMarker,
  isDuplicate,
  MARKER_PREFIX,
  parseDecision,
  raisedAgainMarker,
  renderComment,
  resolveLabels,
  type TriageDecision,
} from "../src/triage/decide";

const ON_NEW_ISSUE = `Possibly a duplicate of #{{number}} ({{state}}): {{reason}}

If this is the same problem, please continue in #{{number}} and close this one.`;

function makeConfig(patch?: (config: TriageConfig) => void): TriageConfig {
  const config: TriageConfig = {
    labels: {
      type: {
        required: true,
        options: [
          { name: "bug", description: "Something is broken" },
          { name: "enhancement", description: "A new feature" },
          { name: "question", description: "A usage question" },
        ],
      },
      priority: {
        required: true,
        options: [
          { name: "P0", description: "Unusable" },
          { name: "P1", description: "Core feature broken" },
          { name: "P2", description: "Off the main path" },
        ],
      },
      state: {
        required: false,
        options: [{ name: "needs-info", description: "Missing steps" }],
      },
    },
    duplicate: {
      label: "duplicate",
      confidence: 0.8,
      candidates: 8,
      includeComments: true,
      comment: {
        onNewIssue: ON_NEW_ISSUE,
        onOriginal: "Raised again in #{{new_number}} ({{date}}).",
      },
    },
  };
  patch?.(config);
  return config;
}

function answer(overrides: Record<string, unknown> = {}): unknown {
  return {
    labels: ["bug"],
    priority: "P1",
    duplicate_of: null,
    confidence: 0.4,
    reason: "Crash on startup",
    ...overrides,
  };
}

function decision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    labels: ["bug"],
    priority: "P2",
    duplicateOf: null,
    confidence: 0.9,
    reason: "the same crash",
    ...overrides,
  };
}

describe("parseDecision", () => {
  test("parses a valid answer and redacts before truncating the reason", () => {
    // The token sits at the front so the assertion proves redaction ran before
    // the 200-character cut, not after.
    const reason = `crash ghp_${"a".repeat(36)} ${"padding ".repeat(30)}`;

    const { decision: parsed, problems } = parseDecision(
      answer({ reason: `  ${reason}  ` }),
      makeConfig(),
      [12],
    );

    expect(problems).toEqual([]);
    expect(parsed).toBeDefined();
    const text = parsed?.reason ?? "";
    expect(text).toHaveLength(200);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain("ghp_");
    expect(text).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(text.startsWith("crash ")).toBe(true);
    expect(parsed?.labels).toEqual(["bug"]);
    expect(parsed?.priority).toBe("P1");
    expect(parsed?.duplicateOf).toBeNull();
    expect(parsed?.confidence).toBe(0.4);
  });

  test("drops unknown labels and keeps the known ones", () => {
    const { decision: parsed, problems } = parseDecision(
      answer({ labels: ["bug", "not-a-label", "enhancement"] }),
      makeConfig(),
      [],
    );

    expect(problems).toEqual([]);
    expect(parsed?.labels).toEqual(["bug", "enhancement"]);
  });

  test("reports a problem when no known label survives", () => {
    const { decision: parsed, problems } = parseDecision(
      answer({ labels: ["not-a-label"] }),
      makeConfig(),
      [],
    );

    expect(parsed).toBeUndefined();
    expect(problems.map((problem) => problem.field)).toEqual(["labels"]);
  });

  test("reports a problem when labels is not a list", () => {
    const { decision: parsed, problems } = parseDecision(
      answer({ labels: "bug" }),
      makeConfig(),
      [],
    );

    expect(parsed).toBeUndefined();
    expect(problems.map((problem) => problem.field)).toContain("labels");
  });

  test("treats a duplicate_of outside the candidates as null with a problem", () => {
    const { decision: parsed, problems } = parseDecision(
      answer({ duplicate_of: 999 }),
      makeConfig(),
      [12, 34],
    );

    expect(parsed).toBeUndefined();
    expect(problems).toEqual([
      { field: "duplicate_of", message: "not one of the candidates" },
    ]);
  });

  test("keeps a duplicate_of that is one of the candidates", () => {
    const { decision: parsed, problems } = parseDecision(
      answer({ duplicate_of: 34 }),
      makeConfig(),
      [12, 34],
    );

    expect(problems).toEqual([]);
    expect(parsed?.duplicateOf).toBe(34);
  });

  test("rejects the trigger label", () => {
    const { decision: parsed, problems } = parseDecision(
      answer({ labels: ["bug", "pi"] }),
      makeConfig(),
      [],
    );

    expect(parsed).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe("labels");
    expect(problems[0]?.message).toContain("pi");
  });

  test("rejects a confidence outside [0, 1]", () => {
    for (const confidence of [-0.1, 1.5, Number.NaN, "high"]) {
      const { decision: parsed, problems } = parseDecision(
        answer({ confidence }),
        makeConfig(),
        [],
      );

      expect(parsed).toBeUndefined();
      expect(problems.map((problem) => problem.field)).toEqual(["confidence"]);
    }
  });

  test("rejects a priority the configuration does not offer", () => {
    const { decision: parsed, problems } = parseDecision(
      answer({ priority: "P9" }),
      makeConfig(),
      [],
    );

    expect(parsed).toBeUndefined();
    expect(problems.map((problem) => problem.field)).toEqual(["priority"]);
  });

  test("rejects an answer that is not a mapping", () => {
    const { decision: parsed, problems } = parseDecision(
      "bug, P1",
      makeConfig(),
      [],
    );

    expect(parsed).toBeUndefined();
    expect(problems).toHaveLength(1);
  });
});

describe("isDuplicate", () => {
  test("honours the configured confidence threshold", () => {
    const config = makeConfig();

    expect(isDuplicate(decision({ duplicateOf: 12, confidence: 0.79 }), config)).toBe(
      false,
    );
    expect(isDuplicate(decision({ duplicateOf: 12, confidence: 0.8 }), config)).toBe(
      true,
    );
  });

  test("is false without a duplicate target, whatever the confidence", () => {
    const config = makeConfig();

    expect(
      isDuplicate(decision({ duplicateOf: null, confidence: 1 }), config),
    ).toBe(false);
  });
});

describe("resolveLabels", () => {
  test("applies one type label and one priority label", () => {
    expect(resolveLabels(makeConfig(), decision())).toEqual(["bug", "P2"]);
  });

  test("adds the state label only when the configuration offers it", () => {
    const config = makeConfig();

    expect(
      resolveLabels(config, decision(), { unmetState: "needs-info" }),
    ).toEqual(["bug", "P2", "needs-info"]);
    expect(resolveLabels(config, decision(), { unmetState: "nope" })).toEqual([
      "bug",
      "P2",
    ]);
  });

  test("adds the duplicate label and de-duplicates", () => {
    const config = makeConfig();

    expect(
      resolveLabels(config, decision({ labels: ["bug", "P2"] }), {
        duplicate: true,
      }),
    ).toEqual(["bug", "P2", "duplicate"]);
  });
});

describe("renderComment", () => {
  test("inserts values and leaves unknown placeholders untouched", () => {
    const rendered = renderComment("Hi {{name}}, see #{{number}} / {{unknown}}", {
      name: "Ada",
      number: "12",
    });

    expect(rendered).toBe("Hi Ada, see #12 / {{unknown}}");
  });

  test("inserts values verbatim, including `$` sequences", () => {
    const rendered = renderComment("reason: {{reason}}", {
      reason: "cost $& then $1",
    });

    expect(rendered).toBe("reason: cost $& then $1");
  });

  test("replaces every occurrence of a placeholder", () => {
    expect(renderComment("{{a}}-{{a}}", { a: "x" })).toBe("x-x");
  });
});

describe("buildDuplicateComments", () => {
  test("ends both comments with the marker for the other issue", () => {
    const comments = buildDuplicateComments({
      config: makeConfig(),
      duplicateOf: 12,
      newIssueNumber: 456,
      duplicateState: "open",
      reason: "the same crash",
      date: "2025-01-31",
    });

    expect(comments.onNewIssue).toContain("Possibly a duplicate of #12 (open)");
    expect(comments.onNewIssue).toContain("the same crash");
    expect(
      comments.onNewIssue.endsWith(`\n\n<!-- ${MARKER_PREFIX}:duplicate-of=12 -->`),
    ).toBe(true);
    expect(comments.onNewIssue.endsWith(`\n\n${duplicateMarker(12)}`)).toBe(true);

    expect(comments.onOriginal).toContain("Raised again in #456 (2025-01-31).");
    expect(
      comments.onOriginal.endsWith(`\n\n<!-- ${MARKER_PREFIX}:raised-again=456 -->`),
    ).toBe(true);
    expect(comments.onOriginal.endsWith(`\n\n${raisedAgainMarker(456)}`)).toBe(true);
  });

  test("renders the markers as hidden single-line comments", () => {
    expect(duplicateMarker(123)).toBe("<!-- pi-triage:duplicate-of=123 -->");
    expect(raisedAgainMarker(7)).toBe("<!-- pi-triage:raised-again=7 -->");
    expect(MARKER_PREFIX).toBe("pi-triage");
  });
});
