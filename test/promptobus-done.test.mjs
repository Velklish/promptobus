// `promptobus done` гасит managed-сессии сам. До этой задачи их закрывал человек
// руками, и цена отсрочки была двойная: на машине копились живые сессии, а уборка worktree
// за живой сессией не идёт вовсе — каталог уехал бы из-под её `cwd`.
//
// Driver здесь ПОДСТАВНОЙ и передаётся швом `registry`: предмет проверки — кого обход
// гасит и кого нет, а не поведение `claude stop`. Живого бинаря набор не трогает.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';

const SB = makeSandbox('promptobus-promptobus-done-');
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(SB, '.promptobus');

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { stopManaged } = await import(path.join(here, '..', 'lib', 'done.js'));
const bus = await import(path.join(here, '..', 'dist', 'index.js'));

// Подмены бинаря здесь нет вовсе, и это предмет проверки (замечание ревью): снимок сессий
// обход собирает ТЕМ ЖЕ registry, которым гасит, поэтому живость участника объявляет
// подставной driver, а не то, что запущено на машине. Половинчатый шов подпирал бы её
// подменённым `claude`, и `inspect` подставного driver'а оставался бы мёртвой фикстурой.
const LIVE = ['sess-worker', 'sess-reviewer', 'sess-attached'];

// Подставной driver: считает, кого просили погасить. `reply` задаёт исход по ref;
// `sessions` — слово harness'а о его реестре, которое уборка вставляет в свои маршруты
//: по нему видно, что строку собрал driver, а не сама уборка.
function fakeRegistry(reply = () => ({ ok: true, stopped: true, note: 'закрыта' }), sessions = 'claude agents') {
  const calls = [];
  const driver = {
    id: 'claude',
    capabilities: {
      spawn: true, attach: false, activation: 'push', inspect: true, stop: true,
      denyTools: true, systemPrompt: true, sessionList: true, enter: true,
    },
    phrases: { sessions, unreadable: 'реестр не разобран', enter: (id) => `войти ${id}`, stop: (id) => `погасить ${id}`, logs: (id) => `журнал ${id}` },
    inspect: (ref) => (LIVE.includes(ref)
      ? { state: 'alive', busy: false, stall: null, id: ref, note: 'idle' }
      : { state: 'gone', busy: false, stall: null, id: null, note: null }),
    stop: (ref) => {
      calls.push(ref);
      return reply(ref);
    },
  };
  return { registry: bus.createRegistry({ drivers: { claude: driver }, fallback: 'claude' }), calls };
}

const TASK = 'done-t20260901-230000';
store.createTask(HOME, { id: TASK, title: 'уборка гасит сессии', owner: null });
// Worker прежнего CLI: поля `mode` у него нет вовсе, и это managed — его сессию поднимал spawn.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:api', { name: 'sess-worker' }));
// Reviewer нынешнего: поля проставлены подъёмом.
store.upsertParticipant(HOME, TASK, store.participantRecord('reviewer:api', { harness: 'claude', mode: 'managed', sessionRef: 'sess-reviewer' }));
// Подключившийся сам: driver его не поднимал и распоряжаться им не вправе.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:svoy', { harness: 'claude', mode: 'attached', sessionRef: 'sess-attached' }));

const { registry, calls } = fakeRegistry();
const out = await capture(async () => stopManaged(HOME, TASK, { registry }));

check(': гасятся managed-участники с живой сессией, и оба рода записи',
  calls.length === 2 && calls.includes('sess-worker') && calls.includes('sess-reviewer'),
  calls.join(', '));
check(': запись прежнего CLI без поля mode считается managed — её сессию поднимал spawn',
  calls.includes('sess-worker'), calls.join(', '));
check(': attached не гасится — driver эту сессию не поднимал',
  !calls.includes('sess-attached'), calls.join(', '));
check(': owner задачи не гасится — сессии за ним нет вовсе',
  !calls.some((c) => c === null || c === 'orchestrator'), calls.join(', '));
check(': закрытые названы вслух — по строке видно, чего не осталось на машине',
  /worker:api/.test(out) && /reviewer:api/.test(out), out.trim());

