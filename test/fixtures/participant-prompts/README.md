# Native role prompt capture

`native.json` was produced from the worker, reviewer and managed-root planners at
commit `ee076d282235e88dfac30119a26c0b1c6820a6bc` before separating Codex prompt sources.
It contains worker and reviewer prompts for Claude, Cursor, Codex and OpenCode,
the Codex root prompt, and the three unsupported managed-root refusals.

`test/prompt-sources.mjs` builds a disposable repository and task and invokes the
real planners without launching any harness. It normalizes the temporary workspace,
path separators, commit SHA and timestamps. All other instructions remain captured.
`test/prompt-sources.test.mjs` compares non-Codex output in full and preserves the
Codex shared body while separately testing its operational guidance.

`roles.json` was captured at commit `c4912a7ac9fb548ec73ef97e9eaee2fc5c94e51b`
before extracting portable role renderers. `test/role-prompts.mjs` uses the same
disposable planner capture and adds approver, teamlead and reporter plans for
all four native harnesses, including unsupported-role refusals. It also normalizes
generated teamlead task suffixes. No harness or model is launched.
`test/role-instructions.test.mjs` compares all 24 native results in full.
