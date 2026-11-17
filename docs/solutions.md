# Recipes

Working workflows live in [`examples/`](../examples). Each one is a complete file
you can copy. This page explains what each solves and which inputs make it work.

## Mention handler

`examples/pi.yml`. The default setup: `@pi` in an issue, a PR, or a review
comment. Tag mode answers, the tracking comment gets the run link.

Why it is safe: the actor needs write access, the workflow declares only the
permissions it uses, and the checkout is the pull request's head only when the
author has write access.

## Issue triage

`examples/issue-triage.yml`. Runs on `issues: [opened]`, classifies the report and
applies labels.

Key inputs:

```yaml
no_tools: "true"        # read-only reasoning
json_schema: |          # structured result
  {"type":"object","properties":{"labels":{"type":"array","items":{"type":"string"}},"missing":{"type":"string"}},"required":["labels"]}
```

`no_tools` matters here: the issue body is attacker-controlled on a public
repository, and a tool-less run can only produce text.

Pair it with `allowed_non_write_users: "*"` so reports from people without write
access can be triaged — the workflow only has `issues: write`.

## Pull request review

`examples/pr-review.yml`. Runs on `pull_request` and reviews the diff.

```yaml
track_progress: "true"       # one live comment instead of many
allowed_tools: read,grep,find,ls
```

Restricting to read tools means a review can never push. Add `bash` only if you
want the agent to run tests, and remember untrusted authors lose it anyway.

## CI failure triage

`examples/ci-failure-auto-fix.yml`. Runs after a failed workflow, reads the logs
through the GitHub CI MCP server, and either explains the failure or pushes a
fix.

```yaml
additional_permissions: |
  actions: read
```

That is what installs the `github_ci` server. Job logs are text the pull request
controls, so keep this on trusted branches or combine it with read-only tools.

## Duplicate issue detection

`examples/issue-deduplication.yml`. Compares a new issue against recent ones and
comments the likely duplicates.

Cheap inputs: a small `model`, `no_tools: "true"`, and a JSON schema listing the
candidate numbers. The agent never needs the repository.

## Ad-hoc analysis on demand

`examples/manual-code-analysis.yml`. `workflow_dispatch` with a prompt input, for
"look at this and tell me" requests without touching issues.

```yaml
on:
  workflow_dispatch:
    inputs:
      prompt:
        required: true
```

## Writing your own

Start from the smallest thing that works:

```yaml
- uses: your-org/pi-agent-action@v1
  with:
    provider: deepseek
    model: deepseek-chat
    api_key: ${{ secrets.DEEPSEEK_API_KEY }}
    prompt: |
      Answer the question in this issue and nothing else.
```

Then add only what the task needs, in this order: `no_tools` → `allowed_tools` →
`json_schema` → `max_turns`. Each one removes a class of failure rather than
adding a feature.

Prompt tips that matter with Pi specifically:

- The agent can read the repository. Point at files instead of pasting them.
- `AGENTS.md` is picked up automatically; put repository conventions there
  instead of in every prompt.
- Ask for a conclusion, not a transcript. The full event stream is already in
  `execution_file`.
