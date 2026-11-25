import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PromptobusHost } from '../dist/index.js';
import type { ManagedNativeStart } from './drivers.js';
import { isSupportedPosixShell, observeRootProcess, processExecutable, processParent } from './root-process.js';
import { contained, readPrivate, recordOf, recordVersion, sameRecordVersion } from './service-state.js';
import { bindManagedNativeStart, readClaudeStartupSession } from './drivers.js';
import { CLIENT_FILE, readManagedServiceHookContext, realizeManagedServiceClient } from './service-launch.js';
import { logWarden, withTaskLock, writeJsonAtomic, taskExists } from './store.js';

async function hookParent(purpose?: 'cursor-hook') {
  let nativeProcess = await observeRootProcess(process.ppid);
  if (nativeProcess && await isSupportedPosixShell(nativeProcess, purpose)) {
    const parent = await processParent(nativeProcess.pid);
    nativeProcess = parent ? await observeRootProcess(parent) : null;
  }
  return nativeProcess;
}

export async function authorizeManagedClaudeExecution(host: PromptobusHost, event: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const file = env[CLIENT_FILE];
  if (!file) throw new Error('Claude execution requires its owned staged client');
  const context = readManagedServiceHookContext(host, file, { env, cwd });
  const record = readPrivate(context.record);
  const evidence = recordOf(record) ? record.nativeAdmissionEvidence ?? record.nativeStartupCandidate : null;
  const command = recordOf(record) && recordOf(record.nativeCommand) ? record.nativeCommand : null;
  if (context.harness !== 'claude' || !recordOf(record) || record.sessionId !== event.session_id
    || !recordOf(evidence) || evidence.kind !== 'native-session-start' || evidence.source !== 'startup'
    || !command || evidence.nativeStore !== command.nativeStore || !isDeepStrictEqual(evidence.executable, command.executable)
    || (!record.nativeAdmissionEvidence && (evidence.launchId !== context.launchId || evidence.ref !== context.ref))
    || evidence.nativeId !== event.session_id || typeof evidence.transcript !== 'string'
    || (event.transcript_path !== undefined && event.transcript_path !== evidence.transcript)
    || !isDeepStrictEqual(evidence.process, await hookParent())) {
    throw new Error('Claude execution requires the same verified fresh startup and native process');
  }
  const published = await authorizeManagedNativeStart(host, { hook_event_name: 'SessionStart', source: 'startup',
    session_id: event.session_id, transcript_path: evidence.transcript }, env, cwd,
    { verifyClaudeRegistry: event.hook_event_name === 'UserPromptSubmit' });
  if (!published) throw new Error('Claude execution has no complete native startup admission');
}

