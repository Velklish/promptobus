# PB-138 · `scripts/audit-public.mjs` uses `import.meta.dirname` (needs Node ≥20.11, but engines says ≥20) and calls `npm`/`tar` via raw `execFileSync` instead of the repo's `run()` helper

- **Scope:** `scripts/audit-public.mjs`, `lib/exec.js`, `test/promptobus-package.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

scripts/audit-public.mjs:17 computes `ROOT` as `path.resolve(import.meta.dirname, '..')`. `import.meta.dirname` is undefined before Node 20.11.0, and package.json:27-29 declares `"engines": { "node": ">=20" }`, so a compliant 20.0-20.10 install throws `TypeError: The "paths[0]" argument must be of type string` (reproduced locally: `node -e "require('path').resolve(undefined,'..')"`). Every other file in the repo that needs its own directory uses `path.dirname(fileURLToPath(import.meta.url))` instead — test/promptobus-package.test.mjs:14 is the direct sibling (it also runs `npm pack` and inspects the tarball), and `grep -rn "import.meta.dirname" .` returns exactly this one hit. Separately, audit-public.mjs:78-82 call `execFileSync('npm', ['run', 'build'], ...)`, `execFileSync('npm', ['pack', ...], ...)` and two `execFileSync('tar', ...)` calls directly. lib/exec.js exists precisely to avoid the npm case — its header states it is the "Single entry point for external processes" because on Windows `npm` resolves to `npm.cmd`, which Node refuses to spawn directly since CVE-2024-27980, and its `run()` routes such launches through `cmd.exe` correctly. test/promptobus-package.test.mjs already wraps its own npm calls this way: `import { run } from '../lib/exec.js'` (line 12) and `const npm = (args, cwd) => run('npm', args, { cwd, encoding: 'utf8', env })` (line 43). `npm run audit` is one of exactly two gates in backslop.json (lines 5-8) and CI (.github workflow, lines 15-16) runs only `os: [ubuntu-latest, macos-latest]`, `node: [20]` (a recent 20.x via setup-node) — so neither failure mode is exercised today, and both would surface for the first time as a hard, unhelpful throw for a contributor on Windows or on an older Node 20 patch. Grepped docs/backlog and docs/archive for `audit-public` and `import.meta.dirname` — no existing entry tracks either; the audit-related entries that do exist (PB-22, PB-23.1, PB-34.2, PB-35.1) are all about surface-1 content scanning (backlog prose, tracker ids, origin names), not this portability issue.

## Work to do

- Replace scripts/audit-public.mjs:17's `const ROOT = path.resolve(import.meta.dirname, '..')` with the repo's own `path.dirname(fileURLToPath(import.meta.url))` idiom (importing `fileURLToPath` from `node:url`), matching test/promptobus-package.test.mjs:14.
- Replace the `execFileSync('npm'|'tar', ...)` calls at audit-public.mjs:78-82 with `run(...)` imported from `../lib/exec.js`, mirroring test/promptobus-package.test.mjs's `npm = (args, cwd) => run('npm', args, { cwd, encoding: 'utf8', env })` wrapper.
- No change to the gate's logic, checks or output.

## Out of scope

- Adding a Windows or Node 20.0-20.10 leg to CI — this fix makes the script runnable there, it does not add coverage that exercises it.
- The `tar` calls' own availability on a bare Windows machine (`tar` is not a Node built-in) — routing them through `run()` only fixes the `.cmd`-launch problem `run()` exists for; whether `tar` itself is present is a separate, unverified question.

## Verification

- `npm run audit` still passes on the current tree (macOS/Linux) after the change, with identical output.
- Read-through confirms `import.meta.dirname` and raw `execFileSync('npm'|'tar', ...)` no longer appear in scripts/audit-public.mjs.
- Manual check on a Windows machine or a pinned Node 20.0-20.10 image is a note for the approver, since this repo's own CI matrix does not cover either.
