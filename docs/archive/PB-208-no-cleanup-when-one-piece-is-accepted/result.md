# PB-208 · Result

**Closed 2026-09-16, completed.** The card was found unmerged: four commits sat in the run-0913a worktree since 2026-09-14 02:51 while `main` moved eight commits ahead. `promptobus sweep <address>` now cleans up after ONE accepted participant and leaves the task active — its artifact records, blobs and files, its worktree, its `mcp-config` and `settings`, its temporary home. The right to sweep is proven positively (`requireSweeper`: the task mailbox owner, or an approver of this task holding its own recorded session; no identity is a refusal, not a pass), the refusal happens before any side effect, and the keep list is a check that throws rather than a comment (`takeAway` refuses a removal aimed inside a kept path; `childOf` refuses a record field that walks out of its directory). The decision is ADR-016.

**What the acceptance had to resolve.** The branch carried `ADR-015`, and `main` had meanwhile issued `ADR-015` to the approver lift. The branch's ADR was renumbered to `ADR-016` with its five references (`docs/README.md`, `docs/reference/03-cli.md` ×2, `CHANGELOG.md`, `lib/sweep.js`).

**Verification.** On the rebased branch at `555ce30`: `npx github:Velklish/backslop#v0.8.0 gates` exit 0 — gates 4, green 4 (`npm test` code 0, 67 files, 161 s; `backslop lint` code 0; `npm run audit` code 0, 931 tracked text files and 133 packed entries; `npm run pins` code 0). Merged into `main` as one commit (`--squash`), 15 files, 1436 insertions.

**Two reds found on the way, both outside this card and both fixed on `main` before the merge.** `promptobus-package.test.mjs` was red on `main` itself — `docs/reference/01-overview.md` still named 0.8.0 while `package.json` carries 0.9.0; proven by running the file standalone on `main` (exit 1) and twice on the branch (exit 1 each), green after the one-line fix. The publicity audit went red on a card edit made in the same pass that named the consumer's tracker id; fixed in `32cdd2a`.

**What is left open.** `PB-208.1` — removing a blob races a publication path that takes no lock. It arrived with this branch as a triage entry, was reviewed in this pass and put in the queue after `PB-217`: the window is narrow and unreproduced, and closing it means a decision about locking the hot path of every send.

**Documentation in the same pass.** `docs/adr/adr-016-…`, `docs/README.md`, `docs/reference/02-host.md`, `03-cli.md`, `04-protocol.md`, `README.md`, `README.ru.md`, `CHANGELOG.md`.
