// Production admission control flow, with controlled observation barriers and no native process.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { check } from './check.mjs';

const source = readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8');
const start = source.indexOf('    const authorizeCurrent =');
const authorization = source.slice(start, source.indexOf('    const authenticateClient =', start));
class HttpFailure extends Error { constructor(status, message) { super(message); this.status = status; } }
for (const scenario of ['busy dead', 'cached alive but dead', 'unknown', 'revision drift', 'sustained revision drift',
  'participant swap between attempts', 'revoked during observation', 'revision drift before write', 'participant drift before write',
  'owner claim during operation', 'fresh alive twice']) {
  const participant = { address: 'reporter', harness: 'codex', metadata: { sessionRef: 'native-one', sessionId: 'native-one' } };
  const grant = { id: 'owned', lifetime: { kind: 'managed', record: '/owned/launch', launchId: 'one' } };
  let revision = 1, liveParticipant = participant, validGrant = true, observations = 0, processChecks = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const state = scenario.includes('dead') ? 'dead' : scenario === 'unknown' ? 'unknown' : 'alive';
  const dependencies = {
    HttpFailure, isDeepStrictEqual, paths: { home: '/owned' },
    currentGrant: value => { if (!validGrant) throw new HttpFailure(401, 'Client binding is absent or expired'); return value; },
    requireProcessLifetime: async () => {
      processChecks += 1;
      if (scenario === 'participant swap between attempts' && processChecks === 2) {
        liveParticipant = { ...participant, metadata: { ...participant.metadata, sessionId: 'swapped' } };
      }
    },
    // This extracted unit controls the observation/revision fence; real native admission is covered by service fixtures.
    requireManagedNativeBinding: async () => {}, standaloneExpired: () => false, host: {},
    requireLifetime: (_grant, _home, observe) => {
      if (observe.managed(grant, participant) === 'dead') throw new HttpFailure(401, 'Client lifetime is already expired or replaced');
    },
    managedState: { managed: () => scenario === 'cached alive but dead' ? 'alive' : 'unknown' },
    unavailableObservations: { managed: () => 'unknown' },
    managedParticipant: () => liveParticipant,
    sessionIdOf: participant => participant.metadata.sessionId,
    recordVersion: file => ({ file, version: revision }),
    sameRecordVersion: proof => proof.version === revision,
    participantSession: (_participant, snapshot) => snapshot,
    warden: { observe: async () => {
      observations += 1; await held;
      if (scenario === 'sustained revision drift') revision += 1;
      return state;
    } },
  };
  const authorize = new Function(...Object.keys(dependencies), `${authorization}; return authorizeGrant;`)(...Object.values(dependencies));
  let completed = false, error, fence;
  const pending = authorize(grant, 'body').then(value => { completed = true; fence = value; }, caught => { completed = true; error = caught; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const withheld = !completed;
  if (scenario === 'revision drift' || scenario === 'participant swap between attempts') revision += 1;
  if (scenario === 'revoked during observation') validGrant = false;
  release(); await pending;
  if (scenario === 'revision drift before write') revision += 1;
  if (scenario === 'participant drift before write') liveParticipant = { ...participant, metadata: { sessionId: 'replaced' } };
  if (scenario === 'owner claim during operation') liveParticipant = { ...participant, metadata: { ...participant.metadata, owner: 'new-owning-session' } };
  if (typeof fence === 'function') { try { fence(); } catch (caught) { error = caught; } }
  if (scenario === 'fresh alive twice') { const next = await authorize(grant, 'body'); if (typeof next === 'function') next(); }
  const expected = scenario.includes('dead') || scenario === 'revoked during observation' ? 401
    : scenario === 'unknown' ? 503 : scenario !== 'revision drift' && (scenario.includes('drift') || scenario.includes('swap')) ? 409 : null;
  const stage = { 'sustained revision drift': ' [stage: exhausted 3]', 'revision drift before write': ' [stage: returned fence: body]',
    'participant drift before write': ' [stage: returned fence: body: participant identity]' }[scenario];
  const expectedMessage = stage ? `Managed lifetime changed after observation; retry with current owner proof${stage}`
    : scenario === 'participant swap between attempts' ? 'Managed participant identity changed during authorization' : null;
  const expectedObservations = { 'fresh alive twice': 2, 'revision drift': 2, 'sustained revision drift': 3 }[scenario] ?? 1;
  check(`operation authority: ${scenario} uses fresh proof and fences the same grant/record/participant`, withheld
    && (expected ? error?.status === expected : !error && typeof fence === 'function')
    && (expectedMessage === null || error?.message === expectedMessage)
    && observations === expectedObservations,
  JSON.stringify({ withheld, observations, status: error?.status, error: error?.message, fence: typeof fence }));
}
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
