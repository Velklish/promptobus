import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';
import { reviewerFiles } from '../lib/reviewer-files.js';

for (const tool of ['read_file', 'search_text']) {
  test(`${tool} cannot read outside bytes after a concurrent symlink replacement`, async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-file-swap-')));
    const repo = path.join(directory, 'repo');
    fs.mkdirSync(repo);
    const file = path.join(repo, 'source.txt');
    const outside = path.join(directory, 'outside.txt');
    fs.writeFileSync(file, 'INSIDE_ONLY\n');
    fs.writeFileSync(outside, 'OUTSIDE_ROOT\n');
    const read = reviewerFiles([repo]);
    const gate = new SharedArrayBuffer(8);
    const state = new Int32Array(gate);
    let workerError;
    const worker = new Worker(`
      const fs = require('node:fs');
      const { workerData } = require('node:worker_threads');
      const state = new Int32Array(workerData.gate);
      if (Atomics.wait(state, 0, 0, 5000) === 'timed-out') throw new Error('read boundary was not reached');
      fs.unlinkSync(workerData.file);
      fs.symlinkSync(workerData.outside, workerData.file);
      Atomics.store(state, 1, 1);
      Atomics.notify(state, 1);
    `, { eval: true, workerData: { gate, file, outside } });
    worker.on('error', (error) => { workerError = error; });
    const original = fs.readFileSync;
    let barrierReached = false;
    fs.readFileSync = (target, ...args) => {
      if (!barrierReached && (target === file || typeof target === 'number')) {
        barrierReached = true;
        Atomics.store(state, 0, 1);
        Atomics.notify(state, 0);
        if (Atomics.wait(state, 1, 0, 5000) === 'timed-out') throw new Error('worker did not replace source');
      }
      return original(target, ...args);
    };
    syncBuiltinESMExports();
    try {
      let result;
      let refusal;
      try { result = read(tool, { path: file, query: '_' }); }
      catch (error) { refusal = error; }
      assert.equal(barrierReached, true, 'test must reach the actual read boundary');
      assert.equal(Atomics.load(state, 1), 1, 'worker must complete the concurrent replacement');
      assert.equal(fs.realpathSync(file), outside);
      if (result) {
        const lines = tool === 'read_file' ? result.lines : result.matches;
        assert.equal(lines.some((line) => line.text.includes('OUTSIDE_ROOT')), false,
          `${tool} returned outside-root bytes after a concurrent source-to-symlink replacement`);
        assert.equal(lines.some((line) => line.text === 'INSIDE_ONLY'), true);
      } else {
        assert.match(refusal?.message ?? '', /outside the declared review roots|File changed|ELOOP/);
      }
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
      await worker.terminate();
      fs.rmSync(directory, { recursive: true, force: true });
    }
    assert.equal(workerError, undefined);
  });
}
