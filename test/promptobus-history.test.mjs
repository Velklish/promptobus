// Регресс на журнал прочитанной переписки — `promptobus promptobus history`.
// Запуск: npm test
//
// Предмет — три свойства команды, которые обещаны прозой и которые нечем проверить глазом:
// история отдаёт записи от СТАРЫХ к новым, лимит по умолчанию считает записи (а не
// сообщения), и чтение истории НЕ делает прочитанным ничего. Последнее дороже остальных:
// история и mailbox лежат в одном сторе, и команда, случайно позвавшая забор, съела бы
// непрочитанное у живого участника молча.
//
// Фильтр по участнику проверяется парой «пусто и не пусто»: у адреса с непрочитанным
// история пуста, у забравшего — нет. Одна половина этой пары зеленела бы и на сломанном
// фильтре.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';

const ROOT = makeSandbox('promptobus-promptobus-history-');
const here = path.dirname(fileURLToPath(import.meta.url));

// Корень рабочего места команда ищет сама: `requireRoot` смотрит на пару файлов.
writeFileSync(path.join(ROOT, 'modules.lock'), '{}\n');
writeFileSync(path.join(ROOT, 'AGENTS.md'), 'проба истории\n');

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { history } = await import(path.join(here, '..', 'lib', 'history.js'));

const HOME = store.promptobusHome(ROOT);
const TASK = 'istoriya-t20260902-120000';
const SECOND = 'sosedka-t20260902-130000';
const WORKER = 'worker:api';
const REVIEWER = 'reviewer:api';

store.createTask(HOME, { id: TASK, title: 'журнал переписки', owner: 'sess-orch' });
store.upsertParticipant(HOME, TASK, store.participantRecord(WORKER, { repo: 'loads_search/cargos-api' }));
store.upsertParticipant(HOME, TASK, store.participantRecord(REVIEWER));
store.createTask(HOME, { id: SECOND, title: 'соседняя задача', owner: 'sess-orch' });
store.upsertParticipant(HOME, SECOND, store.participantRecord(WORKER));

// Пять сообщений в задаче: три статуса worker'а, ответ оркестратора и замечание reviewer'а.
// Тело первого — многострочное: в строку журнала обязан попасть первый абзац, а не «\n».
store.sendMessage(HOME, TASK, {
  from: WORKER, to: 'orchestrator', type: 'status', body: 'ШАГ-ОДИН: взял задание\n\nвторой абзац',
});
store.sendMessage(HOME, TASK, { from: WORKER, to: 'orchestrator', type: 'status', body: 'ШАГ-ДВА' });
store.sendMessage(HOME, TASK, { from: WORKER, to: 'orchestrator', type: 'status', body: 'ШАГ-ТРИ' });
store.sendMessage(HOME, TASK, { from: 'orchestrator', to: WORKER, type: 'answer', body: 'ОТВЕТ' });
store.sendMessage(HOME, TASK, { from: REVIEWER, to: 'orchestrator', type: 'review', body: 'ЗАМЕЧАНИЕ' });
// Сообщение с артефактом: в v1 оно несёт id metadata-записи, а печатать журнал обязан ИМЯ
// файла — по id человек файл в папке задачи не найдёт (замечание ревью ). Имя
// нарочно не похоже ни на id, ни на путь: подстрока из пути прошла бы и на сыром поле.
const ARTIFACT = path.join(ROOT, 'diff-obzora.patch');
writeFileSync(ARTIFACT, 'diff --git a/x b/x\n');
store.sendMessage(HOME, SECOND, {
  from: WORKER, to: 'orchestrator', type: 'result', body: 'СОСЕДКА', artifactPath: ARTIFACT,
});

// В историю попадает ЗАБРАННОЕ. Оркестратор забирает обе задачи, worker свою — нет:
// его `ОТВЕТ` остаётся непрочитанным и служит мерой того, что история его не трогает.
store.readInbox(HOME, TASK, 'orchestrator');
store.readInbox(HOME, SECOND, 'orchestrator');

const unreadBefore = store.countInbox(HOME, TASK, WORKER);
check('стенд: у worker\'а есть непрочитанное — есть чем мерить неприкосновенность mailbox\'а',
  unreadBefore === 1, String(unreadBefore));

