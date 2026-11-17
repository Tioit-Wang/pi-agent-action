import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMcpConfig, writePiMcpConfig } from "../src/pi/mcp";

const stdioEntry = {
  command: "bun",
  args: ["/action/src/mcp/github-comment-server.ts"],
  env: { GITHUB_TOKEN: "ghs_test", REPO_OWNER: "o", REPO_NAME: "r" },
};

describe("parseMcpConfig", () => {
  test("returns nothing for empty input", () => {
    expect(parseMcpConfig(undefined)).toEqual({ servers: {}, skipped: [] });
    expect(parseMcpConfig("  ")).toEqual({ servers: {}, skipped: [] });
  });

  test("keeps stdio and http entries unchanged", () => {
    const { servers, skipped } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          github_comment: stdioEntry,
          docs: { url: "https://example.com/mcp", headers: { a: "b" } },
        },
      }),
    );
    expect(Object.keys(servers)).toEqual(["github_comment", "docs"]);
    expect(servers.github_comment).toEqual(stdioEntry);
    expect(skipped).toEqual([]);
  });

  test("drops entries Pi cannot use", () => {
    const { servers, skipped } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          good: stdioEntry,
          "bad name": stdioEntry,
          legacy: { type: "sse", url: "https://example.com/sse" },
          empty: { env: {} },
          notObject: "nope",
        },
      }),
    );
    expect(Object.keys(servers)).toEqual(["good"]);
    expect(skipped).toEqual(["bad name", "legacy", "empty", "notObject"]);
  });

  test("tolerates a document without mcpServers", () => {
    expect(parseMcpConfig(JSON.stringify({ other: 1 }))).toEqual({
      servers: {},
      skipped: [],
    });
  });

  test("rejects malformed JSON with a clear message", () => {
    expect(() => parseMcpConfig("{oops")).toThrow(
      /MCP configuration is not valid JSON/,
    );
  });
});

describe("writePiMcpConfig", () => {
  test("writes mcpServers into the agent directory", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const result = await writePiMcpConfig(
      agentDir,
      JSON.stringify({ mcpServers: { github_comment: stdioEntry } }),
    );

    expect(result.servers).toEqual(["github_comment"]);
    expect(result.skipped).toEqual([]);
    const written = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8"));
    expect(written.mcpServers.github_comment).toEqual(stdioEntry);
  });

  test("keeps unrelated servers that are already configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { mine: { command: "node" } }, note: "keep" }),
    );

    await writePiMcpConfig(
      agentDir,
      JSON.stringify({ mcpServers: { github_comment: stdioEntry } }),
    );

    const written = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8"));
    expect(Object.keys(written.mcpServers).sort()).toEqual([
      "github_comment",
      "mine",
    ]);
    expect(written.note).toBe("keep");
  });

  test("the action's entry replaces an entry with the same name", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { github_comment: { command: "stale" } } }),
    );

    await writePiMcpConfig(
      agentDir,
      JSON.stringify({ mcpServers: { github_comment: stdioEntry } }),
    );

    const written = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8"));
    expect(written.mcpServers.github_comment.command).toBe("bun");
  });

  test("writes no file when nothing is usable", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
    const result = await writePiMcpConfig(
      agentDir,
      JSON.stringify({ mcpServers: { legacy: { type: "sse", url: "x" } } }),
    );

    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual(["legacy"]);
    expect(() => readFileSync(join(agentDir, "mcp.json"), "utf-8")).toThrow();
  });
});
