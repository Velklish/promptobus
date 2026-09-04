// Миграция `legacy/a2a` → `.promptobus` ( §7).
//
// Вход — golden-срез `v0.61.0` ([fixtures/promptobus/legacy-v061](fixtures/promptobus/legacy-v061)),
// снятый генератором через store текущего релиза. Срез намеренно не покрывает файлы
// adapter'а: `wake/`, `waits/` и `stalls.json` заводятся по ходу работы, и в git от них не
// остаётся ничего. Дописывает их сюда сам набор — ТЕМ ЖЕ store API, каким их пишет живой
// механизм ([MANIFEST](fixtures/promptobus/MANIFEST.md)); правкой самого среза этого делать
// нельзя, он снят пересъёмкой байт в байт и правка меняет его смысл.
//
// Предмет проверки — три свойства, и каждое стоит отдельного раздела:
//
// 1. **Полный перенос.** Счётчики inbox и `read/`, владение, история, digest артефактов.
// 2. **Отказ ДО мутации.** Активные задачи, оба root'а сразу, повреждённый корень.
// 3. **Восстановимость.** Падение на каждом шаге до атомарного переключения оставляет
//    legacy-каталог нетронутым, а повтор доводит перенос до конца.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Дверь механизма — она и запускает перенос при первом обращении к store, и подаёт ему то,
// чего package знать не вправе: идентичность сессии и harness записей прежнего CLI (у них
// поля `harness` нет вовсе, а v1 требует его в каждой записи участника). Без неё миграция
// писала бы «harness не объявлен» — то самое, что она обязана закрыть значением driver
// registry (: шва подстановки у package больше нет, всё приходит аргументом).
const store = await import('../lib/store.js');
const bus = await import('../dist/index.js');
const { legacy, preflight: preflightOf, ROOT_DIR } = bus;

const LAYOUT = { rel: 'legacy/a2a', done: 'promptobus done <id>' };
const LEGACY_DONE = LAYOUT.done;
const preflight = (root) => preflightOf(root, LAYOUT);
const migrate = (root, opts = {}) => bus.migrate(root, {
  harness: store.FALLBACK_HARNESS, layout: LAYOUT, ...opts,
});

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-migration-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'promptobus', 'legacy-v061');
const ACTIVE = 't20260831-090000';
const CLOSED = 't20260830-140000';

let nth = 0;

/** Рабочее место со срезом `v0.61.0` внутри. Каждый раздел берёт своё — миграция разрушительна. */
function workspace({ close = true } = {}) {
  nth += 1;
  const root = path.join(SB, `ws-${nth}`);
  const home = path.join(root, 'legacy', 'a2a');
  mkdirSync(path.dirname(home), { recursive: true });
  cpSync(FIXTURE, home, { recursive: true });
  // Активная задача блокирует переход по построению. Закрываем её тем же store, каким
  // её закрыл бы прежний CLI, — так же, как это придётся сделать человеку.
  if (close) legacy.closeTask(home, ACTIVE);
  return { root, home, target: path.join(root, ROOT_DIR) };
}

