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
