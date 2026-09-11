# PB-167 · Raise the backslop pin so the gates runner the Definition of Done names actually exists

- **Scope:** `backslop.json`, `AGENTS.md`, the generated adapter output, [contributing](../../guides/contributing.md)
- **Created:** 2026-09-12
- **Dependencies:** none
- **Taken:** 2026-09-12

## Context

`backslop.json` pins `0.4.0`. That version has no `gates` runner: `npx github:Velklish/backslop#v0.4.0 gates` answers `unknown command "gates"` and exits 1, and its `help` lists `init, new, mv, archive, adr, status, lint, upgrade, migrate, changelog, version, help`. The `gates` key IS in `backslop.json` and names three commands — on this pin it is a declaration nothing executes.

The brief generator prints a Definition of Done that requires the summary `gates N, green N`. Two workers on consecutive days — runs 0911e and 0912a — hit the same unusable step, spent a turn diagnosing it, and each ran the three commands from the `gates` key by hand instead. Both refused to invent the summary line, correctly: a fabricated summary is worse than none, because it looks like a gate.

The generator side is filed as `BS-51` in backslop's own tracker. This card is the consumer side, and the owner decided on 2026-09-12 to raise the pin rather than wait.

The repository's own rule stands and is the reason this is a card rather than a side effect: upgrade happens "when you decide to, not because of someone else's commit". The decision has been made; this card carries it out.

## What to do

- `npx github:Velklish/backslop#v0.6.0 upgrade` — it bumps the pin in `backslop.json` and in the `gates` commands, runs `migrate` and re-runs `init` at the new version.
- Read what `migrate` changed before committing: the layout version is a field in `backslop.json`, and a format migration may touch card files. A diff that touches cards is not automatically wrong, but it must be looked at rather than trusted.
- Verify the point of the exercise: `npx github:Velklish/backslop#v0.6.0 gates` runs and prints the summary, and the three commands it counts are the same three the key named before.
- Check what the new version's `lint` says. Later versions carry more checks than `0.4.0`, and some may be red on a layout that was written for the old one. Red lines are a finding, not a reason to roll back: report them, fix the cheap ones, file the rest.
- `AGENTS.md` of this repository names the pinned version in its backslop block and in the command strings of every step. Those strings go with the pin.

## Out of scope

- The generator's behaviour on old pins — `BS-51` in backslop.
- Any card content beyond what `migrate` itself rewrites.

## Checks

- `npx github:Velklish/backslop#v0.6.0 gates` exits 0 and prints `gates N, green N`.
- `npm test`, `backslop lint` and `npm run audit` each exit 0 on their own, and the summary counts those three.
- No command string in `AGENTS.md` still names the old pin.
