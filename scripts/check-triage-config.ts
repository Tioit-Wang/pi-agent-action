#!/usr/bin/env bun
/**
 * Check a triage configuration before it reaches the agent.
 *
 * Two layers, both required:
 *   1. structure — the file must satisfy the policy (a `bug` type label, a named
 *      duplicate label, unique names, no trigger label, sane thresholds).
 *   2. repository — every label the file mentions must exist on the repository,
 *      because GitHub rejects an unknown label at write time.
 *
 * Usage:
 *   bun run scripts/check-triage-config.ts --config .github/pi-triage.yml
 *   bun run scripts/check-triage-config.ts --config .github/pi-triage.yml \
 *     --repo owner/name
 *
 * Without `--repo` only the structural pass runs, which is what a pull request
 * check should do. With `--repo` a token is read from GITHUB_TOKEN or GH_TOKEN.
 */

import { readFileSync } from "node:fs";
import {
  missingRepoLabels,
  validateTriageConfig,
  type TriageConfigProblem,
} from "../src/triage/config";

type Args = {
  config: string;
  repo?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { config: ".github/pi-triage.yml" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") args.config = argv[++i] ?? args.config;
    else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: check-triage-config.ts [--config path] [--repo owner/name]",
      );
      process.exit(0);
    }
  }
  return args;
}

async function fetchRepoLabels(repo: string): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const names: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/labels?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `GET /repos/${repo}/labels failed: ${response.status} ${response.statusText}`,
      );
    }
    const page_labels = (await response.json()) as Array<{ name: string }>;
    names.push(...page_labels.map((label) => label.name));
    if (page_labels.length < 100) break;
  }
  return names;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(args.config, "utf8"));
  } catch (error) {
    console.error(`✗ cannot read ${args.config}: ${String(error)}`);
    process.exit(1);
  }

  const { config, problems } = validateTriageConfig(raw);
  const all: TriageConfigProblem[] = [...problems];

  if (config && args.repo) {
    try {
      const missing = missingRepoLabels(config, await fetchRepoLabels(args.repo));
      for (const name of missing) {
        all.push({
          field: "labels",
          message: `"${name}" is not a label of ${args.repo}`,
        });
      }
    } catch (error) {
      all.push({ field: "", message: String(error) });
    }
  }

  if (all.length > 0) {
    for (const problem of all) {
      console.error(
        problem.field ? `✗ ${problem.field}: ${problem.message}` : `✗ ${problem.message}`,
      );
    }
    console.error(
      `\n${all.length} problem(s) in ${args.config}${args.repo ? ` against ${args.repo}` : ""}.`,
    );
    process.exit(1);
  }

  const labelCount = config
    ? config.labels.type.options.length +
      config.labels.priority.options.length +
      (config.labels.state?.options.length ?? 0) +
      1
    : 0;
  console.log(
    `✓ ${args.config} is valid${args.repo ? ` against ${args.repo}` : ""} (${labelCount} labels).`,
  );
}

if (import.meta.main) {
  await main();
}
