/**
 * Validates the environment the Pi run needs.
 *
 * Pi can authenticate in several ways (stored `auth.json`, provider environment
 * variables, or a compatible endpoint declared in `models.json`). The action
 * requires enough information to make the choice unambiguous instead of letting
 * Pi prompt for credentials, which would hang a CI job.
 */

const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
] as const;

export type PiEnvironmentInput = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  agentDir?: string;
  env?: Record<string, string | undefined>;
};

export function validatePiEnvironment(
  input: PiEnvironmentInput = {},
): void {
  const env = input.env ?? process.env;
  const provider = input.provider?.trim() || env.PI_PROVIDER?.trim();
  const model = input.model?.trim() || env.PI_MODEL?.trim();
  const baseUrl = input.baseUrl?.trim() || env.PI_BASE_URL?.trim();
  const apiKey = input.apiKey?.trim() || env.PI_API_KEY?.trim();
  const errors: string[] = [];

  if (!model) {
    errors.push(
      "A model is required. Set the `model` input (for example `deepseek-chat` or `anthropic/claude-sonnet-5`).",
    );
  }

  // A custom endpoint is declared in models.json, which needs a key to be usable.
  if (baseUrl && !apiKey) {
    errors.push(
      "`base_url` was provided without an `api_key`. A compatible endpoint declared in models.json needs credentials Pi can resolve.",
    );
  }

  if (provider && !baseUrl) {
    const ambientKey = PROVIDER_ENV_VARS.some((name) => Boolean(env[name]));
    if (!apiKey && !ambientKey) {
      errors.push(
        `Provider "${provider}" was selected but no credential is available. Set the \`api_key\` input or export the provider's environment variable (for example DEEPSEEK_API_KEY).`,
      );
    }
  }

  if (!provider && !baseUrl) {
    const ambientKey = PROVIDER_ENV_VARS.some((name) => Boolean(env[name]));
    if (!apiKey && !ambientKey) {
      errors.push(
        "No provider credential found. Set the `api_key` input, export a provider environment variable, or run `pi auth` before this step.",
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Environment validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
}
