import { check } from './check.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox, makeSockPath } from './sandbox.mjs';
import { installHarness as installClaude, sessionFile, writeSession } from './harness.mjs';
import { installHarness as installCursor, serverDir } from './harness-cursor.mjs';
import { CURSOR_TMUX_SERVER } from '../lib/cursor-persist.js';
import { pollEnvironmentOf } from '../lib/harness-home.js';

const ROOT = makeSandbox('promptobus-shared-warden-');
const claudeBin = path.join(ROOT, 'claude-bin'), cursorBin = path.join(ROOT, 'cursor-bin');
const claude = await installClaude({ binDir: claudeBin, sock: makeSockPath('a2h-') });
const cursor = await installCursor({ binDir: cursorBin });
const holder = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'ignore'] });
await new Promise((resolve, reject) => { holder.once('error', reject); holder.stdout.once('data', resolve); });
if (!Number.isInteger(holder.pid) || holder.pid <= 1) throw new Error('owned fixture holder has no valid PID');
const claudeId = 'owned-poll-claude', cursorId = 'owned-poll-cursor';
const cursorRecord = path.join(serverDir(cursor.home, CURSOR_TMUX_SERVER), 'sessions', `${cursorId}.json`);
try {
  writeSession(claude.home, { id: claudeId, sessionId: claudeId, name: claudeId, pid: holder.pid, cwd: ROOT });
  mkdirSync(path.dirname(cursorRecord), { recursive: true });
  writeFileSync(cursorRecord, JSON.stringify({ name: cursorId, panePid: holder.pid, cwd: ROOT, options: { '@cursor_chat_id': cursorId } }));
  const env = pollEnvironmentOf(process.env);
  check('poll fixtures use the ordinary common environment without private stand control variables', !('PROMPTOBUS_E2E_HARNESS' in env)
    && !('PROMPTOBUS_E2E_CURSOR' in env));
  const run = (bin, args) => spawnSync(bin, args, { env, encoding: 'utf8' });
  const listed = run(path.join(claudeBin, 'claude'), ['agents', '--json']);
  check('the Claude binary lists its captured owned home under the projected poll environment', listed.status === 0
    && JSON.parse(listed.stdout).some(row => row.id === claudeId && row.pid === holder.pid && row.cwd === ROOT), listed.stderr);
  const tmux = run(path.join(cursorBin, 'tmux'), ['-L', CURSOR_TMUX_SERVER, 'list-sessions', '-F', '#{session_name}']);
  check('the tmux binary lists its captured owned Cursor home under the projected poll environment', tmux.status === 0
    && tmux.stdout.trim() === cursorId, tmux.stderr);
  const agent = run(path.join(cursorBin, 'cursor-agent'), ['persist', 'list']);
  check('the Cursor binary lists the same captured owned session without a stand variable', agent.status === 0
    && agent.stdout.includes(`Session: ${cursorId}`) && agent.stdout.includes(`Chat ID: ${cursorId}`), agent.stderr);
} finally {
  rmSync(sessionFile(claude.home, claudeId), { force: true }); rmSync(cursorRecord, { force: true });
  const exited = new Promise(resolve => holder.once('close', resolve)); holder.stdin.end(); await exited;
  cursor.restore(); claude.restore();
}
