// The Codex app-server fixtures are a citation of somebody else's protocol, and a citation is
// worth its version tag: the directory is named off `PROVEN_CODEX_VERSION`, so bumping the
// constant without regenerating the schemas fails here instead of validating a dead protocol.
// Run: npm test
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import Ajv from 'ajv';
import { MIN_CODEX_VERSION, PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';
import { approvalReply, codexInitParams } from '../lib/codex-session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'fixtures', 'codex-app-server', PROVEN_CODEX_VERSION);

check('PB-242: the fixture directory is the one the proven version names',
  existsSync(dir),
  `${dir} is missing — regenerate: codex app-server generate-json-schema --out ${dir}`);

// The harness compiles this one at import time; the rest are read by name as the trace needs
// them. Missing here means a green suite asserting nothing about the server's requests.
const required = ['ClientRequest.json', 'ServerRequest.json'];
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
  InitializeParams: codexInitParams({ hostName: 'promptobus', hostVersion: '0.21.0' }, {}),
  ThreadStartParams: { cwd: '/fixture/root', sandbox: 'workspace-write', approvalPolicy: 'on-request',
    model: 'gpt-6-astra', runtimeWorkspaceRoots: ['/fixture/rules'],
    config: { 'features.hooks': false, 'skills.config': [{ path: '/fixture/personal/SKILL.md', enabled: false }] } },
  ThreadResumeParams: { threadId: 'fixture-thread', cwd: '/fixture/root', sandbox: 'workspace-write',
    approvalPolicy: 'on-request', model: 'gpt-6-astra', excludeTurns: true,
    config: { 'features.hooks': false, 'skills.config': [{ path: '/fixture/personal/SKILL.md', enabled: false }] } },
  SkillsListParams: { cwds: ['/fixture/root'], forceReload: true },
  GetAccountParams: { refreshToken: false },
  TurnStartParams: { threadId: 'fixture-thread', input: [{ type: 'text', text: 'Read mailbox' }], effort: 'low' },
  TurnSteerParams: { threadId: 'fixture-thread', expectedTurnId: 'fixture-turn', input: [{ type: 'text', text: 'Mail arrived' }] },
  ThreadReadParams: { threadId: 'fixture-thread', includeTurns: true },
  ThreadInjectItemsParams: { threadId: 'fixture-thread', items: [{ type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'Original authorized assignment' }] }] },
};
Object.assign(samples, {
  ModelListParams: { includeHidden: true },
  ThreadSetNameParams: { threadId: 'fixture-thread', name: 'Fixture participant' },
  TurnInterruptParams: { threadId: 'fixture-thread', turnId: 'fixture-turn' },
  ReviewStartParams: { threadId: 'fixture-thread', target: { type: 'uncommittedChanges' }, delivery: 'inline' },
});
for (const version of new Set([MIN_CODEX_VERSION, '0.159.2', '0.160.0', PROVEN_CODEX_VERSION])) {
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

const provenance = JSON.parse(readFileSync(path.join(here, 'fixtures/codex-app-server/0.160.0/capture-provenance.json'), 'utf8'));
check('installed Codex schema baseline is bound to its measured capture',
  PROVEN_CODEX_VERSION === provenance.version && provenance.versionCommand.stdout === `codex-cli ${provenance.version}\n`
  && provenance.generation.exitCode === 0 && /^[a-f0-9]{64}$/.test(provenance.binary.sha256));
const generated = Object.keys(provenance.inventory);
const captureDir = path.join(here, 'fixtures/codex-app-server', provenance.version);
const actual = readdirSync(captureDir, { recursive: true }).filter(name => name.endsWith('.json')
  && JSON.parse(readFileSync(path.join(captureDir, name), 'utf8')).$schema).sort();
check('captured schema inventory is complete and unchanged from the previous capture',
  generated.length === 314 && JSON.stringify(actual) === JSON.stringify(generated)
  && generated.every(name => {
    const data = readFileSync(path.join(captureDir, name));
    return provenance.inventory[name].bytes === data.length
      && createHash('sha256').update(data).digest('hex') === provenance.inventory[name].sha256
      && data.equals(readFileSync(path.join(here, 'fixtures/codex-app-server/0.159.2', name)));
  }));
for (const name of ['ClientRequest', 'ServerRequest']) {
  const schema = JSON.parse(readFileSync(path.join(captureDir, `${name}.json`), 'utf8'));
  check(`captured ${name} retains its complete method inventory`, schema.oneOf.length === (name === 'ClientRequest' ? 104 : 10));
}
const approvals = { execCommandApproval: 'ExecCommandApproval', applyPatchApproval: 'ApplyPatchApproval',
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApproval',
  'item/fileChange/requestApproval': 'FileChangeRequestApproval',
  'item/permissions/requestApproval': 'PermissionsRequestApproval',
  'item/tool/requestUserInput': 'ToolRequestUserInput', 'mcpServer/elicitation/request': 'McpServerElicitationRequest' };
for (const version of ['0.159.2', '0.160.0']) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const load = name => ajv.compile(JSON.parse(readFileSync(path.join(here, 'fixtures/codex-app-server', version, `${name}.json`), 'utf8')));
  for (const [method, schema] of Object.entries(approvals)) {
    const validate = load(`${schema}Response`);
    for (const allowed of [true, false]) {
      const reply = approvalReply(method, allowed, { questions: [{ id: 'question' }] });
      check(`Codex ${version} validates actual holder ${method} reply allowed=${allowed}`, validate(reply), ajv.errorsText(validate.errors));
    }
  }
  const interrupt = load('v2/TurnInterruptParams');
  check(`Codex ${version} rejects an interrupt without its real turn ID`, !interrupt({ threadId: 'thread' }));
  const steer = load('v2/TurnSteerResponse');
  check(`Codex ${version} rejects the malformed historical mock steer response`, !steer({ turn: { id: 'turn', status: 'inProgress' } }));
  const approval = load('CommandExecutionRequestApprovalResponse');
  check(`Codex ${version} rejects an invented approval decision`, !approval({ decision: 'allow-everything' }));
}
for (const file of ['docs/reference/05-drivers.md', 'docs/guides/contributing.md', 'test/fixtures/codex-app-server/0.160.0/README.md']) {
  const text = readFileSync(path.join(here, '..', file), 'utf8');
  check(`${file} names the current capture and its unmeasured native behavior`,
    text.includes('0.160.0') && text.replace(/\s+/g, ' ').includes(file.endsWith('README.md')
      ? 'Those were not remeasured on 0.160.0.'
      : 'Native model turns and hook behavior were not remeasured on 0.160.0.'));
}
