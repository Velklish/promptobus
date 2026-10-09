# PB-357 · Use platform-appropriate Windows named pipes for Codex session IPC

- **Scope:** [Codex session driver](../../reference/05-drivers.md)
- **Created:** 2026-10-08
- **Dependencies:** none
- **Cost:** major

## Context

The owner requested this planning record on 2026-10-08 while stopping a managed Codex run. At local main `9a2a758209802e0b9632aad958f862d15e2e4c30`, `lib/codex-session.js:74–82` derives either a nested `.sock` filesystem path or a `tmpdir()` filesystem fallback, without a Windows branch. The owner's portability concern is that Node IPC on Windows requires a named-pipe endpoint. This is static evidence of a transport gap; no Windows reproduction or implementation was performed in that run.

The existing Windows keyed-publication record concerns POSIX child-PID registration, a separate transport and lifecycle boundary. It does not cover Codex session IPC.

## Work to do

- Confirm the supported Windows Codex-session boundary and reproduce the current endpoint failure with an exact command and exit code.
- Select a platform-appropriate endpoint: Windows named pipes and the existing bounded Unix socket paths on POSIX.
- Preserve actual native identity, private-home isolation, endpoint ownership, cleanup and reconnect semantics. Refuse ambiguous ownership rather than rerouting through another identity.

## Out of scope

- Windows keyed-publication leases, other harness transports, unrelated Windows cards, and runtime or policy edits during shutdown.
- Implementation and Windows verification in the stopped run; this record remains unstarted.

## Verification

- Add a platform endpoint test that fails for the current filesystem-only Windows path and passes for a named-pipe endpoint.
- On Windows, exercise session IPC connection, reconnect and cleanup with actual exits and retained raw output.
- Preserve POSIX short-path and long-path fallback behavior, private-home isolation and ownership refusals.

## Triage

2026-10-09: defer until Windows verification is available. Current source `ea81f0d8643d923aecf140b813ae9ae521270d23`, `lib/codex-session.js:74-83`, still returns filesystem socket paths without a platform branch; the local test helper already distinguishes Windows pipe endpoints in `test/sandbox.mjs:248-256`. This confirms the endpoint-selection gap in source, not a measured Windows runtime failure. No Windows host or session was used in triage. Keep this independent of PB-222.2, which concerns publication-lease child registration.

## Deferred

- **Deferred:** 2026-10-09
- **Reason:** The required Windows IPC failure, connection, reconnect and cleanup checks cannot be measured on the current macOS host. A POSIX-only test is insufficient evidence of Windows support.
- **Return condition:** A disposable Windows host with the supported Codex CLI is available and its IPC verification is authorized. First capture the current endpoint outcome, then implement platform selection and verify both Windows and POSIX boundaries.
