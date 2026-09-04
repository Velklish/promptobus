// Многопроцессная конкуренция там, где её не закрывает engine: участники под локом журнала,
// уникальность имён записей на диске, metadata артефактов и место надзирателя. Настоящими
// процессами, а не промисами в одном: предмет проверки — атомарные примитивы файловой
// системы (`mkdir` лока, `wx` журнала, `link` имени записи), а внутри одного процесса они
// никогда не встречаются с собой.
//
// Переехало вместе с кодом: разделы про read-modify-write двух процессов
// и про атомарность («первый выигрывает»).
// Запуск — своя команда package: `npm test`.
//
// **Три проверки сняты и не потеряны.** Они гоняли через слой совместимости ту же
// конкуренцию, что [v1-races.test.mjs](v1-races.test.mjs) проверяет прямо на engine, и после
// снятия слоя стали бы дословными копиями: «конкурентная запись двух процессов в один inbox»
// покрыта там проверкой «два процесса шлют в один mailbox — ничего не потеряно и порядок
// отправителя цел», «одну задачу заводит ровно один из восьми» — «восемь процессов заводят
// одну задачу — успех ровно у одного», «два читателя одного mailbox'а» — «два читателя
// одного mailbox'а — ни отказа, ни задвоенного сообщения».
//
// **Многопроцессная гонка ИМЕНИ артефакта в папке файлов задачи снята, и замены ей нет.**
// Имя занимает сама жёсткая ссылка: `linkSync` отказывает `EEXIST` на занятом имени, и
// выбор следующего идёт циклом у двери механизма (`placeFile` в
// adapter потребителя). Свойство держится этим
// отказом ФС, а не проверкой перед записью, и покрыто оно последовательно —
// набором adapter'а потребителя,
// «артефакт: одноимённый не затирает прежний — имя занимает сама ссылка». Многопроцессного
// стенда у двери нет: он стоил бы своего харнеса ради ветки, где сама ФС и есть арбитр.
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const store = await import('../dist/index.js');

// Routing policy обязательна при открытии engine, и правило её — дело adapter'а: здесь adapter'а нет, и его играет набор. Пример policy («worker'у нельзя писать
// worker'у») живёт в CLI и проверяется там.
const DIST = new URL('../dist/index.js', import.meta.url).href;

// Adapter'а здесь нет, и его играет набор: перевод адреса в запись участника — его дело.
// Тот же перевод уезжает и в дочерний процесс: он открывает свой engine и кладёт свои
// записи, а имена и поля обязаны совпадать с родительскими.
const RECIPE = `const at = (home) => m.openEngine({ home, policy: () => ({ allow: true }) });
const rec = (address, fields = {}) => ({
  id: m.addrDir(address), role: m.roleOf(address), harness: 'proba',
  mode: fields.sessionRef ? 'managed' : 'attached', sessionRef: fields.sessionRef ?? null,
  capabilities: null, metadata: { address, ...fields },
});
`;
// eslint-disable-next-line no-new-func
const { at, rec } = await import(`data:text/javascript,${encodeURIComponent(
  `const m = await import(${JSON.stringify(DIST)});\n${RECIPE}export { at, rec };`,
)}`);

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-races-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const J = JSON.stringify;

// Доклад ребёнка «дошёл до барьера». Первая строка его stdout и в проверки не возвращается.
const READY = '__ready__';

// Дочерний процесс с кодом на входе: код выхода, stdout и stderr одним резолвом.
//
// Код возврата берётся у КАЖДОГО ребёнка, а не только там, где его спрашивают. Тело упавшего
// ребёнка не печатает ничего, и его молчание неотличимо от затёртой записи: проверка счёта
// называла причиной следствие — «сообщение затёрто» вместо «процесс не отработал».
//
// Резолв по `close`, а не по `exit`: `exit` приходит до того, как дочитаны пайпы, и хвост
// stderr упавшего ребёнка уезжал бы вместе с диагнозом, ради которого он и читается.
//
// `ready` — хук барьера: зовётся ровно один раз, с stdin'ом ребёнка при докладе о готовности
// либо с `null`, если ребёнок умер, не доложив. Второе обязательно: упавший ребёнок иначе
// запирал бы барьер навсегда, а его код возврата нужен проверке живым.
function child(body, { ready = null } = {}) {
  const code = `const m = await import(${J(DIST)});\n${RECIPE}${body}`;
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, ['--input-type=module', '-e', code],
      { stdio: [ready ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let pending = ready;
    const arrive = (stdin) => {
      if (!pending) return;
      const hook = pending;
      pending = null;
      hook(stdin);
    };
    ch.stdout.on('data', (d) => { out += d; if (out.startsWith(`${READY}\n`)) arrive(ch.stdin); });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (c) => {
      arrive(null);
      resolve({ code: c, out: (ready ? out.slice(out.indexOf('\n') + 1) : out).trim(), err: err.trim() });
    });
  });
}

