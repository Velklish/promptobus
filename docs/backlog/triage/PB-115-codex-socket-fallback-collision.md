# PB-115 · The holder socket's /tmp fallback path is keyed by the session ref alone, so two registries running a participant with the same ref collide on one socket

- **Scope:** `lib/codex-session.js` (`socketPath`, `lockFile`, `holdMain`), [03-cli](../../reference/03-cli.md) § The Codex holder
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified at commit `cc1aca8` (v0.5.0), and reproduced directly.

`lib/codex-session.js:91-96`:
```
export function socketPath(ref, env = process.env) {
  const name = `${createHash('sha1').update(String(ref ?? '')).digest('hex').slice(0, 12)}.sock`;
  const nested = path.join(sessionsDir(env), name);
  if (Buffer.byteLength(nested) <= SOCK_MAX) return nested;
  return path.join(tmpdir(), `pb-cdx-${name}`);
}
```
The nested form is namespaced by `sessionsDir(env)` (reads `PROMPTOBUS_CODEX_HOME` or `host.harnessStateHome('codex')`), but the `/tmp` fallback on line 95 hashes only `ref` — the registry home is dropped from the key. Reproduced directly: with two distinct, long `PROMPTOBUS_CODEX_HOME` values (long enough to push the nested path past `SOCK_MAX = 103` bytes, the documented trigger for the fallback) and the same `ref`, `socketPath(ref, envA) === socketPath(ref, envB)` — both resolved to `/tmp/pb-cdx-<sha1(ref)>.sock` (probe run in this session, `COLLISION: true`).

The lock that should stop a second holder does not see across registries either: `lockFile(ref, env)` (defined via `takeHolderLock`, line 245 onward) is built under `sessionsDir(env)`, the same per-registry path. `holdMain` then unconditionally clears whatever socket sits at that path before listening (`lib/codex-session.js:667-668`: `const sock = socketPath(ref, env); rmSync(sock, { force: true });`), so the second holder deletes and takes over the first holder's live socket without either registry's lock ever tripping.

## Work to do

- Fold `sessionsDir(env)` into the `/tmp` fallback's hash input (e.g. `sha1(sessionsDir(env) + '\0' + ref)`), keeping the `pb-cdx-` prefix, so the nested and fallback forms share the same key space and two registries never collide.
- Add a regression test alongside the existing `SOCK_MAX` coverage: two different registry homes long enough to trigger the fallback, same `ref`, distinct socket paths.
- Update the `SOCK_MAX` comment at `lib/codex-session.js:85-88` to note the fallback name is now also scoped by registry home.

## Out of scope

- Making `lockFile` itself cross-registry-aware — once the socket path is unique per registry, the existing per-registry lock is sufficient again.
- The `SOCK_MAX` threshold value or the general path-shortening strategy — only the missing registry-home component of the fallback key.

## Verification

- `node --test` on the codex-session suite passes with the added case.
- Re-run the collision probe: `socketPath(ref, envA) !== socketPath(ref, envB)` for two distinct `PROMPTOBUS_CODEX_HOME` values and the same `ref`, once both exceed `SOCK_MAX`.
