// Регресс на правду о worktree и о живости сессии (). Запуск: npm test
//
// Два предмета. Первый — git как источник правды: имя ветки берётся у него, а не из
// журнала задачи, и по нему же решается судьба каталога при закрытии задачи. Фикстуры
// настоящие: репозиторий с worktree во временной папке, моков git нет — проверяем ровно
// то, что он делает. Второй — разбор записи сессии из `claude agents --json`: тут наоборот,
// записи синтетические, потому что интересна логика, а не живой claude.
//
// **Имена вида `a2a-…` в фикстурах оставлены намеренно**: так называл ветки,
// каталоги worktree и сессии прежний CLI, и на них проверяется, что hard rename не сломал
// уже заведённое. Разбор — в `promptobus.test.mjs`, шапка файла.
import {
  writeFileSync, readFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { check } from './check.mjs';

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-wt-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  branchLine, createWorktree, defaultRefs, excludeWorktrees, inspectWorktree,
  removeWorktree, worktreeBranch, worktreeDisposition,
} = await import(path.join(here, '..', 'lib', 'worktree.js'));
// Реестр сессий и подъём живут за контрактом driver'а: `spawn.js` их больше не
// реэкспортирует — он вообще не импортирует ни `liftoff.js`, ни driver, и это сторожит гейт
// границы adapter'а. Набор берёт их из их собственного дома.
const {
  sessionLiveness, awaitSession, findSession, spawnedSessionId, parseSessionId,
} = await import(path.join(here, '..', 'lib', 'liftoff.js'));

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

// --- фикстура: репозиторий с двумя worktree ------------------------------------
const REPO = path.join(SB, 'repo');
mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q', '-b', 'master');
writeFileSync(path.join(REPO, 'f'), 'первый\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-qm', 'первый');

// Worktree worker'а, который ничего не менял: ветка целиком в master.
const CLEAN = path.join(REPO, '.claude', 'worktrees', 'clean');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-clean', CLEAN);
// Worktree worker'а со своей работой: коммит, которого в master нет.
const AHEAD = path.join(REPO, '.claude', 'worktrees', 'ahead');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-ahead', AHEAD);
writeFileSync(path.join(AHEAD, 'f'), `работа worker'а\n`);
git(AHEAD, 'add', '.');
git(AHEAD, 'commit', '-qm', 'работа');
// Worktree, который worker увёл на собственную ветку по просьбе брифа — тот самый
// случай, из-за которого MR !37 открылся пустым.
const MOVED = path.join(REPO, '.claude', 'worktrees', 'moved');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-moved', MOVED);
git(MOVED, 'checkout', '-q', '-b', 'feat/diagnostics-domain');

// --- ветка: у git, а не по конвенции имени ----------------------------
check('ветка worktree берётся у git', worktreeBranch(CLEAN) === 'worktree-a2a-clean', String(worktreeBranch(CLEAN)));
check('worker сменил ветку — git отдаёт ту, на которой он стоит сейчас',
  worktreeBranch(MOVED) === 'feat/diagnostics-domain', String(worktreeBranch(MOVED)));
check('каталога нет — null, а не выдуманная ветка', worktreeBranch(path.join(REPO, 'нет')) === null);
check('отсоединённый HEAD — null, а не строка «HEAD»', (() => {
  const head = git(MOVED, 'rev-parse', 'HEAD').stdout.trim();
  git(MOVED, 'checkout', '-q', head);
  const got = worktreeBranch(MOVED);
  git(MOVED, 'checkout', '-q', 'feat/diagnostics-domain');
  return got === null;
})());

check('строка ветки: журнал и git совпали — без шума', branchLine('worktree-a2a-clean', 'worktree-a2a-clean') === 'branch worktree-a2a-clean');
check('строка ветки: расхождение названо громко и с обеими ветками', (() => {
  const line = branchLine('worktree-a2a-moved', 'feat/diagnostics-domain');
  return line.includes('WORKER CHANGED BRANCH') && line.includes('worktree-a2a-moved') && line.includes('feat/diagnostics-domain');
})(), branchLine('worktree-a2a-moved', 'feat/diagnostics-domain'));
check('строка ветки: git молчит — говорим это, а не печатаем журнальную как факт',
  branchLine('worktree-a2a-clean', null).includes('git did not answer'), branchLine('worktree-a2a-clean', null));