// Все дети вышли нулём — сверяется ПЕРЕД всяким счётом сообщений и артефактов. Деталь
// называет упавшего и несёт его stderr: диагноз стоит там, а не в числе недосчитанных.
function exitedZero(kids, who = (i) => `#${i}`) {
  const dead = kids.map((k, i) => ({ ...k, who: who(i) })).filter((k) => k.code !== 0);
  assert.equal(dead.length, 0, dead
    .map((k) => `ребёнок ${k.who} вышел кодом ${k.code}: ${k.err || 'stderr пуст'}`).join('\n'));
}

// Барьер для гонок: дети докладывают о готовности и засыпают на чтении stdin, а родитель
// отпускает всех разом, когда собрались все. Без барьера они выстраиваются в очередь по
// времени запуска процесса, и окно между проверкой и записью — то самое, которое чинится, —
// не наступает вовсе.
//
// По готовности, а не по общей метке времени. Метка давала фору на запуск node и
// импорт `dist`, и калибровалась она под спокойную машину: под нагрузкой (load average
// 41–43) половина из восьми детей входила в барьер уже ПОСЛЕ метки, +27…−159 мс, и гонка
// вырождалась в почти последовательный запуск. Доклад о нагрузке не знает вовсе: опоздавших
// нет по построению, а замер восьми детей в 5 кругов дал разброс выхода из барьера 0…3 мс
// против 7…28 мс у метки на той же машине.
//
// Ожидание на stdin — блокировка, а не спин: процессорного времени оно не жжёт вовсе.
// Снятие stdin с чтения после отпуска обязательно: оставленный в потоке, он держал бы цикл
// событий ребёнка живым и после того, как тело гонки отработало.
function racers(n, body) {
  const doors = [];
  let seen = 0;
  let gathered = null;
  const all = new Promise((r) => { gathered = r; });
  const arrive = (stdin) => {
    if (stdin) {
      // Слушатель ошибки — сразу при укладке двери, а не при отпуске: ребёнок, доложивший о
      // готовности и тут же умерший, оставил бы пайп без слушателя, и EPIPE уронил бы набор.
      stdin.on('error', () => {});
      doors.push(stdin);
    }
    seen += 1;
    if (seen === n) gathered();
  };
  const kids = Array.from({ length: n }, (_, i) => child(
    `const i = ${i};\nconsole.log(${J(READY)});\n`
    + "await new Promise((r) => process.stdin.once('data', r));\nprocess.stdin.pause();\n"
    + body,
    { ready: arrive },
  ));
  return all.then(() => {
    // Ребёнок мог умереть между докладом и отпуском: EPIPE здесь не отказ стенда, и
    // слушатель ошибки на двери стоит с самой её укладки.
    for (const door of doors) door.end('go\n');
    return Promise.all(kids);
  });
}

// --- read-modify-write двух процессов ---------------------------------

test('два процесса пишут участников — ни одна запись не потеряна', async () => {
  // Без лока второй писатель кладёт список, прочитанный до чужой записи, и участник
  // теряется молча — worker поднят, а в журнале его нет. Адреса у всех разные:
  // потерянная запись не восстанавливается следующим кругом.
  const home = path.join(SB, 'race-participants');
  const RACE_N = 120;
  const raceTask = at(home).createTask({
    id: 't20260827-100003', title: 'гонка участников', owner: rec(store.ORCHESTRATOR),
  });
  const joiner = (prefix) => child(`const e = at(${J(home)});\n`
    + `for (let i = 0; i < ${RACE_N}; i += 1) e.putParticipant(${J(raceTask.id)}, `
    + `rec('worker:${prefix}' + i, { repo: 'ns/repo' }));`);
  const joiners = await Promise.all([joiner('a'), joiner('b')]);
  const joined = at(home).readTask(raceTask.id).participants;
  exitedZero(joiners, (i) => ['a', 'b'][i]);
  assert.equal(joined.length, RACE_N * 2 + 1, `участников ${joined.length} из ${RACE_N * 2 + 1}`);
  assert.ok(!existsSync(path.join(store.taskDir(home, raceTask.id), '.lock')), 'лок снят');
  assert.ok(readdirSync(store.taskDir(home, raceTask.id)).every((n) => !n.startsWith('.tmp-')),
    'временных файлов не осталось');
});

// --- атомарность и «первый выигрывает» -------------------------------

const atomicHome = path.join(SB, 'race-atomic');

