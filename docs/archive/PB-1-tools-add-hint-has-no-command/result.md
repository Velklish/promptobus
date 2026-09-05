# PB-1 · Result

**Closed 2026-09-05.** Completed. The undeclared-harness refusal in `lib/spawn.js` no longer names a `tools add` command the package does not have (owner's decision: declaring a harness is a hand edit of `promptobus.json`); it names the manifest file and its `tools` array, and the only command left in it is the host's `syncHint()`. A gate in `test/cli.test.mjs` walks `lib/` recursively and requires every `formatCommand`/`busCommand`/`formatNpx` call with a literal command to name a `case` label of the dispatcher, with a sanity check that the reader finds real commands and a subdirectory. Track `cli` of the routing run, worker in Claude Code (opus, high, bypassPermissions), one isolated review round.

**Verification.** `npm test` exit 0 — 46/46 files; `cli.test.mjs` 4/4; the two driver tests assert the new wording. Probes, commit-first: the old message restored → red in two files; a reader that swallows every quoted string or finds nothing → red; a non-recursive walk → red. Gates re-run on the merged `main` tree by the approver.

**Documentation in the same pass.** `docs/reference/03-cli.md` § Spawn and the commands line (what the gate checks and what a host-assembled hint is not), `docs/guides/install.md` § 2, `CHANGELOG.md`. Finding filed: PB-1.1 (the group-address hint names a `clone` subcommand — the gate's single named exception).
