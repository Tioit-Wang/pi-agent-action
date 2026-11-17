/**
 * Prompt and response schema for issue triage.
 *
 * The model sees nothing but this prompt: no repository files, no search
 * results beyond the candidates the caller already fetched. Everything the
 * answer depends on — the label vocabulary, the duplicate threshold, the issue
 * text, the candidate list, the output schema — is restated here, and every
 * bound is applied here so a huge issue cannot blow the context window.
 */

import type { TriageConfig, TriageLabelGroup } from "./config";

/**
 * Structural mirror of the candidate type produced by `src/triage/search.ts`.
 * Kept local so this module and its tests do not depend on a module that is
 * being written in parallel; the shapes are interchangeable.
 */
export type IssueCandidate = {
  number: number;
  title: string;
  state: "open" | "closed";
  createdAt: string;
  bodyExcerpt: string;
  commentExcerpts: string[];
};

export type TriageIssueContext = {
  number: number;
  title: string;
  author: string;
  body: string;
  comments: string[];
  createdAt: string;
};

/** Characters kept from the issue body and from each individual comment. */
const BODY_LIMIT = 4000;
const COMMENT_LIMIT = 600;
const MAX_COMMENTS = 10;
const MAX_CANDIDATE_COMMENT_EXCERPTS = 3;
const REASON_LIMIT = 200;

/**
 * Illustrative response schema for callers that only need to print one (docs,
 * logs, issue comments). The `bug` and `P2` enums are placeholders, not the
 * labels of any particular repository: the authoritative, config-derived schema
 * is `buildTriageJsonSchema`.
 */