test('имена сообщений уникальны на диске, а не в памяти процесса', async (t) => {
  // `seq` свой у каждого процесса, и два отправителя под одним адресом в одну миллисекунду
  // собирали одно имя, а `rename` перезаписывал молча. Адрес у всех детей один — в этом
  // весь предмет.
  const NAME_TASK = 'imena-t20260829-030100';
  const engine = at(atomicHome);
  engine.createTask({ id: NAME_TASK, title: 'уникальность имён', owner: rec(store.ORCHESTRATOR) });
  engine.putParticipant(NAME_TASK, rec('worker:a'));
  const WRITERS = 6;
  const PER_WRITER = 30;
  const kids = await racers(WRITERS,
    `const e = at(${J(atomicHome)});\n`
    + `for (let k = 0; k < ${PER_WRITER}; k += 1) e.sendSync(${J(NAME_TASK)}, `
    + "{ from: 'worker-a', to: ['orchestrator'], type: 'status', body: i + '#' + k });");
  const { messages: sameFrom } = engine.peek(NAME_TASK, 'orchestrator');
  await t.test('отправители под одним адресом — ни одно сообщение не затёрто', () => {
    exitedZero(kids);
    assert.equal(sameFrom.length, WRITERS * PER_WRITER, `${sameFrom.length} из ${WRITERS * PER_WRITER}`);
  });
  await t.test('временных файлов после гонки имён не осталось', () => {
    exitedZero(kids);
    assert.equal(readdirSync(engine.inboxPath(NAME_TASK, 'orchestrator'))
      .filter((n) => n.startsWith('.tmp-')).length, 0);
  });
});

test('параллельные отправители одного содержимого не теряют записей', async (t) => {
  // Имя записи занимала проверка перед копированием, и два отправителя, увидевшие одно
  // свободное имя, клали файл друг поверх друга. В store v1 содержимое адресуется SHA-256 и
  // дедуплицируется, а видимая часть — metadata-запись: тридцать отправок одного файла дают
  // тридцать записей и один blob, и ни одна запись не теряется. Гонка ЧЕЛОВЕЧЕСКОГО имени в
  // папке файлов задачи — дело adapter'а, и проверяется она у него.
  const ART_TASK = 'artefakty-t20260829-030200';
  const engine = at(atomicHome);
  engine.createTask({ id: ART_TASK, title: 'гонка артефактов', owner: rec(store.ORCHESTRATOR) });
  engine.putParticipant(ART_TASK, rec('worker:a'));
  const artRace = path.join(SB, 'race-artifact.json');
  writeFileSync(artRace, '{"event":"CargoCreated"}\n');
  const kids = await racers(6,
    `const e = at(${J(atomicHome)});\n`
    + `for (let k = 0; k < 5; k += 1) e.sendSync(${J(ART_TASK)}, `
    + "{ from: 'worker-a', to: ['orchestrator'], type: 'artifact', body: 'a' + i + k, "
    + `artifact: { path: ${J(artRace)} } });`);
  await t.test('параллельные отправители — metadata-записей столько же, сколько отправок', () => {
    exitedZero(kids);
    const { artifacts, broken } = engine.listArtifacts(ART_TASK);
    assert.equal(broken.length, 0, broken.join(', '));
    assert.equal(artifacts.length, 30, `${artifacts.length} из 30`);
  });
  await t.test('id записей не повторяются, а содержимое дедуплицировано в один blob', () => {
    exitedZero(kids);
    const seen = engine.peek(ART_TASK, 'orchestrator').messages.map((msg) => msg.artifact);
    assert.equal(new Set(seen).size, 30);
    assert.equal(new Set(engine.listArtifacts(ART_TASK).artifacts.map((a) => a.sha256)).size, 1);
  });
});

test('отметка надзирателя не пишется поверх себя', async () => {
  // Приезжает на место через rename, как журнал: жёсткая ссылка на прежний файл
  // держит прежнее содержимое. Записанная поверх себя, она менялась бы и по ссылке — а
  // между усечением и записью читатель видит пустой файл и отвечает «надзирателя нет», то
  // есть противоположное правде.
  const MARK_TASK = 'otmetka-t20260829-030300';
  at(atomicHome).createTask({ id: MARK_TASK, title: 'атомарность отметки', owner: rec(store.ORCHESTRATOR) });
  store.claimWarden(atomicHome, MARK_TASK, { cli: 'проба' });
  const heldMark = path.join(SB, 'race-mark.json');
  linkSync(store.wardenMarkFile(atomicHome, MARK_TASK), heldMark);
  const heldBeat = JSON.parse(readFileSync(heldMark, 'utf8')).beat;
  // Удар сердца несёт время: без паузы обе записи легли бы в одну миллисекунду, и
  // сравнивать было бы нечего.
  await new Promise((r) => { setTimeout(r, 5); });
  const beaten = store.beatWarden(atomicHome, MARK_TASK);
  assert.equal(JSON.parse(readFileSync(heldMark, 'utf8')).beat, heldBeat);
  assert.equal(JSON.parse(readFileSync(store.wardenMarkFile(atomicHome, MARK_TASK), 'utf8')).beat, beaten.beat);
  assert.notEqual(beaten.beat, heldBeat);
});

