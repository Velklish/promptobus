import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  GIT_MAX_OUTPUT, GIT_NET_TIMEOUT_MS, PROC_INSTALL_TIMEOUT_MS, lastLines, procTimedOut, runProc,
  shellQuote, toPosix, writeFileAtomic,
} from './copy/util.js';

// git — источник правды о worktree worker'а. Spawn задаёт имя ветки при подъёме, но
// worker, которому бриф велел завести свою, уводит worktree на неё — журнал остаётся со
// служебной. git зовётся напрямую spawnSync, а не через exec.js: обёртка нужна там, где у
// бинаря на Windows бывает .cmd, а git — нативный .exe. Тяжёлых импортов нет: модуль
// читает и MCP-сервер шины, поднимаемый на каждого участника.

// Префикс ветки, которую заводит spawn: здесь же по нему решается, наша ветка или чужая.
export const WORKTREE_BRANCH_PREFIX = 'worktree-';

/**
 * Каталог служебных worktree внутри клона — относительным путём (`BL-466`). Дом у него
 * здесь, а не у подъёма: тот же путь стоит в строке `.git/info/exclude` ниже, и две копии
 * разошлись бы молча — каталог заводился бы в одном месте, а исключался в другом, и клон
 * оставался бы навсегда грязным. Имя досталось от каталога, который в репозитории уже был;
 * к driver'у оно отношения не имеет — это раскладка рабочего места, одна на все harness'ы.
 */
export const WORKTREE_DIR_REL = path.join('.claude', 'worktrees');

// Шаблон имени служебной ветки целиком — тем видом, каким его цитируют прозой скилл
// оркестрации и гайд (`<!-- contract:worktree-branch -->`, ключ в VALUE_HOMES lint.js).
// Собирается ИЗ префикса: иначе переименование оставило бы шаблон и цитаты прежними.
export const WORKTREE_BRANCH_TEMPLATE = `${WORKTREE_BRANCH_PREFIX}promptobus-<слаг задачи>-<слаг worker'а>-t<дата>-<время>`;

// Потолки вывода и ожидания — общие с fresh.js и zone.js: на дефолтном мегабайте
// `status --porcelain` грязного worktree процесс убивается. Таймаут страхует от залипшего
// index.lock. `core.quotePath=false` — нелатинские строки приезжают читаемыми.
const git = (dir, ...args) => spawnSync('git', ['-c', 'core.quotePath=false', '-C', dir, ...args], {
  encoding: 'utf8',
  maxBuffer: GIT_MAX_OUTPUT,
  timeout: GIT_NET_TIMEOUT_MS,
});
const out = (r) => (r.status === 0 ? (r.stdout ?? '').trim() : null);

// Почему git отказал — одной строкой и никогда пустой: убитый по таймауту или упёршийся в
// потолок вывода процесс не оставляет ни stderr, ни статуса, причина лежит в `error`.
const gitWhy = (r) => (r.stderr ?? '').trim().split('\n').filter(Boolean).pop()
  || r.error?.message
  || 'git не объяснил';

// Ref'ы default-ветки по порядку предпочтения: локальная, затем origin-версия. Только
// существующие. Порядок один на всех потребителей — второй копии этой лесенки быть не должно.
export function defaultRefs(repoAbs, def) {
  return [def, def && `origin/${def}`]
    .filter(Boolean)
    .filter((r) => out(git(repoAbs, 'rev-parse', '--verify', '--quiet', r)) !== null);
}

