# PB-239.1 · Result

**Closed 2026-09-22. Done, and the card's own diagnosis was wrong.** The publicity audit was red
because `scripts/audit-public.mjs:103` forbids the consumer CLI's name anywhere in a tracked file,
and PB-239 carried it **in its body** — the reproduction line quoting the passthrough command —
not in its slug or title, as this card claimed. The fix follows from that: the line now names the
passthrough without the consumer's product name, and nothing else changed.

**That also settles the fork this card raised.** The alternative — teaching the audit to skip
tracker cards the way `check-pins.mjs` skips `CHANGELOG.md` and `docs/adr/**` — would have made
every future card a legal place to name the origin's internals, which is the one thing the audit
exists to prevent. Removing the leak keeps the gate's meaning intact.

**Checks.** `npm run audit` — exit 0, `publicity audit: clean · checked 1011 tracked text files
and 136 packed text entries`; before the edit, the same command on the same tree exited 1 with
`✖ origin CLI name: docs/backlog/triage/PB-239-…`. `git grep -c` over the tracked tree for that
name now returns nothing.

**Still open.** PB-239 itself: `sweep` reporting an unknown session when the harness binary is
simply off the lifted session's `PATH`.
