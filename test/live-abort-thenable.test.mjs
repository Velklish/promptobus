import { check } from './check.mjs';
import { onAbort, exitCodeOf } from '../scripts/live-abort.mjs';
import { readFileSync } from 'node:fs';

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
function fixture(cleanup, waitMs = 100) {
  const handlers = new Map(), exits = [], diagnostics = [];
  onAbort(cleanup, { on: (sig, fn) => handlers.set(sig, fn),
    exit: (code) => exits.push(code), say: (line) => diagnostics.push(line), waitMs });
  let escaped = null;
  try { handlers.get('SIGTERM')(); } catch (error) { escaped = error.message; }
  handlers.get('SIGINT')();
  return { exits, diagnostics, escaped };
}

for (const kind of ['getter', 'invocation']) {
  const value = kind === 'getter'
    ? { get then() { throw new Error('then getter fault'); } }
    : { then() { throw new Error('then invocation fault'); } };
  const run = fixture(() => value);
  await settle();
  check(`thenable: a throwing ${kind} is diagnosed once and keeps the first signal code`,
    run.escaped === null && run.exits.join(',') === String(exitCodeOf('SIGTERM'))
    && run.diagnostics.length === 1 && run.diagnostics[0].includes(`then ${kind} fault`), JSON.stringify(run));
}

for (const value of [null, 0, false, undefined, '']) {
  for (const kind of ['cleanup', 'getter', 'invocation']) {
    const run = fixture(() => {
      if (kind === 'cleanup') throw value;
      return kind === 'getter' ? { get then() { throw value; } } : { then() { throw value; } };
    });
    await settle();
    check(`thenable: falsy ${String(value) || 'empty string'} thrown by ${kind} is diagnosed once with the first signal code`,
      run.escaped === null && run.exits.join(',') === String(exitCodeOf('SIGTERM'))
      && run.diagnostics.length === 1
      && run.diagnostics[0] === `✖ cleanup after SIGTERM broke off: ${value}\n`, JSON.stringify(run));
  }
}

let release;
const pending = new Promise((resolve) => { release = resolve; });
const adopted = fixture(() => ({ then(resolve, reject) { resolve(pending); reject(new Error('late rejection')); } }));
await settle();
check('thenable: resolving to a pending promise holds the exit until the adopted promise ends',
  adopted.exits.length === 0 && adopted.diagnostics.length === 0, JSON.stringify(adopted));
release();
await settle();
check('thenable: adopted completion exits once with the original signal despite a second settlement',
  adopted.exits.join(',') === String(exitCodeOf('SIGTERM')) && adopted.diagnostics.length === 0, JSON.stringify(adopted));

let releaseLate;
const overdue = fixture(() => ({ then(resolve) { releaseLate = resolve; } }), 20);
await new Promise((resolve) => setTimeout(resolve, 50));
releaseLate();
await settle();
check('thenable: timeout and late settlement keep one exit and the original signal code',
  overdue.exits.join(',') === String(exitCodeOf('SIGTERM')) && overdue.diagnostics.length === 1
  && overdue.diagnostics[0].includes('did not end in 20 ms'), JSON.stringify(overdue));

check('thenable docs: the guide states adoption, fault handling and the first signal code',
  readFileSync(new URL('../docs/guides/contributing.md', import.meta.url), 'utf8')
    .includes('A throwing `then` getter or invocation is diagnosed, and a timeout or repeated settlement preserves the first signal code and one exit.'));
