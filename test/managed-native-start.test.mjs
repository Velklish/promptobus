import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { bindManagedNativeStart } from '../lib/drivers.js';
import { closeTask, createTask, participantOf, participantRecord, readTask, taskExists, taskFile, upsertParticipant, readWake } from '../lib/store.js';
import { readPrivate, recordVersion, writePrivate } from '../lib/service-state.js';

const scratch = realpathSync(makeSandbox('promptobus-managed-native-'));
const home = path.join(scratch, '.promptobus');
const refuses = (call, pattern) => {
  try { call(); return false; }
  catch (error) { return pattern.test(error.message); }
};
for (const harness of ['claude', 'cursor', 'codex', 'opencode']) {
  const task = `${harness}-t20261101-000001`, address = 'worker:own', ref = `own-${harness}`;
  const file = path.join(scratch, `${harness}.json`), idField = harness === 'cursor' ? 'chatId' : harness === 'codex' ? 'threadId' : 'sessionId';
  const nativeId = `actual-${harness}`;
  const record = { ref, home, task, address, launchId: 'owned-generation', turns: 7,
    [idField]: ['codex', 'opencode'].includes(harness) ? nativeId : null,
    ...(harness === 'claude' ? { expectedSessionId: nativeId } : {}) };
  writePrivate(file, record);
  createTask(home, { id: task, title: 'owned native start' });
  upsertParticipant(home, task, participantRecord(address, { harness, sessionRef: ref, sessionRecord: file }));
  const input = { harness, home, task, address, ref, record: file, launchId: record.launchId, nativeId };
  const before = readFileSync(file, 'utf8');
  const foreignGeneration = refuses(() => bindManagedNativeStart({ ...input, launchId: 'foreign-generation' }), /owned launch record/);
  check(`${harness} refuses a changed generation before native publication`, foreignGeneration && readFileSync(file, 'utf8') === before
    && !participantOf(readTask(home, task), address).metadata.sessionId);
  const foreignRef = refuses(() => bindManagedNativeStart({ ...input, ref: `${ref}-foreign` }), /owned launch record/);
  check(`${harness} refuses a changed launch ref before native publication`, foreignRef && readFileSync(file, 'utf8') === before
    && !participantOf(readTask(home, task), address).metadata.sessionId);
  const transcript = path.join(scratch, `${nativeId}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ sessionId: nativeId })}\n`);
  const started = bindManagedNativeStart({ ...input, transcript }), own = readPrivate(file);
  check(`${harness} binds only the owned native id without a turn-end wake`, started.published && own[idField] === nativeId
    && own.turns === 7 && !readWake(home, task, address)
    && (['codex', 'opencode'].includes(harness) || participantOf(readTask(home, task), address).metadata.sessionId === nativeId));
  if (['claude', 'cursor'].includes(harness)) check(`${harness} records actual hook transcript evidence without inventing native store or process birth`,
    own.nativeStartEvidence.nativeId === nativeId && own.nativeStartEvidence.transcript === realpathSync(transcript)
      && own.nativeAdmission === undefined && own.nativeAdmissionUnknown.nativeId === nativeId);
  const bound = readFileSync(file, 'utf8');
  const replacement = refuses(() => bindManagedNativeStart({ ...input, nativeId: 'replacement-id' }), /disagrees/);
  check(`${harness} refuses a different id after binding`, replacement && readFileSync(file, 'utf8') === bound);
  const participant = participantOf(readTask(home, task), address);
  upsertParticipant(home, task, { ...participant, metadata: { ...participant.metadata, sessionRecord: `${file}-foreign` } });
  const replaced = refuses(() => bindManagedNativeStart(input), /published participant/);
  check(`${harness} cannot reuse a replaced participant pointer`, replaced && readFileSync(file, 'utf8') === bound);
  upsertParticipant(home, task, participant);
  closeTask(home, task);
  const done = readFileSync(taskFile(home, task), 'utf8');
  const closed = refuses(() => bindManagedNativeStart(input), /not active/)
    && refuses(() => bindManagedNativeStart({ ...input, deferTaskBinding: true }), /not active/);
  check(`${harness} refuses a closed task before native or journal writes`, closed
    && readFileSync(file, 'utf8') === bound && readFileSync(taskFile(home, task), 'utf8') === done);

}

const hintedTask = 'hinted-claude-t20261101-000001', hintedAddress = 'worker:hinted', hintedRef = 'hinted-claude';
const hintedFile = path.join(scratch, 'hinted-claude.json');
createTask(home, { id: hintedTask, title: 'actual native identity exceeds argv hint' });
upsertParticipant(home, hintedTask, participantRecord(hintedAddress, { harness: 'claude', sessionRef: hintedRef, sessionRecord: hintedFile }));
writePrivate(hintedFile, { home, task: hintedTask, address: hintedAddress, ref: hintedRef, launchId: 'hinted-launch',
  sessionId: null, expectedSessionId: 'requested-uuid-hint' });
