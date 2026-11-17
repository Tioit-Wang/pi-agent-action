#!/usr/bin/env bun

/**
 * Unified entrypoint for the Claude Code Action.
 * Merges all previously separate action.yml steps (prepare, install, run, cleanup)
 * into a single TypeScript orchestrator.
 */

import * as core from "@actions/core";
import { dirname } from "path";
import { spawn } from "child_process";
import { appendFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { setupGitHubToken, WorkflowValidationSkipError } from "../github/token";
import {
  checkBotActorPullRequestAuthor,
  checkWritePermissions,
} from "../github/validation/permissions";
import {
  getUntrustedPrDisallowedTools,
  UNTRUSTED_PR_EXCLUDED_PI_TOOLS,
} from "../github/validation/untrusted-pr";
import { createOctokit } from "../github/api/client";
import type { Octokits } from "../github/api/client";
import {
  parseGitHubContext,
  isEntityContext,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
  isWorkflowRunEvent,
} from "../github/context";
import type { GitHubContext } from "../github/context";
import { detectMode } from "../modes/detector";
import { prepareTagMode } from "../modes/tag";
import { prepareAgentMode } from "../modes/agent";
import { checkContainsTrigger } from "../github/validation/trigger";
import {
  clearSessionState,
  disableGitPrograms,
  prepareGitForSession,
  snapshotSessionFiles,
} from "../github/operations/session-guard";
import { restoreConfigFromBase } from "../github/operations/restore-config";
import { restoreToolConfigFromBase } from "../github/operations/tool-config";
import { validateBranchName } from "../github/operations/branch";
import { collectActionInputsPresence } from "./collect-inputs";
import { updateCommentLink } from "./update-comment-link";
import { buildOutcomeNotice } from "../github/operations/comments/agent-answer";
import { buildUsageFooter } from "../github/operations/comments/usage-footer";
import { createJobRunLink } from "../github/operations/comments/common";
import {
  buildProgressBody,
  createProgressPublisher,
} from "../github/operations/comments/progress";
import { formatPiReport } from "../../base-action/src/pi/report";
import type { PiEvent } from "../../base-action/src/pi/events";
import { redactSecrets } from "../github/utils/sanitizer";
// Base-action imports (used directly instead of subprocess)
import { validatePiEnvironment } from "../../base-action/src/validate-env";
import { setupPiSettings } from "../../base-action/src/setup-pi-settings";
import { preparePrompt } from "../../base-action/src/prepare-prompt";
import { runPi } from "../../base-action/src/pi/run";
import type { PiRunResult } from "../../base-action/src/pi/run";
import { parsePiOptions } from "../../base-action/src/pi/options";
import { bootstrapPiProvider } from "../../base-action/src/pi/provider";
import { writePiMcpConfig } from "../../base-action/src/pi/mcp";
import { setExecutionFileOutputIfPresent } from "../../base-action/src/execution-file";

/** Optional USD-per-million price, used to estimate a run's cost. */
function parsePrice(raw?: string): number | undefined {
  const value = Number.parseFloat((raw ?? "").trim());
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Exported for unit testing. `set -o pipefail` makes the package manager's
// non-zero exit propagate through the pipe so the retry logic actually
// triggers on a transient registry failure.
export function buildInstallCommand(version: string): string {
  return `set -o pipefail; npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${version}`;
}

/**
 * Install the Pi CLI, handling retry logic and custom executable paths.
 * Returns the executable (or its absolute path when one was supplied).
 */
async function installPi(): Promise<string> {
  const customExecutable = process.env.PATH_TO_PI_EXECUTABLE;
  if (customExecutable) {
    if (/[\x00-\x1f\x7f]/.test(customExecutable)) {
      throw new Error(
        "PATH_TO_PI_EXECUTABLE contains control characters (e.g. newlines), which is not allowed",
      );
    }
    console.log(`Using custom Pi executable: ${customExecutable}`);
    const piDir = dirname(customExecutable);
    const githubPath = process.env.GITHUB_PATH;
    if (githubPath) {
      await appendFile(githubPath, `${piDir}\n`);
    }
    process.env.PATH = `${piDir}:${process.env.PATH}`;
    return customExecutable;
  }

  const piVersion = "1.5.0";
  console.log(`Installing Pi v${piVersion}...`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Installation attempt ${attempt}...`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "bash",
          ["-c", buildInstallCommand(piVersion)],
          { stdio: "inherit" },
        );
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Install failed with exit code ${code}`));
        });
        child.on("error", reject);
      });
      console.log("Pi installed successfully");
      return "pi";
    } catch (error) {
      if (attempt === 3) {
        throw new Error(`Failed to install Pi after 3 attempts: ${error}`);
      }
      console.log("Installation failed, retrying...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error("unreachable");
}

/**
 * Write the step summary from the Pi execution output file.
 */
async function writeStepSummary(executionFile: string): Promise<void> {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  try {
    const events = JSON.parse(readFileSync(executionFile, "utf-8")) as PiEvent[];
    await appendFile(summaryFile, formatPiReport(events));
    console.log("Successfully formatted Pi agent report");
  } catch (error) {
    console.error(`Failed to format output: ${error}`);
    // Fall back to raw JSON
    try {
      let fallback = "## Pi Agent Report (Raw Output)\n\n";
      fallback +=
        "Failed to format output (please report). Here's the raw JSON:\n\n";
      fallback += "```json\n";
      fallback += redactSecrets(readFileSync(executionFile, "utf-8"));
      fallback += "\n```\n";
      await appendFile(summaryFile, fallback);
    } catch {
      console.error("Failed to write raw output to step summary");
    }
  }
}

async function run() {
  // Bun has read this by now, and it's only for the action's own scripts
  delete process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;

  let githubToken: string | undefined;
  let commentId: number | undefined;
  let claudeBranch: string | undefined;
  let baseBranch: string | undefined;
  let executionFile: string | undefined;
  let claudeSuccess = false;
  // Final assistant text, posted in place of the placeholder comment body.
  let agentAnswer: string | undefined;
  let prepareSuccess = true;
  let prepareError: string | undefined;
  // A cancelled job or the job timeout stops Pi early. Remember it so the comment
  // says so instead of leaving the "Pi is working…" spinner running forever.
  let runCancelled = false;
  let runError: string | undefined;
  let runStartedAt: number | undefined;
  let usageFooter: string | undefined;
  const abortRun = new AbortController();
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => {
      if (abortRun.signal.aborted) return;
      core.warning(
        `Received ${signal}; stopping Pi and publishing what it produced.`,
      );
      abortRun.abort();
    };
    process.on(signal, handler);
    signalHandlers.push([signal, handler]);
  }
  let context: GitHubContext | undefined;
  let octokit: Octokits | undefined;
  // Paths reverted to the PR base branch, which cleanup must not commit back
  // onto the PR author's branch. Empty unless restoreConfigFromBase ran.
  let restoredConfigPaths: string[] = [];
  // Track whether we've completed prepare phase, so we can attribute errors correctly
  let prepareCompleted = false;
  try {
    // Phase 1: Prepare
    const actionInputsPresent = collectActionInputsPresence();
    context = parseGitHubContext();
    const modeName = detectMode(context);
    console.log(
      `Auto-detected mode: ${modeName} for event: ${context.eventName}`,
    );

    try {
      githubToken = await setupGitHubToken();
    } catch (error) {
      if (error instanceof WorkflowValidationSkipError) {
        core.setOutput("skipped_due_to_workflow_validation_mismatch", "true");
        console.log("Exiting due to workflow validation skip");
        return;
      }
      throw error;
    }

    octokit = createOctokit(githubToken);

    // Set GITHUB_TOKEN and GH_TOKEN in process env for downstream usage
    process.env.GITHUB_TOKEN = githubToken;
    process.env.GH_TOKEN = githubToken;

    // Check write permissions for entity contexts, and for workflow_run
    // events, whose upstream run may have been started by an actor without
    // write access (e.g. the author of a fork pull request)
    if (isEntityContext(context) || isWorkflowRunEvent(context)) {
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        !!process.env.OVERRIDE_GITHUB_TOKEN,
      );
      if (!hasWritePermissions) {
        // Someone without write access asked for a run. Ignore it: no comment,
        // no failing job, nothing for them to react to.
        core.info(
          `${context.actor} does not have write access to this repository; ignoring the request.`,
        );
        core.setOutput("conclusion", "skipped");
        core.setOutput("github_token", githubToken);
        return;
      }
    }

    // Check trigger conditions
    const containsTrigger =
      modeName === "tag"
        ? isEntityContext(context) && checkContainsTrigger(context)
        : !!context.inputs?.prompt;
    console.log(`Mode: ${modeName}`);
    console.log(`Context prompt: ${context.inputs?.prompt || "NO PROMPT"}`);
    console.log(`Trigger result: ${containsTrigger}`);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      core.setOutput("github_token", githubToken);
      return;
    }

    const botActorAllowed = await checkBotActorPullRequestAuthor(
      octokit.rest,
      context,
      context.inputs.allowedNonWriteUsers,
      !!process.env.OVERRIDE_GITHUB_TOKEN,
    );
    if (!botActorAllowed) {
      // The bot itself is allowed, but the pull request it acted on comes from
      // someone without write access. Treat it like any other unauthorized
      // mention and stay quiet.
      core.info(
        `${context.actor} acted on a pull request whose author does not have write access; ignoring the request.`,
      );
      core.setOutput("conclusion", "skipped");
      core.setOutput("github_token", githubToken);
      return;
    }

    // Run prepare
    // Commands that run checkout code are denied on PRs from authors without write
    // access. Hooks go off here, before the action checks out such a PR's head, and
    // keep running for trusted authors, whose repositories may rely on them.
    const untrustedPrDisallowedTools = isEntityContext(context)
      ? await getUntrustedPrDisallowedTools(octokit.rest, context)
      : [];
    const hooksOff = untrustedPrDisallowedTools.length > 0;
    disableGitPrograms({ hooks: hooksOff });
    clearSessionState();

    console.log(
      `Preparing with mode: ${modeName} for event: ${context.eventName}`,
    );
    const prepareResult =
      modeName === "tag"
        ? await prepareTagMode({ context, octokit, githubToken })
        : await prepareAgentMode({ context, octokit, githubToken });

    commentId = prepareResult.commentId;

    // GitHub uploads job logs only after the job ends, so the tracking comment is
    // the only channel a reader can watch while Pi works.
    const progressCommentId = commentId;
    const progressOctokit = octokit;
    const repository = context.repository;
    const reportProgress =
      context.inputs.progressUpdates !== false && progressOctokit && progressCommentId
        ? createProgressPublisher({
            post: async (body) => {
              await progressOctokit.rest.issues.updateComment({
                owner: repository.owner,
                repo: repository.repo,
                comment_id: progressCommentId,
                body,
              });
            },
            build: (update) =>
              buildProgressBody(
                update,
                createJobRunLink(
                  repository.owner,
                  repository.repo,
                  process.env.GITHUB_RUN_ID ?? "",
                ),
              ),
            log: (message) => core.info(message),
          })
        : undefined;
    claudeBranch = prepareResult.branchInfo.claudeBranch;
    baseBranch = prepareResult.branchInfo.baseBranch;
    prepareCompleted = true;

    // Phase 2: Install Claude Code CLI
    // Phase 2: install the Pi CLI and prepare its provider configuration
    const piExecutable = await installPi();
    const providerConfig = await bootstrapPiProvider({
      provider: process.env.PI_PROVIDER,
      model: process.env.PI_MODEL,
      baseUrl: process.env.PI_BASE_URL,
      apiKey: process.env.PI_API_KEY,
      api: process.env.PI_API_STYLE,
      agentDir: process.env.PI_CODING_AGENT_DIR,
    });
    const agentDir = providerConfig.agentDir;
    const providerEnv = providerConfig.env;

    // Publish the GitHub MCP servers to Pi's agent directory. Pi connects every
    // server listed there at session start; it has no --mcp-config equivalent.
    await writePiMcpConfig(agentDir, prepareResult.mcpConfig);

    // Phase 3: Run Claude (import base-action directly)
    // Set env vars needed by the base-action code
    process.env.INPUT_ACTION_INPUTS_PRESENT = actionInputsPresent;
    process.env.PI_AGENT_ACTION = "1";
    process.env.DETAILED_PERMISSION_MESSAGES = "1";

    validatePiEnvironment({
      provider: process.env.PI_PROVIDER,
      model: process.env.PI_MODEL,
      baseUrl: process.env.PI_BASE_URL,
      apiKey: process.env.PI_API_KEY,
    });

    // Tag mode sets claudeBranch only when it branched from the base instead of
    // checking out the PR's head, as for a closed or merged PR.
    const checkedOutPrHead = modeName !== "tag" || !claudeBranch;
    const isUntrustedCheckout =
      checkedOutPrHead && untrustedPrDisallowedTools.length > 0;
    let restoredToolConfig: string[] = [];

    // On PRs, .claude/ and .mcp.json in the checkout are attacker-controlled.
    // Restore them from the base branch before the CLI reads them.
    //
    // We read pull_request.base.ref from the payload directly because agent
    // mode's branchInfo.baseBranch defaults to the repo's default branch rather
    // than the PR's actual target (agent/index.ts). For issue_comment on a PR the payload
    // lacks base.ref, so we fall back to the mode-provided value — tag mode
    // fetches it from GraphQL; agent mode on issue_comment is an edge case
    // that at worst restores from the wrong trusted branch (still secure).
    if (isEntityContext(context) && context.isPR) {
      let restoreBase = baseBranch;
      if (
        isPullRequestEvent(context) ||
        isPullRequestReviewEvent(context) ||
        isPullRequestReviewCommentEvent(context)
      ) {
        restoreBase = context.payload.pull_request.base.ref;
        validateBranchName(restoreBase);
      }
      if (restoreBase) {
        restoredConfigPaths = restoreConfigFromBase(restoreBase);
        // Before plugins are installed, which can already start package managers here.
        if (isUntrustedCheckout) {
          restoredToolConfig = restoreToolConfigFromBase(restoreBase);
          restoredConfigPaths.push(...restoredToolConfig);
        }
      }
    }

    await setupPiSettings(process.env.INPUT_SETTINGS, agentDir);


    const promptFile =
      process.env.INPUT_PROMPT_FILE ||
      `${process.env.RUNNER_TEMP}/pi-prompts/pi-prompt.txt`;
    const promptConfig = await preparePrompt({
      prompt: "",
      promptFile,
    });
    const promptText = readFileSync(promptConfig.path, "utf-8");

    // Passed separately because text added to claudeArgs can be lost: a comment at
    // the end of the user's claude_args would swallow it.
    // Pi has no per-command deny patterns, so an untrusted checkout loses the
    // tools that can execute or mutate anything instead of matching rules.
    const disallowedTools = isUntrustedCheckout
      ? [...UNTRUSTED_PR_EXCLUDED_PI_TOOLS]
      : [];


    const restoreSessionFiles = snapshotSessionFiles(() =>
      prepareGitForSession({ hooks: hooksOff }),
    );

    let piResult: PiRunResult;
    runStartedAt = Date.now();
    const parsedPiOptions = parsePiOptions({
      // Mode-generated Claude flags (--allowedTools, --mcp-config, ...) are not
      // valid Pi arguments, so only the workflow's own pi_args reach the CLI.
      piArgs: process.env.INPUT_PI_ARGS,
      provider: process.env.PI_PROVIDER,
      model: process.env.PI_MODEL,
      allowedTools: process.env.INPUT_ALLOWED_TOOLS,
      disallowedTools: disallowedTools.join(","),
      appendSystemPrompt: process.env.APPEND_SYSTEM_PROMPT,
      maxTurns: process.env.INPUT_MAX_TURNS,
      // Project-local `.pi/` configuration is attacker-controlled on an
      // untrusted checkout, so trust is granted only to trusted authors.
      approveProject: !isUntrustedCheckout,
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    });
    try {
      piResult = await runPi({
        promptPath: promptConfig.path,
        promptText,
        parsed: parsedPiOptions,
        env: providerEnv,
        piExecutable,
        jsonSchema: process.env.INPUT_JSON_SCHEMA,
        signal: abortRun.signal,
        onProgress: reportProgress,
      });
    } finally {
      restoreSessionFiles();
      // The action's own git commands from here on hold the job's credentials,
      // and the session could have edited a tracked hook.
      disableGitPrograms({ hooks: true });
      // Revoking the app token depends on this output, and a session can write it.
      core.setOutput("skipped_due_to_workflow_validation_mismatch", "false");
    }

    agentAnswer = piResult.finalText;
    claudeSuccess = piResult.conclusion === "success";
    executionFile = piResult.executionFile;
    runError = piResult.error;
    runCancelled = piResult.cancelled === true;

    // The run details footer: executor, model, duration, tokens, cost.
    usageFooter =
      context.inputs.usageFooter === false
        ? undefined
        : buildUsageFooter({
            provider: process.env.PI_PROVIDER,
            model: process.env.PI_MODEL,
            ...(runStartedAt !== undefined
              ? { durationMs: Date.now() - runStartedAt }
              : {}),
            ...(piResult.numTurns !== undefined ? { turns: piResult.numTurns } : {}),
            ...(piResult.usage ? { inputTokens: piResult.usage.input } : {}),
            ...(piResult.usage ? { outputTokens: piResult.usage.output } : {}),
            ...(piResult.usage ? { totalTokens: piResult.usage.totalTokens } : {}),
            ...(piResult.usage ? { costUsd: piResult.usage.cost } : {}),
            ...(piResult.usage
              ? { cacheReadTokens: piResult.usage.cacheRead }
              : {}),
            at: new Date(),
            ...(parsePrice(process.env.INPUT_PRICE_INPUT_PER_MILLION) !== undefined
              ? {
                  priceInputPerMillion: parsePrice(
                    process.env.INPUT_PRICE_INPUT_PER_MILLION,
                  ),
                }
              : {}),
            ...(parsePrice(process.env.INPUT_PRICE_OUTPUT_PER_MILLION) !== undefined
              ? {
                  priceOutputPerMillion: parsePrice(
                    process.env.INPUT_PRICE_OUTPUT_PER_MILLION,
                  ),
                }
              : {}),
          });

    // A failed run still has to say something: the placeholder reads as "still
    // working" long after the job is gone, which is the worst possible answer.
    if (!claudeSuccess && !agentAnswer) {
      agentAnswer = buildOutcomeNotice({
        ...(runCancelled ? { cancelled: true } : {}),
        ...(piResult.numTurns !== undefined ? { turns: piResult.numTurns } : {}),
        ...(runStartedAt !== undefined
          ? { durationMs: Date.now() - runStartedAt }
          : {}),
        ...(runError ? { reason: runError } : {}),
      });
    }
    if (!claudeSuccess) {
      core.setFailed(runError ?? "Pi did not finish the run");
    }

    // Set action-level outputs
    if (piResult.executionFile) {
      core.setOutput("execution_file", piResult.executionFile);
    }
    if (piResult.sessionId) {
      core.setOutput("session_id", piResult.sessionId);
    }
    if (piResult.structuredOutput) {
      core.setOutput("structured_output", piResult.structuredOutput);
    }
    core.setOutput("conclusion", piResult.conclusion);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    executionFile ??= setExecutionFileOutputIfPresent();
    // Only mark as prepare failure if we haven't completed the prepare phase
    if (!prepareCompleted) {
      prepareSuccess = false;
      prepareError = errorMessage;
    }
    core.setFailed(`Action failed with error: ${redactSecrets(errorMessage)}`);
  } finally {
    // Phase 4: Cleanup (always runs)
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    clearSessionState();


    // Update tracking comment
    if (
      commentId &&
      context &&
      isEntityContext(context) &&
      githubToken &&
      octokit
    ) {
      try {
        await updateCommentLink({
          commentId,
          githubToken,
          claudeBranch,
          baseBranch: baseBranch || context.repository.default_branch || "main",
          triggerUsername: context.actor,
          context,
          octokit,
          claudeSuccess,
          agentAnswer,
          cancelled: runCancelled,
          usageFooter,
          outputFile: executionFile,
          prepareSuccess,
          prepareError,
          useCommitSigning: context.inputs.useCommitSigning,
          restoredConfigPaths,
        });
      } catch (error) {
        console.error("Error updating comment with job link:", error);
      }
    }

    // Write step summary (unless display_report is set to false)
    if (
      executionFile &&
      existsSync(executionFile) &&
      process.env.DISPLAY_REPORT !== "false"
    ) {
      await writeStepSummary(executionFile);
    }

    // Set remaining action-level outputs
    core.setOutput("branch_name", claudeBranch);
    core.setOutput("github_token", githubToken);
  }
}

if (import.meta.main) {
  run();
}
