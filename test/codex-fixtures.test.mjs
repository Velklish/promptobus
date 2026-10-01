// The Codex app-server fixtures are a citation of somebody else's protocol, and a citation is
// worth its version tag: the directory is named off `PROVEN_CODEX_VERSION`, so bumping the
// constant without regenerating the schemas fails here instead of validating a dead protocol.
// Run: npm test
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import Ajv from 'ajv';
import { MIN_CODEX_VERSION, PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';

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

const samples = {
  InitializeParams: { clientInfo: { name: 'promptobus', version: '0.21.0' }, capabilities: { experimentalApi: true } },
  ThreadStartParams: { cwd: '/fixture/root', sandbox: 'workspace-write', approvalPolicy: 'on-request',
    model: 'gpt-6-astra', runtimeWorkspaceRoots: ['/fixture/rules'],
    config: { 'features.hooks': false, 'skills.config': [{ path: '/fixture/personal/SKILL.md', enabled: false }] } },
  ThreadResumeParams: { threadId: 'fixture-thread', cwd: '/fixture/root', sandbox: 'workspace-write',
    approvalPolicy: 'on-request', model: 'gpt-6-astra', excludeTurns: true,
    config: { 'features.hooks': false, 'skills.config': [{ path: '/fixture/personal/SKILL.md', enabled: false }] } },
  SkillsListParams: { cwds: ['/fixture/root'], forceReload: true },
  TurnStartParams: { threadId: 'fixture-thread', input: [{ type: 'text', text: 'Read mailbox' }], effort: 'low' },
  TurnSteerParams: { threadId: 'fixture-thread', expectedTurnId: 'fixture-turn', input: [{ type: 'text', text: 'Mail arrived' }] },
  ThreadReadParams: { threadId: 'fixture-thread', includeTurns: true },
  ThreadInjectItemsParams: { threadId: 'fixture-thread', items: [{ type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'Original authorized assignment' }] }] },
};
for (const version of [MIN_CODEX_VERSION, PROVEN_CODEX_VERSION]) {
  const base = path.join(here, 'fixtures', 'codex-app-server', version);
  check(`Codex ${version} has a full client/server protocol capture`,
    existsSync(path.join(base, 'ClientRequest.json')) && existsSync(path.join(base, 'ServerRequest.json')));
  const ajv = new Ajv({ strict: false, allErrors: true, formats: { int64: true, uint64: true, uint32: true, uint: true, double: true } });
  for (const [name, sample] of Object.entries(samples)) {
    const schema = JSON.parse(readFileSync(path.join(base, name === 'InitializeParams' ? 'v1' : 'v2', `${name}.json`), 'utf8'));
    const validate = ajv.compile(schema);
    check(`Codex ${version} accepts the holder ${name} shape`, validate(sample), ajv.errorsText(validate.errors));
  }
}
