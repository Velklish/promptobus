# PB-177 · `install` writes `harnesses` and the standalone host reads `tools`, so `review` refuses right after a successful install

- **Order:** 130
- **Scope:** `lib/install.js`, `src/standalone.ts` (the `tools` read), the refusal text,
  [install](../../guides/install.md), README (both languages)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Found 2026-09-12 by a worker building a standalone stand for a live measurement — it hit this on
a clean workspace and reported it rather than working around it silently.

The sequence a person follows from the README is: create `promptobus.json`, then
`promptobus install --harnesses codex`. The install succeeds and writes `harnesses` into
`promptobus.json`. The very next command refuses:

```
promptobus review <subject> --harness codex
✖ … declared: none
```

because the standalone host reads a **different** key — `tools` (`src/standalone.ts:140`) — and
that one is still absent. The worker added `"tools": ["codex"]` by hand and went on.

**The two keys are genuinely different things**, and the installer already says so: `harnesses`
records which harnesses have hooks written, and it "is not the spawn allow-list". That part is
correct and documented. What is wrong is the shape of the experience around it: a command whose
whole subject is harnesses writes a harness list, and the next command says none are declared.

The refusal text does name the fix, which is why this is a papercut rather than a wall. But it
costs a person one failed command and one guess on every fresh workspace, and it costs them at
the exact moment they have the least idea which of two similar keys is which.

## Work to do

- Decide the shape: either `install` offers to declare the harnesses it installed for (asking,
  or under a flag), or the refusal names the key *and* the fact that `install` did not write it,
  so the reader understands why a successful install left them undeclared.
- Whatever is chosen, the two keys must be told apart in one place a person reads before
  running either command — the install guide, not only the reference.
- Keep them two keys. Merging them would make writing a hook file imply permission to spawn,
  which is a different decision and not this card's.

## Out of scope

- The spawn allow-list semantics of `tools`.
- The installer's own behaviour with foreign hooks and unknown fields.

## Verification

- Following the documented order on a clean workspace produces no refusal that the previous
  command could have prevented.
- A reader who meets the refusal can tell from it why a successful `install` did not satisfy it.