const all = capture(() => history(ROOT, {}));
const lines = all.split('\n').filter((l) => l.includes(' · '));
check('умолчание: отданы все прочитанные записи обеих задач',
  lines.length === 5, `${lines.length}: ${all}`);
check('порядок: от старых записей к новым',
  lines[0].includes('ШАГ-ОДИН') && lines[4].includes('СОСЕДКА'), all);
check('строка называет время, задачу, тип и обе стороны адресами шины',
  /^\s+2026-\S+ · istoriya-t20260902-120000 · status worker:api → orchestrator — ШАГ-ОДИН/.test(lines[0]),
  lines[0]);
check('тело сжато до первого абзаца — второй в строку не едет',
  !all.includes('второй абзац'), lines[0]);
const withArt = lines[4];
check('артефакт назван именем файла, а не id metadata-записи',
  / · артефакт diff-obzora\.patch/.test(withArt), withArt);
// Обратная половина: id в строку не попал вовсе. Без неё проверка выше зеленела бы и на
// строке, где рядом с именем печатается ещё и сырое поле.
const artId = store.history(HOME, { task: SECOND }).entries[0].message.artifact;
check('id metadata-записи в строку не едет — у человека одно имя, а не два',
  typeof artId === 'string' && artId.length > 0 && !withArt.includes(artId),
  `${artId} · ${withArt}`);

// Забор истории не трогает mailbox: непрочитанное worker'а на месте, у оркестратора
// по-прежнему пусто. Проверка стоит СРАЗУ после первого вызова — до фильтров: сломай
// команда mailbox, и все проверки ниже мерили бы уже испорченный стенд.
check('история не делает прочитанным ничего — непрочитанное worker\'а на месте',
  store.countInbox(HOME, TASK, WORKER) === unreadBefore
  && store.countInbox(HOME, TASK, 'orchestrator') === 0,
  `${store.countInbox(HOME, TASK, WORKER)} / ${store.countInbox(HOME, TASK, 'orchestrator')}`);

const one = capture(() => history(ROOT, { task: TASK }));
check('--task: соседняя задача в выдачу не попадает',
  one.includes('ЗАМЕЧАНИЕ') && !one.includes('СОСЕДКА'), one);

const boxed = capture(() => history(ROOT, { task: TASK, participant: 'orchestrator' }));
check('--participant: адрес принимается адресом шины, а не именем каталога mailbox\'а',
  boxed.split('\n').filter((l) => l.includes(' · ')).length === 4, boxed);
const empty = capture(() => history(ROOT, { task: TASK, participant: WORKER }));
check('--participant: у не забиравшего mailbox история пуста — фильтр работает в обе стороны',
  empty.includes('в истории пусто'), empty);

const limited = capture(() => history(ROOT, { limit: '2' }));
const tail = limited.split('\n').filter((l) => l.includes(' · '));
check('--limit: отдаётся хвост — последние записи, а не первые',
  tail.length === 2 && tail[1].includes('СОСЕДКА'), limited);
check('--limit: усечённая выдача говорит, что старше есть',
  /старше есть/.test(limited), limited);
check('--all: полная выдача о старших не говорит',
  !/старше есть/.test(capture(() => history(ROOT, { all: true }))), 'all');

// --- отказы ------------------------------------------------------------------

const both = expectFail(() => history(ROOT, { all: true, limit: '3' }));
check('--all и --limit вместе — отказ, а не молчаливый выбор одного из двух',
  both.failed && /--all и --limit вместе не принимаются/.test(both.out), both.out);
for (const bad of ['0', '-1', 'abc', '2.5']) {
  const r = expectFail(() => history(ROOT, { limit: bad }));
  check(`--limit «${bad}» — отказ с самим значением в тексте`,
    r.failed && r.out.includes(`«${bad}»`), r.out);
}
const ghost = expectFail(() => history(ROOT, { task: 'net-takoy' }));
check('неизвестная задача — отказ перечисляет известные, а не отдаёт пустоту',
  ghost.failed && /задачи «net-takoy» в журнале нет/.test(ghost.out) && ghost.out.includes(TASK),
  ghost.out);
const badAddr = expectFail(() => history(ROOT, { participant: 'boss' }));
check('негодный адрес участника — отказ грамматикой адреса, а не пустая выдача',
  badAddr.failed && /worker:<slug>/.test(badAddr.out), badAddr.out);
