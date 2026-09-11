# PB-181 · Three Cursor dialogs behave three ways without a person, and the participant prompt describes one of them wrongly

- **Order:** 8
- **Scope:** `lib/driver-cursor.js` (the participant prompt), `lib/cursor-persist.js` (the stall
  verdict), [03-cli](../../reference/03-cli.md) § Status, [15](../../reference/15-warden.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Measured 2026-09-12 on a live background Cursor participant (`grok-4.6`, its own tmux server, no
person at the panel at any point). Three dialogs of the same harness, three different behaviours:

| Dialog | Without a person | Evidence |
|---|---|---|
| `SwitchMode` (approval) | rejected by a timer; the agent is told `Mode switch was rejected by the user. Do not attempt to switch modes again.` | panel footer `auto-rejects when the bar runs out`; the tool's own reply text |
| `AskQuestion` | **not rejected at all** — the turn is held until a key is pressed | 4 min 35 s of standstill, transcript stops growing, watchdog at 234 s |
| `Write` under `plan` | refused immediately, in words about markdown/canvas | the refusal text in full; `Shell` writes the same file, exit 0 |

**The `AskQuestion` measurement, by the clock.** `02:28:53` the participant calls it with two
options — the last record its transcript ever receives
(`~/.cursor/projects/…/agent-transcripts/15082a1e-….jsonl` stops growing there). The panel
renders a live dialog whose footer reads `↑/↓ option · ←/→ question · Space select · Enter
next/submit · Esc to skip` — **no countdown bar**, unlike `SwitchMode`. At `02:31:06`
`promptobus status` still says `session … is alive (a turn is running)`. At `02:32:47` the
stall watchdog fires: *the turn transcript has been silent for 234 s (threshold 180 s), no tool
processes under the pane, and nothing was written in the worktree for 829 s — none of the three
liveness signals answered*. At `02:33:28` a person presses `Escape` and the session resumes
immediately. **Four minutes thirty-five seconds, ended by a keypress and not by a timer.**

**What is wrong in this package.** The participant prompt written by the Cursor driver tells the
model:

> In this mode `AskQuestion` gets no answer — it gets a skip: the turn will end and the work
> will be left unfinished.

There is no skip. The rule it argues for — do not ask questions — is right; the reason it gives
is false, and the model reads the reason. A participant that believes a question degrades
gracefully will ask one; what it gets is a held turn.

**And `SwitchMode` is the opposite failure.** No person is present, yet the agent is told a
person refused, plus an instruction never to try again. Absence becomes an assertion, and the
session obeys it honestly. It is the same family as the Codex approval that turned a missing
person into a lost call, one step further along: there, silence lost the report; here, silence
speaks in a person's name.

**The watchdog is the good news and belongs in the reference.** It named all three liveness
signals with a number each, which is what separates "stalled" from "a long gate is legitimately
quiet". What it cannot do is name the *reason* — and for these two dialogs the reason is the
whole of the remedy.

## Work to do

- Correct the participant prompt to what is measured: a question is not skipped, it holds the
  turn until a key is pressed. Keep the rule; replace the reason.
- Decide what the mechanism does about a held dialog. It is detectable — the panel carries the
  dialog text — and today the stall verdict routes a person to attach without saying what they
  will find.
- Record the `SwitchMode` behaviour where a reader of the parity table will meet it: an approval
  a background session cannot answer resolves as `rejected by the user`, and the agent is told
  not to retry.

## Out of scope

- Cursor's own dialog design.
- The stall watchdog's signals, which worked: three signals, three numbers, one verdict.

## Verification

- The prompt's statement about `AskQuestion` matches a measurement, and the measurement is named
  beside it.
- A held dialog is distinguishable from a running turn without a person attaching to the panel.
