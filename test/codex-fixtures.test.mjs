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
import { holderParams } from './codex-contract-witnesses.mjs';
import { MIN_CODEX_VERSION, PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';
import { approvalReply } from '../lib/codex-session.js';

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

for (const version of new Set([MIN_CODEX_VERSION, '0.159.2', '0.160.0', '0.162.1', '0.163.0', PROVEN_CODEX_VERSION])) {
  const base = path.join(here, 'fixtures', 'codex-app-server', version);
  check(`Codex ${version} has a full client/server protocol capture`,
    existsSync(path.join(base, 'ClientRequest.json')) && existsSync(path.join(base, 'ServerRequest.json')));
  const ajv = new Ajv({ strict: false, allErrors: true, formats: { int64: true, uint64: true, uint32: true, uint: true, double: true } });
  for (const [name, sample] of Object.entries(holderParams)) {
    const schema = JSON.parse(readFileSync(path.join(base, name === 'InitializeParams' ? 'v1' : 'v2', `${name}.json`), 'utf8'));
    const validate = ajv.compile(schema);
    check(`Codex ${version} accepts the holder ${name} shape`, validate(sample), ajv.errorsText(validate.errors));
  }
}

const provenance = JSON.parse(readFileSync(path.join(dir, 'capture-provenance.json'), 'utf8'));
check('installed Codex schema baseline is bound to its measured capture',
  PROVEN_CODEX_VERSION === provenance.version && provenance.build === '0.164.0'
  && provenance.versionCommand.stdout === `codex-cli ${provenance.build}\n`
  && provenance.generation.exitCode === 0 && /^[a-f0-9]{64}$/.test(provenance.binary.sha256));
const generated = Object.keys(provenance.inventory);
const captureDir = path.join(here, 'fixtures/codex-app-server', provenance.version);
const actual = readdirSync(captureDir, { recursive: true }).filter(name => name.endsWith('.json')
  && JSON.parse(readFileSync(path.join(captureDir, name), 'utf8')).$schema).sort();
check('captured schema inventory is complete and matches its recorded hashes',
  generated.length === 320 && JSON.stringify(actual) === JSON.stringify(generated)
  && generated.every(name => {
    const data = readFileSync(path.join(captureDir, name));
    return provenance.inventory[name].bytes === data.length
      && createHash('sha256').update(data).digest('hex') === provenance.inventory[name].sha256;
  }));
const previousDir = path.join(here, 'fixtures/codex-app-server/0.160.0');
const previous = JSON.parse(readFileSync(path.join(previousDir, 'capture-provenance.json'), 'utf8'));
const oldNames = Object.keys(previous.inventory);
const priorDir = path.join(here, 'fixtures/codex-app-server/0.163.0');
const prior = JSON.parse(readFileSync(path.join(priorDir, 'capture-provenance.json'), 'utf8'));
const priorNames = Object.keys(prior.inventory);
const added = generated.filter(name => !priorNames.includes(name));
const removed = priorNames.filter(name => !generated.includes(name));
const changed = generated.filter(name => priorNames.includes(name)
  && !readFileSync(path.join(captureDir, name)).equals(readFileSync(path.join(priorDir, name))));
check('current capture retains the measured delta from the full historical capture',
  added.length === 2 && removed.length === 0 && changed.length === 31
  && provenance.comparison.previousVersion === '0.163.0'
  && JSON.stringify([added, removed, changed]) === JSON.stringify([
    provenance.comparison.added, provenance.comparison.removed, provenance.comparison.changed]));
function historicalCaptureUnchanged(version, expectedCount) {
  const historicalDir = path.join(here, 'fixtures/codex-app-server', version);
  const historical = JSON.parse(readFileSync(path.join(historicalDir, 'capture-provenance.json'), 'utf8'));
  const names = Object.keys(historical.inventory);
  const actualNames = readdirSync(historicalDir, { recursive: true }).filter(name => name.endsWith('.json')
    && JSON.parse(readFileSync(path.join(historicalDir, name), 'utf8')).$schema).sort();
  return names.length === expectedCount && JSON.stringify(actualNames) === JSON.stringify(names)
    && names.every(name => {
      const data = readFileSync(path.join(historicalDir, name));
      return historical.inventory[name].bytes === data.length
        && historical.inventory[name].sha256 === createHash('sha256').update(data).digest('hex');
    });
}
for (const [version, expectedCount] of [['0.162.1', 317], ['0.163.0', 318]]) {
  check(`historical ${version} capture retains its original inventory and hashes`,
    historicalCaptureUnchanged(version, expectedCount));
}
check('historical 0.160.0 capture and its byte-identical 0.159.2 comparison remain unchanged',
  oldNames.length === 314 && oldNames.every(name => {
    const data = readFileSync(path.join(previousDir, name));
    return previous.inventory[name].bytes === data.length
      && previous.inventory[name].sha256 === createHash('sha256').update(data).digest('hex')
      && data.equals(readFileSync(path.join(here, 'fixtures/codex-app-server/0.159.2', name)));
  }));
for (const name of ['ClientRequest', 'ServerRequest']) {
  const schema = JSON.parse(readFileSync(path.join(captureDir, `${name}.json`), 'utf8'));
  check(`captured ${name} retains its complete method inventory`, schema.oneOf.length === (name === 'ClientRequest' ? 106 : 10));
}
const approvals = { execCommandApproval: 'ExecCommandApproval', applyPatchApproval: 'ApplyPatchApproval',
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApproval',
  'item/fileChange/requestApproval': 'FileChangeRequestApproval',
  'item/permissions/requestApproval': 'PermissionsRequestApproval',
  'item/tool/requestUserInput': 'ToolRequestUserInput', 'mcpServer/elicitation/request': 'McpServerElicitationRequest' };
for (const version of new Set(['0.159.2', '0.160.0', '0.162.1', '0.163.0', PROVEN_CODEX_VERSION])) {
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
for (const file of ['docs/reference/05-drivers.md', 'docs/guides/contributing.md', `test/fixtures/codex-app-server/${PROVEN_CODEX_VERSION}/README.md`]) {
  const text = readFileSync(path.join(here, '..', file), 'utf8');
  check(`${file} names the current capture and keeps native evidence version-scoped`,
    text.includes(PROVEN_CODEX_VERSION) && text.includes('Native evidence is version-scoped.'));
}
const availabilityDocs = readFileSync(path.join(here, '../docs/reference/03-cli.md'), 'utf8');
const routingGuide = readFileSync(path.join(here, '../docs/guides/model-routing.md'), 'utf8');
check('Codex availability documents the measured notification duration and the remaining fallback limit',
  availabilityDocs.includes('a live worker turn produced a notification with nested `rateLimits.primary.windowDurationMins: 10080`')
  && availabilityDocs.includes('the missing-method fallback itself remains unmeasured'));
check('model routing documents the completed hidden-model turn',
  routingGuide.includes('a live `gpt-reserve` turn completed'));
