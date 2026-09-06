# PB-142 · Nine stand helpers are duplicated verbatim across the three harness modules, and diagnoseTrace has drifted so the Cursor and Codex stands hide scenario errors that the Claude stand surfaces first

- **Order:** 690
- **Scope:** `test/harness.mjs`, `test/harness-cursor.mjs`, `test/harness-codex.mjs`, `test/promptobus-driver-cursor.test.mjs`, `test/promptobus-driver-codex.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-141

## Context

Nine helpers are duplicated byte-for-byte across the three harness stands: `addrKey` (`harness.mjs:53`, `harness-cursor.mjs:184`, `harness-codex.mjs:71`), `scriptFile` (66/170/74), `traceFile` (71/175/78), `planParticipant` (225/197/83), `readTrace`, `pidAlive` (155/209/150), `argValue` (`harness.mjs:233`, `harness-cursor.mjs:312`) — confirmed identical by reading all three files side by side.

`diagnoseTrace` has drifted between them. `harness.mjs:132` defines `const AUTHOR_ERROR_KINDS = new Set(['unknown-action', 'action-failed', 'turn-failed']);` with a comment explaining why: "a live session does not crash on an unknown tool... so the E2E goes red on later steps, while the cause sits at the start of the trace." `harness.mjs:138-143`'s `diagnoseTrace` prepends those scenario errors before the trace tail:
```js
export function diagnoseTrace(home, address, tail = 6) {
  const trace = readTrace(home, address);
  const errs = authorErrors(trace);
  const head = errs.length ? `scenario errors for ${address} (the cause is usually here): ${JSON.stringify(errs)} · ` : '';
  return `${head}trace for ${address}: ${JSON.stringify(trace.slice(-tail))}`;
}
```
`harness-cursor.mjs:204-206` and `harness-codex.mjs:97-99` are both the bare tail-only version, with no `authorErrors` call:
```js
export function diagnoseTrace(home, address, tail = 8) {
  return `trace for ${address}: ${JSON.stringify(readTrace(home, address).slice(-tail))}`;
}
```
Both stands emit the affected kinds — `harness-cursor.mjs:1010` (`kind: 'action-failed'`), `:1017` (`kind: 'unknown-action'`); `harness-codex.mjs:634` (`kind: 'action-failed'`) — and `diagnoseTrace(HARNESS, ...)` is called on red assertions in `test/promptobus-driver-cursor.test.mjs:761,848,1082` and `test/promptobus-driver-codex.test.mjs:333,384,389,399,407`. So a scenario error on either the Cursor or Codex driver's E2E is diagnosed today with only a raw trace tail, while the same class of error on the Claude stand gets the scenario-error head that names the cause up front.

## Work to do

- Restore scenario-error diagnosis on the Cursor and Codex stand paths and test it through their actual entry points.
- Share the diagnostic helper only if its input/output contract is identical. The broader nine-helper extraction is not required by this repair.

## Out of scope

- Any behavioural change to what counts as a scenario error (`AUTHOR_ERROR_KINDS`) — this entry only stops the drift between the three copies.
- Deduplicating anything in the three stand files beyond the nine helpers named above.

## Verification

- `npm test` stays green with the three harness files reduced to their per-harness differences plus an import of `test/harness-shared.mjs`.
- A scenario-error fixture on the Cursor or Codex driver (an `unknown-action` or `action-failed` trace entry followed by a later red assertion) shows the "scenario errors ... (the cause is usually here)" head in the failure output, matching what the Claude stand already produces.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `test/promptobus-driver-cursor.test.mjs:761`, `test/promptobus-driver-codex.test.mjs:333`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** First restore scenario-error diagnosis to Cursor and Codex and exercise it through their actual stand entry points. Extract only the shared diagnostic if useful; deduplicating all nine helpers is optional and not part of the initial bug fix.