/** Отпечаток дерева: относительные пути и содержимое. Им сверяется «legacy не тронут». */
function treeDigest(dir) {
  const hash = createHash('sha256');
  const walk = (at, rel) => {
    for (const e of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(at, e.name);
      const key = path.join(rel, e.name);
      if (e.isDirectory()) {
        hash.update(`d ${key}\n`);
        walk(next, key);
      } else {
        hash.update(`f ${key} `);
        hash.update(readFileSync(next));
        hash.update('\n');
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

function names(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function thrown(fn) {
  try {
    fn();
    return { threw: false, name: '', msg: '' };
  } catch (e) {
    return { threw: true, name: e?.constructor?.name, msg: e.message };
  }
}

// --- отказы до мутации ---------------------------------------------------------

test('preflight: активные задачи — отказ без единого изменения и с командой старой версии', async (t) => {
  const { root, home, target } = workspace({ close: false });
  const before = treeDigest(home);
  const plan = preflight(root);

  await t.test('отказ назван, и в нём перечислены активные задачи', () => {
    assert.equal(plan.needed, true);
    assert.ok(plan.refusal, 'отказа нет');
    assert.deepEqual(plan.active, [ACTIVE]);
    assert.match(plan.refusal, new RegExp(ACTIVE));
  });

  await t.test('в отказе — точная команда закрытия прежним CLI', () => {
    assert.ok(plan.refusal.includes(LEGACY_DONE.replace('<id>', ACTIVE)),
      plan.refusal);
  });

  await t.test('сама миграция отказывает тем же текстом и классом гейта', () => {
    const said = thrown(() => migrate(root));
    assert.equal(said.name, 'GateError');
    assert.match(said.msg, new RegExp(ACTIVE));
  });

  await t.test('legacy store не тронут, нового каталога не появилось', () => {
    assert.equal(treeDigest(home), before);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(path.join(root, `${ROOT_DIR}.migrating`)), false);
  });
});

test('preflight: оба root\'а сразу — отказ без merge', async (t) => {
  const { root, home, target } = workspace();
  mkdirSync(path.join(target, 'tasks'), { recursive: true });
  const before = treeDigest(home);
  const plan = preflight(root);

  await t.test('отказ называет оба каталога и не берётся их сливать', () => {
    assert.ok(plan.refusal, 'отказа нет');
    assert.ok(plan.refusal.includes(target) && plan.refusal.includes(home), plan.refusal);
    assert.match(plan.refusal, /The mechanism will not merge them/);
  });

  await t.test('legacy store не тронут', () => {
    assert.equal(treeDigest(home), before);
  });
});

test('preflight: повреждённый корень — отказ без мутации', async (t) => {
  const root = path.join(SB, 'ws-broken-root');
  mkdirSync(path.join(root, 'legacy'), { recursive: true });
  writeFileSync(path.join(root, 'legacy', 'a2a'), 'это файл, а не каталог\n');

  await t.test('корень-файл: отказ, а не попытка чтения', () => {
    const plan = preflight(root);
    assert.ok(plan.refusal, 'отказа нет');
    assert.equal(plan.needed, false);
    assert.match(plan.refusal, /is not a directory/);
  });

  await t.test('tasks/ файлом вместо каталога — тот же отказ', () => {
    const other = path.join(SB, 'ws-broken-tasks');
    mkdirSync(path.join(other, 'legacy', 'a2a'), { recursive: true });
    writeFileSync(path.join(other, 'legacy', 'a2a', 'tasks'), 'подмена\n');
    const plan = preflight(other);
    assert.ok(plan.refusal, 'отказа нет');
    assert.match(plan.refusal, /is not a directory/);
    assert.equal(existsSync(path.join(other, ROOT_DIR)), false);
  });
});

// --- полный перенос ------------------------------------------------------------

test('golden: срез v0.61.0 переносится целиком', async (t) => {
  const { root, home, target } = workspace();
  // Файлы adapter'а, которых в срезе нет вовсе, дописываем тем же store API: contact
  // point'ы, отметку конца хода и отметку доложенного стопа.
  legacy.writeWake(home, ACTIVE, 'worker:demo', { socket: '/tmp/promptobus-demo/worker-demo.sock', pid: 424243 });
  legacy.markTurn(home, ACTIVE, 'worker:demo', '2026-08-31T10:05:00.000Z');
  legacy.writeStalls(home, ACTIVE, { 'worker:demo': { reason: 'permission', at: '2026-08-31T10:06:00.000Z', tries: 1 } });
  const artifactSha = createHash('sha256')
    .update(readFileSync(path.join(home, 'tasks', ACTIVE, 'artifacts', 'demo-diff.patch'))).digest('hex');

  const report = migrate(root);

  await t.test('обе задачи перенесены, повреждённых нет', () => {
    assert.deepEqual(report.tasks.map((x) => x.id).sort(), [CLOSED, ACTIVE]);
    assert.deepEqual(report.brokenTasks, []);
  });

  await t.test('legacy-каталог снят только после переключения', () => {
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(path.join(target, 'tasks', ACTIVE, 'task.json')), true);
  });

  await t.test('участники: legacy ID сохранены, роль лежит полем, harness проставлен', () => {
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'task.json'));
    assert.deepEqual(meta.participants.map((p) => p.id).sort(), ['orchestrator', 'reviewer-demo', 'worker-demo']);
    assert.deepEqual(meta.participants.map((p) => p.role).sort(), ['orchestrator', 'reviewer', 'worker']);
    assert.ok(meta.participants.every((p) => p.harness === 'claude'), 'harness не у всех');
    // Адрес не разбирается из id обратно — он лежит в metadata записи.
    assert.deepEqual(meta.participants.map((p) => p.metadata.address).sort(),
      ['orchestrator', 'reviewer:demo', 'worker:demo']);
  });

  await t.test('владение задачей: owner — участник, сессия-владелец осталась полем записи', () => {
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'task.json'));
    assert.equal(meta.owner, 'orchestrator');
    assert.equal(meta.participants.find((p) => p.id === 'orchestrator').metadata.owner,
      '00000000-0000-4000-8000-000000000001');
  });

  await t.test('поля adapter\'а из журнала уцелели', () => {
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'task.json'));
    assert.equal(meta.title, 'демо: активная задача');
    assert.equal(meta.adapter.slug, 'demo');
    assert.equal(meta.adapter.stamp, ACTIVE);
    assert.equal(meta.status, 'done', 'закрытая задача обязана остаться закрытой');
  });

  await t.test('счётчики inbox: непрочитанное осталось непрочитанным', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.unread, 3, `непрочитанных ${one.unread}`);
    assert.equal(names(path.join(target, 'tasks', ACTIVE, 'inbox', 'orchestrator')).length, 1);
    assert.equal(names(path.join(target, 'tasks', ACTIVE, 'inbox', 'worker-demo')).length, 2);
  });

  await t.test('счётчики history: прочитанное осталось прочитанным', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.read, 4, `прочитанных ${one.read}`);
    assert.equal(names(path.join(target, 'tasks', ACTIVE, 'history', 'orchestrator')).length, 3);
    assert.equal(names(path.join(target, 'tasks', ACTIVE, 'history', 'reviewer-demo')).length, 1);
  });

  await t.test('канон один на сообщение, а ссылка — тот же inode', () => {
    const canon = names(path.join(target, 'tasks', ACTIVE, 'messages'));
    assert.equal(canon.length, 7, `канонических ${canon.length}`);
    const ref = names(path.join(target, 'tasks', ACTIVE, 'inbox', 'orchestrator'))[0];
    const a = statSync(path.join(target, 'tasks', ACTIVE, 'messages', ref));
    const b = statSync(path.join(target, 'tasks', ACTIVE, 'inbox', 'orchestrator', ref));
    assert.equal(a.ino, b.ino, 'ссылка в inbox не тот же inode');
  });

  await t.test('порядок сообщений сохранён: сортировка имён — порядок отправки', () => {
    const canon = names(path.join(target, 'tasks', ACTIVE, 'messages'));
    const stamps = canon.map((n) => readJson(path.join(target, 'tasks', ACTIVE, 'messages', n)).ts);
    assert.deepEqual(stamps, [...stamps].sort(), stamps.join(' '));
  });

  await t.test('битая запись уехала в broken, остальные сообщения дошли', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.broken.length, 1, one.broken.join('; '));
    assert.deepEqual(names(path.join(target, 'tasks', ACTIVE, 'broken', 'inbox', 'worker-demo')),
      ['20260831T095500000-0009-orchestrator.json']);
  });

  await t.test('артефакт: blob по SHA-256, metadata, имя файла человеку', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.artifacts, 1);
    assert.deepEqual(names(path.join(target, 'tasks', ACTIVE, 'blobs')), [artifactSha]);
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'artifacts',
      names(path.join(target, 'tasks', ACTIVE, 'artifacts'))[0]));
    assert.equal(meta.sha256, artifactSha);
    assert.equal(meta.filename, 'demo-diff.patch');
    assert.deepEqual(names(path.join(target, 'tasks', ACTIVE, 'files')), ['demo-diff.patch']);
  });

  await t.test('ссылка на артефакт в сообщении переписана на id записи', () => {
    const dir = path.join(target, 'tasks', ACTIVE, 'history', 'orchestrator');
    const withArt = names(dir).map((n) => readJson(path.join(dir, n))).find((m) => m.artifact);
    const meta = readJson(path.join(target, 'tasks', ACTIVE, 'artifacts',
      names(path.join(target, 'tasks', ACTIVE, 'artifacts'))[0]));
    assert.equal(withArt.artifact, meta.id);
  });

  await t.test('файлы adapter\'а перенесены как есть', () => {
    const at = path.join(target, 'tasks', ACTIVE);
    assert.equal(existsSync(path.join(at, 'health.json')), true);
    assert.equal(existsSync(path.join(at, 'supervisor.json')), true);
    assert.equal(existsSync(path.join(at, 'supervisor.log')), true);
    assert.equal(readJson(path.join(at, 'stalls.json'))['worker:demo'].reason, 'permission');
    assert.equal(readJson(path.join(at, 'waits', 'worker-demo.turn.json')).at, '2026-08-31T10:05:00.000Z');
  });

  await t.test('contact point\'ы не переносятся: их пересдают живые сессии', () => {
    assert.equal(existsSync(path.join(target, 'tasks', ACTIVE, 'wake')), false);
  });

  await t.test('привязки сессий перенесены', () => {
    assert.equal(report.bindings, 1);
    assert.deepEqual(names(path.join(target, 'sessions')),
      ['00000000-0000-4000-8000-000000000001.json']);
  });

  await t.test('закрытая задача: обе стороны переписки на месте', () => {
    const one = report.tasks.find((x) => x.id === CLOSED);
    assert.equal(one.read, 2);
    assert.equal(one.unread, 0);
    assert.equal(names(path.join(target, 'tasks', CLOSED, 'history', 'orchestrator')).length, 1);
    assert.equal(names(path.join(target, 'tasks', CLOSED, 'history', 'worker-stale')).length, 1);
  });
});

