// The E2E loop's task identity: its own on every run, and distinct session names within one
// UTC minute. Judged by the package's own name builder. Run: npm test
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { E2E_TASK_SLUG, e2eTaskId, loopTitle, store } from './scenario.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { sessionName } = await import(path.join(here, '..', 'lib', 'spawn.js'));

const names = (at) => {
  const id = e2eTaskId(new Date(at));
  const task = { id, title: 'E2E orchestration loop', adapter: { stamp: store.stampOfId(id) } };
  const worker = sessionName(task, { slug: 'e2e', title: loopTitle(id) });
  return { id, worker, reviewer: sessionName(task, { slug: 'e2e', reviewer: true, title: loopTitle(id) }) };
};
const first = names('2026-09-06T01:31:10Z');
const sameMinute = names('2026-09-06T01:31:44Z');
const later = names('2026-09-06T03:01:10Z');
const bracket = (name) => /\(([^)]*)\)$/.exec(name)?.[1] ?? null;

check('identity: the id is the package task identity with the loop slug and a seconds stamp',
  first.id === store.newTaskIdentity(E2E_TASK_SLUG, new Date('2026-09-06T01:31:10Z')).id
  && first.id === 'e2ebus-t20260906-013110', first.id);
check('identity: control — within one UTC minute the readable stamp of the two names is the same',
  bracket(first.worker) === bracket(sameMinute.worker) && bracket(first.worker) === '0906-0131',
  `${first.worker} · ${sameMinute.worker}`);
check('identity: two runs within one UTC minute get different ids and different worker and reviewer names',
  first.id !== sameMinute.id && first.worker !== sameMinute.worker && first.reviewer !== sameMinute.reviewer,
  JSON.stringify([first, sameMinute]));
check('identity: runs hours apart differ too, and a stampless id keeps the plain title',
  later.worker !== first.worker && loopTitle('e2ebus') === 'E2E orchestration loop',
  JSON.stringify(later));
