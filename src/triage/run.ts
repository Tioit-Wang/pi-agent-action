/**
 * Issue triage: label a newly opened issue and link it to an existing duplicate.
 *
 * The run is silent by design. It never creates a tracking comment, so a
 * repository that only wants labels gets exactly that; the only comment it may
 * post is the duplicate link, and only when a duplicate was actually found.
 *
 * The model is given one call, no tools, and a JSON contract. Everything that
 * touches the repository — the label set, the candidate filter, the comment text,
 * the idempotency markers — is decided here, not by the model.
 */

import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import type { Octokit } from "@octokit/rest";
import {
  missingRepoLabels,
  validateTriageConfig,
  type TriageConfig,
} from "./config";
import {
  buildDuplicateComments,
  duplicateMarker,
  isDuplicate,
  parseDecision,
  raisedAgainMarker,
  resolveLabels,
  type TriageDecision,
} from "./decide";
import {
  buildTriageJsonSchema,
  buildTriagePrompt,
  type TriageIssueContext,
} from "./prompt";
import { findDuplicateCandidates, type IssueCandidate } from "./search";

export type TriageRunInput = {
  octokit: Octokit;
  owner: string;
  repo: string;
  issueNumber: number;
  /** Raw YAML text of the repository's triage configuration. */
  configText: string;
  configPath: string;
  /** Runs the single model call and returns its parsed JSON answer. */
  askModel: (prompt: string, schema: Record<string, unknown>) => Promise<unknown>;
  /** Today, for the "raised again" note. Injectable for tests. */
  now?: () => Date;
  /** Test seam: replaces the GitHub issue search. */
  findCandidates?: typeof findDuplicateCandidates;
};

export type TriageRunResult = {
  /** Labels written to the new issue. */
  labelsApplied: string[];
  /** Issue the new one duplicates, when the run decided so. */
  duplicateOf?: number;
  /** True when the candidate search failed and duplicate detection was skipped. */
  degraded?: "search";
  /** True when the issue was already triaged and nothing changed. */
  skipped?: boolean;
};

const DUPLICATE_RETRY = 1;

function isMarkerPresent(body: string, marker: string): boolean {
  return body.includes(marker);
}

async function readRepoLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await octokit.rest.issues.listLabelsForRepo({
      owner,
      repo,
      per_page: 100,
      page,
    });
    names.push(...response.data.map((label) => label.name));
    if (response.data.length < 100) break;
  }
  return names;
}

async function readIssueComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string[]> {
  const response = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 20,
  });
  return response.data.map((comment) => comment.body ?? "");
}

/**
 * Search is best effort: a rate limit or a broken query must not stop labelling,
 * which is the part a repository relies on.
 */
async function safeCandidates(
  input: TriageRunInput,
  config: TriageConfig,
  body: string,
  comments: string[],
  title: string,
): Promise<IssueCandidate[] | undefined> {
  try {
    const search = input.findCandidates ?? findDuplicateCandidates;
    return await search({
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      title,
      body,
      comments,
      limit: config.duplicate.candidates,
      includeComments: config.duplicate.includeComments,
      duplicateLabel: config.duplicate.label,
    });
  } catch (error) {
    core.warning(
      `Duplicate search failed, continuing with labels only: ${String(error)}`,
    );
    return undefined;
  }
}

