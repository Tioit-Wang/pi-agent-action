/**
 * The run footer that closes a tracking comment.
 *
 * It answers the two questions a reader asks after the answer: what ran this, and
 * what did it cost. Cost is reported by the provider when it knows it, otherwise
 * estimated from operator-supplied prices, otherwise left out — never invented.
 */

export const PI_ACTION_URL =
  "https://github.com/Tioit-Wang/pi-agent-action";

export type UsageFooterInput = {
  /** Absolute URL for the executor link. */
  actionUrl?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Cost reported by the provider, in USD. */
  costUsd?: number;
  /** Fallback prices, USD per million tokens. */
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
};

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) {
    const millions = (value / 1_000_000).toFixed(2).replace(/\.?0+$/, "");
    return `${millions}M`;
  }
  if (value >= 1_000) {
    const thousands = (value / 1_000).toFixed(1).replace(/\.0$/, "");
    return `${thousands}k`;
  }
  return String(Math.round(value));
}

function formatUsd(value: number): string {
  if (value >= 0.1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function formatMinutes(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function costLine(
  input: UsageFooterInput,
): { summary: string; detail: string } | undefined {
  if (typeof input.costUsd === "number" && input.costUsd > 0) {
    return {
      summary: `≈${formatUsd(input.costUsd)}`,
      detail: `Estimated cost: ≈${formatUsd(input.costUsd)} (reported by the provider)`,
    };
  }
  const priceIn = input.priceInputPerMillion;
  const priceOut = input.priceOutputPerMillion;
  if (typeof priceIn !== "number" && typeof priceOut !== "number") {
    return undefined;
  }

  const tokensIn = input.inputTokens ?? 0;
  const tokensOut = input.outputTokens ?? 0;
  const total =
    (tokensIn / 1_000_000) * (priceIn ?? 0) +
    (tokensOut / 1_000_000) * (priceOut ?? 0);
  if (!(total > 0)) return undefined;

  const prices = [
    typeof priceIn === "number" ? `$${priceIn}/M input` : "",
    typeof priceOut === "number" ? `$${priceOut}/M output` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return {
    summary: `≈${formatUsd(total)}`,
    detail: `Estimated cost: ≈${formatUsd(total)} (${prices})`,
  };
}

/**
 * Build the `<details>` block. Returns undefined when there is nothing worth
 * showing — a run with no model and no token counts would only add noise.
 */
export function buildUsageFooter(
  input: UsageFooterInput,
): string | undefined {
  const model =
    input.provider && input.model
      ? `${input.provider}/${input.model}`
      : input.model || input.provider;
  const totalTokens =
    input.totalTokens ??
    (input.inputTokens ?? 0) + (input.outputTokens ?? 0);

  if (!model && totalTokens <= 0) return undefined;

  const cost = costLine(input);
  const summaryParts = ["Run details"];
  if (input.durationMs !== undefined) {
    summaryParts.push(formatMinutes(input.durationMs));
  }
  if (totalTokens > 0) summaryParts.push(`${formatTokenCount(totalTokens)} tokens`);
  if (cost) summaryParts.push(cost.summary);

  const details: string[] = [];
  details.push(
    `- Executor: [pi-agent-action](${input.actionUrl ?? PI_ACTION_URL})`,
  );
  if (model) details.push(`- Model: \`${model}\``);

  if (input.durationMs !== undefined) {
    const turns =
      input.turns !== undefined
        ? ` (${input.turns} turn${input.turns === 1 ? "" : "s"})`
        : "";
    details.push(`- Duration: ${formatMinutes(input.durationMs)}${turns}`);
  }

  if (totalTokens > 0) {
    const breakdown =
      input.inputTokens !== undefined || input.outputTokens !== undefined
        ? ` (${formatTokenCount(input.inputTokens ?? 0)} input, ${formatTokenCount(input.outputTokens ?? 0)} output)`
        : "";
    details.push(`- Tokens: ${formatTokenCount(totalTokens)}${breakdown}`);
  }

  if (cost) details.push(`- ${cost.detail}`);

  return `<details><summary>${summaryParts.join(" · ")}</summary>

${details.join("\n")}

</details>`;
}
