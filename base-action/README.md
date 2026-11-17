# Pi Agent Base Action

Run the [Pi](https://pi.dev) coding agent non-interactively inside GitHub
Actions. This is the low-level building block: it sends one prompt to `pi` and
reports what came back. It does not read issues or comments and it does not touch
GitHub — use the top-level action for that.

## Usage

```yaml
- uses: actions/checkout@v7
- uses: your-org/pi-agent-action/base-action@v1
  id: pi
  with:
    provider: deepseek
    model: deepseek-chat
    api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    prompt: |
      Review the diff against main and list the risky changes.
```

From a file, with a turn cap and no tools:

```yaml
- uses: your-org/pi-agent-action/base-action@v1
  with:
    provider: deepseek
    model: deepseek-chat
    api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    prompt_file: ./prompts/review.md
    max_turns: "12"
    no_tools: "true"
```

A structured answer:

```yaml
- uses: your-org/pi-agent-action/base-action@v1
  id: pi
  with:
    provider: deepseek
    model: deepseek-chat
    api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    json_schema: |
      {"type":"object","properties":{"labels":{"type":"array","items":{"type":"string"}}},"required":["labels"]}
    prompt: "List the labels this issue should get."

- run: echo "$STRUCTURED_OUTPUT" | jq .
  env:
    STRUCTURED_OUTPUT: ${{ steps.pi.outputs.structured_output }}
```


## How it runs

`pi --mode json <prompt>` is spawned once. Its stdout is a strict JSONL event
stream: a session header, then session events, then `agent_settled`. The action
parses that stream and derives:

- `conclusion` — success only when the process exits 0, the stream settles, no
  error event arrived, and any `max_turns` limit was respected;
- `session_id` — the header record's id;
- `structured_output` — the JSON object extracted from the final assistant
  message when `json_schema` is set.

The raw event array is written to `<runner temp>/claude-execution-output.json` and
exposed as `execution_file`.

## Trust model

`trust_project_files` defaults to `false`, so the action passes `--no-approve`
and project-local `.pi/` configuration is not loaded. `AGENTS.md` still loads,
because context-file discovery does not require project trust. Enable it only for
content you trust: a pull request from a fork can put anything in `.pi/`.

`api_key` is exported to the child process as `PI_PROVIDER_API_KEY` and referenced
from `models.json` as `$PI_PROVIDER_API_KEY`; it is never written to disk in
plaintext.

## Inputs

| Input                    | Description                                                                                                 | Required | Default       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| `prompt`                 | The prompt to send to Pi                                                                                    | No\*     | `''`          |
| `prompt_file`            | Path to a file containing the prompt to send to Pi                                                          | No\*     | `''`          |
| `settings`               | Pi settings as a JSON string or the path to a settings JSON file                                            | No       | `''`          |
| `pi_args`                | Additional arguments passed to the Pi CLI                                                                   | No       | `''`          |
| `json_schema`            | JSON Schema the final answer must conform to; appended to the prompt                                        | No       | `''`          |
| `provider`               | Pi provider id, e.g. `deepseek`                                                                             | No       | `''`          |
| `model`                  | Model id or pattern, e.g. `deepseek-chat`                                                                   | No\*     | `''`          |
| `api_key`                | API key for the provider; exported as `PI_PROVIDER_API_KEY`                                                 | No       | `''`          |
| `base_url`               | Base URL for an OpenAI-compatible endpoint; written to `models.json`                                        | No       | `''`          |
| `api_style`              | Wire protocol for the endpoint                                                                              | No       | `'openai-completions'` |
| `agent_dir`              | Pi agent directory (sessions, settings, models, auth)                                                       | No       | `~/.pi/agent` |
| `allowed_tools`          | Comma-separated allowlist of Pi tools                                                                       | No       | `''`          |
| `disallowed_tools`       | Comma-separated denylist of Pi tools                                                                        | No       | `''`          |
| `no_tools`               | Run Pi with no tools at all                                                                                 | No       | `'false'`     |
| `max_turns`              | Abort when Pi exceeds this many assistant turns (enforced by the action)                                    | No       | `''`          |
| `system_prompt`          | Replace Pi's default system prompt                                                                          | No       | `''`          |
| `append_system_prompt`   | Append text (or a file path) to Pi's system prompt                                                          | No       | `''`          |
| `trust_project_files`    | Trust project-local `.pi/` configuration for this run                                                       | No       | `'false'`     |
| `path_to_pi_executable`  | Path to a Pi executable; skips the automatic install                                                        | No       | `''`          |
| `path_to_bun_executable` | Path to a Bun executable; skips the automatic install                                                       | No       | `''`          |
| `show_full_output`       | Log every event instead of a sanitized summary (⚠️ may include repository content)                          | No       | `'false'`     |

\* One of `prompt` or `prompt_file` is required.

## Outputs

| Output              | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `conclusion`        | Execution status of the Pi agent ('success' or 'failure')            |
| `execution_file`    | Path to the JSON file holding the Pi event stream                     |
| `session_id`        | Pi session id, usable with `--session` to continue the conversation   |
| `structured_output` | JSON string with the structured fields extracted from the final reply |

## Development

```bash
bun install
bunx tsc --noEmit
bun test
```
