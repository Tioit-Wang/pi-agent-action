/**
 * Duplicate-candidate retrieval for issue triage.
 *
 * Triage can only say "duplicate of #N" when the model is shown the issues a
 * search engine considers related, so this module turns a new issue into a
 * deterministic keyword query, runs it against GitHub issue search, and
 * normalizes the hits into excerpt-sized candidates. Excerpts and the corpus
 * budget exist because every candidate competes for prompt tokens.
 */

export type IssueCandidate = {
  number: number;
  title: string;
  state: "open" | "closed";
  createdAt: string;
  /** At most 800 characters; a trailing `…` marks a cut. */
  bodyExcerpt: string;
  /** At most 3 entries of at most 400 characters each. */
  commentExcerpts: string[];
};

export type CandidateRequest = {
  owner: string;
  repo: string;
  /** The new issue; always excluded from the results. */
  issueNumber: number;
  title: string;
  body: string;
  /** Comment bodies of the new issue, used as extra keyword signal. */
  comments: string[];
  /** Default 8, clamped to 1..20. */
  limit?: number;
  /** Default true; false leaves candidate comments unread. */
  includeComments?: boolean;
  /** Default "duplicate"; candidates carrying it are skipped. */
  duplicateLabel?: string;
  /** Default global fetch; tests inject a stub here. */
  fetchImpl?: typeof fetch;
};

const API_BASE = "https://api.github.com";
const SEARCH_PATH = "/search/issues";
const ACCEPT = "application/vnd.github+json";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const DEFAULT_DUPLICATE_LABEL = "duplicate";
const MAX_BODY_SCAN = 2000;
const MAX_KEYWORDS = 6;
const MIN_KEYWORDS = 3;
const TITLE_KEYWORD_MAX = 80;
const BODY_EXCERPT_MAX = 800;
const COMMENT_EXCERPT_MAX = 400;
const MAX_COMMENT_EXCERPTS = 3;
const CORPUS_MAX_CHARS = 6000;
const ELLIPSIS = "…";

/**
 * Words that appear in almost every report, so a query built from them matches
 * everything and ranks nothing.
 */
const STOPWORDS = new Set(
  "the and for with this that error issue bug please how why not can cannot when where does is are was were it its of to in on at from by".split(
    " ",
  ),
);

// CJK has no spaces, so Han/Kana/Hangul runs stay one token and are shortened
// rather than split on the boundaries used for Latin words.
const CJK =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const TOKEN_RE = new RegExp(`[${CJK}]+|[\\p{L}\\p{N}]+`, "gu");
const CJK_RE = new RegExp(`^[${CJK}]+$`, "u");

/**
 * Deterministic keywords for one issue: the title as a phrase (when short
 * enough) plus the most frequent title/body/comment tokens. No model call, so
 * the same issue always yields the same query and candidate set.
 */
