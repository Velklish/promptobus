import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const [cacheFile, lock, harness] = process.argv.slice(2);
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

if (harness === 'beta') {
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
await preflight({
  host: { routingPaths: () => ({ cacheFile, overlays: [] }) },
  harnesses: [harness],
  adapterFor: () => ({ probe: () => ({
    state: 'available', reason: null, message: 'lock handoff fixture',
    checkedAt: new Date().toISOString(), source: 'probe', resetAt: null,
  }) }),
});
