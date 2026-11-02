import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { contained, processIdentity, recordOf } from './service-state.js';
import type { ProcessIdentity } from './service-state.js';

export function observeCodexAppServer(start = process.ppid): ProcessIdentity {
  let pid = start;
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    const observed = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm=', '-o', 'args='], { encoding: 'utf8', timeout: 2000 });
    const match = observed.status === 0 && /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(observed.stdout);
    if (!match) break;
    if (path.basename(match[2]!) === 'codex' && /(?:^|\s)app-server(?:\s|$)/.test(match[3]!)) {
      const identity = processIdentity(pid);
      if (identity) return identity;
      break;
    }
    pid = Number(match[1]);
  }
  throw new Error('Root hook requires an observable native Codex app-server ancestor');
}

export interface CodexRootTranscript {
  nativeStore: string;
  transcript: string;
  nativeThreadId: string;
}

function readCodexTranscript(input: CodexRootTranscript) {
  if (!path.isAbsolute(input.nativeStore) || !path.isAbsolute(input.transcript) || !/^\S+$/u.test(input.nativeThreadId)) {
    throw new Error('Root identity requires an absolute account store, transcript and exact native thread ID');
  }
  const declared = path.resolve(input.nativeStore), store = realpathSync(declared);
  const transcript = path.resolve(input.transcript);
  const relative = contained(declared, transcript) ? path.relative(declared, transcript)
    : contained(store, transcript) ? path.relative(store, transcript) : null;
  if (!relative) throw new Error('Root transcript is outside its approved native account store');
  let file = store;
  for (const component of relative.split(path.sep)) {
    file = path.join(file, component);
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid())) {
      throw new Error('Root transcript traverses an unowned or symbolic-link native path');
    }
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || (before.mode & 0o022) !== 0 || realpathSync(file) !== file
      || (process.getuid && before.uid !== process.getuid())) throw new Error('Root transcript must be a regular native file without foreign write access');
    const firstLine = () => {
      const bytes = Buffer.alloc(64 * 1024);
      const count = readSync(fd, bytes, 0, bytes.length, 0), end = bytes.subarray(0, count).indexOf(10);
      if (end < 0) throw new Error('Root transcript requires one complete bounded first record');
      return bytes.subarray(0, end).toString('utf8');
    };
    const text = firstLine();
    const first: unknown = JSON.parse(text);
    if (!recordOf(first) || first.type !== 'session_meta' || !recordOf(first.payload)
      || first.payload.id !== input.nativeThreadId
      || typeof first.payload.source !== 'string' || !['cli', 'exec', 'vscode'].includes(first.payload.source)) {
      throw new Error('Root transcript first SessionMeta does not identify an ordinary native root');
    }
    const after = fstatSync(fd), current = lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
      || current.dev !== before.dev || current.ino !== before.ino || realpathSync(file) !== file || firstLine() !== text) {
      throw new Error('Root transcript identity changed while being read');
    }
    return { nativeThreadId: input.nativeThreadId, nativeStore: store, transcript: file, source: first.payload.source };
  } finally { closeSync(fd); }
}

export function readCodexRootTranscript(input: CodexRootTranscript) {
  return readCodexTranscript(input) as ReturnType<typeof readCodexTranscript> & { source: 'cli' | 'exec' | 'vscode' };
}
