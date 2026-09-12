# PB-169 · Result

**Closed on a recorded decision, and the rejected option is recorded with it.** The reviewer is
given no second immovable artefact; the resolution stays with the orchestrator. Three reasons,
written into `03-cli` § Review so the option is not re-proposed as new: the candidate closes the
discrepancy only on the diff's own paths while the prompt sends the reviewer into the working
copy far wider — call sites, neighbouring code, tests; it costs 13.6× the bytes in the budget
that matters, measured on a seven-file branch at 22 422 bytes of diff against 306 067 bytes of
full `HEAD` content, written on every review and re-review; and it guards a report the prompt
already forbids, since on a contradiction the reviewer files no finding at all.

Two further lines make it a decision rather than an omission: the read-only guarantee is not
spent on resolution — `Bash` stays in `REVIEWER_DENY` — and what the orchestrator already holds
is named, the exact `git show <sha> -- <path>` inside the report and `review --task` to
re-snapshot. ADR-009 carries the same, with a Revisit clause: the first reason rests on the
prompt sending the reviewer beyond the diff, and a prompt that narrowed to the changed paths
would change the trade.

Verified: the byte ratio by measurement on a real branch; the rest is a decision, and is written
as one.

Outside the card: the ordering rule "worker finishes first, then reviewer" — the consumer's, and
needed whatever the reviewer is handed.

---
