import { check, skip } from './check.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './sandbox.mjs';
import { writeRootExecPlan } from '../lib/launch-exec.js';

if (process.platform === 'win32') {
  skip('the root exec launcher', 'The implementation requires a POSIX shell');
} else {
  const base = realpathSync(makeSandbox('promptobus-test-root-exec-'));
  const directory = path.join(base, 'private');
  const output = path.join(base, 'result.json');
  const native = path.join(base, 'native.mjs');
  const secret = "value with 'quotes', $(touch NEVER), `literal`, $HOME\nand a second line";
  const args = ['a b', "single'quote", '$(touch NEVER)', 'a\nb', ''];
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(native, `import{writeFileSync,existsSync}from'node:fs';
writeFileSync(process.env.RESULT,JSON.stringify({pid:process.pid,args:process.argv.slice(2),secret:process.env.ROOT_SECRET,
removed:process.env.ROOT_ANCESTOR,planExists:existsSync(process.env.PLAN)}));\n`);
  try {
    const file = writeRootExecPlan(directory, { file: process.execPath, args: [native, ...args],
      env: { RESULT: output, ROOT_SECRET: secret, ROOT_ANCESTOR: null } });
    check('the root exec plan is an owner-only regular file', statSync(file).isFile() && (statSync(file).mode & 0o777) === 0o600);
    const child = spawn('/bin/sh', ['-c', '. "$1"', 'promptobus-launch', file], {
      cwd: base, env: { ...process.env, ROOT_ANCESTOR: 'foreign', PLAN: file }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    check('the shell replaces itself with the selected native command', result.code === 0 && result.signal === null, stderr);
    const receipt = JSON.parse(readFileSync(output, 'utf8'));
    check('the launched native process keeps the launcher PID without a Node proxy', receipt.pid === child.pid);
    check('exec preserves every argument including empty strings and newlines', JSON.stringify(receipt.args) === JSON.stringify(args));
    check('a private environment value reaches the process without becoming an argument', receipt.secret === secret && !receipt.args.includes(secret));
    check('an inherited actor value is removed before exec', receipt.removed === undefined);
    check('the private plan is deleted before native execution', receipt.planExists === false && !existsSync(file));
    check('shell syntax in arguments and private values stays literal', !existsSync(path.join(base, 'NEVER')));
    for (const [label, command] of [
      ['invalid environment name', { file: process.execPath, args: [], env: { 'BAD;touch NEVER': 'x' } }],
      ['NUL in an argument', { file: process.execPath, args: ['bad\0arg'], env: {} }],
      ['NUL in an environment value', { file: process.execPath, args: [], env: { BAD: 'bad\0value' } }],
    ]) {
      let refused = false;
      try { writeRootExecPlan(directory, command); } catch { refused = true; }
      check(`${label} refuses before a shell plan is written`, refused);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
