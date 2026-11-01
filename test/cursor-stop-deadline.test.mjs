// Controlled time at the production Stop boundaries; actual delayed-stub checks run separately.
import { readFileSync } from 'node:fs';
import * as module from 'node:module';
import { check } from './check.mjs';

const compiled = module.stripTypeScriptTypes
  ? module.stripTypeScriptTypes(readFileSync(new URL('../lib/cursor-persist.ts', import.meta.url), 'utf8'), { mode: 'transform' })
  : readFileSync(new URL('../lib/cursor-persist.js', import.meta.url), 'utf8');
const stopSource = compiled.slice(compiled.indexOf('export async function stopSession')).replace('export ', '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const boundary of ['zero', 'preflight exhausted', 'native refusal exhausted', 'early native refusal', 'fallback timeout',
  'post-native observation exhausted', 'pre-fallback observation exhausted']) {
  let now = 0, reads = 0, present = true, synchronousReads = 0;
  const commands = [], native = { name: 'owned', chatId: 'chat', panePid: 123, hash: 'hash' };
  const dependencies = {
    process, Date: { now: () => now }, STOP_TIMEOUT_MS: 10, STOP_STEP_MS: 1, CURSOR_TMUX_SERVER: 'fixture',
    sessionMarker: () => 'owned', readTmuxSessionsAsync: async () => {
      reads += 1;
      if (boundary === 'preflight exhausted' && reads === 2) now = 20;
      if (boundary === 'post-native observation exhausted' && reads === 3) now = 20;
      if (boundary === 'pre-fallback observation exhausted' && reads === 4) now = 20;
      return { sessions: present ? [native] : [], missing: null };
    },
    readTmuxSessions: () => { synchronousReads += 1; return { sessions: present ? [native] : [], missing: null }; },
    parsePsTable: () => ({ kids: new Map() }), walkKids: () => [], reapOrphans: () => [], killPids: () => [],
    TMUX_TMPDIR: '/owned', TMUX_NOT_FOUND: 'owned tmux unavailable', tmuxBin: () => 'owned-tmux',
    runAsync: async (command, _args, options) => {
      if (command === 'ps') return { status: 0, stdout: '' };
      if (command === 'owned-tmux') {
        commands.push({ kind: 'fallback', at: now, allowance: options.timeoutMs });
        if (boundary === 'fallback timeout') { now = 20; return { status: null, error: new Error('owned fallback timed out') }; }
        present = false; return { status: 0 };
      }
      commands.push({ kind: 'native', at: now, allowance: options.timeoutMs });
      if (boundary === 'native refusal exhausted') now = 20;
      return { status: 1, stdout: '', stderr: 'controlled NOACK' };
    },
    tmux: () => { commands.push({ kind: 'fallback', at: now }); present = false; },
    settle: async () => { now += 1; },
  };
  const stop = await new AsyncFunction(...Object.keys(dependencies), `${stopSource}; return stopSession;`)(...Object.values(dependencies));
  const result = await stop({ sessionName: 'owned', chatId: 'chat', panePid: 123, workspaceHash: 'hash' },
    { bin: 'agent', timeoutMs: boundary === 'zero' ? 0 : 10 });
  const passingFallback = boundary === 'early native refusal';
  check(`Cursor Stop deadline: ${boundary} never starts native or fallback work after its original allowance`,
    passingFallback ? result.stopped === true && !present && commands.length === 2 && commands.every(command => command.at < 10)
      : boundary === 'fallback timeout' ? result.stopped === false && present && /fallback/i.test(result.missing ?? '')
        && commands.length === 2 && commands.at(-1).allowance === 10
      : result.stopped === false && present && /deadline/i.test(result.missing ?? '')
        && commands.length === (['native refusal exhausted', 'post-native observation exhausted', 'pre-fallback observation exhausted'].includes(boundary) ? 1 : 0),
    JSON.stringify({ result, commands, present, now, reads }));
  if (passingFallback) check('Cursor Stop fallback receives only the remaining original allowance through awaited execution',
    commands.at(-1)?.kind === 'fallback' && commands.at(-1).allowance === 10 - commands.at(-1).at, JSON.stringify(commands));
  check(`Cursor Stop ${boundary} performs no synchronous pre-confirmation native observation`, synchronousReads === 0, String(synchronousReads));
}

check('Cursor Stop deadline docs: zero is valid without hidden observation time or unconditional forced Stop',
  readFileSync(new URL('../docs/reference/05-drivers.md', import.meta.url), 'utf8')
    .includes('There is no separate observation allowance and no unconditional forced Stop.'));
check('Cursor Stop docs bound every pre-confirmation observation and reserve reaping for confirmed absence',
  readFileSync(new URL('../docs/reference/05-drivers.md', import.meta.url), 'utf8').includes('Cursor Stop awaits every pre-confirmation tmux observation')
  && readFileSync(new URL('../docs/reference/05-drivers.md', import.meta.url), 'utf8').includes('Only confirmed native absence permits orphan/child reaping;'));

let lookupClock = 0, launched = 0;
const readerSource = compiled.slice(compiled.indexOf('export async function readTmuxSessionsAsync'), compiled.indexOf('function parseTmuxSessions')).replace('export ', '');
const readerDependencies = {
  process, CURSOR_TMUX_SERVER: 'fixture', STOP_TIMEOUT_MS: 10, TMUX_TMPDIR: '/owned', TMUX_NOT_FOUND: 'missing',
  LIST_FIELDS: [], LIST_SEP: '|', Date: { now: () => lookupClock },
  tmuxBin: () => { lookupClock = 20; return '/owned/tmux'; },
  runAsync: async () => { launched += 1; return { status: 0 }; }, parseTmuxSessions: () => ({ sessions: [], missing: null }),
};
const reader = new Function(...Object.keys(readerDependencies), `${readerSource}; return readTmuxSessionsAsync;`)(...Object.values(readerDependencies));
const lookupResult = await reader({ timeoutMs: 10, deadlineAt: 10 });
check('native binary lookup consumes the original observation edge before any subprocess launch', launched === 0
  && lookupResult.sessions === null && /deadline/.test(lookupResult.missing ?? ''), JSON.stringify({ launched, lookupClock, lookupResult }));
