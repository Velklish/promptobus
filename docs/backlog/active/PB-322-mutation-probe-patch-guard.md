# PB-322 · The mutation probe runs a file name as shell text and lets a delete or rename patch escape its restore

- **Scope:** [Contributing](../../guides/contributing.md)
- **Created:** 2026-10-03
- **Dependencies:** none
- **Cost:** critical
- **Previous order:** 70
- **Taken:** 2026-10-04

## Context

On 2026-10-03 a consumer workspace copied `scripts/mutation-probe.mjs` as the model for its own probe command. A reviewer of that copy reported three critical findings and one major by reading its code. The consumer's worker then copied this repository's script unchanged into a throwaway fixture repository and ran each case; it wrote nothing here.
- Script: the file at `b6f80892`, last changed by `9dddf500`.
- Results: items 1–3 below reproduced; item 4 does not apply in the reported form.

1. **A file name becomes shell text.** `scripts/mutation-probe.mjs:38` builds `node ${JSON.stringify(rel)}`, and `sh()` runs it with `spawnSync(cmd, { shell: true })` (`:41`). Double quotes do not stop `$(…)` or a backtick, so a path containing them runs that text, and the probe runs something other than the named file.
2. **A patch that deletes the subject passes the path check.** `:67` drops `/dev/null` from the named paths, so a `--stdin-patch` that deletes `rel` names only `rel` and passes. After `git apply`, `readFileSync(abs)` (`:101`) throws ENOENT before `restore()` runs, and the file is not put back.
3. **A rename block without `---`/`+++` lines passes the one-file check.** The check reads only `---` and `+++` lines (`:68`). A patch that changes `rel` and also carries a pure rename of another file (`rename from`/`rename to`, no hunk) names only `rel`. `git apply` renames the other file, and the restore does not bring it back.
4. **(major) An interrupted run is taken as a red.** The reviewer reported this for the copy, which reads verdict tails. This script reads no tails and decides by exit code alone, so an interrupted run that exits 1 counts as red with the mutation by construction.

Evidence, from the fixture runs:
- Item 2: a patch deleting `lib/a.mjs` → exit 1, `Error: ENOENT: no such file or directory, open …/lib/a.mjs`. Afterwards `git status` shows ` D lib/a.mjs`: the file is not restored.
- Item 3: a patch editing `lib/a.mjs` plus a rename `lib/b.mjs → lib/c.mjs` → exit 1. Afterwards ` D lib/b.mjs` and `?? lib/c.mjs`.
- Item 1: a file named `test/x $(touch pwned) y.test.mjs`, run without `--run` → `?? pwned` appears in the fixture root. The run is red both with the mutation and without it.

These lines are on main at `e77098c2`: 38, 41, 67–71 and 101. The consumer fixed its copy by:
- reading the paths and operations from `git apply --numstat -z --summary` before applying, and refusing anything but a content change of the subject;
- restoring in `finally`;
- passing the file to `node` as an argument, without a shell.

## Work to do

- Turn the three fixture reproductions above into tests that fail on the old script.
- Run the default command without a shell (`spawnSync('node', [rel])`), keep `--run` as the shell form a person writes themselves.
- Refuse a patch that deletes or renames anything, `rel` included: read `deleted file mode`, `rename from`/`rename to`, `copy from`/`copy to` headers as well as `---`/`+++`.
- Put the restore in a `finally` so a throw after the mutation still restores `rel`.
- Do not count an interrupted run (a signal, a crash before the suite ends) as the red with the mutation.
- Each fix carries a test that fails on the old script.

## Out of scope

- The consumer's own copy of the script.

## Verification

- The three reproduction tests fail on the old script and pass on the new one; an interrupted run is refused.
- `npm test` and the repository gates exit 0.
