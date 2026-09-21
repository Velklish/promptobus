// The Codex app-server fixtures are a citation of somebody else's protocol, and a citation is
// worth its version tag: the directory is named off `PROVEN_CODEX_VERSION`, so bumping the
// constant without regenerating the schemas fails here instead of validating a dead protocol.
// Run: npm test
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'fixtures', 'codex-app-server', PROVEN_CODEX_VERSION);

check('PB-242: the fixture directory is the one the proven version names',
  existsSync(dir),
  `${dir} is missing — regenerate: codex app-server generate-json-schema --out ${dir}`);

// The harness compiles this one at import time; the rest are read by name as the trace needs
// them. Missing here means a green suite asserting nothing about the server's requests.
const required = ['ServerRequest.json'];
const present = existsSync(dir) ? new Set(readdirSync(dir)) : new Set();
const missing = required.filter((name) => !present.has(name));
check('PB-242: the schemas the harness compiles are in it',
  missing.length === 0,
  missing.join(', ') || `${present.size} files`);

// The literal the directory used to be spelled with must not come back: two spellings of one
// version is exactly the drift this file exists to stop.
const harnessSource = readFileSync(path.join(here, 'harness-codex.mjs'), 'utf8');
check('PB-242: the harness names the directory off the constant',
  /'codex-app-server', PROVEN_CODEX_VERSION/.test(harnessSource)
    && !/'codex-app-server', '\d/.test(harnessSource),
  'harness-codex.mjs still spells a version literal');
