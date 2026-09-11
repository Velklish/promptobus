# PB-173 · Remove the PostToolUse feed hook: the orchestrator does not need its own calls echoed back

- **Order:** 15
- **Scope:** `src/hooks.ts` (`BUS_HOOK_EVENT`, `BUS_HOOK_MATCHER`, `busHookSettings`,
  `busHookCommand`), `templates/bus-hook.mjs`, `lib/install.js`, `src/mcp/render.ts`,
  `test/host.test.mjs`, `test/promptobus-host.test.mjs`, `test/promptobus-package.test.mjs`,
  README (both languages), [03-cli](../../reference/03-cli.md),
  [hooks-and-trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Owner's decision of 2026-09-12: the hook goes. What it produces in a session looks like this,
once per bus call:

```
Claude Code notice
PostToolUse:mcp__promptobus__promptobus_send says: Sent task → Worker: Надзиратель: переключатель
до участника и три… — **Новое правило владельца, действует с этой минуты и во всех репозиториях
```

The orchestrator is shown an excerpt of the message it has just written itself, on every send.
Over a run of four participants that is one notice per exchange, and none of them carries
anything the caller did not have a moment earlier.

**Removing it costs the mechanism nothing**, and the template says so itself: the hook is "one
session-feed line per exchange event", written for a person watching the feed. None of the
working machinery runs through it —

- the turn is returned by the **`Stop` guard** (`GUARD_HOOK_EVENT`, `promptobus guard`), a
  separate hook that stays;
- unread counts reach the caller in the **MCP reply itself** ("your mailbox: unread N");
- delivery to a participant is the **warden's**, over its own channel.

So the subject is a feed line and nothing else.

## Work to do

- Remove the hook from the planner, the installer and the template, and make `uninstall` —
  and a re-run of `install` — take the already-written entry out of `.claude/settings.json`,
  `.cursor/hooks.json` and `.codex/hooks.json`. A workspace that installed it once must not
  keep it after an upgrade: leaving it is the same noise with nothing to regenerate it.
- Keep foreign hooks and unknown fields in those files untouched, as the installer already
  does.
- Leave the `Stop` guard exactly as it is. A change that touches the guard is the wrong change.
- Documentation in the same pass: both READMEs describe "bus feedback after each bus tool
  call" as one of two installed hooks, and the reference and the hooks guide name it as well.

## Out of scope

- The warden and its notifications.
- The MCP reply text, including the unread-count line — that is the channel that replaces the
  hook, not a second copy of it.

## Verification

- After `install` on a clean workspace, the harness hook files carry the guard and no
  `PostToolUse` entry for the bus tools.
- After `install` on a workspace that already had the feed hook, the entry is gone and foreign
  hooks in the same file are untouched.
- A bus call produces no session notice; the turn is still returned while mail is unread.
