# PB-208 · Accepting one piece cleans up nothing, and prune refuses on an active task

- **Order:** 80
- **Scope:** `lib/done.js` (`sweepWorktrees`, `sweepParticipantSecrets`), `lib/prune.js`, `lib/dismiss.js`, `lib/stop.js`, `lib/driver-codex.js` (participant homes), `docs/reference/03-cli.md`, `docs/reference/04-protocol.md` § Store layout
- **Created:** 2026-09-12, owner's decision of the same day
- **Dependencies:** PB-206

## Context

Everything the mechanism cleans up, it cleans up for a whole task. `done` stops the managed sessions, sweeps the worktrees of closed tasks, removes a branch it has proven merged by two measurements ([PB-6](../PB-6-done-blames-conflict-after-squash/result.md), [PB-158](../PB-158-done-keeps-a-branch-it-proved-merged/result.md)), and finally sweeps journals older than the threshold. Per piece there is nothing: `dismiss` removes supervision only, `stop` kills one session, and neither touches a directory. `engine.prune` **refuses on an active task** — and at the moment one piece is accepted, the task is still active by definition.

What that leaves behind, checked on disk rather than inferred:

- `artifacts/`, `blobs/` and `files/` of the accepted piece stay until the whole journal is swept;
- `workers/<stem>.settings.json` is removed by nobody — the secrets sweep takes the wake files, the MCP config and the `<stem>.*` directories, and the settings file is not in the list; a task closed on 2026-09-10 still carries three reviewer settings files and four turn sidecars;
- temporary participant homes are swept per participant at `done` and orphans at lift and at `stop`, but not at `done`; 17 mechanism directories were standing in the temporary root at the time of the measurement.

> Source: 2026-09-12, reading of `lib/done.js`, `lib/prune.js`, `lib/driver-codex.js` and of a closed task directory; counts reproduced by `ls` over the temporary root and the task's `workers/`.

The owner's decision of 2026-09-12 sets the boundary: **the telemetry a strategy is built from must survive**; the worktree and the branch of the accepted participant, the blobs and files of that piece, and the temporary stands may go. Sessions are already stopped by `done` and are not part of this card.

That boundary is not where the code draws it today. `telemetry.jsonl` lives outside the journal and survives anything. But `health.json`, `supervisor.log`, `stalls.json`, `messages/` and the wait sidecars — the only sources of delivery and idle time — are removed with the task directory and are projected nowhere (PB-205).

## Work to do

- Define the verb that accepts one piece and cleans up after it. The precedent for its shape is [ADR-012](../../adr/adr-012-stopping-one-participant-is-a-verb-of-its-own.md): an action over one participant is a verb, not a flag on `done`.
- List explicitly what it removes and what it must keep, and make the keep-list a check rather than a comment.
- Decide who calls it — the approver of PB-206 — and what happens when the piece is accepted but its branch is not provably merged: keep the tree, as `done` already does for that case.
- Close the settings-file gap while the file is open, or state why it stays.

## Out of scope

- The acceptance decision itself and who makes it — PB-206.
- Journal retention: the threshold is the consumer's decision and stands.
- Killing sessions: already done by `done`, and the owner did not ask to move it.

## Checks

- After accepting one piece: its worktree is gone, its branch is gone when provably merged, the blobs and files of that piece are gone — each verified by a command with its exit code, not by a printed summary.
- The task is still active afterwards and the other participants are untouched: their worktrees, sidecars and mailboxes unchanged.
- The keep-list holds: telemetry, messages and the health sidecars of the run survive the new verb, checked by file existence and by line count.
- A piece whose branch is not provably merged keeps its tree, and the verb says so instead of removing it silently.

## Что установил первый проход (2026-09-13, не принят)

Глагол написан, два круга изолированного ревью прочитаны, карточка возвращена в очередь решением владельца. Ветка `worktree-promptobus-0913a-cleanup-t20260913-163533`, HEAD `a5863e5`, дерево чисто, четыре коммита поверх `fd3cb81`; не запушена. Следующий проход начинает отсюда, а не с нуля.

**Что сделано и держится проверками:** глагол `sweep <address>`; keep-list выведен из того, что читает сборщик телеметрии на закрытии задачи, и закреплён двумя слоями — стражем на решении и проверкой по назначению (задача закрывается, строка телеметрии убранного участника читается обратно целиком); оба прохода доказательства слияния покрыты, включая случай, где база двинулась по тем же строкам; право вызова переписано как положительное доказательство; пути из записей ограничены каталогами задачи; отдельное состояние «дерево записано, но исчезло» вместо «дерева не было»; дыра с файлом настроек закрыта и в существующей команде закрытия.

**Почему не принят.** Безопасность разрушающего глагола держится на протоколах, которые живут вне его модуля. Пять критических путей к потере чужой работы остались открытыми, и два из них не чинятся внутри уборки.

### Развилка, которую надо решить до кода

Каталог рабочего дерева создаётся **раньше**, чем берётся замок журнала: подъём создаёт его, потом записывает участника, а замок берёт запись. Путь каталога при этом выводится из адреса, поэтому повторный подъём создаёт **тот же** каталог, который уборка под замком сносит; сверка отметки подъёма этого не видит по построению — записи ещё нет, сверять не с чем. Замок упорядочивает уборку против записи, а не против создания каталога.

Чинить можно с двух сторон, и цена разная:

- **подъём берёт замок до создания каталога** — короче в работе, но замок журнала удерживается на время создания рабочего дерева и установки зависимостей, то есть минуты, и все писатели журнала задачи встают;
- **уборка перестаёт полагаться на замок для дерева** и получает признак занятости самого каталога — отметку подъёма внутри рабочего дерева, которую снимает тот, кто его создал: длиннее в работе, дешевле в удержании.

Решение за владельцем. Названо здесь, чтобы не открывалось заново на середине следующего прохода.

### Остальные открытые пути

- **Происхождение артефакта берётся из непроверенного JSON.** Подложная запись с совпадающим отправителем присваивает артефакт соседа: его метаданные, ссылка и, возможно, единственный блоб уходят. Нужна проверка схемой и тождества хранения до первого разрушающего действия.
- **Гонка публикации.** Отправка на шине замка задачи не берёт вовсе, поэтому счётчик ссылок сужает окно, но не закрывает: блоб может быть уложен до снимка, а слинкован после удаления. Отдельная запись в триаже.
- **Вторая проверка живости не свежая.** Список фоновых сессий кэшируется, и повторный вызов под замком читает тот же снимок. Чинится локально, одной строкой, прецедент есть в команде закрытия — но **проверить это стендом нельзя**: стенд-драйвер кэша не держит, поэтому его повторный вызов честно отрабатывает и проверка зелёная. Условие приёмки: стенд обязан кэшировать так же, как боевой драйвер, иначе новая проверка будет такой же пустой.
- **Запись, называющая дерево, но без канонического пути репозитория**, читается как «дерева нет», и артефакты уходят без единого доказательства слияния.
- Результат снятия осиротевшей регистрации игнорируется: команда сообщает об успехе, когда его не было.
- Контракт хоста говорит, что все снимаемые пути лежат под домом шины, а драйвер участника снимает внешний каталог под временным корнем системы.
