# Promptobus

[![CI](https://github.com/Velklish/promptobus/actions/workflows/ci.yml/badge.svg)](https://github.com/Velklish/promptobus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Шина для агентских сессий, не привязанная к инструменту: задачи, почтовые ящики, артефакты и сессии участников.

[English](README.md)

Promptobus даёт одной агентской сессии — оркестратору — передать работу другим сессиям и получить её обратно. Worker'ы правят изолированные git worktree, ревьюер читает дифф свежим взглядом, и все они обмениваются типизированными сообщениями, артефактами и статусом через задачу, лежащую на диске в `.promptobus/`. Ни одна сессия не видит чужую переписку, а умершую заменяет та, что забрала её ящик и продолжила работу.

Шина не знает вашего рабочего места. Каждый вызов получает **host**, который отвечает за текущий каталог, git и `promptobus.json`; CLI собирает самостоятельный host, а инструмент-потребитель передаёт свой. Пакет вынесен из частного рабочего инструмента, чтобы шина работала сама по себе, и ведёт сессии Claude Code, Cursor и Codex по одному контракту драйвера.

Канонический язык — английский. Русский README — единственный перевод в этом репозитории.

## Что умеет

- **Хранилище задач на диске.** Каталог на задачу: `task.json`, ящики и история каждого участника, артефакты жёсткими ссылками на свои блобы и папка `files/`, которую человек может открыть. Семь типов сообщений — `task`, `status`, `question`, `answer`, `artifact`, `result`, `review` — и JSON-схема на каждую форму записи.
- **Worker'ы в worktree.** `promptobus spawn` поднимает сессию в изолированном git worktree целевого репозитория, отдаёт ей бриф и шину и не трогает основное дерево.
- **Изолированное ревью.** `promptobus review` поднимает read-only ревьюера на снимке диффа; находки приходят шиной, а повторный вызов отдаёт тому же ревьюеру свежий снимок.
- **Три инструмента, один контракт.** Драйверы Claude Code, Cursor и Codex; `promptobus.json` перечисляет, кого рабочему месту разрешено поднимать.
- **MCP-сервер и хуки.** `promptobus mcp` отдаёт три инструмента по stdio. `promptobus install` пишет project-level хуки — отклик шины после каждого её вызова и Stop guard, возвращающий ход, пока почта не прочитана, — а надзиратель будит адресата, когда почта приходит.
- **Маршрутизация моделей.** Вместо модели называешь стратегию, и резолвер выбирает инструмент, модель и усилие из оценённого каталога, пересечённого с тем, что аккаунты могут поднять прямо сейчас. Пять стратегий, overlay-файлы для локальных поправок и команда калибровки, предлагающая строки overlay по собственной телеметрии.
- **Библиотека, а не только CLI.** Движок, контракт host'а, контракт драйвера и планировщик хуков экспортированы с типами TypeScript, и у пакета нет runtime-зависимостей.
- **Процессные скиллы в комплекте.** `skills/orchestrate` и `skills/solo-review` объясняют агенту, как вести прогон и как просить ревью.

## Требования

- Node.js 20 или новее
- Git — worktree, диффы и проверка свежести
- Хотя бы один CLI инструмента в `PATH` для `spawn` и `review`: Claude Code, Cursor (`cursor-agent` плюс `tmux`) или Codex
- Для работы над самим пакетом: `tmux` и `ast-grep` (см. [Разработка](#разработка))

## Установка

Пакета нет в реестре npm. Ставится он с GitHub, пином на тег релиза из [CHANGELOG.md](CHANGELOG.md):

```bash
npm install github:Velklish/promptobus#v<version>
```

Добавьте `-g`, чтобы команда `promptobus` появилась в `PATH`. Из клона:

```bash
npm install
npm run build
node bin/promptobus.js --version
```

Последняя команда печатает `promptobus` и версию из `package.json`.

### 1. Объявить рабочее место

Создайте `promptobus.json` в корне рабочего места. Самостоятельный host ищет его вверх от текущего каталога и держит хранилище в `.promptobus/` рядом — добавьте этот каталог в `.gitignore`.

```json
{
  "tools": ["claude", "cursor", "codex"]
}
```

`tools` — это список разрешённых к подъёму: `--harness` обязан назвать одного из них, а без флага `spawn` и `review` берут `claude`. Необязательные ключи, которые читает host: `commandName`, `locale`, `version`, `rules` (дополнительные файлы правил участнику), `mcp` (серверы, копируемые участнику), `skills` (каталог процессных скиллов). Репозиторий, который генерирует свои процессные скиллы, объявляет команду в своём `promptobus.json` под ключом `generate` массивом argv.

### 2. Дать оркестратору MCP-сервер

Spawn пишет запись MCP каждому worker'у и ревьюеру. Сессии оркестратора нужен тот же stdio-сервер в project-файле MCP её инструмента:

```json
{
  "mcpServers": {
    "promptobus": {
      "type": "stdio",
      "command": "promptobus",
      "args": ["mcp"],
      "env": { "PROMPTOBUS_HOME": "/absolute/path/to/workspace/.promptobus" }
    }
  }
}
```

Без глобальной установки `command` — это `node`, а `args` — `["/absolute/path/to/bin/promptobus.js", "mcp"]`. Имя сервера обязано остаться `promptobus`: из него собираются матчеры хуков и имена инструментов.

### 3. Поставить project hooks

Установка хуков — отдельная команда, а не `postinstall` пакета:

```bash
promptobus install --harnesses claude,cursor,codex   # список обязателен при первой установке
promptobus install --check                          # exit 1, когда файлы проекта разъехались
promptobus install --dry-run                        # напечатать будущие записи, не писать ничего
promptobus uninstall                                # снять только свои хуки
```

Установщик правит `.claude/settings.json`, `.cursor/hooks.json` и `.codex/hooks.json`, сохраняет чужие хуки и незнакомые поля и записывает поставленный список в `promptobus.json` под ключом `harnesses` — это не список разрешённых к подъёму. После установки выдайте project hooks доверие в своём инструменте: [Хуки, доверие и разбор неполадок](docs/guides/hooks-and-trust.md).

## Как пользоваться

### Быстрый старт

Напишите бриф — файл Markdown с заданием, — затем:

```bash
promptobus spawn --repo ./my-repo --brief ./brief.md --task-title "Rename the billing module"
promptobus status
```

`--repo` — путь на диске, `--brief` обязателен. Worker получает worktree, бриф и шину; первым его сообщением идёт `status`. Почту из сессии оркестратора забирайте инструментом `promptobus_mailbox` — надзиратель стучит, когда что-то приходит, а Stop guard не даёт ходу кончиться, пока почта не прочитана. На `question` отвечайте `promptobus_send`, `result` принимайте, находки ревью отправляйте обратно.

Независимое прочтение диффа:

```bash
promptobus review ./my-repo --title "Review the rename"
```

Путь обязателен, `--title` заводит новую задачу ревью, а `--task <id>` отдаёт новый снимок уже поднятому ревьюеру. Когда работа принята, задачу закрывают:

```bash
promptobus done
```

`done` гасит сессии, поднятые шиной (оставить их — `--keep-sessions`), сносит заведённый механизмом worktree вместе с веткой, когда работа доказанно слита, и дописывает по одной записи телеметрии на участника.

### Команды

| Команда | Что делает |
|---|---|
| `promptobus spawn --repo <path> --brief <file>` | Поднять worker'а в изолированном git worktree. `--new-task` или `--task <id>`, `--title`, `--task-title`, `--harness`, `--model`, `--effort`, `--strategy`, `--dry-run` |
| `promptobus review <path>` | Поднять read-only ревьюера на снимке диффа. `--title` или `--task <id>`, `--base <ref>`, `--strategy`, `--dry-run` |
| `promptobus models` | Что резолвер выбрал бы сейчас и сколько осталось у каждого аккаунта. Подкоманды `validate`, `strategy [--set <s> \| --clear]`, `calibrate [--write]`; `--clear-exhausted <harness>` |
| `promptobus status` | Активные задачи: участники, непрочитанная почта, состояние сессий, маршрут и счёт проходов ревью |
| `promptobus done` | Закрыть задачу; погасить поднятые шиной сессии, если не задан `--keep-sessions` |
| `promptobus stop <address>` | Погасить сессию ОДНОГО участника, оставив задачу открытой; запись сессии уходит вместе с процессом |
| `promptobus dismiss <address>` | Перестать следить за отработавшим участником — только надзор, процесс не трогается |
| `promptobus history` | Журнал прочитанной почты, от старого к новому; `--limit <n>` или `--all` |
| `promptobus prune` | Показать журналы задач, закрытых больше 14 дней назад; удалить — `--yes` |
| `promptobus guard` | Сторож цикла для хука Stop: exit 2 возвращает ход, пока почта не прочитана |
| `promptobus warden` | Слушатель задачи. Поднимает его любая команда шины; `PROMPTOBUS_WARDEN=off` выключает авто-подъём |
| `promptobus mcp` | MCP-сервер по stdio |
| `promptobus install` / `uninstall` | Поставить или снять project-level хуки |

`promptobus help` печатает все флаги; она и `--version` работают без `promptobus.json`.

### Инструменты MCP

| Инструмент | Вход | Что делает |
|---|---|---|
| `promptobus_send` | `{ to, type, body, artifactPath?, task? }` | Послать типизированное сообщение; `to` — это `orchestrator`, `worker:<slug>` или `reviewer:<slug>` |
| `promptobus_mailbox` | `{ claim?, task? }` | Забрать непрочитанное и пометить прочитанным; `claim: true` перехватывает ящик у прежней сессии |
| `promptobus_task` | `{ task? }` | Метаданные задачи, участники, каталог артефактов |

Полные имена, которые видит сессия, — `mcp__promptobus__promptobus_send` и тот же префикс у остальных двух. Без `task` сервер берёт `PROMPTOBUS_TASK`, затем привязку сессии, затем единственную активную задачу.

### Маршрутизация моделей

```bash
promptobus models --strategy balanced                       # выбор, все кандидаты, все причины
promptobus spawn --repo ./my-repo --brief ./brief.md --strategy quality
promptobus models strategy --set balance                    # записать умолчание для будущих spawn и review
promptobus models calibrate                                 # предложить оценки overlay по локальной телеметрии
```

Стратегий пять: `quality`, `balanced`, `speed`, `economy` и `balance`. Первые четыре взвешивают качества тройки `harness + model + effort`; `balance` отвечает на другой вопрос — какую из подписок тратить, — и предпочитает инструмент, сильнее прочих отставший от темпа собственного окна лимита. Приоритет такой: флаг, затем записанное умолчание overlay, затем ничего — вызов без стратегии идёт немаршрутизированным путём. `--harness`, `--model` и `--effort` ограничивают выбор резолвера и никогда не подменяются.

`models` читает кэш доступности и ничего не спрашивает у инструментов; пробует только `--refresh`. Когда у аккаунта остаётся мало, печатается строка `near-limit` со стратегией, на которую стоит перейти, и ничего не переключается само. Кэш и файл телеметрии лежат в домашнем каталоге с правами `0600`, не содержат ни промптов, ни токенов и никуда не отправляются. Команды, коды причин и коды ошибок — [reference/03-cli.md § Model routing](docs/reference/03-cli.md#model-routing); каталог и overlay-файл для копирования — [guides/model-routing.md](docs/guides/model-routing.md).

### Переменные окружения

| Переменная | Что делает |
|---|---|
| `PROMPTOBUS_HOME` | Каталог хранилища для процесса, который его уже знает, — его и выставляет spawn MCP-серверу участника |
| `PROMPTOBUS_TASK` | Id задачи, который берут инструменты MCP, когда вызов не назвал её |
| `PROMPTOBUS_WARDEN=off` | Выключить авто-подъём надзирателя; участники тогда опрашивают `promptobus_mailbox` сами |

## Библиотека

```js
import { openEngine, PROTOCOL_VERSION } from 'promptobus';
import { createStandaloneHost } from 'promptobus/host';
import { planPromptobusHooks } from 'promptobus/hooks';
import { createRegistry } from 'promptobus/driver';
import { runPromptobus } from 'promptobus/cli';
```

| Спецификатор | Что внутри |
|---|---|
| `promptobus` | Протокол и хранилище v1: `openEngine`, задачи, участники, сообщения, артефакты, восстановимый fan-out, история; фабрика MCP; типы host'а и драйвера |
| `promptobus/host` | Контракт `PromptobusHost` и `createStandaloneHost` |
| `promptobus/hooks` | Планировщик хуков: отклик шины и сторож, которые нужны файлу инструмента |
| `promptobus/driver` | Контракт драйвера, `createRegistry`, помощники сессий, типы маршрутизации моделей |
| `promptobus/cli` | `runPromptobus(argv, { host, cwd, env, input, output })` |
| `promptobus/schemas/*` | JSON-схемы задачи, участника, сообщения, артефакта и документов маршрутизации |

`openEngine` принимает расположение хранилища (`root` или `home`) и политику маршрутизации; диск в поисках рабочего места он не обходит. Исходники пакета импортируют только встроенные модули Node и никогда не читают `process.env` и не пишут в stdout — диагностика, идентичность сессии и имя инструмента приходят аргументами, так что окружение и вывод остаются у потребителя. Подробности — [reference/01-overview.md](docs/reference/01-overview.md), [reference/02-host.md](docs/reference/02-host.md), [reference/04-protocol.md](docs/reference/04-protocol.md).

## Разработка

```bash
git clone https://github.com/Velklish/promptobus.git
cd promptobus
npm ci               # собирает dist/ через prepare
npm run build        # tsc -p tsconfig.json
npm test             # test/run.mjs гоняет каждый test/*.test.mjs
npm run audit        # аудит публичной поверхности по tracked-файлам и собранному tarball
npm run lint:backslop
```

`src/` — это TypeScript, компилируемый в `dist/`; `lib/` — рантайм на JavaScript и три драйвера; `skills/`, `templates/`, `schemas/` и `models/` едут в tarball.

Набору нужны `git`, `tmux` и `ast-grep` (`npm install -g @ast-grep/cli@0.45.3` — версия, которую пинит CI). Он гоняет файлы пулом процессов, держа файлы с замером настенного времени в серийной группе в конце, даёт каждому файлу свой дом и свой временный каталог, запечатывает `PATH` каталогом заглушек, чтобы ни один настоящий бинарь инструмента не был вызван, и отказывает прогону, оставившему за собой процесс. Живые прогоны инструментов в CI не запускаются никогда. `lint:backslop` нужен сгенерированный adapter output, которого в свежем чекауте нет, — сначала `npx --yes github:Velklish/backslop#v0.6.0 init --prefix PB --lang en --tools claude,cursor,codex`.

CI гоняет те же шаги на Node 20 и 22, на Ubuntu и macOS ([ci.yml](.github/workflows/ci.yml)). Гейты, которые обязана пройти правка, перечислены под ключом `gates` в [backslop.json](backslop.json): `npm test`, `backslop lint`, `npm run audit`.

## Как участвовать

Задачи и решения живут в `docs/` и ведутся через [backslop](https://github.com/Velklish/backslop); `npx github:Velklish/backslop#v0.6.0 status` печатает очередь. Правка завершена, когда вместе с ней переехали справочник, затронутый README и `CHANGELOG.md`, и каждый гейт выше вышел с кодом 0. Тема коммита начинается с номера задачи: `PB-N: <что сделано>`. Новые строки, комментарии и проверки в `bin/`, `lib/`, `src/`, `schemas/` и `templates/` пишутся по-английски, и ничто не называет внутренний продукт и не ссылается в чужой репозиторий. Полная процедура — [docs/guides/contributing.md](docs/guides/contributing.md).

## Документация

- [Install](docs/guides/install.md) — пакет, файл рабочего места, MCP-сервер, project hooks
- [Hooks, trust, and troubleshooting](docs/guides/hooks-and-trust.md)
- [Model routing: the catalog and overlays](docs/guides/model-routing.md)
- [Reference](docs/reference/README.md) — обзор, host, CLI, протокол
- [Glossary](docs/GLOSSARY.md) и [Roadmap](docs/ROADMAP.md)
- [Documentation index](docs/README.md) — гайды, справочник и журнал решений
- Процессные скиллы: [orchestrate](skills/orchestrate/SKILL.md), [solo-review](skills/solo-review/SKILL.md)
- [CHANGELOG.md](CHANGELOG.md)

## Лицензия

[MIT](LICENSE)
