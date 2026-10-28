// Regression probe for the live-script PATH boundary. Run: npm test
//
// An import is refused by the entry guard. This file reads source and exercises
// resolveToolBin: a direct `node scripts/live-*.mjs` remains the live route.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, resolveToolBin, stubCommand, withStubPath } from './sandbox.mjs';
import { cursorDriver } from '../lib/driver-cursor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const liveE2e = readFileSync(path.join(here, '..', 'scripts', 'live-e2e.mjs'), 'utf8');
const liveCanary = readFileSync(path.join(here, '..', 'scripts', 'live-canary.mjs'), 'utf8');
const tool = resolveToolBin('node');

check('sandbox resolver returns a PATH name, not an install path',
  tool.ok && tool.path === 'node' && path.dirname(tool.path) === '.', JSON.stringify(tool));
check('live-e2e does not prepend the resolver result to PATH',
  !/(?:\bbinDir\b|process\.env\.PATH\s*=)/.test(liveE2e) && !/local\/bin/.test(liveE2e), liveE2e);
check('live-canary does not prepend the resolver result to PATH',
  !/(?:\bclaudeBin\b|\bbinDir\b|process\.env\.PATH\s*=)/.test(liveCanary) && !/local\/bin/.test(liveCanary), liveCanary);

const liveCursor = readFileSync(path.join(here, '..', 'scripts', 'live-cursor.mjs'), 'utf8');
const selection = liveCursor.match(/^const tool = .+;$/m)?.[0] ?? '';
const bin = path.join(makeSandbox('promptobus-promptobus-live-cursor-'), 'bin');
stubCommand(bin, 'cursor', "console.log('editor-fixture');");
stubCommand(bin, 'cursor-agent', "console.log('native-fixture');");
const restorePath = withStubPath(bin, { only: true });
try {
  check('live-cursor selection fixture has both editor and native executables',
    resolveToolBin('cursor').version === 'editor-fixture'
    && resolveToolBin('cursor-agent').version === 'native-fixture');
  const selected = new Function('resolveToolBin', 'cursorDriver', 'guarded', `${selection}\nreturn tool;`)(resolveToolBin, cursorDriver, { stub: false });
  check('live-cursor preflight selects the native agent when the editor is also on PATH',
    selected.ok && selected.path === 'cursor-agent' && selected.version === 'native-fixture', JSON.stringify(selected));
} finally {
  restorePath();
}
