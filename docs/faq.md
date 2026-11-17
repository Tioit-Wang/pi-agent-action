# FAQ and troubleshooting

## The run fails before `pi` starts

Read the log top-down. The action prints each step's outcome before spawning the
agent:

1. `Environment validation failed: …` — missing `model`, or no credential for the
   provider you named. Add `model` and either `api_key` or the provider's own
   environment variable.
2. `Writing provider "x" to …/models.json` — expected when `base_url` is set.
3. `Registered MCP servers in …/mcp.json: github_comment` — expected.
4. `Running Pi agent (full output hidden for security)...` — the agent started.

## "No provider credential found"

Pi never prompts for a login in CI, so the action refuses to start without a
credential. Three ways to supply one:

- `api_key: ${{ secrets.DEEPSEEK_API_KEY }}`
- an environment variable Pi reads directly (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, …) — set it at job level
- a cached `<agent-dir>/auth.json` from a previous `pi auth` run

## The model is not found

`pi --list-models` only shows providers whose credential resolves. A provider you
know Pi supports — DeepSeek included — disappears from that list when no key is
available, which reads like "the model is not found". Checks:

- the credential actually reached the process: `api_key` alone is enough, but an
  environment variable must be exported at job level, and the action passes the
  key to `pi` as `PI_PROVIDER_API_KEY`
- `provider: deepseek` and `model: deepseek-v4.1-flash` (the id alone, without the
  `provider/` prefix when you also pass `provider`)
- `base_url` is required when the endpoint is a gateway or proxy; the action then
  writes `models.json` with that base URL and adds the model id
- a model id the catalog does not list needs both `provider` and `base_url`, and
  `api_style` should stay `openai-completions` unless the endpoint only speaks
  the responses API

## `pi_args` was rejected

`pi_args` is parsed as plain words. Shell operators (`>`, `|`, `&&`) are rejected
on purpose, because the action never runs `pi` through a shell. Put the values in
the dedicated inputs instead.

## Turns ran out

`max_turns` is enforced by the action, not by Pi: the process is killed and the
step fails with the turn count. Raise it, narrow the task, or allow fewer tools.

## The agent cannot call the GitHub tools

The GitHub MCP servers are written to `<agent-dir>/mcp.json` every run. Pi names
their tools `mcp__<server>__<tool>`; if you restricted `allowed_tools` to Pi's
built-ins, the MCP tools are gone too. Leave `allowed_tools` empty to keep them,
or list the `mcp__…` names explicitly.

Entry names must match `[A-Za-z0-9_-]+`, and `type: "sse"` is not supported —
those entries are skipped with a warning.

## Session resume does nothing

Pi keeps sessions inside the agent directory. If the directory is fresh on every
run (the default), there is nothing to resume. Cache `~/.pi/agent/sessions` first,
then pass `pi_args: --session-id <id>` with an id from a previous run's
`session_id` output.

## Comments are not posted

Two gates must both pass: the actor needs write access (or must be listed in
`allowed_non_write_users`), and a bot must be listed in `allowed_bots`. Also
check that the workflow's `permissions:` block grants `issues: write` or
`pull-requests: write` — the action cannot add what the job token lacks.

## The step summary is empty

`display_report` defaults to `true`, but the summary needs `GITHUB_STEP_SUMMARY`,
which exists on hosted runners. If the report shows as raw JSON, the formatter hit
an unexpected shape; the raw event array is in `execution_file`.

## It works locally but not on the runner

The action spawns `pi` as a child process and expects a Linux or macOS runner.
`pi` must be on `PATH` after installation; if you install it yourself, pass
`path_to_pi_executable`. Windows runners are not supported.

## What does it cost?

Whatever your provider charges for the tokens. A triage run is a few thousand
tokens; an implementation run is more. Bound it with `max_turns`, a small `model`
for classification, and `no_tools` where the agent only needs to think.
