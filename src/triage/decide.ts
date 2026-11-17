/**
 * Turns the triage model's JSON answer into a decision the action can apply.
 *
 * The answer is untrusted: every field is validated and normalized here so a
 * caller that receives a `decision` can label an issue without re-checking it,
 * and a caller that receives `problems` can retry or fail with a reason.
 */

import { FORBIDDEN_LABELS, type TriageConfig } from "./config";
import { redactSecrets } from "../github/utils/sanitizer";

export type TriageDecision = {
  /** Type labels chosen by the model, 1..2 entries, all from the config. */
  labels: string[];
  /** One of the configured priority group names. */
  priority: string;
  duplicateOf: number | null;
  /** 0..1. */
  confidence: number;
  /** At most 200 characters, secrets redacted. */
  reason: string;
};

export type DecisionProblem = {
  field: string;
  message: string;
};

const MAX_TYPE_LABELS = 2;
const REASON_LIMIT = 200;
const ELLIPSIS = "…";
const PLACEHOLDER = /\{\{([a-z_][a-z0-9_]*)\}\}/gi;

type Raw = Record<string, unknown>;

/** A value a parser either produced or refused; refusals always record a problem. */
type Parsed<T> = { ok: true; value: T } | { ok: false };

const FAILED: Parsed<never> = { ok: false };

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function asRecord(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}

function isForbidden(label: string): boolean {
  return FORBIDDEN_LABELS.includes(label);
}

function parseTypeLabels(
  raw: unknown,
  config: TriageConfig,
  problems: DecisionProblem[],
): Parsed<string[]> {
  if (!Array.isArray(raw)) {
    problems.push({ field: "labels", message: "must be a list of type labels" });
    return FAILED;
  }

  const known = new Set(config.labels.type.options.map((option) => option.name));
  const chosen: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();

    // Forbidden labels are checked before membership: a config that offers `pi`
    // would be rejected at load time, so this is the only place the trigger
    // label can still arrive, and applying it would start another run.
    if (isForbidden(name)) {
      problems.push({
        field: "labels",
        message: `"${name}" must never be applied: it is the trigger label`,
      });
      continue;
    }

    // A misspelt label is a model mistake, not a failed run: drop it silently
    // and let the remaining labels carry the decision.
    if (!known.has(name)) continue;

    if (chosen.includes(name) || chosen.length >= MAX_TYPE_LABELS) continue;
    chosen.push(name);
  }

  if (chosen.length === 0) {
    problems.push({ field: "labels", message: "no known type label was chosen" });
    return FAILED;
  }

  return ok(chosen);
}

function parsePriority(
  raw: unknown,
  config: TriageConfig,
  problems: DecisionProblem[],
): Parsed<string> {
  const known = config.labels.priority.options.map((option) => option.name);
  const name = typeof raw === "string" ? raw.trim() : "";

  if (!known.includes(name)) {
    problems.push({
      field: "priority",
      message: `must be one of: ${known.join(", ")}`,
    });
    return FAILED;
  }

  return ok(name);
}

function parseDuplicateOf(
  raw: unknown,
  candidateNumbers: number[],
  problems: DecisionProblem[],
): Parsed<number | null> {
  // An omitted key reads as "no duplicate": there is nothing to check against
  // the candidates, so it is not a problem.
  if (raw === undefined || raw === null) return ok(null);

  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    problems.push({ field: "duplicate_of", message: "must be a number or null" });
    return FAILED;
  }

  if (!candidateNumbers.includes(raw)) {
    problems.push({ field: "duplicate_of", message: "not one of the candidates" });
    return ok(null);
  }

  return ok(raw);
}

function parseConfidence(
  raw: unknown,
  problems: DecisionProblem[],
): Parsed<number> {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    problems.push({ field: "confidence", message: "must be a number in [0, 1]" });
    return FAILED;
  }

  return ok(raw);
}

function parseReason(raw: unknown, problems: DecisionProblem[]): Parsed<string> {
  if (typeof raw !== "string") {
    problems.push({ field: "reason", message: "must be a string" });
    return FAILED;
  }

  // Redact before truncating: cutting a credential in half first would let the
  // visible remainder slip past the redactor and into a public comment.
  const cleaned = redactSecrets(raw.trim());
  const reason =
    cleaned.length > REASON_LIMIT
      ? `${cleaned.slice(0, REASON_LIMIT - 1)}${ELLIPSIS}`
      : cleaned;

  return ok(reason);
}

