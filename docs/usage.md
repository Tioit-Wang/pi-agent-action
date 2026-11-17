# Usage

## Two modes

The action picks a mode from the event; you do not set it.

**Tag mode** answers. It runs on `@pi` mentions in issue bodies, issue comments
and review comments, plus assignee and label triggers. The agent reports back in
a comment. It never pushes commits.

**Agent mode** works. It runs on `prompt:` automation (schedule, `workflow_dispatch`,
`pull_request`), implements the change on a branch named
`<branch_prefix><entity>-<number>-<timestamp>`, and can open a pull request.

`track_progress: true` forces tag mode with a live checklist comment on
`pull_request` and `issues` events.

## Triggers

| Trigger | Input | Default |
| --- | --- | --- |
| Mention | `trigger_phrase` | `@pi` |
| Assignee | `assignee_trigger` | – (set `pi` to enable) |
| Label | `label_trigger` | `pi` |
| Automation | `prompt` on any event | – |

Mentions are matched in issue bodies, issue comments and review comments.
Assignments apply to `issues: [assigned]`; labels to `issues: [labeled]` and
`pull_request: [labeled]`.

## Inputs

See the [README](../README.md#inputs) for the full table. The ones that change
behaviour most:

| Input | Effect |
| --- | --- |
| `no_tools` | No tools at all. Use for classification and Q&A on untrusted text. |
| `allowed_tools` / `disallowed_tools` | Comma-separated Pi tool names: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`. |
| `max_turns` | Hard cap on assistant turns. Empty, `0` or a negative value means no limit. |
| `json_schema` | Schema appended to the prompt; the object is extracted from the final reply. |
| `pi_args` | Extra CLI flags, e.g. `--thinking high`. Plain words only; shell operators are rejected. |
| `trust_project_files` | Load project `.pi/` configuration. Leave false for untrusted content. |
| `restrict_untrusted_prs` | Default `true`. Removes `bash`, `edit`, `write` on untrusted PR checkouts. |
| `progress_updates` | Default `true`. Rewrites the tracking comment with the turn count, elapsed time and last tool while Pi runs. |

## Outputs

```yaml
- id: pi
  uses: Tioit-Wang/pi-agent-action@v1
  with: { provider: deepseek, model: deepseek-chat, api_key: "${{ secrets.DEEPSEEK_API_KEY }}" }

- run: echo "conclusion=${{ steps.pi.outputs.conclusion }}"
- run: echo "$STRUCTURED_OUTPUT" | jq .
  env:
    STRUCTURED_OUTPUT: ${{ steps.pi.outputs.structured_output }}
- run: echo "session=${{ steps.pi.outputs.session_id }}"
```

`execution_file` holds the raw JSONL event array. `branch_name` is set when agent
mode created or checked out a branch.

## Continuing a session

`session_id` identifies the Pi session. To continue it, reuse the agent
directory across runs, because Pi stores sessions inside it:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.pi/agent/sessions
    key: pi-sessions-${{ github.ref }}-${{ github.run_id }}
    restore-keys: pi-sessions-${{ github.ref }}-

- uses: Tioit-Wang/pi-agent-action@v1
  with:
    provider: deepseek
    model: deepseek-chat
    api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    pi_args: --session-id ${{ steps.prev.outputs.session_id }}
```

`--session-id` opens that session or creates it; `--continue` picks the most
recent one for the working directory.

## Prompt files

Instead of an inline prompt, point at a file so the instructions live in the
repository:

```yaml
- uses: Tioit-Wang/pi-agent-action@v1
  with:
    provider: deepseek
    model: deepseek-chat
    api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    prompt: |
      Read .github/prompts/review.md and follow it for PR #${{ github.event.pull_request.number }}.
```

The agent has `read`, so it can load the file itself — no template engine needed.
