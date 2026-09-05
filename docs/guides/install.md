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

It prints `promptobus` and the version in `package.json`. No version is written out here: a number in a guide drifts at every release with nothing to catch it.

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

`tools` is the spawn allow-list. `--harness` checks this list (`lib/spawn.js`). The standalone host walks up from the current directory to find the file. The store is `.promptobus/` beside it.

Adding a harness to that list is a hand edit of this file. There is no `tools` subcommand, and an undeclared `--harness` is refused with the file and the field named. Run `promptobus install` after the edit.

`promptobus install` writes a second field, `harnesses`: the last installed hook list. Do not invent that field by hand on the first install. Pass `--harnesses` instead.

### A repository that generates its process skills

A worker repository may have its own `promptobus.json` — separate from the workspace one — with an optional `generate` field: the argv of a command that restores the process skills the repository does not keep in git.

```json
{ "generate": ["npx", "--yes", "github:owner/tool", "init"] }
```

`spawn` runs it in the fresh worktree after the checkout, and the participant preamble says whether the skills were laid out. It runs **before** dependencies are installed, so the worktree has no `node_modules`: an `npx …` generator works, an `npm run …` one does not. **Ignore what it generates** — files git can see leave the worker's branch dirty from its first second, and `promptobus done` never sweeps a dirty worktree; the lift warns when it finds them. Skills committed to git stay the default: a repository that has them in the checkout declares nothing. Details in [reference/03-cli](../reference/03-cli.md) § Spawn.

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
| `--harnesses <list>` | Comma-separated `claude`, `cursor`, `codex`. Required on the first install. Saved as `harnesses` in `promptobus.json`. A later call without the flag reuses that list. A new list replaces the old one and removes owned hooks of a dropped harness. |
| `--dry-run` | Print the plan. Write nothing. |
| `--check` | Report drift. Exit 1 if project files no longer match. Do not repair. On a clean tree prints `configured` and exits 0. |
| `uninstall` | Separate command. Removes owned Promptobus records only. `--check` is not supported. |

`--harnesses` may name one harness or several. Install each alone or all together.

### What the installer writes

| Harness | Project file | Bus feedback | Loop guard |
|---|---|---|---|
| Claude Code | `.claude/settings.json` | `PostToolUse` matcher on `promptobus_send` / `promptobus_mailbox`; runner field `systemMessage` | `Stop` and `SessionStart` |
| Cursor | `.cursor/hooks.json` (`version` 1) | `postToolUse` with `--output additional_context` | `stop` |
| Codex | `.codex/hooks.json` | `PostToolUse`; runner field `systemMessage` | `Stop` and `SessionStart` |

The runner script is generated under `.promptobus/hooks/` (`busHookRel()`). Ownership ids are stored in `.promptobus/manifest.json` (`installManifestRel()`). Cleanup of a run must keep `.promptobus/hooks/`.

Merge keeps foreign hook groups, foreign settings, and unknown fields. Promptobus recognises its own records by a stable command and matcher. `uninstall` removes only those records.

A malformed or shared config file fails the command. The installer does not write a partial file.

### Two install levels

1. `promptobus install` configures orchestrator hooks in the consumer repository.
2. The driver writes a `Stop` hook into each participant worktree when it starts the session.

### After install

The CLI prints `configured` and then:

```text
Review: Codex requires /hooks; project hooks also depend on workspace trust.
```

Trust the project hooks in the harness. See [hooks-and-trust.md](hooks-and-trust.md).

`promptobus help` lists `install` and `uninstall` with the flags above; it is the same list this guide describes.
