# Promptobus

[![CI](https://github.com/Velklish/promptobus/actions/workflows/ci.yml/badge.svg)](https://github.com/Velklish/promptobus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Шина для агентских сессий, не привязанная к инструменту: задачи, почтовые ящики, артефакты и сессии участников.

[English](README.md)

Promptobus даёт одной агентской сессии — оркестратору — передать работу другим сессиям и получить её обратно. Worker'ы правят изолированные git worktree, ревьюер читает дифф свежим взглядом, approver принимает одну прошедшую ревью часть, и все они обмениваются типизированными сообщениями, артефактами и статусом через задачу, лежащую на диске в `.promptobus/`. Ни одна сессия не видит чужую переписку, а умершую заменяет та, что забрала её ящик и продолжила работу.

Шина не знает вашего рабочего места. Каждый вызов получает **host**, который отвечает за текущий каталог, git и `promptobus.json`; CLI собирает самостоятельный host, а инструмент-потребитель передаёт свой. Пакет вынесен из частного рабочего инструмента, чтобы шина работала сама по себе, и ведёт сессии Claude Code, Cursor и Codex по одному контракту драйвера.

Канонический язык — английский. Русский README — единственный перевод в этом репозитории.

## Что умеет

- **Хранилище задач на диске.** Каталог на задачу: `task.json`, ящики и история каждого участника, артефакты жёсткими ссылками на свои блобы и папка `files/`, которую человек может открыть. Семь типов сообщений — `task`, `status`, `question`, `answer`, `artifact`, `result`, `review` — и JSON-схема на каждую форму записи.
- **Дерево задач и маршруты.** Корневая задача может иметь дочерние задачи с teamlead'ами. Teamlead'ы одного корня и связанные через `link` корневые задачи обмениваются `question`, `answer`, `status` и `artifact`; остальные сообщения идут через оркестратора. Адрес `user` задаёт оркестратору вопрос, а reporter читает журналы и при необходимости спрашивает от имени `user`.
- **Worker'ы в worktree.** `promptobus spawn` поднимает сессию в изолированном git worktree целевого репозитория, отдаёт ей бриф и шину и не трогает основное дерево.
- **Шаги проверки.** `promptobus.json` может объявить pipeline с редактирующим владельцем и упорядоченными гейтами. Первый гейт чтения диффа можно поднять без результата предыдущего участника; каждый следующий гейт требует текущий результат предшествующего объявленного гейта для того же объекта проверки. `review` выбирает первый гейт чтения диффа.
- **Изолированное ревью.** `promptobus review` поднимает read-only ревьюера на снимке диффа; находки приходят шиной, а повторный вызов отдаёт тому же ревьюеру свежий снимок.
- **Адресованная приёмка.** `review --approver` поднимает гейт записи в основное дерево после текущих результатов предшествующего объявленного гейта и владельца для того же объекта проверки. Approver принимает часть в собственном worktree и продвигает основную ветку только fast-forward; его зарегистрированный адрес может писать владельцу части напрямую, пока сессия удерживает адрес.
- **Reporter для человека.** `promptobus report --task <root>` поднимает read-only сессию в корне установки. Она отвечает по журналам дерева задач или спрашивает оркестратора через ограниченный MCP-инструмент от имени `user`.
- **Три инструмента, один контракт.** Драйверы Claude Code, Cursor и Codex; `promptobus.json` перечисляет, кого рабочему месту разрешено поднимать.
- **MCP-сервер и хуки.** `promptobus mcp` отдаёт шесть инструментов по stdio; три доступны только подтверждённой сессии reporter. `promptobus install` пишет сторож цикла на Stop и SessionStart для Claude Code и Codex, только на stop для Cursor. Сторож возвращает ход при непрочитанной почте или долге ответа, а надзиратель будит адресата при доставке. `status` показывает `UNANSWERED` после хода обычного участника с долгом или сразу после вопроса `user` оркестратору.
- **Маршрутизация моделей.** Вместо модели называешь стратегию, и резолвер выбирает инструмент, модель и усилие из оценённого каталога, пересечённого с тем, что аккаунты могут поднять прямо сейчас. Пять стратегий, overlay-файлы для локальных поправок и команда калибровки, предлагающая строки overlay по собственной телеметрии.
- **Библиотека, а не только CLI.** Движок, контракт host'а, контракт драйвера и планировщик хуков экспортированы с типами TypeScript, и у пакета нет runtime-зависимостей.
- **Процессные скиллы в комплекте.** `skills/orchestrate` и `skills/solo-review` объясняют агенту, как вести прогон и как просить ревью.

## Требования

- Node.js 20 или новее
- Git — worktree, диффы и проверка свежести
- Хотя бы один CLI инструмента в `PATH` для `spawn` и `review`: Claude Code, Cursor (`cursor-agent` плюс `tmux`) или Codex
- Для работы над самим пакетом: `tmux` и `ast-grep` (см. [Разработка](#разработка))

## Установка

Пакета нет в реестре npm. Локальную зависимость ставят с GitHub, закрепив текущий тег релиза:

```bash
npm install github:Velklish/promptobus#v0.19.0
```

Для глобальной CLI-команды в `PATH` используйте тот же тег:

```bash
npm install -g github:Velklish/promptobus#v0.19.0
promptobus --version
```

Из клона:

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

`tools` — это список разрешённых к подъёму: `--harness` обязан назвать одного из них. При новом подъёме `spawn` или `review` без этого флага явная или записанная стратегия может выбрать инструмент, если работает маршрутизация; без стратегии новый участник получает запасной `claude`. Повторный `spawn` использует записанный инструмент участника. Повторный `review` использует записанный инструмент ревьюера, кроме разрешённой явной смены инструмента. Необязательные ключи, которые читает host: `commandName`, `locale`, `version`, `rules` (дополнительные файлы правил участнику), `mcp` (серверы, копируемые участнику), `skills` (каталог процессных скиллов), `pipeline` (шаг-владелец и гейты, которые часть проходит после него, — [install § 2](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/guides/install.md#the-pipeline)). Репозиторий, который генерирует свои процессные скиллы, объявляет команду в своём `promptobus.json` под ключом `generate` массивом argv.

### 2. Дать оркестратору MCP-сервер

Подъём участника пишет ему собственную запись MCP. Для оркестратора stdio-сервер регистрируют отдельно в project-файле его инструмента: `.mcp.json` для Claude Code, `.cursor/mcp.json` для Cursor, `.codex/config.toml` для Codex. [Руководство по установке](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/guides/install.md#3-mcp-server-for-the-orchestrator) даёт фрагмент нужного формата, условия доверия и команды проверки без отправки сообщений. `promptobus install` пишет хуки и скиллы, но не эту запись MCP.

### 3. Поставить project hooks

Установка хуков — отдельная команда, а не `postinstall` пакета:

```bash
promptobus install --harnesses claude,cursor,codex   # список обязателен при первой установке
promptobus install --check                          # exit 1, когда файлы проекта разъехались
promptobus install --dry-run                        # напечатать будущие записи, не писать ничего
promptobus uninstall                                # снять только свои хуки
```

Установщик правит `.claude/settings.json`, `.cursor/hooks.json` и `.codex/hooks.json`, сохраняет чужие хуки и незнакомые поля и записывает поставленный список в `promptobus.json` под ключом `harnesses` — это не список разрешённых к подъёму. После установки выдайте project hooks доверие в своём инструменте: [Хуки, доверие и разбор неполадок](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/guides/hooks-and-trust.md).

## Как пользоваться

### Быстрый старт

Напишите бриф — файл Markdown с заданием, — затем:

```bash
promptobus spawn --repo ./my-repo --brief ./brief.md --task-title "Rename the billing module"
promptobus status
```

`--repo` — путь на диске, `--brief` обязателен. Worker получает worktree, бриф и шину; первым его сообщением идёт `status`. Почту из сессии оркестратора забирайте инструментом `promptobus_mailbox` — надзиратель стучит, когда что-то приходит, а Stop guard не даёт ходу worker'а кончиться, пока почта не прочитана или пока он не отправил ответ, которого от него ждут. На `question` отвечайте `promptobus_send`, `result` принимайте, находки ревью отправляйте обратно.

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
| `promptobus spawn --teamlead --brief <file> --task <root>` | Поднять оркестратора дочерней задачи в корне установки на Claude Code |
| `promptobus step <name> <path> --task <id>` | Поднять объявленный гейт: первому гейту чтения диффа предшествующий результат не нужен; следующим нужен текущий результат предшествующего объявленного гейта для того же объекта проверки, а гейту записи — также результат владельца |
| `promptobus review <path>` | Поднять первый гейт чтения диффа; `--approver` выбирает первый гейт записи в основное дерево. `--title` или `--task <id>`, `--base <ref>`, `--strategy`, `--dry-run` |
| `promptobus report --task <root>` | Поднять одного read-only reporter в корне установки; дочерняя задача и вторая живая сессия отказываются |
| `promptobus models` | Что резолвер выбрал бы сейчас и сколько осталось у каждого аккаунта. Подкоманды `validate`, `strategy [--set <s> \| --clear]`, `calibrate [--write]`; `--clear-exhausted <harness>` |
| `promptobus status` | Аренда машины, затем корневые и дочерние задачи: участники по частям и шагам, почта, сессии, маршрут и счёт проходов ревью |
| `promptobus digest [--task <id>] [--json]` | Страница дерева задач по журналу: последние статусы, вопросы, долги ответа, остановки и шаги частей |
| `promptobus send <address>` | Написать одно сообщение от адреса, который эта сессия держит в задаче; `--body` или `--file`, `--type`, `--task`, `--artifact`. `--from` нет |
| `promptobus link <task-a> <task-b>` / `unlink` | Связать две активные корневые задачи как peers или убрать связь, сохранив прежнюю почту |
| `promptobus ask "<text>" --task <id>` | Спросить от имени `user` из обычного терминала; `--to teamlead:<slug>` выбирает дочернюю задачу, `ask --answers` читает ответы |
| `promptobus done` | Закрыть задачу; погасить поднятые шиной сессии, если не задан `--keep-sessions` |
| `promptobus stop <address>` | Погасить сессию ОДНОГО участника, оставив задачу открытой; запись сессии уходит вместе с процессом |
| `promptobus sweep <address>` | Убрать за ОДНИМ принятым куском, оставив задачу активной: worktree и ветку при доказуемом слиянии, присланные им блобы и файлы, его файлы в `workers/` |
| `promptobus dismiss <address>` | Перестать следить за отработавшим участником — только надзор, процесс не трогается |
| `promptobus history` | Журнал прочитанной почты, от старого к новому; `--limit <n>` или `--all` |
| `promptobus prune` | Показать журналы задач, закрытых больше 14 дней назад; удалить — `--yes` |
| `promptobus guard` | Сторож цикла для хука Stop: exit 2 возвращает ход, пока почта не прочитана — в этой задаче или в другой, которой сессия оркестратор, — или пока не отправлен ожидаемый ответ |
| `promptobus warden` | Слушатель задачи. Поднимает его любая команда шины; `PROMPTOBUS_WARDEN=off` выключает авто-подъём |
| `promptobus lease -- <command…>` | Пустить один замер на машину за раз; ожидающий называет держателя аренды и сдаётся на `--wait` (по умолчанию 1800 с); `status` называет держателя |
| `promptobus mcp` | MCP-сервер по stdio |
| `promptobus install` / `uninstall` | Поставить или снять project-level хуки |

`promptobus help` печатает все флаги; она и `--version` работают без `promptobus.json`.

### Инструменты MCP

| Инструмент | Вход | Что делает |
|---|---|---|
| `promptobus_send` | `{ to, type, body, artifactPath?, task? }` | Послать типизированное сообщение зарегистрированному участнику; реестр включает шаги pipeline, governance-роли и `user`. Отправитель — адрес, который эта сессия держит в задаче; reporter не отправляет от своего адреса |
| `promptobus_mailbox` | `{ claim?, message?, task? }` | Без `message` отдаёт заголовки и помечает почту прочитанной; с `message` отдаёт одно тело и ничего не помечает. На адресе orchestrator вызов без сессии получает копию, оставляет оригиналы, и ответ об этом говорит. `claim: true` перехватывает ящик у прежней сессии |
| `promptobus_task` | `{ task? }` | Метаданные задачи, участники, каталог артефактов |
| `promptobus_digest` | `{ task? }` | Только для reporter: дерево корневой задачи как `digest --json` |
| `promptobus_status` | `{ task? }` | Только для reporter: статус дерева и состояние живых сессий |
| `promptobus_ask` | `{ body?, answers?, after?, task? }` | Только для reporter: вопрос от имени `user` или чтение последующих ответов без изъятия почты `user` |

Полные имена, которые видит сессия, — `mcp__promptobus__promptobus_send` и тот же префикс у остальных пяти. Без `task` сервер берёт `PROMPTOBUS_TASK`, затем привязку сессии, затем единственную активную задачу.

Worker отправляет артефакт, который будет назван в результате, раньше самого результата, читает имя, под которым он лёг, из непосредственного ответа на собственный вызов `promptobus_send` и вписывает его в шапку, не завершая ход. При коллизии шина может пронумеровать имя; ревьюер не может прикладывать файлы.

### Маршрутизация моделей

```bash
promptobus models --strategy balanced                       # выбор, все кандидаты, все причины
promptobus spawn --repo ./my-repo --brief ./brief.md --strategy quality
promptobus models strategy --set balance                    # записать умолчание для будущих spawn и review
promptobus models calibrate                                 # предложить оценки overlay по локальной телеметрии
```

Маршрутизируются worker, reviewer и approver с мягкими порогами качества 5, 9 и 7. Стратегий пять: `quality`, `balanced`, `speed`, `economy` и `balance`. Первые четыре взвешивают качества тройки `harness + model + effort`; `balance` отвечает на другой вопрос — какую из подписок тратить, — и предпочитает инструмент, сильнее прочих отставший от темпа собственного окна лимита. Приоритет такой: флаг, затем записанное умолчание overlay, затем ничего — вызов без стратегии идёт немаршрутизированным путём. `--harness`, `--model` и `--effort` ограничивают выбор резолвера и никогда не подменяются.

`ROUTED_ROLES` в каталоге — единый неизменяемый источник словаря маршрутизации; его используют resolver, validation, учёт live-троек и telemetry, а JSON-схемы остаются статическими артефактами, сверяемыми с ним parity-тестом model-routing. `orchestrator` и другие адресуемые, но немаршрутизируемые роли отклоняются, когда роль названа в политике или выборе, и явно исключаются из проекций маршрутизации.

`models` читает кэш доступности и ничего не спрашивает у инструментов; пробует только `--refresh`. Когда у аккаунта остаётся мало, печатается строка `near-limit` со стратегией, на которую стоит перейти, и ничего не переключается само. Модель, у которой самое израсходованное из её окон лимита занято на 90 % и больше, выходит из автоматического выбора (`window-nearly-spent`), если её не назвали через `--harness` или `--model`. Кэш и файл телеметрии лежат в домашнем каталоге с правами `0600`, не содержат ни промптов, ни токенов и никуда не отправляются. Запись телеметрии не обещает расход для присоединённой сессии; расход токенов из rollout Codex намеренно не импортируется в sidecar пропускной способности, потому что rollout находится вне шины и не содержит времени активной работы модели. Команды, коды причин и коды ошибок — [reference/03-cli.md § Model routing](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/reference/03-cli.md#model-routing); каталог и overlay-файл для копирования — [guides/model-routing.md](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/guides/model-routing.md).

`import { telemetryStats } from 'promptobus/telemetry'` — типизированная описательная сводка запуска по ролям: из сохранённых строк она выводит wall-clock, счётчик сообщений шины, close-time ожидание почты и называет роль, ставшую узким местом. Сдвиги окон лимита остаются свидетельством всего запуска в `quotaEvidence` с покрытием по harness/window; у роли `quotaCostPercent` всегда null, а состояние `ambiguous` или `unavailable`, потому что расход нельзя распределить между пересекающимися участниками, причём `ambiguous` появляется только при валидном измеренном покрытии quota; запись того же harness без подходящего окна считается недоступной, невалидное окно не даёт свидетельства расхода, а отсутствующий или невалидный scope не считается всем аккаунтом. Числовые итоги роли требуют полного покрытия записей, а при неполном wall-clock bottleneckRole равен null. Расход присоединённой сессии, model turns и model-active time остаются недоступны; CLI по-прежнему печатает только число и размер записей телеметрии.

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
| `promptobus/hooks` | Планировщик сторожа цикла для Stop и SessionStart; Cursor ставит только stop |
| `promptobus/driver` | Контракт драйвера, `createRegistry`, помощники сессий, типы маршрутизации моделей |
| `promptobus/cli` | `runPromptobus(argv, { host, cwd, env, input, output })` |
| `promptobus/schemas/*` | JSON-схемы задачи, участника, сообщения, артефакта, записи о гейтах и документов маршрутизации |

`openEngine` принимает расположение хранилища (`root` или `home`) и политику маршрутизации; диск в поисках рабочего места он не обходит. Исходники пакета импортируют только встроенные модули Node и никогда не читают `process.env` и не пишут в stdout — диагностика, идентичность сессии и имя инструмента приходят аргументами, так что окружение и вывод остаются у потребителя. Подробности — [reference/01-overview.md](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/reference/01-overview.md), [reference/02-host.md](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/reference/02-host.md), [reference/04-protocol.md](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/reference/04-protocol.md).

Если инструмент не передаёт MCP-процессу переменную сессии, драйвер вместо неё называет указатель на запись сессии; адаптер принимает его, только когда запись и процесс ведут в один физический home и называют точные задачу и адрес, и обновляет перед каждым вызовом инструмента, потому что id может появиться уже после handshake. См. [ADR-014](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/adr/adr-014-mcp-session-proof.md).

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

`src/` — это TypeScript, компилируемый в `dist/`; `lib/` — рантайм на JavaScript и три драйвера; `skills/`, `schemas/` и `models/` едут в tarball.

Набору нужны `git`, `tmux` и `ast-grep` (`npm install -g @ast-grep/cli@0.45.3` — версия, которую пинит CI). Он гоняет файлы пулом процессов, держа файлы с замером настенного времени в серийной группе в конце, даёт каждому файлу свой дом и свой временный каталог, запечатывает `PATH` каталогом заглушек, чтобы ни один настоящий бинарь инструмента не был вызван, и отказывает прогону, оставившему за собой процесс. На той же границе он снимает все известные идентификаторы инструментов до того, как фикстура установит свой, поэтому запуск из участника другого инструмента не создаёт вторую личность сессии. Живые прогоны инструментов в CI не запускаются никогда. `lint:backslop` нужен сгенерированный adapter output, которого в свежем чекауте нет, — сначала `npx --yes github:Velklish/backslop#v0.10.1 init --prefix PB --lang en --tools claude,cursor,codex`.

CI гоняет те же шаги на Node 20 и 22, на Ubuntu и macOS ([ci.yml](https://github.com/Velklish/promptobus/blob/v0.19.0/.github/workflows/ci.yml)). Гейты, которые обязана пройти правка, перечислены под ключом `gates` в [backslop.json](https://github.com/Velklish/promptobus/blob/v0.19.0/backslop.json).

## Как участвовать

Задачи и решения живут в `docs/` и ведутся через [backslop](https://github.com/Velklish/backslop); `npx github:Velklish/backslop#v0.10.1 status` печатает очередь. Правка завершена, когда вместе с ней переехали справочник, затронутый README и `CHANGELOG.md`, и каждый гейт выше вышел с кодом 0. Тема коммита начинается с номера задачи: `PB-N: <что сделано>`. Новые строки, комментарии и проверки в `bin/`, `lib/`, `src/`, `schemas/` и `templates/` пишутся по-английски, и ничто не называет внутренний продукт и не ссылается в чужой репозиторий. Полная процедура — [docs/guides/contributing.md](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/guides/contributing.md).

## Документация

- [Install](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/guides/install.md) — пакет, файл рабочего места, MCP-сервер, project hooks
- [Hooks, trust, and troubleshooting](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/guides/hooks-and-trust.md)
- [Model routing: the catalog and overlays](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/guides/model-routing.md)
- [Reference](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/reference/README.md) — обзор, host, CLI, протокол
- [Glossary](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/GLOSSARY.md) и [Roadmap](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/ROADMAP.md)
- [Documentation index](https://github.com/Velklish/promptobus/blob/v0.19.0/docs/README.md) — гайды, справочник и журнал решений
- Процессные скиллы: [orchestrate](skills/orchestrate/SKILL.md), [solo-review](skills/solo-review/SKILL.md)
- [CHANGELOG.md](https://github.com/Velklish/promptobus/blob/v0.19.0/CHANGELOG.md)

## Лицензия

[MIT](LICENSE)
