# Security

## What is trusted

| Content | Trusted? | Consequence |
| --- | --- | --- |
| Workflow file on the default branch | Yes | It defines the run |
| Prompt written by a maintainer | Yes | – |
| Issue body, issue comments, review comments | **No** | Anyone who can comment controls it |
| Files in a fork pull request | **No** | Anyone can put anything there |
| Project `.pi/` config in a fork | **No** | Only loaded with `trust_project_files: true` |

The action never treats issue text as instructions to itself. It becomes the
agent's input, and the agent's output becomes a comment or a commit — nothing
else.

## Untrusted pull requests

`restrict_untrusted_prs` defaults to `true`. When a PR author has no write
access:

- `bash`, `edit` and `write` are removed from the run, so the checkout cannot be
  executed or modified;
- `--no-approve` is passed, so project `.pi/` configuration is ignored;
- the tracked tool configuration is restored from the base branch, not the PR
  head.

What still runs: `read`, `grep`, `find`, `ls`, and the MCP servers. That is
enough to review or answer, not enough to run the PR's code.

## Comment-triggered runs

`issue_comment` runs with the repository's secrets available, and anybody can
comment on a public repository. Two gates apply:

1. `checkWritePermissions` — the actor must have write access, unless listed in
   `allowed_non_write_users`.
2. `allowed_bots` — bots need an explicit entry. `*` on a public repository lets
   any installed App drive the action with a prompt it controls.

Prefer the narrowest `permissions:` block. A triage workflow should look like:

```yaml
permissions:
  contents: read
  issues: write
```

and pass `no_tools: "true"`. Then even a successful prompt injection has nothing
to call.

## Secrets

| Secret | Where it goes |
| --- | --- |
| `api_key` | Child process env only (`PI_PROVIDER_API_KEY`); `models.json` holds `$PI_PROVIDER_API_KEY` |
| `GITHUB_TOKEN` | Passed to the GitHub MCP server processes, not to `pi` itself |
| SSH signing key | Written, used for git config, removed by the post step |

`show_full_output: "true"` prints every event, including tool results. On a
public repository that publishes repository content into the job log. Keep it
off except while debugging in a private repository.

## Prompt injection, honestly

Any design that lets a model read untrusted text and then act can be steered by
that text. The controls here reduce the blast radius:

- the agent's authority is the token and the tools the workflow granted;
- on untrusted checkouts those tools cannot execute or write;
- GitHub writes go through the action's own API calls and the MCP servers, both
  of which validate their inputs;
- `json_schema` output is parsed as data, never evaluated.

What they do not do: guarantee that a sufficiently clever issue cannot make the
agent write a misleading comment. Keep `contents: write` away from untrusted
triggers, and review agent-authored PRs like any other.

## Checklist

- [ ] `permissions:` is the minimum for the goal
- [ ] Classification / Q&A workflows use `no_tools: "true"`
- [ ] `allowed_non_write_users` is empty unless the workflow is read-only
- [ ] `allowed_bots` is empty or names specific bots
- [ ] `restrict_untrusted_prs` is left at `true`
- [ ] `trust_project_files` stays `false` for anything a non-maintainer wrote
- [ ] `show_full_output` is `false` in public repositories
