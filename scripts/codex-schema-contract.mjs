import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { approvalReply } from '../lib/codex-session.js';
import { holderParams, protocolThread, protocolThreadResponse, protocolTurn } from '../test/codex-contract-witnesses.mjs';

const formats = Object.fromEntries(['int64', 'uint64', 'uint32', 'uint', 'double', 'int32', 'uint16'].map(n => [n, true]));
const fail = (where, reason) => { throw new Error(`${where}: ${reason}; regenerate the capture or review the consumed protocol`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requests = {
  initialize: 'InitializeParams', 'thread/start': 'ThreadStartParams', 'thread/resume': 'ThreadResumeParams',
  'thread/read': 'ThreadReadParams', 'thread/list': 'ThreadListParams', 'thread/loaded/list': 'ThreadLoadedListParams',
  'thread/name/set': 'ThreadSetNameParams', 'thread/inject_items': 'ThreadInjectItemsParams',
  'turn/start': 'TurnStartParams', 'turn/steer': 'TurnSteerParams', 'turn/interrupt': 'TurnInterruptParams',
  'review/start': 'ReviewStartParams', 'skills/list': 'SkillsListParams', 'model/list': 'ModelListParams',
  'account/read': 'GetAccountParams', 'account/rateLimits/read': 'GetAccountRateLimitsParams',
};
const approvals = {
  execCommandApproval: 'ExecCommandApproval', applyPatchApproval: 'ApplyPatchApproval',
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApproval',
  'item/fileChange/requestApproval': 'FileChangeRequestApproval',
  'item/permissions/requestApproval': 'PermissionsRequestApproval',
  'item/tool/requestUserInput': 'ToolRequestUserInput', 'mcpServer/elicitation/request': 'McpServerElicitationRequest',
};
const unhandled = ['account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/tool/call'];

export function readCapture(dir, { provenance = false } = {}) {
  const entries = readdirSync(dir, { recursive: true }).map(n => n.split(path.sep).join('/'));
  for (const name of entries) if (lstatSync(path.join(dir, name)).isSymbolicLink()) fail(name, 'symlink in capture');
  const files = entries.filter(n => lstatSync(path.join(dir, n)).isFile()).sort();
  const generated = files.filter(n => !['README.md', 'capture-provenance.json'].includes(n));
  const schemas = new Map();
  for (const name of generated) {
    if (!name.endsWith('.json')) fail(name, 'unexpected generated file');
    const bytes = readFileSync(path.join(dir, name));
    let schema;
    try { schema = JSON.parse(bytes); } catch (error) { fail(name, `malformed JSON (${error.message})`); }
    if (!schema || typeof schema !== 'object' || !schema.$schema) fail(name, 'missing schema document');
    schemas.set(name, schema);
  }
  if (provenance) {
    const raw = readFileSync(path.join(dir, 'capture-provenance.json'), 'utf8');
    const record = JSON.parse(raw);
    const names = Object.keys(record.inventory ?? {}).sort();
    const declared = [...raw.slice(raw.indexOf('"inventory"')).matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)]
      .map(m => JSON.parse(m[1])).filter(name => name.endsWith('.json'));
    if (declared.length !== new Set(declared).size) fail('inventory', 'duplicate generated file');
    if (JSON.stringify(declared.sort()) !== JSON.stringify(names)) fail('inventory', 'generated-entry keys must match parsed inventory');
    for (const name of names) {
      if (path.isAbsolute(name) || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.')) fail('inventory', `unsafe path ${name}`);
    }
    if (JSON.stringify(names) !== JSON.stringify(generated)) fail('inventory', 'must cover every generated file exactly');
    for (const name of names) {
      const bytes = readFileSync(path.join(dir, name));
      if (record.inventory[name].bytes !== bytes.length || record.inventory[name].sha256 !== hash(bytes)) fail(name, 'inventory bytes/SHA-256 mismatch');
    }
    if (!record.version || record.version !== record.build || record.versionCommand?.exitCode !== 0
      || record.versionCommand?.stdout !== `codex-cli ${record.build}\n` || record.generation?.exitCode !== 0
      || record.versionCommand?.command !== 'codex --version'
      || record.generation?.command !== `codex app-server generate-json-schema --out <worktree>/test/fixtures/codex-app-server/${record.version}`
      || record.versionCommand.signal !== null || record.generation.signal !== null
      || !/^[a-f0-9]{64}$/.test(record.originalManifestSha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(record.binary?.sha256 ?? '')
      || record.binary.sha256Before !== record.binary.sha256 || record.binary.sha256After !== record.binary.sha256
      || !record.binary.resolvedPath || !record.binary.realPath || !record.source?.head?.match(/^[a-f0-9]{40}$/)
      || !record.platform || !record.architecture || !Number.isFinite(Date.parse(record.capturedAt))) {
      fail('capture-provenance.json', 'successful commands, source, platform and stable binary identity required');
    }
  }
  const ajv = new Ajv({ strict: false, allErrors: true, formats });
  for (const [name, schema] of schemas) {
    if (!ajv.validateSchema(schema)) fail(name, `invalid schema (${ajv.errorsText()})`);
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.$ref === 'string') {
        if (!value.$ref.startsWith('#/')) fail(name, `unsupported reference ${value.$ref}`);
        const target = value.$ref.slice(2).split('/').reduce((v, k) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], schema);
        if (!target) fail(name, `unresolved reference ${value.$ref}`);
      }
      Object.values(value).forEach(visit);
    };
    visit(schema);
  }
  return schemas;
}

