# Setup

## 1. Pick a provider and model

The action runs [`pi`](https://pi.dev) as a subprocess. Pi needs a model id and a
credential; how you supply them depends on the endpoint.

**A provider Pi already supports** (Anthropic, OpenAI, Google, …): pass `model`
with the provider prefix and set that provider's environment variable, or pass
`api_key`.

```yaml
- uses: Tioit-Wang/pi-agent-action@v1
  with:
    model: anthropic/claude-sonnet-5
    api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

**An OpenAI-compatible endpoint Pi does not ship** (DeepSeek, OpenRouter, a
gateway): also pass `provider` and, when it is not one of the known ones,
`base_url`. The action writes the `models.json` entry for you.

```yaml
- uses: Tioit-Wang/pi-agent-action@v1
  with:
    provider: deepseek
    model: deepseek-chat
    api_key: ${{ secrets.DEEPSEEK_API_KEY }}
```

Defaults: `deepseek` → `https://api.deepseek.com`, `openrouter` →
`https://openrouter.ai/api/v1`, `ollama` → `http://localhost:11434/v1`. For
anything else set `base_url` explicitly.

The key never reaches disk: it is exported to the `pi` process as
`PI_PROVIDER_API_KEY`, and `models.json` refers to it as `$PI_PROVIDER_API_KEY`.

## 2. Add a workflow

```yaml
name: Pi
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  pi:
    if: contains(github.event.comment.body, '@pi')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: Tioit-Wang/pi-agent-action@v1
        with:
          provider: deepseek
          model: deepseek-chat
          api_key: ${{ secrets.DEEPSEEK_API_KEY }}
```

Commit that file to the default branch. Workflows that respond to comments only
run from the default branch, so a pull request cannot add one and trigger itself.

## 3. Permissions

Grant the narrowest set that still does the job:

| Goal | `permissions:` | Other inputs |
| --- | --- | --- |
| Answer questions, classify an issue | `contents: read`, `issues: write` (for a reply) | `no_tools: "true"` |
| Review a pull request | `contents: read`, `pull-requests: write` | `track_progress: "true"` |
| Implement a change and open a pull request | `contents: write`, `pull-requests: write`, `issues: write` | – |

`id-token: write` is only needed when you wire a GitHub App of your own. Without
one, the action logs a warning and uses the workflow token, so the job's
`permissions:` block is what the agent can actually do.

## 4. Verify it works

1. Open an issue and comment `@pi what does the retry logic in src/fetch.ts do?`
2. The workflow run shows `Running Pi agent (full output hidden for security)...`
   followed by sanitized `turn_end` / `tool_execution_end` records.
3. The step summary gets a `Pi Agent Report` section with session id, turns, a
   tool table and the final response.
4. A tracking comment on the issue is updated with the run link.

If the run fails before any event appears, read the log top-down: provider
validation, `models.json` write and MCP registration all print their outcome
before `pi` starts.

## Next

- [usage.md](usage.md) — modes, triggers, inputs and outputs
- [configuration.md](configuration.md) — providers, tools, MCP, settings
- [security.md](security.md) — trust boundaries and what to keep read-only
