import { describe, expect, test } from "bun:test";
import type { TriageConfig } from "../src/triage/config";
import {
  TRIAGE_OUTPUT_SCHEMA,
  buildTriageJsonSchema,
  buildTriagePrompt,
  type IssueCandidate,
  type TriageIssueContext,
} from "../src/triage/prompt";

const config: TriageConfig = {
  labels: {
    type: {
      required: true,
      options: [
        { name: "bug", description: "Something is broken" },
        { name: "enhancement", description: "New capability" },
      ],
    },
    priority: {
      required: true,
      options: [
        { name: "P1", description: "Drop everything" },
        { name: "P2", description: "Next release" },
      ],
    },
    state: {
      required: false,
      options: [{ name: "needs-repro", description: "Cannot reproduce yet" }],
    },
  },
  duplicate: {
    label: "duplicate",
    confidence: 0.85,
    candidates: 5,
    includeComments: true,
    comment: {
      onNewIssue: "Possibly a duplicate of #{{number}}",
      onOriginal: "Raised again in #{{new_number}}",
    },
  },
};

function issue(overrides: Partial<TriageIssueContext> = {}): TriageIssueContext {
  return {
    number: 1234,
    title: "Crash when opening the settings panel",
    author: "octocat",
    body: "Steps to reproduce: open the panel.",
    comments: ["Same here on Linux."],
    createdAt: "2026-01-02T03:04:05Z",
    ...overrides,
  };
}

function candidate(overrides: Partial<IssueCandidate> = {}): IssueCandidate {
  return {
    number: 42,
    title: "Settings panel crash on open",
    state: "open",
    createdAt: "2025-12-01T00:00:00Z",
    bodyExcerpt: "Same crash after login.",
    commentExcerpts: ["first excerpt", "second excerpt", "third excerpt", "fourth excerpt"],
    ...overrides,
  };
}

function prompt(input: {
  issue?: TriageIssueContext;
  candidates?: IssueCandidate[];
}): string {
  return buildTriagePrompt({
    config,
    issue: input.issue ?? issue(),
    candidates: input.candidates ?? [candidate()],
  });
}

/** Typed access to a nested schema node, so tests never need `any`. */
function property(schema: Record<string, unknown>, key: string): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const node = properties[key];
  if (!node) throw new Error(`schema has no property "${key}"`);
  return node;
}

describe("buildTriagePrompt: allowed labels", () => {
  test("lists every label with its description", () => {
    const text = prompt({});

    expect(text).toContain("## Allowed labels");
    expect(text).toContain("bug — Something is broken");
    expect(text).toContain("enhancement — New capability");
    expect(text).toContain("P1 — Drop everything");
    expect(text).toContain("P2 — Next release");
    expect(text).toContain("needs-repro — Cannot reproduce yet");
  });

  test("states the count rules and the duplicate threshold", () => {
    const text = prompt({});

    expect(text).toContain("exactly one type label");
    expect(text).toContain("exactly one priority label");
    expect(text).toContain("at most one");
    expect(text).toContain("Do not use any label that is not listed above.");
    expect(text).toContain("at least 0.85");
    expect(text).toContain("never invent a number");
  });

  test("omits the state group when the config has none", () => {
    const noState: TriageConfig = {
      ...config,
      labels: { type: config.labels.type, priority: config.labels.priority },
    };
    const text = buildTriagePrompt({ config: noState, issue: issue(), candidates: [] });

    expect(text).toContain("state (at most one):");
    expect(text).toContain("(none configured");
    expect(text).not.toContain("needs-repro");
  });
});

