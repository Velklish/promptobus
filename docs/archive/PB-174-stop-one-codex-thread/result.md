# PB-174 · Result

**Closed with a verb of its own, `promptobus stop <address>`, and the record is retired by the
driver rather than by the command.** Between `done`, which closes the whole task, and `dismiss`,
which touches the watch and never a process, there was nothing — which is why a run that needed to
stop one of two participants killed the holder by hand and freed 172 MB while leaving the registry
record reading `state: alive`.

The command takes the owner gate of `done` and `dismiss`, and refuses three addresses rather than
guessing: one that is not a participant of this task — the line names who is; the orchestrator,
which has no session this mechanism started, being the one that started the others; and an
`attached` participant, whose session is a person's own window `spawn` never owned. A participant
with no live session is not an error, an unconfirmed stop is not a success and says the record may
still read alive, and the watch is left untouched.

**The card asked the door to "retire its registry record", and it does — but not by doing it
itself.** `stop` calls `stopParticipant`, which dispatches to the driver's own `stop`, and that is
what retires the record: `dropSession` for Codex and Cursor, the registry entry leaving for Claude.
The command keeps no record-keeping of its own, deliberately: a second place that retired records
would drift from the first, and the hand `kill` leaves `state: alive` precisely because it goes
around the record's owner. Calling the driver instead of a signal is the whole fix.

**Verified**: `test/promptobus-stop.test.mjs`, 17/17, plus the neighbours the change could reach —
`promptobus-done` 32/32, `promptobus-dismiss` 26/26, `tmpdir-sweep` 37/37, `cli` and
`comment-length` exit 0. Each refusal is asserted twice, by its exit **and** by the driver not
having been called, because a refusal that returns non-zero after doing the work is not a refusal.
"The task is still alive" is asserted by the neighbour's address rather than by a participant
count — a count stays green while the record holds the wrong people. Three mutation probes, one per
promise: removing the `attached` refusal, turning "the task stays open" into "the task is over",
and reporting an unconfirmed stop as success each redden their own assertion and only theirs.

**Documentation the same pass**: `03-cli` § Status, done… — written into the existing paragraph on
what each command does to a process, including the correction of its own sentence saying no such
door exists; the Commands table in both READMEs; the help of all three commands, which now states
the boundary in one breath — `done` is the task, `stop` is one session, `dismiss` is the watch; the
CHANGELOG; ADR-012 for the form, with `dismiss --stop` and `done --only` rejected and why. The new
sandbox prefix went into the sweep list in the same commit rather than waiting for the gate to
demand it.

**Outside the card**: no live participant was stopped. The checks run against a stand-in driver, so
"the record goes with the process" is verified against the driver's contract and not against a live
Codex holder — which is what a stand can verify, and is stated rather than implied.

**The rule this leaves behind is larger than the command**, and it is recorded in `03-cli` and
ADR-012: an artefact written at birth — a registry record, a contact point file — is not erased at
death by anything but the mechanism that wrote it. Read liveness from the process, or from a sign
checkable from outside, and never from the artefact's own existence. PB-175 and PB-174 are two
instances of that one shape, and they are cured in different places for exactly that reason.
