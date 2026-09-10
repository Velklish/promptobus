# PB-146.2 · recover() and history() take only listTasks().tasks and discard listTasks().broken, so a broken-task taxonomy never reaches their callers

- **Order:** 50
- **Scope:** `src/v1/engine.ts` (`recover`, `history`), [04-protocol](../../reference/04-protocol.md) § Engine
- **Created:** 2026-09-09
- **Dependencies:** PB-146

## Context

Finding of `worker:s-store` while implementing PB-146 (run `pb-run-0909-t20260909-132344`), from the source. `src/v1/engine.ts:348-350` (`recover` without an argument) and `:353-363` (`history`) read `listTasks(home, cli).tasks` and drop `listTasks(...).broken`. PB-146 gives `BrokenTask` a `code` so a caller of `engine.listTasks()` can branch on it, but `recover()` and `history()` still return nothing about the tasks they skipped: a journal written by a newer mechanism or a truncated one is silently absent from both results. PB-146's Work to do and Verification bind its repair to `BrokenTask.code` and the `listTasks` acceptance case, so this is a separate contract question.

## Work to do

- Decide (owner): either document in 04-protocol that `recover()` and `history()` cover readable tasks only and a caller pairs them with `listTasks()` for the broken ones, or carry `broken: BrokenTask[]` through `RecoverResult` and the history page as a scoped contract change (an `Added` entry, the exported types updated).
- A test for the chosen contract on a store with one readable and one unreadable journal.

## Out of scope

- The `BrokenTask.code` taxonomy itself — PB-146.

## Verification

- The test above is red on the PB-146 tree for the chosen contract and green after.

## Triage — 2026-09-10

- **Track:** S — Store integrity and public engine.
- **Priority:** P2.
- **Evidence level:** source review at `3ccdf27`: `src/v1/engine.ts:349` (`history`) and `:354` (`recover`) read `listTasks(home, cli).tasks`; the bus facade already reports the skipped tasks from its own `listTasks()` walk (`lib/store.js:505-508`).
- **Decision:** the documented contract, not a type change. `recover()` and `history()` cover readable tasks; a caller that needs the unreadable ones pairs them with `listTasks().broken`, whose `code` PB-146 gave it. `RecoverResult.broken` keeps its meaning — unreadable records inside a readable task — and is not overloaded with `BrokenTask`. One sentence in 04-protocol § Engine; a test on a store with one readable and one unreadable journal asserting that both results carry the readable task only and that `listTasks().broken` names the other. One `Changed` CHANGELOG line.
- **Next step:** implement as decided.
