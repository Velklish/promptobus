// Общие приёмы песочницы тестов. Не `*.test.mjs` — раннер (run.mjs) берёт из каталога
// только их, и этот файл в прогон не попадает.
//
// Подставной бинарь в PATH нужен там, где под тест берётся ветка «внешняя команда
// найдена»: живой `claude`, `agent` или `ast-grep` тесту не нужен, а задать его ответ
// нужно. Приём применялся семь раз, и шесть из них были написаны как `#!/bin/sh` без
// расширения — на Windows такой файл не находится вовсе: `resolveCommand` ищет по
// PATH × PATHEXT, и файла без `.exe`/`.cmd`/`.bat` в этом переборе нет. То есть тест
// краснел там при исправном коде и приучал считать красное нормой.
//
// Лечится не переводом сценария на batch: сценарии ветвятся по argv, читают stdin и
// пишут файлы, а два диалекта разошлись бы при первой же правке. Сценарий пишется один
// раз на JS и исполняется node'ом; платформенным остаётся запускатель в три строки —
// `.cmd` на win32, `#!/bin/sh` на POSIX.
//
// Цена — запуск node на каждый вызов подставного бинаря, и это не доли секунды.
// Замер на этой машине 2026-08-30, по 80 вызовов на вариант: вызов стоит около 71 мс, из
// них 55–66 мс — пустой старт node (`node -e ''`), 3–6 мс — процесс `sh` запускателя,
// 5–10 мс — ESM-загрузчик против CJS. Подставной бинарь зовут сотни раз за прогон набора;
// больше всего — `promptobus-review.test.mjs`, самый долгий файл набора (потолок и разброс —
// [run.mjs](run.mjs)).
//
// Дешевле запускатель сделать можно, но немного, и правка дороже выигрыша. Тем же замером:
// шебанг node вместо `sh` (`#!<node>`, файл без расширения) снимает только процесс `sh` и
// ESM-телу не даёт и его — 69 мс против 71; тот же шебанг с телом на `.cjs` снимает ещё и
// ESM-загрузчик — 61 мс, то есть 10 мс с вызова. За эти 10 мс платить пришлось бы второй
// формой запускателя на POSIX и разбором тела по синтаксису: `import` есть в 9 вызовах
// `stubCommand` из 52, остальным `.cjs` годится. Потолок выигрыша — 3,5 с CPU на прогон
// набора и 0,7 с настенных часов на критическом пути пула, то есть меньше, чем прогон
// гуляет от соседей по машине. Отсюда решение: не сделано.
//
// Сам старт node — 55–66 мс из 71 — не снимается ничем, кроме одного долгоживущего стаба.
// Он запрещён по другой причине, и она к `.cjs` отношения не имеет: клиент к сокету
// пишется уже не на JS, и `.cmd` с `#!/bin/sh` разошлись бы не в три строки, а в две
// разные программы — ровно та беда , ради которой сценарий и сведён к одному языку.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
// Статический импорт CLI — до гигиены HOME в check.mjs и до подмены в файле набора.
// Модуль, который вычисляет os.homedir() в константу загрузки, увидит настоящий дом
// (: пути дома считаются в момент вызова; класс ловит homedir-module.test.mjs).
import { resetBgSessionsCache } from '../lib/liftoff.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { addressOf } from '../lib/store.js';

// Сброс процессной памяти CLI: набор подменяет PATH, тело подставного бинаря и
// маркер «сессия поднялась», а без сброса кэш отдаёт ответ до правки.
export function resetCliCaches() {
  resetBgSessionsCache();
}

