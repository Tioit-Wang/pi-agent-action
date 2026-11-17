/**
 * Provider bootstrap for the Pi agent CLI.
 *
 * Pi ships a bundled model catalog that already includes several hosted
 * providers (Anthropic, OpenAI, Google, DeepSeek, ...). Their models only appear
 * in `--list-models` once a credential resolves, so `models.json` is needed for a
 * different base URL, a gateway, or a model the catalog does not list.
 *
 * Reference:
 * node_modules/@earendil-works/pi-coding-agent/docs/models.md#configure-a-compatible-endpoint
 *
 * The API key is never written to disk: `models.json` interpolates an
 * environment variable (`$NAME`), and the action passes the secret through the
 * child process environment instead.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Convenience defaults for endpoints people use most; any base URL can be given explicitly. */
export const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

/** Environment variable that carries the secret into the child process. */
export const PI_PROVIDER_API_KEY_ENV = "PI_PROVIDER_API_KEY";

export type PiProviderConfig = {
  /** Provider id, e.g. `deepseek`. Empty means "use Pi's own catalog". */
  provider?: string;
  /** Model id or pattern, e.g. `deepseek-chat` or `deepseek/deepseek-chat`. */
  model?: string;
  /** API key value; exported to the child as PI_PROVIDER_API_KEY. */
  apiKey?: string;
  /** Base URL for the endpoint. Falls back to DEFAULT_PROVIDER_BASE_URLS. */
  baseUrl?: string;
  /** Wire protocol for the endpoint. */
  api?: string;
  /** Agent directory override; defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
  agentDir?: string;
};

export type ResolvedProvider = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  api: string;
  /** True when a models.json entry has to be written. */
  requiresModelEntry: boolean;
};

export function resolveAgentDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return configured;
  return join(homedir(), ".pi", "agent");
}

/**
 * Decide what the run needs. A custom base URL (or a provider Pi does not ship)
 * needs a `models.json` entry; a plain provider/model pair does not.
 */
export function resolveProvider(config: PiProviderConfig): ResolvedProvider {
  const provider = config.provider?.trim() || undefined;
  const model = config.model?.trim() || undefined;
  const explicitBaseUrl = config.baseUrl?.trim() || undefined;
  const knownBaseUrl = provider
    ? DEFAULT_PROVIDER_BASE_URLS[provider]
    : undefined;
  const baseUrl = explicitBaseUrl ?? knownBaseUrl;
  const api = config.api?.trim() || "openai-completions";

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    api,
    requiresModelEntry: Boolean(baseUrl) && Boolean(provider),
  };
}

/** Build the `models.json` document for one compatible endpoint. */
export function buildModelsJson(config: {
  provider: string;
  baseUrl: string;
  api: string;
  model: string;
  apiKeyEnvVar?: string;
}): Record<string, unknown> {
  const modelEntry: Record<string, unknown> = { id: config.model };
  return {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
      [config.provider]: {
        baseUrl: config.baseUrl,
        api: config.api,
        // `$NAME` is interpolated by Pi at request time, so the secret stays in
        // the environment instead of a file on the runner.
        ...(config.apiKeyEnvVar ? { apiKey: `$${config.apiKeyEnvVar}` } : {}),
        models: [modelEntry],
      },
    },
  };
}

export type BootstrapResult = {
  agentDir: string;
  modelsPath?: string;
  /** Environment additions for the child process. */
  env: Record<string, string>;
};

/**
 * Prepare the agent directory and, when needed, write `models.json`.
 * Never throws on an existing models.json: the file is merged so a repository
 * or a previous step can keep its own provider entries.
 */
export async function bootstrapPiProvider(
  config: PiProviderConfig,
): Promise<BootstrapResult> {
  const agentDir = config.agentDir?.trim() || resolveAgentDir();
  await mkdir(agentDir, { recursive: true });

  const resolved = resolveProvider(config);
  const env: Record<string, string> = { PI_CODING_AGENT_DIR: agentDir };
  if (config.apiKey?.trim()) {
    env[PI_PROVIDER_API_KEY_ENV] = config.apiKey.trim();
  }

  if (!resolved.requiresModelEntry || !resolved.provider) {
    return { agentDir, env };
  }

  const modelsPath = join(agentDir, "models.json");
  const desired = buildModelsJson({
    provider: resolved.provider,
    baseUrl: resolved.baseUrl!,
    api: resolved.api,
    model: resolved.model ?? resolved.provider,
    ...(config.apiKey?.trim()
      ? { apiKeyEnvVar: PI_PROVIDER_API_KEY_ENV }
      : {}),
  });

  let merged = desired;
  try {
    const existing = JSON.parse(await readFile(modelsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const existingProviders =
      (existing.providers as Record<string, unknown> | undefined) ?? {};
    const desiredProviders = desired.providers as Record<string, unknown>;
    merged = {
      ...existing,
      ...desired,
      providers: { ...existingProviders, ...desiredProviders },
    };
    console.log(
      `Merged provider "${resolved.provider}" into existing ${modelsPath}`,
    );
  } catch {
    console.log(`Writing provider "${resolved.provider}" to ${modelsPath}`);
  }

  await writeFile(modelsPath, `${JSON.stringify(merged, null, 2)}\n`);
  return { agentDir, modelsPath, env };
}
