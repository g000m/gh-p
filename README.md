# gh-p

GitHub Projects CLI extension (`gh p`). Manages project board items, statuses, and priorities.

## How it runs

`gh-p` is a **bash shebang loader** — not a compiled binary.

```
gh-p          # tiny bash script: exec bun index.ts "$@"
index.ts      # all logic lives here (#!/usr/bin/env bun)
```

The `gh-p` file delegates to Bun at runtime. This keeps the repo small and means edits to `index.ts` take effect immediately with no build step.

**Do not use `bun build --compile`.** It embeds the entire Bun runtime (~58 MB) into a binary. There is no reason to do this — Bun is already installed on the host.

## Install / update

```bash
# First install
gh extension install /path/to/gh-p

# After editing index.ts — nothing needed, changes are live immediately
```

## Commands

```
gh p init                                                Interactive setup
gh p sync                                                Refresh cached field/option IDs
gh p add <alias> <issue> [--status <s>] [--priority <p>] Add issue to project
gh p status <alias> <issue> <name>                       Set issue status
gh p priority <alias> <issue> <name>                     Set issue priority
gh p list <alias> [options]                              List project items
gh p statuses <alias>                                    Show available status options
```

### `gh p list` options

| Flag | Description |
|------|-------------|
| `-b` / `--brief` | Number + title only (no status/timestamp) |
| `--all` | Include statuses excluded by default (e.g. Done) |
| `--status <s>` | Filter to a single status |
| `--exclude <s>` | Comma-separated statuses to exclude (stacks on project defaults) |
| `--repo` | Show repo short-name column |
| `--sort updated\|created\|number` | Sort order (default: updated) |
| `--since <age>` | Only items updated within age (e.g. `1d`, `4d`, `1w`, `6h`) |

## Config

Cached at `~/.config/ghp/config.json`. Run `gh p init` to set up, `gh p sync` to refresh.
