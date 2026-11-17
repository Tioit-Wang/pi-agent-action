#!/usr/bin/env bun

import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import { preparePrompt } from "./prepare-prompt";
import { runPi } from "./pi/run";
import { parsePiOptions } from "./pi/options";
import { bootstrapPiProvider } from "./pi/provider";
import { setupPiSettings } from "./setup-pi-settings";
import { validatePiEnvironment } from "./validate-env";
import { setExecutionFileOutputIfPresent } from "./execution-file";

async function run() {
  // Bun has read this by now, and it's only for the action's own script
  delete process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;

  try {
    const providerInput = {
      provider: process.env.PI_PROVIDER,
      model: process.env.PI_MODEL,
      baseUrl: process.env.PI_BASE_URL,
      apiKey: process.env.PI_API_KEY,
      apiStyle: process.env.PI_API_STYLE,
      agentDir: process.env.PI_CODING_AGENT_DIR,
    };

    // Fail before touching the network or the filesystem when the workflow has
    // no usable credential: a CI job must never wait on an interactive login.
    validatePiEnvironment({
      provider: providerInput.provider,
      model: providerInput.model,
      baseUrl: providerInput.baseUrl,
      apiKey: providerInput.apiKey,
    });

    const provider = await bootstrapPiProvider({
      provider: providerInput.provider,
      model: providerInput.model,
      baseUrl: providerInput.baseUrl,
      apiKey: providerInput.apiKey,
      api: providerInput.apiStyle,
      agentDir: providerInput.agentDir,
    });

    await setupPiSettings(process.env.INPUT_SETTINGS, provider.agentDir);

    const promptConfig = await preparePrompt({
      prompt: process.env.INPUT_PROMPT || "",
      promptFile: process.env.INPUT_PROMPT_FILE || "",
    });
    const promptText = await readFile(promptConfig.path, "utf-8");

    const parsed = parsePiOptions({
      piArgs: process.env.INPUT_PI_ARGS,
      provider: providerInput.provider,
      model: providerInput.model,
      allowedTools: process.env.INPUT_ALLOWED_TOOLS,
      disallowedTools: process.env.INPUT_DISALLOWED_TOOLS,
      maxTurns: process.env.INPUT_MAX_TURNS,
      systemPrompt: process.env.INPUT_SYSTEM_PROMPT,
      appendSystemPrompt: process.env.INPUT_APPEND_SYSTEM_PROMPT,
      noTools: process.env.INPUT_NO_TOOLS === "true",
      approveProject: process.env.INPUT_TRUST_PROJECT_FILES === "true",
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    });

    const result = await runPi({
      promptPath: promptConfig.path,
      promptText,
      parsed,
      env: provider.env,
      piExecutable: process.env.INPUT_PATH_TO_PI_EXECUTABLE,
      jsonSchema: process.env.INPUT_JSON_SCHEMA,
    });

    // Set outputs for the standalone base-action
    core.setOutput("conclusion", result.conclusion);
    if (result.executionFile) {
      core.setOutput("execution_file", result.executionFile);
    }
    if (result.sessionId) {
      core.setOutput("session_id", result.sessionId);
    }
    if (result.structuredOutput) {
      core.setOutput("structured_output", result.structuredOutput);
    }
  } catch (error) {
    setExecutionFileOutputIfPresent();
    core.setFailed(`Action failed with error: ${error}`);
    core.setOutput("conclusion", "failure");
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