test('golden: перенесённое читается механизмом', async (t) => {
  const { root, home, target } = workspace();
  migrate(root);

  await t.test('счётчик непрочитанного тот же, что был в legacy', () => {
    assert.equal(store.countInbox(target, ACTIVE, 'worker:demo'), 2);
    assert.equal(store.countInbox(target, ACTIVE, 'orchestrator'), 1);
  });

  await t.test('участники читаются адресами, а не id участников v1', () => {
    const meta = store.readTask(target, ACTIVE);
    assert.deepEqual(store.addressesOf(meta).sort(),
      ['orchestrator', 'reviewer:demo', 'worker:demo']);
    assert.equal(store.participantOf(meta, 'worker:demo').metadata.repo, 'demo-group/demo-api');
  });

  await t.test('владение mailbox\'ом сохранилось', () => {
    assert.equal(store.taskOwner(target, ACTIVE), '00000000-0000-4000-8000-000000000001');
  });

  await t.test('mailbox отдаёт перенесённое, а отправитель и получатель — id участников', () => {
    const { messages } = store.readInbox(target, ACTIVE, 'worker:demo');
    assert.equal(messages.length, 2);
    assert.ok(messages.every((m) => m.sender === 'orchestrator' && m.recipients.join(',') === 'worker-demo'),
      JSON.stringify(messages.map((m) => [m.sender, m.recipients])));
  });

  await t.test('история отдаёт ровно прочитанное, и порядок в ней тот же', () => {
    // История v1 строится ТОЛЬКО по `history/`: недоставленное в неё не попадает, и на
    // этом различии стоит восстановление fan-out'а.
    const page = store.history(target, { task: ACTIVE, participant: 'orchestrator', all: true });
    assert.equal(page.entries.length, 3, `записей ${page.entries.length}`);
    const stamps = page.entries.map((e) => e.message.ts);
    assert.deepEqual(stamps, [...stamps].sort(), stamps.join(' '));
    assert.deepEqual(page.broken, []);
  });

  await t.test('артефакт находится по имени в папке задачи', () => {
    assert.equal(existsSync(path.join(store.filesDir(target, ACTIVE), 'demo-diff.patch')), true);
  });

  await t.test('legacy-каталог снесён', () => {
    assert.equal(existsSync(home), false);
  });
});

