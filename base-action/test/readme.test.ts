import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const actionMetadata = readFileSync(
  new URL("../action.yml", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("base action README", () => {
  test("should document every input declared in the action metadata", () => {
    const inputMetadata = actionMetadata.match(
      /^inputs:\n([\s\S]*?)^outputs:/m,
    )?.[1];
    const inputReference = readme.match(
      /^## Inputs\n([\s\S]*?)^## Outputs/m,
    )?.[1];

    expect(inputMetadata).toBeDefined();
    expect(inputReference).toBeDefined();

    const declaredInputs = [
      ...(inputMetadata?.matchAll(/^  ([a-z0-9_]+):$/gm) ?? []),
    ].map((match) => match[1]);
    const documentedInputs = [
      ...(inputReference?.matchAll(/^\| `([^`]+)`/gm) ?? []),
    ].map((match) => match[1]);

    expect(documentedInputs).toEqual(declaredInputs);
  });

  test("should not use removed legacy inputs in workflow examples", () => {
    // Pi restores model, max_turns and the tool lists as first-class inputs; what
    // this fork removed are the Anthropic-only provider and plugin inputs.
    const removedInputs = [
      "anthropic_api_key",
      "claude_code_oauth_token",
      "anthropic_federation_rule_id",
      "anthropic_organization_id",
      "anthropic_service_account_id",
      "anthropic_workspace_id",
      "anthropic_oidc_audience",
      "use_bedrock",
      "use_vertex",
      "use_foundry",
      "claude_args",
      "plugins",
      "plugin_marketplaces",
      "path_to_claude_code_executable",
    ];

    for (const input of removedInputs) {
      expect(readme).not.toMatch(new RegExp(`^\\s+${input}:`, "m"));
    }
  });
});
