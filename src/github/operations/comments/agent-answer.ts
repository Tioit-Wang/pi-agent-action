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
