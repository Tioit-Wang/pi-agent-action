import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  configuredLabels,
  missingRepoLabels,
  validateTriageConfig,
} from "../src/triage/config";

const root = join(import.meta.dir, "..");

function loadExample(): unknown {
  return Bun.YAML.parse(readFileSync(join(root, "examples/pi-triage.yml"), "utf8"));
}

type Mutable = {
  labels: {
    type: { options: Array<{ name: string; description: string }> };
    priority: { options: Array<{ name: string; description: string }> };
    state?: { options: Array<{ name: string; description: string }> };
  };
  duplicate: {
    label?: string;
    confidence?: number;
    candidates?: number;
    comment?: unknown;
  };
};

function example(): Mutable {
  return structuredClone(loadExample()) as Mutable;
}

describe("validateTriageConfig", () => {
  test("accepts the shipped example", () => {
    const { config, problems } = validateTriageConfig(loadExample());

    expect(problems).toEqual([]);
    expect(config?.duplicate.label).toBe("duplicate");
    expect(config?.duplicate.confidence).toBe(0.8);
  });

  test("requires a bug type label", () => {
    const raw = example();
    raw.labels.type.options = raw.labels.type.options.filter(
      (option) => option.name !== "bug",
    );

    const { problems } = validateTriageConfig(raw);

    expect(problems.map((problem) => problem.field)).toContain(
      "labels.type.options",
    );
    expect(problems.map((problem) => problem.message)).toContain(
      'must contain "bug"',
    );
  });

  test("rejects a blank duplicate label", () => {
    const raw = example();
    raw.duplicate.label = "  ";

    const { problems } = validateTriageConfig(raw);

    expect(problems.map((problem) => problem.field)).toContain("duplicate.label");
  });

  test("defaults the duplicate label when the section is absent", () => {
    const raw = example() as unknown as Record<string, unknown>;
    delete raw.duplicate;

    const { config, problems } = validateTriageConfig(raw);

    expect(problems).toEqual([]);
    expect(config?.duplicate.label).toBe("duplicate");
  });

  test("rejects a label defined twice", () => {
    const raw = example();
    raw.labels.priority.options.push({ name: "bug", description: "again" });

    const { problems } = validateTriageConfig(raw);

    expect(problems.map((problem) => problem.field)).toContain(
      "labels.priority.options",
    );
  });

  test("rejects the trigger label", () => {
    const raw = example();
    raw.labels.state!.options.push({ name: "pi", description: "trigger" });

    const { problems } = validateTriageConfig(raw);

    expect(problems.map((problem) => problem.message).join(" ")).toContain(
      "trigger label",
    );
  });
  test("requires a priority group", () => {
    const raw = example() as unknown as {
      labels: Record<string, unknown>;
    };
    delete raw.labels.priority;
    const { problems } = validateTriageConfig(raw);


    expect(problems.map((problem) => problem.field)).toContain("labels.priority");
  });

  test("rejects out-of-range thresholds", () => {
    const raw = example();
    raw.duplicate.confidence = 1.5;
    raw.duplicate.candidates = 42;

    const { problems } = validateTriageConfig(raw);

    const fields = problems.map((problem) => problem.field);
    expect(fields).toContain("duplicate.confidence");
    expect(fields).toContain("duplicate.candidates");
  });
});

describe("repository labels", () => {
  test("lists every label the config expects", () => {
    const { config } = validateTriageConfig(loadExample());

    expect(configuredLabels(config!)).toEqual([
      "bug",
      "enhancement",
      "documentation",
      "question",
      "performance",
      "security",
      "P0",
      "P1",
      "P2",
      "P3",
      "needs-info",
      "duplicate",
    ]);
  });

  test("reports missing labels, ignoring case", () => {
    const { config } = validateTriageConfig(loadExample());

    const missing = missingRepoLabels(config!, [
      "bug",
      "enhancement",
      "documentation",
      "question",
      "needs-info",
      "duplicate",
      "p0",
      "p1",
      "P2",
      "P3",
    ]);

    expect(missing).toEqual(["performance", "security"]);
  });
});

describe("check-triage-config script", () => {
  test("passes on the shipped example", () => {
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "run",
        join(root, "scripts/check-triage-config.ts"),
        "--config",
        join(root, "examples/pi-triage.yml"),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("is valid");
  });

  test("fails on a config without a bug label", () => {
    const broken = join(import.meta.dir, "tmp-broken-triage.yml");
    const raw = example();
    raw.labels.type.options = raw.labels.type.options.filter(
      (option) => option.name !== "bug",
    );
    require("node:fs").writeFileSync(
      broken,
      Bun.YAML.stringify(raw as never),
      "utf8",
    );

    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "run",
        join(root, "scripts/check-triage-config.ts"),
        "--config",
        broken,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("must contain \"bug\"");
  });
});
