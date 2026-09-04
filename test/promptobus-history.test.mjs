// Regression on the journal of read mail — `promptobus promptobus history`.
// Run: npm test
//
// The subject is three properties the prose promises and that you cannot check by eye:
// history returns entries from OLDEST to newest, the default limit counts entries (not
// messages), and reading history marks NOTHING as read. The last one costs more than the
// others: history and mailbox live in the same store, and a command that accidentally
// fetched would silently eat unread mail of a live participant.
//
// The participant filter is checked as a pair "empty and not empty": an address with
// unread mail has an empty history, one that fetched does not. One half of that pair
// would stay green on a broken filter.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';

const ROOT = makeSandbox('promptobus-promptobus-history-');
const here = path.dirname(fileURLToPath(import.meta.url));

const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));

writeHostConfig(ROOT);
writeFileSync(path.join(ROOT, 'AGENTS.md'), 'проба истории\n');

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { history } = await import(path.join(here, '..', 'lib', 'history.js'));

const HOME = store.promptobusHome(ROOT, hostOf(ROOT));
const TASK = 'istoriya-t20260902-120000';
const SECOND = 'sosedka-t20260902-130000';
const WORKER = 'worker:api';
const REVIEWER = 'reviewer:api';

store.createTask(HOME, { id: TASK, title: 'журнал переписки', owner: 'sess-orch' });
store.upsertParticipant(HOME, TASK, store.participantRecord(WORKER, { repo: 'loads_search/cargos-api' }));
store.upsertParticipant(HOME, TASK, store.participantRecord(REVIEWER));
store.createTask(HOME, { id: SECOND, title: 'соседняя задача', owner: 'sess-orch' });
store.upsertParticipant(HOME, SECOND, store.participantRecord(WORKER));

// Five messages in the task: three worker statuses, an orchestrator answer, and a
// reviewer note. The first body is multiline: the journal line must take the first
// paragraph, not "\n".
store.sendMessage(HOME, TASK, {
  from: WORKER, to: 'orchestrator', type: 'status', body: 'ШАГ-ОДИН: взял задание\n\nвторой абзац',
});
store.sendMessage(HOME, TASK, { from: WORKER, to: 'orchestrator', type: 'status', body: 'ШАГ-ДВА' });
store.sendMessage(HOME, TASK, { from: WORKER, to: 'orchestrator', type: 'status', body: 'ШАГ-ТРИ' });
store.sendMessage(HOME, TASK, { from: 'orchestrator', to: WORKER, type: 'answer', body: 'ОТВЕТ' });
store.sendMessage(HOME, TASK, { from: REVIEWER, to: 'orchestrator', type: 'review', body: 'ЗАМЕЧАНИЕ' });
// Message with an artifact: in v1 it carries a metadata-record id, and the journal must
// print the FILE NAME — a person will not find the file in the task folder by id
// (review note). The name is deliberately unlike either the id or the path: a substring
// of the path would pass on the raw field too.
const ARTIFACT = path.join(ROOT, 'diff-obzora.patch');
writeFileSync(ARTIFACT, 'diff --git a/x b/x\n');
store.sendMessage(HOME, SECOND, {
  from: WORKER, to: 'orchestrator', type: 'result', body: 'СОСЕДКА', artifactPath: ARTIFACT,
});

// History gets FETCHED mail. The orchestrator fetches both tasks, the worker theirs —
// not: their `ОТВЕТ` stays unread and measures that history does not touch it.
store.readInbox(HOME, TASK, 'orchestrator');
store.readInbox(HOME, SECOND, 'orchestrator');

const unreadBefore = store.countInbox(HOME, TASK, WORKER);
check('stand: the worker has unread mail — something to measure mailbox inviolability by',
  unreadBefore === 1, String(unreadBefore));

const all = capture(() => history(ROOT, {}));
const lines = all.split('\n').filter((l) => l.includes(' · '));
check('default: all read entries of both tasks are returned',
  lines.length === 5, `${lines.length}: ${all}`);
