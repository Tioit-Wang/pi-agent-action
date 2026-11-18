import { describe, expect, test } from "bun:test";
import {
  buildUsageFooter,
  formatTokenCount,
  isPeakHour,
} from "../src/github/operations/comments/usage-footer";

// 2026-11-17T07:00Z is a Tuesday: peak (06:00-10:00 UTC).
const PEAK = new Date("2026-11-17T07:00:00Z");
// 2026-11-17T12:00Z is outside both peak windows.
const OFF_PEAK = new Date("2026-11-17T12:00:00Z");
// 2026-11-21 is a Saturday.
const WEEKEND = new Date("2026-11-21T07:00:00Z");

describe("isPeakHour", () => {
  test("follows the DeepSeek peak windows in UTC", () => {
    expect(isPeakHour(PEAK)).toBe(true);
    expect(isPeakHour(new Date("2026-11-17T02:30:00Z"))).toBe(true);
    expect(isPeakHour(new Date("2026-11-17T09:59:00Z"))).toBe(true);
    expect(isPeakHour(new Date("2026-11-17T04:00:00Z"))).toBe(false);
    expect(isPeakHour(OFF_PEAK)).toBe(false);
    expect(isPeakHour(WEEKEND)).toBe(false);
  });
});

describe("built-in DeepSeek pricing", () => {
  test("charges flash cache-miss and output at peak rates", () => {
    const footer = buildUsageFooter({
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      at: PEAK,
    })!;

    // 1M × $0.30 + 1M × $1.20
    expect(footer).toContain("≈$1.50");
    expect(footer).toContain("deepseek-flash: $0.30/M input, $1.20/M output");
  });

  test("bills cached input at the cache-hit rate", () => {
    const footer = buildUsageFooter({
      model: "deepseek-flash",
      cacheReadTokens: 1_000_000,
      at: PEAK,
    })!;

    // 1M cached × $0.006
    expect(footer).toContain("≈$0.006");
    expect(footer).toContain("$0.006/M cached");
  });

  test("bills cache misses and cache hits separately", () => {
    const footer = buildUsageFooter({
      model: "deepseek-flash",
      inputTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
      outputTokens: 1_000_000,
      at: PEAK,
    })!;

    // 2M × $0.006 + 1M × $0.30 + 1M × $1.20
    expect(footer).toContain("≈$1.51");
    expect(footer).toContain("(1M input, 2M cached, 1M output)");
  });

  test("halves everything outside peak hours", () => {
    const footer = buildUsageFooter({
      model: "deepseek-flash",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      at: OFF_PEAK,
    })!;

    expect(footer).toContain("≈$0.75");
    expect(footer).toContain("off-peak");
    expect(footer).toContain("$0.15/M input, $0.60/M output");
  });

  test("prices v4-pro separately", () => {
    const footer = buildUsageFooter({
      model: "deepseek-v4-pro",
      outputTokens: 1_000_000,
      at: PEAK,
    })!;

    expect(footer).toContain("deepseek-v4-pro");
    expect(footer).toContain("$3.96/M output");
  });

  test("leaves unknown models without a cost", () => {
    const footer = buildUsageFooter({
      model: "gpt-4o",
      inputTokens: 1_000,
      at: PEAK,
    })!;

    expect(footer).not.toContain("cost");
  });
});

describe("formatTokenCount", () => {
  test("scales millions, thousands and small counts", () => {
    expect(formatTokenCount(1_290_000)).toBe("1.29M");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
    expect(formatTokenCount(84_000)).toBe("84k");
    expect(formatTokenCount(8_400)).toBe("8.4k");
    expect(formatTokenCount(512)).toBe("512");
    expect(formatTokenCount(0)).toBe("0");
  });
});
