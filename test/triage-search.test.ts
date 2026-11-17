import { describe, expect, test } from "bun:test";
import {
  buildSearchQuery,
  extractKeywords,
  findDuplicateCandidates,
  truncateCorpus,
  type CandidateRequest,
  type IssueCandidate,
} from "../src/triage/search";

function baseRequest(overrides: Partial<CandidateRequest> = {}): CandidateRequest {
  return {
    owner: "Tioit-Wang",
    repo: "PI-Desktop",
    issueNumber: 99,
    title: "Model settings page crashes on macOS",
    body: "Opening the model settings page crashes the app. macOS 14.5, version 0.22.0.",
    comments: ["Same crash here after upgrading."],
    ...overrides,
  };
}

type SearchItem = {
  number: number;
  title: string;
  state: string;
  created_at: string;
  body: string | null;
  labels?: Array<{ name: string }>;
  comments?: string[];
  pull_request?: unknown;
};

function jsonResponse(items: SearchItem[], status = 200): Response {
  return new Response(JSON.stringify({ items }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(byState: { open?: SearchItem[]; closed?: SearchItem[]; status?: number }) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const state = url.includes("state%3Aclosed") || url.includes("state:closed")
      ? "closed"
      : "open";
    return jsonResponse(byState[state] ?? [], byState.status ?? 200);
  }) as typeof fetch;
  return { impl, calls };
}

describe("extractKeywords", () => {
  test("drops stopwords and keeps the title phrase", () => {
    const keywords = extractKeywords(baseRequest());

    expect(keywords.length).toBeGreaterThanOrEqual(3);
    expect(keywords.length).toBeLessThanOrEqual(7);
    expect(keywords.some((keyword) => keyword.includes("settings page crashes"))).toBe(
      true,
    );
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("and");
  });

  test("keeps CJK runs of two to four characters", () => {
    const keywords = extractKeywords(
      baseRequest({
        title: "设置里打开模型页会闪退",
        body: "复现步骤：打开设置",
        comments: [],
      }),
    );

    expect(keywords.some((keyword) => /设置|模型|闪退/.test(keyword))).toBe(true);
  });

  test("falls back to the title when nothing else survives", () => {
    const keywords = extractKeywords(
      baseRequest({ title: "crash", body: "the and for", comments: [] }),
    );

    expect(keywords).toEqual(["crash"]);
  });
});

describe("buildSearchQuery", () => {
  test("scopes to the repository, issues and a state", () => {
    const query = buildSearchQuery("o/r", ["settings page", "crash"], "closed");

    expect(query).toContain("repo:o/r");
    expect(query).toContain("is:issue");
    expect(query).toContain("state:closed");
    expect(query).toContain('"settings page"');
    expect(query).toContain("OR");
  });
});

describe("truncateCorpus", () => {
  const make = (number: number, size: number): IssueCandidate => ({
    number,
    title: `issue ${number}`,
    state: "open",
    createdAt: "2026-01-01T00:00:00Z",
    bodyExcerpt: "x".repeat(size),
    commentExcerpts: [],
  });

  test("stops before the budget and always keeps one", () => {
    expect(truncateCorpus([make(1, 100), make(2, 100), make(3, 100)], 250)).toHaveLength(2);
    expect(truncateCorpus([make(1, 900)], 100)).toHaveLength(1);
  });
});

describe("findDuplicateCandidates", () => {
  test("searches open and closed, and drops self, pull requests and duplicates", async () => {
    const stub = stubFetch({
      open: [
        {
          number: 99,
          title: "self",
          state: "open",
          created_at: "2026-01-01T00:00:00Z",
          body: "self",
        },
        {
          number: 41,
          title: "Settings page crashes",
          state: "open",
          created_at: "2026-01-02T00:00:00Z",
          body: "same crash",
          comments: ["me too", "fixed in beta"],
        },
        {
          number: 42,
          title: "A pull request",
          state: "open",
          created_at: "2026-01-02T00:00:00Z",
          body: "pr",
          pull_request: {},
        },
        {
          number: 43,
          title: "Already filed",
          state: "open",
          created_at: "2026-01-02T00:00:00Z",
          body: "dup",
          labels: [{ name: "duplicate" }],
        },
      ],
      closed: [
        {
          number: 12,
          title: "Old crash in settings",
          state: "closed",
          created_at: "2025-12-01T00:00:00Z",
          body: "old",
        },
      ],
    });

    const candidates = await findDuplicateCandidates(
      baseRequest({ fetchImpl: stub.impl }),
    );

    expect(stub.calls).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.number)).toEqual([41, 12]);
    expect(candidates[0]?.state).toBe("open");
    expect(candidates[1]?.state).toBe("closed");
    expect(candidates[0]?.commentExcerpts).toEqual(["me too", "fixed in beta"]);
  });

  test("leaves comments out when includeComments is false", async () => {
    const stub = stubFetch({
      open: [
        {
          number: 41,
          title: "Settings page crashes",
          state: "open",
          created_at: "2026-01-02T00:00:00Z",
          body: "same crash",
          comments: ["me too"],
        },
      ],
    });

    const candidates = await findDuplicateCandidates(
      baseRequest({ fetchImpl: stub.impl, includeComments: false }),
    );

    expect(candidates[0]?.commentExcerpts).toEqual([]);
  });

  test("truncates long bodies and comments", async () => {
    const stub = stubFetch({
      open: [
        {
          number: 41,
          title: "long",
          state: "open",
          created_at: "2026-01-02T00:00:00Z",
          body: "b".repeat(2000),
          comments: ["c".repeat(900)],
        },
      ],
    });

    const candidates = await findDuplicateCandidates(
      baseRequest({ fetchImpl: stub.impl }),
    );

    expect(candidates[0]!.bodyExcerpt).toHaveLength(800);
    expect(candidates[0]!.bodyExcerpt.endsWith("…")).toBe(true);
    expect(candidates[0]!.commentExcerpts[0]).toHaveLength(400);
  });

  test("rejects with the status when the search is refused", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ message: "rate limited" }), {
        status: 403,
      })) as unknown as typeof fetch;

    await expect(
      findDuplicateCandidates(baseRequest({ fetchImpl: failing })),
    ).rejects.toThrow(/403/);
  });
});
