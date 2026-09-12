# PB-167.1 · Result

**Closed with a local gate; the upstream half is a separate report.** `npm run pins`
(`scripts/check-pins.mjs`) is red when a tracked file names a backslop ref disagreeing with `cli`
in `backslop.json`. It reads the expected version out of that file and carries no literal pin of
its own. It skips exactly what `upgrade` skips — `CHANGELOG.md`, `docs/adr/**`, the task archive
and task cards — restated rather than imported, because the CLI arrives by npx and is not a
dependency. Wired into `package.json`, the `gates` key, and CI ahead of `backslop init`.

Verified by probes in both directions, each returning to green: a live file on `#v0.4.0` → exit 1
naming file, line, found and expected; **both** live files on `#main` together → exit 1 with two
lines, the case that passed the older semver-only form and passes the package test to this day,
since that test compares the two files with each other rather than with `backslop.json`; a
truncated `#v0.6` and a sha → exit 1 each; the four classes of excluded record rewritten to a
bogus ref → exit 0 with the historical counter moving, which is what shows they were seen and
set aside rather than missed; an unreadable tracked file → a finding, not a skip.

**The measurement that shaped the gate came from probing the gate itself.** Its floor — "a gate
that matched nothing is green for the wrong reason" — was decorative in the first version:
pointed at a spec no file in the tree carried, it reported `1 live pin(s) in 1 file(s)` and
exited 0, because `backslop.json` holds the very spec the gate reads and so matches itself
whatever the walk does. The floor now discounts the config, and that reason is in the code as two
lines and in the contributing guide in full.

Outside the card: the report to backslop asking `upgrade` and `lint` to reach beyond markdown —
the approver filed it. The contributing-guide paragraphs were written here and inserted by the
track that owns the file.

---
