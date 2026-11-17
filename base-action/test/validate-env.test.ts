#!/usr/bin/env bun

import { describe, test, expect, beforeEach } from "bun:test";
import { validatePiEnvironment } from "../src/validate-env";

describe("validatePiEnvironment", () => {
  beforeEach(() => {
    // Keep the assertions independent of whatever the runner exports.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.PI_API_KEY;
    delete process.env.PI_MODEL;
    delete process.env.PI_BASE_URL;
    delete process.env.PI_PROVIDER;
  });

  test("accepts an explicit model with an API key", () => {
    expect(() =>
      validatePiEnvironment({ model: "deepseek-chat", apiKey: "sk-test" }),
    ).not.toThrow();
  });

  test("accepts a provider whose environment variable is exported", () => {
    expect(() =>
      validatePiEnvironment({
        provider: "deepseek",
        model: "deepseek-chat",
        env: { DEEPSEEK_API_KEY: "sk-test" },
      }),
    ).not.toThrow();
  });

  test("rejects a run without a model", () => {
    expect(() => validatePiEnvironment({ apiKey: "sk-test", env: {} })).toThrow(
      /A model is required/,
    );
  });

  test("rejects a compatible endpoint without an api key", () => {
    expect(() =>
      validatePiEnvironment({
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com",
        env: {},
      }),
    ).toThrow(/base_url.*api_key/);
  });

  test("rejects a provider with no credential anywhere", () => {
    expect(() =>
      validatePiEnvironment({
        provider: "deepseek",
        model: "deepseek-chat",
        env: {},
      }),
    ).toThrow(/no credential is available/);
  });

  test("rejects a run with no provider, endpoint or credential", () => {
    expect(() => validatePiEnvironment({ model: "m", env: {} })).toThrow(
      /No provider credential found/,
    );
  });
});