// Ветка, на которой worktree стоит сейчас. null — каталога нет, git молчит или HEAD отсоединён.
export function worktreeBranch(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return null;
  const branch = out(git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'));
  return branch && branch !== 'HEAD' ? branch : null;
}

// Шапка расхождения журнала с git. Цитируется прозой дословно — справочником и скиллом
// оркестрации, — поэтому живёт константой: цитату сверяет с ней гейт contract quote (ключ
// `branch-changed-mark` в lint.js).
export const BRANCH_CHANGED_MARK = 'WORKER СМЕНИЛ ВЕТКУ';

// Строка про ветку участника: журнал против git. Разошлось — громкая: забирать результат
// надо из той ветки, что назвал git.
export function branchLine(journalBranch, actualBranch) {
  if (!actualBranch) return journalBranch ? `ветка ${journalBranch} (git не ответил — worktree снят?)` : null;
  if (!journalBranch || journalBranch === actualBranch) return `ветка ${actualBranch}`;
  return `ветка ${actualBranch} — ${BRANCH_CHANGED_MARK} (в журнале ${journalBranch}): результат забирать из ${actualBranch}`;
}

// Что известно про worktree перед уборкой. `def` — имя default-ветки, его приносит
// вызывающий: определяет её fresh.js, и тянуть его сюда значит тянуть весь резолв
// репозиториев. `unmerged` — сколько коммитов ветки нет в default; null — сверить не с чем.
export function inspectWorktree(repoAbs, worktreePath, def) {
  // Каталога нет — отвечаем тем же «не знаю», что и на молчание git: `dirty: null` уводит
  // решение в `keep`.
  if (!worktreePath || !existsSync(worktreePath)) return { branch: null, dirty: null, unmerged: null, base: null, adds: null };
  const branch = worktreeBranch(worktreePath);
  const dirty = out(git(worktreePath, 'status', '--porcelain'));
  // Сверяем с ОБЕИМИ default-ветками: работа, слитая в origin при отставшем локальном
  // master, иначе держала бы каталог как невзятый.
  const refs = defaultRefs(repoAbs, def);
  const counts = branch ? refs.map((r) => ({ ref: r, n: out(git(repoAbs, 'rev-list', '--count', `${r}..${branch}`)) })) : [];
  const known = counts.filter((c) => c.n !== null).map((c) => ({ ref: c.ref, n: Number(c.n) }));
  const best = known.length ? known.reduce((a, b) => (b.n < a.n ? b : a)) : null;
  const needAdds = !!best && best.n > 0 && dirty !== null && dirty.length === 0 && !!branch;
  return {
    branch,
    dirty: dirty === null ? null : dirty.length > 0,
    unmerged: best ? best.n : null,
    base: best ? best.ref : null,
    // Считаем только там, где ответ понадобится: `merge-tree --write-tree` — полное
    // трёхстороннее слияние. Не считали — `null` («не знаю»), а не `false`: `false`
    // означал бы «сверили, вливать нечего» — приговор каталогу без сверки.
    adds: needAdds ? branchAdds(repoAbs, best.ref, branch) : null,
  };
}

// Добавит ли ветка хоть что-нибудь, если влить её в базу. Сверки по предкам мало: при
// squash-мерже история ветки в базу не попадает. `merge-tree --write-tree` ничего не пишет
// в рабочее дерево (git ≥ 2.38); конфликт, старый git, отказ — `null`, решает «оставить».
function branchAdds(repoAbs, base, branch) {
  const r = git(repoAbs, 'merge-tree', '--write-tree', base, branch);
  if (r.status !== 0) return null;
  const merged = (r.stdout ?? '').trim().split('\n')[0];
  const baseTree = out(git(repoAbs, 'rev-parse', `${base}^{tree}`));
  if (!merged || !baseTree) return null;
  return merged !== baseTree;
}

// Судьба каталога — чистая функция от того, что нашлось. Убираем только доказанно
// безлюдное; всё остальное оставить: каталог дёшево удалить и невозможно вернуть.
export function worktreeDisposition(info) {
  if (info?.dirty == null) return { action: 'keep', reason: 'git не ответил про состояние дерева' };
  if (info.dirty) return { action: 'keep', reason: 'в дереве незакоммиченные правки' };
  if (!info.branch) return { action: 'keep', reason: 'git не назвал ветку (отсоединённый HEAD?)' };
  if (info.unmerged === null) return { action: 'keep', reason: 'не с чем сверить: default-ветки репозитория не видно' };
  if (info.unmerged > 0) {
    // Коммитов в базе нет, но и вливать нечего — работу взяли сквошем.
    if (info.adds === false) {
      return { action: 'remove', reason: `ветка ${info.branch} не добавляет к ${info.base} ничего — работа взята (похоже, squash-мержем)` };
    }
    const why = info.adds === null ? ' (слить их с базой не удалось — конфликт или старый git)' : '';
    return { action: 'keep', reason: `${info.unmerged} коммит(ов) ветки ${info.branch} нет в ${info.base}${why} — забери (merge/MR) или удали сам` };
  }
  return { action: 'remove', reason: `ветка ${info.branch} целиком в ${info.base}` };
}

// Лок каталога worktree: `git worktree list --porcelain` печатает у залоченного строку
// `locked`, а с `--reason` — `locked <причина>`. `null`, когда git не ответил или каталога
// в списке нет. Пути сверяем по realpath: на macOS каталог во временной папке приезжает и
// как `/var/…`, и как `/private/var/…`.
function realOrSelf(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

function worktreeLock(repoAbs, worktreePath) {
  const list = out(git(repoAbs, 'worktree', 'list', '--porcelain'));
  if (list === null) return null;
  const target = realOrSelf(worktreePath);
  let here = false;
  let found = false;
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) {
      here = realOrSelf(line.slice('worktree '.length).trim()) === target;
      found = found || here;
      continue;
    }
    if (!here) continue;
    if (line.trim() === 'locked') return { locked: true, reason: '' };
    if (line.startsWith('locked ')) return { locked: true, reason: line.slice('locked '.length).trim() };
  }
  // Каталог в списке есть, строки `locked` нет — не залочен. Каталога в списке нет вовсе —
  // это «не знаю», а не «не залочен».
  return found ? { locked: false, reason: '' } : null;
}