export function validateConsumedContract(schemas) {
  const load = name => schemas.get(`${name}.json`) ?? fail(name, 'required schema missing');
  const ajv = new Ajv({ strict: false, allErrors: true, formats });
  const validators = new WeakMap();
  const compile = (schema, root) => {
    if (typeof schema === 'boolean') return ajv.compile(schema);
    if (!validators.has(schema)) validators.set(schema, ajv.compile({ ...schema, definitions: root.definitions }));
    return validators.get(schema);
  };
  const deref = (schema, root) => schema.$ref
    ? deref(schema.$ref.slice(2).split('/').reduce((v, k) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root), root) : schema;
  const declaredFields = (schema, value, root, where) => {
    schema = deref(schema, root);
    const choices = schema.oneOf ?? schema.anyOf;
    if (choices) {
      const arm = choices.find(s => compile(s, root)(value));
      if (arm) {
        const picked = deref(arm, root);
        declaredFields({ ...schema, ...picked, oneOf: undefined, anyOf: undefined,
          properties: { ...schema.properties, ...picked.properties } }, value, root, where);
      }
      return;
    }
    if (Array.isArray(value) && schema.items) value.forEach((v, i) => declaredFields(schema.items, v, root, `${where}/${i}`));
    else if (value && typeof value === 'object') {
      if (!schema.properties && !schema.additionalProperties && !schema.required?.length) return;
      for (const [key, v] of Object.entries(value)) {
        const roots = key === 'runtimeWorkspaceRoots' && /(?:thread\/start\/params|ThreadStartParams)$/.test(where)
          ? root.definitions?.TurnEnvironmentParams?.properties?.runtimeWorkspaceRoots : null;
        const field = schema.properties?.[key] ?? schema.additionalProperties ?? roots;
        if (roots && !compile(roots, root)(v)) fail(`${where}/${key}`, 'runtime workspace roots type incompatible');
        if (!field) fail(`${where}/${key}`, 'consumed field is not declared');
        if (typeof field === 'object') declaredFields(field, v, root, `${where}/${key}`);
      }
    }
  };
  const incomingProjection = (schema, value, root) => {
    schema = deref(schema, root);
    if (!schema || typeof schema !== 'object') return schema;
    const projected = { ...schema };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (schema.required) projected.required = schema.required.filter(key => Object.hasOwn(value, key));
      if (schema.properties) projected.properties = Object.fromEntries(Object.entries(schema.properties)
        .filter(([key]) => Object.hasOwn(value, key))
        .map(([key, field]) => [key, incomingProjection(field, value[key], root)]));
    }
    if (Array.isArray(value) && value.length && schema.items) projected.items = incomingProjection(schema.items, value[0], root);
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (schema[key]) projected[key] = schema[key].map(arm => incomingProjection(arm, value, root));
    }
    return projected;
  };
  const witness = (name, value, { negative = false, schema = load(name), root = schema, fields = true } = {}) => {
    const validate = compile(schema, root);
    const valid = validate(value);
    if (negative ? valid : !valid) fail(name, negative ? 'malformed consumed witness was accepted' : ajv.errorsText(validate.errors));
    if (!negative && fields) declaredFields(schema, value, root, name);
  };
  const armFor = (name, method) => {
    const root = load(name);
    const arms = (root.oneOf ?? []).filter(a => a.properties?.method?.enum?.includes(method));
    if (arms.length !== 1) fail(`${name}/${method}`, 'required method must have exactly one request arm');
    return { schema: arms[0], root };
  };
  const allTypes = ['null', 'boolean', 'object', 'array', 'string', 'integer', 'number'];
  const typesOf = (schema, root) => {
    schema = deref(schema, root);
    if (schema === false) return [];
    if (schema === true) return allTypes;
    const named = [schema.type ?? allTypes].flat();
    let types = allTypes.filter(type => named.includes(type) || type === 'integer' && named.includes('number'));
    const intersect = allowed => { types = types.filter(type => allowed.includes(type)); };
    if (schema.enum || Object.hasOwn(schema, 'const')) {
      const values = schema.enum ?? [schema.const];
      intersect(values.map(value => value === null ? 'null' : Array.isArray(value) ? 'array'
        : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value));
    }
    for (const key of ['anyOf', 'oneOf']) {
      if (schema[key]) intersect(schema[key].flatMap(arm => typesOf(arm, root)));
    }
    for (const arm of schema.allOf ?? []) intersect(typesOf(arm, root));
    return types;
  };
  const fieldOf = (schema, key, root, parentTypes = allTypes) => {
    schema = deref(schema, root);
    if (typeof schema === 'boolean') return null;
    const applicable = typesOf(schema, root).filter(type => parentTypes.includes(type));
    const direct = key === '[]' ? schema.items : schema.properties?.[key];
    const constraints = direct === undefined ? [] : [direct];
    for (const arm of schema.allOf ?? []) {
      const field = fieldOf(arm, key, root, applicable);
      if (field !== null) constraints.push(field);
    }
    for (const kind of ['anyOf', 'oneOf']) {
      if (!schema[kind]) continue;
      const arms = schema[kind].filter(arm => typesOf(arm, root).some(type => type !== 'null' && applicable.includes(type)));
      const fields = arms.map(arm => fieldOf(arm, key, root, applicable));
      if (fields.some(field => field !== null)) constraints.push({ anyOf: fields.map(field => field ?? true) });
    }
    return constraints.length ? { allOf: constraints } : null;
  };
  const checkFields = (name, fields, root, schema = root) => {
    for (const [trail, supported] of Object.entries(fields)) {
      let field = schema;
      for (const key of trail.split('.')) {
        field = fieldOf(field, key, root);
        if (field === null) fail(`${name}/${trail}`, 'consumed field is not declared');
      }
      const types = typesOf(field, root);
      const allowed = supported.split('|').flatMap(type => type === 'number' ? ['integer', 'number'] : [type]);
      if (!types.length || types.some(type => !allowed.includes(type))) {
        fail(`${name}/${trail}`, `consumed response type incompatible with ${supported}`);
      }
    }
  };
  const incoming = (name, value, required, fields, { schema = load(name), root = schema } = {}) => {
    checkFields(name, fields, root, schema);
    const projected = incomingProjection(schema, value, root);
    witness(name, value, { schema: projected, root, fields: false });
    for (const trail of required) {
      const missing = structuredClone(value);
      const keys = trail.split('.');
      const key = keys.pop();
      delete keys.reduce((v, k) => v[k], missing)[key];
      witness(`${name}/${trail}`, missing, { schema: projected, root, fields: false, negative: true });
    }
  };
  for (const [method, name] of Object.entries(requests)) {
    const params = holderParams[name] ?? {};
    witness(`ClientRequest/${method}`, { id: 1, method, params }, armFor('ClientRequest', method));
    if (method !== 'account/rateLimits/read') witness(`${method === 'initialize' ? 'v1' : 'v2'}/${name}`, params);
  }
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
    witness('ClientRequest/thread/start', { id: 1, method: 'thread/start', params: { ...holderParams.ThreadStartParams, sandbox } }, armFor('ClientRequest', 'thread/start'));
  }
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    witness('ClientRequest/turn/start', { id: 1, method: 'turn/start', params: { ...holderParams.TurnStartParams, effort } }, armFor('ClientRequest', 'turn/start'));
  }
  const server = load('ServerRequest');
  const methods = (server.oneOf ?? []).flatMap(a => a.properties?.method?.enum ?? []).sort();
  if (JSON.stringify(methods) !== JSON.stringify([...Object.keys(approvals), ...unhandled].sort())) fail('ServerRequest', 'handler/security inventory changed; explicit security review required');
  for (const method of unhandled) if (approvalReply(method, false).__error?.code !== -32601) fail(method, 'unknown request must remain refused with -32601');
  for (const [method, name] of Object.entries(approvals)) {
    for (const allowed of [true, false]) witness(`${name}Response`, approvalReply(method, allowed, { questions: [{ id: 'question' }] }));
  }
  witness('v2/TurnInterruptParams', { threadId: 'thread' }, { negative: true });
  witness('v2/TurnSteerResponse', { turn: { id: 'turn', status: 'inProgress' } }, { negative: true });
  witness('CommandExecutionRequestApprovalResponse', { decision: 'allow-everything' }, { negative: true });
  const serverParams = {
    'item/commandExecution/requestApproval': { threadId: 'thread', turnId: 'turn', itemId: 'item', startedAtMs: 1,
      command: 'true', cwd: '/fixture/root', kind: 'command', networkApprovalContext: { host: 'packages.invalid', protocol: 'https' },
      proposedNetworkPolicyAmendments: [{ action: 'allow', host: 'packages.invalid' }] },
    'item/fileChange/requestApproval': { threadId: 'thread', turnId: 'turn', itemId: 'item', startedAtMs: 1, grantRoot: null },
    'item/permissions/requestApproval': { threadId: 'thread', turnId: 'turn', itemId: 'item', startedAtMs: 1, cwd: '/fixture/root', permissions: {} },
    'item/tool/requestUserInput': { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, questions: [] },
    'mcpServer/elicitation/request': { serverName: 'fixture', threadId: 'thread', mode: 'form', message: 'Fixture input', requestedSchema: { type: 'object', properties: {} } },
    applyPatchApproval: { callId: 'call', conversationId: 'thread', fileChanges: {}, grantRoot: null },
    execCommandApproval: { callId: 'call', conversationId: 'thread', command: ['true'], cwd: '/fixture/root', parsedCmd: [] },
  };
  const approvalFields = {
    'item/commandExecution/requestApproval': { threadId: 'string', turnId: 'string', itemId: 'string',
      kind: 'string', networkApprovalContext: 'object|null', 'networkApprovalContext.host': 'string',
      'networkApprovalContext.protocol': 'string', proposedNetworkPolicyAmendments: 'array|null',
      'proposedNetworkPolicyAmendments.[]': 'object', 'proposedNetworkPolicyAmendments.[].host': 'string',
      'proposedNetworkPolicyAmendments.[].action': 'string' },
    'item/fileChange/requestApproval': { threadId: 'string', turnId: 'string', itemId: 'string', grantRoot: 'string|null' },
    'item/permissions/requestApproval': { threadId: 'string', turnId: 'string', itemId: 'string', cwd: 'string', permissions: 'object' },
    'item/tool/requestUserInput': { threadId: 'string', turnId: 'string', itemId: 'string', isBlocking: 'boolean', questions: 'array' },
    'mcpServer/elicitation/request': { serverName: 'string', threadId: 'string' },
    applyPatchApproval: { callId: 'string', conversationId: 'string', fileChanges: 'object', grantRoot: 'string|null' },
    execCommandApproval: { callId: 'string', conversationId: 'string', command: 'array', cwd: 'string', parsedCmd: 'array' },
  };
  const approvalRequired = {
    'item/commandExecution/requestApproval': ['threadId', 'turnId', 'itemId', 'networkApprovalContext.host',
      'networkApprovalContext.protocol', 'proposedNetworkPolicyAmendments.0.action', 'proposedNetworkPolicyAmendments.0.host'],
    'item/fileChange/requestApproval': ['threadId', 'turnId', 'itemId'],
    'item/permissions/requestApproval': ['threadId', 'turnId', 'itemId', 'cwd', 'permissions'],
    'item/tool/requestUserInput': ['threadId', 'turnId', 'itemId', 'isBlocking', 'questions'],
    'mcpServer/elicitation/request': ['serverName', 'threadId'],
    applyPatchApproval: ['callId', 'conversationId', 'fileChanges'],
    execCommandApproval: ['callId', 'conversationId', 'command', 'cwd', 'parsedCmd'],
  };
  for (const [method, params] of Object.entries(serverParams)) {
    incoming(`ServerRequest/${method}`, { id: 1, method, params },
      ['id', 'method', 'params', ...approvalRequired[method].map(key => `params.${key}`)],
      Object.fromEntries(Object.entries(approvalFields[method]).map(([key, type]) => [`params.${key}`, type])),
      armFor('ServerRequest', method));
    incoming(`${approvals[method]}Params`, params, approvalRequired[method], approvalFields[method]);
  }
  incoming('ServerRequest/command/writeStdin', { id: 1, method: 'item/commandExecution/requestApproval',
    params: { ...serverParams['item/commandExecution/requestApproval'], kind: 'writeStdin' } }, [], {},
  armFor('ServerRequest', 'item/commandExecution/requestApproval'));
  const command = load('CommandExecutionRequestApprovalParams');
  for (const key of ['networkApprovalContext', 'proposedNetworkPolicyAmendments']) {
    if (!command.properties?.[key]) fail(`CommandExecutionRequestApprovalParams/${key}`, 'required security field missing');
  }
  for (const [name, keys] of Object.entries({ NetworkApprovalContext: ['host', 'protocol'], NetworkPolicyAmendment: ['action', 'host'] })) {
    if (!keys.every(key => command.definitions?.[name]?.required?.includes(key))) fail(name, 'required security fields changed');
  }
  if (JSON.stringify(command.definitions?.CommandExecutionApprovalKind?.enum?.slice().sort()) !== '["command","writeStdin"]') fail('CommandExecutionApprovalKind', 'command/writeStdin security inventory changed');
  const thread = { id: 'fixture-thread', cwd: '/fixture/root', turns: [], busy: false, config: { model_reasoning_effort: 'high' } };
  const turn = protocolTurn({ id: 'fixture-turn', status: 'inProgress' });
  const nativeThread = protocolThread(thread);
  const coreThread = { id: nativeThread.id, cwd: nativeThread.cwd, status: nativeThread.status, turns: nativeThread.turns };
  const profile = { ...protocolThreadResponse(thread), thread: coreThread };
  const responses = {
    'v1/InitializeResponse': { codexHome: '/fixture/home', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fixture' },
    'v2/ThreadStartResponse': profile, 'v2/ThreadResumeResponse': profile,
    'v2/ThreadReadResponse': { thread: coreThread }, 'v2/ThreadListResponse': { data: [coreThread] },
    'v2/ThreadLoadedListResponse': { data: [thread.id] }, 'v2/ThreadSetNameResponse': {}, 'v2/ThreadInjectItemsResponse': {},
    'v2/TurnStartResponse': { turn }, 'v2/ReviewStartResponse': { turn, reviewThreadId: thread.id },
    'v2/TurnSteerResponse': { turnId: turn.id }, 'v2/TurnInterruptResponse': {},
    'v2/SkillsListResponse': { data: [{ cwd: thread.cwd, skills: [{ name: 'fixture', path: '/fixture/SKILL.md',
      scope: 'repo', description: 'Fixture', enabled: true }], errors: [] }] },
    'v2/ModelListResponse': { data: [{ id: 'fixture-model', model: 'fixture-model', hidden: true, isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }] },
    'v2/GetAccountResponse': { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true },
    'v2/GetAccountRateLimitsResponse': { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 2000000000 }, credits: null, planType: 'plus' } },
  };
  const requiredIncoming = {
    'v1/InitializeResponse': ['userAgent'],
    'v2/ThreadStartResponse': ['thread', 'thread.id', 'cwd', 'model', 'sandbox', 'approvalPolicy'],
    'v2/ThreadResumeResponse': ['thread', 'thread.id', 'cwd', 'model', 'sandbox', 'approvalPolicy'], 'v2/ThreadReadResponse': ['thread', 'thread.id'],
    'v2/ThreadListResponse': ['data', 'data.0.id'], 'v2/ThreadLoadedListResponse': ['data'],
    'v2/TurnStartResponse': ['turn', 'turn.id', 'turn.status', 'turn.items'],
    'v2/ReviewStartResponse': ['turn', 'turn.id', 'reviewThreadId'], 'v2/TurnSteerResponse': ['turnId'],
    'v2/SkillsListResponse': ['data', 'data.0.cwd', 'data.0.skills'], 'v2/ModelListResponse': ['data', 'data.0.id', 'data.0.model', 'data.0.hidden'],
    'v2/GetAccountResponse': ['requiresOpenaiAuth'], 'v2/GetAccountRateLimitsResponse': ['rateLimits', 'rateLimits.primary.usedPercent', 'rateLimits.secondary.usedPercent'],
  };
  const rateFields = { rateLimits: 'object', 'rateLimits.primary': 'object|null',
    'rateLimits.primary.usedPercent': 'number', 'rateLimits.primary.windowDurationMins': 'number|null',
    'rateLimits.secondary': 'object|null', 'rateLimits.secondary.usedPercent': 'number', 'rateLimits.secondary.windowDurationMins': 'number|null' };
  const requiredFields = {
    'v2/ThreadStartResponse': { 'thread.id': 'string', 'thread.cwd': 'string', 'thread.turns': 'array', 'thread.status': 'object', cwd: 'string', model: 'string', sandbox: 'object', 'sandbox.type': 'string', approvalPolicy: 'string|object', reasoningEffort: 'string|null' },
    'v2/ThreadResumeResponse': { 'thread.id': 'string', cwd: 'string', model: 'string', sandbox: 'object', 'sandbox.type': 'string', approvalPolicy: 'string|object', reasoningEffort: 'string|null' },
    'v2/ThreadReadResponse': { 'thread.id': 'string', 'thread.turns': 'array' },
    'v2/ThreadListResponse': { data: 'array', 'data.[].id': 'string', 'data.[].cwd': 'string' },
    'v2/ThreadLoadedListResponse': { data: 'array', 'data.[]': 'string' },
    'v2/TurnStartResponse': { 'turn.id': 'string', 'turn.status': 'string', 'turn.items': 'array' },
    'v2/ReviewStartResponse': { reviewThreadId: 'string', 'turn.id': 'string' },
    'v2/TurnSteerResponse': { turnId: 'string' },
    'v2/ModelListResponse': { data: 'array', 'data.[].id': 'string', 'data.[].model': 'string', 'data.[].hidden': 'boolean', 'data.[].supportedReasoningEfforts': 'array' },
    'v2/SkillsListResponse': { data: 'array', 'data.[].cwd': 'string', 'data.[].skills': 'array', 'data.[].errors': 'array' },
    'v2/GetAccountResponse': { requiresOpenaiAuth: 'boolean' },
    'v2/GetAccountRateLimitsResponse': rateFields,
  };
  for (const [name, value] of Object.entries(responses)) {
    incoming(name, value, requiredIncoming[name] ?? [], requiredFields[name] ?? {});
  }
  for (const [method, name, params, required, fields] of [
    ['turn/started', 'TurnStartedNotification', { threadId: thread.id, turn },
      ['threadId', 'turn', 'turn.id'], { threadId: 'string', turn: 'object', 'turn.id': 'string' }],
    ['turn/completed', 'TurnCompletedNotification', { threadId: thread.id, turn: { ...turn, status: 'completed' } },
      ['threadId', 'turn', 'turn.id', 'turn.status'], { threadId: 'string', turn: 'object', 'turn.id': 'string', 'turn.status': 'string' }],
    ['thread/status/changed', 'ThreadStatusChangedNotification', { threadId: thread.id, status: { type: 'idle' } },
      ['threadId', 'status'], { threadId: 'string', status: 'object', 'status.type': 'string' }],
    ['account/rateLimits/updated', 'AccountRateLimitsUpdatedNotification', responses['v2/GetAccountRateLimitsResponse'],
      ['rateLimits', 'rateLimits.primary.usedPercent', 'rateLimits.secondary.usedPercent'], rateFields],
  ]) {
    incoming(`ServerNotification/${method}`, { method, params },
      ['method', 'params', ...required.map(key => `params.${key}`)],
      Object.fromEntries(Object.entries(fields).map(([key, type]) => [`params.${key}`, type])),
      armFor('ServerNotification', method));
    incoming(`v2/${name}`, params, required, fields);
  }
  return { requests: Object.keys(requests).length, serverRequests: methods.length, responses: Object.keys(responses).length, notifications: 4 };
}
