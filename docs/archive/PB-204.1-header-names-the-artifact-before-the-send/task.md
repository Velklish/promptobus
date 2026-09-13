# PB-204.1 · The header must quote the landed artifact name, but it is composed before the send that reveals it

- **Order:** 45
- **Scope:** `lib/spawn.js` and `lib/review.js` (the result-header lines of both preambles), `docs/reference/04-protocol.md` § Artifacts
- **Created:** 2026-09-12, by the author of PB-204 on the first use of its own rule
- **Dependencies:** none

## Context

PB-204 requires a result to open with four lines and the rest to go as an artifact **named in the header**. PB-201 added the neighbouring warning to the protocol reference, in the same pass and by the same author:

> The name a sender passes is not always the name the artifact gets … a message body written before the send can therefore name a file that does not exist — quote the name from the reply, not from the path you passed.

On the very first result written under both rules the two collided. The author passed `PB-201-PB-204-result.md`; `placeFile` found the stem taken by the previous round's report and the file landed as `PB-201-PB-204-result-2.md`. The header quoted the passed path, so it named a file that does not exist, and the author caught it by reading the send reply afterwards.

**The slip is not the point — the rule is.** "Quote the name from the reply" cannot be obeyed by a header, because the header is part of the body and the body is composed **before** the send that produces the reply. Obeying it literally means composing the header, sending, reading the reply, and only then learning whether the header is true; for a one-shot send there is no second chance. A rule that can only be followed by sending twice is not a rule a participant can follow.

> Source: 2026-09-12, run `opt0912`, the acceptance of PB-201 and PB-204. The gate record of the same result is unaffected — `gates-pb-prompts.json` was the first use of its stem and landed under the name it was given, which is why the resolver found it.

The gate record escapes the trap by accident of order, not by design: it is sent as its own `artifact` message before the result, so the result can quote a name that already exists.

**The workaround was then used deliberately, and the participant that used it phrased the rule better than this card first did.** Told to send the artifact first and quote the landed name, one worker did exactly that and reported the shape as: *the artifact name is read from the bus reply to the send, and the turn is not interrupted.* The second half matters as much as the first — the reply comes back to the sender immediately, so quoting it costs no wait. An earlier wording of the workaround said "read the name from the reply" without saying whose reply, and the same worker briefly read it as waiting for the orchestrator. A rule about not blocking that can be read as "block here" is the wrong rule to ship into a preamble.

## Work to do

- Choose the closure and write the reason in this card. Two are known and both are a one-line change to the preambles: send the artifact as its own message first and quote the landed name **from the bus reply to that send, without ending the turn** — which is what the gate record already does and what one worker has now done on purpose; or give the result artifact a stem unique per attempt, so the passed name and the landed name cannot differ. Whichever is chosen, the wording must name whose reply is meant: the ambiguity has already cost one reading.
- Whichever is chosen, the § Artifacts warning must stop telling a participant to do something a header cannot do. Today it states a true fact and draws an impossible instruction from it.
- Check the other places a body names a file it is sending, not only the result header.

## Out of scope

- Changing `placeFile` or `numberedName`: the numbering is correct and protects the earlier round's file from being overwritten, which is exactly why the collision happened rather than a silent loss.
- The bound on the header — PB-204 decided it and this card does not reopen it.

## Checks

- A result whose artifact stem is already taken still names the file that exists: demonstrated by sending two results with the same stem in one task and reading both headers.
- A grep of both preambles finds no instruction that requires a reply the sender cannot yet have.
- The gate record keeps working unchanged, since its order already satisfies whichever rule is chosen.
