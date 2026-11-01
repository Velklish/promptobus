// Production admission control flow, with controlled observation barriers and no native process.
import { readFileSync } from 'node:fs';
import * as module from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { check } from './check.mjs';

const source = module.stripTypeScriptTypes
  ? module.stripTypeScriptTypes(readFileSync(new URL('../lib/service.ts', import.meta.url), 'utf8'), { mode: 'transform' })
  : readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8');
const start = source.indexOf('    const authorizeCurrent =');
const authorization = source.slice(start, source.indexOf('    const authenticateClient =', start));
class HttpFailure extends Error { constructor(status, message) { super(message); this.status = status; } }
for (const scenario of ['busy dead', 'cached alive but dead', 'unknown', 'revision drift', 'revoked during observation',
  'revision drift before write', 'participant drift before write', 'owner claim during operation', 'fresh alive twice']) {
  const participant = { address: 'reporter', harness: 'codex', metadata: { sessionRef: 'native-one', sessionId: 'native-one' } };
  const grant = { id: 'owned', lifetime: { kind: 'managed', record: '/owned/launch', launchId: 'one' } };
  let revision = 1, liveParticipant = participant, validGrant = true, observations = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const state = scenario.includes('dead') ? 'dead' : scenario === 'unknown' ? 'unknown' : 'alive';
  const dependencies = {
    HttpFailure, isDeepStrictEqual, paths: { home: '/owned' },
    currentGrant: value => { if (!validGrant) throw new HttpFailure(401, 'Client binding is absent or expired'); return value; },
    requireProcessLifetime: async () => {},
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
    warden: { observe: async () => { observations += 1; await held; return state; } },
  };
  const authorize = new Function(...Object.keys(dependencies), `${authorization}; return authorizeGrant;`)(...Object.values(dependencies));
  let completed = false, error, fence;
  const pending = authorize(grant).then(value => { completed = true; fence = value; }, caught => { completed = true; error = caught; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const withheld = !completed;
  if (scenario === 'revision drift') revision += 1;
  if (scenario === 'revoked during observation') validGrant = false;
  release(); await pending;
  if (scenario === 'revision drift before write') revision += 1;
  if (scenario === 'participant drift before write') liveParticipant = { ...participant, metadata: { sessionId: 'replaced' } };
  if (scenario === 'owner claim during operation') liveParticipant = { ...participant, metadata: { ...participant.metadata, owner: 'new-owning-session' } };
  if (typeof fence === 'function') { try { fence(); } catch (caught) { error = caught; } }
  if (scenario === 'fresh alive twice') { const next = await authorize(grant); if (typeof next === 'function') next(); }
  const expected = scenario.includes('dead') || scenario === 'revoked during observation' ? 401
    : scenario === 'unknown' ? 503 : scenario.includes('drift') ? 409 : null;
  check(`operation authority: ${scenario} uses fresh proof and fences the same grant/record/participant`, withheld
    && (expected ? error?.status === expected : !error && typeof fence === 'function')
    && observations === (scenario === 'fresh alive twice' ? 2 : 1),
  JSON.stringify({ withheld, observations, status: error?.status, error: error?.message, fence: typeof fence }));
}
check('managed HTTP docs distinguish retained status from fresh operation authority and partial receipts',
  readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8').includes('Status observations do not authorize operations.')
  && readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8').includes('A later refusal may follow a partial effect:'));
