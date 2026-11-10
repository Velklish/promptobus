import './home.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check } from './check.mjs';
import { participantCodexHome, sweepParticipantHomes } from '../lib/driver-codex.js';
import { createHarnessRegistry } from '../lib/harness-registry.js';

const root = fs.mkdtempSync(path.join(tmpdir(), 'promptobus-codex-registry-observation-'));
const registry = createHarnessRegistry({ harness: 'codex' });
const savedRead = fs.readFileSync, savedList = fs.readdirSync;
let serial = 0;
function fixture() {
  const env = { PROMPTOBUS_CODEX_HOME: path.join(root, String(++serial)) };
  const live = participantCodexHome({ task: 'synthetic', address: 'worker:live' }, env);
  const orphan = participantCodexHome({ task: 'synthetic', address: 'worker:orphan' }, env);
  for (const dir of [live, orphan]) fs.mkdirSync(dir, { recursive: true });
  registry.writeSession({ ref: 'synthetic-live', codexHome: live }, env);
  return { env, live, orphan };
}
function retained(f) {
  let swept, error;
  const warnings = [], warn = console.warn;
  console.warn = message => warnings.push(String(message));
  try { swept = sweepParticipantHomes(f.env); } catch (e) { error = e.message; }
  finally { console.warn = warn; }
  return { ok: fs.existsSync(f.live) && fs.existsSync(f.orphan) && !swept?.length
    && warnings.some(w => w.includes('incomplete')), swept, error, warnings };
}
try {
  const complete = fixture();
  const swept = sweepParticipantHomes(complete.env);
  check('complete Codex registry preserves live homes and removes synthetic orphans',
    fs.existsSync(complete.live) && !fs.existsSync(complete.orphan) && swept.includes(complete.orphan));
  for (const [label, content] of [['corrupt JSON', '{'], ['malformed record', '{}'], ['missing home', '{"ref":"synthetic-live"}']]) {
    const f = fixture();
    fs.writeFileSync(registry.sessionFile('synthetic-live', f.env), content);
    const result = retained(f);
    check(`${label} Codex registry retains every participant home`, result.ok, JSON.stringify(result));
  }
  for (const scope of ['directory', 'record']) {
    const f = fixture();
    const target = scope === 'directory' ? registry.sessionsDir(f.env) : registry.sessionFile('synthetic-live', f.env);
    const key = scope === 'directory' ? 'readdirSync' : 'readFileSync';
    const original = fs[key];
    fs[key] = (file, ...args) => {
      if (String(file) === target) throw Object.assign(new Error('synthetic access denied'), { code: 'EACCES' });
      return original(file, ...args);
    };
    syncBuiltinESMExports();
    const result = retained(f);
    fs[key] = original;
    syncBuiltinESMExports();
    check(`unreadable Codex registry ${scope} retains every participant home`, result.ok, JSON.stringify(result));
  }
  const absent = fixture();
  fs.rmSync(registry.sessionsDir(absent.env), { recursive: true });
  const absentSweep = sweepParticipantHomes(absent.env);
  check('absent Codex registry keeps the established empty-state orphan sweep',
    absentSweep.length === 2 && !fs.existsSync(absent.live) && !fs.existsSync(absent.orphan));
} finally {
  fs.readFileSync = savedRead;
  fs.readdirSync = savedList;
  syncBuiltinESMExports();
  for (let n = 1; n <= serial; n++) {
    const env = { PROMPTOBUS_CODEX_HOME: path.join(root, String(n)) };
    for (const address of ['worker:live', 'worker:orphan'])
      fs.rmSync(participantCodexHome({ task: 'synthetic', address }, env), { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
}
