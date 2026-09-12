# PB-191 · `apply_patch` is method-dependent: the current file-change approval is pathless, while the legacy shape carries paths

- **Order:** 20
- **Scope:** `lib/codex-session.js` (`pathsOfApproval`, the `MUTATION_APPROVALS` branch at :874-884), [03-cli](../../reference/03-cli.md) § The Codex holder, [guides/hooks-and-trust](../../guides/hooks-and-trust.md)
- **Created:** 2026-09-12, orchestrator's measurement during the 0912c backlog run
- **Dependencies:** none

## The old title was too broad

The earlier title said that a Codex participant can never use `apply_patch`. That is not supported by
the day's successful participant edits. The measured fact is narrower: the approval method that a
current Codex turn sent to this holder was pathless and failed closed. The result depends on the
method and its request shape, not on the tool name alone.

The containment check is right and stays. A mutation whose bounds cannot be established is a
mutation the holder must not approve. The holder's first branch is:

```js
const raws = pathsOfApproval(params);
if (!raws.length) {
  const why = method === 'item/fileChange/requestApproval'
    ? 'item/fileChange/requestApproval carries no path to contain'
    : 'action target is unreadable';
  return { allow: false, why };
}
```

## Live measurement

Measured from this Codex participant on 2026-09-12, with the holder journal in
`~/.agents/codex/sessions/`:

```
own apply_patch call:
2026-09-12T16:14:27.787Z approval deny item/fileChange/requestApproval
  item/fileChange/requestApproval carries no path to contain
2026-09-12T16:14:27.788253Z codex_core::tools::router
  error=patch rejected by user
```

The harness returned exactly:

```
Script failed
Script error:
patch rejected by user
```

No person rejected the edit. This is one measured request generation: the holder received
`item/fileChange/requestApproval`, which carries no path, and refused before the patch could
change the tree.

The same live journal also contains allowed shell approvals through the other method, including:

```
2026-09-12T16:11:46.044Z approval allow item/commandExecution/requestApproval
2026-09-12T16:11:52.628Z approval allow item/commandExecution/requestApproval
```

That proves the holder sees a distinct shell approval method; it does not prove that the operating
system lets that shell write this participant's worktree. The inside-participant write boundary is
measured separately in PB-194.

`applyPatchApproval` is the older measured schema shape: its `fileChanges` map supplies path keys
that `pathsOfApproval` can inspect. The live measurement above did not receive that method, so
whether a current participant still receives it and whether an in-root request is accepted remains
open. Calling the legacy route "the working route" is a hypothesis until a holder journal captures
that method.

The wider 0912c run has repeated current-method denials and successful participant edits, so
"Codex participants can never use `apply_patch`" is not a valid conclusion. Each successful edit
needs its approval method recorded before it can be attributed to the legacy path.

## What is established and what is not

- Current `item/fileChange/requestApproval` without a path is refused fail-closed with a reason that
  names the method and the missing containment input.
- `item/commandExecution/requestApproval` is a separate approval route; an allow there does not
  override an OS-level worktree refusal.
- The holder's containment logic and `pathsOfApproval` stay unchanged.
- The legacy `applyPatchApproval` path and the exact condition under which a live participant
  reaches it are not established by this turn.
- The router text `patch rejected by user` is misleading: it hides a holder denial and falsely
  suggests a human decision.

## The participant-facing gap

The refusal text that reaches a participant names neither the method nor the missing path. A
participant therefore cannot distinguish a fail-closed file-change request from a human refusal.
The supported fallback is also not universal: the same participant's shell is not writable in its
worktree from the first minute, while its temporary directories are writable (PB-194).

## Work to do

- Capture a live holder request using the legacy `applyPatchApproval` shape and an in-root
  `fileChanges` path, then record whether containment allows it. Do not infer that result from the
  current `item/fileChange/requestApproval` refusal.
- Decide whether the holder should derive a path for the current method or keep failing closed with
  a refusal that names the method and missing path.
- Document a participant fallback only after its shell boundary is known; if shell is refused, the
  participant needs a loud route to escalation or a relift rather than an instruction that simply
  fails.
- Measure the other mutation approval methods before claiming that only file-change requests are
  pathless.

## Out of scope

- Weakening the containment check or `pathsOfApproval`.
- The participant worktree sandbox boundary itself; PB-194 records that measurement.
- Hook firing for a Codex participant; PB-185 is a separate gate.
