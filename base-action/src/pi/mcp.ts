/**
 * Publishes the action's GitHub MCP servers to Pi.
 *
 * `prepareMcpConfig` already produces Claude's `mcpServers` shape, which Pi
 * reads unchanged (docs/mcp.md in @earendil-works/pi-coding-agent: "Claude
 * Desktop, Claude Code, or Cursor — copy the existing mcpServers entry").
 *
 * Pi loads user-level servers from `<agent-dir>/mcp.json` at session start, so
 * the action writes there rather than passing `--mcp-config`, which Pi has no
 * equivalent for.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type McpServerEntry = Record<string, unknown>;
export type McpServers = Record<string, McpServerEntry>;

/** Pi accepts only these characters in a server name. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export type ParsedMcpConfig = {
  servers: McpServers;
  /** Names dropped because Pi would reject or ignore them. */
  skipped: string[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read `{ "mcpServers": { ... } }` and keep only entries Pi can connect to.
 * The legacy SSE transport is rejected by Pi, so it is dropped here instead of
 * failing the whole session.
 */
export function parseMcpConfig(configJson?: string): ParsedMcpConfig {
  const servers: McpServers = {};
  const skipped: string[] = [];
  if (!configJson?.trim()) return { servers, skipped };

  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch (error) {
    throw new Error(`MCP configuration is not valid JSON: ${error}`);
  }

  const container = asRecord(asRecord(parsed)?.mcpServers);
  if (!container) {
    return { servers, skipped };
  }

  for (const [name, rawEntry] of Object.entries(container)) {
    const entry = asRecord(rawEntry);
    const usable =
      entry !== undefined &&
      SERVER_NAME.test(name) &&
      entry.type !== "sse" &&
      (typeof entry.command === "string" || typeof entry.url === "string");
    if (!usable) {
      skipped.push(name);
      continue;
    }
    servers[name] = entry;
  }

  return { servers, skipped };
}

/**
 * Merge the action's servers into `<agent-dir>/mcp.json` and return the names
 * now available. Servers the action defines win over pre-existing entries with
 * the same name; unrelated entries are preserved.
 */
export async function writePiMcpConfig(
  agentDir: string,
  configJson?: string,
): Promise<{ path: string; servers: string[]; skipped: string[] }> {
  const { servers, skipped } = parseMcpConfig(configJson);
  const path = join(agentDir, "mcp.json");
  const names = Object.keys(servers);

  if (names.length === 0) {
    if (skipped.length > 0) {
      console.warn(`No usable MCP servers; skipped: ${skipped.join(", ")}`);
    }
    return { path, servers: [], skipped };
  }

  await mkdir(agentDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const parsed = asRecord(JSON.parse(await readFile(path, "utf-8")));
    if (parsed) existing = parsed;
  } catch {
    // No previous file, or it is not JSON: write a fresh one.
  }

  const existingServers = asRecord(existing.mcpServers) ?? {};
  const merged = {
    ...existing,
    mcpServers: { ...existingServers, ...servers },
  };
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);

  console.log(`Registered MCP servers in ${path}: ${names.join(", ")}`);
  if (skipped.length > 0) {
    console.warn(`Skipped unusable MCP servers: ${skipped.join(", ")}`);
  }
  return { path, servers: names, skipped };
}
