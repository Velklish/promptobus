// The cached status observations still use their generated-source fixture.
import { readFileSync } from 'node:fs';
import { check } from './check.mjs';
import './service-mcp-request-fixture.mjs';

const source = readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8');
const cacheStart = source.indexOf('    const cachedObservation =');
const cache = source.slice(cacheStart, source.indexOf('    const requireProcessLifetime =', cacheStart));
const flush = () => new Promise(resolve => setImmediate(resolve));
const observeLifetimes = (verdict, overrides = {}) => {
  let clock = 0, loads = 0;
  const observed = new Map(), dependencies = {
    observed, TICK_MS: 1000, pendingObservations: new Set(), Date: { now: () => clock },
    processStateAsync: async () => { loads += 1; return verdict(); },
    recordVersion: file => ({ file, version: 1 }), sameRecordVersion: () => true, managedParticipant: () => ({}), paths: { home: '/owned' },
    participantSession: (_participant, snapshot) => snapshot, warden: { observe: async () => { loads += 1; return verdict(); } }, ...overrides,
  };
  const managedState = new Function(...Object.keys(dependencies), `${cache}; return managedState;`)(...Object.values(dependencies));
  const tick = async (observe, grant) => {
    const state = observe(grant);
    clock += 1; await flush();
    return state;
  };
  return { managedState, observed, tick, loads: () => loads, advance: ms => { clock += ms; } };
};
const processGrant = (pid, birth) => ({ id: 'owned-process', lifetime: { kind: 'process', process: { pid, birth } } });
const aliasedTicks = async (verdict, grants, observe = 'process') => {
  const fixture = observeLifetimes(verdict), states = [];
  for (const grant of grants) {
    const run = target => observe === 'process' ? fixture.managedState.process(target) : fixture.managedState.managed(target, {});
    states.push(await fixture.tick(run, grant));
    fixture.advance(1001);
  }
  return { states, loads: fixture.loads() };
};
const dead = processGrant(4242, 'v2:linux:boot:ns:100');
const deadTicks = await aliasedTicks(() => 'dead', [dead, dead, dead, dead, dead]);
check('a completed dead observation of one exact process identity is not lost to tick and cache aliasing',
  deadTicks.states[0] === 'unknown' && deadTicks.states.slice(1).every(state => state === 'dead') && deadTicks.loads === 1, JSON.stringify(deadTicks));
const aliveTicks = await aliasedTicks(() => 'alive', [dead, dead, dead]);
check('an alive process observation keeps its cache lifetime and is observed again after it expires',
  aliveTicks.states.every(state => state === 'unknown') && aliveTicks.loads === 3, JSON.stringify(aliveTicks));
const unknownTicks = await aliasedTicks(() => 'unknown', [dead, dead, dead]);
check('an unknown process observation never becomes dead', unknownTicks.states.every(state => state === 'unknown'), JSON.stringify(unknownTicks));
let identity = 0;
const replacedTicks = await aliasedTicks(() => identity++ === 0 ? 'dead' : 'alive', [dead, dead, processGrant(4243, 'v2:linux:boot:ns:200')]);
check('a dead observation is not inherited by another pid or birth under the same client id',
  replacedTicks.states[1] === 'dead' && replacedTicks.states[2] === 'unknown' && replacedTicks.loads === 2, JSON.stringify(replacedTicks));
const managedGrant = { id: 'owned-managed', lifetime: { kind: 'managed', record: '/owned/launch' } };
const managedTicks = await aliasedTicks(() => 'dead', [managedGrant, managedGrant, managedGrant], 'managed');
check('a managed participant dead observation keeps its cache lifetime instead of becoming terminal',
  managedTicks.states.every(state => state === 'unknown') && managedTicks.loads === 3, JSON.stringify(managedTicks));
check('managed HTTP docs distinguish retained status from fresh operation authority and partial receipts',
  readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8').includes('Status observations do not authorize operations.')
  && readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8').includes('A later refusal may follow a partial effect:'));