let hintedFailure;
try {
  bindManagedNativeStart({ harness: 'claude', home, task: hintedTask, address: hintedAddress, ref: hintedRef,
    launchId: 'hinted-launch', record: hintedFile, nativeId: 'actual-owned-native' });
} catch (error) { hintedFailure = error; }
check('Claude binds the actual owned hook identity when the requested UUID hint differs',
  !hintedFailure && readPrivate(hintedFile).sessionId === 'actual-owned-native'
    && participantOf(readTask(home, hintedTask), hintedAddress).metadata.sessionId === 'actual-owned-native', hintedFailure?.message);
const future = 'future-t20261101-000001', file = path.join(scratch, 'future.json');
writePrivate(file, { home, task: future, address: 'orchestrator', ref: 'future-owner', launchId: 'future-generation', sessionId: null, expectedSessionId: 'future-native' });
const deferred = { harness: 'claude', home, task: future, address: 'orchestrator', ref: 'future-owner', record: file, launchId: 'future-generation', nativeId: 'future-native' };
const missingOwner = refuses(() => bindManagedNativeStart(deferred), /published participant/);
const bound = bindManagedNativeStart({ ...deferred, deferTaskBinding: true });
check('deferred native publication creates no fabricated owner or task', missingOwner && !bound.published && !taskExists(home, future)
  && readPrivate(file).sessionId === 'future-native');

// Simulated process observations exercise both native-start callers; no native process is launched.
const observations = path.join(scratch, 'native-start-observations.mjs');
writeFileSync(observations, `export const fixture = {};
export const CLIENT_FILE = 'PROMPTOBUS_CLIENT_FILE';
export const readManagedServiceHookContext = () => fixture.context;
export const bindManagedNativeStart = input => { fixture.bindings.push(input); return { published: false }; };
export const realizeManagedServiceClient = async () => { throw new Error('Unpublished fixture must not realize a client'); };
export const observeRootProcess = async pid => pid === process.ppid ? fixture.shell : pid === fixture.native.pid ? fixture.native : null;
export const isSupportedPosixShell = async identity => identity === fixture.shell && fixture.shellAllowed;
export const processParent = async pid => pid === fixture.shell.pid ? fixture.parent : null;
export const processExecutable = async identity => { fixture.onExecutable?.(identity); return identity === fixture.shell ? '/bin/bash' : fixture.nativeImage; };
`);
const observationUrl = pathToFileURL(observations).href;
let source = readFileSync(new URL('../lib/native-start.js', import.meta.url), 'utf8');
for (const module of ['root-process', 'drivers', 'service-launch', 'service-state']) {
  const original = `from './${module}.js'`, replacement = module === 'service-state'
    ? new URL('../lib/service-state.js', import.meta.url).href : observationUrl;
  if (!source.includes(original)) throw new Error(`Native start fixture could not replace ${module} boundary`);
  source = source.replaceAll(original, `from ${JSON.stringify(replacement)}`);
}
const authorization = path.join(scratch, 'native-start-authorization.mjs'); writeFileSync(authorization, source);
const { fixture } = await import(observationUrl);
const { authorizeManagedNativeStart } = await import(pathToFileURL(authorization).href);
const executable = recordVersion(realpathSync(process.execPath));
const transcript = path.join(scratch, 'observed-native.jsonl'); writeFileSync(transcript, '{}\n');
for (const harness of ['claude', 'cursor']) {
  const record = path.join(scratch, `${harness}-observed.json`);
  const nativeCommand = { executable, launcher: executable, bundle: executable, argv: ['--bg', 'fixture'], nativeStore: scratch };
  const reset = () => {
    writePrivate(record, { nativeCommand, nativeLaunchProvenance: { state: 'candidate', nativeStore: scratch } });
    Object.assign(fixture, { context: { harness, record }, bindings: [], shell: { pid: process.ppid, birth: 'simulated-shell-birth' },
      native: { pid: process.ppid + 1, birth: 'simulated-native-birth' }, parent: process.ppid + 1,
      shellAllowed: true, nativeImage: executable.file, onExecutable: null });
  };
  const event = { hook_event_name: harness === 'cursor' ? 'sessionStart' : 'SessionStart', source: 'startup',
    session_id: 'observed-native', conversation_id: 'observed-native', transcript_path: transcript };
  const authorize = () => authorizeManagedNativeStart({}, event, { PROMPTOBUS_CLIENT_FILE: record }, scratch);
  const proof = () => fixture.bindings.find(input => input.nativeProof || input.nativeProcessEvidence);
  reset();
  let positiveError;
  try { await authorize(); } catch (error) { positiveError = error; }
  check(`${harness} native start uses the shared protected-shell decision before exact native image proof`,
    !positiveError && (harness === 'claude' ? proof()?.nativeProof.binding.process : proof()?.nativeProcessEvidence.process) === fixture.native,
    positiveError?.message);
  for (const [name, change] of [
    ['unapproved or unknown shell', () => { fixture.shellAllowed = false; }],
    ['different direct parent', () => { fixture.parent += 1; }],
    ['different native image', () => { fixture.nativeImage = '/actor/native'; }],
    ['changed record generation', () => { fixture.onExecutable = () => writePrivate(record, { replaced: true }); }],
  ]) {
    reset(); change();
    let error;
    try { await authorize(); } catch (caught) { error = caught; }
    check(`${harness} native start retains exact ancestry, image and generation refusal: ${name}`, Boolean(error) && !proof(), error?.message);
  }
}
