# PB-5 · Host answers which clone a directory belongs to: cloneOf replaces reposRoot and the pair gate

- **Scope:** [02-host](../../reference/02-host.md)
- **Created:** 2026-09-05
- **Dependencies:** none
- **Taken:** 2026-09-05

## Context

The review gate asked the host for one `reposRoot()` and walked the tree itself: from that root down to the first `.git`, then required a two-segment namespace (`need-pair`). That is one zone's layout baked into the package. The first consumer grew a second zone (`external/<repo>` beside `repos/<group>/<repo>`) and the package could neither find a clone there nor word the refusal — the host had no say in what a clone is. Standalone keeps its shape — clones below the root, the root itself is never a clone — but now says so in its own `cloneOf`.

## Work to do

- `cloneOf(abs): HostClone | null` replaces `reposRoot()`: the host names the clone root and its `nsPath`; the package never walks a zone.
- Drop `need-pair` and `cwd-need-pair` from `reviewLayoutError`: a host that wants a pair says so in `no-clone` / `cwd-outside` text.
- Standalone `cloneOf`: the first `.git` below the root, `nsPath` `/`-joined from the root, as the old walk did.

## Out of scope

- Consumer-side zones — the ATI host implements `cloneOf` on its side.

## Verification

- Standalone host: `cloneOf` of a nested clone, of a group folder, of the root, of a directory outside — one answer and three `null`s.
- Review refusals `outside the workspace` / `clone not found` unchanged on the planted fixture; no pair refusal remains in the package.