test('одноимённые legacy-записи в разных mailbox\'ах не съедают друг друга', async (t) => {
  // Имена прежнего store уникальны в пределах ОДНОГО mailbox'а, а не задачи: два
  // отправителя под одним адресом из двух процессов собирали одно имя, и разводил их `link`
  // внутри своего каталога. Посев id одним именем файла дал бы им один id на всю
  // задачу — и тело второго исчезло бы молча, а миграция необратима.
  const { root, home, target } = workspace();
  const NAME = '20260831T091500000-0042-orchestrator.json';
  const twin = (to, body) => ({
    id: NAME.slice(0, -'.json'.length), task: ACTIVE, from: 'orchestrator', to,
    type: 'task', ts: '2026-08-31T09:15:00.000Z', body,
  });
  for (const [box, to, body] of [['worker-demo', 'worker:demo', 'близнец worker\'у'],
    ['reviewer-demo', 'reviewer:demo', 'близнец reviewer\'у']]) {
    const dir = path.join(home, 'tasks', ACTIVE, 'inbox', box);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, NAME), `${JSON.stringify(twin(to, body), null, 2)}\n`);
  }

  const report = migrate(root);

  await t.test('оба близнеца доехали: два разных канона, оба с телом', () => {
    const dir = path.join(target, 'tasks', ACTIVE, 'messages');
    const bodies = names(dir).map((n) => readJson(path.join(dir, n)))
      .filter((m) => m.body.startsWith('близнец')).map((m) => m.body).sort();
    assert.deepEqual(bodies, ['близнец reviewer\'у', 'близнец worker\'у'], bodies.join(' | '));
  });

  await t.test('id у них разные, и лежат они каждый в своём mailbox\'е', () => {
    const at = (box) => names(path.join(target, 'tasks', ACTIVE, 'inbox', box));
    const mine = at('worker-demo').filter((n) => n.startsWith('20260831T091500000-0042'));
    const theirs = at('reviewer-demo').filter((n) => n.startsWith('20260831T091500000-0042'));
    assert.equal(mine.length, 1, at('worker-demo').join(','));
    assert.equal(theirs.length, 1, at('reviewer-demo').join(','));
    assert.notEqual(mine[0], theirs[0], `id совпали: ${mine[0]}`);
  });

  await t.test('счётчик задачи их посчитал обоих', () => {
    const one = report.tasks.find((x) => x.id === ACTIVE);
    assert.equal(one.unread, 5, `непрочитанных ${one.unread}`);
  });
});

