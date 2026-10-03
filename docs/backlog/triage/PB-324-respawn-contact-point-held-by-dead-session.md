# PB-324 · A participant lifted again on the same address stays deaf while the dead session's record holds the contact point

- **Scope:** [02. Host § Session identity](../../reference/02-host.md#session-identity)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major

## Context

In run bs020 on 2026-10-03, in the ati-agents group, `worker:adr` was lifted again with the same spawn into the same worktree after its phase-1 session (b6fc23de) died. The teamlead reported the address deaf for the whole piece: mail reached the new session only through the Stop guard at the end of its turn, which for a worker is the end of the piece. After the relift of both teamleads at 20:06Z, `status` named both channels deaf until each new session's first turn end. The text it prints says the channel "returns to it on its next turn end" (`lib/driver-claude.js:349`).

Code reading, not a measured trace: `spawn` registers the contact point at lift only for Codex (`lib/spawn.js:1630`). A Claude Code participant takes it from its own bus calls and the Stop guard (`lib/guard.js:511`), and `registerWake` refuses while the record names another session (`foreignSession`, `lib/driver-claude.js:471`). If the record still names the dead session, the new one cannot take the channel until something rewrites the record.

PB-331 makes the mailbox and the channel belong to the participant rather than to a session. This card covers the measured gap and the reproduction that PB-331 must keep green.

## Work to do

- Reproduce on a stand: lift a Claude Code participant, kill its session, lift it again on the same address, send to it before its first turn end, and record whether the warden reaches the new session.
- Hand the contact point to the new session at lift when the old session is dead.

## Out of scope

- The mailbox ownership change, which is PB-331.

## Verification

- On the stand, a message sent right after a relift wakes the new session; a test fails on the old code.
- `status` does not report a deaf channel for a freshly relifted participant.
