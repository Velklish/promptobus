# PB-412 · Cursor driver on the Cursor SDK, after the decision on a Cursor API key

- **Scope:** [reference/05-drivers § Cursor: the persist session](../../reference/05-drivers.md#cursor-the-persist-session), `lib/driver-cursor.js`, `lib/cursor-persist.js`
- **Created:** 2026-10-29
- **Dependencies:** the owner's decision to provide a Cursor API key as a secret and to raise the Node floor
- **Cost:** minor

## Context

A consumer workspace's spike of 2026-09-03 found that `@cursor/sdk` 1.0.30 closes three gaps of the CLI path at once. The driver lifts a Cursor participant through `agent persist` in a tmux pane (`lib/driver-cursor.js`, `lib/cursor-persist.js`), and the SDK offers instead:

- `mcpServers` passed as an argument, in place of the three conditions the CLI path needs (a `.cursor/mcp.json` in the git directory plus `--approve-mcps`);
- `disallowedTools` with `askQuestion`, `shell`, `edit` and `delete`, in place of forbidding questions in the prompt and a deny list in `.cursor/cli.json`;
- `Agent.list` and `Agent.get` with a status and `run.cancel()`, in place of walking `~/.cursor/chats` and killing a process and collecting its orphan.

The price: `CURSOR_API_KEY` becomes a new secret (on a local IDE login the SDK does not work at all: `logged-out`); `engines.node >= 22.13` against `>=20` here (`package.json:32`); 49 MB of dependencies with native binaries against this package's no runtime dependencies; and a local agent lives in the host process without detaching. The spike ran no live SDK turn, because no key was set.

The CLI-path driver works today, and nothing depends on the SDK.

## Work to do

- After the owner decides to provide the key and raise the Node floor: a second spike with live SDK turns, then replace the internals of the driver's operations. The driver contract does not change its set of operations.

## Out of scope

- The CLI-path driver while the decision is not made.

## Verification

- The spike records live SDK turns: a lift with `mcpServers` as an argument, a refused `askQuestion`, `Agent.get` status and `run.cancel()`.
- The driver's existing suite passes on the SDK-backed operations.

## Deferred

- **Deferred:** 2026-10-29
- **Reason:** the SDK needs a new secret and a higher Node floor, and the first spike ran no live turn; the CLI path works.
- **Return condition:** the owner decides to provide a Cursor API key (where it comes from is named in the same decision) and to raise the Node floor to 22.13.
