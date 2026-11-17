import { formatElapsed } from "./common";

/**
 * The action posts the agent's final message verbatim, so the text that
 * reaches the tracking comment is assembled here rather than by the agent.
 */

/** Placeholder the initial tracking comment carries while the agent runs. */
export const PLACEHOLDER_ANSWER = "I'll analyze this and get back to you.";

/**
 * Some models open their final message with a scratchpad `<analysis>` block.
 * It is reasoning scaffolding, not an answer, so drop it before publishing.
 */
const ANALYSIS_PREAMBLE = /^<analysis>[\s\S]*?<\/analysis>\s*/i;

export function stripAnalysisPreamble(answer: string): string {
  return answer.replace(ANALYSIS_PREAMBLE, "").trim();
}

/**
 * Replace the placeholder the initial comment carries with the agent's final
 * answer. Links and headers are rebuilt by updateCommentBody afterwards, so
 * only the placeholder line changes; a comment that never had one gets the
 * answer appended instead of being rewritten.
 */
export function withAgentAnswer(body: string, answer?: string): string {
  const cleaned = answer ? stripAnalysisPreamble(answer) : "";
  if (!cleaned) return body;
  if (!body.includes(PLACEHOLDER_ANSWER)) {
    return body.trimEnd() + "\n\n" + cleaned;
  }
  return body.replace(PLACEHOLDER_ANSWER, cleaned);
}

export type RunOutcome = {
  /** True when the runner stopped the job on purpose. */
  cancelled?: boolean;
  turns?: number;
  durationMs?: number;
  /** Failure reason from the runner, already free of secrets. */
  reason?: string;
};

/**
 * What the thread reads when the run stopped before writing an answer: the job
 * was cancelled, the timeout fired, or a turn budget was hit. Leaving the
 * placeholder in place hides the difference between "still thinking" and
 * "gone", which is exactly the wrong impression on a public issue.
 */
export function buildOutcomeNotice(outcome: RunOutcome): string {
  const verb = outcome.cancelled ? "was cancelled" : "stopped";
  let head = `Pi ${verb} before writing an answer`;
  if (outcome.turns !== undefined) {
    head += ` after ${outcome.turns} turn${outcome.turns === 1 ? "" : "s"}`;
  }
  if (outcome.durationMs !== undefined) {
    head += ` and ${formatElapsed(outcome.durationMs)}`;
  }

  const parts = [`_${head}._`];
  if (outcome.reason) parts.push(outcome.reason);
  parts.push(
    "The job log lists the tools it ran. Try a narrower question, or raise the budget and re-run.",
  );
  return parts.join("\n\n");
}
