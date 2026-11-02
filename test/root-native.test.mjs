import { check, skip } from './check.mjs';
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './sandbox.mjs';
import { readCodexRootTranscript } from '../lib/root-native.js';

const base = realpathSync(makeSandbox('promptobus-root-admission-native-'));
const store = path.join(base, 'account'), sessions = path.join(store, 'sessions');
mkdirSync(sessions, { recursive: true });
const transcript = path.join(sessions, 'root.jsonl');
const meta = source => ({ type: 'session_meta', payload: { id: 'native-root', source } });
const write = records => writeFileSync(transcript, `${records.map(JSON.stringify).join('\n')}\n`, { mode: 0o600 });
const read = (changes = {}) => readCodexRootTranscript({ nativeStore: store, transcript, nativeThreadId: 'native-root', ...changes });
const refused = action => { try { action(); return false; } catch { return true; } };
try {
  for (const source of ['cli', 'vscode', 'exec']) {
    write([meta(source), { type: 'event_msg' }]);
    let proof = null;
    try { proof = read(); } catch {}
    check(`a first native ${source} SessionMeta supplies the exact root ID`, proof?.nativeThreadId === 'native-root' && proof.source === source);
  }
  check('a caller cannot choose another native ID for the same transcript', refused(() => read({ nativeThreadId: 'another-thread' })));
  for (const source of [['cli'], ['vscode'], { value: 'cli' }, { subagent: { parent_thread_id: 'native-parent' } }, 'subagent', 'unknown', null]) {
    write([meta(source)]);
    check(`a non-root SessionMeta source ${JSON.stringify(source)} refuses`, refused(() => read()));
  }
  write([{ ...meta('cli'), type: 'event_msg' }, meta('cli')]);
  check('a later ordinary SessionMeta cannot replace the first native record', refused(() => read()));
  writeFileSync(transcript, JSON.stringify(meta('cli')));
  check('a partial first record refuses rather than searching later bytes', refused(() => read()));
  write([meta('cli')]);
  chmodSync(transcript, 0o622);
  check('a transcript writable by another user refuses', refused(() => read()));
  chmodSync(transcript, 0o600);
  const outside = path.join(base, 'outside.jsonl');
  writeFileSync(outside, `${JSON.stringify(meta('cli'))}\n`, { mode: 0o600 });
  check('an ordinary-looking transcript outside the approved account store refuses', refused(() => read({ transcript: outside })));
  if (process.platform === 'win32') {
    skip('native transcript path aliases', 'The fixture requires POSIX symlinks');
  } else {
    const alias = path.join(base, 'approved-account-alias');
    symlinkSync(store, alias);
    check('an explicitly approved account-root alias has the same canonical store',
      read({ nativeStore: alias, transcript: path.join(alias, 'sessions', 'root.jsonl') }).nativeStore === store);
    const link = path.join(sessions, 'linked.jsonl');
    symlinkSync(outside, link);
    check('a transcript symlink inside the account refuses', refused(() => read({ transcript: link })));
    const directory = path.join(store, 'linked-sessions');
    symlinkSync(sessions, directory);
    check('a symlink below the approved account root refuses', refused(() => read({ transcript: path.join(directory, 'root.jsonl') })));
  }
} finally { rmSync(base, { recursive: true, force: true }); }