// Снятие каталога и ветки. Ветку удаляем безопасным `-d`: сверка выше уже сказала, что
// она слита, и `-d` держит второй, независимый гейт — разойдись они, победит git.
export function removeWorktree(repoAbs, worktreePath, branch) {
  let rm = git(repoAbs, 'worktree', 'remove', worktreePath);
  // `git worktree remove` на залоченном каталоге отказывает. Лок с причиной ставил
  // человек — чужой замок уборка не снимает; лок без причины — след прежнего механизма
  // (`claude --bg --worktree` лочил свой каталог, сами мы не лочим) — снимаем и пробуем
  // ещё раз. `-f` не используем: он снимает и защиту от незакоммиченных правок.
  if (rm.status !== 0) {
    const lock = worktreeLock(repoAbs, worktreePath);
    if (lock?.locked && lock.reason) {
      return {
        removed: false,
        error: `каталог залочен человеком (${lock.reason}) — снимать чужой лок уборка не станет.`
          + ` Лок больше не нужен: git -C ${shellQuote(repoAbs)} worktree unlock ${shellQuote(worktreePath)}`,
        branchKept: null,
      };
    }
    if (lock?.locked && git(repoAbs, 'worktree', 'unlock', worktreePath).status === 0) {
      rm = git(repoAbs, 'worktree', 'remove', worktreePath);
      // Снять всё равно не вышло — лок возвращаем на место: мы его не ставили, и
      // расстёгнутый каталог означал бы, что уборка молча потеряла чужую защиту.
      if (rm.status !== 0) git(repoAbs, 'worktree', 'lock', worktreePath);
    }
  }
  if (rm.status !== 0) return { removed: false, error: gitWhy(rm), branchKept: null };
  // Удаляем только ветку, которую завёл spawn. Ветка, на которую worker уехал по просьбе
  // задания, — не наша; тем же путём под удаление попала бы и default-ветка. `-d` от этого
  // не спасает: он проверяет слитость, а не принадлежность.
  const ours = typeof branch === 'string' && branch.startsWith(WORKTREE_BRANCH_PREFIX);
  const br = ours ? git(repoAbs, 'branch', '-d', branch) : null;
  const deleted = br ? br.status === 0 : false;
  // Своя ветка, которую `-d` не отдал, — почти всегда сквош: безопасная форма считает
  // слитость по предкам. Молчать о ней нельзя: ветки копятся в клоне.
  return {
    removed: true,
    branchDeleted: deleted,
    branchKept: ours ? null : (branch ?? null),
    branchStuck: ours && !deleted ? branch : null,
  };
}