// --- судьба каталога при закрытии задачи ------------------------------
const disp = (p) => worktreeDisposition(inspectWorktree(REPO, p, 'master'));
check('слитый и чистый worktree — снять', disp(CLEAN).action === 'remove', JSON.stringify(disp(CLEAN)));
check('есть свои коммиты — оставить и назвать, сколько их', (() => {
  const d = disp(AHEAD);
  return d.action === 'keep' && d.reason.includes('1 commit');
})(), JSON.stringify(disp(AHEAD)));
check('сверка идёт по ветке от git, а не по журнальной: уведённый worktree не снимается', (() => {
  writeFileSync(path.join(MOVED, 'f'), 'правка на своей ветке\n');
  git(MOVED, 'add', '.');
  git(MOVED, 'commit', '-qm', 'своя ветка');
  const d = disp(MOVED);
  return d.action === 'keep' && d.reason.includes('feat/diagnostics-domain');
})(), JSON.stringify(disp(MOVED)));
check('незакоммиченные правки — оставить', (() => {
  writeFileSync(path.join(CLEAN, 'f'), 'недописанное\n');
  const d = disp(CLEAN);
  writeFileSync(path.join(CLEAN, 'f'), 'первый\n');
  return d.action === 'keep' && d.reason.includes('uncommitted');
})());
// Тристейт `adds` держится честно: `false` означает «сверили merge-tree, вливать
// нечего» — приговор каталогу. Там, где сверки не было (грязное дерево, молчание git,
// слитая ветка), ответ обязан быть `null` — «не знаю».
check('adds не выдумывает «вливать нечего» там, где не сверял', (() => {
  const clean = inspectWorktree(REPO, CLEAN, 'master');
  writeFileSync(path.join(AHEAD, 'f'), 'недописанное\n');
  const dirty = inspectWorktree(REPO, AHEAD, 'master');
  writeFileSync(path.join(AHEAD, 'f'), `работа worker'а\n`);
  return clean.adds === null && dirty.adds === null && worktreeDisposition(dirty).action === 'keep';
})(), JSON.stringify(inspectWorktree(REPO, CLEAN, 'master')));
// Каталога нет — тот же ответ, что на молчание git: «не знаю» → `keep`.
// Отдельного вердикта 'gone' у решателя больше нет, и это не косметика: боевой
// потребитель (уборка в spawn.js) отсеивает несуществующий каталог раньше, а всё, что
// не 'keep', он ведёт в `removeWorktree` — то есть прежняя ветка была миной.
check('каталога нет — оставить, а не вести в снос', (() => {
  const d = worktreeDisposition(inspectWorktree(REPO, path.join(REPO, 'нет'), 'master'));
  return d.action === 'keep' && /git did not answer/.test(d.reason);
})(), JSON.stringify(worktreeDisposition(inspectWorktree(REPO, path.join(REPO, 'нет'), 'master'))));
check('сверить не с чем — оставить, а не снести на всякий случай',
  worktreeDisposition(inspectWorktree(REPO, CLEAN, 'нет-такой-ветки')).action === 'keep',
  JSON.stringify(inspectWorktree(REPO, CLEAN, 'нет-такой-ветки')));

// Само снятие: каталог уходит, слитая ветка уходит с ним. Каталог залочен нарочно —
// `claude --bg --worktree` лочит свои worktree, и живой `promptobus done` спотыкался ровно об это.
git(REPO, 'worktree', 'lock', CLEAN);
const rm = removeWorktree(REPO, CLEAN, 'worktree-a2a-clean');
check('снятие: каталога больше нет', rm.removed && !existsSync(CLEAN), JSON.stringify(rm));
check('снятие: слитая ветка удалена вместе с каталогом',
  rm.branchDeleted && !git(REPO, 'rev-parse', '--verify', '-q', 'worktree-a2a-clean').stdout.trim());
