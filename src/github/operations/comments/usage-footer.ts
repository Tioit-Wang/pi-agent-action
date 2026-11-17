/**
 * The run footer that closes a tracking comment.
 *
 * It answers the two questions a reader asks after the answer: what ran this, and
 * what did it cost. Cost comes from the provider when it reports one, otherwise
 * from operator-supplied prices, otherwise from the built-in table below, and it
 * is omitted rather than invented when nothing applies.
 */

export const PI_ACTION_URL = "https://github.com/Tioit-Wang/pi-agent-action";

/** Per-million-token prices, in USD, at peak hours. */
export type TokenPricing = {
  /** Shown in the comment so a reader can check the basis. */
  label: string;
  /** Input tokens that missed the prompt cache. */
  inputCacheMissPerMillion: number;
  /** Input tokens served from the prompt cache. */
  inputCacheHitPerMillion: number;
  outputPerMillion: number;
  /** Multiplier applied outside peak hours. */
  offPeakMultiplier: number;
};

/**
 * DeepSeek bills half price outside peak hours, and cached input is far cheaper
 * than fresh input, so an honest estimate needs all three rates.
 * Source: https://api-docs.deepseek.com/quick_start/pricing
 */
const BUILT_IN_PRICING: Array<{ pattern: RegExp; pricing: TokenPricing }> = [
  {
    pattern: /deepseek(-v4(\.1)?)?-flash/i,
    pricing: {
      label: "deepseek-flash",
      inputCacheMissPerMillion: 0.3,
      inputCacheHitPerMillion: 0.006,
      outputPerMillion: 1.2,
      offPeakMultiplier: 0.5,
    },
  },
  {
    pattern: /deepseek(-v4)?-pro/i,
    pricing: {
      label: "deepseek-v4-pro",
      inputCacheMissPerMillion: 1.32,
      inputCacheHitPerMillion: 0.044,
      outputPerMillion: 3.96,
      offPeakMultiplier: 0.5,
    },
  },
];

export function builtInPricing(model?: string): TokenPricing | undefined {
  if (!model) return undefined;
  return BUILT_IN_PRICING.find((entry) => entry.pattern.test(model))?.pricing;
}

/**
 * Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. Chinese
 * public holidays are off-peak as well but cannot be derived from a clock, so an
 * estimate on such a day errs on the high side.
 */
export function isPeakHour(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

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
  /** Input tokens served from the prompt cache. */
  cacheReadTokens?: number;
  /** Cost reported by the provider, in USD. */
  costUsd?: number;
  /** Overrides for the built-in table, USD per million tokens. */
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
  /** When the run happened, used to pick peak or off-peak pricing. */
  at?: Date;
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

function priceUsd(value: number): string {
  return value >= 0.1 ? `$${value.toFixed(2)}` : `$${String(value)}`;
}

type CostEstimate = { total: number; detail: string };

function estimateFromTable(
  input: UsageFooterInput,
  pricing: TokenPricing,
): CostEstimate | undefined {
  const peak = input.at ? isPeakHour(input.at) : true;
  const multiplier = peak ? 1 : pricing.offPeakMultiplier;

  const inputTokens = input.inputTokens ?? 0;
  const cached = Math.min(input.cacheReadTokens ?? 0, inputTokens);
  const fresh = Math.max(0, inputTokens - cached);
  const outputTokens = input.outputTokens ?? 0;

  const total =
    (cached / 1_000_000) * pricing.inputCacheHitPerMillion * multiplier +
    (fresh / 1_000_000) * pricing.inputCacheMissPerMillion * multiplier +
    (outputTokens / 1_000_000) * pricing.outputPerMillion * multiplier;

  if (!(total > 0)) return undefined;

  const rates = [
    `${priceUsd(pricing.inputCacheMissPerMillion * multiplier)}/M input`,
    `${priceUsd(pricing.outputPerMillion * multiplier)}/M output`,
  ];
  if (cached > 0) {
    rates.unshift(`${priceUsd(pricing.inputCacheHitPerMillion * multiplier)}/M cached`);
  }

  return {
    total,
    detail: `Estimated cost: ≈${formatUsd(total)} (${pricing.label}${peak ? "" : ", off-peak"}: ${rates.join(", ")})`,
  };
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

  const manualIn = input.priceInputPerMillion;
  const manualOut = input.priceOutputPerMillion;
  if (typeof manualIn === "number" || typeof manualOut === "number") {
    const total =
      ((input.inputTokens ?? 0) / 1_000_000) * (manualIn ?? 0) +
      ((input.outputTokens ?? 0) / 1_000_000) * (manualOut ?? 0);
    if (total > 0) {
      const rates = [
        typeof manualIn === "number" ? `$${manualIn}/M input` : "",
        typeof manualOut === "number" ? `$${manualOut}/M output` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return {
        summary: `≈${formatUsd(total)}`,
        detail: `Estimated cost: ≈${formatUsd(total)} (${rates})`,
      };
    }
  }

  const pricing = builtInPricing(input.model);
  if (!pricing) return undefined;
  const estimate = estimateFromTable(input, pricing);
  if (!estimate) return undefined;

  return {
    summary: `≈${formatUsd(estimate.total)}`,
    detail: estimate.detail,
  };
}

/**
 * Build the `<details>` block. Returns undefined when there is nothing worth
 * showing — a run with no model and no token counts would only add noise.
 */
export function buildUsageFooter(input: UsageFooterInput): string | undefined {
  const model =
    input.provider && input.model
      ? `${input.provider}/${input.model}`
      : input.model || input.provider;
  const totalTokens =
    input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0);

  if (!model && totalTokens <= 0) return undefined;

  const cost = costLine(input);
  const summaryParts = ["Run details"];
  if (input.durationMs !== undefined) {
    summaryParts.push(formatMinutes(input.durationMs));
  }
  if (totalTokens > 0) {
    summaryParts.push(`${formatTokenCount(totalTokens)} tokens`);
  }
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