export function extractKeywords(input: CandidateRequest): string[] {
  const title = input.title.trim();
  const counts = new Map<string, number>();
  const corpus = [title, input.body.slice(0, MAX_BODY_SCAN), ...input.comments];
  for (const text of corpus) {
    for (const token of tokens(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const keywords: string[] = [];
  // A short title is the strongest signal available, so it takes the first
  // slot; longer titles would be quoted as an unusable exact phrase.
  if (title.length > 0 && title.length <= TITLE_KEYWORD_MAX) keywords.push(title);

  for (const token of ranked(counts)) {
    if (keywords.length >= MAX_KEYWORDS) break;
    // A one-word title is the same phrase as its own token: keep the title's
    // casing and do not spend a second slot on it.
    if (keywords.some((keyword) => keyword.toLowerCase() === token)) continue;
    keywords.push(token);
  }

  // Too little signal for a ranked query: the title alone is the fallback.
  return keywords.length < MIN_KEYWORDS && title.length > 0 ? [title] : keywords;
}

/** GitHub issue-search query; multi-word phrases are quoted for exact match. */
export function buildSearchQuery(
  repoFullName: string,
  keywords: string[],
  state: "open" | "closed",
): string {
  const terms = keywords
    .map((keyword) => quotePhrase(keyword))
    .filter((term) => term.length > 0);
  const head = `repo:${repoFullName} is:issue state:${state}`;
  return terms.length > 0 ? `${head} (${terms.join(" OR ")})` : head;
}

/**
 * Keeps whole candidates while the summed `title + bodyExcerpt +
 * commentExcerpts` length fits the budget. Stopping at the first over-budget
 * candidate keeps every kept excerpt complete, because half a body reads as
 * truncated evidence when candidates are compared side by side.
 */
export function truncateCorpus(
  candidates: IssueCandidate[],
  maxChars: number = CORPUS_MAX_CHARS,
): IssueCandidate[] {
  const kept: IssueCandidate[] = [];
  let total = 0;
  for (const candidate of candidates) {
    const size = candidateChars(candidate);
    if (kept.length > 0 && total + size > maxChars) break;
    kept.push(candidate);
    total += size;
  }
  return kept;
}

/**
 * Searches open and closed issues, drops the obvious non-candidates, and
 * returns at most `limit` candidates in API relevance order (open first). A
 * non-2xx response throws so the caller can degrade gracefully instead of
 * reading an outage as "no duplicates".
 */
export async function findDuplicateCandidates(
  input: CandidateRequest,
): Promise<IssueCandidate[]> {
  const limit = clamp(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const includeComments = input.includeComments ?? true;
  const duplicateLabel = normalizeLabel(
    input.duplicateLabel ?? DEFAULT_DUPLICATE_LABEL,
  );
  const keywords = extractKeywords(input);
  const repoFullName = `${input.owner}/${input.repo}`;
  const doFetch = input.fetchImpl ?? fetch;
  const token = process.env["GITHUB_TOKEN"]?.trim();

  const search = async (state: "open" | "closed"): Promise<unknown[]> => {
    const url = new URL(`${API_BASE}${SEARCH_PATH}`);
    url.searchParams.set("q", buildSearchQuery(repoFullName, keywords, state));
    url.searchParams.set("per_page", "5");
    url.searchParams.set("sort", "relevance");
    url.searchParams.set("order", "desc");

    const headers: Record<string, string> = { Accept: ACCEPT };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const response = await doFetch(url.toString(), { method: "GET", headers });
    if (!response.ok) {
      throw new Error(
        `GitHub issue search failed with status ${response.status} for ${SEARCH_PATH} (state:${state})`,
      );
    }
    return readItems(response);
  };

  // Closed issues are searched too: a duplicate is often already closed, and
  // the extra request is paid once per triage run.
  const results = await Promise.all([search("open"), search("closed")]);

  const candidates: IssueCandidate[] = [];
  const seen = new Set<number>();
  for (const items of results) {
    for (const item of items) {
      const record = asRecord(item);
      if (!record) continue;

      const number = asNumber(record["number"]);
      if (number === undefined || number === input.issueNumber) continue;
      // `pull_request` is present only on PRs, which search returns mixed in.
      if (record["pull_request"] != null || hasLabel(record["labels"], duplicateLabel)) {
        continue;
      }
      if (seen.has(number)) continue;

      seen.add(number);
      candidates.push(toCandidate(record, number, includeComments));
    }
  }

  return truncateCorpus(candidates.slice(0, limit));
}

function tokens(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0];
    if (CJK_RE.test(raw)) {
      // One character matches too much and 5+ characters is not a useful index
      // term, so long runs are cut to their first four characters.
      if (raw.length > 1) found.push(raw.length <= 4 ? raw : raw.slice(0, 4));
      continue;
    }
    const token = raw.toLowerCase();
    if (token.length >= 3 && !STOPWORDS.has(token)) found.push(token);
  }
  return found;
}

function ranked(counts: Map<string, number>): string[] {
  // Frequency first, then code-unit order, so output does not depend on the
  // order the corpus happened to mention tokens in.
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([token]) => token);
}

function quotePhrase(phrase: string): string {
  // Embedded quotes would break the query's phrase grouping.
  const cleaned = phrase.replace(/"/g, "").trim();
  if (cleaned.length === 0) return "";
  return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function candidateChars(candidate: IssueCandidate): number {
  const comments = candidate.commentExcerpts.reduce(
    (sum, excerpt) => sum + excerpt.length,
    0,
  );
  return candidate.title.length + candidate.bodyExcerpt.length + comments;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeLabel(label: string): string {
  const trimmed = label.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : DEFAULT_DUPLICATE_LABEL;
}

async function readItems(response: Response): Promise<unknown[]> {
  try {
    const payload: unknown = await response.json();
    const items = asRecord(payload)?.["items"];
    return Array.isArray(items) ? items : [];
  } catch {
    // A malformed body means no usable hits, not a hard failure.
    return [];
  }
}

function toCandidate(
  record: Record<string, unknown>,
  number: number,
  includeComments: boolean,
): IssueCandidate {
  const comments = includeComments ? commentBodies(record["comments"]) : [];
  return {
    number,
    title: asString(record["title"]) ?? "",
    state: asString(record["state"]) === "open" ? "open" : "closed",
    createdAt: asString(record["created_at"]) ?? "",
    bodyExcerpt: truncate(asString(record["body"]) ?? "", BODY_EXCERPT_MAX),
    commentExcerpts: comments.map((body) =>
      truncate(body, COMMENT_EXCERPT_MAX),
    ),
  };
}

function commentBodies(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_COMMENT_EXCERPTS);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // `max` is the total length budget, so the ellipsis replaces a character
  // rather than pushing the excerpt past the cap.
  return `${text.slice(0, max - 1)}${ELLIPSIS}`;
}

function hasLabel(labels: unknown, target: string): boolean {
  if (!Array.isArray(labels)) return false;
  return labels.some((label) => {
    const name =
      typeof label === "string" ? label : asString(asRecord(label)?.["name"]);
    return name !== undefined && name.trim().toLowerCase() === target;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}