// --- параллельный запуск ---------------------------------------------------------

// Двумя настоящими процессами, а не промисами в одном: предмет — лок-каталог и `rename`,
// а внутри одного процесса они с собой не встречаются. Барьер обязателен — без него дети
// выстраиваются по времени запуска, и окно не наступает вовсе.
//
// Ждут они СНОМ, а не спином: ловимое окно меряется секундой с лишним (сам переезд — 1,45 с
// на 36 МБ), точность спина здесь не нужна, а полсекунды сожжённого CPU в каждом процессе
// набор платит из своего бюджета.
function racers(n, body) {
  const at = Date.now() + 700;
  // `a` — adapter CLI (он же ставит шов package'у), `m` — сам package.
  const code = (i) => `const path = await import('node:path');\n`
    + `const a = await import(${JSON.stringify(path.join(process.cwd(), 'lib', 'store.js'))});\n`
    + `const m = await import(${JSON.stringify(path.join(process.cwd(), 'dist', 'index.js'))});\n`
    + `const layout = ${JSON.stringify(LAYOUT)};\n`
    + `const i = ${i};\n`
    + `await new Promise((r) => setTimeout(r, Math.max(0, ${at} - Date.now())));\n${body}`;
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const ch = spawn(process.execPath, ['--input-type=module', '-e', code(i)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('exit', (codeOut) => resolve({ code: codeOut, out: out.trim(), err: err.trim() }));
  })));
}

