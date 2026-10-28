import './home.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { check } from './check.mjs';
import { holderParams } from './codex-contract-witnesses.mjs';
import { MIN_CODEX_VERSION, PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';
import { approvalReply } from '../lib/codex-session.js';
import { consumedSchemaNames, readConsumedContract, validateConsumedContract } from '../scripts/codex-schema-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'fixtures', 'codex-app-server');
check('Codex contract keeps only minimum and proven versions',
  JSON.stringify(readdirSync(root).filter(version =>
    existsSync(path.join(root, version, 'contract-provenance.json'))).sort())
    === JSON.stringify([MIN_CODEX_VERSION, PROVEN_CODEX_VERSION].sort()));
const harnessSource = readFileSync(path.join(here, 'harness-codex.mjs'), 'utf8');
check('Codex harness selects the proven contract through its version constant',
  /'codex-app-server', PROVEN_CODEX_VERSION/.test(harnessSource));

const approvals = { execCommandApproval: 'ExecCommandApproval', applyPatchApproval: 'ApplyPatchApproval',
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApproval',
  'item/fileChange/requestApproval': 'FileChangeRequestApproval',
  'item/permissions/requestApproval': 'PermissionsRequestApproval',
  'item/tool/requestUserInput': 'ToolRequestUserInput', 'mcpServer/elicitation/request': 'McpServerElicitationRequest' };
for (const version of [MIN_CODEX_VERSION, PROVEN_CODEX_VERSION]) {
  const schemas = readConsumedContract(path.join(root, version), version);
  check(`Codex ${version} contract contains exactly the consumed schemas`,
    schemas.size === consumedSchemaNames.length && schemas.has('ClientRequest.json') && schemas.has('ServerRequest.json'));
  const counts = validateConsumedContract(schemas);
  check(`Codex ${version} contract preserves methods and notifications`,
    counts.requests === 16 && counts.serverRequests === 10 && counts.notifications === 4 && counts.responses === 16);
  const ajv = new Ajv({ strict: false, allErrors: true, formats: { int64: true, uint64: true, uint32: true, uint: true, double: true } });
  for (const [name, sample] of Object.entries(holderParams)) {
    const schema = schemas.get(`${name === 'InitializeParams' ? 'v1' : 'v2'}/${name}.json`);
    const validate = ajv.compile(schema);
    check(`Codex ${version} accepts holder ${name}`, validate(sample), ajv.errorsText(validate.errors));
  }
  for (const [method, name] of Object.entries(approvals)) {
    const validate = ajv.compile(schemas.get(`${name}Response.json`));
    for (const allowed of [true, false]) {
      const reply = approvalReply(method, allowed, { questions: [{ id: 'question' }] });
      check(`Codex ${version} validates holder ${method} reply allowed=${allowed}`, validate(reply), ajv.errorsText(validate.errors));
    }
  }
  check(`Codex ${version} rejects interrupt without turn ID`,
    !ajv.compile(schemas.get('v2/TurnInterruptParams.json'))({ threadId: 'thread' }));
  check(`Codex ${version} rejects malformed steer response`,
    !ajv.compile(schemas.get('v2/TurnSteerResponse.json'))({ turn: { id: 'turn', status: 'inProgress' } }));
  check(`Codex ${version} rejects invented approval decision`,
    !ajv.compile(schemas.get('CommandExecutionRequestApprovalResponse.json'))({ decision: 'allow-everything' }));
}
for (const file of ['docs/reference/05-drivers.md', 'docs/guides/contributing.md']) {
  const content = readFileSync(path.join(here, '..', file), 'utf8');
  check(`${file} names the current consumed contract and version-scoped evidence`,
    content.includes(PROVEN_CODEX_VERSION) && content.includes('Native evidence is version-scoped.'));
}
check('Codex live evidence remains outside the schema contract documents',
  existsSync(path.join(root, PROVEN_CODEX_VERSION, 'README.md')));
const availabilityDocs = readFileSync(path.join(here, '../docs/reference/03-cli.md'), 'utf8');
const routingGuide = readFileSync(path.join(here, '../docs/guides/model-routing.md'), 'utf8');
check('Codex availability documents the measured notification duration and the remaining fallback limit',
  availabilityDocs.includes('a live worker turn produced a notification with nested `rateLimits.primary.windowDurationMins: 10080`')
  && availabilityDocs.includes('the missing-method fallback itself remains unmeasured'));
check('model routing documents the completed hidden-model turn',
  routingGuide.includes('a live `gpt-reserve` turn completed'));
