# PB-181 · Result

**Closed 2026-09-12, completed.** The rule was kept and its false justification replaced by a
measurement.

The Cursor participant's prompt asserted that `AskQuestion` "gets a skip". Measured on a live
background participant: the question is neither answered nor skipped — **the turn HELD for
278.497 s** and ended when a person pressed Escape; no upper bound was found. The rule "do not ask
questions" stands; its reason is now true. A second item was added for `SwitchMode`: with no person
it returns `Mode switch was rejected by the user. Do not attempt to switch modes again.` in under a
second, and the participant is told to read that as the harness answering for an absent person
rather than as an instruction from one.

**Verification.** The clock measurement the card asked for; `promptobus-driver-cursor` 119/119;
`npm test` 62/62 files on the merged tree. The human-visible route for a held dialogue was repaired
in the same pass: it repeated the same falsehood and additionally promised that "the message will
arrive on the next turn", which is wrong while the turn is held — a held turn holds the message
with it.

**Documentation in the same pass.** The participant prompt and the driver reference carry the
measured behaviour instead of the skip claim.

**What the card does not close.** Its second verification item — that a held dialogue is
distinguishable from a running turn without a person attaching to the panel — is reached only as
far as the watchdog verdict gives it: three liveness signals are silent, and the verdict now NAMES
a held dialogue as one of the causes. There is no separate detector, and one was deliberately not
built (`PB-183`).
