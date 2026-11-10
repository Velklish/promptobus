import '../home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { reservedSpawn } from '../../lib/live-reservation.js';
import { createHarnessRegistry } from '../../lib/harness-registry.js';
import { REGISTRY } from '../../lib/drivers.js';
import { reserveNativeParticipant } from '../../lib/native-lifecycle.js';
import { processIdentity } from '../../lib/service-state.js';
import { createStandaloneHost } from '../../dist/host-index.js';
import * as store from '../../lib/store.js';
const [root, home, task, harness, address, role, fault, attempt] = process.argv.slice(2);
const host = createStandaloneHost({ cwd: root });
host.routingPaths = () => ({ overlays: [{ id: 'test', path: path.join(root, 'overlay.json'), writable: true }] });
const env = { ...process.env, [`PROMPTOBUS_${harness.toUpperCase()}_HOME`]: path.join(root, harness) };
Object.assign(process.env, env);
const ref = address.replace(':', '-');
const registry = createHarnessRegistry({ harness });
REGISTRY.drivers[harness].inspect = r => ({ state: fs.existsSync(path.join(root, `${r}.live`)) ? 'alive' : 'gone', id: r });
const resultStem = attempt ? `${ref}-${attempt}` : ref;
const resultFile = path.join(root, `${resultStem}.result`);
const wait = async file => { while (!fs.existsSync(file)) await new Promise(r => setTimeout(r, 10)); };
fs.writeFileSync(path.join(root, `${resultStem}.ready`), 'ready');
await wait(path.join(root, 'go'));
try {
  if (fault === 'same-assignment') reserveNativeParticipant(home, task,
    store.participantRecord(address, { harness, sessionRef: ref }), null, REGISTRY);
  const driver = { id: harness, spawn: async (plan, ctx) => {
    if (fault === 'kill-before-start') {
      registry.writeSession({ ref, launchId: plan.launchId, home, task, address, launcherPid: process.pid,
        launcherProcess: processIdentity(process.pid),
        holderPid: null, appPid: null, threadId: null, state: 'starting' }, env);
      process.kill(process.pid, 'SIGKILL');
    }
    plan.liveSeat.starting();
    registry.writeSession({ ref, holderPid: process.pid, threadId: ref, sessionId: ref, sessionName: ref, state: 'alive' }, env);
    fs.writeFileSync(path.join(root, `${ref}.live`), 'synthetic');
    ctx.persist(ref, 'alive', ref);
    fs.writeFileSync(resultFile, JSON.stringify({ launched: true }));
    await wait(path.join(root, 'release'));
    return { output: '', session: ref, seen: { state: 'alive' } };
  } };
  await reservedSpawn(driver, { argv: [], files: [], mcpConfig: null, settings: null, launchId: 'synthetic-launch' }, {
    host, home, task, address, ref, role, cwd: root, env, tool: { ok: true, bin: 'synthetic-only' },
    persist: (id, state, full) => {
      if (fault === 'kill-before-link') process.kill(process.pid, 'SIGKILL');
      return store.upsertParticipant(home, task, store.participantRecord(address, {
        harness, mode: 'managed', sessionRef: ref, sessionId: full, childTask: role === 'teamlead' ? 'synthetic-child' : undefined,
      }));
    },
  });
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({ launched: false, error: error.message }));
}
