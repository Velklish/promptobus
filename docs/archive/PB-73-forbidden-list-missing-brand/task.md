# PB-73 · Publicity gate's FORBIDDEN list has no bare-brand entry, so `atiRouting` (lib/store.js), the "ATI implementation" comment (src/host.ts → dist/host.d.ts), and two literal ati-workspace-<hash> ids (live-canary.mjs) ship in the public tarball while `npm run audit` reports clean

- **Scope:** `scripts/audit-public.mjs`, `lib/store.js`, `src/host.ts`, `scripts/live-canary.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-101
- **Taken:** 2026-09-10

## Context

scripts/audit-public.mjs:20-27 defines `FORBIDDEN` as seven entries — the origin forge host, the origin CLI name, two package scopes, the env prefix, the memory-service name, and the tracker-id pattern — each assembled from fragments so the gate itself doesn't contain the literal strings. None of the seven matches the bare company brand on its own.

Run live against the current tree (v0.5.0, HEAD cc1aca8): `node scripts/audit-public.mjs` exits 0, "publicity audit: clean · 438 tracked files and the packed tarball" (117 entries, confirmed to include both files below), while three leaks of the bare brand ship inside that same tarball:
- lib/store.js:186 `export function atiRouting(sender, recipient) {` — live code, not dead: called at :210 and :892, and lib/store.js is required by roughly a dozen other lib/*.js modules, so it ships and runs.
- src/host.ts:78 `* happened at the extract: the ATI implementation returned \`path\`, consumers` — compiled straight into the shipped type declarations at dist/host.d.ts:59, identical text.
- scripts/live-canary.mjs:286-287 name two literal captured ids in a comment: `ati-workspace-005c0315` and `ati-workspace-d6c0cbf8`.

This matches the repo's own established pattern for this gate: PB-23.1, PB-34.2, PB-35.1 and PB-38.1 (all archived) are each a prior missing-FORBIDDEN-entry finding, closed by adding the entry and fixing the leak it caught. Grep of docs/backlog and docs/archive for `atiRouting` or a bare-brand entry finds no existing coverage of this specific gap.

## Work to do

- Add a `FORBIDDEN` entry for the bare brand, assembled from fragments the same way the other seven are (e.g. `['origin brand', ['A','TI'].join('')]`), with a word-boundary or context check in the scan so it doesn't flag ordinary English words that happen to contain the fragment.
- Rename `atiRouting` (lib/store.js:186, and its call sites at :210 and :892) to a name the glossary's routing vocabulary already covers, and stop exporting it if nothing outside lib/store.js needs it.
- Reword src/host.ts:78 to something like "the consumer's implementation returned `path`" and rebuild `dist/` so dist/host.d.ts picks up the change.
- Rewrite scripts/live-canary.mjs:286-287 to describe the id shape (`ati-workspace-<hash>`) without the two literal captured ids.

## Out of scope

- A general word-boundary or false-positive guard across all seven existing FORBIDDEN entries — only the new bare-brand entry needs one, since it's the entry most likely to collide with ordinary English.
- A manual sweep of prose docs (README, guides) for the brand — scripts/audit-public.mjs already scans `.md` files under TEXT; this entry is about the FORBIDDEN list gaining the entry, not a hand audit.

## Verification

- With the new FORBIDDEN entry added and before the three fixes land, `node scripts/audit-public.mjs` exits non-zero and names all three hits (lib/store.js, src/host.ts / dist/host.d.ts, scripts/live-canary.mjs).
- After the three fixes, `node scripts/audit-public.mjs` exits 0 again ("publicity audit: clean"), and `npm pack --dry-run` still lists lib/store.js and dist/host.d.ts with their existing sizes roughly unchanged.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `scripts/audit-public.mjs:20`, `lib/store.js:186`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Separate verified packed-file findings from script-only material: scripts/live-canary.mjs is not shipped by the package files list. It is a tracked-source finding, not a tarball leak. Match identifiers and standalone brand words without false positives in ordinary English.
