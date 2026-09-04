import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn } from '../util.js';
import { promptobusHome, filesDir, GateError, listTasks, taskDir } from './store.js';
import { PRUNE_DEFAULT_DAYS } from './contract.js';

// Порог по умолчанию реэкспортируется отсюда: дом у него в contract.js, а зовут его по
// имени этой команды.
export { PRUNE_DEFAULT_DAYS };

// Уборка журнала задач. `promptobus done` закрывает задачу и снимает за ней каталоги worktree,
// mcp-конфиги и contact point'ы, а сама переписка остаётся на диске навсегда. Замер
// 2026-08-30 на живом workspace — 54 задачи, 18 МБ, из них 53 закрытых; на 2026-08-28 было
// 40 задач и 11 МБ, то есть порядка 3 МБ в день плотной оркестрации.
//
// Предмет отделён от `done.js`: `done` заканчивает ЖИВОЙ run и метёт за ним чужое
// (каталоги, секреты), а `prune` сносит журнал давно закрытого. Разная цена ошибки —
// разные команды: `done` зовут в каждом run'е, `prune` человек зовёт руками.
//
// Артефакты уезжают вместе с перепиской, а не живут своим сроком: артефакт прислан
// сообщением, и без сообщения он файл без повода. Проба называет их число отдельно.
const DAY_MS = 24 * 60 * 60 * 1000;

// Вес задачи — обход её каталога. Он и есть предмет команды: без числа проба говорит
// «двенадцать задач», а человек спрашивает «сколько это места». Нечитаемое поддерево
// пропускается нулём: падать на чужом файле команде про размер незачем.
function dirSize(dir) {
  let sum = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { sum += dirSize(p); continue; }
    try { sum += statSync(p).size; } catch { /* файл унесли между обходом и статом */ }
  }
  return sum;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

// Каталог worktree, названный журналом и всё ещё стоящий на диске. Задача с таким
// каталогом мёртвой не считается ни при каком возрасте: `done` его не убрал, а журнал —
// единственное место, где записано, где эта работа лежит и чья она. Снеси журнал — и
// каталог останется сиротой без имени.
function heldWorktrees(meta) {
  return (meta.participants ?? [])
    .map((p) => p?.metadata?.worktree)
    .filter((w) => w && existsSync(w));
}

// Что считается мёртвым: задача ЗАКРЫТА и закрыта давно. Статус отделяет живой run от
// истории, возраст даёт человеку время вернуться в переписку. Отметки о закрытии нет
// (журнал прежнего CLI или правка руками) — задача не трогается: возраст неизвестен, а
// «неизвестно» на удалении значит «нет».
function pruneCandidates(home, days) {
  const edge = Date.now() - days * DAY_MS;
  const out = { dead: [], young: 0, active: 0, undated: 0, held: [] };
  for (const meta of listTasks(home)) {
    if (meta.status !== 'done') { out.active += 1; continue; }
    const closed = Date.parse(meta.adapter.closed ?? '');
    if (Number.isNaN(closed)) { out.undated += 1; continue; }
    if (closed > edge) { out.young += 1; continue; }
    const held = heldWorktrees(meta);
    if (held.length) { out.held.push({ meta, held }); continue; }
    out.dead.push({
      meta,
      closed,
      size: dirSize(taskDir(home, meta.id)),
      arts: existsSync(filesDir(home, meta.id)) ? readdirSync(filesDir(home, meta.id)).length : 0,
    });
  }
  return out;
}

// Перечень под уборку — одними строками у пробы, у `--yes` и у `promptobus done`: каким бы
// путём уборка ни пришла, человек читает про снимаемое одно и то же.
function sayCandidates(dead) {
  for (const { meta, closed, size, arts } of dead) {
    info(`${meta.id} «${meta.title ?? ''}» — закрыта ${new Date(closed).toISOString().slice(0, 10)}, `
      + `${humanSize(size)}${arts ? `, артефактов ${arts}` : ''}`);
  }
}