test('доклад о переезде печатает тот, кто переехал, — и только он', async (t) => {
  // Печатает его adapter, а не package: он же и молчит, когда переносить было нечего.
  // Без этой ветки проигравший рапортовал бы «0 tasks, 0 messages, former directory»
  // на рабочем месте, где сосед перенёс всё, — врала бы ровно та строка, которая обещана
  // пользователю как доклад числами.
  const { root, home } = workspace();
  const before = names(path.join(home, 'tasks')).length;
  const runs = await racers(2, `a.promptobusHome(${JSON.stringify(root)}, { legacyLayout: () => layout });`);

  await t.test('оба процесса ушли успехом', () => {
    assert.deepEqual(runs.map((r) => r.code), [0, 0], JSON.stringify(runs));
  });

  await t.test('строка "the bus moved" ровно одна — у того, кто переехал', () => {
    const said = runs.filter((r) => r.err.includes('the bus moved'));
    assert.equal(said.length, 1, runs.map((r) => `«${r.err}»`).join(' | '));
    assert.match(said[0].err, new RegExp(`${before} tasks`), said[0].err);
  });

  await t.test('второй молчит вовсе — пустого доклада не бывает', () => {
    const quiet = runs.filter((r) => !r.err.includes('the bus moved'));
    assert.equal(quiet.length, 1);
    assert.equal(quiet[0].err, '', `«${quiet[0].err}»`);
  });
});

test('два процесса переезжают одновременно — переносит один, оба уходят с полным store', async (t) => {
  const { root, home, target } = workspace();
  // Тела берём ДО переезда: сверять надо их, а не счётчики. Счётчик считает ссылки, и обе
  // ссылки на месте даже тогда, когда указывают на один inode — потерю он не видит.
  const bodies = [];
  for (const box of ['inbox', 'read']) {
    for (const dir of names(path.join(home, 'tasks', ACTIVE, box))) {
      for (const n of names(path.join(home, 'tasks', ACTIVE, box, dir))) {
        try {
          bodies.push(readJson(path.join(home, 'tasks', ACTIVE, box, dir, n)).body);
        } catch {
          // Битая запись тела не имеет — она уедет в broken, и сверять по ней нечего.
        }
      }
    }
  }

  const runs = await racers(2, `const r = m.migrate(${JSON.stringify(root)}, { harness: a.FALLBACK_HARNESS, layout });\n`
    + `process.stdout.write(JSON.stringify({ tasks: r.tasks.length, moved: r.moved, resumed: r.resumed }));`);

  await t.test('оба процесса ушли успехом — проигравший не отказывает', () => {
    assert.deepEqual(runs.map((r) => r.code), [0, 0], JSON.stringify(runs));
  });

  await t.test('перенёс ровно один, второй увидел уже переехавший корень', () => {
    const moved = runs.filter((r) => JSON.parse(r.out).tasks > 0);
    assert.equal(moved.length, 1, runs.map((r) => r.out).join(' | '));
  });

  await t.test('проигравший говорит «ничего не делал», а не пустой перенос', () => {
    // Без этого поля пустой отчёт неотличим от удавшегося переноса, и доклад числами
    // сказал бы «0 tasks, 0 messages, former directory» на месте, где сосед перенёс всё.
    const said = runs.map((r) => JSON.parse(r.out));
    assert.deepEqual(said.map((r) => r.moved).sort(), [false, true], JSON.stringify(said));
    assert.equal(said.find((r) => !r.moved).tasks, 0);
  });

  await t.test('в новом корне ПОЛНЫЙ store — сверка тел, а не счётчиков', () => {
    const after = [];
    const dir = path.join(target, 'tasks', ACTIVE, 'messages');
    for (const n of names(dir)) after.push(readJson(path.join(dir, n)).body);
    assert.deepEqual(after.sort(), bodies.sort(), `${after.length} тел из ${bodies.length}`);
  });

  await t.test('прежний корень снят, временного каталога и лока не осталось', () => {
    assert.equal(existsSync(home), false, 'прежний корень на месте');
    assert.equal(existsSync(path.join(root, `${ROOT_DIR}.migrating`)), false, 'остался временный каталог');
    assert.equal(existsSync(path.join(root, `${ROOT_DIR}.migrating.lock`)), false, 'остался лок');
  });
});

// --- восстановимость -----------------------------------------------------------

const BEFORE_SWITCH = ['scan', 'temp', 'artifacts', 'messages', 'task', 'sidecar', 'sessions', 'mark'];