check('order: from oldest entries to newest',
  lines[0].includes('ШАГ-ОДИН') && lines[4].includes('СОСЕДКА'), all);
check('the line names time, task, type, and both sides as bus addresses',
  /^\s+2026-\S+ · istoriya-t20260902-120000 · status worker:api → orchestrator — ШАГ-ОДИН/.test(lines[0]),
  lines[0]);
check('body is compressed to the first paragraph — the second does not go into the line',
  !all.includes('второй абзац'), lines[0]);
const withArt = lines[4];
check('the artifact is named by file name, not by the metadata-record id',
  / · artifact diff-obzora\.patch/.test(withArt), withArt);
// Reverse half: the id did not land in the line at all. Without it the check above
// would stay green on a line that prints the raw field next to the name.
const artId = store.history(HOME, { task: SECOND }).entries[0].message.artifact;
check('the metadata-record id does not go into the line — a person sees one name, not two',
  typeof artId === 'string' && artId.length > 0 && !withArt.includes(artId),
  `${artId} · ${withArt}`);

// Fetching history does not touch the mailbox: the worker's unread is still there, the
// orchestrator's is still empty. The check sits RIGHT after the first call — before
// filters: if the command broke the mailbox, every check below would measure an already
// spoiled stand.
check('history marks nothing as read — the worker\'s unread is still there',
  store.countInbox(HOME, TASK, WORKER) === unreadBefore
  && store.countInbox(HOME, TASK, 'orchestrator') === 0,
  `${store.countInbox(HOME, TASK, WORKER)} / ${store.countInbox(HOME, TASK, 'orchestrator')}`);

const one = capture(() => history(ROOT, { task: TASK }));
check('--task: the neighboring task does not enter the output',
  one.includes('ЗАМЕЧАНИЕ') && !one.includes('СОСЕДКА'), one);

const boxed = capture(() => history(ROOT, { task: TASK, participant: 'orchestrator' }));
check('--participant: the address is accepted as a bus address, not as a mailbox directory name',
  boxed.split('\n').filter((l) => l.includes(' · ')).length === 4, boxed);
const empty = capture(() => history(ROOT, { task: TASK, participant: WORKER }));
check('--participant: an address that did not fetch the mailbox has empty history — the filter works both ways',
  empty.includes('history is empty'), empty);

const limited = capture(() => history(ROOT, { limit: '2' }));
const tail = limited.split('\n').filter((l) => l.includes(' · '));
check('--limit: the tail is returned — last entries, not first',
  tail.length === 2 && tail[1].includes('СОСЕДКА'), limited);
check('--limit: truncated output says older ones exist',
  /older ones exist/.test(limited), limited);
check('--all: full output does not talk about older ones',
  !/older ones exist/.test(capture(() => history(ROOT, { all: true }))), 'all');

// --- refusals ------------------------------------------------------------------

const both = expectFail(() => history(ROOT, { all: true, limit: '3' }));
check('--all and --limit together — a refusal, not a silent pick of one of the two',
  both.failed && /--all and --limit together are not accepted/.test(both.out), both.out);
for (const bad of ['0', '-1', 'abc', '2.5']) {
  const r = expectFail(() => history(ROOT, { limit: bad }));
  check(`--limit "${bad}" — refusal with the value itself in the text`,
    r.failed && r.out.includes(`"${bad}"`), r.out);
}
const ghost = expectFail(() => history(ROOT, { task: 'net-takoy' }));
check('unknown task — the refusal lists the known ones, rather than returning emptiness',
  ghost.failed && /task "net-takoy" is not in the journal/.test(ghost.out) && ghost.out.includes(TASK),
  ghost.out);
const badAddr = expectFail(() => history(ROOT, { participant: 'boss' }));
check('invalid participant address — refusal by address grammar, not an empty page',
  badAddr.failed && /worker:<slug>/.test(badAddr.out), badAddr.out);
