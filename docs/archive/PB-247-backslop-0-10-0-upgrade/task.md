# PB-247 · backslop pin v0.9.0 → v0.10.0: backlog README from the template, pins outside markdown, rule restatements

- **Scope:** [guides/contributing](../../guides/contributing.md), `backslop.json`, `docs/backlog/README.md`, `test/gate-record.test.mjs`
- **Created:** 2026-09-23
- **Dependencies:** none
- **Taken:** 2026-09-23

## Context

backslop v0.10.0 is out (2026-09-22) and the repository is on v0.9.0. A trial `upgrade` on a local clone on 2026-09-23 exited 0: the pin moved in `backslop.json`, in ten live files (among them `package.json`, `.github/workflows/ci.yml`, `docs/guides/contributing.md`), and the migration created an empty `docs/archive/LOG.md`. `lint` v0.10.0 on the current tree exits 0.

`upgrade` does not rewrite `docs/backlog/README.md` — `init` leaves an existing file in `docs/` alone (BS-72 in backslop) — while the refreshed `AGENTS.md` block already names `fold N` and `--restore`. The file differs from the v0.10.0 template by 50 diff lines. The previous pin also lived in `test/gate-record.test.mjs`, which `upgrade` does not touch, and `npm run pins` went red on it.

## Work to do

- `npx github:Velklish/backslop#v0.10.0 upgrade`.
- Rebuild `docs/backlog/README.md` and `docs/archive/README.md` from the v0.10.0 template, keeping this repository's own additions.
- Move the pins `upgrade` does not see — `test/gate-record.test.mjs` and anything `git grep -n "backslop#v0.9.0"` still finds outside historical files.
- Check texts that restate the tracker's rules against v0.10.0: evidence is required for a minor finding, stubs in `triage/` no longer fail `lint`, closure is `archive` then `fold`, the saved "Previous order" and `mv --restore`, and the `when` scope of a gate.
- Declare the `probe` field in `backslop.json` with the repository's mutation probe command.
- CHANGELOG under Unreleased.

## Out of scope

- Folding the archive — PB-248; re-triaging open cards — PB-249.

## Verification

- The `backslop.json` gates on the new pin: how many, how many green, the exit code of each.
