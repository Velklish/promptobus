import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStandaloneHost } from '../dist/host-index.js';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { holderAlive, holderAsk, pidAlive, readSession, sessionFile } from '../lib/codex-session.js';
import { createTask, participantRecord, upsertParticipant } from '../lib/store.js';
import { installHarness, PROBE_VAR, readTrace } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-native-api-refusal-'));
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const owner = path.join(root, 'auth-owner'); mkdirSync(owner);
writeFileSync(path.join(owner, 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"fixture"}');
const host = createStandaloneHost({ cwd: root }), home = host.promptobusHome(), task = 'api-proof-t20261101-000000';
createTask(home, { id: task, title: 'Native API publication negatives' });
const baseEnv = { ...process.env, PROMPTOBUS_CODEX_OWNER_HOME: owner };

async function launch(ref, profile = '', previous = null) {
  const address = `worker:${ref}`, launchId = `${ref}-${profile || 'actual'}-generation`;
  const env = { ...baseEnv, [PROBE_VAR]: profile, PROMPTOBUS_ROLE: address };
  upsertParticipant(home, task, participantRecord(address, { harness: 'codex', mode: 'managed', sessionRef: ref, nativeLaunchId: launchId }));
  const codexHome = participantCodexHome({ task, address }, env);
  let persistCalls = 0, realizeCalls = 0, revokes = 0, failure;
  const plan = { argv: [], files: [], cwd: root, prompt: 'Fixture ordinary native API turn', settings: {}, trustProject: false,
    mcpConfig: { mcpServers: {} }, codexHome, prelaunchBinding: {},
    ...(previous ? { resumeThreadId: previous.threadId } : {}),
    service: { launchId, beforeStart: async () => {}, realize: async () => { realizeCalls += 1; }, revoke: async () => { revokes += 1; } } };
  try {
    await codexDriver.spawn(plan, { tool: { bin: path.join(root, 'bin', 'codex') }, host, home, task, address, ref,
      role: 'worker', cwd: root, env, persist: () => { persistCalls += 1; } });
  } catch (error) { failure = error; }
  return { ref, address, env, plan, failure, persistCalls, realizeCalls, revokes };
}

try {
  for (const [profile, pattern] of [['thread-start-error', /fixture native thread\/start refused/], ['thread-start-null', /did not return an owned native thread object/]]) {
    const result = await launch(profile, profile), retained = readSession(result.ref, result.env);
    const trace = readTrace(harness.home, result.address);
    check(`actual owned ${profile} response never reaches native provenance, actor publication or first tools`,
      pattern.test(result.failure?.message ?? '') && result.persistCalls === 0 && result.realizeCalls === 0 && result.revokes === 1
        && !retained?.nativeAdmission && !trace.some(entry => entry.kind === 'tool' || entry.kind === 'turn-start')
        && trace.some(entry => entry.kind === 'native-api-refusal' && entry.method === 'thread/start'), result.failure?.stack);
  }
  const first = await launch('same-real-history');
  const original = await waitFor(() => {
    const record = readSession(first.ref, first.env);
    return record?.turns >= 1 && !record.busy ? record : null;
  }, { timeoutMs: 15000 });
  check('wrong-id fixture first creates a native thread and history through the real owned API',
    !first.failure && !!original?.threadId && !!original?.nativeAdmission);
  const history = path.join(harness.home, 'threads', `${original.threadId}.json`), historyBefore = readFileSync(history, 'utf8');
  await holderAsk(first.ref, 'shutdown', { launchId: original.launchId }, first.env);
  await waitFor(() => !holderAlive(first.ref, first.env) && !pidAlive(readSession(first.ref, first.env)?.appPid), { timeoutMs: 10000 });
  const wrong = await launch(first.ref, 'thread-resume-wrong-id', original);
  const trace = readTrace(harness.home, wrong.address);
  check('wrong resumed native ID refuses before provenance and tools while retaining the actual prior store/history',
    /thread\/resume returned a different thread/.test(wrong.failure?.message ?? '') && wrong.persistCalls === 0 && wrong.realizeCalls === 0
      && wrong.revokes === 1 && existsSync(original.codexHome) && readFileSync(history, 'utf8') === historyBefore
      && trace.some(entry => entry.kind === 'native-api-refusal' && entry.method === 'thread/resume'), wrong.failure?.stack);
  const terminal = await waitFor(() => {
    const record = readSession(first.ref, first.env);
    return !holderAlive(first.ref, first.env) && !pidAlive(record?.appPid);
  }, { timeoutMs: 10000 });
  check('API refusal fixture observes its owned native processes exit without synthesizing Stop', terminal === true);
  check('API refusal fixture never recreates a rollout/store merely to satisfy admission',
    realpathSync(wrong.plan.codexHome) === realpathSync(original.codexHome) && wrong.plan.resumeThreadId === original.threadId
      && sessionFile(first.ref, first.env) === sessionFile(wrong.ref, wrong.env));
} finally { harness.restore(); }