describe("buildTriagePrompt: issue and candidates", () => {
  test("renders the new issue header", () => {
    const text = prompt({});

    expect(text).toContain("## The new issue");
    expect(text).toContain("#1234");
    expect(text).toContain(issue().title);
    expect(text).toContain("octocat");
    expect(text).toContain("2026-01-02T03:04:05Z");
    expect(text).toContain("comment 1: Same here on Linux.");
  });

  test("renders one block per candidate with state and excerpts", () => {
    const text = prompt({
      candidates: [
        candidate(),
        candidate({ number: 77, state: "closed", title: "Older report", createdAt: "2025-01-01T00:00:00Z" }),
      ],
    });

    expect(text).toContain("## Candidate issues");
    expect(text).toContain("### #42 (open, 2025-12-01T00:00:00Z)");
    expect(text).toContain("### #77 (closed, 2025-01-01T00:00:00Z)");
    expect(text).toContain("Same crash after login.");
    expect(text).toContain("- comment: first excerpt");
    expect(text).toContain("- comment: third excerpt");
    // Only the first three comment excerpts are rendered.
    expect(text).not.toContain("fourth excerpt");
  });

  test("prints (no candidates) and asks for a null duplicate", () => {
    const text = prompt({ candidates: [] });

    expect(text).toContain("(no candidates)");
    expect(text).toContain("duplicate_of: null");
  });

  test("truncates the body at 4000 characters and each comment at 600", () => {
    const body = "a".repeat(5000);
    const comment = "b".repeat(1200);
    const text = prompt({ issue: issue({ body, comments: [comment] }), candidates: [] });

    expect(text).toContain(`${"a".repeat(4000)}…`);
    expect(text).not.toContain("a".repeat(4001));
    expect(text).toContain(`${"b".repeat(600)}…`);
    expect(text).not.toContain("b".repeat(601));
  });

  test("keeps at most ten comments", () => {
    const comments = Array.from({ length: 12 }, (_, index) => `body ${index + 1}`);
    const text = prompt({ issue: issue({ comments }), candidates: [] });

    expect(text).toContain("comment 10: body 10");
    expect(text).not.toContain("comment 11:");
    expect(text).not.toContain("body 12");
  });

  test("ends with the JSON-only output contract", () => {
    const text = prompt({});
    const contract = text.indexOf("## Output contract");

    expect(contract).toBeGreaterThan(text.indexOf("## Candidate issues"));
    expect(text.slice(contract)).toContain("single JSON object");
    expect(text.slice(contract)).toContain("no markdown fences before or after");
    for (const field of ["labels", "priority", "duplicate_of", "confidence", "reason"]) {
      expect(text.slice(contract)).toContain(`\`${field}\``);
    }
    expect(text.slice(contract)).toContain("no markdown links");
  });
});

describe("buildTriageJsonSchema", () => {
  test("mirrors the configured labels and closes the object", () => {
    const schema = buildTriageJsonSchema(config);
    const labels = property(schema, "labels");
    const items = labels.items as Record<string, unknown>;

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["labels", "priority", "duplicate_of", "confidence", "reason"]);
    expect(items.enum).toEqual(["bug", "enhancement"]);
    expect(labels.minItems).toBe(1);
    expect(labels.maxItems).toBe(2);
    expect(property(schema, "priority").enum).toEqual(["P1", "P2"]);
    expect(property(schema, "duplicate_of").type).toEqual(["integer", "null"]);
    expect(property(schema, "confidence")).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(property(schema, "reason")).toMatchObject({ type: "string", maxLength: 200 });
  });

  test("follows a different configuration", () => {
    const other: TriageConfig = {
      ...config,
      labels: {
        type: { required: true, options: [{ name: "bug", description: "Defect" }] },
        priority: { required: true, options: [{ name: "high", description: "Urgent" }] },
      },
    };
    const schema = buildTriageJsonSchema(other);
    const items = property(schema, "labels").items as Record<string, unknown>;

    expect(items.enum).toEqual(["bug"]);
    expect(property(schema, "priority").enum).toEqual(["high"]);
  });

  test("the prompt embeds the schema it would be validated against", () => {
    expect(prompt({})).toContain(JSON.stringify(buildTriageJsonSchema(config), null, 2));
  });

  test("the static illustrative schema keeps the documented shape", () => {
    expect(TRIAGE_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(TRIAGE_OUTPUT_SCHEMA.required).toEqual([
      "labels",
      "priority",
      "duplicate_of",
      "confidence",
      "reason",
    ]);
    const items = property(TRIAGE_OUTPUT_SCHEMA, "labels").items as Record<string, unknown>;
    expect(items.enum).toEqual(["bug"]);
    expect(property(TRIAGE_OUTPUT_SCHEMA, "priority").enum).toEqual(["P2"]);
  });
});
