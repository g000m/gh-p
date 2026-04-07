# gh-p

A [GitHub CLI](https://cli.github.com/) extension for managing [GitHub Projects (V2)](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects) from the terminal.

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated with the necessary project permissions
- [Bun](https://bun.sh/)

## Installation

```bash
gh extension install g000m/gh-p
```

## Setup

Run the interactive setup to connect your GitHub Projects:

```bash
gh p init
```

This prompts you for a GitHub org or username, lists all their projects, and lets you assign a short **alias** (e.g. `myapp`) and a default **repo name** to each one. Configuration is saved to `~/.config/ghp/config.json`.

To refresh project IDs and field options after making changes in GitHub:

```bash
gh p sync
```

## Usage

```
gh p <command>
```

| Command | Description |
|---|---|
| `init` | Interactive setup — register projects from any owner |
| `sync` | Refresh cached IDs and field options from GitHub |
| `add <alias> <issue> [--status <s>] [--priority <p>]` | Add an issue to a project, optionally setting status and/or priority |
| `status <alias> <issue> <name>` | Set the status of an issue |
| `priority <alias> <issue> <name>` | Set the priority of an issue |
| `list <alias> [-v] [--status <name>]` | List project items (`-v` shows status column) |
| `statuses <alias>` | Show available status options for a project |

### Examples

```bash
# Add issue #42 to the "myapp" project with a status and priority
gh p add myapp 42 --status "In Progress" --priority P1

# Move issue #42 to "Done"
gh p status myapp 42 Done

# Set issue #42 priority to P0
gh p priority myapp 42 P0

# List all items in the "myapp" project
gh p list myapp

# List items, showing their current status
gh p list myapp -v

# List only items with status "In Progress"
gh p list myapp --status "In Progress"

# Show available status values for a project
gh p statuses myapp
```

## Configuration

The config file at `~/.config/ghp/config.json` stores project metadata (owner, project number, node IDs, field definitions). It is created by `gh p init` and updated by `gh p sync`. You generally do not need to edit it manually.
