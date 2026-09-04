# Install

Two steps. The first puts the package on disk. The second writes project-level hooks. npm `postinstall` does not edit harness files.

## 1. Package

Node.js 20 or newer.

From a clone:

```bash
npm install
npm run build
node bin/promptobus.js --version
```

The command must print `promptobus 0.1.0`.

As a dependency:

```bash
npm install promptobus
```

The CLI entry is `bin/promptobus.js` (`package.json` `bin.promptobus`).

## 2. Workspace file

Create `promptobus.json` at the workspace root:

```json
{
  "tools": ["claude", "cursor", "codex"]
}
```

List only harnesses this workspace will spawn. `--harness` checks this list. The standalone host walks up from the current directory to find the file. The store is `.promptobus/` beside it.

## 3. MCP server for the orchestrator

Spawn writes an MCP entry for each worker and reviewer. The orchestrator session needs the same stdio server.

```json
{
  "mcpServers": {
    "promptobus": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/bin/promptobus.js", "mcp"],
      "env": {
        "PROMPTOBUS_HOME": "/absolute/path/to/workspace/.promptobus"
      }
    }
  }
}
```

If `promptobus` is on `PATH`, `command` may be `promptobus` and `args` may be `["mcp"]`. The server name must stay `promptobus`: hook matchers and tool names use it (`lib/contract.js`, `src/hooks.ts`).

Where that JSON lives is the harness's project MCP file. Do not put it in `~/.claude`, `~/.cursor`, or `~/.codex`. Those home catalogs are out of scope for this installer.

## 4. Project hooks

```text
promptobus install --harnesses claude,cursor,codex
promptobus install --check
promptobus install --dry-run
promptobus uninstall [--harnesses claude,cursor,codex]
```

| Flag | Effect |
|---|---|
| `--harnesses <list>` | Comma-separated `claude`, `cursor`, `codex`. First install stores the choice in `promptobus.json`. A later call without the flag reuses that list. A new list replaces the old one and removes owned hooks of a dropped harness. |
| `--dry-run` | Print the plan. Write nothing. |
| `--check` | Report drift. Exit non-zero if project files no longer match. Do not repair. |
| `uninstall` | Remove owned Promptobus records only. Foreign groups and unknown fields stay. |

`--harnesses` may name one harness or several. Install each alone or all together.

The first install saves the harness list in `promptobus.json`. Later calls without `--harnesses` read it from there.

### What the installer writes

| Harness | Project file | Bus feedback | Loop guard |
|---|---|---|---|
| Claude Code | `.claude/settings.json` | `PostToolUse` on `promptobus_send` / `promptobus_mailbox` | `Stop` |
| Cursor | `.cursor/hooks.json` | `postToolUse` with `additional_context` | `stop` |
| Codex | `.codex/hooks.json` | `PostToolUse` with `systemMessage` | `Stop` |

The runner script is generated under `.promptobus/hooks/` (`src/standalone.ts` `busHookRel()`). Cleanup of a run must keep that directory.

Merge keeps foreign hook groups, foreign settings, and unknown fields. Promptobus recognises its own records by a stable command and matcher. `uninstall` removes only those records.

A malformed or shared config file fails the command. The installer does not write a partial file.

### Two install levels

1. `promptobus install` configures orchestrator hooks in the consumer repository.
2. The driver writes a `Stop` hook into each participant worktree when it starts the session.

### After install

The CLI reports `configured` and prints what to verify. Then trust the project hooks in the harness. See [hooks-and-trust.md](hooks-and-trust.md).

## What this guide does not claim

`promptobus install` / `uninstall` are the documented command form. Confirm they are present in the CLI you are running (`promptobus help`). This tree's help lists `spawn, review, status, done, dismiss, history, prune, guard, warden, mcp` until the installer lands.