export async function authorizeManagedNativeStart(host: PromptobusHost, event: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv, cwd: string, { verifyClaudeRegistry = false } = {}): Promise<boolean> {
  const file = env[CLIENT_FILE];
  if (!file || (event.hook_event_name !== 'SessionStart' && event.hook_event_name !== 'sessionStart')) return false;
  const context = readManagedServiceHookContext(host, file, { env, cwd });
  const startEvent = context.harness === 'cursor' ? 'sessionStart' : 'SessionStart';
  if (event.hook_event_name !== startEvent) return false;
  const nativeId = event[context.harness === 'cursor' ? 'conversation_id' : 'session_id'];
  if (typeof nativeId !== 'string' || !/^\S+$/u.test(nativeId)) throw new Error('Native start requires the actual hook session identity');
  let { published } = bindManagedNativeStart({ ...context, nativeId, transcript: event.transcript_path });
  let nativeProof: ManagedNativeStart['nativeProof'];
  if (context.harness === 'claude' && event.source === 'startup') {
    const version = recordVersion(context.record), record = readPrivate(context.record);
    const command = recordOf(record) && recordOf(record.nativeCommand) ? record.nativeCommand : null;
    const provenance = recordOf(record) && recordOf(record.nativeLaunchProvenance) ? record.nativeLaunchProvenance : null;
    if (!command || !provenance || provenance.state !== 'candidate' || provenance.nativeStore !== command.nativeStore
      || !recordOf(command.executable) || typeof command.executable.file !== 'string'
      || typeof command.executable.version !== 'string' || !path.isAbsolute(command.executable.file)
      || realpathSync(command.executable.file) !== command.executable.file || !sameRecordVersion(command.executable as { file: string; version: string })
      || !Array.isArray(command.argv) || !command.argv.every(value => typeof value === 'string' && !value.includes('\0'))
      || command.argv[0] !== '--bg' || command.argv.slice(0, -1).some(value => /^--(?:resume|continue|fork-session|init-only|remote|attach)(?:=|$)/.test(value))
      || typeof command.nativeStore !== 'string'
      || !path.isAbsolute(command.nativeStore) || realpathSync(command.nativeStore) !== command.nativeStore
      || typeof event.transcript_path !== 'string' || !path.isAbsolute(event.transcript_path)
      || !contained(command.nativeStore, event.transcript_path) || path.basename(event.transcript_path) !== `${nativeId}.jsonl`) {
      throw new Error('Claude startup lacks its exact owned command and same-ID native transcript/store');
    }
    const nativeProcess = await hookParent();
    if (!nativeProcess || await processExecutable(nativeProcess) !== command.executable.file) {
      throw new Error('Claude startup has no exact owned native process/image generation');
    }
    const executable = { file: command.executable.file, version: command.executable.version };
    const evidence = { kind: 'native-session-start' as const, source: 'startup' as const, nativeStore: command.nativeStore, nativeId,
      process: nativeProcess, transcript: event.transcript_path, executable };
    const candidate = { ...evidence, launchId: context.launchId, ref: context.ref };
    if (recordOf(record) && record.nativeStartupCandidate !== undefined && !isDeepStrictEqual(record.nativeStartupCandidate, candidate)) {
      throw new Error('Claude startup candidate changed its exact launch, native process or store');
    }
    const staged = { ...(record as Record<string, unknown>), nativeStartupCandidate: candidate };
    const sameStagedCandidate = () => isDeepStrictEqual(readPrivate(context.record), staged);
    if (!sameRecordVersion(version)) {
      if (sameStagedCandidate()) return false;
      throw new Error('Claude startup record changed during native observation');
    }
    let transcript = command.nativeStore;
    let missing = false;
    for (const part of path.relative(command.nativeStore, event.transcript_path).split(path.sep)) {
      transcript = path.join(transcript, part);
      let entry;
      try { entry = lstatSync(transcript); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing = true; break;
      }
      if (entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o022) !== 0) throw new Error('Claude native transcript path is not owned');
    }
    if (missing && !verifyClaudeRegistry) {
      const stage = () => {
        if (sameStagedCandidate()) return;
        if (!sameRecordVersion(version)) throw new Error('Claude startup record changed before candidate publication');
        writeJsonAtomic(context.record, staged, { mode: 0o600 });
      };
      if (taskExists(context.home, context.task)) withTaskLock(context.home, context.task, stage); else stage();
      return false;
    }
    let registry;
    if (missing) {
      const nativeCwd = realpathSync(cwd);
      registry = readClaudeStartupSession({ executable: command.executable.file, nativeStore: command.nativeStore }, nativeId, context.ref, nativeCwd);
      if (command.cwd !== nativeCwd || !registry) throw new Error('Claude startup has no exact owned native registry session');
    } else if (!lstatSync(transcript).isFile() || realpathSync(transcript) !== transcript) {
      throw new Error('Claude native transcript is not a regular file');
    }
    if (!sameRecordVersion(version)) throw new Error('Claude startup record changed during native observation');
    nativeProof = { version, binding: { harness: 'claude', nativeStore: command.nativeStore, nativeId, process: nativeProcess },
      evidence: { ...evidence, ...(registry ? { registry } : {}) } };
  }
  if (nativeProof) ({ published } = bindManagedNativeStart({ ...context, nativeId, transcript: event.transcript_path, nativeProof }));
  if (context.harness === 'cursor') {
    const snapshot = () => {
      const read = () => ({ version: recordVersion(context.record), record: readPrivate(context.record) });
      return taskExists(context.home, context.task) ? withTaskLock(context.home, context.task, read) : read();
    };
    const initial = snapshot(), record = initial.record;
    let version = initial.version;
    const command = recordOf(record) && recordOf(record.nativeCommand) ? record.nativeCommand : null;
    if (!command || !recordOf(command.executable) || typeof command.executable.file !== 'string' || typeof command.executable.version !== 'string'
      || !recordOf(command.launcher) || typeof command.launcher.file !== 'string' || typeof command.launcher.version !== 'string'
      || !recordOf(command.bundle) || typeof command.bundle.file !== 'string' || typeof command.bundle.version !== 'string'
      || !sameRecordVersion(command.executable as { file: string; version: string })
      || !sameRecordVersion(command.launcher as { file: string; version: string })
      || !sameRecordVersion(command.bundle as { file: string; version: string })) throw new Error('Cursor hook has no current approved native image chain');
    let observed: Awaited<ReturnType<typeof hookParent>> = null;
    for (let attempt = 0; ; attempt++) {
      const native = await hookParent('cursor-hook');
      const image = native && await processExecutable(native);
      if (!native || image !== command.executable.file || (observed && !isDeepStrictEqual(observed, native))) {
        const reason = `Cursor sessionStart native process mismatch: ${JSON.stringify({ hookParentPid: process.ppid, native, image })}`;
        if (context.home && taskExists(context.home, context.task)) logWarden(context.home, context.task, reason);
        throw new Error(reason);
      }
      observed = native;
      try {
        if (!sameRecordVersion(version)) throw new Error('Cursor hook record changed during process observation');
        ({ published } = bindManagedNativeStart({ ...context, nativeId, nativeProcessEvidence: { version, process: native,
          executable: { file: command.executable.file, version: command.executable.version } } }));
        break;
      } catch (error) {
        if (attempt || sameRecordVersion(version) || !recordOf(record) || !record.nativePersistNonce) throw error;
        const next = snapshot(), latest = next.record;
        version = next.version;
        if (!recordOf(latest) || !Number.isSafeInteger(latest.turns) || Number(latest.turns) <= (Number(record.turns) || 0)
          || !recordOf(latest.last) || latest.last.session !== nativeId
          || !isDeepStrictEqual({ ...record, turns: null, last: null }, { ...latest, turns: null, last: null })) throw error;
      }
    }
    const current = readPrivate(context.record);
    if (!recordOf(current) || !recordOf(current.nativeAdmission)) return false;
  }
  if (!published) return false;
  await realizeManagedServiceClient(host, file, nativeId, { env, cwd });
  return true;
}