// Отказ одного участника обход не прерывает: уборка идёт ПОСЛЕ закрытия задачи, и брошенный
// отсюда отказ унёс бы с собой остальных — та же беда, что в .
const failing = fakeRegistry((ref) => (ref === 'sess-worker'
  ? { ok: false, stopped: false, note: 'claude stop w1 завершился с кодом 1' }
  : { ok: true, stopped: true, note: 'закрыта' }));
const outTwo = await capture(async () => stopManaged(HOME, TASK, { registry: failing.registry }));
check(': отказ одного не прерывает обход — второго всё равно погасили',
  failing.calls.length === 2 && failing.calls.includes('sess-reviewer'), failing.calls.join(', '));
check(': отказ назван вслух и с маршрутом — иначе worktree останется молча',
  /could not close/.test(outTwo) && /claude agents/.test(outTwo), outTwo.trim());
// : слово про реестр сессий в маршруте приходит от driver'а, а не живёт в уборке.
// Проверяется подменой самого слова: разъехавшись, строка советовала бы человеку команду
// harness'а, которого в этой задаче нет.
const named = fakeRegistry((ref) => (ref === 'sess-worker'
  ? { ok: false, stopped: false, note: 'подставной стоп отказал' }
  : { ok: true, stopped: true, note: 'закрыта' }), 'реестр подставного harness\'а');
