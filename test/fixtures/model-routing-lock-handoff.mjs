import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const [cacheFile, lock, harness, scenario] = process.argv.slice(2);
const dir = path.dirname(cacheFile);
const { statSync, renameSync } = fs;
const signal = (name) => fs.writeFileSync(path.join(dir, name), '');
const pause = new Int32Array(new SharedArrayBuffer(4));
function wait(name) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, name))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${name}`);
    Atomics.wait(pause, 0, 0, 5);
  }
}

if (scenario === 'stale') {
  // Both waiters retain the same old stat. Gamma gets to act on it only after beta
  // reaches rename with its replacement lock, or refuses without taking a lock.
  let observed = false;
  fs.statSync = (file, ...options) => {
    const snapshot = statSync(file, ...options);
    if (file !== lock || observed) return snapshot;
    observed = true;
    signal(`${harness}-saw-stale`);
    wait(harness === 'beta' ? 'gamma-saw-stale' : 'beta-at-rename-or-refused');
    return snapshot;
  };
  fs.renameSync = (from, to) => {
    if (to === cacheFile && harness === 'beta') {
      signal('beta-at-rename-or-refused');
      wait('gamma-finished');
    }
    return renameSync(from, to);
  };
} else if (harness === 'beta') {
  wait('alpha-released');
  fs.renameSync = (from, to) => {
    if (to === cacheFile) {
      signal('beta-merging');
      wait('beta-can-rename');
    }
    return renameSync(from, to);
  };
} else {
  let released = false;
  fs.statSync = (file, ...options) => {
    if (file !== lock) return statSync(file, ...options);
    if (released) {
      const held = statSync(file, ...options);
      signal('beta-can-rename');
      return held;
    }
    released = true;
    fs.rmSync(lock);
    try {
      return statSync(file, ...options);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      signal('alpha-released');
      wait('beta-merging');
      throw error;
    }
  };
  fs.renameSync = (from, to) => {
    const result = renameSync(from, to);
    if (to === cacheFile) signal('beta-can-rename');
    return result;
  };
}
syncBuiltinESMExports();

const { preflight } = await import('../../lib/model-routing/preflight.js');
const view = await preflight({
  host: { routingPaths: () => ({ cacheFile, overlays: [] }) },
  harnesses: [harness],
  adapterFor: () => ({ probe: () => ({
    state: 'available', reason: null, message: 'lock handoff fixture',
    checkedAt: new Date().toISOString(), source: 'probe', resetAt: null,
  }) }),
});
if (view.harnesses[harness]?.state !== 'available') throw new Error('fixture probe did not return available');
if (scenario === 'stale') signal(harness === 'beta' ? 'beta-at-rename-or-refused' : 'gamma-finished');
