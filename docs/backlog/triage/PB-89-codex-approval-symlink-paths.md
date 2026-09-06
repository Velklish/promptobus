# PB-89 · The Codex approval gate compares paths as raw strings, so a worktree reached through a symlinked root is denied every mutation approval as outside cwd/addDirs

- **Scope:** `lib/codex-session.js` (`decideApproval`, `resolveTarget`, `insideRoots`), `lib/driver-codex.js`, `test/promptobus-driver-codex.test.mjs`, [reference/03-cli.md](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`insideRoots` (lib/codex-session.js:493-496) compares paths as plain strings against the record's own roots:

```
function resolveTarget(raw, cwd) {                                          // 485
  const s = String(raw ?? '');
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  if (!cwd) return null;
  return path.resolve(cwd, s);
}

function insideRoots(abs, roots) {                                          // 493
  if (!abs) return false;
  return roots.some((root) => abs === root || abs.startsWith(`${root}${path.sep}`));
}
```

`decideApproval` builds `roots` from the record verbatim (`const roots = [record.cwd, ...(record.addDirs ?? [])].filter(Boolean);` — line 521) and denies with `action outside cwd/addDirs: ${abs}` when the check fails (line 530). `record.cwd` is written unresolved (`driver-codex.js:386` `const workdir = plan.cwd ?? cwd;`, `:392` `cwd: workdir` in the spawned record) and handed to Codex twice unresolved: as the literal process cwd of the spawned `app-server` child (`codex-session.js:671` `cwd: record.cwd`) and inside the `thread/start` RPC params (`codex-session.js:954` `cwd: record.cwd`).

Codex's app-server canonicalizes what it is given: in a captured session under codex-cli 0.146.0 (`~/.codex/sessions/2026/09/03/rollout-2026-09-03T19-55-31-01a06832-72c4-7a80-9548-aea1ec2eeee5.jsonl`), `session_meta.cwd` reads `/var/folders/t8/.../T/g1` while every `turn_context.cwd`, `workspace_roots` entry and the model's own `<environment_context><cwd>` in the same file read the canonical `/private/var/folders/t8/.../T/g1` — one file with both spellings; a second capture (`rollout-2026-09-03T16-09-05-01a06763`) shows the same split. So when `record.cwd` is a macOS temp path, every absolute path the model later proposes to touch comes back canonical while `roots` still holds the unresolved spelling, and the string-prefix check in `insideRoots` denies a legitimate patch inside the worktree.

Reproduced against the current function: `insideRoots('/private/var/folders/zz/T/pb-worktree/a.js', ['/var/folders/zz/T/pb-worktree'])` is `false` (deny); the same pair canonical on both sides is `true`. The owner's own runs do not hit this — the workspace root under `/Users/...` is already canonical, and no warden journal under `.promptobus/tasks` carries an `action outside cwd/addDirs` line — but it fires for any participant lifted with a cwd reached through a symlink: `$TMPDIR`/`/tmp` sandboxes, or a symlinked home or repos directory.

The rest of the codebase already treats realpath as the comparison canon: `lib/worktree.js:239-242` states outright that "paths are compared by realpath: on macOS a directory in a temp folder arrives both as `/var/…` and as `/private/var/…`" and resolves with `realOrSelf` (`realpathSync` with a fallback to `path.resolve` for a path that does not exist yet); `lib/review.js`, `lib/store.js` and `lib/guard.js` resolve the same way before comparing. `decideApproval`'s `insideRoots` is the one path-containment check in the codebase that still compares raw strings.

The existing tests do not reach this case: `test/promptobus-driver-codex.test.mjs:78-94` uses `cwd: '/tmp/wt'` for both the record and the target it denies (`/etc/passwd`) or allows (`note.md`, resolved against that same unresolved spelling) — the two sides never diverge in spelling.

## Work to do

- Resolve both sides of the comparison in `insideRoots` (or just before it, in `decideApproval`): `realpathSync` each root once, and resolve the target with the same fallback `lib/worktree.js:241` (`realOrSelf`) already uses for a path that may not exist yet (resolve the nearest existing parent, then re-join the tail).
- Keep the deny message printing the path as Codex reported it (unresolved), so the journal a person reads stays legible — only the comparison changes, not what gets logged.
- Add two cases next to the existing ones in `test/promptobus-driver-codex.test.mjs:78-94`: a record whose `cwd` is the unresolved spelling of a real temp directory with a target given in the resolved spelling — allow; and a symlink inside the worktree that resolves outside it — deny (the reverse face the current string-prefix check lets through today).
- Note the resolved comparison in `docs/reference/03-cli.md` § The Codex holder, next to the existing description of the cwd/addDirs check.

## Out of scope

- The Codex reviewer's own permission decisions (`item/permissions/requestApproval` and the read-only refusals) — this only touches the `MUTATION_APPROVALS` path a worker takes.
- Any change to how `record.cwd` itself is chosen or written (`driver-codex.js:386`) — the fix compares what is already there, it does not change what gets stored.

## Verification

- The two new tests in `test/promptobus-driver-codex.test.mjs` pass.
- `npm test` stays green.
- Manual probe: calling `decideApproval` with a root given in its unresolved spelling and a target given in the resolved spelling of the same directory returns `{ allow: true }` after the fix (it returns `{ allow: false, why: 'action outside cwd/addDirs: ...' }` today).