const outNamed = await capture(async () => stopManaged(HOME, TASK, { registry: named.registry }));
check(': маршрут отказа называет реестр сессий словами driver\'а, а не своими',
  /реестр подставного harness'а/.test(outNamed) && !/claude agents/.test(outNamed), outNamed.trim());

// : третий исход гашения — команду отдали, подтвердить нечем. Печатать его словами
// "no need to stop" значило бы отрицать первую половину строки второй: гасить как раз
// пришлось. Отличает его от «сессии не было ещё до команды» признак `attempted` исхода, и
// без него два разных состояния machine видела бы одним.
const unsure = fakeRegistry(() => ({
  ok: true, stopped: false, attempted: true, note: 'подставной стоп не подтвердил исчезновение записи',
}));
const unsureOut = await capture(async () => stopManaged(HOME, TASK, { registry: unsure.registry }));
check(': гашение без подтверждения — свой исход, а не "no need to stop"',
  /stop of the session of participant worker:api was not confirmed/.test(unsureOut)
  && !/no need to stop/.test(unsureOut), unsureOut.trim());
check(': строка называет цену — worktree will stay in place',
  /worktree will stay in place/.test(unsureOut), unsureOut.trim());
const unsureCount = await stopManaged(HOME, TASK, { registry: fakeRegistry(() => ({
  ok: true, stopped: false, attempted: true, note: 'подставной стоп не подтвердил исчезновение записи',
})).registry });
check(': неподтверждённое не считается ни погашенным, ни "nothing to stop", ни отказом',
  unsureCount.unconfirmed === 2 && unsureCount.stopped === 0 && unsureCount.idle === 0
  && unsureCount.failed === 0, JSON.stringify(unsureCount));

// nothing to stop: сессий этих участников в списке нет. Предикат живости тот же, что у всей
// уборки, поэтому мёртвая сессия до driver'а не доходит вовсе.
const DEAD = 'done-dead-t20260901-230100';
store.createTask(HOME, { id: DEAD, title: 'мёртвые сессии', owner: null });
store.upsertParticipant(HOME, DEAD, store.participantRecord('worker:mertvyy', { harness: 'claude', mode: 'managed', sessionRef: 'sess-net-takoy' }));
const dead = fakeRegistry();
const deadOut = await capture(async () => stopManaged(HOME, DEAD, { registry: dead.registry }));
check(': мёртвая сессия до driver’а не доходит — nothing to stop',
  dead.calls.length === 0 && !/closed/.test(deadOut), `${dead.calls.join(', ')} · ${deadOut.trim()}`);

// Контракт: attached отказывает по режиму, а не по capability — capability у driver'а есть.
// Отказ ловится `await`'ом: исход гашения — обещание, и синхронный `try` мимо
// него прошёл бы с пустой строкой, то есть проверка стала бы холостой.
const refusal = await (async () => {
  try {
    await bus.stopParticipant({ address: 'worker:svoy', harness: 'claude', mode: 'attached', sessionRef: 'sess-attached' },
      fakeRegistry().registry);
    return '';
  } catch (e) {
    return e.message;
  }
})();
check(': отказ по attached называет режим, а не отсутствие capability',
  /mode «attached»/.test(refusal) && /did not launch/.test(refusal), refusal);

// Негодная запись участника обход не роняет — тем же приёмом, что и вся уборка.
const BAD = 'done-bad-t20260901-230200';
store.createTask(HOME, { id: BAD, title: 'негодная запись', owner: null });
// Запись годна по схеме store и негодна по адресу: адрес — поле adapter'а, и схема его не
// смотрит вовсе. Кладётся она мимо двери: `participantRecord` такой адрес не принимает.
const badMeta = store.readTask(HOME, BAD);
badMeta.participants.push({
  id: 'worker-plohoy',
  role: 'worker',
  harness: 'claude',
  mode: 'attached',
  sessionRef: null,
  capabilities: null,
  metadata: { address: 'worker:Плохой Адрес', name: 'sess-worker' },
});
writeFileSync(store.taskFile(HOME, BAD), JSON.stringify(badMeta, null, 2) + '\n');
store.upsertParticipant(HOME, BAD, store.participantRecord('worker:posle', { harness: 'claude', mode: 'managed', sessionRef: 'sess-reviewer' }));
const bad = fakeRegistry();
await capture(async () => stopManaged(HOME, BAD, { registry: bad.registry }));
check(': негодная запись обход не роняет — соседа погасили',
  bad.calls.includes('sess-reviewer'), bad.calls.join(', '));

// Задачи нет вовсе — молчим: уборка идёт после закрытия, и отказ отсюда унёс бы её целиком.
check(': задачи нет — обход молчит, а не падает',
  JSON.stringify(await stopManaged(HOME, 'net-takoy-zadachi', { registry: fakeRegistry().registry }))
  === JSON.stringify({ stopped: 0, idle: 0, failed: 0, unconfirmed: 0 }));

// Успех без гашения — свой исход, а не "closed" (замечание ревью): сессия исчезла между
// снимком и вызовом, и печатать это как сделанную работу значило бы утверждать недоказанное.
const idle = fakeRegistry(() => ({ ok: true, stopped: false, note: 'сессии «sess-worker» в списке нет' }));
const idleOut = await capture(async () => stopManaged(HOME, TASK, { registry: idle.registry }));
check(': no need to stop — исход свой, и он не "closed"',
  /no need to stop/.test(idleOut) && !/session of participant worker:api closed/.test(idleOut), idleOut.trim());
let counted;
await capture(async () => { counted = await stopManaged(HOME, TASK, { registry: idle.registry }); });
check(': и считается он отдельно от погашенных',
  JSON.stringify(counted) === JSON.stringify({ stopped: 0, idle: 2, failed: 0, unconfirmed: 0 }),
  JSON.stringify(counted));

// Перечень адресов печатается ДО первого гашения: команда необратима, и человек обязан
// видеть, что сейчас будет закрыто, а не узнавать об этом задним числом.
const ahead = fakeRegistry();
const aheadOut = await capture(async () => stopManaged(HOME, TASK, { registry: ahead.registry }));
check(': перечень гасимых назван до гашения',
  /stopping participant sessions \(2\)/.test(aheadOut)
  && aheadOut.indexOf('stopping participant sessions') < aheadOut.indexOf('closed'), aheadOut.trim());

// Незнакомый режим — не managed: «раз не attached, значит managed» погасил бы сессию,
// которую driver не поднимал. Опечатка в регистре здесь ровно такой случай.
//
// **С  до обхода такая запись не доходит вовсе**: режим — поле протокола v1, и схема
// знает у него ровно два значения. Дверь механизма мусор нормализует, а запись мимо двери
// отвергает store — до журнала задачи. Защита самого предиката (`modeOf`, `stopParticipant`)
// осталась там, где предикат живёт: `driver.test.mjs`, проверка «незнакомый режим за managed
// не считается — ни опечатка в регистре, ни мусор»; здесь проверяется, что мусор до него
// не добирается.
const STRANGE = 'done-strange-t20260901-230300';
store.createTask(HOME, { id: STRANGE, title: 'незнакомый режим', owner: null });
const junkMode = (mode) => {
  try {
    store.upsertParticipant(HOME, STRANGE, {
      ...store.participantRecord('worker:musor', { harness: 'claude', sessionRef: 'sess-reviewer' }),
      mode,
    });
    return '';
  } catch (e) {
    return e.message;
  }
};
check(': незнакомый режим store не принимает — ни опечатка в регистре, ни мусор',
  /expected managed or attached/.test(junkMode('Attached')) && /expected managed or attached/.test(junkMode('что-то своё')),
  `${junkMode('Attached')} · ${junkMode('что-то своё')}`);
store.upsertParticipant(HOME, STRANGE, store.participantRecord('worker:opechatka', { harness: 'claude', mode: 'attached', sessionRef: 'sess-worker' }));
const strange = fakeRegistry();
await capture(async () => stopManaged(HOME, STRANGE, { registry: strange.registry }));
check(': attached в обход гашения не берётся — driver его не поднимал',
  strange.calls.length === 0, strange.calls.join(', '));
const strangeRefusal = await (async () => {
  try {
    await bus.stopParticipant({ address: 'worker:musor', harness: 'claude', mode: 'что-то своё', sessionRef: 'sess-reviewer' },
      fakeRegistry().registry);
    return '';
  } catch (e) {
    return e.message;
  }
})();
check(': явный вызов на незнакомом режиме отказывает и называет его дословно',
  /«что-то своё»/.test(strangeRefusal) && /the contract does not know this mode/.test(strangeRefusal), strangeRefusal);

// --- выключатель необратимого действия ----------------------------------------
//
// `--keep-sessions` проверяется на настоящей команде: ветка живёт в `done`, а не в обходе,
// и объявление флага держит свой гейт ([cli-flags.test.mjs](cli-flags.test.mjs)). Здесь —
// что флаг доезжает до библиотеки своим кебабным ключом и меняет ход команды.
const { done } = await import(path.join(here, '..', 'lib', 'done.js'));
writeFileSync(path.join(SB, 'AGENTS.md'), 'песочница\n');
writeHostConfig(SB);
const KEEP = 'done-keep-t20260901-230400';
store.createTask(HOME, { id: KEEP, title: 'выключатель гашения', owner: null });
// Снимок сессий — швом: предмет файла — уборка, а не опрос harness'а, и живой
// `claude` ему не нужен ни одной ветвью.
const noSessions = () => ({});
const keptOut = await capture(async () => done(SB, { task: KEEP, 'keep-sessions': true, snapshot: noSessions }));
check(': --keep-sessions доезжает своим ключом и называет себя в выводе',
  /--keep-sessions: participant sessions left alive/.test(keptOut), keptOut.trim());
check(': с флагом обход гашения не начинается вовсе',
  !/stopping participant sessions/.test(keptOut), keptOut.trim());
// --- : `done` убирает журналы ДАВНО закрытых задач ------------------------
//
// Замер владельца 2026-09-02: журнал рабочего места — 71 задача, 36 МБ, 1243 сообщения,
// 196 артефактов. Ручной `prune` есть с , но зовут его руками, и журнал рос
// быстрее, чем его мели. Решение владельца: `done` после своей работы зовёт ту же уборку
// порогом по умолчанию — закрытие задачи и есть тот момент, когда человек прибирает и
// видит перечень. Дом здесь свой: счётчики уборки не должны считать задачи проверок выше.
const { PRUNE_DEFAULT_DAYS } = await import(path.join(here, '..', 'lib', 'prune.js'));
const SWEEP = path.join(SB, 'sweep-ws');
const sweepHome = path.join(SWEEP, '.promptobus');
mkdirSync(sweepHome, { recursive: true });
writeFileSync(path.join(SWEEP, 'AGENTS.md'), 'песочница\n');
writeHostConfig(SWEEP);
// Дата ставится прямо в журнал: `closeTask` пишет «сейчас», а предмет проверки — возраст.
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const closedAgo = (id, title, ago) => {
  store.createTask(sweepHome, { id, title, owner: null });
  store.closeTask(sweepHome, id);
  store.patchTask(sweepHome, id, { adapter: { closed: daysAgo(ago) } });
  return id;
};
const SWEEP_OLD = closedAgo('sweep-staraya-t20260801-010000', 'давно закрытый заход', PRUNE_DEFAULT_DAYS + 1);
const SWEEP_YOUNG = closedAgo('sweep-svezhaya-t20260901-020000', 'вчерашний заход', 1);
// Закрыта давно, но её worktree ещё стоит на диске: журнал — единственное место, где
// записано, где лежит эта работа. Сессии у участника нет вовсе — обход worktree оставит
// каталог со словами "unknown" и внешнего опроса не сделает.
const SWEEP_HELD = closedAgo('sweep-zanyataya-t20260801-030000', 'заход с оставленным каталогом', PRUNE_DEFAULT_DAYS + 1);
const heldTree = path.join(SB, 'sweep-repo', '.claude', 'worktrees', 'promptobus-ostavshiysya');
mkdirSync(heldTree, { recursive: true });
store.upsertParticipant(sweepHome, SWEEP_HELD, store.participantRecord('worker:ostavshiysya', { repoAbs: path.join(SB, 'sweep-repo'), worktree: heldTree }));
const SWEEP_ACTIVE = 'sweep-zhivaya-t20260902-040000';
store.createTask(sweepHome, { id: SWEEP_ACTIVE, title: 'живой заход', owner: null });
// Задача, которую закрывает сам вызов: ей от роду секунды, и под уборку она не попадает.
const SWEEP_NOW = 'sweep-seychas-t20260902-050000';
store.createTask(sweepHome, { id: SWEEP_NOW, title: 'закрываемая сейчас', owner: null });

const swept = await capture(async () => done(SWEEP, { task: SWEEP_NOW, snapshot: noSessions }));
check(': done снял журнал давно закрытой задачи и назвал её в перечне',
  !existsSync(store.taskDir(sweepHome, SWEEP_OLD)) && swept.includes(SWEEP_OLD)
  && /journals removed: tasks 1/.test(swept), swept.trim());
check(': молодая, занятая каталогом и активная задачи уборку пережили',
  [SWEEP_YOUNG, SWEEP_HELD, SWEEP_ACTIVE].every((id) => existsSync(store.taskDir(sweepHome, id))),
  [SWEEP_YOUNG, SWEEP_HELD, SWEEP_ACTIVE].filter((id) => !existsSync(store.taskDir(sweepHome, id))).join(' · '));
// Ищем id в строке ПЕРЕЧНЯ (`<id> "<title>" — closed …`), а не где угодно в выводе:
// закрываемую задачу `done` называет своей первой строкой, и голое вхождение id было бы
// истинно всегда.
check(': только что закрытая задача остаётся — уборка идёт по порогу, а не по факту закрытия',
  existsSync(store.taskDir(sweepHome, SWEEP_NOW)) && !new RegExp(`${SWEEP_NOW} "`).test(swept),
  swept.trim());
// Порядок обязателен: обход worktree читает журналы ВСЕХ закрытых задач, и снеси уборка
// журнал раньше — каталог остался бы сиротой без имени.
// `includes` обязателен: `indexOf` отсутствующей строки даёт −1, и сверка порядка прошла
// бы вхолостую ровно там, где обход worktree не сказал ничего (замечание ревью).
check(': уборка журналов идёт после обхода worktree, а не до него',
  swept.includes('left in place') && swept.indexOf('left in place') < swept.indexOf('journals removed'),
  swept.trim());

// Дом без кандидатов: `done` про уборку молчит вовсе. Строка про несделанное на каждом
// закрытии была бы шумом — перечень и счёт остаются у ручного `promptobus prune`.
const QUIET = path.join(SB, 'quiet-ws');
mkdirSync(path.join(QUIET, '.promptobus'), { recursive: true });
writeFileSync(path.join(QUIET, 'AGENTS.md'), 'песочница\n');
writeHostConfig(QUIET);
const QUIET_TASK = 'quiet-t20260902-060000';
store.createTask(path.join(QUIET, '.promptobus'), { id: QUIET_TASK, title: 'нечего убирать', owner: null });
const quietOut = await capture(async () => done(QUIET, { task: QUIET_TASK, snapshot: noSessions }));
check(': nothing to remove — done про уборку не говорит ничего',
  !/journals removed|nothing to remove/.test(quietOut) && /closed/.test(quietOut), quietOut.trim());