export const TRIAGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["labels", "priority", "duplicate_of", "confidence", "reason"],
  properties: {
    labels: {
      type: "array",
      items: { enum: ["bug"] },
      minItems: 1,
      maxItems: 2,
    },
    priority: { enum: ["P2"] },
    duplicate_of: { type: ["integer", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", maxLength: REASON_LIMIT },
  },
};

/** `TRIAGE_OUTPUT_SCHEMA` as printable JSON text. */
export const TRIAGE_OUTPUT_SCHEMA_JSON = JSON.stringify(
  TRIAGE_OUTPUT_SCHEMA,
  null,
  2,
);

function optionNames(group: TriageLabelGroup | undefined): string[] {
  return group?.options.map((option) => option.name) ?? [];
}

/**
 * Response schema for one repository's configuration. Enumerating the labels in
 * the schema is what makes a hallucinated or misspelled label a validation
 * error instead of a silently ignored choice.
 */
export function buildTriageJsonSchema(
  config: TriageConfig,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["labels", "priority", "duplicate_of", "confidence", "reason"],
    properties: {
      // One type label is mandatory; the second slot is free for the optional
      // state label (see the note in `buildTriagePrompt`).
      labels: {
        type: "array",
        items: { enum: optionNames(config.labels.type) },
        minItems: 1,
        maxItems: 2,
      },
      priority: { enum: optionNames(config.labels.priority) },
      duplicate_of: { type: ["integer", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string", maxLength: REASON_LIMIT },
    },
  };
}

/**
 * Cut `text` at `limit` code units and mark the cut with an ellipsis. A slice
 * can end on the high half of a surrogate pair; that half is dropped so the
 * model never receives an unpaired surrogate.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${safe}…`;
}

function renderLabelGroup(
  name: string,
  rule: string,
  group: TriageLabelGroup | undefined,
): string[] {
  const lines = [`${name} (${rule}):`];
  if (!group || group.options.length === 0) {
    lines.push("- (none configured — do not use a label of this kind)");
    return lines;
  }
  for (const option of group.options) {
    const description = option.description.trim() || "(no description)";
    lines.push(`- ${option.name} — ${description}`);
  }
  return lines;
}

function renderDuplicateRule(config: TriageConfig): string[] {
  const { label, confidence } = config.duplicate;
  return [
    "## Duplicate rule",
    "",
    `Only report a duplicate when your confidence is at least ${confidence}.`,
    "Take the duplicate's number from the candidate list below; never invent a number.",
    "When you are unsure, or no candidate describes the same problem, report `duplicate_of: null`.",
    `The host applies the "${label}" label itself, so never list it under \`labels\`.`,
  ];
}

function renderIssue(issue: TriageIssueContext): string[] {
  const lines = [
    "## The new issue",
    "",
    `Number: #${issue.number}`,
    `Title: ${issue.title}`,
    `Author: ${issue.author}`,
    `Created: ${issue.createdAt}`,
    "",
    "Body:",
    "",
    truncate(issue.body, BODY_LIMIT).trim() || "(empty)",
  ];

  const comments = issue.comments
    .slice(0, MAX_COMMENTS)
    .filter((comment) => comment.trim().length > 0);
  if (comments.length > 0) {
    lines.push("", `Comments (at most ${MAX_COMMENTS}):`, "");
    comments.forEach((comment, index) => {
      lines.push(`comment ${index + 1}: ${truncate(comment, COMMENT_LIMIT).trim()}`);
    });
  }

  return lines;
}

function renderCandidate(candidate: IssueCandidate): string[] {
  const lines = [
    `### #${candidate.number} (${candidate.state}, ${candidate.createdAt})`,
    candidate.title.trim(),
    "",
    candidate.bodyExcerpt.trim() || "(no body)",
  ];
  for (const excerpt of candidate.commentExcerpts.slice(
    0,
    MAX_CANDIDATE_COMMENT_EXCERPTS,
  )) {
    const text = excerpt.trim();
    if (text) lines.push(`- comment: ${text}`);
  }
  return lines;
}

function renderCandidates(candidates: IssueCandidate[]): string[] {
  const lines = ["## Candidate issues", ""];
  if (candidates.length === 0) {
    lines.push(
      "(no candidates)",
      "",
      "No existing issue was retrieved, so you must return `duplicate_of: null`.",
    );
    return lines;
  }
  lines.push(
    "These are the only issues that can be duplicates; any other number is invalid.",
    "",
  );
  candidates.forEach((candidate, index) => {
    if (index > 0) lines.push("");
    lines.push(...renderCandidate(candidate));
  });
  return lines;
}

function renderOutputContract(config: TriageConfig): string[] {
  return [
    "## Output contract",
    "",
    "Reply with a single JSON object and nothing else: no prose, no explanation,",
    "no markdown fences before or after. It must match this schema:",
    "",
    "```json",
    JSON.stringify(buildTriageJsonSchema(config), null, 2),
    "```",
    "",
    "- `labels` — label names from the allowed list: exactly one type label, plus the state label when one applies.",
    "- `priority` — exactly one priority label name from the allowed list.",
    "- `duplicate_of` — the number of the candidate this issue duplicates, or `null`.",
    `- \`confidence\` — number between 0 and 1 for the duplicate decision; report a duplicate only at ${config.duplicate.confidence} or above.`,
    `- \`reason\` — one plain sentence, at most ${REASON_LIMIT} characters, no markdown links.`,
  ];
}

export function buildTriagePrompt(input: {
  config: TriageConfig;
  issue: TriageIssueContext;
  candidates: IssueCandidate[];
}): string {
  const { config, issue, candidates } = input;
  const lines = [
    "Triage the new GitHub issue below: choose its labels and decide whether it",
    "duplicates an existing issue.",
    "",
    "## Allowed labels",
    "",
    "Only the labels listed here may be used for triage; any other label is invalid.",
    "",
    ...renderLabelGroup("type", "exactly one", config.labels.type),
    "",
    ...renderLabelGroup("priority", "exactly one", config.labels.priority),
    "",
    ...renderLabelGroup("state", "at most one", config.labels.state),
    "",
    "Apply exactly one type label, exactly one priority label, and at most one",
    "state label. Do not use any label that is not listed above.",
    "",
    ...renderDuplicateRule(config),
    "",
    ...renderIssue(issue),
    "",
    ...renderCandidates(candidates),
    "",
    ...renderOutputContract(config),
  ];
  return `${lines.join("\n")}\n`;
}
