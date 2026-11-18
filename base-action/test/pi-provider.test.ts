import { describe, expect, test } from "bun:test";
import { buildModelsJson, resolveThinkingFormat } from "../src/pi/provider";

/** The single `deepseek` model entry a generated document must carry. */
function modelEntry(json: Record<string, unknown>): Record<string, unknown> {
  const providers = json.providers as Record<
    string,
    { models: Record<string, unknown>[] }
  >;
  const provider = providers.deepseek;
  if (!provider) throw new Error("deepseek provider missing from models.json");
  const entry = provider.models[0];
  if (!entry) throw new Error("deepseek has no model entry");
  return entry;
}

describe("buildModelsJson", () => {
  const base = {
    provider: "deepseek",
    baseUrl: "https://platform.example/v1",
    api: "openai-completions",
    model: "deepseek-v4.1-flash",
  };

  test("declares the model as reasoning-capable when asked", () => {
    const entry = modelEntry(buildModelsJson({ ...base, reasoning: true }));

    expect(entry).toMatchObject({ id: "deepseek-v4.1-flash", reasoning: true });
  });

  test("leaves the model without reasoning support when thinking is off", () => {
    const entry = modelEntry(buildModelsJson({ ...base, reasoning: false }));

    expect(entry).not.toHaveProperty("reasoning");
  });

  test("writes the thinking wire format only when one was resolved", () => {
    const withFormat = modelEntry(
      buildModelsJson({ ...base, thinkingFormat: "deepseek" }),
    );
    const withoutFormat = modelEntry(buildModelsJson(base));

    expect(withFormat).toMatchObject({ thinkingFormat: "deepseek" });
    expect(withoutFormat).not.toHaveProperty("thinkingFormat");
  });
});

describe("resolveThinkingFormat", () => {
  test("maps a deepseek model behind an unknown gateway", () => {
    expect(resolveThinkingFormat({ provider: "deepseek" })).toBe("deepseek");
    expect(resolveThinkingFormat({ model: "deepseek-v4.1-flash" })).toBe(
      "deepseek",
    );
    expect(
      resolveThinkingFormat({ baseUrl: "https://gateway.example/deepseek/v1" }),
    ).toBe("deepseek");
  });

  test("stays out of the way for providers Pi can detect itself", () => {
    expect(
      resolveThinkingFormat({ provider: "openai", model: "gpt-4o" }),
    ).toBeUndefined();
    expect(resolveThinkingFormat({})).toBeUndefined();
  });
});
