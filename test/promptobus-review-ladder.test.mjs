// Регресс на порядок локальной лесенки default-ветки. Запуск: npm test
//
// Предмет — фолбэк `localDefault` в [review.js](../lib/review.js). Достижим он в одном
// раскладе: ссылок origin в клоне нет вовсе (репозиторий собран `git init`, без remote), и
// `defaultBranch` имени не даёт. Тогда база диффа угадывается по лесенке ЛОКАЛЬНЫХ веток
// `['master', 'main']`.
//
// Чем важен порядок именно здесь. Spawn в этом раскладе лесенки не спрашивает вовсе — он
// берёт за базу `HEAD` и пишет точку ветвления в журнал. Лесенка остаётся reviewer'у на
// случай, когда записанной точки взять неоткуда: запись сделал прежний CLI, или ветку
// перебазировали. Угадать она обязана ту ветку, на которой `HEAD` и стоял: промахнись
// она — `merge-base` уходит к общему предку, и в дифф worker'а возвращается чужая
// незапушенная работа, беда .
//
// Лесенка `defaultBranch` ([fresh.js](../lib/fresh.js)) — origin'овая (`origin/HEAD` →
// `origin/master` → `origin/main`), и в этом раскладе она не работает вовсе: спорить двум
// лесенкам в одном прогоне не о чем. Порядок написан одинаково с ней по другой причине —
// чтобы два детекта читались одним правилом и ответы не разъехались, когда ссылки origin у
// клона появятся.
//
// Что пиннят проверки. Главная — ИНВАРИАНТ, а не устройство: база ревью равна коммиту, от
// которого `worktree add` завёл ветку. Он переживёт законную замену механизма (скажем, на
// явное чтение `HEAD`), а перестановку лесенки ловит не хуже имени ветки — угаданная ветка
// меняется, вместе с ней меняется база. Третья проверка читает имя ветки прямо из строки
// базы: на замене механизма покраснеет только она, и это сигнал перечитать этот файл, а не
// признак поломки.
//
// Файл отдельный, потому что расклад нужен свой: клон без ссылок origin, где есть ОБЕ
// локальные ветки и стоят они на разных коммитах. Фикстуры promptobus-review.test.mjs до фолбэка
// доходят (`rebase-api`, `merged-api`), но каждая с одной локальной веткой — по одной ветке
// очерёдность не наблюдаема, и перестановка `['main', 'master']` оставляет их зелёными.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { check } from './check.mjs';

// realpath: план канонизирует корень (macOS: /var → /private/var), и ожидания проверок
// сравниваются с каноническими путями. Уборка — на `makeSandbox`: упавшая
// проверка уносит процесс через `process.exit`, и хвостовой `rmSync` до неё не доходит.
const SB = realpathSync(makeSandbox('promptobus-promptobus-ladder-'));
const { planReview } = await import(new URL('../lib/review.js', import.meta.url).href);
const { createStandaloneHost } = await import(new URL('../lib/host.js', import.meta.url).href);

const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// --- workspace: минимум, который читает план ------------------------------
const WS = path.join(SB, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(path.join(WS, 'AGENTS.md'), 'workspace\n');
writeHostConfig(WS);

// --- клон без ссылок origin, обе локальные ветки на разных коммитах ------------
//
// `main` осталась на первом коммите, `master` ушла вперёд на работу оркестратора —
// незапушенную, ту самую, ради которой база и считается от ЛОКАЛЬНОЙ ветки.
// Ветка worker'а заводится от `master`, поэтому её точка ветвления — вершина `master`, и
// промах лесенки на `main` виден и в базе, и в составе диффа.
const REPO = path.join(WS, 'repos', 'loads_search', 'ladder-api');
mkdirSync(REPO, { recursive: true });
g(REPO, 'init', '-b', 'master');
writeFileSync(path.join(REPO, 'AGENTS.md'), 'Правила репозитория.\n');
g(REPO, 'add', '.');
g(REPO, 'commit', '-m', 'init', '-q');
const OLD = g(REPO, 'rev-parse', 'HEAD');
g(REPO, 'branch', 'main', OLD);
writeFileSync(path.join(REPO, 'orkestrator.txt'), 'незапушенная работа оркестратора\n');
g(REPO, 'add', '.');
g(REPO, 'commit', '-m', 'работа оркестратора', '-q');
const FORK = g(REPO, 'rev-parse', 'HEAD');
const WT = path.join(REPO, '.claude', 'worktrees', 'a2a-ladder');
g(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-ladder', WT, 'master');
writeFileSync(path.join(WT, 'rabota.txt'), `работа worker'а\n`);
g(WT, 'add', '.');
g(WT, 'commit', '-m', 'работа', '-q');

const heads = g(REPO, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n');
const remotes = g(REPO, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/');
check('фикстура: в клоне обе локальные ветки и ни одной ссылки origin — фолбэк достижим',
  heads.includes('master') && heads.includes('main') && remotes === '',
  `${heads.join(',')} · remotes=[${remotes}]`);
check('фикстура: ветку завели от master, и точка ветвления с main другая — промах виден',
  FORK !== OLD && g(WT, 'merge-base', 'master', 'HEAD') === FORK
  && g(WT, 'merge-base', 'main', 'HEAD') === OLD, `master=${FORK} main=${OLD}`);

// --- сама проверка ------------------------------------------------------------
// Standalone defaultBranch falls back to HEAD when origin refs are absent, which would
// name the worktree branch itself and skip review.js's local ['master','main'] ladder.
// This file pins that ladder, so the host here reports no named default.
const host = createStandaloneHost({ cwd: WS });
host.defaultBranch = () => null;
const plan = planReview(host, { target: WT, title: 'лесенка' });
check(': база ревью — коммит, от которого worktree add завёл ветку',
  plan.baseRef === FORK, `${plan.baseRef} · ветвились от ${FORK}, у main ${OLD}`);
check(': при перестановке лесенки в дифф вернулась бы работа оркестратора — её там нет',
  plan.diff.includes('rabota.txt') && !plan.diff.includes('orkestrator.txt'), plan.stat);
check(': угаданная ветка названа вслух, и это master — прямое чтение порядка лесенки',
  /merge-base с master /.test(String(plan.baseLine)), String(plan.baseLine));