test('fault injection: падение до атомарного переключения не трогает legacy', async (t) => {
  for (const step of BEFORE_SWITCH) {
    await t.test(`падение на «${step}»: legacy цел, нового каталога нет, повтор доводит`, () => {
      const { root, home, target } = workspace();
      const before = treeDigest(home);
      // Цель спрашивается ИЗНУТРИ падения, а не после него: снаружи её отсутствие
      // обеспечила бы и уборка в catch, а предмет проверки другой — пока сборка идёт,
      // на месте цели нет ничего. Настоящая смерть процесса уборки не делает вовсе.
      const seen = [];
      const said = thrown(() => migrate(root, {
        fault: (at) => {
          seen.push([at, existsSync(target)]);
          if (at === step) throw new Error(`подставное падение на ${at}`);
        },
      }));
      assert.equal(said.threw, true, 'падения не случилось');
      assert.match(said.msg, /подставное падение/);
      assert.deepEqual(seen.filter(([, there]) => there), [],
        `цель существовала во время сборки: ${JSON.stringify(seen)}`);
      assert.equal(treeDigest(home), before, 'legacy store изменился');
      assert.equal(existsSync(target), false, 'цель появилась до переключения');
      assert.equal(existsSync(path.join(root, `${ROOT_DIR}.migrating`)), false, 'остался временный каталог');

      // Повтор после прерывания идемпотентен: перенос доходит до конца.
      const report = migrate(root);
      assert.equal(report.tasks.length, 2);
      assert.equal(existsSync(home), false);
      assert.equal(existsSync(path.join(target, 'tasks', ACTIVE, 'task.json')), true);
    });
  }
});

test('fault injection: падение ПОСЛЕ переключения доводится повтором, а не отказом', async (t) => {
  const { root, home, target } = workspace();
  const said = thrown(() => migrate(root, {
    fault: (at) => {
      if (at === 'switch') throw new Error('подставное падение после rename');
    },
  }));

  await t.test('оба каталога на месте — окно между переключением и уборкой', () => {
    assert.equal(said.threw, true);
    assert.equal(existsSync(home), true);
    assert.equal(existsSync(target), true);
  });

  await t.test('повторный запуск не отказывает «оба root\'а», а доделывает уборку', () => {
    const plan = preflight(root);
    assert.equal(plan.refusal, null, plan.refusal ?? '');
    const report = migrate(root);
    assert.equal(report.resumed, true);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(path.join(target, 'tasks', ACTIVE, 'task.json')), true);
  });
});

test('повторный запуск на перенесённом рабочем месте не делает ничего', async (t) => {
  const { root, target } = workspace();
  migrate(root);
  const after = treeDigest(target);

  await t.test('preflight больше не просит миграции', () => {
    const plan = preflight(root);
    assert.equal(plan.needed, false);
    assert.equal(plan.refusal, null);
  });

  await t.test('повторная миграция ничего не делает и говорит об этом', () => {
    const report = migrate(root);
    assert.deepEqual(report.tasks, []);
    assert.equal(report.moved, false, 'пустой отчёт выдан за перенос');
    assert.equal(treeDigest(target), after);
  });
});

test('повреждённая задача уезжает в migration-broken и не активируется', async (t) => {
  const { root, home, target } = workspace();
  writeFileSync(path.join(home, 'tasks', CLOSED, 'task.json'), '{"id": "обрез');
  const report = migrate(root);

  await t.test('битая задача названа отдельно и в tasks/ не попала', () => {
    assert.deepEqual(report.brokenTasks, [CLOSED]);
    assert.deepEqual(report.tasks.map((x) => x.id), [ACTIVE]);
    assert.equal(existsSync(path.join(target, 'tasks', CLOSED)), false);
  });

  await t.test('её каталог сохранён целиком, с причиной рядом', () => {
    assert.equal(existsSync(path.join(target, 'migration-broken', CLOSED, 'task.json')), true);
    assert.match(readFileSync(path.join(target, 'migration-broken', `${CLOSED}.txt`), 'utf8'),
      /journal did not parse/);
  });

  await t.test('здоровая задача при этом читается', () => {
    assert.equal(store.readTask(target, ACTIVE).id, ACTIVE);
  });
});
