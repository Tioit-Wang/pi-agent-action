# Configuration

## Providers and models

Pi resolves a model from its bundled catalog plus `<agent-dir>/models.json`. The
action writes that file when it needs to.

Decision table:

| Your endpoint | Inputs | What the action does |
| --- | --- | --- |
| In Pi's catalog (Anthropic, OpenAI, Google, 鈥? | `model: anthropic/claude-sonnet-5` + `api_key` or the provider's env var | Nothing to configure; passes `--model` |
| Known compatible provider | `provider: deepseek` (or `openrouter`, `ollama`) + `model` | Writes `models.json` with the default base URL |
| Any other OpenAI-compatible endpoint | `provider` + `base_url` + `model` + `api_key` | Writes `models.json` with your base URL |
| Local model server on the runner | `provider: ollama`, `model`, no key | Writes `models.json`; Pi uses a placeholder key |

What lands on disk (`api_style` defaults to `openai-completions`):

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "$PI_PROVIDER_API_KEY",
      "models": [{ "id": "deepseek-chat" }]
    }
  }
}
```

An existing `models.json` is merged, not replaced, so a runner image or a cache
can carry extra providers.

## Agent directory

`agent_dir` (or `PI_CODING_AGENT_DIR`) controls where Pi keeps its state. Default
`~/.pi/agent`:

| Path | Contents |
| --- | --- |
| `settings.json` | Pi settings, written from the `settings` input |
| `models.json` | Compatible endpoints (above) |
| `mcp.json` | MCP servers, written by the action each run |
| `sessions/` | Session transcripts, the thing `session_id` refers to |
| `auth.json` | Only present if you cache credentials yourself |

Point `agent_dir` at a cached path to keep sessions across runs.

## Tools

Pi's built-in tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`.

| Input | Effect |
| --- | --- |
| `no_tools: "true"` | `--no-tools`. The agent can only reason over the prompt. |
| `allowed_tools` | `--tools a,b,c`. Only these exist for the run. |
| `disallowed_tools` | `--exclude-tools a,b`. Everything else stays. |
| `max_turns` | The action kills `pi` after this many `turn_end` records. |

`no_tools` wins over the other two. Deny rules are tool-level, not
per-command 鈥?`bash` is all or nothing. That is why untrusted pull requests lose
`bash`, `edit` and `write` entirely.

## MCP servers

The action publishes GitHub MCP servers into `<agent-dir>/mcp.json` every run:

| Server | Tools | When |
| --- | --- | --- |
| `github_comment` | update the tracking comment | tag mode, or agent mode that asks for the tools |
| `github_inline_comment` | review comments on a PR | PR runs with the GitHub MCP tools allowed |
| `github_ci` | read workflow runs and logs | when `additional_permissions` grants `actions: read` |
| `github_file_ops` | commit files through the API | when `use_commit_signing` is on |

They appear to the model as `mcp__<server>__<tool>`, the same naming Pi uses.
Because the format is Claude-compatible, you can add your own servers by putting
an `mcpServers` document in the agent directory before this action runs:

```yaml
- run: |
    mkdir -p ~/.pi/agent
    cat > ~/.pi/agent/mcp.json <<'JSON'
    {"mcpServers":{"docs":{"command":"npx","args":["-y","my-docs-mcp"]}}}
    JSON
- uses: Tioit-Wang/pi-agent-action@v1
  with: { provider: deepseek, model: deepseek-chat, api_key: "${{ secrets.DEEPSEEK_API_KEY }}" }
```

Entries the action defines win over a pre-existing entry with the same name;
unrelated entries survive. Entries Pi rejects (invalid name, `type: "sse"`, no
`command` or `url`) are logged and skipped instead of breaking the session.

A project-level `.pi/mcp.json` is only read when `trust_project_files: "true"`.

## System prompts

| Input | Flag |
| --- | --- |
| `system_prompt` | `--system-prompt`, replaces Pi's prompt |
| `append_system_prompt` | `--append-system-prompt`, text or a file path |

Repository instructions are separate: `AGENTS.md` / `CLAUDE.md` are discovered
from the working directory without project trust.

## Settings

`settings` accepts inline JSON or a path, and is merged into
`<agent-dir>/settings.json`. Use it for Pi preferences such as default thinking
level rather than for secrets.

## Structured output

Pi has no `--json-schema`. The `json_schema` input appends the schema to the
prompt, then extracts the object from the final assistant message and exposes it
as `structured_output`. If no object can be parsed the step fails rather than
returning an empty output.

## Cost and runtime

Three knobs matter:

- `max_turns` 鈥?bounds the agent loop.
- `allowed_tools` / `no_tools` 鈥?fewer tools, fewer round trips.
- `model` 鈥?a small model for classification, a large one for implementation.

A triage run is typically one to three turns. An implementation run is tens.
