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
check('managed HTTP docs distinguish retained status from fresh operation authority and partial receipts',
  readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8').includes('Status observations do not authorize operations.')
  && readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8').includes('A later refusal may follow a partial effect:'));