/**
 * Validates the model's answer against the configuration and the duplicate
 * candidates the run fetched. All violations are collected; nothing throws and
 * `decision` is only present when the answer is completely usable.
 */
export function parseDecision(
  raw: unknown,
  config: TriageConfig,
  candidateNumbers: number[],
): { decision?: TriageDecision; problems: DecisionProblem[] } {
  const problems: DecisionProblem[] = [];
  const record = asRecord(raw);
  if (!record) {
    return { problems: [{ field: "", message: "decision must be a mapping" }] };
  }

  const labels = parseTypeLabels(record.labels, config, problems);
  const priority = parsePriority(record.priority, config, problems);
  const duplicateOf = parseDuplicateOf(
    record.duplicate_of,
    candidateNumbers,
    problems,
  );
  const confidence = parseConfidence(record.confidence, problems);
  const reason = parseReason(record.reason, problems);

  // A refused field always logged a problem, so returning here is safe for both
  // branches: refused values and answers that lost a label to the rules above.
  if (!labels.ok || !priority.ok || !duplicateOf.ok || !confidence.ok || !reason.ok) {
    return { problems };
  }
  if (problems.length > 0) return { problems };

  return {
    problems,
    decision: {
      labels: labels.value,
      priority: priority.value,
      duplicateOf: duplicateOf.value,
      confidence: confidence.value,
      reason: reason.value,
    },
  };
}

export function isDuplicate(
  decision: TriageDecision,
  config: TriageConfig,
): boolean {
  return (
    decision.duplicateOf !== null &&
    decision.confidence >= config.duplicate.confidence
  );
}

/**
 * Labels to apply, in the order they should appear. `unmetState` comes from the
 * caller's own checks (e.g. a body with no reproduction steps), not the model.
 */
export function resolveLabels(
  config: TriageConfig,
  decision: TriageDecision,
  options?: { duplicate?: boolean; unmetState?: string | null },
): string[] {
  const labels = [...decision.labels, decision.priority];

  const unmetState = options?.unmetState ?? null;
  if (
    unmetState &&
    config.labels.state?.options.some((option) => option.name === unmetState)
  ) {
    labels.push(unmetState);
  }

  if (options?.duplicate === true) labels.push(config.duplicate.label);

  // Deduplicate while keeping first-seen order. Forbidden labels are filtered
  // here too: the decision is model output and `pi` would re-trigger the action.
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const label of labels) {
    if (isForbidden(label) || seen.has(label)) continue;
    seen.add(label);
    resolved.push(label);
  }

  return resolved;
}

/** Substitutes `{{key}}` placeholders. Unknown placeholders stay as written. */
export function renderComment(
  template: string,
  values: Record<string, string>,
): string {
  // A replacer function keeps `$&`-style sequences in values literal; comment
  // bodies quote model output, so `$` must never be read as a substitution.
  return template.replace(
    PLACEHOLDER,
    (match, key: string) => values[key] ?? match,
  );
}

export const MARKER_PREFIX = "pi-triage";

export function duplicateMarker(duplicateOf: number): string {
  return `<!-- ${MARKER_PREFIX}:duplicate-of=${duplicateOf} -->`;
}

export function raisedAgainMarker(newIssueNumber: number): string {
  return `<!-- ${MARKER_PREFIX}:raised-again=${newIssueNumber} -->`;
}

/**
 * The HTML marker goes on its own line after a blank line so it renders hidden
 * and a later run can find our own comment without matching user text.
 */
function withMarker(body: string, marker: string): string {
  const trimmed = body.trimEnd();
  return trimmed === "" ? marker : `${trimmed}\n\n${marker}`;
}

export function buildDuplicateComments(input: {
  config: TriageConfig;
  duplicateOf: number;
  newIssueNumber: number;
  duplicateState: "open" | "closed";
  reason: string;
  /** YYYY-MM-DD. */
  date: string;
}): { onNewIssue: string; onOriginal: string } {
  const templates = input.config.duplicate.comment;

  const onNewIssue = renderComment(templates.onNewIssue, {
    number: String(input.duplicateOf),
    state: input.duplicateState,
    reason: input.reason,
  });

  const onOriginal = renderComment(templates.onOriginal, {
    new_number: String(input.newIssueNumber),
    date: input.date,
  });

  return {
    onNewIssue: withMarker(onNewIssue, duplicateMarker(input.duplicateOf)),
    onOriginal: withMarker(onOriginal, raisedAgainMarker(input.newIssueNumber)),
  };
}
