import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, stubCommand } from './sandbox.mjs';
const runtime = process.argv[2] ? pathToFileURL(`${path.resolve(process.argv[2])}/`) : new URL('../', import.meta.url);
const { bindManagedNativeStart } = await import(new URL('lib/drivers.js', runtime));
import { closeTask, createTask, participantOf, participantRecord, readTask, taskExists, taskFile, upsertParticipant, readWake } from '../lib/store.js';
import { readPrivate, recordVersion, writePrivate } from '../lib/service-state.js';

const scratch = realpathSync(makeSandbox('promptobus-managed-native-'));
const home = path.join(scratch, '.promptobus');
const refuses = (call, pattern) => {
  try { call(); return false; }
  catch (error) { return pattern.test(error.message); }
};
const { cursorAssignment, freshPersistCommand, persistStartedName } = await import(new URL('lib/cursor-persist.js', runtime));
const nonce = '11111111-1111-4111-8111-111111111111';
const options = ['persist', '--workspace', scratch, '--trust', '--force', '--model', 'fixture'];
const fixed = `Read the complete task instructions in .cursor/promptobus-${nonce}.md before doing any work.`;
check('fresh Cursor argv accepts only the generation-specific assignment instruction', cursorAssignment?.(nonce)?.argument === fixed && freshPersistCommand([...options, '--', fixed], scratch, nonce)
  && !['resume', '--continue', '--approve-mcps', fixed + ' --resume'].some(text => freshPersistCommand([...options, '--', text], scratch, nonce)));
const receipt = path.join(scratch, 'primary.stderr'), fd = openSync(receipt, 'wx+');
const started = name => `Started persistent session ${name}. Use /detach to leave it running; reconnect with agent persist list.\n`;
try {
  writeFileSync(receipt, 'diagnostic\n' + started('cursor-owned').trimEnd());
  check('a partial start receipt does not select a pane', persistStartedName?.(fd) === null);
  writeFileSync(receipt, 'diagnostic\n' + started('cursor-owned'));
  check('a complete primary receipt survives leading diagnostics', persistStartedName?.(fd) === 'cursor-owned');
  writeFileSync(receipt, started('cursor-owned') + started('cursor-other'));
  check('conflicting primary start receipts cannot select a pane', refuses(() => persistStartedName(fd), /conflicting start receipts/));
} finally { closeSync(fd); }

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
  if (harness === 'cursor') {
    const pending = { ...record, nativePersistNonce: ref, nativeCreationPending: { command: 'persist', launchId: record.launchId, nonce: ref } };
    writePrivate(file, pending);
    const staged = readFileSync(file, 'utf8');
    const early = bindManagedNativeStart(input);
    check('fresh Cursor hook alone cannot publish the sender or change the pending primary record',
      !early.published && readFileSync(file, 'utf8') === staged && !participantOf(readTask(home, task), address).metadata.sessionId);
    writePrivate(file, record);
  }
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
export { readClaudeStartupSession } from ${JSON.stringify(new URL('lib/drivers.js', runtime).href)};
export const observeRootProcess = async pid => pid === process.ppid ? fixture.shell : pid === fixture.native.pid ? fixture.native : null;
export const isSupportedPosixShell = async (identity, purpose) => identity === fixture.shell && (fixture.shellAllowed || (fixture.cursorZsh && purpose === 'cursor-hook'));
export const processParent = async pid => pid === fixture.shell.pid ? fixture.parent : null;
export const processExecutable = async identity => { fixture.onExecutable?.(identity); return identity === fixture.shell ? '/bin/bash' : fixture.nativeImage; };
`);
const observationUrl = pathToFileURL(observations).href;
const state = path.join(scratch, 'observed-state.mjs');
const actualState = new URL('lib/service-state.js', runtime).href;
writeFileSync(state, `export * from ${JSON.stringify(actualState)};
import {recordVersion as stat} from ${JSON.stringify(actualState)};
import {fixture} from ${JSON.stringify(observationUrl)};
export function recordVersion(file){ const value=stat(file); fixture.afterVersion?.(file); return value; }`);
let source = readFileSync(new URL('lib/native-start.js', runtime), 'utf8');
for (const module of ['root-process', 'drivers', 'service-launch', 'service-state', 'store']) {
  const original = `from './${module}.js'`, replacement = module === 'service-state' ? pathToFileURL(state).href : module === 'store'
    ? new URL(`lib/${module}.js`, runtime).href : observationUrl;
  if (!source.includes(original)) throw new Error(`Native start fixture could not replace ${module} boundary`);
  source = source.replaceAll(original, `from ${JSON.stringify(replacement)}`);
}
const authorization = path.join(scratch, 'native-start-authorization.mjs'); writeFileSync(authorization, source);
const { fixture } = await import(observationUrl);
const { authorizeManagedNativeStart } = await import(pathToFileURL(authorization).href);
const registryFile = path.join(scratch, 'registry.json');
const otherStore = path.join(scratch, 'other-store');
mkdirSync(otherStore, { mode: 0o700 });
stubCommand(scratch, 'registry-claude', `import { readFileSync } from 'node:fs';
if (process.argv.slice(2).join(' ') !== 'agents --json') process.exit(64);
const file = process.env.CLAUDE_CONFIG_DIR === ${JSON.stringify(otherStore)}
  ? ${JSON.stringify(path.join(otherStore, 'registry.json'))} : ${JSON.stringify(registryFile)};
