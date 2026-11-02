import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeRootExecPlan } from '../lib/launch-exec.js';

const root = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-exec-'));
const directory = path.join(root, "plans with ' spaces"); mkdirSync(directory, { mode: 0o700 });
const native = path.join(root, 'native.mjs'), preload = path.join(root, 'unlink.cjs'), result = path.join(root, 'native.json');
const consumed = path.join(root, 'consumed.json'), launcher = path.join(root, 'launcher.sh');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');const unlink=fs.unlinkSync;
fs.unlinkSync=function(file){if(path.dirname(file)===${JSON.stringify(directory)}){
fs.writeFileSync(${JSON.stringify(consumed)},JSON.stringify({argvHasPath:[...process.argv,...process.execArgv].some(value=>value.includes(file))}),{mode:0o600});
if(process.env.PB_TEST_UNLINK_FAIL==='1')throw new Error('Private reference '+file);}
return unlink.call(fs,file);};
`);
writeFileSync(native, `import{readFileSync,writeFileSync}from'node:fs';
writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,cwd:process.cwd(),args:process.argv.slice(3),stdin:readFileSync(0,'utf8')}),{mode:0o600});
`);
const run = (plan, failure = false) => new Promise(resolve => {
  writeFileSync(launcher, `#!/bin/sh\n. ${quote(plan)}\n`, { mode: 0o700 });
  const child = spawn('/bin/sh', [launcher], { cwd: root, env: { ...process.env,
    NODE_OPTIONS: `--require ${preload}`, PB_TEST_UNLINK_FAIL: failure ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', error = '';
  child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
  child.once('close', code => resolve({ code, pid: child.pid, out, error }));
  child.stdin.end('stdin $ literal\nline two\n');
});
try {
  const command = { file: process.execPath, args: [native, result, 'literal $(touch NEVER)', ''], env: {} };
  const plan = writeRootExecPlan(directory, command);
  const executed = await run(plan), receipt = existsSync(result) ? JSON.parse(readFileSync(result)) : {};
  check('one-shot exec retains native PID cwd literal args and original stdin after private unlink', executed.code === 0
    && receipt.pid === executed.pid && receipt.cwd === root && JSON.stringify(receipt.args) === JSON.stringify(command.args.slice(2))
    && receipt.stdin === 'stdin $ literal\nline two\n' && !existsSync(plan) && !existsSync(path.join(root, 'NEVER')), executed.error);
  check('transient unlink never puts the private exec-plan path in argv or stdout', existsSync(consumed)
    && JSON.parse(readFileSync(consumed)).argvHasPath === false && executed.out === '');
  rmSync(result, { force: true });
  const failedPlan = writeRootExecPlan(directory, command), failed = await run(failedPlan, true);
  check('unlink failure is sanitized and refuses native exec without claiming owner revocation', failed.code === 1
    && failed.out === '' && failed.error === 'Private root exec plan could not be consumed\n'
    && !failed.error.includes(failedPlan) && !existsSync(result) && existsSync(failedPlan), failed.error);
} finally { rmSync(root, { recursive: true, force: true }); }