// Ветку с невзятой работой git не отдаст даже по прямой просьбе: `-d` — второй гейт
// поверх нашей сверки, и если они разойдутся, побеждает git.
const rmAhead = removeWorktree(REPO, AHEAD, 'worktree-a2a-ahead');
check('снятие несведённой ветки: каталог снят, но ветка с работой цела',
  rmAhead.removed && rmAhead.branchDeleted === false
  && !!git(REPO, 'rev-parse', '--verify', '-q', 'worktree-a2a-ahead').stdout.trim(), JSON.stringify(rmAhead));

// Ветку, которую завёл не spawn, снятие каталога не трогает: worker уехал на неё по
// просьбе задания, человек её для чего-то назвал, и слитость тут ничего не решает.
const movedBranch = 'feat/diagnostics-domain';
git(REPO, 'merge', '-q', '--no-edit', movedBranch);
// Слитость проверяем явно, а не считаем достигнутой: без неё `-d` отказал бы сам, и
// проверка ниже прошла бы по ложной причине — «ветку не тронули» вместо «не стали».
check('фикстура: чужая ветка действительно слита в master',
  git(REPO, 'branch', '--merged', 'master').stdout.includes(movedBranch),
  git(REPO, 'branch', '--merged', 'master').stdout);
const rmMoved = removeWorktree(REPO, MOVED, movedBranch);
check('снятие: чужую ветку не удаляем, даже слитую — и говорим, что оставили',
  rmMoved.removed && rmMoved.branchKept === movedBranch && rmMoved.branchDeleted === false
  && !!git(REPO, 'rev-parse', '--verify', '-q', movedBranch).stdout.trim(), JSON.stringify(rmMoved));

// --- лок каталога: свой снимаем, чужой не трогаем ---------------------
//
// Лок бывает двух пород. Без причины — след прежнего механизма (`claude --bg --worktree`
// лочил свои каталоги), его уборка снимает и каталог уносит: это проверено снятием CLEAN
// выше. С причиной — поставил человек, и его замок, объяснённый вслух, уборка не трогает.
const LOCKED = path.join(REPO, '.claude', 'worktrees', 'locked');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-locked', LOCKED);
git(REPO, 'worktree', 'lock', '--reason', 'разбираю руками', LOCKED);
const rmLocked = removeWorktree(REPO, LOCKED, 'worktree-a2a-locked');
check('лок с причиной — отказ, и причина человека названа в нём',
  !rmLocked.removed && String(rmLocked.error).includes('разбираю руками') && existsSync(LOCKED),
  JSON.stringify(rmLocked));
check('чужой лок остался на месте — уборка его не снимала',
  git(REPO, 'worktree', 'unlock', LOCKED).status === 0);
git(REPO, 'worktree', 'remove', '--force', LOCKED);
git(REPO, 'branch', '-D', 'worktree-a2a-locked');

// Лок без причины сняли, а снять каталог всё равно не вышло — лок возвращается на место:
// уборка его не ставила, и оставленный расстёгнутым каталог означал бы молча снятую
// чужую защиту.
const STUCK = path.join(REPO, '.claude', 'worktrees', 'stuck');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-stuck', STUCK);
writeFileSync(path.join(STUCK, 'новый'), 'незакоммиченное\n');
git(REPO, 'worktree', 'lock', STUCK);
const rmStuck = removeWorktree(REPO, STUCK, 'worktree-a2a-stuck');
check('снять не вышло — лок вернули на место, а не оставили снятым',
  !rmStuck.removed && git(REPO, 'worktree', 'unlock', STUCK).status === 0, JSON.stringify(rmStuck));
check('причина отказа непуста и на обычном отказе git',
  typeof rmStuck.error === 'string' && rmStuck.error.length > 0, JSON.stringify(rmStuck.error));
