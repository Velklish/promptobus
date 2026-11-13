import './home.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv';
import { makeSandbox } from './sandbox.mjs';
import { approvalReply, codexInitParams, decideApproval } from '../lib/codex-session.js';
import { readConsumedContract } from '../scripts/codex-schema-contract.mjs';

const method = 'item/commandExecution/requestApproval';
const box = makeSandbox('promptobus-codex-');
const cwd = path.join(box, 'worktree'), extra = path.join(box, 'extra'), outside = path.join(box, 'outside');
for (const dir of [cwd, extra, outside]) mkdirSync(dir);
const contexts = [
  ['contained', { cwd }], ['additional root', { cwd: extra }], ['outside', { cwd: outside }],
  ['network', { cwd, networkApprovalContext: { host: 'packages.invalid', protocol: 'https' } }],
  ['network amendment', { cwd, proposedNetworkPolicyAmendments: [{ action: 'allow', host: 'packages.invalid' }] }],
];

test('holder advertises exactly its implemented capabilities and no human approval capability', () => {
  const capabilities = codexInitParams({}, {}).capabilities;
  assert.deepEqual(capabilities, { experimentalApi: true, optOutNotificationMethods: ['mcpServer/startupStatus/updated'] });
  assert.equal(Object.hasOwn(capabilities, 'requiredHumanApproval'), false);
});

for (const role of ['worker', 'approver', 'reviewer', 'reporter']) {
  for (const [context, params] of contexts) {
    test(`humanCommand refuses before ${role} ${context} dispatch`, () => {
      const decision = decideApproval(method, { ...params, kind: 'humanCommand',
        capabilities: { experimentalApi: true, requiredHumanApproval: true } }, { cwd, addDirs: [extra], role });
      assert.deepEqual(decision, { allow: false, why: 'humanCommand requires a fresh human decision; the holder has no human approval capability' });
      assert.deepEqual(approvalReply(method, decision.allow), { decision: 'decline' });
    });
  }
}

for (const kind of [null, undefined, false, true, 0, '', 'humancommand', 'futureCommand', [], ['command'], {},
  { type: 'command' }, { humanCommand: { requiredHumanApproval: true } }]) {
  test(`malformed or unknown explicit approval kind refuses: ${JSON.stringify(kind)}`, () => {
    const decision = decideApproval(method, { cwd, kind }, { cwd, role: 'worker' });
    assert.deepEqual(decision, { allow: false, why: 'unknown or malformed command approval kind' });
    assert.deepEqual(approvalReply(method, decision.allow), { decision: 'decline' });
  });
}

for (const kind of [undefined, 'command', 'writeStdin']) {
  for (const role of ['worker', 'approver', 'reviewer', 'reporter']) {
    for (const [context, params] of contexts) {
      test(`${kind ?? 'absent kind'} retains ${role} ${context} restrictions`, () => {
        const decision = decideApproval(method, { ...params, ...(kind === undefined ? {} : { kind }) },
          { cwd, addDirs: [extra], role });
        const allow = ['worker', 'approver'].includes(role) && ['contained', 'additional root'].includes(context);
        assert.equal(decision.allow, allow, JSON.stringify(decision));
        assert.deepEqual(approvalReply(method, decision.allow), { decision: allow ? 'accept' : 'decline' });
      });
    }
  }
}

const formats = Object.fromEntries(['int64', 'uint64', 'uint32', 'uint', 'double', 'int32', 'uint16'].map(n => [n, true]));
for (const version of ['0.158.0', '0.166.0', '0.167.2']) {
  test(`Codex ${version} exact approval kind alternatives in both schema locations`, () => {
    const schemas = readConsumedContract(`test/fixtures/codex-app-server/${version}`, version);
    const ajv = new Ajv({ strict: false, allErrors: true, formats });
    for (const name of ['ServerRequest', 'CommandExecutionRequestApprovalParams']) {
      const schema = schemas.get(`${name}.json`);
      const validate = ajv.compile({ $ref: '#/definitions/CommandExecutionApprovalKind', definitions: schema.definitions });
      for (const kind of ['command', 'writeStdin', 'humanCommand']) {
        assert.equal(validate(kind), kind !== 'humanCommand' || version === '0.167.2', `${name}: ${kind}`);
      }
      for (const kind of [null, false, 1, '', 'futureCommand', [], ['humanCommand'], {}, { type: 'humanCommand' }]) {
        assert.equal(validate(kind), false, `${name}: malformed ${JSON.stringify(kind)}`);
      }
    }
  });
}

test('Codex 0.167.2 human capability is an optional boolean in both schema locations', () => {
  const schemas = readConsumedContract('test/fixtures/codex-app-server/0.167.2', '0.167.2');
  const ajv = new Ajv({ strict: false, formats });
  for (const name of ['ClientRequest', 'v1/InitializeParams']) {
    const schema = schemas.get(`${name}.json`);
    const validate = ajv.compile({ $ref: '#/definitions/InitializeCapabilities', definitions: schema.definitions });
    for (const capabilities of [{}, { experimentalApi: true, requiredHumanApproval: true },
      { experimentalApi: true, requiredHumanApproval: false }]) assert.equal(validate(capabilities), true);
    for (const requiredHumanApproval of [null, 'true', 1, [], {}, { enabled: true }]) {
      assert.equal(validate({ experimentalApi: true, requiredHumanApproval }), false, `${name}: ${JSON.stringify(requiredHumanApproval)}`);
    }
  }
});

test('Codex 0.167.2 audio witnesses retain exact fileId or url alternatives without changing holder input', () => {
  const schemas = readConsumedContract('test/fixtures/codex-app-server/0.167.2', '0.167.2');
  const ajv = new Ajv({ strict: false, formats });
  for (const [name, schema] of schemas) {
    if (!schema.definitions?.UserInput) continue;
    const validate = ajv.compile({ $ref: '#/definitions/UserInput', definitions: schema.definitions });
    for (const audio of [{ type: 'audio', url: 'https://audio.invalid/a' }, { type: 'audio', fileId: 'file-fixture' },
      { type: 'audio', fileId: 'file-fixture', url: 'https://audio.invalid/a' }]) {
      assert.equal(validate(audio), true, `${name}: ${JSON.stringify(audio)}`);
    }
    for (const audio of [{ type: 'audio' }, { type: 'audio', fileId: null }, { type: 'audio', fileId: 1 },
      { type: 'audio', url: null }, { type: 'audio', url: [] }, { type: 'audio', fileId: {}, url: false }]) {
      assert.equal(validate(audio), false, `${name}: malformed ${JSON.stringify(audio)}`);
    }
  }
});

test('current holder documentation selects 0.167.2 and keeps historical approval measurements scoped', () => {
  const cli = readFileSync('docs/reference/03-cli.md', 'utf8');
  assert.match(cli, /current consumed contract is codex-cli 0\.167\.2/);
  assert.match(cli, /humanCommand.*fresh human decision/);
  assert.match(cli, /Historical approval measurements on codex-cli 0\.156\.1/);
});
