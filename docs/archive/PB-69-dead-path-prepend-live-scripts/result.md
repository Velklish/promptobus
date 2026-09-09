# PB-69 · Result

**Closed 2026-09-09.** Completed with the card's minimal option. `scripts/live-e2e.mjs` and `scripts/live-canary.mjs` no longer prepend the directory of `resolveToolBin`'s answer to `PATH`: the sandbox resolver is a PATH-only presence gate that returns the probed name, not an install path, so `path.dirname` of its answer was `.` and the prepend put the current directory in front of every child command — a shadowing hazard, never the `~/.local/bin` rescue the comments claimed. The resolver's contract is stated in `test/sandbox.mjs`; the comments in both scripts now describe what the check does.

**Verification.** Worker commit `73b8eae` (worktree of `worker:verify`, on `main` `1df62ba`). Reproducer red before the repair: `node test/promptobus-live-path.test.mjs` exit 1, 1/3 — "live-e2e does not prepend the resolver result to PATH" and "live-canary does not prepend the resolver result to PATH"; the probe also shows `resolveToolBin('node')` answering `node` with dirname `.`, the old prepend yielding `.:/usr/bin:/bin`. After the repair 3/3; `node --check` on both scripts exit 0. Gates on `73b8eae`: `npm test` exit 0, 54/54 test files; `npx github:Velklish/backslop#v0.4.0 lint` exit 0, 0 errors; `npm run audit` exit 0, 641 tracked files, 119 tarball entries. Mutation probe after the commit, test kept: both prepend blocks restored → exit 1, 1/3 with the same checks; fix restored → 3/3. Review: the orchestrator read the diff in full (two removed blocks, rewritten comments, one resolver doc comment, one CHANGELOG bullet, one source probe) — no isolated reviewer session was spent on it. Approver: squash of the worker branch onto `main`; CHANGELOG union; `backslop lint` and `npm run audit` on the integrated tree exit 0.

**Not run.** The two live scripts start real harness sessions and were not executed; the end-to-end run on a real Claude remains for the owner.

**Documentation in the same pass.** Comments in both scripts and `test/sandbox.mjs`; CHANGELOG entry under Fixed.

**Acceptance.** Implementation: Codex `gpt-5.6-luna` max (`worker:verify`, strategy `balance`, bus task `pb-run-0909b-t20260909-184312`). Review: orchestrator.
