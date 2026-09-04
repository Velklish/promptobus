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

Команда печатает `promptobus 0.1.0`. После глобальной установки или `npx` тот же бинарь — `promptobus`.

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

## Команды

| Команда | Что делает |
|---|---|
| `promptobus spawn` | Поднять воркера в изолированном git worktree |
| `promptobus review` | Поднять read-only ревьюера на путь |
| `promptobus status` | Список активных задач, участники, непрочитанное |
| `promptobus done` | Закрыть задачу. Гасит сессии, которые подняла шина, если нет `--keep-sessions` |
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
- [Как контрибутить (backslop)](docs/guides/contributing.md)
- [Контракт host](docs/adr/adr-002-standalone-host-contract.md)
- [Глоссарий](docs/GLOSSARY.md)
- [Справочник](docs/reference/README.md)
- Скиллы процесса: [skills/orchestrate](skills/orchestrate/SKILL.md), [skills/solo-review](skills/solo-review/SKILL.md)

## Лицензия

MIT
