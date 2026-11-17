import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import { buildInstallCommand } from "../src/entrypoints/run";

describe("buildInstallCommand (regression for #1136)", () => {
  it("pins the published pi package version", () => {
    const cmd = buildInstallCommand("1.5.0");
    expect(cmd).toContain("@earendil-works/pi-coding-agent@1.5.0");
  });

  it("prefixes the command with `set -o pipefail`", () => {
    const cmd = buildInstallCommand("1.5.0");
    expect(cmd.startsWith("set -o pipefail;")).toBe(true);
  });

  it("installs from the registry instead of piping a remote script", () => {
    const cmd = buildInstallCommand("1.5.0");
    expect(cmd).toContain("npm install -g --ignore-scripts");
    expect(cmd).not.toContain("curl");
    expect(cmd).not.toContain("| bash");
  });
});

describe("pipefail semantics (proves the bug shape and the fix)", () => {
  // The install command keeps the job's exit status meaningful: npm must not be
  // hidden behind a pipe whose last command always succeeds.
  //
  // network access. No shell-escaping traps here: the version argument is
  // a numeric literal.
  const unreachable = "http://127.0.0.1:1/nope";
  const version = "2.1.114";

  it("BEFORE FIX: pipeline without pipefail swallows curl failure (exit 0)", () => {
    const buggy = `curl -fsSL ${unreachable} | bash -s -- ${version}`;
    const result = spawnSync("bash", ["-c", buggy], { stdio: "pipe" });
    expect(result.status).toBe(0);
  });

  it("AFTER FIX: buildInstallCommand (against unreachable host) exits non-zero", () => {
    const fixed = buildInstallCommand(version).replace(
      "https://claude.ai/install.sh",
      unreachable,
    );
    const result = spawnSync("bash", ["-c", fixed], { stdio: "pipe" });
    expect(result.status).not.toBe(0);
  });
});
