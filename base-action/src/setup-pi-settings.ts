/**
 * Writes user-level Pi settings into the agent directory.
 *
 * Mirrors the role of the previous setup-claude-code-settings.ts, but for Pi's
 * layout: `<agent-dir>/settings.json` (see docs/configuration.md in the
 * @earendil-works/pi-coding-agent package).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type PiSettingsResult = {
  settingsPath: string;
  settings: Record<string, unknown>;
};

export function resolveSettingsPath(agentDir?: string): string {
  const dir =
    agentDir?.trim() ||
    process.env.PI_CODING_AGENT_DIR?.trim() ||
    join(homedir(), ".pi", "agent");
  return join(dir, "settings.json");
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf-8");
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Accepts settings as a JSON string or as a path to a JSON file, then merges
 * them over whatever the agent directory already holds.
 */
export async function setupPiSettings(
  settingsInput?: string,
  agentDir?: string,
): Promise<PiSettingsResult> {
  const settingsPath = resolveSettingsPath(agentDir);
  await mkdir(join(settingsPath, ".."), { recursive: true });
  console.log(`Setting up Pi settings at: ${settingsPath}`);

  let settings = await readJsonFile(settingsPath);

  if (settingsInput?.trim()) {
    let inputSettings: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(settingsInput);
      if (parsed && typeof parsed === "object") {
        inputSettings = parsed as Record<string, unknown>;
      }
    } catch {
      console.log(
        `Settings input is not JSON, treating it as a file path: ${settingsInput}`,
      );
      try {
        inputSettings = await readJsonFile(settingsInput);
      } catch (error) {
        throw new Error(`Failed to process settings input: ${error}`);
      }
    }
    settings = { ...settings, ...inputSettings };
    console.log("Merged input settings over existing settings");
  }

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log("Settings saved successfully");
  return { settingsPath, settings };
}
