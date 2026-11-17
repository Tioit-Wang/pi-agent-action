import { describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTriage, type TriageRunInput } from "../src/triage/run";
import type { IssueCandidate } from "../src/triage/search";

const root = join(import.meta.dir, "..");
const CONFIG = readFileSync(join(root, "examples/pi-triage.yml"), "utf8");

type Call = { method: string; args: Record<string, unknown> };

/**
 * A minimal Octokit stand-in. Only the endpoints triage touches are implemented,
 * because the point of these tests is the decision flow, not HTTP.
 */
function fakeOctokit(options: {
  labels?: string[];
  issueLabels?: string[];
  comments?: string[];
  originalLocked?: boolean;
  searchFails?: boolean;
}) {
  const calls: Call[] = [];
  const labels = options.labels ?? [
    "bug",
    "enhancement",
    "documentation",
    "question",
    "performance",
    "security",
    "P0",
    "P1",
    "P2",
    "P3",
    "needs-info",
    "duplicate",
  ];

  const octokit = {
    rest: {
      issues: {
        listLabelsForRepo: async () => ({ data: labels.map((name) => ({ name })) }),
        get: async ({ issue_number }: { issue_number: number }) => ({
          data:
            issue_number === 7
              ? {
                  title: "Opening model settings crashes the app",
                  body: "The settings page crashes on macOS 14.5.",
                  user: { login: "reporter" },
                  created_at: "2026-11-17T08:00:00Z",
                  labels: (options.issueLabels ?? []).map((name) => ({ name })),
                  locked: false,
                }
              : {
                  title: "Model page crash",
                  body: "old",
                  user: { login: "someone" },
                  created_at: "2026-11-01T08:00:00Z",
                  labels: [],
                  locked: options.originalLocked === true,
                },
        }),
        listComments: async ({ issue_number }: { issue_number: number }) => ({
          data: (issue_number === 7 ? (options.comments ?? []) : []).map((body) => ({
            body,
          })),
        }),
        addLabels: async (args: Record<string, unknown>) => {
          calls.push({ method: "addLabels", args });
          return { data: [] };
        },
        createComment: async (args: Record<string, unknown>) => {
          calls.push({ method: "createComment", args });
          return { data: { id: 1 } };
        },
      },
    },
  } as unknown as Octokit;

  return { octokit, calls };
}

function input(
  octokit: Octokit,
  askModel: TriageRunInput["askModel"],
  overrides: Partial<TriageRunInput> = {},
): TriageRunInput {
  return {
    octokit,
    owner: "o",
    repo: "r",
    issueNumber: 7,
    configText: CONFIG,
    configPath: ".github/pi-triage.yml",
    askModel,
    now: () => new Date("2026-11-17T09:00:00Z"),
    findCandidates: async () => [],
    ...overrides,
  };
}

const answer = (overrides: Record<string, unknown> = {}) => ({
  labels: ["bug"],
  priority: "P2",
  duplicate_of: null,
  confidence: 0.4,
  reason: "Looks like a settings crash.",
  ...overrides,
});
/** A candidate the model is allowed to pick, mirroring what search would return. */
function candidate(number: number): IssueCandidate {
  return {
    number,
    title: "Model page crash",
    state: "closed",
    createdAt: "2026-11-01T08:00:00Z",
    bodyExcerpt: "old",
    commentExcerpts: [],
  };
}

const withCandidate = { findCandidates: async () => [candidate(12)] };

