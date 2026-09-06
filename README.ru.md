# Promptobus

[English](README.md)

Promptobus — локальный почтовый ящик и шина задач для сессий агентов. Оркестратор и воркеры обмениваются типизированными сообщениями, артефактами и статусом через задачу на диске. Общей чат-ленты у них нет.

Пакет вынесли из закрытого инструмента для агентского рабочего места. Теперь шина работает сама.

Канон — английский текст. Русский README — единственное другое место с кириллицей в этом репозитории.

## Зачем

Когда работа уходит в другие сессии, пропадают задание, ответы и файлы. Promptobus держит их на диске в `.promptobus/`. Новая сессия забирает ящик и продолжает. Воркеры не пишут друг другу. Почта идёт через оркестратора.

Шина не знает ваше рабочее место. В каждый вызов вы передаёте [host](docs/adr/adr-002-standalone-host-contract.md). CLI собирает standalone host из текущего каталога, Git и `promptobus.json`.

## Требования

- Node.js 20 или новее (`engines` в `package.json`)
- Git: worktree и проверка свежести

## Как поставить пакет

Из клона этого репозитория:

```bash
npm install
npm run build
node bin/promptobus.js --version
```

Команда печатает `promptobus` и версию из `package.json`. После глобальной установки или `npx` тот же бинарь — `promptobus`.

Как библиотека:

```bash
npm install promptobus
```

`package.json` отдаёт `.`, `./host`, `./hooks`, `./driver`, `./cli` и `./schemas/*`.

## Как настроить рабочее место

Создайте `promptobus.json` в корне рабочего места. Standalone host ищет его вверх от текущего каталога. Store лежит рядом, в `.promptobus/`.

```json
{
  "tools": ["claude", "cursor", "codex"]
}
```

`tools` — harness'ы, которые это место может поднимать. `--harness` должен назвать один из них. Без флага spawn и review берут `claude` (`lib/drivers.js`).

`promptobus install` пишет в тот же файл поле `harnesses`: последний установленный список hooks. Это не список для spawn.

Необязательные ключи, которые читает standalone host: `commandName`, `locale`, `version`. Ещё `rules` (дополнительные файлы правил), `mcp` (серверы участника), `skills` (каталог скиллов процесса).

## Как подключить MCP-сервер

Шина — MCP-сервер на stdio:

```bash
promptobus mcp
```

Укажите harness'у эту команду. Задайте `PROMPTOBUS_HOME` — каталог store (папка `.promptobus`). Spawn пишет эту запись каждому воркеру и ревьюеру. Сессии оркестратора нужен тот же сервер.

Инструменты:

- `promptobus_send` — отправить типизированное сообщение (`task`, `status`, `question`, `answer`, `artifact`, `result`, `review`)
- `promptobus_mailbox` — забрать непрочитанное (это помечает его прочитанным)
- `promptobus_task` — метаданные задачи, участники, каталог артефактов

Полные имена, которые видит сессия: `mcp__promptobus__promptobus_send` и тот же префикс у двух других (`lib/contract.js`).

## Как поставить project hooks

Установка hooks — отдельная команда. Это не npm `postinstall`. См. [docs/guides/install.md](docs/guides/install.md).

```text
promptobus install --harnesses claude,cursor,codex
promptobus install --check
promptobus install --dry-run
promptobus uninstall [--harnesses claude,cursor,codex]
```

Доверие и разбор проблем: [docs/guides/hooks-and-trust.md](docs/guides/hooks-and-trust.md).

## Как начать

Напишите файл брифа. Дальше:

```bash
promptobus spawn --repo ./my-repo --brief ./brief.md
promptobus status
```

`--repo` — путь на диске. `--brief` обязателен. `--new-task` открывает новую задачу. `--task <id>` сажает воркера в уже открытую. `--title` называет кусок этого воркера. `--task-title` называет задачу. `--harness cursor` или `--harness codex` выбирает runtime. `--dry-run` печатает план. Он ничего не пишет.

Изолированное ревью:

```bash
promptobus review ./my-repo --title "Review the change"
```

Путь обязателен. `--title` обязателен, чтобы открыть новую задачу ревью. Повтор с `--task <id>` шлёт новый дифф на тот же адрес.

## Model routing

