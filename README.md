# Pi Agent Action

Run the [Pi](https://pi.dev) coding agent inside GitHub Actions, in the shape of
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action).

Mention `@pi` in an issue or pull request comment and the agent reads the
repository, does the work, and reports back. Tag mode answers questions; agent
mode edits code, commits to a branch and can open a pull request.

## Quick start

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

A read-only triage setup needs no write permissions and no tools:

```yaml
      - uses: Tioit-Wang/pi-agent-action@v1
        with:
          provider: deepseek
          model: deepseek-chat
          api_key: ${{ secrets.DEEPSEEK_API_KEY }}
          no_tools: "true"
          prompt: |
            Classify this issue as bug, feature or needs-info and reply with one
            short paragraph explaining what is missing.
```

## How Pi is invoked

The action spawns one `pi --mode json <prompt>` process, reads the JSONL event
stream from stdout, and derives everything it reports from those records. See
`base-action/src/pi/`:

| Module | Responsibility |
| --- | --- |
| `events.ts` | JSONL framing, event summary (session id, turns, final text, usage, errors) |
| `options.ts` | Action inputs to `pi` argv; prompt size handling; `max_turns` |
| `provider.ts` | Agent directory, `models.json` for compatible endpoints |
| `mcp.ts` | GitHub MCP servers into `<agent-dir>/mcp.json` |
| `run.ts` | Process lifecycle, `max_turns` enforcement, execution file |
| `report.ts` | Step-summary report |

## Providers

Pi ships a model catalog. Anything else (DeepSeek, OpenRouter, vLLM, a proxy) is
declared in `models.json`. The action writes it for you when `provider` and
`base_url` are set:

```jsonc
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      // Interpolated by Pi at request time, so the secret never lands on disk
      "apiKey": "$PI_PROVIDER_API_KEY",
      "models": [{ "id": "deepseek-chat" }]
    }
  }
}
```

Known base URLs default automatically for `deepseek`, `openrouter` and `ollama`;
any other OpenAI-compatible endpoint works by setting `base_url` explicitly. For
a provider Pi already supports (Anthropic, OpenAI, Google), leave `base_url`
empty and export the provider's own environment variable or pass `api_key`.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `trigger_phrase` | `@pi` | Phrase looked for in comments and issue bodies |
| `assignee_trigger` / `label_trigger` | 鈥?/ `pi` | Alternative triggers |
| `provider` / `model` / `api_key` / `base_url` / `api_style` | 鈥?| Provider selection (see above) |
| `agent_dir` | `~/.pi/agent` | Sessions, `settings.json`, `models.json` |
| `pi_args` | 鈥?| Extra CLI arguments, e.g. `--thinking high` |
| `allowed_tools` / `disallowed_tools` | 鈥?| Comma-separated Pi tool names |
| `no_tools` | `false` | Read-only analysis |
| `max_turns` | 鈥?| Enforced by the action; Pi has no CLI equivalent |
| `system_prompt` / `append_system_prompt` | 鈥?| System prompt overrides |
| `json_schema` | 鈥?| JSON Schema appended to the prompt; result exposed as `structured_output` |
| `trust_project_files` | `false` | Allow project `.pi/` configuration |
| `branch_prefix` | `pi/` | Branch namespace for agent mode |
| `allowed_bots`, `allowed_non_write_users`, `restrict_untrusted_prs` | 鈥?/ 鈥?/ `true` | Access control |
| `show_full_output` | `false` | Log every event (may leak repository content) |
| `display_report` | `true` | Write the report to the step summary |
| `path_to_pi_executable` / `path_to_bun_executable` | 鈥?| Skip auto-install |

## Outputs

`conclusion`, `execution_file`, `branch_name`, `github_token`,
`structured_output`, `session_id`.

## Security model

- The agent job runs with the token the workflow grants. Prefer the narrowest
  `permissions:` that still does the job; `no_tools: true` for anything that only
  classifies or answers.
- A pull request whose author has no write access loses `bash`, `edit` and
  `write` entirely (`restrict_untrusted_prs`). Pi has no per-command deny
  patterns, so the action removes the tools instead of matching commands.
- Project-local `.pi/` configuration is trusted only when the caller sets
  `trust_project_files: true`; the action passes `--no-approve` otherwise.
  `AGENTS.md` discovery is unaffected because it does not require project trust.
- `api_key` reaches the child process through `PI_PROVIDER_API_KEY`. It is never
  written into `models.json`, and `GITHUB_TOKEN` is not passed to the agent's
  environment.
- Issue and comment text is untrusted input. Treat model output as data: this
  action applies it only through the Pi CLI's own tools and the GitHub API calls
  the workflow author controls.

## Differences from claude-code-action

Ported: trigger detection, tag and agent modes, branch creation, PR creation,
permission checks, comment updates, step reports, and the GitHub MCP servers
(`github_comment`, `github_inline_comment`, `github_ci`, `github_file_ops`),
which are written to `<agent-dir>/mcp.json` and reached as
`mcp__<server>__<tool>`. Put your own servers in the same file.

Not ported:

- Anthropic-specific auth (Bedrock, Vertex, Foundry, OIDC federation).
- Claude Code plugins and plugin marketplaces.
- Inline-review-comment classification (`classify_inline_comments` defaults to
  `false`; the buffered post-step is gone).
- `--json-schema` has no Pi equivalent: the `json_schema` input appends the
  schema to the prompt and the object is extracted from the final message.
- Per-command deny rules (`Bash(npm:*)`). Replaced by removing `bash`, `edit` and
  `write` on untrusted checkouts.
- Mode-generated Claude CLI flags: `pi_args` from the workflow is what reaches
  Pi; the modes' `--allowedTools` / `--mcp-config` strings are not forwarded.

Internal identifiers that still say `claude*` (comments, some option names in
`src/`) are leftovers of the fork; they are not user-visible.

## Development

```bash
bun install
bunx tsc --noEmit
bun test
```

`docs/` and `examples/` are written for this fork and match the code:

| Document | Covers |
| --- | --- |
| [docs/setup.md](docs/setup.md) | Provider, first workflow, permissions |
| [docs/usage.md](docs/usage.md) | Modes, triggers, inputs, outputs, sessions |
| [docs/configuration.md](docs/configuration.md) | Providers, tools, MCP, settings, cost |
| [docs/security.md](docs/security.md) | Trust model, untrusted PRs, secrets |
| [docs/solutions.md](docs/solutions.md) | Recipes and which inputs each needs |
| [docs/faq.md](docs/faq.md) | Troubleshooting |
| [examples/](examples) | Copy-paste workflows |

## License

MIT. This project is a fork of
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action);
see `LICENSE` and `NOTICE`.
