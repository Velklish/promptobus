import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';
import { readCapture, validateConsumedContract } from '../scripts/codex-schema-contract.mjs';
import { checkCodexSchema } from '../scripts/check-codex-schema.mjs';
import { listedModels, verifyThreadProfile } from '../lib/codex-session.js';
import { rateLimitWindows } from '../lib/model-routing/adapter-codex.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capture = path.join(root, 'test/fixtures/codex-app-server', PROVEN_CODEX_VERSION);
const box = makeSandbox('promptobus-codex-');
const bin = path.join(box, 'bin');
mkdirSync(bin);
stubCommand(bin, 'codex', `
import { cpSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') process.stdout.write('codex-cli 0.164.0\\n');
else if (JSON.stringify(args.slice(0, 3)) === JSON.stringify(['app-server', 'generate-json-schema', '--out'])) {
  cpSync(${JSON.stringify(capture)}, args[3], { recursive: true });
} else process.exit(99);
`);

test('schema gate accepts a newer label with the compatible consumed protocol', () => {
  const result = spawnSync(process.execPath, ['scripts/check-codex-schema.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}` },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /installed consumed protocol compatible/);
});

const schemas = readCapture(capture, { provenance: true });
function changed(name, mutate) {
  const result = new Map(schemas);
  const value = structuredClone(result.get(name));
  mutate(value);
  result.set(name, value);
  return result;
}
function gate(label, generation = null, version = {}) {
  const calls = [], lines = [], streams = [];
  const code = checkCodexSchema({ captureDir: capture, say: s => lines.push(s), raw: s => streams.push(s),
    run(exe, args, options) {
      calls.push({ exe, args, options });
      if (args[0] === '--version') return { status: 0, stdout: label, ...version };
      cpSync(capture, args[3], { recursive: true });
      return generation?.(args[3]) ?? { status: 0, stdout: '', stderr: '' };
    } });
  return { code, calls, lines: lines.join('\n'), raw: streams.join('') };
}

test('schema gate treats old future prefixed and unreadable version labels as telemetry', () => {
  for (const label of ['codex-cli 0.1.0', 'codex-cli 99.1.0', 'v0.164.0', 'future codex build', '']) {
    const result = gate(label);
    assert.equal(result.code, 0, result.lines);
    assert.deepEqual(result.calls.map(c => c.args.slice(0, 3)), [['--version'], ['app-server', 'generate-json-schema', '--out']]);
    assert.ok(result.calls.every(c => c.options.timeout === 20_000 && c.options.maxBuffer === 2 * 1024 * 1024));
    assert.ok(!result.calls[1].args[3].includes(label || '\0'));
  }
});

test('missing binary skips only installed comparison after validating the committed capture', () => {
  const result = gate('', null, { error: { code: 'ENOENT' }, status: null });
  assert.equal(result.code, 0, result.lines);
  assert.equal(result.calls.length, 1);
  assert.match(result.lines, /committed Codex/);
  assert.match(result.lines, /installed comparison notRun: codex binary missing/);
});

test('failed version telemetry does not override a successful consumed-contract measurement', () => {
  const result = gate('', null, { status: 1, stderr: 'version warning\n', error: { message: 'version telemetry failed' } });
  assert.equal(result.code, 0, result.lines);
  assert.match(result.raw, /version warning/);
});

test('generation nonzero timeout malformed and missing schemas fail with actionable diagnostics', () => {
  for (const [generation, expected] of [
    [() => ({ status: 2, stderr: 'unsupported generator flag\n' }), /generate-json-schema failed: exit 2/],
    [() => ({ status: null, error: { message: 'ETIMEDOUT' }, signal: 'SIGTERM' }), /ETIMEDOUT/],
    [dir => { writeFileSync(path.join(dir, 'ClientRequest.json'), '{'); }, /ClientRequest.json: malformed JSON/],
    [dir => { rmSync(path.join(dir, 'ClientRequest.json')); }, /ClientRequest: required schema missing/],
    [dir => { writeFileSync(path.join(dir, 'Extra.json'), JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', $ref: '#/definitions/absent' })); }, /unresolved reference/],
  ]) {
    const result = gate('future', generation);
    assert.equal(result.code, 1, result.lines);
    assert.match(result.lines, expected);
    assert.doesNotMatch(result.lines, /installed comparison notRun/);
    assert.equal(readFileSync(path.join(capture, 'ClientRequest.json'), 'utf8').startsWith('{'), true);
  }
});

test('consumed request membership is required even when its params file remains', () => {
  const value = changed('ClientRequest.json', s => { s.oneOf = s.oneOf.filter(a => !a.properties.method.enum.includes('turn/start')); });
  assert.ok(value.has('v2/TurnStartParams.json'));
  assert.throws(() => validateConsumedContract(value), /ClientRequest\/turn\/start: required method/);
});

test('consumed request fields and new required outgoing fields are checked in the request union', () => {
  for (const change of [
    s => { const arm = s.oneOf.find(a => a.properties.method.enum.includes('turn/start')); arm.required.push('newRequired'); },
    s => { s.definitions.TurnStartParams.properties.threadId.type = 'integer'; },
    s => { delete s.definitions.ThreadStartParams.properties.sandbox; },
    s => { delete s.definitions.TurnEnvironmentParams.properties.runtimeWorkspaceRoots; },
    s => { s.definitions.TurnEnvironmentParams.properties.runtimeWorkspaceRoots.type = 'integer'; },
  ]) assert.throws(() => validateConsumedContract(changed('ClientRequest.json', change)), /ClientRequest/);
});

test('consumed responses retain their actual fields types and malformed-witness refusals', () => {
  assert.throws(() => validateConsumedContract(changed('v2/TurnStartResponse.json', s => { delete s.definitions.Turn.properties.id; })), /turn.id/);
  assert.throws(() => validateConsumedContract(changed('v2/TurnSteerResponse.json', s => { s.properties.turnId.type = 'integer'; })), /TurnSteerResponse/);
  assert.throws(() => validateConsumedContract(changed('v2/TurnSteerResponse.json', s => { s.properties.turnId.type = ['string', 'integer']; })), /type/);
  assert.throws(() => validateConsumedContract(changed('v2/TurnInterruptParams.json', s => { s.required = s.required.filter(n => n !== 'turnId'); })), /malformed consumed witness was accepted/);
});

test('security inventory and actual approval reply semantics cannot silently widen', () => {
  assert.throws(() => validateConsumedContract(changed('ServerRequest.json', s => {
    s.oneOf.push({ type: 'object', properties: { method: { enum: ['new/requestApproval'] }, id: {}, params: {} } });
  })), /explicit security review required/);
  assert.throws(() => validateConsumedContract(changed('CommandExecutionRequestApprovalParams.json', s => { delete s.properties.networkApprovalContext; })), /networkApprovalContext: (consumed field is not declared|required security field missing)/);
  assert.throws(() => validateConsumedContract(changed('ServerRequest.json', s => { delete s.definitions.CommandExecutionRequestApprovalParams.properties.proposedNetworkPolicyAmendments; })), /proposedNetworkPolicyAmendments/);
  assert.throws(() => validateConsumedContract(changed('CommandExecutionRequestApprovalResponse.json', s => {
    s.definitions.CommandExecutionApprovalDecision.oneOf.push({ type: 'string', enum: ['allow-everything'] });
  })), /malformed consumed witness was accepted/);
  assert.throws(() => validateConsumedContract(changed('CommandExecutionRequestApprovalParams.json', s => {
    s.definitions.CommandExecutionApprovalKind.enum = ['command'];
  })), /CommandExecutionApprovalKind/);
});

test('unrelated additive client methods and schema documents remain compatible', () => {
  const value = changed('ClientRequest.json', s => {
    s.oneOf.push({ type: 'object', properties: { method: { enum: ['new/unrelated'] }, id: { type: 'integer' }, params: {} }, required: ['method'] });
  });
  value.set('NewUnrelated.json', { $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' });
  assert.equal(validateConsumedContract(value).requests, 16);
});

function copyCapture(name) {
  const dir = path.join(box, name);
  cpSync(capture, dir, { recursive: true });
  return dir;
}
function editProvenance(dir, mutate) {
  const file = path.join(dir, 'capture-provenance.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  mutate(record);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

test('capture provenance verifies bytes full inventory safe paths and successful stable identity', () => {
  for (const [name, mutate, expected] of [
    ['bytes', dir => writeFileSync(path.join(dir, 'ClientRequest.json'), `${readFileSync(path.join(dir, 'ClientRequest.json'))}\n`), /bytes\/SHA-256 mismatch/],
    ['missing-entry', dir => editProvenance(dir, r => { delete r.inventory['ClientRequest.json']; }), /every generated file/],
    ['extra-file', dir => writeFileSync(path.join(dir, 'Extra.json'), '{}'), /missing schema document|every generated file/],
    ['unsafe-path', dir => editProvenance(dir, r => { r.inventory['../outside.json'] = { bytes: 0, sha256: 'a'.repeat(64) }; }), /unsafe path/],
    ['identity', dir => editProvenance(dir, r => { r.binary.sha256After = 'f'.repeat(64); }), /stable binary identity/],
    ['failed-generation', dir => editProvenance(dir, r => { r.generation.exitCode = 2; }), /successful commands/],
  ]) {
    const dir = copyCapture(name);
    mutate(dir);
    assert.throws(() => readCapture(dir, { provenance: true }), expected, name);
  }
  const dir = copyCapture('duplicate');
  const file = path.join(dir, 'capture-provenance.json');
  const raw = readFileSync(file, 'utf8').replace('"inventory": {', '"inventory": { "ClientRequest.json": {},');
  writeFileSync(file, raw);
  assert.throws(() => readCapture(dir, { provenance: true }), /duplicate generated file/);
  const escaped = copyCapture('escaped-duplicate');
  const escapedFile = path.join(escaped, 'capture-provenance.json');
  writeFileSync(escapedFile, readFileSync(escapedFile, 'utf8')
    .replace('"inventory": {', '"inventory": { "Client\\u0052equest.json": {},'));
  assert.throws(() => readCapture(escaped, { provenance: true }), /duplicate generated file/);
});

test('missing installed binary never hides invalid committed provenance', () => {
  const dir = copyCapture('absent-invalid');
  editProvenance(dir, r => { r.generation.exitCode = 1; });
  let called = false;
  const code = checkCodexSchema({ captureDir: dir, run() { called = true; return { error: { code: 'ENOENT' } }; }, say() {} });
  assert.equal(code, 1);
  assert.equal(called, false);
});

test('current documentation states protocol admission static inventory and requested effort', () => {
  const read = name => readFileSync(path.join(root, name), 'utf8').replace(/\s+/g, ' ');
  assert.match(read('docs/reference/05-drivers.md'), /Native harness version labels are telemetry/);
  assert.match(read('docs/reference/04-protocol.md'), /finite protocol consumed by the holder/);
  assert.match(read('docs/guides/contributing.md'), /missing binary skips the installed comparison, explicitly as `notRun`/);
  assert.match(read('docs/reference/03-cli.md'), /static dictionary for every version label/);
  assert.match(read('docs/reference/03-cli.md'), /Successful launch alone does not establish effective effort/);
  assert.match(read('docs/guides/model-routing.md'), /static dictionary is independent of the binary's version label/);
});

test('unrelated required incoming fields remain compatible with the consumed contract', () => {
  const value = changed('v2/ThreadStartResponse.json', s => {
    s.properties.futureMetadata = { type: 'string' };
    s.required.push('futureMetadata');
    s.definitions.Thread.properties.futureMetadata = { type: 'string' };
    s.definitions.Thread.required.push('futureMetadata');
  });
  assert.equal(validateConsumedContract(value).requests, 16);
});

test('consumed incoming required fields cannot become optional', () => {
  const value = changed('v2/TurnStartResponse.json', s => {
    s.definitions.Turn.required = s.definitions.Turn.required.filter(n => n !== 'id');
  });
  assert.throws(() => validateConsumedContract(value), /malformed consumed witness was accepted/);
});


test('consumed numeric usage accepts integer and number schemas but rejects nonnumeric types', () => {
  const windows = rateLimitWindows({ primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 2000000000 } });
  assert.equal(windows[0].usedPercent, 12.5);
  for (const type of ['integer', 'number', ['integer', 'number']]) {
    const value = changed('v2/GetAccountRateLimitsResponse.json', s => { s.definitions.RateLimitWindow.properties.usedPercent.type = type; });
    assert.equal(validateConsumedContract(value).requests, 16);
  }
  for (const type of ['string', ['number', 'string']]) {
    const value = changed('v2/GetAccountRateLimitsResponse.json', s => { s.definitions.RateLimitWindow.properties.usedPercent.type = type; });
    assert.throws(() => validateConsumedContract(value), /usedPercent/);
  }
});

for (const response of ['ThreadStartResponse', 'ThreadResumeResponse']) {
  for (const field of ['reasoningEffort', 'sandbox', 'approvalPolicy']) {
    test(`${response} requires the consumed ${field} declaration`, () => {
      assert.throws(() => validateConsumedContract(changed(`v2/${response}.json`, s => {
        delete s.properties[field];
        s.required = s.required.filter(key => key !== field);
      })), new RegExp(field));
    });
    test(`${response} rejects a boolean alternative for ${field}`, () => {
      assert.throws(() => validateConsumedContract(changed(`v2/${response}.json`, s => {
        s.properties[field] = { anyOf: [s.properties[field], { type: 'boolean' }] };
      })), new RegExp(field));
    });
  }
  test(`${response} keeps sandbox and approvalPolicy required but effort optional and nullable`, () => {
    for (const field of ['sandbox', 'approvalPolicy']) {
      assert.throws(() => validateConsumedContract(changed(`v2/${response}.json`, s => {
        s.required = s.required.filter(key => key !== field);
      })), /malformed consumed witness was accepted/);
    }
    assert.equal(validateConsumedContract(changed(`v2/${response}.json`, s => {
      s.required = s.required.filter(key => key !== 'reasoningEffort');
    })).responses, 16);
  });
}

for (const mutation of ['declaration', 'type', 'requiredness']) {
  test(`model visibility rejects missing or widened hidden ${mutation}`, () => {
    assert.throws(() => validateConsumedContract(changed('v2/ModelListResponse.json', s => {
      const model = s.definitions.Model;
      if (mutation === 'declaration') delete model.properties.hidden;
      if (mutation === 'type') model.properties.hidden.type = ['boolean', 'string'];
      if (mutation === 'requiredness') model.required = model.required.filter(key => key !== 'hidden');
    })), /hidden|malformed consumed witness/);
  });
}

for (const [name, field, first] of [
  ['v2/GetAccountRateLimitsResponse.json', 'usedPercent', 'number'],
  ['v2/TurnSteerResponse.json', 'turnId', 'string'],
]) {
  for (const arm of [{}, true, { type: 'boolean' }]) {
    test(`${field} rejects unrestricted or unsupported union arm ${JSON.stringify(arm)}`, () => {
      assert.throws(() => validateConsumedContract(changed(name, s => {
        const properties = field === 'usedPercent' ? s.definitions.RateLimitWindow.properties : s.properties;
        properties[field] = { anyOf: [{ type: first }, arm] };
      })), new RegExp(field));
    });
  }
}

test('consumed type constraints intersect allOf instead of joining its alternatives', () => {
  const value = changed('v2/GetAccountRateLimitsResponse.json', s => {
    s.definitions.RateLimitWindow.properties.usedPercent = {
      allOf: [{ anyOf: [{ type: 'number' }, { type: 'string' }] }, { type: 'number' }],
    };
  });
  assert.equal(validateConsumedContract(value).responses, 16);
});

test('consumed nested fields are checked in every incoming alternative', () => {
  const value = changed('v2/TurnStartResponse.json', s => {
    const alternative = structuredClone(s.definitions.Turn);
    alternative.properties.id = { type: 'integer' };
    s.properties.turn = { anyOf: [s.properties.turn, alternative] };
  });
  assert.throws(() => validateConsumedContract(value), /turn.id/);
});

for (const file of ['ServerNotification.json', 'v2/AccountRateLimitsUpdatedNotification.json']) {
  for (const type of [['integer', 'boolean'], ['number', 'string']]) {
    test(`${file} rejects nonnumeric notification usage ${type.join('|')}`, () => {
      assert.throws(() => validateConsumedContract(changed(file, s => {
        s.definitions.RateLimitWindow.properties.usedPercent.type = type;
      })), /usedPercent/);
    });
  }
}
for (const file of ['ServerNotification.json', 'v2/TurnCompletedNotification.json']) {
  for (const field of ['turn', 'threadId', 'id', 'status']) {
    test(`${file} keeps completion ${field} required`, () => {
      assert.throws(() => validateConsumedContract(changed(file, s => {
        const target = ['id', 'status'].includes(field) ? s.definitions.Turn
          : file === 'ServerNotification.json' ? s.definitions.TurnCompletedNotification : s;
        target.required = target.required.filter(key => key !== field);
      })), /malformed consumed witness was accepted/);
    });
  }
}
for (const file of ['ServerRequest.json', 'CommandExecutionRequestApprovalParams.json']) {
  for (const field of ['networkApprovalContext', 'proposedNetworkPolicyAmendments']) {
    test(`${file} refuses a string representation of ${field}`, () => {
      assert.throws(() => validateConsumedContract(changed(file, s => {
        const params = file === 'ServerRequest.json' ? s.definitions.CommandExecutionRequestApprovalParams : s;
        params.properties[field] = { anyOf: [params.properties[field], { type: 'string' }] };
      })), new RegExp(field));
    });
  }
  test(`${file} retains network context and amendment host identity`, () => {
    for (const definition of ['NetworkApprovalContext', 'NetworkPolicyAmendment']) {
      assert.throws(() => validateConsumedContract(changed(file, s => {
        s.definitions[definition].required = s.definitions[definition].required.filter(key => key !== 'host');
      })), /host|security fields|malformed consumed witness/);
      assert.throws(() => validateConsumedContract(changed(file, s => {
        s.definitions[definition].properties.host = { type: ['string', 'boolean'] };
      })), /host/);
    }
  });
  for (const definition of ['NetworkApprovalContext', 'NetworkPolicyAmendment']) {
    test(`${file} accepts required additive metadata in ${definition}`, () => {
      assert.equal(validateConsumedContract(changed(file, s => {
        s.definitions[definition].properties.futureMetadata = { type: 'string' };
        s.definitions[definition].required.push('futureMetadata');
      })).responses, 16);
    });
  }
}

test('incoming notifications and approvals preserve nullable optional and unrelated additive fields', () => {
  for (const file of ['ServerNotification.json', 'v2/TurnCompletedNotification.json', 'ServerRequest.json', 'CommandExecutionRequestApprovalParams.json']) {
    assert.equal(validateConsumedContract(changed(file, s => {
      const params = file === 'ServerNotification.json' ? s.definitions.TurnCompletedNotification
        : file === 'ServerRequest.json' ? s.definitions.CommandExecutionRequestApprovalParams : s;
      params.properties.unrelatedMetadata = { type: 'string' };
      params.required.push('unrelatedMetadata');
    })).responses, 16);
  }
});


test('requested effort echo and hidden true retain their actual reader semantics', () => {
  const record = { model: 'fixture-model', effort: 'high', sandbox: 'workspace-write', approvalPolicy: 'on-request' };
  const profile = { model: record.model, reasoningEffort: record.effort,
    sandbox: { type: 'workspaceWrite' }, approvalPolicy: record.approvalPolicy };
  assert.doesNotThrow(() => verifyThreadProfile(record, profile));
  assert.throws(() => verifyThreadProfile(record, { ...profile, reasoningEffort: null }), /effort requested="high" effective=null/);
  assert.deepEqual(listedModels({ data: [{ id: 'visible', hidden: false }, { id: 'hidden', hidden: true }] }),
    [{ model: 'visible', hidden: false }, { model: 'hidden', hidden: true }]);
  for (const [value, normalized] of [[false, 0], ['12', 12]]) {
    assert.equal(rateLimitWindows({ primary: { usedPercent: value, windowDurationMins: 300 } })[0].usedPercent, normalized);
  }
});

for (const file of ['v2/GetAccountRateLimitsResponse.json', 'ServerNotification.json', 'v2/AccountRateLimitsUpdatedNotification.json']) {
  for (const window of ['primary', 'secondary']) {
    test(`${file} requires usedPercent in a present ${window} window`, () => {
      assert.throws(() => validateConsumedContract(changed(file, s => {
        const present = structuredClone(s.definitions.RateLimitWindow);
        present.required = present.required.filter(key => key !== 'usedPercent');
        s.definitions.RateLimitSnapshot.properties[window] = { anyOf: [present, { type: 'null' }] };
      })), /usedPercent.*malformed consumed witness was accepted/);
    });
  }
  test(`${file} keeps rate windows optional and nullable with unrelated required metadata`, () => {
    assert.equal(validateConsumedContract(changed(file, s => {
      const snapshot = s.definitions.RateLimitSnapshot;
      snapshot.required = ['futureMetadata'];
      snapshot.properties.futureMetadata = { type: 'string' };
      for (const window of ['primary', 'secondary']) {
        snapshot.properties[window] = { anyOf: [{ $ref: '#/definitions/RateLimitWindow' }, { type: 'null' }] };
      }
    })).responses, 16);
  });
}

for (const type of [['integer', 'boolean'], ['number', 'string'], 'boolean']) {
  test(`secondary response usage rejects ${JSON.stringify(type)} without changing primary`, () => {
    assert.throws(() => validateConsumedContract(changed('v2/GetAccountRateLimitsResponse.json', s => {
      const secondary = structuredClone(s.definitions.RateLimitWindow);
      secondary.properties.usedPercent.type = type;
      s.definitions.RateLimitSnapshot.properties.secondary = { anyOf: [secondary, { type: 'null' }] };
    })), /secondary.usedPercent/);
  });
}
for (const type of ['integer', 'number', ['integer', 'number']]) {
  test(`secondary response usage accepts ${JSON.stringify(type)} with nullable optional windows`, () => {
    assert.equal(validateConsumedContract(changed('v2/GetAccountRateLimitsResponse.json', s => {
      const secondary = structuredClone(s.definitions.RateLimitWindow);
      secondary.properties.usedPercent.type = type;
      s.definitions.RateLimitSnapshot.properties.secondary = { anyOf: [secondary, { type: 'null' }] };
    })).responses, 16);
  });
}

for (const kind of ['anyOf', 'oneOf']) {
  for (const restriction of ['direct', 'allOf']) {
    test(`${kind} nested fields ignore string arms excluded by ${restriction} object constraints`, () => {
      assert.equal(validateConsumedContract(changed('v2/TurnStartResponse.json', s => {
        const choices = { [kind]: [s.properties.turn, { type: 'string' }] };
        s.properties.turn = restriction === 'direct' ? { type: 'object', ...choices }
          : { allOf: [{ type: 'object' }, choices] };
      })).responses, 16);
    });
    test(`${kind} nested fields retain unrestricted object arms under ${restriction} constraints`, () => {
      assert.throws(() => validateConsumedContract(changed('v2/TurnStartResponse.json', s => {
        const choices = { [kind]: [s.properties.turn, {}] };
        s.properties.turn = restriction === 'direct' ? { type: 'object', ...choices }
          : { allOf: [{ type: 'object' }, choices] };
      })), /turn.id/);
    });
  }
}

test('missing usage drops a window while secondary boolean usage becomes zero in the actual reader', () => {
  assert.deepEqual(rateLimitWindows({ primary: { windowDurationMins: 300 } }), []);
  assert.equal(rateLimitWindows({ secondary: { usedPercent: false, windowDurationMins: 300 } })[0].usedPercent, 0);
});

for (const file of ['v2/GetAccountRateLimitsResponse.json', 'ServerNotification.json', 'v2/AccountRateLimitsUpdatedNotification.json']) {
  for (const window of ['primary', 'secondary']) {
    test(`${file} rejects unsupported duration types in ${window}`, () => {
      for (const duration of [
        { type: ['integer', 'null', 'boolean'] }, { type: ['number', 'null', 'string'] },
        {}, true, { anyOf: [{ type: 'integer' }, {}] },
        { anyOf: [{ type: 'number' }, true] }, { oneOf: [{ type: 'number' }, { type: 'boolean' }] },
      ]) {
        assert.throws(() => validateConsumedContract(changed(file, s => {
          const present = structuredClone(s.definitions.RateLimitWindow);
          present.properties.windowDurationMins = duration;
          s.definitions.RateLimitSnapshot.properties[window] = { anyOf: [present, { type: 'null' }] };
        })), new RegExp(`${window}\\.windowDurationMins`), JSON.stringify(duration));
      }
    });
    test(`${file} requires the optional consumed duration declaration in ${window}`, () => {
      assert.throws(() => validateConsumedContract(changed(file, s => {
        const present = structuredClone(s.definitions.RateLimitWindow);
        delete present.properties.windowDurationMins;
        s.definitions.RateLimitSnapshot.properties[window] = { anyOf: [present, { type: 'null' }] };
      })), new RegExp(`${window}\\.windowDurationMins: consumed field is not declared`));
    });
    test(`${file} accepts numeric optional nullable duration in ${window} with additive metadata`, () => {
      for (const duration of [
        { type: 'integer' }, { type: 'number' }, { type: ['integer', 'null'] },
        { type: ['number', 'null'] }, { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      ]) {
        assert.equal(validateConsumedContract(changed(file, s => {
          const snapshot = s.definitions.RateLimitSnapshot;
          snapshot.properties.futureMetadata = { type: 'string' };
          snapshot.required = ['futureMetadata'];
          const present = structuredClone(s.definitions.RateLimitWindow);
          present.properties.windowDurationMins = duration;
          present.properties.futureMetadata = { type: 'string' };
          present.required = ['usedPercent', 'futureMetadata'];
          snapshot.properties[window] = { anyOf: [present, { type: 'null' }] };
        })).responses, 16);
      }
    });
  }
}

test('actual duration reader preserves numeric windows and drops absent or null duration', () => {
  for (const window of ['primary', 'secondary']) {
    for (const duration of [300, 10080, 1.5]) {
      assert.equal(rateLimitWindows({ [window]: { usedPercent: 12, windowDurationMins: duration } })[0].lengthSec,
        Math.round(duration * 60));
    }
    assert.deepEqual(rateLimitWindows({ [window]: { usedPercent: 12 } }), []);
    assert.deepEqual(rateLimitWindows({ [window]: { usedPercent: 12, windowDurationMins: null } }), []);
    assert.equal(rateLimitWindows({ [window]: { usedPercent: 12, windowDurationMins: true } })[0].lengthSec, 60);
    assert.deepEqual(rateLimitWindows({ [window]: { usedPercent: 12, windowDurationMins: false } }), []);
  }
});