// Пустой stderr — не теория: убитый по таймауту или не запустившийся вовсе git не
// оставляет ни строки, и потребитель печатал «убрать не вышло: » без причины.
// Воспроизводим прямо: PATH без git, значит ENOENT и пустой stderr.
check('git не запустился вовсе — причина всё равно названа, а не пустая строка', (() => {
  const noGit = path.join(SB, 'без-git');
  mkdirSync(noGit, { recursive: true });
  const saved = process.env.PATH;
  process.env.PATH = noGit;
  const r = removeWorktree(REPO, STUCK, 'worktree-a2a-stuck');
  process.env.PATH = saved;
  return !r.removed && typeof r.error === 'string' && r.error.trim().length > 0;
})());
git(REPO, 'worktree', 'remove', '--force', STUCK);
git(REPO, 'branch', '-D', 'worktree-a2a-stuck');

// --- squash-мерж: коммитов в базе нет, а вливать нечего ---------------
//
// Проверка опирается на `git merge-tree --write-tree` — это git 2.38 и новее. Версию
// называем отдельной проверкой: иначе на старом git блок падает невнятно, и читатель
// гадает, дело в логике или в окружении.
const gitVer = (git(REPO, '--version').stdout.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const mergeTreeOk = gitVer.length === 2 && (gitVer[0] > 2 || (gitVer[0] === 2 && gitVer[1] >= 38));
check('окружение: git умеет merge-tree --write-tree (2.38+) — иначе сквош не распознать',
  mergeTreeOk, git(REPO, '--version').stdout.trim());
//
// Живой случай: MR !37 канона смержен сквошем — в master один коммит со всем содержимым,
// а десять коммитов ветки навсегда числятся «вне master». Сверки по предкам тут мало.
const SQ = path.join(REPO, '.claude', 'worktrees', 'squashed');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-squashed', SQ);
writeFileSync(path.join(SQ, 'sq1'), 'первая часть работы\n');
git(SQ, 'add', '.'); git(SQ, 'commit', '-qm', 'часть 1');
writeFileSync(path.join(SQ, 'sq2'), 'вторая часть работы\n');
git(SQ, 'add', '.'); git(SQ, 'commit', '-qm', 'часть 2');
// До сквоша вливать есть что — и это надо зафиксировать, иначе проверка ниже зелёная
// по любой причине, включая «функция всегда отвечает false».
check('невзятая работа: вливать есть что — каталог остаётся',
  inspectWorktree(REPO, SQ, 'master').adds === true
  && worktreeDisposition(inspectWorktree(REPO, SQ, 'master')).action === 'keep',
  JSON.stringify(inspectWorktree(REPO, SQ, 'master')));
// Сквош: содержимое ветки уезжает в master одним коммитом, история — нет.
git(REPO, 'merge', '-q', '--squash', 'worktree-a2a-squashed');
git(REPO, 'commit', '-qm', 'squash: работа ветки одним коммитом');
const sq = inspectWorktree(REPO, SQ, 'master');
check('фикстура: после сквоша коммиты ветки по-прежнему числятся вне master',
  sq.unmerged === 2, String(sq.unmerged));
check('squash-мерж: ветка не добавляет к базе ничего — каталог снимается',
  sq.adds === false && worktreeDisposition(sq).action === 'remove'
  && /squash/.test(worktreeDisposition(sq).reason), JSON.stringify(worktreeDisposition(sq)));
// Снятие идёт продукционным путём: у сквошенной ветки `git branch -d` слитости не видит
// (он считает по предкам), поэтому каталог уходит, а ветка остаётся — и обязана быть
// названа, иначе ветки копятся молча.
const rmSq = removeWorktree(REPO, SQ, 'worktree-a2a-squashed');
check('сквошенная ветка: каталог снят, ветка осталась и названа',
  rmSq.removed && rmSq.branchDeleted === false && rmSq.branchStuck === 'worktree-a2a-squashed'
  && rmSq.branchKept === null, JSON.stringify(rmSq));
git(REPO, 'branch', '-D', 'worktree-a2a-squashed');

// Третье состояние: слить нельзя — конфликт. Это «не знаю», и решать оно должно в пользу
// «оставить», назвав причину.
const CF = path.join(REPO, '.claude', 'worktrees', 'conflict');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-conflict', CF);
writeFileSync(path.join(CF, 'f'), 'версия ветки\n');
git(CF, 'add', '.'); git(CF, 'commit', '-qm', 'своя версия общего файла');
writeFileSync(path.join(REPO, 'f'), 'версия master\n');
git(REPO, 'add', '.'); git(REPO, 'commit', '-qm', 'другая версия того же файла');
const cf = inspectWorktree(REPO, CF, 'master');
check('конфликт слияния — «не знаю», а не «вливать нечего»', cf.adds === null, String(cf.adds));
check('неизвестность решает в пользу «оставить», и причина названа', (() => {
  const d = worktreeDisposition(cf);
  return d.action === 'keep' && /conflict or old git/.test(d.reason);
})(), JSON.stringify(worktreeDisposition(cf)));
git(REPO, 'worktree', 'remove', '--force', CF);
git(REPO, 'branch', '-D', 'worktree-a2a-conflict');

// --- база нового worktree: локальная default впереди origin -----------
//
// Главная развилка задачи: worker обязан видеть коммиты, которые человек ещё не запушил.
// Фикстура ставит origin/master намеренно позади локального master — ровно та картина,
// на которой прошлый worker не увидел кода оркестратора.
const OLD = git(REPO, 'rev-parse', 'master').stdout.trim();
writeFileSync(path.join(REPO, 'f'), 'незапушенная работа\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-qm', 'локальный коммит поверх origin');
const AHEAD_SHA = git(REPO, 'rev-parse', 'master').stdout.trim();
git(REPO, 'update-ref', 'refs/remotes/origin/master', OLD);

check('порядок предпочтения: локальная default впереди origin-версии',
  defaultRefs(REPO, 'master')[0] === 'master'
  && defaultRefs(REPO, 'master')[1] === 'origin/master', JSON.stringify(defaultRefs(REPO, 'master')));
check('несуществующие ref не отдаются', defaultRefs(REPO, 'нет-такой').length === 0);

const FRESH = path.join(REPO, '.claude', 'worktrees', 'fresh');
const madeFresh = createWorktree(REPO, FRESH, 'worktree-a2a-fresh', defaultRefs(REPO, 'master')[0]);
check('новый worktree заводится от локальной default-ветки, а не от origin/<default>',
  madeFresh.created && !madeFresh.reused
  && git(FRESH, 'rev-parse', 'HEAD').stdout.trim() === AHEAD_SHA,
  `${JSON.stringify(madeFresh)} · ожидали ${AHEAD_SHA.slice(0, 7)}`);
// Точка ветвления — sha, а не имя базы: имя догоняет чужие коммиты, а дифф
// worker'а `promptobus review` обязан считать ровно от того, что worker унаследовал. Именно
// это `master` и делает в этой фикстуре: origin/master стоит позади него.
check('createWorktree называет точку ветвления sha, а не именем базы',
  madeFresh.baseSha === AHEAD_SHA, `${madeFresh.baseSha} vs ${AHEAD_SHA}`);

// Перезапуск умершего worker'а тем же адресом: ветка уцелела, каталога нет. `-b` на такой
// ветке отказал бы — дерево должно завестись НА ней, а не рядом.
git(REPO, 'worktree', 'remove', FRESH);
const remade = createWorktree(REPO, FRESH, 'worktree-a2a-fresh', 'master');
check(`ветка уцелела с прошлого run'а — заводимся на ней, а не отказываем`,
  remade.created && remade.reused === true
  && worktreeBranch(FRESH) === 'worktree-a2a-fresh', JSON.stringify(remade));
// HEAD уцелевшей ветки точкой ветвления уже не является: worker на ней работал. Выдать
// его за точку значило бы обрезать его же работу из диффа reviewer'а — здесь честнее
// «не знаю»: точку такой ветки знает только журнал задачи.
check('уцелевшая ветка: точку ветвления createWorktree не выдумывает',
  remade.baseSha === null, String(remade.baseSha));
check('осиротевшая регистрация не мешает: каталог снесён руками — заводим заново', (() => {
  rmSync(FRESH, { recursive: true, force: true });
  const again = createWorktree(REPO, FRESH, 'worktree-a2a-fresh', 'master');
  return again.created && existsSync(FRESH);
})());
git(REPO, 'worktree', 'remove', '--force', FRESH);

// --- служебный каталог не грязнит клон --------------------------------
const DIRT = path.join(REPO, '.claude', 'worktrees', 'dirt');
createWorktree(REPO, DIRT, 'worktree-a2a-dirt', 'master');
check('фикстура: до исключения служебный каталог виден как незакоммиченная правка',
  git(REPO, 'status', '--porcelain').stdout.includes('.claude'),
  git(REPO, 'status', '--porcelain').stdout.trim());
check('после excludeWorktrees git status каталога не видит',
  excludeWorktrees(REPO).status === 'added'
  && !git(REPO, 'status', '--porcelain').stdout.includes('.claude'),
  git(REPO, 'status', '--porcelain').stdout.trim());
// Тристейт, а не булево: «уже стоит» и «записать не вышло» — разные исходы, и
// одинаковый ответ на них прятал от человека ровно тот, ради которого шаг заведён.
check('повторный вызов ничего не дописывает и говорит это своим исходом',
  excludeWorktrees(REPO).status === 'present', JSON.stringify(excludeWorktrees(REPO)));
check('строка помечена своим маркером — видно, кто её поставил',
  readFileSync(path.join(REPO, '.git', 'info', 'exclude'), 'utf8').includes('# promptobus:'));
check('отказ записи — свой исход, и с причиной, а не молчаливое «уже стоит»', (() => {
  const notRepo = path.join(SB, 'не-репозиторий');
  mkdirSync(notRepo, { recursive: true });
  const r = excludeWorktrees(notRepo);
  return r.status === 'failed' && typeof r.error === 'string' && r.error.length > 0;
})(), JSON.stringify(excludeWorktrees(path.join(SB, 'не-репозиторий'))));

// Файл чужой: в нём лежат exclude-строки человека, и переписывался он на месте.
// Проверяем и сохранность чужих строк, и права — `rename` подменяет файл целиком.
const EXCL = path.join(SB, 'excl');
mkdirSync(EXCL, { recursive: true });
git(EXCL, 'init', '-q', '-b', 'master');
const exclFile = path.join(EXCL, '.git', 'info', 'exclude');
mkdirSync(path.dirname(exclFile), { recursive: true });
writeFileSync(exclFile, '# строка человека\nмой-мусор/\n');
// `mode` у writeFileSync работает только на СОЗДАНИИ файла, а `git init` уже положил
// свой `info/exclude` — права ставим отдельным chmod (тот же приём, что у writeSecret).
chmodSync(exclFile, 0o600);
const exclAdded = excludeWorktrees(EXCL);
check('чужие строки exclude переживают дозапись',
  exclAdded.status === 'added'
  && readFileSync(exclFile, 'utf8').includes('мой-мусор/')
  && readFileSync(exclFile, 'utf8').includes('**/.claude/worktrees/'),
  readFileSync(exclFile, 'utf8'));
check('права чужого файла не съезжают на дефолтные после подмены',
  (statSync(exclFile).mode & 0o777) === 0o600, (statSync(exclFile).mode & 0o777).toString(8));
check('временного файла записи после себя не остаётся',
  !readdirSync(path.dirname(exclFile)).some((f) => f.startsWith('.tmp-exclude')),
  readdirSync(path.dirname(exclFile)).join(', '));

// Атомарность записи — через жёсткую ссылку на прежний файл. `rename` подменяет
// запись в каталоге: старый inode, а с ним и ссылка, остаётся с прежним содержимым.
// Запись на месте изменила бы и ссылку — то есть переписала бы файл под тем, кто его
// в этот момент читает, и смерть процесса посреди неё унесла бы чужие строки.
const EXCL2 = path.join(SB, 'excl2');
mkdirSync(EXCL2, { recursive: true });
git(EXCL2, 'init', '-q', '-b', 'master');
const excl2File = path.join(EXCL2, '.git', 'info', 'exclude');
mkdirSync(path.dirname(excl2File), { recursive: true });
writeFileSync(excl2File, '# строка человека\n');
const excl2Alias = path.join(SB, 'exclude-до-записи');
linkSync(excl2File, excl2Alias);
check('запись идёт через tmp+rename, а не поверх чужого файла',
  excludeWorktrees(EXCL2).status === 'added'
  && readFileSync(excl2Alias, 'utf8') === '# строка человека\n'
  && readFileSync(excl2File, 'utf8').includes('**/.claude/worktrees/'),
  readFileSync(excl2Alias, 'utf8'));

// --- потолок вывода git -----------------------------------------------
//
// Дефолтный мегабайт `spawnSync` подменяет ответ ровно на самом нужном каталоге:
// по-настоящему грязный worktree перебирает его, процесс убивается, и клон читается как
// «git did not answer» вместо «с незакоммиченным». Фикстура настоящая: пять тысяч файлов с
// длинными именами дают больше мегабайта `status --porcelain` (замер — 1.2 МБ, вся
// проверка около 0.4 с).
const BIG = path.join(SB, 'big');
mkdirSync(BIG, { recursive: true });
git(BIG, 'init', '-q', '-b', 'master');
writeFileSync(path.join(BIG, 'f'), 'первый\n');
git(BIG, 'add', '.');
git(BIG, 'commit', '-qm', 'первый');
const BIGWT = path.join(BIG, '.claude', 'worktrees', 'big');
git(BIG, 'worktree', 'add', '-q', '-b', 'worktree-a2a-big', BIGWT);
const longName = 'x'.repeat(240);
for (let i = 0; i < 5000; i += 1) writeFileSync(path.join(BIGWT, `${longName}-${i}`), '');
const bigStatus = git(BIGWT, 'status', '--porcelain');
check('фикстура: вывод status перебирает дефолтный мегабайт',
  bigStatus.stdout.length > 1024 * 1024, String(bigStatus.stdout.length));
const bigInfo = inspectWorktree(BIG, BIGWT, 'master');
check('очень грязный worktree читается как грязный, а не как «git did not answer»',
  bigInfo.dirty === true, JSON.stringify(bigInfo));

// --- живость сессии: «жива» против «числится» -------------------------
// Живая фоновая сессия печатает pid; запись, пережившая свой демон, — нет (снято
// живым spawn'ом и стопом на claude 2.1.241).
const LIVE = { id: 'a6110205', kind: 'background', pid: 7506, status: 'idle', state: 'done' };
const GHOST = { id: '72c77534', kind: 'background', state: 'blocked' };
check('запись с pid — жива', sessionLiveness(LIVE, [LIVE, GHOST]) === 'alive');
check('запись без pid там, где pid печатается, — числится',
  sessionLiveness(GHOST, [LIVE, GHOST]) === 'stale', sessionLiveness(GHOST, [LIVE, GHOST]));
check('записи нет вовсе — мертва', sessionLiveness(null, [LIVE]) === 'dead');
// Самокалибровка: сборка claude, которая pid не печатает, не должна превращать всех
// живых в призраков — признака нет, значит улики нет.
check('pid не печатает никто — прежнее поведение, а не поголовная смерть',
  sessionLiveness({ name: 'x', status: 'running' }, [{ name: 'x', status: 'running' }]) === 'alive');
check('список не передан — тоже прежнее поведение', sessionLiveness({ name: 'x' }) === 'alive');

// Имя сессии детерминировано, а призрак из списка не исчезает: после перезапуска
// worker'а тем же адресом под одним именем лежат две записи. Взять первую совпавшую
// значит отдать призрака — spawn отчитается его id, а status назовёт живого «числится».
const DUP = 'a2a · задача · repo · 0826-1048';
const dupList = [{ id: 'старая', name: DUP, state: 'blocked' }, { id: 'новая', name: DUP, pid: 999, state: 'working' }];
check('две записи под одним именем: выбирается живая, а не первая совпавшая',
  findSession(dupList, DUP)?.id === 'новая', JSON.stringify(findSession(dupList, DUP)));
check('живой записи среди совпавших нет — отдаём что есть, а не null',
  findSession([dupList[0], { id: 'x', pid: 7, name: 'другая' }], DUP)?.id === 'старая');

// --- подтверждение подъёма сессии -------------------------------------
const seenAfter = (n) => { let i = 0; return () => (i++ < n ? [] : [{ id: 'z', name: 'a2a · тест', pid: 5 }]); };
check('spawn: сессия появилась не сразу — дожидаемся, а не хороним',
  (await awaitSession('a2a · тест', { tries: 3, delayMs: 1, sessions: seenAfter(2) })).state === 'alive');
const ghostOnly = () => [{ id: 'призрак', name: 'a2a · тест', state: 'blocked' }, { id: 'чужой', name: 'другая', pid: 3 }];
const onlyGhost = await awaitSession('a2a · тест', { tries: 2, delayMs: 1, sessions: ghostOnly });
check('spawn: под именем лежит только призрак — это НЕ «поднят»',
  onlyGhost.state === 'dead' && onlyGhost.ghost?.id === 'призрак', JSON.stringify(onlyGhost));

check('spawn: сессии нет за все попытки — мертва',
  (await awaitSession('a2a · тест', { tries: 2, delayMs: 1, sessions: () => [] })).state === 'dead');
check('spawn: вывод claude agents не разобран — неизвестно, а не мертва',
  (await awaitSession('a2a · тест', { tries: 2, delayMs: 1, sessions: () => null })).state === 'unknown');
check('spawn: сессия найдена — awaitSession отдаёт саму запись, а не только состояние',
  (await awaitSession('a2a · тест', { tries: 1, delayMs: 1, sessions: seenAfter(0) })).session?.id === 'z');
// Двум источникам id нужен порядок, а не наличие: разбор вывода `claude --bg` угадывает
// id в свободном тексте, запись из списка сессий его знает. Перевёрнутый порядок молча
// пишет в участника угаданное — при живой записи под рукой.
const BG_OUT = 'backgrounded · cafe12 · a2a-worker';
check('spawn: id сессии берётся из списка, а не из разбора вывода',
  spawnedSessionId({ state: 'alive', session: { id: 'z' } }, BG_OUT) === 'z'
  && parseSessionId(BG_OUT) !== 'z',
  `${spawnedSessionId({ state: 'alive', session: { id: 'z' } }, BG_OUT)} vs ${parseSessionId(BG_OUT)}`);
check('spawn: списка нет — id остаётся разбором вывода, а не пропадает',
  spawnedSessionId({ state: 'unknown', session: null }, BG_OUT) === parseSessionId(BG_OUT),
  String(spawnedSessionId({ state: 'unknown', session: null }, BG_OUT)));

// Замечание ревью: реестр сессий переехал в liftoff.js, чтобы два файла не импортировали
// друг друга. Цикл в ESM сегодня безвреден, и набор с ним зелёный — увидеть его нечем,
// кроме как посмотреть на импорты. Поэтому проверка механическая: она и держит границу
// дальше, а цена цикла — первая же правка, читающая чужой модуль на верхнем уровне,
// упрётся в TDZ. Имена при этом остались доступны из spawn.js: их берёт отсюда сам этот
// файл (импорт выше), то есть реэкспорт проверен всеми проверками этого блока.
const liftoffSrc = readFileSync(path.join(here, '..', 'lib', 'liftoff.js'), 'utf8');
check('замечание ревью: liftoff.js не импортирует spawn.js — цикла между ними нет',
  !/^\s*import\s[^;]*from\s+'\.\/spawn\.js'/m.test(liftoffSrc),
  liftoffSrc.split('\n').filter((l) => /from '\.\/spawn\.js'/.test(l)).join(' | ') || 'импортов нет');

rmSync(SB, { recursive: true, force: true });
