# PB-322 · The mutation probe runs a file name as shell text and lets a delete or rename patch escape its restore

- **Scope:** [Contributing](../../guides/contributing.md)
- **Created:** 2026-10-03
- **Dependencies:** none
- **Cost:** critical

## Context

On 2026-10-03 a consumer workspace copied `scripts/mutation-probe.mjs` as the model for its own probe command. A reviewer of that copy reported three critical findings and one major. The reviewer derived them from reading the copy's code and did not run them. The same lines are on this repository's main. Each finding below was checked against the source here by reading; none has been reproduced yet.

1. **A file name becomes shell text.** `scripts/mutation-probe.mjs:38` builds `node ${JSON.stringify(rel)}`, and `sh()` runs it with `spawnSync(cmd, { shell: true })` (`:41`). Double quotes do not stop `$(…)` or a backtick, so a path containing them runs that text, and the probe runs something other than the named file.
2. **A patch that deletes the subject passes the path check.** `:67` drops `/dev/null` from the named paths, so a `--stdin-patch` that deletes `rel` names only `rel` and passes. After `git apply`, `readFileSync(abs)` (`:101`) throws ENOENT before `restore()` runs, and the file is not put back.
3. **A rename block without `---`/`+++` lines passes the one-file check.** The check reads only `---` and `+++` lines (`:68`). A patch that changes `rel` and also carries a pure rename of another file (`rename from`/`rename to`, no hunk) names only `rel`. `git apply` renames the other file, and the restore does not bring it back.
4. **(major) An interrupted run whose verdict count happens to match is taken as a probe.** The reviewer reported that the sign of an interrupted run does not take part in the decision. Not yet checked here.

Evidence: reading of `scripts/mutation-probe.mjs` on main `e77098c2`, lines 38, 41, 67–71, 101; the consumer's review of its copy. The consumer's worker was asked to reproduce each item on this repository's script; its commands and exit codes go here when they arrive.

## Work to do

- Reproduce each item with a throwaway file in a scratch clone: the command, its output and exit code, and whether the tree was restored.
- Run the default command without a shell (`spawnSync('node', [rel])`), keep `--run` as the shell form a person writes themselves.
- Refuse a patch that deletes or renames anything, `rel` included: read `deleted file mode`, `rename from`/`rename to`, `copy from`/`copy to` headers as well as `---`/`+++`.
- Put the restore in a `finally` so a throw after the mutation still restores `rel`.
- Make an interrupted run fail the probe whatever its verdict count.
- Each fix carries a test that fails on the old script.

## Out of scope

- The consumer's own copy of the script.

## Verification

- The four reproductions from the first item fail on the old script and pass on the new one.
- `npm test` and the repository gates exit 0.