// Заводим рабочее дерево worker'а сами, а не флагом `claude --worktree`: флаг базу
// выбирать не даёт и берёт её у origin — незапушенных локальных коммитов worker не увидит.
export function createWorktree(repoAbs, worktreePath, branch, base) {
  // Два живых остатка прошлых run'ов, на которых `worktree add` отказывает там, где
  // продолжить можно: осиротевшую регистрацию снимает prune, а на уцелевшей ветке
  // `worktree-…` дерево заводится БЕЗ `-b` — повторный spawn продолжает работу.
  pruneWorktrees(repoAbs);
  const exists = out(git(repoAbs, 'rev-parse', '--verify', '--quiet', branch)) !== null;
  const args = exists
    ? ['worktree', 'add', '-q', worktreePath, branch]
    : ['worktree', 'add', '-q', '-b', branch, worktreePath, ...(base ? [base] : [])];
  const r = git(repoAbs, ...args);
  if (r.status !== 0) return { created: false, error: gitWhy(r), reused: false, baseSha: null };
  // Точка ветвления — sha, снятый сразу после создания ветки: именем базы её не заменить,
  // имя догоняет чужие коммиты. У уцелевшей ветки HEAD точкой ветвления уже не является —
  // её знает только журнал, поэтому `null`.
  const baseSha = exists ? null : out(git(repoAbs, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`));
  return { created: true, reused: exists, baseSha };
}

// Признак и команда установки — одни на spawn и на `--dry-run`. Нет lock'а — шага нет
// вовсе и в выводе его нет: репозитории без npm (.NET, Python) не должны видеть чужой
// toolchain. `npm`, не `git`: на Windows это `.cmd`, и без `runProc` spawnSync его не найдёт.
// Команда целиком — `<!-- contract:npm-ci -->`, ключ в VALUE_HOMES lint.js.
const WORKTREE_LOCK = 'package-lock.json';
const NPM_CI_ARGS = ['ci', '--no-audit', '--no-fund'];

export function worktreeHasLock(dir) {
  return !!dir && existsSync(path.join(dir, WORKTREE_LOCK));
}

export function npmCiCommand() {
  return `npm ${NPM_CI_ARGS.join(' ')}`;
}

// Репозиторий, в котором `node_modules` не в ignore, после установки навсегда грязный:
// `done` такое дерево не снимает, а `git add -A` унесёт зависимости в коммит.
function nodeModulesIgnored(worktreePath) {
  const r = git(worktreePath, 'check-ignore', '-q', 'node_modules');
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/**
 * Ставит зависимости в только что заведённый worktree. Отказ установки — не отказ
 * spawn'а: worker без `node_modules` хуже, чем без worker'а — нет. Вывод `npm` в лог
 * рядом с каталогом, не в дерево и не в терминал: файл внутри worktree стал бы
 * незакоммиченной правкой, а служебный каталог worktree уже в exclude клона.
 * Хвост вывода и путь лога уезжают в предупреждение: лог, который никто не называет,
 * после отказа не найти.
 */
// `env` — шов проверки ENOENT. spawnSync без явного env берёт PATH процесса, а раннер
// набора часто оставляет системный PATH дочернему, и спрятать npm из process.env мало.
export function installWorktreeDeps(worktreePath, { env } = {}) {
  if (!worktreeHasLock(worktreePath)) return { ran: false };
  const started = Date.now();
  const r = runProc('npm', NPM_CI_ARGS, { cwd: worktreePath, timeout: PROC_INSTALL_TIMEOUT_MS, ...(env ? { env } : {}) });
  const ms = Date.now() - started;
  const logPath = `${worktreePath}.npm-ci.log`;
  try {
    writeFileSync(logPath, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`);
  } catch { /* лог — удобство; отказ записи не откатывает spawn */ }
  const ignored = nodeModulesIgnored(worktreePath);
  if (r.status === 0) return { ran: true, ok: true, ms, logPath, ignored };
  let why;
  if (r.error?.code === 'ENOENT') why = 'npm не найден в PATH';
  else if (procTimedOut(r)) why = `не ответил за ${PROC_INSTALL_TIMEOUT_MS / 1000} с`;
  else {
    const tail = lastLines(r.stderr || r.stdout || r.error?.message || '');
    const code = r.status ?? r.error?.code ?? '?';
    why = tail ? `завершился с кодом ${code}: ${tail}` : `завершился с кодом ${code}`;
  }
  return { ran: true, ok: false, ms, why, command: npmCiCommand(), logPath, ignored };
}

// Служебный каталог не должен выглядеть незакоммиченной правкой: иначе клон навсегда
// грязный, а `fresh` грязное дерево не трогает. Пишем в `.git/info/exclude` — файл
// локальный. Исход тристейтом: added, present, failed — булев сливал бы «всё хорошо» и
// «клон останется грязным навсегда».
export function excludeWorktrees(repoAbs) {
  const probe = git(repoAbs, 'rev-parse', '--git-common-dir');
  const dir = out(probe);
  if (!dir) return { status: 'failed', error: `git не назвал каталог .git: ${gitWhy(probe)}` };
  const abs = path.isAbsolute(dir) ? dir : path.join(repoAbs, dir);
  const file = path.join(abs, 'info', 'exclude');
  const line = `**/${toPosix(WORKTREE_DIR_REL)}/`;
  try {
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // Строку мог поставить и сам Claude Code (блок `# claude-code-runtime`) — она устраивает.
    if (cur.split('\n').some((l) => l.trim() === line || l.trim() === '.claude/worktrees/')) {
      return { status: 'present', error: null };
    }
    // Своя строка со своим маркером; в чужой блок не пишем — при перегенерации пропала бы.
    const own = `# ati-agents: служебные worktree worker'ов Promptobus\n${line}\n`;
    // Запись через tmp+rename: в файле exclude-строки человека, терять их нельзя.
    writeFileAtomic(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${own}`,
      { mode: 0o644, preserveMode: true });
    return { status: 'added', error: null };
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

// Осиротевшие регистрации в .git/worktrees — от каталогов, снятых мимо git. Пока
// запись жива, git считает ветку занятой и не даёт добавить worktree по тому же пути.
export function pruneWorktrees(repoAbs) {
  return git(repoAbs, 'worktree', 'prune').status === 0;
}