test('место надзирателя занимает ровно один из восьми', async () => {
  // Проверка живости и запись отметки — одно решение под локом. Без лока восемь
  // параллельных команд шины видят «надзирателя нет» и поднимают восемь процессов: одну
  // задачу стерегли бы восемь циклов доставки, и каждое сообщение уезжало бы адресату
  // восемь раз.
  const CLAIM_TASK = 'nadziratel-t20260829-030400';
  at(atomicHome).createTask({ id: CLAIM_TASK, title: 'первый выигрывает место надзирателя', owner: rec(store.ORCHESTRATOR) });
  // Отметка ставится на pid РОДИТЕЛЯ, а не свой у каждого ребёнка. Место
  // держится живостью владельца: `liveWarden` спрашивает `pidAlive`, и вышедший победитель
  // освобождает его по-настоящему. Пока дети метили себя, победителя приходилось держать
  // живым сном, и под пулом раннера этот сон не покрывал разброса — первый выходил раньше,
  // чем последний доходил до `claimWarden`, и тот занимал СВОБОДНОЕ место законно. Так
  // файл и падал в общем прогоне, проходя в одиночку: `mark, busy, busy, busy, busy, mark,
  // busy, busy`, тест 4,3 с при удержании 900 мс. Родительский pid жив весь тест, поэтому
  // держать место сном больше не надо вовсе — и проверяется ровно то, что названо в
  // заголовке: решение под локом, а не время жизни чужого процесса.
  const kids = await racers(8,
    `const r = m.claimWarden(${J(atomicHome)}, ${J(CLAIM_TASK)}, { pid: ${process.pid} });\n`
    + "console.log(r.busy ? 'busy' : 'mark');");
  exitedZero(kids);
  const claims = kids.map((k) => k.out);
  assert.equal(claims.filter((r) => r === 'mark').length, 1, claims.join(', '));
});

test('снятие отметки идёт под локом задачи', async (t) => {
  // Снятие отметки — read-check-delete, и оно тоже под локом: между чтением «моя ли» и
  // удалением помещается чужой `claimWarden`, и снялась бы свежая чужая отметка. Признак
  // лока — само ожидание: держателя снимает посторонний процесс через 400 мс, и снятие
  // столько же и досиживает. Держатель живой (наш pid), поэтому сиротой лок не считается.
  const LOCK_TASK = 'snyatie-t20260829-030500';
  at(atomicHome).createTask({ id: LOCK_TASK, title: 'снятие под локом', owner: rec(store.ORCHESTRATOR) });
  store.claimWarden(atomicHome, LOCK_TASK);
  const clearLock = path.join(store.taskDir(atomicHome, LOCK_TASK), '.lock');
  mkdirSync(clearLock, { recursive: true });
  writeFileSync(path.join(clearLock, 'owner'), `${JSON.stringify({ pid: process.pid, session: null, since: null })}\n`);
  const releaser = spawn(process.execPath, ['--input-type=module', '-e',
    'await new Promise((r) => setTimeout(r, 400));\n'
    + `(await import('node:fs')).rmSync(${J(clearLock)}, { recursive: true, force: true });`],
  { stdio: ['ignore', 'ignore', 'inherit'] });
  const clearStart = Date.now();
  const cleared = store.clearWarden(atomicHome, LOCK_TASK);
  const clearMs = Date.now() - clearStart;
  await new Promise((r) => releaser.on('exit', r));
  await t.test('снятие отметки ждёт лока задачи — read-check-delete не идёт мимо него', () => {
    assert.equal(cleared, true);
    assert.ok(clearMs >= 350, `${clearMs}ms`);
    assert.ok(!existsSync(store.wardenMarkFile(atomicHome, LOCK_TASK)));
  });
  // Задачи на диске уже нет — снимать нечего, и лок брать не у чего: зовётся это из
  // `finally` цикла надзирателя, и отказ оттуда унёс бы законный выход.
  rmSync(store.taskDir(atomicHome, LOCK_TASK), { recursive: true, force: true });
  await t.test('снесённая с диска задача — снятие молчит, а не падает на локе', () => {
    let threw = false;
    try { store.clearWarden(atomicHome, LOCK_TASK); } catch { threw = true; }
    assert.ok(!threw);
  });
});