async function askWithRetry(
  input: TriageRunInput,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DUPLICATE_RETRY; attempt += 1) {
    try {
      return await input.askModel(prompt, schema);
    } catch (error) {
      lastError = error;
      core.warning(
        `Triage answer attempt ${attempt + 1} failed: ${String(error)}`,
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Triage model failed: ${String(lastError)}`);
}

export async function runTriage(input: TriageRunInput): Promise<TriageRunResult> {
  const now = input.now ?? (() => new Date());

  // 1. Configuration. A broken file fails before the model is called, so a typo
  // cannot surface as a half-finished run.
  let parsedConfig: unknown;
  try {
    parsedConfig = Bun.YAML.parse(input.configText);
  } catch (error) {
    throw new Error(`Cannot parse ${input.configPath}: ${String(error)}`);
  }

  const { config, problems } = validateTriageConfig(parsedConfig);
  if (!config) {
    throw new Error(
      `${input.configPath} is invalid:\n${problems
        .map((problem) => `- ${problem.field}: ${problem.message}`)
        .join("\n")}`,
    );
  }

  const repoLabels = await readRepoLabels(input.octokit, input.owner, input.repo);
  const missing = missingRepoLabels(config, repoLabels);
  if (missing.length > 0) {
    throw new Error(
      `${input.configPath} references labels that ${input.owner}/${input.repo} does not define: ${missing.join(", ")}`,
    );
  }

  // 2. The issue itself.
  const issue = await input.octokit.rest.issues.get({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
  });
  const title = issue.data.title ?? "";
  const body = issue.data.body ?? "";
  const author = issue.data.user?.login ?? "unknown";
  const createdAt = issue.data.created_at ?? now().toISOString();
  const issueComments = await readIssueComments(
    input.octokit,
    input.owner,
    input.repo,
    input.issueNumber,
  );

  // 3. Markers already on the issue make a re-run a no-op: labels are a set, and
  // the duplicate comment must not be posted twice by a workflow re-run.
  const existingBodies = [body, ...issueComments].join("\n\n");
  const alreadyLabelled = (issue.data.labels ?? []).some(
    (label) => typeof label === "object" && label.name === config.duplicate.label,
  );

  // 4. Candidates.
  const candidates = await safeCandidates(
    input,
    config,
    body,
    issueComments,
    title,
  );

  const issueContext: TriageIssueContext = {
    number: input.issueNumber,
    title,
    author,
    body,
    comments: issueComments,
    createdAt,
  };

  const prompt = buildTriagePrompt({
    config,
    issue: issueContext,
    candidates: candidates ?? [],
  });
  const schema = buildTriageJsonSchema(config);

  // 5. One model call, retried once, then validated. A bad answer changes
  // nothing at all.
  const answer = await askWithRetry(input, prompt, schema);
  const candidateNumbers = (candidates ?? []).map((candidate) => candidate.number);
  const { decision, problems: decisionProblems } = parseDecision(
    answer,
    config,
    candidateNumbers,
  );
  if (!decision) {
    throw new Error(
      `Triage answer did not match the contract:\n${decisionProblems
        .map((problem) => `- ${problem.field}: ${problem.message}`)
        .join("\n")}`,
    );
  }

  // 6. Writes.
  const wantsDuplicate = isDuplicate(decision, config) && !alreadyLabelled;
  const duplicateOf = wantsDuplicate ? decision.duplicateOf : null;
  const duplicateCandidate = duplicateOf
    ? candidates?.find((candidate) => candidate.number === duplicateOf)
    : undefined;

  const labels = resolveLabels(config, decision, {
    duplicate: wantsDuplicate,
    unmetState: null,
  });

  if (labels.length > 0) {
    await input.octokit.rest.issues.addLabels({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issueNumber,
      labels,
    });
  }
  core.info(`Applied labels: ${labels.join(", ") || "(none)"}`);

  if (duplicateOf && duplicateCandidate) {
    const date = now().toISOString().slice(0, 10);
    const { onNewIssue, onOriginal } = buildDuplicateComments({
      config,
      duplicateOf,
      newIssueNumber: input.issueNumber,
      duplicateState: duplicateCandidate.state,
      reason: decision.reason,
      date,
    });

    if (!isMarkerPresent(existingBodies, duplicateMarker(duplicateOf))) {
      await input.octokit.rest.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        body: `${onNewIssue}\n\n${duplicateMarker(duplicateOf)}`,
      });
    }

    // The original issue is a courtesy link; a locked thread simply gets none.
    const original = await input.octokit.rest.issues
      .get({ owner: input.owner, repo: input.repo, issue_number: duplicateOf })
      .catch(() => undefined);
    const originalLocked = original?.data.locked === true;

    if (!originalLocked) {
      const originalComments = await readIssueComments(
        input.octokit,
        input.owner,
        input.repo,
        duplicateOf,
      );
      const marker = raisedAgainMarker(input.issueNumber);
      if (!originalComments.some((comment) => isMarkerPresent(comment, marker))) {
        await input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: duplicateOf,
          body: `${onOriginal}\n\n${marker}`,
        });
      }
    } else {
      core.info(`Issue #${duplicateOf} is locked; skipped the back-reference.`);
    }
  }

  const result: TriageRunResult = {
    labelsApplied: labels,
    ...(duplicateOf ? { duplicateOf } : {}),
    ...(candidates === undefined ? { degraded: "search" as const } : {}),
    ...(alreadyLabelled && decision.duplicateOf ? { skipped: true } : {}),
  };

  core.setOutput("labels_applied", labels.join(","));
  core.setOutput("duplicate_of", duplicateOf ? String(duplicateOf) : "");
  core.setOutput("structured_output", JSON.stringify(decision));
  core.setOutput("conclusion", "success");
  return result;
}

/** Read the configuration file from the checked out repository. */
export async function readTriageConfig(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    throw new Error(
      `Cannot read triage configuration at ${path}; copy examples/pi-triage.yml into the repository. (${String(error)})`,
    );
  }
}

/** Convenience wrapper so the caller does not repeat the file read. */
export async function runTriageFromRepo(
  input: Omit<TriageRunInput, "configText">,
): Promise<TriageRunResult> {
  const configText = await readTriageConfig(input.configPath);
  return runTriage({ ...input, configText });
}

export type { TriageDecision };