// Само удаление и его итог. Отказ по одной задаче обход не прерывает: у `promptobus done`
// уборка идёт ПОСЛЕ закрытия, и брошенный отсюда отказ унёс бы остальные каталоги. В итог
// при этом идут только снятые: «убрано 3» о двух снятых — неправда о необратимом действии.
// Не снялось НИЧЕГО — итог жёлтый: зелёная строка «убрано задач 0» отчитывается успехом о
// несделанном, и человек уходит, не прочитав причин выше.
//
// `remove` — шов для набора: сделать каталог неудаляемым переносимо нечем (chmod на
// Windows не запрещает удаление, а под root не запрещает нигде), и ветка отказа осталась
// бы непроверенной.
function removeJournals(home, dead, { days, young, remove = rmSync }) {
  let gone = 0;
  let failed = 0;
  for (const { meta, size } of dead) {
    try {
      remove(taskDir(home, meta.id), { recursive: true, force: true });
      gone += size;
    } catch (e) {
      failed += 1;
      warn(`задача ${meta.id} не убрана: ${e.message}`);
    }
  }
  const count = dead.length - failed;
  if (count) {
    ok(`журналы убраны: задач ${count}, освобождено ${humanSize(gone)} (моложе ${days} дн. — ${young}, не тронуты)`);
  } else {
    warn(`журналы не убраны: не снялась ни одна из ${dead.length} задач (отказов ${failed}) — причина по каждой строкой выше`);
  }
  return { count, gone, failed };
}

/**
 * Уборка журналов давно закрытых задач порогом по умолчанию — то же, что делает
 * `prune --yes`, и зовёт её `promptobus done` после своей работы (`BL-432`, решение
 * владельца 2026-09-02). Закрытие задачи — единственный момент, когда человек и так
 * прибирает и видит перечень; старт надзирателя идёт без человека у клавиатуры.
 *
 * Перечень снятого печатается, контекстные строки ручной команды (активные, без отметки,
 * занятые каталогом) — нет: их читают у `promptobus prune`, за ними его и зовут. Убирать
 * нечего — молчим совсем: `done` не отчёт о журнале, и строка про несделанное на каждом
 * закрытии была бы шумом.
 */
export function sweepJournals(home, days = PRUNE_DEFAULT_DAYS, { remove } = {}) {
  const { dead, young } = pruneCandidates(home, days);
  if (!dead.length) return { count: 0, gone: 0, failed: 0 };
  sayCandidates(dead);
  return removeJournals(home, dead, { days, young, ...(remove ? { remove } : {}) });
}

// Проба по умолчанию, удаление по явному `--yes`: команду зовёт агент, и сессия, решившая
// «посмотреть, что там накопилось», иначе снесла бы переписку недели. Обратного хода нет —
// журнал лежит вне git.
export function prune(root, { olderThan, yes } = {}) {
  const home = promptobusHome(root);
  // Пустое значение (`--older-than=`) — негодное, а не «ноль дней»: `Number('')` даёт 0, и
  // уборка снесла бы ВСЕ закрытые задачи с отметкой. Порог `0` остаётся законным, но
  // названным цифрой, а не пропуском значения.
  const raw = olderThan === undefined ? null : String(olderThan).trim();
  const days = raw === null ? PRUNE_DEFAULT_DAYS : Number(raw);
  if (raw === '' || !Number.isFinite(days) || days < 0) {
    throw new GateError(`--older-than <дней>: ожидалось неотрицательное число, получено «${olderThan}»`);
  }
  const { dead, young, active, undated, held } = pruneCandidates(home, days);
  for (const { meta, held: dirs } of held) {
    warn(`задача ${meta.id} оставлена: её worktree ещё на диске (${dirs.join(', ')}) — `
      + 'журнал называет, где лежит эта работа. Забери её или сними каталог, тогда задача уберётся');
  }
  if (undated) info(`закрытых задач без отметки о закрытии: ${undated} — возраст неизвестен, не трогаем`);
  info(`активных задач: ${active} — они не трогаются ни при каком вызове`);
  if (!dead.length) {
    ok(`убирать нечего: закрытых задач старше ${days} дн. нет (моложе — ${young})`);
    return;
  }
  const total = dead.reduce((s, t) => s + t.size, 0);
  sayCandidates(dead);
  if (!yes) {
    ok(`проба: под уборку попадает задач ${dead.length} на ${humanSize(total)} (моложе ${days} дн. — ${young}). `
      + `Ничего не удалено. Удалить: npx ati-agents promptobus prune --older-than ${days} --yes`);
    return;
  }
  removeJournals(home, dead, { days, young });
}
