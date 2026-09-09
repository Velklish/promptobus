# PB-66 · src/v1/messages.ts treats any errno but ENOENT as corruption: recovery retires an unreadable intent to broken/messages, which nothing reads back, and readInbox rethrows mid-walk after refs have already gone to history

- **Scope:** `src/v1/messages.ts`, [04-protocol](../../reference/04-protocol.md) § Message types
- **Created:** 2026-09-06
- **Dependencies:** none
- **Taken:** 2026-09-09

## Context

Two places in the same file read a filesystem failure as a torn record.

**recoverTask, `src/v1/messages.ts:597-603`.** `readFileSync` sits inside the same `try` as `JSON.parse`:

    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      code = 'schema-invalid';
      note = `intent did not parse (${(e as Error).message})`;
    }

so every errno but `ENOENT` is classified `schema-invalid`, and the intent is isolated into `broken/messages` (`:617`, `isolate(file, brokenMessagesDir(home, task), name)`) with its lease removed (`:619`). The intent is the only copy of a message whose fan-out never ran — the send to it had already succeeded and returned to its caller; a torn intent is what a crash inside the commit point produces (`:611-621`). Nothing reads `broken/messages` back: `brokenMessagesDir` is written at `:617` only (`grep -rn brokenMessagesDir src lib bin`), while `Engine.brokenPath` (`engine.ts:276`) and `lib/store.js:340` both expose `brokenInboxDir`, a different directory. Reproduced: crash a send at the `intent` fault step, `chmod 000` the intent file, call `recover(task)` → `repairs: []`, `broken: [{ code: 'schema-invalid', note: 'intent did not parse (EACCES: permission denied, open ...)' }]`, the file moved to `broken/messages/`, `intents/` empty, recipient inbox empty. A later run with the permission restored never retries — the intent is already gone from `intents/`.

**readInbox, `src/v1/messages.ts:406` and `:438`.** Both the read and the rename-to-history rethrow anything that is not `ENOENT`, from the middle of the sorted walk:

    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    ...
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      continue;
    }

Earlier names in the walk have already been renamed into `history/<participant>/` and pushed into the local `messages` array that the throw then discards. Reproduced: three messages to `w-api`, `chmod 000` on the second ref → `read()` threw `EACCES`; `history/w-api` already held ref 1, `inbox/w-api` kept refs 2 and 3, and message 'one' was returned to no caller. `delivered()` (`:116-119`) counts a history ref as delivered, so recovery does not re-link it either — after restoring the permission, a second `read` returns only `['two','three']`; 'one' is unreachable for good. The comment at `:435-438` names exactly this failure as the reason `ENOENT` must not refuse, and the non-`ENOENT` branch still causes it.

Neither path is covered: no ADR touches mailbox durability (adr-001 through adr-005 are process, host contract, model routing, balance, and the ten-point scale), `docs/reference/04-protocol.md` states the opposite contract ('Mail is kept until read'), and no test exercises an `EACCES`/`chmod` case in the v1 suite.

## Work to do

- In `recoverTask`, read the intent file in its own `try`, the way `readInbox` already separates read from parse: `ENOENT` continues, and any other errno leaves the intent in place (propagate it, or record a transient note that is not a `BrokenNote` and does not call `isolate`). Only a `JSON.parse` or schema `validate` failure classifies the record as torn and moves it to `broken/messages`.
- In `readInbox`, make the walk failure-tolerant on a non-`ENOENT` read or rename: record a note for that one name and continue, so the caller still receives every message whose ref actually reached history. If a fatal error is unavoidable, raise it only after the loop, carrying the messages already taken.
- Add suite cases for both halves that make one record unreadable (`chmod 000`) and assert the message is still delivered on a later pass, and that `broken/messages`/`broken/<participant>` stays empty for a merely-unreadable (not malformed) record.
- Add a caveat to the 'Mail is kept until read' line in `docs/reference/04-protocol.md` if the corrected behaviour still allows a genuinely fatal IO error to end a command mid-walk.

## Out of scope

- The `schema-invalid` classification for a record that DOES parse but fails `validate` — that stays isolation, unchanged; only the read failure is reclassified.
- `brokenMessagesDir` having no reader at all — worth its own entry if nobody plans to build one; this task only stops writing merely-unreadable records into it.

## Verification

- New test: `chmod 000` an intent mid-recovery, restore the permission, call `recover()` again — the intent completes fan-out instead of landing in `broken/messages`.
- New test: `chmod 000` the second of three inbox refs, call `read()`, restore the permission, call `read()` again — all three messages are eventually returned to the caller, none lost to `history` with no return.

## Triage — 2026-09-07

- **Track:** S — Store integrity and public engine.
- **Priority:** P0.
- **Evidence level:** source/definition review at `1e0401a`, including `src/v1/messages.ts:597`, `lib/store.js:340`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Priority: potential loss of delivered messages. Preserve transient I/O failures for retry and return messages already moved to history. Define the partial-result contract before refactoring readers; permission-based tests need a portable injection path where chmod cannot reproduce refusal.