Назовите намерение — стратегию — вместо модели, и CLI сам подберёт кортеж `role + harness + model + effort`: рейтинговый каталог из пакета, пересечённый с тем, что аккаунты действительно могут запустить прямо сейчас, с печатью всех кандидатов и причин.

```bash
promptobus models --strategy balanced          # что выбрал бы резолвер и почему
promptobus models --strategy balance           # …и какую из подписок он бы потратил
promptobus spawn --repo my-repo --brief ./brief.md --strategy balanced
```

Вид вывода, сокращённый по строкам `…`. Числа взяты из фикстуры снапшота, которую фиксирует набор тестов (`test/fixtures/model-routing/balance-snapshot.json`), прогнанной против каталога из пакета, — читатель может их воспроизвести. Проценты реального аккаунта принадлежат этому аккаунту:

```text
$ promptobus models --strategy balance
strategy: balance · role: worker
snapshot: 2026-09-06T02:17:43.464Z · 0 s old · source cache
overlays: user (absent) · workspace (absent)
chosen: codex-sol-medium · codex / gpt-5.6-sol medium · score 78.10

candidates:
  * codex-sol-medium        codex / gpt-5.6-sol medium       available     78.10
    claude-opus-medium      claude / claude-opus-5 medium    available     74.25
    codex-sol-high          codex / gpt-5.6-sol high         available     73.10
    claude-opus-high        claude / claude-opus-5 high      available     73.00
    …

pace — percentage points of each binding window · band 5.0 · spend unit 5.0:
  * codex   codex-sol-medium · secondary weekly · 46.0% used · 62.5% elapsed · underspend +16.50 · penalty -1.25 · effective +15.25
    claude  claude-opus-medium · 7d weekly · 30.0% used · 40.5% elapsed · underspend +10.48 · penalty -1.25 · effective +9.23
    cursor  cursor-composer-2.5 · cycle-auto monthly · 62.0% used · 47.9% elapsed · underspend -14.08 · penalty -1.25 · effective -15.33

availability:
  claude  available  tier example-max (credentials)
      5h        session 8.0% used · 18000 s · account · resets 2026-09-06T06:17:43.464Z
      7d        weekly  30.0% used · 604800 s · account · resets 2026-09-10T06:17:43.464Z
      7d-fable  weekly  38.0% used · 604800 s · model Fable · resets 2026-09-10T06:17:43.464Z
  cursor  available  tier included:2000 (derived)
      cycle-auto  monthly 62.0% used · 2592000 s · pool auto · resets 2026-09-21T17:17:43.464Z
      cycle-api   monthly 72.0% used · 2592000 s · pool api · resets 2026-09-21T17:17:43.464Z
  codex   available  tier example-pro (probe) · credits none · reset credits 2
      primary    session 0.0% used · 18000 s · account · resets 2026-09-06T04:17:43.464Z
      secondary  weekly  46.0% used · 604800 s · account · resets 2026-09-08T17:17:43.464Z

runtime models — not rated, never chosen automatically:
    cursor / gpt-5.6-via-cursor  [no-zdr]
    …```

Стратегий пять: `quality`, `balanced`, `speed`, `economy` и `balance`. Первые четыре взвешивают качества кортежа. `balance` отвечает на другой вопрос — какую из подписок тратить. Его берут, когда платят за несколько harness и хотят расходовать их равномерно: он предпочитает harness, сильнее прочих отставший от темпа собственного лимитного окна, внутри harness упорядочивает кортежи по `balanced`, а когда темп не считается ни для одного окна — откатывается к `balanced` с предупреждением. Блок `availability:` над ним — это то, что ответил каждый аккаунт: состояние, тариф и каждое лимитное окно с его видом, израсходованной долей, длиной, тем, что оно связывает, и временем сброса. Таблица `pace` печатается только под `balance`.

**Приоритет: флаг → записанный default overlay → ничего.** `--strategy` в командной строке всегда выигрывает. Ниже — `defaults.strategy` из слитых overlay, записанный default. Ещё ниже — ничего: `spawn` и `review` не маршрутизируют и идут своим обычным путём, ровно как раньше. `--harness`, `--model` и `--effort` в эту лестницу не входят вовсе: они остаются **ограничениями** выбора резолвера, и стратегия их не подменяет.

