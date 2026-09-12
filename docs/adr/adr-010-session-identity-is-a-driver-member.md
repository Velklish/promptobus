# ADR-010: Session identity is a driver member, injected into the core, and a contested answer is refused

**Status:** Accepted
**Date:** 2026-09-12
**Deciders:** the run's orchestrator, under the owner's standing mandate of 2026-09-12 — "decide the forks yourself and record them as ADRs with the rejected options". **Not reviewed by the owner**: this line says so because an ADR outlives the night it was written in, and a decision recorded under someone's name is read later as theirs.

## Context

Every other harness fact is a driver member — permission modes, effort levels, dropped
variables, deny list, knock channel, default model. Identity was not. The harness-neutral
core read one harness's variable directly:

```js
// lib/store.js, until this decision
sessionIdentity = env.CLAUDE_CODE_SESSION_ID?.trim() || null
```

It is not a corner. `grep -ho "sessionIdentity(" lib/*.js | wc -l` → **23 calls across 8
modules**, and `grep -n "identity\|sessionId" lib/drivers.js` → nothing. Task ownership,
`claim`, the warden's claim and the loop guard all hang off that one line.

**What it actually returned, measured 2026-09-12 on live participants.** The answer is worse
than "empty for other harnesses", and the two halves were measured from opposite ends:

| Path | What the old reader returned |
|---|---|
| a command the participant runs (its shell) | **a wrong id — its orchestrator's.** A Codex participant's environment carries `CLAUDE_CODE_SESSION_ID` from the parent, because the Codex `SESSION_ENV_DROP` drops only `CODEX_HOME`. Measured from inside a live participant's worktree: the id printed was the orchestrator's. |
| the participant's own MCP server | **nothing at all.** codex-cli 0.146.0 hands an MCP server child eleven variables — `HOME LOGNAME PATH PWD SHELL SHLVL TERM TMPDIR USER _ __CF_USER_TEXT_ENCODING` — and not one is `CODEX_*` or `CLAUDE_CODE_*`. Measured free, with `thread/start` into a synthetic `CODEX_HOME` whose only MCP server dumps its environment. |

So one function returned a **wrong** value on one path and **empty** on the other, and both
paths call it. The leak itself is a separate decision (PB-182); what this one settles is that
the core must stop guessing.

**All three harnesses do name themselves**, each in its own variable:
`CLAUDE_CODE_SESSION_ID`, `CURSOR_CONVERSATION_ID` (measured in cursor-agent 2026.09.10 —
`local-exec:shell-core` sets it for the shell tool and deliberately keeps it out of persisted
environment snapshots), `CODEX_THREAD_ID`. The member is not invented; it is taken out of
where the drivers already knew it.

## Decision

**1. `DriverOptions.identityVar` — the variable a harness uses to name its own session, or
`null` when it has none.** It sits beside `knockChannel` and `envDrop`, where the rest of the
harness vocabulary lives. A driver with nothing to offer declares `null`, and the core says so
rather than returning a plausible value.

**2. The member answers for ONE path — a command the session runs — and says so.** It does
not answer for an MCP server child, whose environment a harness may scrub entirely. Folding
the two paths into one member would bake the measured divergence above into the contract.

**3. A contested answer is refused, not broken.** `resolveSessionIdentity` returns the id when
exactly one declared variable is set; `null` with a reason when none is; and `null` with a
reason naming **both claimants and their variables** when two are. Picking one would be
today's defect with extra steps — the leaked pair is precisely the live participant's shape.
The refusal is warned once per process, so the leak is readable from the message. An
environment that names no harness is a legal state and is not warned about: its reason stays
on the resolver's `why` for a caller that shows it.

**4. The resolver is INJECTED into the core, not imported by it, and the injector is the
registry itself.** `lib/drivers.js` binds it with `bindSessionIdentity` at import — the shape a
driver already uses to bind participant-home removal into the session store — so whoever loads
the registry can answer, which is the honest condition: the answer comes from the drivers, and
without them there are no drivers to ask. `lib/cli.js` binds it explicitly as well, beside the
`bindHarnessHomes` binding that is there for the same reason, because its command modules are
imported dynamically and not all of them load the registry (`dismiss` reaches only the store).
Unbound, the core answers `null` and says once that no registry is bound — it never falls back
to reading a variable itself, because that fallback is the defect this decision removes.

## Alternatives considered

**The core imports `lib/drivers.js` directly.** Rejected on a measurement, not a preference:
it loads when `store.js` is the entry module and dies when a driver module is —
`ReferenceError: Cannot access 'CLAUDE' before initialization` at `lib/drivers.js:26`, taking
`promptobus-adapter.test.mjs` and `promptobus-driver-cursor.test.mjs` down before their first
check. Every driver imports `store.js`, so the back edge is unavoidable.

**Moving `sessionIdentity()` out of `store.js` entirely**, so the new module may import the
registry and no cycle exists. Correct, and still the end state. Not taken in one pass because
nine sites in `store.js` default to it (`146, 444, 464, 535, 784, 812, 822, 829, 1193`), and
removing the default pushes the value out to callers in modules held by other work in the same
run. The binding above is not a cheaper substitute for that move — it is the same behaviour
with the fallback removed, which is the part that mattered.

## Consequences

- `status` can show an owner, and `claim` can refuse a foreign session, for a session of any
  declared harness rather than one — on the path where the harness names itself.
- A leaked ancestor identity now produces a named refusal instead of a confident wrong answer.
  Ownership stays unestablished for such a session until the leak is removed, and that is the
  honest state rather than a regression.
- A process that reaches `store.js` without loading the driver registry gets `null` and one
  warning. The full suite found four such paths on the first run — three modules that reach the
  store without the registry, and a child process standing in for an adapter CLI — which is the
  suite doing what it is for: a path with no drivers loaded cannot name a harness, and the core
  says so instead of papering over it.
- A fourth harness declares one field and needs no change in the core.
