# Overview

The npm package name is `promptobus`. Version in `package.json` is `0.3.0`. License is MIT. Node.js `>=20`.

That number is written out by hand, and the suite compares it to `package.json` (`test/promptobus-package.test.mjs`): it moves in the commit that cuts a release, and in no other. A reader who needs the version of the tree in front of them asks the tree — `promptobus --version` prints it without a host file.

## Entry points

| Path | What it is |
|---|---|
| `bin/promptobus.js` | CLI. Help and `--version` use a thin host. Other commands load `createStandaloneHost`. |
| `lib/cli.js` | `runPromptobus(argv, { host, … })`. Host is required. |
| `src/index.ts` → `.` | Protocol, store v1, MCP factory, driver contract, host types, standalone host |
| `src/host-index.ts` → `./host` | Host contract only |
| `src/hooks.ts` → `./hooks` | Hook planner |
| `src/driver.ts` → `./driver` | Driver contract |
| `lib/cli.js` → `./cli` | Command parser |
| `schemas/v1/*.json` → `./schemas/*` | Task, participant, message, artifact schemas |

`src/` is TypeScript. `npm run build` emits `dist/`. `lib/*.js` is the JS runtime and the three harness drivers.

## Store home

Default store directory name: `.promptobus` (`src/v1/layout.ts` `ROOT_DIR`). The standalone host places it under the workspace root (`src/host.ts` `homeOfRoot`). `PROMPTOBUS_HOME` overrides the path for a process that already knows the home (`lib/store.js`).

Layout of one task:

```
.promptobus/tasks/<task-id>/
  task.json
  messages/
  intents/
  inbox/<participant-id>/
  history/<participant-id>/
  blobs/
  artifacts/
  files/
```

`files/` is the folder a person opens, and it holds two kinds of file: artifacts that arrived through the bus — hard links to their blobs under the names they came with — and what the mechanism puts there itself, the `review` diff (`review-<worker>.diff`) and the `spawn` brief (`brief-<worker>.md`). A taken name is never overwritten: the next file of that stem takes the following number (`brief-<worker>-2.md`).

Sidecar files the CLI writes (warden, wake, health, worker catalogs) sit in the same task directory. The engine API does not own them.

## MCP tools

Declared in `src/mcp/tools.ts` and listed in `lib/contract.js` as `PROMPTOBUS_TOOLS`:

- `promptobus_send`
- `promptobus_mailbox`
- `promptobus_task`

Each accepts an optional `task` id. Without it the server uses `PROMPTOBUS_TASK`, else the session binding, else the only active task.

`promptobus mcp` is JSON-RPC 2.0 over stdio (`lib/server.js`). Protocol versions the server accepts: `2025-06-18`, `2025-03-26`, `2024-11-05` (`lib/contract.js`).
