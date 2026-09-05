# PB-1.1 · Result

**Closed 2026-09-05.** Completed by the approver. The package must not print a command it cannot name: the group-address refusal in `lib/spawn.js` now says to name one repository of the group (`<group>/<name>`) and that this command does not clone one — no command, no host hint; the message gate in `test/cli.test.mjs` keeps no exception list.

**Verification.** `test/cli.test.mjs` 4/4; probe, commit-first: the old `formatNpx(['clone', …])` text restored → the gate red. Gates re-run on `main` by the approver.

**Documentation in the same pass.** Not required beyond the message itself; `CHANGELOG.md` carries the PB-1 entry.
