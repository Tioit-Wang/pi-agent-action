# Pi Agent Action

**Mention `@pi` in an issue or a pull request and let the agent do the work.**

Pi Agent Action runs the [Pi](https://pi.dev) coding agent inside GitHub Actions.
Ask a question and it answers in the thread. Ask for a fix and it edits the
repository, commits to a branch and opens a pull request. Bring your own model —
DeepSeek, OpenAI, Anthropic, a self-hosted gateway, anything Pi can reach.

[![CI](https://github.com/Tioit-Wang/pi-agent-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Tioit-Wang/pi-agent-action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Agent: Pi](https://img.shields.io/badge/agent-pi-8b5cf6.svg)](https://pi.dev)

```text
You:    @pi why does the watcher restart twice on Linux?

Pi:     Pi finished @you's task
        ### Cause
        `src/watcher/init.ts:88` subscribes before the ready latch is set, so …
        [View job run]
```

---

## Why people use it

| | |
| --- | --- |
| **No vendor lock-in** | Any provider Pi supports, including any OpenAI-compatible endpoint through `base_url`. Nothing is hard-coded to a single model vendor. |
| **Two modes, auto-detected** | A mention answers; a `prompt:` job works. You never configure the mode. |
| **Read-only is one input away** | `no_tools: true` gives you a reviewer that cannot touch a file. `allowed_tools: read,grep,find,ls` gives a read-everything, write-nothing agent. |
| **No GitHub App required** | It uses the workflow token when no App is configured, so it works in forks and personal repositories out of the box. |
| **Answers land in the thread** | The action posts the agent's final message into the tracking comment for you. No prompt gymnastics needed to make the reply appear. |
| **Cheap, bounded runs** | `max_turns`, `timeout-minutes` and explicit tool allowlists keep a run from snowballing. |

## Quick start

```yaml
name: Pi
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]

jobs:
  pi:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@pi')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@pi')) ||
      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@pi')) ||
      (github.event_name == 'issues' && (contains(github.event.issue.body, '@pi') || github.event.assignee.login == 'pi'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
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

Commit that to your default branch and mention `@pi` anywhere. Comment triggers
only fire workflows that already exist on the default branch, so a pull request
cannot add this file and then trigger it.

Prefer a locked-down version? Drop the `issues`/`pull_request_review` triggers,
set `permissions: { contents: read, issues: write, pull-requests: write }`, and
add `allowed_tools: read,grep,find,ls`.

## What you can build

| Recipe | Copy | Key inputs |
| --- | --- | --- |
| Ask-anything bot | [examples/pi.yml](examples/pi.yml) | `provider`, `model`, `api_key` |
| Read-only PR reviewer | [examples/pr-review.yml](examples/pr-review.yml) | `allowed_tools: read,grep,find,ls` |
| Issue triage and labelling | [examples/issue-triage.yml](examples/issue-triage.yml) | `no_tools: "true"`, `json_schema` |
| Duplicate-issue detection | [examples/issue-deduplication.yml](examples/issue-deduplication.yml) | `no_tools: "true"` |
| Fix a failing CI run | [examples/ci-failure-auto-fix.yml](examples/ci-failure-auto-fix.yml) | `additional_permissions: actions: read` |
| On-demand code analysis | [examples/manual-code-analysis.yml](examples/manual-code-analysis.yml) | `prompt`, `workflow_dispatch` |

## Triggers

| Trigger | Input | Default |
| --- | --- | --- |
| Mention in an issue body, issue comment or review comment | `trigger_phrase` | `@pi` |
| Issue / PR assignee | `assignee_trigger` | – (set `pi` to enable) |
| Label | `label_trigger` | `pi` |
| Automation on any event | `prompt` | – |

## Two modes, picked from the event

| | Tag mode | Agent mode |
| --- | --- | --- |
| Runs on | `@pi` mentions, assignee and label triggers | any event with a `prompt:` input (schedule, `workflow_dispatch`, `pull_request`) |
| Does | reads, reasons, replies in the thread | implements the change on `<branch_prefix><entity>-<number>-<timestamp>` and can open a pull request |
| Pushes to the repository | never | yes, to its own branch |
| Live checklist | the tracking comment | the tracking comment |

`track_progress: true` forces tag mode with a live checklist comment on
`pull_request` and `issues` events.

## Provider freedom

Pi ships a bundled model catalog, and the action writes `models.json` for you when
you need a different endpoint:

```yaml
      - uses: Tioit-Wang/pi-agent-action@v1
        with:
          provider: deepseek
          model: deepseek-v4.1-flash
          base_url: https://platform.aimom.net/v1   # any OpenAI-compatible gateway
          api_style: openai-completions
          api_key: ${{ secrets.AIMOM_API_KEY }}
```

Which turns into this on the runner — the key is interpolated by Pi at request
time and never written to disk:

```jsonc
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://platform.aimom.net/v1",
      "api": "openai-completions",
      "apiKey": "$PI_PROVIDER_API_KEY",
      "models": [{ "id": "deepseek-v4.1-flash" }]
    }
  }
}
```

Known base URLs are filled in automatically for `deepseek`, `openrouter` and
`ollama`. For providers Pi already supports (Anthropic, OpenAI, Google), leave
`base_url` empty and pass `api_key`.

## Safety you can dial in

```yaml
# Cannot touch a file: perfect for labelling and classification
- uses: Tioit-Wang/pi-agent-action@v1
  with:
    no_tools: "true"

