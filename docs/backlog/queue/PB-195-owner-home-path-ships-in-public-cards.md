# PB-195 · Evidence cards ship the owner's absolute home path to a public repository, and the publicity audit has no rule for it

- **Order:** 15
- **Scope:** `scripts/audit-public.mjs`, [reference/README](../../reference/README.md)
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

`git remote -v` names a public GitHub repository. Eight tracked files under `docs/` carry an
absolute path of the shape `/Users/<owner login>/<workspace dir>/…` — six archived task records and
**two live queue cards**. Several of them spell out the full on-disk path of the private consumer
repository as well, and one quotes the contents of a live state file by absolute path.

`npm run audit` is **green** on exactly that tree: exit 0, 853 tracked files and the packed tarball,
publicity audit clean. The gate is not asleep — it has no rule for this. `FORBIDDEN` in
`scripts/audit-public.mjs` covers the forge host, the origin CLI name, the package scopes, the
environment prefix, the memory service, origin tracker ids and the brand; none of those matches a
home path. The brand rule that comes closest is narrowed twice over: `BRAND_ID` matches only the
`<brand>-workspace-<hex>` shape, and evidence cards (`docs/archive/`, `docs/backlog/`) are
explicitly exempted from it.

The exemption is deliberate and defensible for a **brand word** in a historical record. It was never
a decision about the owner's login, home layout, or the path of a repository this package must not
know about — those simply fall outside every rule and ride the exemption by accident.

This is not hypothetical publication: the files are tracked and pushed. The tarball is the narrower
surface (126 entries of 853 tracked files), so `npm` consumers see less than repository readers do —
which is why an audit that reasons only about the tarball would keep missing this.

## Work to do

- Add a rule to `scripts/audit-public.mjs` for an absolute home path — the shape, not one login —
  and decide explicitly whether evidence cards are exempt from it. State the decision in the file;
  the current exemption reads as covering more than it was written for.
- Sweep the eight files. An archived measurement stays valid when the path is reduced to its
  meaning: name the file relative to its root, or say `<workspace>/…`. Nothing of evidentiary value
  is lost — the login is not what the measurement showed.
- The two live queue cards matter more than the archive: they are still being read and copied from,
  so they reproduce the pattern into new cards.

## Out of scope

- The brand exemption itself for evidence cards. It is a separate decision with its own reasons.
- Anything about the private consumer repository beyond removing its path from this tree.

## Verification

- A red check: a fixture card carrying an absolute home path fails the audit, naming the file.
- A mutation probe aimed at the rule and not at the sweep: with the rule in place, re-introducing
  one such path into one card must redden **that** verdict. A green probe here condemns the check.
- `npm run audit` exit 0 on the swept tree, with the tracked-file count stated.
