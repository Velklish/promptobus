import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSupportedPosixShell, processExecutable, processParent, observeRootProcess, requireNativeHookAncestor } from '../lib/root-process.js';
import { makeSandbox } from './sandbox.mjs';

const identity = await observeRootProcess(process.pid);
const before = process.title;
try {
  process.title = 'codex app-server';
  check('kernel executable observation does not trust a native-looking process title', identity !== null
    && await processExecutable(identity) === realpathSync(process.execPath));
  check('a changed process birth never authorizes an existing PID image', identity !== null
    && await processExecutable({ ...identity, birth: `${identity.birth}:replaced` }) === null);
  check('missing PID observation is unknown rather than a native executable', await observeRootProcess(2147483647) === null);
} finally { process.title = before; }

if (['darwin', 'linux'].includes(process.platform)) {
  const root = realpathSync(makeSandbox('promptobus-root-process-'));
  const hook = path.join(root, 'owned-hook.mjs'), after = path.join(root, 'owned-after-exec.mjs'), shell = path.join(root, 'owned-launcher.sh');
  const module = new URL('../lib/root-process.js', import.meta.url).href;
  writeFileSync(hook, `import{existsSync,writeFileSync}from'node:fs';
import{observeRootProcess,requireNativeHookAncestor}from${JSON.stringify(module)};
const[native,ready,release]=process.argv.slice(2);let allowed=false,error=null;
try{await requireNativeHookAncestor(JSON.parse(native));allowed=true;}catch(caught){error=caught.message;}
writeFileSync(ready,JSON.stringify({allowed,error,shell:await observeRootProcess(process.ppid)}));
while(!existsSync(release))await new Promise(resolve=>setTimeout(resolve,10));
`);
  writeFileSync(after, `import{existsSync,writeFileSync}from'node:fs';
import{observeRootProcess}from${JSON.stringify(module)};
writeFileSync(process.argv[2],JSON.stringify(await observeRootProcess(process.pid)));
while(!existsSync(process.argv[3]))await new Promise(resolve=>setTimeout(resolve,10));
`);
  writeFileSync(shell, '#!/bin/sh\n"$1" "$2" "$3" "$4" "$5" || exit $?\nexec "$1" "$6" "$7" "$8"\n');
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() >= deadline) throw new Error('Owned shell fixture did not reach its barrier'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const refused = async action => { try { await action(); return false; } catch { return true; } };
  const priorBirth = birth => {
    if (birth.startsWith('v2:linux:')) return birth.replace(/:(\d+)$/, (_, ticks) => `:${BigInt(ticks) > 0n ? BigInt(ticks) - 1n : 1n}`);
    if (!birth.startsWith('v2:darwin:utc-c:')) throw new Error('Owned shell fixture requires a comparable birth');
    const date = new Date(`${birth.slice('v2:darwin:utc-c:'.length)} GMT`); date.setUTCSeconds(date.getUTCSeconds() - 1);
    const [weekday, , month, year, time] = date.toUTCString().split(' ');
    return `v2:darwin:utc-c:${weekday.slice(0, -1)} ${month} ${date.getUTCDate()} ${time} ${year}`;
  };
  async function exercise(executable, label, allowed) {
    const ready = path.join(root, `${label}-hook.json`), release = path.join(root, `${label}-release`);
    const nativeReady = path.join(root, `${label}-native.json`), nativeRelease = path.join(root, `${label}-native-release`);
    const child = spawn(executable, [shell, process.execPath, hook, JSON.stringify(identity), ready, release, after, nativeReady, nativeRelease], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      await until(() => existsSync(ready) || child.exitCode !== null || child.signalCode !== null);
      if (!existsSync(ready)) throw new Error(`Owned shell fixture exited before its actual hook observation: ${JSON.stringify({ executable, label,
        pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, stderr })}`);
      const packet = JSON.parse(readFileSync(ready, 'utf8')), captured = await observeRootProcess(child.pid);
      check(`${label}: actual launcher and its own hook child follow the same protected shell policy`,
        captured !== null && packet.shell.pid === captured.pid && packet.shell.birth === captured.birth
          && packet.allowed === allowed && await isSupportedPosixShell(captured) === allowed, JSON.stringify(packet));
      check(`${label}: a shell image is not the approved Node image before exec`,
        captured !== null && await processExecutable(captured) !== realpathSync(process.execPath));
      check(`${label}: unavailable and incomparable launcher lifetimes never authorize a shell`, captured !== null
        && !await isSupportedPosixShell({ ...captured, birth: 'not-a-comparable-process-birth' })
        && !await isSupportedPosixShell({ ...captured, pid: 2147483647 }));
      check(`${label}: a comparable different lifetime cannot borrow a shell or its native parent`, captured !== null
        && !await isSupportedPosixShell({ ...captured, birth: priorBirth(captured.birth) })
        && await refused(() => requireNativeHookAncestor({ ...identity, birth: priorBirth(identity.birth) }, captured.pid)));
      writeFileSync(release, 'release own hook');
      await until(() => existsSync(nativeReady) || child.exitCode !== null || child.signalCode !== null);
      if (!existsSync(nativeReady)) throw new Error(`Owned shell fixture did not exec its Node image: ${JSON.stringify({ executable, label,
        pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, stderr })}`);
      const executed = JSON.parse(readFileSync(nativeReady, 'utf8'));
      check(`${label}: same-PID exec keeps birth but removes shell and hook-child authority`, captured !== null
        && executed.pid === captured.pid && executed.birth === captured.birth
        && await processExecutable(captured) === realpathSync(process.execPath)
        && !await isSupportedPosixShell(captured) && await refused(() => requireNativeHookAncestor(identity, captured.pid)));
      writeFileSync(nativeRelease, 'end owned native image');
      check(`${label}: owned fixture exits normally`, await closed === 0);
    } finally {
      writeFileSync(release, 'fixture cleanup'); writeFileSync(nativeRelease, 'fixture cleanup');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  }
  await exercise('/bin/sh', 'protected-bin-sh', true);
  if (process.platform === 'darwin') {
    await exercise('/bin/bash', 'protected-bin-bash', true);
    const actor = path.join(root, 'actor'); mkdirSync(path.join(actor, 'bin'), { recursive: true });
    const custom = path.join(actor, 'bin', 'bash'), node = realpathSync(process.execPath);
    copyFileSync(node, custom);
    const libraries = path.resolve(path.dirname(node), '..', 'lib');
    if (existsSync(libraries)) symlinkSync(realpathSync(libraries), path.join(actor, 'lib'));
    const holder = path.join(root, 'actor-holder.mjs'), ready = path.join(root, 'actor-hook.json'), release = path.join(root, 'actor-release');
    writeFileSync(holder, `import{spawn}from'node:child_process';
const[node,hook,...args]=process.argv.slice(2),child=spawn(node,[hook,...args],{stdio:'inherit'});
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
`);
    const child = spawn(custom, [holder, node, hook, JSON.stringify(identity), ready, release], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      await until(() => existsSync(ready) || child.exitCode !== null || child.signalCode !== null);
      if (!existsSync(ready)) throw new Error(`Owned actor image exited before its hook observation: ${JSON.stringify({ pid: child.pid,
        exitCode: child.exitCode, signalCode: child.signalCode, stderr })}`);
      const captured = await observeRootProcess(child.pid), packet = JSON.parse(readFileSync(ready, 'utf8'));
      check('an actual actor-owned image named bash cannot authorize its own hook child as a protected shell', captured !== null
        && packet.shell.pid === captured.pid && packet.shell.birth === captured.birth && packet.allowed === false
        && !await isSupportedPosixShell(captured), JSON.stringify(packet));
      check('the actor negative reaches its exact nonprotected kernel image rather than a launch refusal', captured !== null
        && await processExecutable(captured) === realpathSync(custom) && realpathSync(custom) !== node);
      check('unavailable and incomparable actor image lifetimes remain refused', captured !== null
        && !await isSupportedPosixShell({ ...captured, birth: 'not-a-comparable-process-birth' })
        && !await isSupportedPosixShell({ ...captured, pid: 2147483647 }));
      check('a comparable replaced actor lifetime cannot borrow native ancestry', captured !== null
        && !await isSupportedPosixShell({ ...captured, birth: priorBirth(captured.birth) })
        && await refused(() => requireNativeHookAncestor({ ...identity, birth: priorBirth(identity.birth) }, captured.pid)));
      writeFileSync(release, 'release actor hook');
      check('the owned actor image and its hook exit normally', await closed === 0);
    } finally {
      writeFileSync(release, 'actor fixture cleanup');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  }
  check('an actual Node runtime cannot become a POSIX launcher', !await isSupportedPosixShell(identity));
  const traps = path.join(root, 'traps'), marker = path.join(root, 'forged-observer-used'); mkdirSync(traps);
  for (const name of ['osascript', 'ps']) writeFileSync(path.join(traps, name),
    '#!/bin/sh\nprintf forged >> "$PB_BAD_OBSERVER"\nprintf "%s\\n" /bin/bash\n', { mode: 0o700 });
  const oldPath = process.env.PATH, oldMarker = process.env.PB_BAD_OBSERVER;
  try {
    process.env.PATH = `${traps}${path.delimiter}${oldPath ?? ''}`; process.env.PB_BAD_OBSERVER = marker;
    check('actor PATH cannot forge the actual image or parent metadata', await processExecutable(identity) === realpathSync(process.execPath)
      && await processParent(process.pid) === process.ppid && !existsSync(marker));
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldMarker === undefined) delete process.env.PB_BAD_OBSERVER; else process.env.PB_BAD_OBSERVER = oldMarker;
  }
}