# Can read everything, can write nothing
- uses: Tioit-Wang/pi-agent-action@v1
  with:
    allowed_tools: read,grep,find,ls
```

- `restrict_untrusted_prs` (default `true`) strips `bash`, `edit` and `write` when
  a pull request comes from an author without write access. Pi has no per-command
  deny patterns, so the action removes the tools instead of matching commands.
- `trust_project_files` defaults to `false`: project-local `.pi/` configuration is
  not loaded from untrusted checkouts.
- `allowed_bots` and `allowed_non_write_users` gate who may trigger a run.
- The token is the one your workflow grants — grant the narrowest `permissions:`
  that still does the job.
- `api_key` travels through the child process environment only; `GITHUB_TOKEN` is
  not exposed to the agent.

Full trust model: [docs/security.md](docs/security.md).

## Who can trigger a run

A mention only starts a run when its author has `write` or `admin` access to the
repository. Anyone else gets nothing at all: no comment, no failing job, no error
message to react to. `allowed_bots` covers automation, and
`allowed_non_write_users` deliberately opens the gate to named outsiders.

## Structured output

Agents are for humans, but a workflow may want a machine-readable answer. Give it
a schema and read the result as an output:

```yaml
- id: pi
  uses: Tioit-Wang/pi-agent-action@v1
  with:
    json_schema: |
      { "type": "object",
        "properties": { "severity": { "enum": ["low", "high"] },
                        "component": { "type": "string" } },
        "required": ["severity", "component"] }
    prompt: |
      Triage this issue. Reply with JSON only.

- run: echo "$OUTPUT" | jq -r .severity
  env:
    OUTPUT: ${{ steps.pi.outputs.structured_output }}
```

Pi has no schema flag, so the action appends the schema to the prompt and
extracts the object from the final message.

## Outputs

| Output | Meaning |
| --- | --- |
| `conclusion` | `success` or `failure` |
| `structured_output` | JSON object when `json_schema` was given |
| `session_id` | Pi session id, reusable with `--session` |
| `execution_file` | Path to the raw JSONL event stream |
| `branch_name` | Branch created by agent mode |
| `github_token` | Token the run used |

## Inputs

### Trigger and targeting

| Input | Default | Notes |
| --- | --- | --- |
| `trigger_phrase` | `@pi` | Phrase matched in comments and issue bodies |
| `assignee_trigger` | – | Assignee login that triggers the run |
| `label_trigger` | `pi` | Label that triggers the run |
| `base_branch` | repository default | Base for created branches |
| `branch_prefix` | `pi/` | Branch namespace for agent mode |
| `branch_name_template` | – | `{{prefix}} {{entityType}} {{entityNumber}} {{timestamp}} {{sha}} {{label}} {{description}}` |

### Model and provider

| Input | Notes |
| --- | --- |
| `provider` | Pi provider id: `deepseek`, `openai`, `anthropic`, `openrouter`, … |
| `model` | Model id or pattern, e.g. `deepseek-chat` |
| `api_key` | Provider key; passed through the environment, never written to disk |
| `base_url` / `api_style` | OpenAI-compatible endpoint and wire protocol |
| `agent_dir` | Pi agent directory, defaults to `~/.pi/agent` |

### Prompt and answer

| Input | Notes |
| --- | --- |
| `prompt` | Instructions, or the whole task in agent mode |
| `system_prompt` / `append_system_prompt` | Replace or extend Pi's system prompt |
| `settings` | Pi settings JSON or a path to one |
| `json_schema` | Schema appended to the prompt, extracted from the answer |
| `pi_args` | Extra CLI flags, e.g. `--thinking high` |

### Tools and limits

| Input | Default | Notes |
| --- | --- | --- |
| `allowed_tools` / `disallowed_tools` | – | Comma-separated Pi tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` |
| `no_tools` | `false` | No tools at all |
| `max_turns` | – | Hard cap on assistant turns; empty, `0` or a negative value means no limit |
| `restrict_untrusted_prs` | `true` | Strip run/mutate tools on untrusted PRs |
| `trust_project_files` | `false` | Load project-local `.pi/` configuration |