`models` читает кэш доступности и ни о чём не спрашивает harness — опрашивает только `--refresh`, и он же единственный, кто пишет запись в кэш.

Когда у аккаунта остаётся мало, `models` печатает строку `near-limit`: окно, время его сброса, что именно сработало — уровень или темп — и стратегию, на которую стоит перейти. **Само ничего не переключается.** Агент предлагает переход вам; после согласия `promptobus models strategy --set <name>` записывает `defaults.strategy` в записываемый слой overlay, и каждый следующий `spawn` и `review` без `--strategy` маршрутизируется с ним. `--clear` убирает запись, а `promptobus models strategy` без аргумента печатает действующий default и слой, из которого он взят.

Единственный вопрос, на который не отвечает ни один метод harness, — название тарифа Cursor. Эту строку вы добавляете один раз в overlay `user`, в `account: { "cursor": { "plan": "<name>" } }`. Её никто не пишет, она только отображается и ни во что не оценивается.

`models validate` проверяет каталог из пакета и каждый слой overlay; `models --clear-exhausted <harness>` снимает отметку об исчерпании, у которой нет известного времени сброса. `promptobus done` дописывает по одной телеметрической записи на участника в `telemetry.jsonl` рядом с кэшем доступности — локально, режим `0600`, никуда не отправляется и не содержит ни промптов, ни путей, ни идентификаторов сессий, ни токенов; `models` печатает, сколько записей в файле. Запустите `promptobus models --refresh` прямо перед `promptobus done`, если хотите, чтобы запись несла конечное значение по каждому окну. Поверхность команд — [Model routing](docs/reference/03-cli.md#model-routing); каталог, слои и файл overlay для копирования — [docs/guides/model-routing.md](docs/guides/model-routing.md).

## Команды

| Команда | Что делает |
|---|---|
| `promptobus spawn` | Поднять воркера в изолированном git worktree |
| `promptobus review` | Поднять read-only ревьюера на путь |
| `promptobus models` | Что резолвер выбрал бы сейчас и сколько осталось у каждого аккаунта; `strategy --set <name>` записывает default, с которым согласился человек, `validate` проверяет каталог, `--clear-exhausted <harness>` снимает залипшую отметку об исчерпании |
| `promptobus status` | Список активных задач, участники, непрочитанное |
| `promptobus done` | Закрыть задачу. Гасит сессии, которые подняла шина, если нет `--keep-sessions`, и дописывает по одной локальной телеметрической записи на участника |
| `promptobus dismiss <address>` | Снять сданного участника с наблюдения |
| `promptobus history` | Печатает **прочитанную** почту, от старых к новым (по умолчанию последние 50) |
| `promptobus prune` | Показать или удалить журналы давно закрытых задач (порог 14 дней) |
| `promptobus guard` | Сторож цикла для Stop-хука. Код 2 возвращает ход |
| `promptobus warden` | Слушатель задачи. Любая команда шины поднимает его. `PROMPTOBUS_WARDEN=off` гасит автоподъём |
| `promptobus mcp` | MCP-сервер на stdio |
| `promptobus install` | Записать project-level hooks (`--harnesses`, `--check`, `--dry-run`) |
| `promptobus uninstall` | Снять только свои project-level hooks |

`promptobus help` и `promptobus --version` работают без файла host.

## Библиотека

```js
import { openEngine } from 'promptobus';
import { createStandaloneHost } from 'promptobus/host';
import { planPromptobusHooks } from 'promptobus/hooks';
```

`openEngine` требует место store (`root` или `home`) и routing policy. Engine не ищет рабочее место на диске. См. [docs/reference/01-overview.md](docs/reference/01-overview.md).

## Документация

- [Установка](docs/guides/install.md)
- [Hooks, доверие, разбор проблем](docs/guides/hooks-and-trust.md)
- [Model routing: каталог и overlays](docs/guides/model-routing.md)
- [Как контрибутить (backslop)](docs/guides/contributing.md)
- [Контракт host](docs/adr/adr-002-standalone-host-contract.md)
- [Глоссарий](docs/GLOSSARY.md)
- [Справочник](docs/reference/README.md)
- Скиллы процесса: [skills/orchestrate](skills/orchestrate/SKILL.md), [skills/solo-review](skills/solo-review/SKILL.md)

## Лицензия

MIT
