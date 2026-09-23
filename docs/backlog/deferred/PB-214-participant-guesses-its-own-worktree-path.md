# PB-214 · Участник Codex промахивается мимо своего рабочего каталога и тратит ходы на угадывание пути

- **Scope:** `lib/codex-session.js` (`containmentPath`, `resolveTarget`, ветка отказа), `lib/spawn.js` и `lib/review.js` — как путь называется участнику в преамбуле; `docs/reference/03-cli.md`
- **Created:** 2026-09-13
- **Dependencies:** none
- **Cost:** major

## Context

Замерено по журналу надзирателя одного прогона (2026-09-12 19:05 — 2026-09-13 08:30, пять участников Codex): **28 отказов** вида `action outside cwd/addDirs` и **96** вида `carries no path to contain`. Каждый отказ — потраченный ход участника, а ход участника Codex стоит ещё и хода встроенного авто-ревьюера.

Первое прочтение было неверным и его стоит записать, чтобы не повторить: отказы выглядят как дефект сборки пути в самом механизме, потому что сообщение печатает **источник и цель одинаковыми** — `action outside cwd/addDirs: X → X`. Это не так. Совпадение объясняется тем, что `containmentPath` для несуществующего пути возвращает его же: резолвить нечего.

Проверка путей из отказов показала настоящую картину — участники **гадают**:

```
/Users/…/AtiWorkspace/workspaces/external/backslop/.claude/worktrees/promptobus-…   ← workspaceS
/Users/…/AtiWorkspace/worktrees/promptobus-opt0912-bs-reach-…                       ← без workspace/external/<repo>/.claude
/Users/…/AtiWorkspace/worktree-promptobus-opt0912-bs-reach-…                         ← worktree вместо worktrees, слитно
/Users/…/AtiWorkspace/workspace/external/promptobus-opt0912-pb-handoff-…            ← имя репозитория склеено с именем worktree
/Users/…/AtiWorkspace/workspace/external/promptobus-tmp
```

Ни один из этих путей не существует. Настоящий вид — `…/workspace/external/<repo>/.claude/worktrees/promptobus-<task>-<slug>-t<штамп>`. Промахи разные по форме — лишняя буква, потерянные сегменты, склейка двух имён, — то есть это не одна опечатка, а повторяющееся восстановление пути по памяти.

Два пути из списка существуют — `/private/tmp` и каталог под ним. Там отказ верен по существу: это вне разрешённых корней.

**Почему это предмет пакета, а не участника.** Путь участнику называется при подъёме, и он же лежит в записи задачи. Если участник тратит 28 ходов на угадывание, значит либо путь до него не доезжает в форме, которую он удерживает, либо отказ не говорит ему, где правда. Сегодня отказ называет **неверный** путь дважды и не называет ни одного верного — прочитав его, участник не узнаёт ничего, кроме того, что промахнулся.

## Work to do

- В отказ добавить разрешённые корни: сообщение обязано печатать, **куда можно**, а не только что цель мимо. Сейчас `unresolvedRootsNote` печатает только нерезолвящиеся корни, то есть в обычном случае молчит.
- Убрать бесполезную половину сообщения: при несуществующей цели `abs` и `canonical` совпадают, и печатать их парой через стрелку — обман чтения. Печатать пару только когда резолв действительно что-то изменил.
- The second class, 96 refusals `carries no path to contain`, is PB-191's subject (the same `item/fileChange/requestApproval` branch, `lib/codex-session.js:723-729`); the count and the fixture's answer are carried there.
- First decide how a refusal reason reaches the participant at all: today the holder answers `{ decision: 'decline' }` and the reason goes only to the holder log and the warden log (`lib/codex-session.js:1053-1056`). Without that, the two items above improve the orchestrator's diagnosis and not the participant's guessing.
- Проверить, в каком виде путь доезжает до участника в преамбуле, и не теряется ли он к середине хода.

## Out of scope

- Ослабление проверки границы. Отказ по существу верен: все перечисленные пути действительно вне разрешённых корней, и два из них — настоящее нарушение границы.
- Автоматическое исправление «похожего» пути. Угадывание за участника — источник худших дефектов, чем лишний ход.

## Verification

- Отказ содержит список разрешённых корней; фикстура проверяет наличие, а не текст целиком.
- Живой прогон участника Codex: число отказов `action outside cwd/addDirs` за прогон сравнимо с замеренными 28 на пять участников, и после правки падает.
- Отрицательный контроль: настоящее нарушение границы (`/private/tmp`) по-прежнему отвергается.

## Deferred

- **Deferred:** 2026-09-16
- **Reason:** Owner decision of 2026-09-16: the Codex cluster (PB-196, PB-194, PB-191, PB-185, PB-214) is deferred as a whole. The current run lifts Claude Code participants only, and every card in the cluster needs live Codex turns on the binary that PB-196 would replace — a fix measured against the old boundary would be lost with the upgrade.
- **Return condition:** A dedicated Codex run opens and PB-196 has upgraded codex-cli in it; this card is then re-measured on the new binary before anything is changed.

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `major`**: every refused guess costs a participant turn plus a Codex auto-reviewer turn — 28 in one run of five participants, per the card's count, which names the journal but no count command — and the text that could stop the guessing names no allowed root.

- The code the card names holds: `grep -n "^function resolveTarget\|^function containmentPath\|unresolvedRootsNote =\|action outside cwd/addDirs" lib/codex-session.js` → exit 0, `:530`, `:549`, `:736`, `:745`. The message still prints `${abs} → ${canonical}`, and `unresolvedRootsNote` is empty unless a root fails to resolve (`sed -n '735,738p' lib/codex-session.js`). Nothing has changed since filing: `git log --oneline --since=2026-09-13T00:00:00 -S"action outside cwd/addDirs" -- lib/` → exit 0, empty.
- `containmentPath` returns its input for a missing path only when the nearest existing prefix holds no symlink: it joins the missing tail onto the realpath of that prefix (`lib/codex-session.js:605`), so `/tmp/x` comes back as `/private/tmp/x`.
- **Correction, from the tree:** the Context says a participant reads the refusal and learns nothing from it. The participant never receives it — the reply is `{ decision: 'decline' }` (`:403`, via `approvalReply` at `:1056`), and the text reaches only the logs. This is also true at the filing commit `ab83711a`. The Work to do now starts with the delivery question and no longer carries PB-191's subject.
- The preamble carries no worktree path: `src/host.ts:199` gives `workerPreamble` only `taskId`, `nsPath` and `branch`, and the standalone host prints no absolute path (`sed -n '284,300p' src/standalone.ts`). The last work item stays open as written.
- **Return condition: not fired** — see the re-triage of PB-196.