### Access, output and plumbing

| Input | Default | Notes |
| --- | --- | --- |
| `allowed_bots` / `allowed_non_write_users` | – | Who may trigger a run (`*` opens the floodgates) |
| `include_comments_by_actor` / `exclude_comments_by_actor` | – | Filter the comment context sent to the model |
| `use_sticky_comment` | `false` | Deliver replies in one reusable comment |
| `use_commit_signing` / `ssh_signing_key` | `false` / – | Signed commits |
| `display_report` | `true` | Write the run report to the step summary |
| `progress_updates` | `true` | Rewrite the tracking comment with live progress while Pi runs |
| `show_full_output` | `false` | Log every event — may leak repository content |
| `path_to_pi_executable` / `path_to_bun_executable` | – | Skip the automatic installs |
| `additional_permissions` | – | Request extra permissions, e.g. `actions: read` for the CI server |

## How a run works

```text
workflow event → mode + prompt → pi --mode json <prompt> → JSONL events
                                                   │
                            ┌──────────────────────┴─────────────────────┐
                    final message                              tool calls
                            │                                      │
                 posted into the tracking comment      GitHub MCP servers
                 (+ step summary + outputs)            (comment, inline
                                                        comment, ci, file ops)
```

The action spawns one `pi --mode json` process and derives everything it reports
from that event stream:

| Module | Responsibility |
| --- | --- |
| `base-action/src/pi/events.ts` | JSONL framing, session id, turns, final text, usage |
| `base-action/src/pi/options.ts` | Inputs to `pi` argv, prompt files, `max_turns` |
| `base-action/src/pi/provider.ts` | Agent directory and `models.json` |
| `base-action/src/pi/mcp.ts` | GitHub MCP servers into `<agent-dir>/mcp.json` |
| `base-action/src/pi/run.ts` | Process lifecycle and enforcement |
| `base-action/src/pi/report.ts` | Step-summary report |

### Watching a run

GitHub uploads job logs only after the job ends, so the run reports itself into the
tracking comment instead:

- `progress_updates` (default `true`) rewrites the comment every ~30s or 10 turns
  with the turn count, the elapsed time and the last tool it ran.
- A cancelled job or a fired `timeout-minutes` still ends in a comment: the spinner
  is replaced with what happened, how many turns it managed, and the reason.
- The job log records every tool call with its arguments (path, pattern, command),
  with file bodies collapsed to `<N chars>` and credentials masked. `show_full_output`
  gives the untrimmed records instead.
- `display_report` (default `true`) writes the run report to the step summary.
### MCP servers

`github_comment`, `github_inline_comment`, `github_ci` and `github_file_ops` are
written to `<agent-dir>/mcp.json` and reachable as `mcp__<server>__<tool>`. Add
your own servers to the same file. `github_ci` is installed when you grant
`additional_permissions: actions: read`.

## Differences from claude-code-action

This is a fork of
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
with the Claude SDK layer replaced by the Pi CLI, so the workflow surface stays
familiar while the agent, the model and the provider are yours.

Ported: trigger detection, both modes, branch and PR creation, permission checks,
tracking comments, step reports, structured output, commit signing, and the four
GitHub MCP servers.

Not ported (or replaced):

| Claude Code feature | Here |
| --- | --- |
| Anthropic-only auth (Bedrock, Vertex, Foundry, OIDC federation) | Any Pi provider; the workflow token is the fallback when no App is configured |
| Claude Code plugins and marketplaces | Pi extensions and MCP servers |
| `--json-schema` | `json_schema` input: appended to the prompt, extracted from the answer |
| Per-command deny rules (`Bash(npm:*)`) | Tools are removed instead: `bash`, `edit`, `write` on untrusted checkouts |
| Inline-review-comment classification | Not ported; `classify_inline_comments` stays `false` |

## Documentation

| Document | Covers |
| --- | --- |
| [docs/setup.md](docs/setup.md) | Provider, first workflow, permissions, troubleshooting a first run |
| [docs/usage.md](docs/usage.md) | Modes, triggers, inputs, outputs, sessions |
| [docs/configuration.md](docs/configuration.md) | Providers, tools, MCP, settings, cost control |
| [docs/security.md](docs/security.md) | Trust model, untrusted PRs, secrets |
| [docs/solutions.md](docs/solutions.md) | Recipes and the inputs each one needs |
| [docs/faq.md](docs/faq.md) | Common failures and what they mean |
| [examples/](examples) | Copy-paste workflows |

## Development

```bash
bun install
bunx tsc --noEmit
bun test
```

`.github/workflows/ci.yml` runs typecheck and the full suite on every push;
`.github/workflows/smoke.yml` exercises the action itself on demand.

## License

MIT. Forked from
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action);
see `LICENSE` and `NOTICE`.