process.stdout.write(readFileSync(file));`);
const registryExecutable = path.join(scratch, process.platform === 'win32' ? 'registry-claude.cmd' : 'registry-claude');
const transcript = path.join(scratch, 'observed-native.jsonl'); writeFileSync(transcript, '{}\n');
for (const harness of ['claude', 'cursor']) {
  const executable = recordVersion(realpathSync(harness === 'claude' ? registryExecutable : process.execPath));
  const record = path.join(scratch, `${harness}-observed.json`);
  const nativeCommand = { executable, launcher: executable, bundle: executable, argv: ['--bg', 'fixture'], nativeStore: scratch, cwd: scratch };
  const reset = () => {
    writePrivate(record, { nativeCommand, nativeLaunchProvenance: { state: 'candidate', nativeStore: scratch } });
    Object.assign(fixture, { context: { harness, record, home, task: hintedTask }, bindings: [], shell: { pid: process.ppid, birth: 'simulated-shell-birth' },
      native: { pid: process.ppid + 1, birth: 'simulated-native-birth' }, parent: process.ppid + 1,
      shellAllowed: true, cursorZsh: false, nativeImage: executable.file, onExecutable: null, afterVersion: null });
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
  reset();
  Object.assign(fixture, { shellAllowed: false, cursorZsh: true });
  let zshFailure;
  try { await authorize(); } catch (error) { zshFailure = error; }
  check(`${harness} applies its own native hook shell policy for Darwin zsh`,
    harness === 'cursor' ? !zshFailure && !!proof() : !!zshFailure && !proof());
  if (harness === 'cursor') {
    reset();
    writePrivate(record, { nativeCommand, nativePersistNonce: nonce, turns: 0 });
    const lockedReads = [], wake = () => writePrivate(record, { ...readPrivate(record), turns: 1, last: { session: event.conversation_id } });
    fixture.afterVersion = file => {
      if (file !== record) return;
      const locked = existsSync(path.join(home, 'tasks', hintedTask, '.lock'));
      lockedReads.push(locked);
      if (lockedReads.length === 1) {
        if (locked) fixture.onExecutable = () => { fixture.onExecutable = null; wake(); };
        else wake();
      }
    };
    let tornError;
    try { await authorize(); } catch (error) { tornError = error; }
    check('Cursor hook snapshots both initial and retry revisions with their record under the wake lock',
      !tornError && !!proof() && JSON.stringify(lockedReads) === '[true,true]', tornError?.message);
    for (const change of ['wake', 'foreign wake', 'generation', 'same bytes', 'second wake']) {
      reset();
      writePrivate(record, { nativeCommand, nativePersistNonce: nonce, turns: 0 });
      let observations = 0;
      fixture.onExecutable = () => {
        observations += 1;
        if (observations > 1 && change !== 'second wake') return;
        const before = readPrivate(record);
        writePrivate(record, change === 'same bytes' ? before : { ...before, turns: observations,
          last: { session: change === 'foreign wake' ? 'another-native' : event.conversation_id },
          ...(change === 'generation' ? { nativePersistNonce: 'replacement' } : {}) });
      };
      let failure;
      try { await authorize(); } catch (error) { failure = error; }
      check(`Cursor hook physical observation across an early Stop: ${change}`, change === 'wake'
        ? !failure && observations === 2 && proof()?.nativeProcessEvidence.version.version === recordVersion(record).version
        : !!failure && !proof(), failure?.message);
    }
  }
  if (harness === 'claude') {
    reset();
    const missingTranscript = path.join(scratch, 'delayed', `${event.session_id}.jsonl`);
    const current = readPrivate(record);
    Object.assign(fixture.context, { home: scratch, task: 'future-native-t20261117-000000', ref: 'owned-launch', launchId: 'same-launch' });
    const candidate = {
      kind: 'native-session-start', source: 'startup', nativeStore: scratch, nativeId: event.session_id,
      process: fixture.native, transcript: missingTranscript, executable, ref: 'owned-launch', launchId: 'same-launch',
    };
    fixture.onExecutable = () => writePrivate(record, { ...current, nativeStartupCandidate: candidate });
    let duplicate, error;
    try {
      duplicate = await authorizeManagedNativeStart({}, { ...event, transcript_path: missingTranscript },
        { PROMPTOBUS_CLIENT_FILE: record }, scratch);
    } catch (caught) { error = caught; }
    check('a concurrent Claude startup with the exact already staged candidate defers admission',
      !error && duplicate === false && !proof() && readPrivate(record).nativeStartupCandidate.launchId === candidate.launchId,
      error?.message);
    const row = { sessionId: event.session_id, name: candidate.ref, cwd: scratch, state: 'working' };
    for (const [name, sessions, accepted] of [
      ['exact owned session', [row], true],
      ['wrong name', [{ ...row, name: 'another launch' }], false],
      ['wrong full ID', [{ ...row, sessionId: 'another-session' }], false],
      ['wrong working directory', [{ ...row, cwd: path.dirname(scratch) }], false],
      ['duplicate rows', [row, row], false],
    ]) {
      reset();
      Object.assign(fixture.context, { home: scratch, task: 'future-native-t20261117-000000', ref: candidate.ref, launchId: candidate.launchId });
      writeFileSync(registryFile, JSON.stringify(sessions));
      let refusal;
      try { await authorizeManagedNativeStart({}, { ...event, transcript_path: missingTranscript },
        { PROMPTOBUS_CLIENT_FILE: record }, scratch, { verifyClaudeRegistry: true }); }
      catch (caught) { refusal = caught; }
      check(`Claude before the transcript recognizes only the exact native registry row: ${name}`,
        accepted ? !refusal && proof()?.nativeProof.evidence.registry?.sessionId === event.session_id
          : /native registry/.test(refusal?.message ?? '') && !proof(), refusal?.message);
    }
    reset();
    Object.assign(fixture.context, { home: scratch, task: 'future-native-t20261117-000000', ref: candidate.ref, launchId: candidate.launchId });
    writeFileSync(registryFile, '[]');
    writeFileSync(path.join(otherStore, 'registry.json'), JSON.stringify([row]));
    const previousStore = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = otherStore;
    let refusal;
    try {
      await authorizeManagedNativeStart({}, { ...event, transcript_path: missingTranscript },
        { PROMPTOBUS_CLIENT_FILE: record }, scratch, { verifyClaudeRegistry: true });
    } catch (caught) { refusal = caught; }
    finally {
      if (previousStore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousStore;
    }
    check('Claude before the transcript refuses an exact row that exists only in another store',
      /native registry/.test(refusal?.message ?? '') && !proof(), refusal?.message);
  }
}
