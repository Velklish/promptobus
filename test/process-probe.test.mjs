import { isDeepStrictEqual } from 'node:util';
import { check } from './check.mjs';
import { processProbe } from './process-probe.mjs';

const matched = { status: 0, signal: null, error: undefined, stdout: ' 123\n456\n', stderr: '' };
const pgrepArgs = ['-f', '/owned stand/[s]tub'];
const deniedStderr = '  sysmon request failed\r\npgrep: Cannot get process list\n ';
const missing = Object.assign(new Error('spawnSync command ENOENT'), {
  code: 'ENOENT', errno: -2, syscall: 'spawnSync command', path: 'command',
});

function probe(name, command, args, result) {
  let call, value, error;
  try {
    value = processProbe(command, args, (bin, argv, options) => {
      call = { bin, argv, options };
      return result;
    });
  } catch (e) {
    error = e;
  }
  check(`${name}: exact command, argv and utf8`,
    isDeepStrictEqual(call, { bin: command, argv: args, options: { encoding: 'utf8' } }),
    JSON.stringify(call));
  return { value, error };
}

function failure(name, command, args, result) {
  const { value, error } = probe(name, command, args, result);
  check(name,
    error instanceof Error && value === undefined
      && error.command === command && isDeepStrictEqual(error.args, args)
      && error.status === result.status && error.signal === result.signal
      && error.error === result.error && error.stderr === result.stderr
      && error.message.includes(command)
      && (result.stderr === null || error.message.includes(result.stderr)),
    JSON.stringify({ value, error: error?.message, command, args, status: result.status,
      signal: result.signal, spawnError: result.error?.message, stderr: result.stderr }));
}

{
  const name = 'process probe: pgrep status 0 preserves matching output';
  const { value, error } = probe(name, 'pgrep', pgrepArgs, matched);
  check(name, error === undefined && value === matched.stdout, JSON.stringify({ value, error: error?.message }));
}
{
  const name = 'process probe: pgrep status 1 with no error or signal is supported no match';
  const { value, error } = probe(name, 'pgrep', pgrepArgs, { ...matched, status: 1, stdout: '' });
  check(name, error === undefined && value === '', JSON.stringify({ value, error: error?.message }));
}

failure('process probe: pgrep status 3 is an error, not no match', 'pgrep', pgrepArgs,
  { ...matched, status: 3, stdout: '', stderr: deniedStderr });
failure('process probe: pgrep ENOENT retains the command and spawn error', 'pgrep', pgrepArgs,
  { ...matched, status: null, error: missing, stdout: null, stderr: null });
failure('process probe: pgrep signal is an error, not no match', 'pgrep', pgrepArgs,
  { ...matched, status: null, signal: 'SIGTERM', stdout: '', stderr: ' interrupted\r\n' });
failure('process probe: pgrep status 1 with a spawn error is not supported no match', 'pgrep', pgrepArgs,
  { ...matched, status: 1, error: missing, stdout: '', stderr: ' denied\n' });
failure('process probe: pgrep status 1 with a signal is not supported no match', 'pgrep', pgrepArgs,
  { ...matched, status: 1, signal: 'SIGTERM', stdout: '', stderr: ' interrupted\n' });
failure('process probe: failed pgrep output never becomes positive PID evidence', 'pgrep', pgrepArgs,
  { ...matched, status: 3, stderr: deniedStderr });

const psSites = [
  { site: 'list', args: ['-Ao', 'pid=,command='], stdout: ' 123 /owned stand/tool child\n' },
  { site: 'environment lookup', args: ['eww', '-o', 'command=', '-p', '123'],
    stdout: 'worker-server PROMPTOBUS_CURSOR_SESSION=/owned stand/session\n' },
  { site: 'parent lookup', args: ['-o', 'ppid=', '-p', '123'], stdout: ' 456\n' },
];
for (const { site, args, stdout } of psSites) {
  const name = `process probe: ps ${site} status 0 preserves output`;
  const { value, error } = probe(name, 'ps', args, { ...matched, stdout });
  check(name, error === undefined && value === stdout, JSON.stringify({ value, error: error?.message }));
  failure(`process probe: ps ${site} status 1 is an error, not measured empty`, 'ps', args,
    { ...matched, status: 1, stdout: '', stderr: ' ps: operation not permitted\r\n ' });
  failure(`process probe: ps ${site} ENOENT retains the command and spawn error`, 'ps', args,
    { ...matched, status: null, error: missing, stdout: null, stderr: null });
  failure(`process probe: ps ${site} signal is an error, not measured empty`, 'ps', args,
    { ...matched, status: null, signal: 'SIGTERM', stdout: '', stderr: ' interrupted\r\n' });
  failure(`process probe: failed ps ${site} output never becomes positive process evidence`, 'ps', args,
    { ...matched, status: 3, stdout, stderr: ' ps: permission denied\r\n ' });
}
{
  const name = 'process probe: ps list status 0 with empty output is measured empty';
  const { value, error } = probe(name, 'ps', psSites[0].args, { ...matched, stdout: '' });
  check(name, error === undefined && value === '', JSON.stringify({ value, error: error?.message }));
}