describe("runTriage", () => {
  test("labels the issue and posts nothing when it is not a duplicate", async () => {
    const { octokit, calls } = fakeOctokit({});

    const result = await runTriage(input(octokit, async () => answer()));

    expect(result.labelsApplied).toEqual(["bug", "P2"]);
    expect(result.duplicateOf).toBeUndefined();
    const methods = calls.map((call) => call.method);
    expect(methods).toEqual(["addLabels"]);
    expect(calls[0]?.args["labels"]).toEqual(["bug", "P2"]);
  });

  test("stops before the model when a configured label is missing", async () => {
    const { octokit } = fakeOctokit({ labels: ["bug", "duplicate"] });
    let asked = false;

    await expect(
      runTriage(
        input(octokit, async () => {
          asked = true;
          return answer();
        }),
      ),
    ).rejects.toThrow(/does not define/);
    expect(asked).toBe(false);
  });

  test("stops before the model when the config is structurally invalid", async () => {
    const { octokit } = fakeOctokit({});
    const broken = CONFIG.replace("- { name: bug,", "- { name: defect,");

    await expect(
      runTriage(input(octokit, async () => answer(), { configText: broken })),
    ).rejects.toThrow(/must contain "bug"/);
  });

  test("changes nothing when the model answer breaks the contract", async () => {
    const { octokit, calls } = fakeOctokit({});

    await expect(
      runTriage(input(octokit, async () => answer({ priority: "urgent" }))),
    ).rejects.toThrow(/did not match the contract/);
    expect(calls).toHaveLength(0);
  });

  test("retries the model once before giving up", async () => {
    const { octokit, calls } = fakeOctokit({});
    let attempts = 0;

    await runTriage(
      input(octokit, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("stream dropped");
        return answer();
      }),
    );

    expect(attempts).toBe(2);
    expect(calls.map((call) => call.method)).toEqual(["addLabels"]);
  });

  test("adds the duplicate label and links both issues", async () => {
    const { octokit, calls } = fakeOctokit({});

    const result = await runTriage(
      input(
        octokit,
        async () =>
          answer({
            duplicate_of: 12,
            confidence: 0.91,
            reason: "Same macOS settings crash.",
          }),
        withCandidate,
      ),
    );

    expect(result.duplicateOf).toBe(12);
    expect(result.labelsApplied).toEqual(["bug", "P2", "duplicate"]);

    const added = calls.find((call) => call.method === "addLabels");
    expect(added?.args["labels"]).toContain("duplicate");

    const comments = calls.filter((call) => call.method === "createComment");
    expect(comments).toHaveLength(2);
    expect(comments[0]?.args["issue_number"]).toBe(7);
    expect(String(comments[0]?.args["body"])).toContain("Possibly a duplicate of #12");
    expect(String(comments[0]?.args["body"])).toContain("pi-triage:duplicate-of=12");
    expect(comments[1]?.args["issue_number"]).toBe(12);
    expect(String(comments[1]?.args["body"])).toContain("Raised again in #7");
    expect(String(comments[1]?.args["body"])).toContain("pi-triage:raised-again=7");
  });

  test("does not link when the confidence is below the threshold", async () => {
    const { octokit, calls } = fakeOctokit({});

    const result = await runTriage(
      input(octokit, async () => answer({ duplicate_of: 12, confidence: 0.5 }), withCandidate),
    );

    expect(result.duplicateOf).toBeUndefined();
    expect(calls.filter((call) => call.method === "createComment")).toHaveLength(0);
  });

  test("skips a pending duplicate when the label is already there", async () => {
    const { octokit, calls } = fakeOctokit({ issueLabels: ["duplicate"] });

    const result = await runTriage(
      input(
        octokit,
        async () => answer({ duplicate_of: 12, confidence: 0.95 }),
        withCandidate,
      ),
    );

    expect(result.skipped).toBe(true);
    expect(calls.filter((call) => call.method === "createComment")).toHaveLength(0);
  });

  test("does not repeat a link the issue already carries", async () => {
    const { octokit, calls } = fakeOctokit({
      comments: ["Possibly a duplicate of #12\n\n<!-- pi-triage:duplicate-of=12 -->"],
    });

    await runTriage(
      input(octokit, async () => answer({ duplicate_of: 12, confidence: 0.95 }), withCandidate),
    );
    const comments = calls.filter((call) => call.method === "createComment");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.args["issue_number"]).toBe(12);
  });

  test("skips the back-reference when the original issue is locked", async () => {
    const { octokit, calls } = fakeOctokit({ originalLocked: true });

    await runTriage(
      input(octokit, async () => answer({ duplicate_of: 12, confidence: 0.95 }), withCandidate),
    );
    const comments = calls.filter((call) => call.method === "createComment");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.args["issue_number"]).toBe(7);
  });
});