// Подставная команда `name` в каталоге `dir`. `body` — тело ESM-скрипта: аргументы
// приходят в `process.argv.slice(2)`, stdin читается как обычно, код выхода задаётся
// `process.exitCode` или `process.exit`.
//
// `platform` задаётся явно только затем, чтобы форма win32 проверялась и с POSIX-машины
// (exec.test.mjs): вся суть починки в том, что на Windows файл обязан иметь расширение
// из PATHEXT, а прогнать там набор сегодня негде.
export function stubCommand(dir, name, body, { platform = process.platform } = {}) {
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${name}.stub.mjs`);
  writeFileSync(script, body.endsWith('\n') ? body : `${body}\n`);
  if (platform === 'win32') {
    // Перенос строки CRLF и `%*` целиком: cmd.exe разбирает батник построчно, а
    // аргументы прокидывает как есть — квотирование за него уже сделал вызывающий.
    writeFileSync(path.join(dir, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(path.join(dir, name),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  // Тело бинаря сменилось: прежний `--version` / `agents --json` больше не правда.
  resetCliCaches();
  return script;
}

// PATH песочницы: каталог с подставными бинарями впереди системного. Возвращает функцию
// возврата — PATH один на весь процесс теста, и оставленный подменённым он утекает в
// соседние ветки того же файла. `only` отсекает системный PATH целиком: так задаётся
// ветка «команды в PATH нет», и пустой каталог для неё нужен настоящий — пустая строка
// в PATH на win32 и на POSIX означает разное.
export function withStubPath(dir, { only = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const before = process.env.PATH;
  process.env.PATH = only ? dir : `${dir}${path.delimiter}${before}`;
  resetCliCaches();
  return () => { process.env.PATH = before; resetCliCaches(); };
}

// Снимок сессий по подставному ответу harness'а — вход машины состояний и шов печати
//. Дом один на весь набор: копии в трёх файлах уже разошлись — у одной
// была охрана `null`, у двух других нет, — а расходиться им нельзя по тому же доводу, по
// какому один дом у `participantFileStem`.
//
// Собирает снимок НАСТОЯЩИЙ driver Claude: сверять машину состояний с самодельной
// раскладкой значило бы проверять фикстуру, а не разбор, которым живёт продакшен. Живого
// `claude` при этом не трогает никто — список приходит фикстурой.
//
// `list === null` гасит снимок ЦЕЛИКОМ, как гасит его `snapshotSessions` на первом `null`
// (driver.ts): половинчатого снимка у механизма не бывает, и подавать его набору нельзя.
export function snapshotOfList(participants, list) {
  if (list === null) return null;
  return Object.fromEntries((participants ?? [])
    .filter((p) => p.sessionRef)
    // Ключ снимка — АДРЕС участника: по нему же ключуются health, contact point'ы и отметки
    // стопа, и его читает человек. Адрес пишет adapter, и лежит он полем `metadata`
    // (`addressOf`); собственные поля записи v1 — роль, harness, режим, session
    // reference и снимок capabilities.
    .map((p) => [addressOf(p), claudeDriver.inspect(p.sessionRef, list)]));
}

// Песочница файла с уборкой на выходе процесса. `mkdtempSync` в хвосте файла
// парный `rmSync` не спасает: до него не доходит ровно тот прогон, где мусор и остаётся, —
// упавшая проверка уносит процесс через `process.exit` из `fail()`, а Ctrl+C не доходит
// и до этого. Хук `exit` срабатывает в обоих случаях, сигналы добираются отдельно.
//
// Под `npm test` каталог и так лежит внутри каталога прогона, который убирает раннер
// ([run.mjs](run.mjs)); этот помощник нужен запуску одного файла руками — то есть
// отладке, где падения и прерывания и случаются.
const sandboxes = [];
let hooked = false;
// Настоящий выход снимается при загрузке модуля: файлы набора подменяют `process.exit`
// бросателем, чтобы ловить отказы с `fail()` (install.test.mjs), и хук на сигнале звал бы
// подменённый — вместо кода 130 получилось бы необработанное исключение.
const exit0 = process.exit;

function keepUntilExit(dir) {
  sandboxes.push(dir);
  if (!hooked) {
    hooked = true;
    const clean = () => { for (const d of sandboxes.splice(0)) rmSync(d, { recursive: true, force: true }); };
    process.on('exit', clean);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => { clean(); exit0.call(process, 130); });
    }
  }
  return dir;
}

export function makeSandbox(prefix) {
  return keepUntilExit(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Standalone host config for a sandbox workspace: tools live in promptobus.json. */
export function writeHostConfig(dir, config = {}) {
  mkdirSync(dir, { recursive: true });
  const body = {
    commandName: 'promptobus',
    tools: ['claude', 'cursor', 'codex'],
    ...config,
  };
  writeFileSync(path.join(dir, 'promptobus.json'), `${JSON.stringify(body)}\n`);
}

/** PATH lookup for live scripts. Standalone host.resolveToolBin does not search install dirs. */
export function resolveToolBin(name) {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) {
    return { ok: false, reason: `${name}: not found on PATH`, bin: name };
  }
  return { ok: true, path: name, bin: name, version: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

// Путь тестового сокета — целиком, вместе с выбором корня. Помощник отдаёт
// строитель `имя → путь`, а не каталог: каталог на Windows бессмыслен — сокет там
// именованный канал и файловой системы не занимает вовсе, — и помощник, отдающий там
// временный каталог, закреплял бы ловушку для третьего вызывающего.
//
// Зачем свой корень на POSIX. Полный путь unix-сокета ограничен примерно 104 байтами
// (`sun_path`), а под `npm test` временный каталог уведён в каталог прогона
// ([run.mjs](run.mjs)) и сам по себе занимает под семьдесят пять символов. `listen` на
// длинном пути падает `EINVAL`, и падает не проверкой, а необработанным событием: файл
// теста умирает целиком. Поодиночке тот же файл проходит — системный `/var/folders/…/T`
// короче каталога прогона ровно настолько, чтобы уложиться. За один run на это наступили
// дважды, в `promptobus-warden.test.mjs` и `doctor.test.mjs`, и приём жил копией в обоих.
//
// Замер на этой машине 2026-08-29: `/tmp/adoc-XXXXXX/live.sock` — 26 символов, тот же сокет
// под каталогом прогона — 97, а с прежним именем каталога `ati-a2a-sock-` — 105, то есть за
// пределом. Короткое имя каталога даёт запас в восемь символов и держится длиной чужого
// `TMPDIR`; короткий корень даёт семьдесят восемь и от машины не зависит. `TMPDIR` прогона
// помощник обходит намеренно, поэтому каталог убирает не раннер, а те же хуки выхода, что и
// песочницу.
export function makeSockPath(prefix) {
  return makeSockDir(prefix).sock;
}

// То же, но вместе с каталогом: его нужно снести тому, кто убирает за собой сам, — живому
// прогону в его `finally` ([live-e2e.mjs](../scripts/live-e2e.mjs)). Выводить каталог из
// строителя пути нельзя: на win32 строитель отдаёт `\\.\pipe\…`, и `rmSync` по такому
// «каталогу» пошёл бы по пространству именованных каналов (замечание ревью). Поэтому
// каталог отдаётся отдельным полем, а на win32 его нет вовсе — `null`.
export function makeSockDir(prefix) {
  if (process.platform === 'win32') {
    return { dir: null, sock: (name) => `\\\\.\\pipe\\${prefix}${process.pid}-${name}` };
  }
  const dir = keepUntilExit(mkdtempSync(path.join('/tmp', prefix)));
  return { dir, sock: (name) => path.join(dir, `${name}.sock`) };
}
