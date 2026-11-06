import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { loadScale, loadScaleProbe, makeSandbox } from './sandbox.mjs';

const attempt = async (run) => { try { return await run(); } catch (error) { return error; } };
// A stand-in probe child that reports a fixed number of wall-clock milliseconds, whatever the machine is doing.
const reports = (ms) => ['-e', `console.log(${ms})`];
const root = makeSandbox('promptobus-test-load-scale-');

const measured = await attempt(() => loadScale());
check('the load factor of this machine is a number from 1 to 10',
  typeof measured === 'number' && measured >= 1 && measured <= 10, String(measured));

const working = await attempt(() => loadScale({ cap: 1e6, maxAgeMs: 0 }));
check('the real burn script answers with a number: a broken one would read as the cap',
  typeof working === 'number' && working >= 1 && working < 1e6, String(working));

const burned = spawnSync(process.execPath, loadScaleProbe(150), { encoding: 'utf8', timeout: 60000 });
const wall = Number(burned.stdout);
check('the burn script keeps a child busy for the CPU time it was asked for: 150 ms of CPU needs at least 140 ms on the clock',
  burned.stdout.trim() !== '' && Number.isFinite(wall) && wall >= 140, JSON.stringify({ stdout: burned.stdout, stderr: burned.stderr }));

const stalled = spawnSync(process.execPath, loadScaleProbe(1e9, 300), { encoding: 'utf8', timeout: 20000 });
const stalledWall = Number(stalled.stdout);
check('a burn that cannot reach its CPU time leaves by the wall-clock bound instead of spinning',
  stalled.stdout.trim() !== '' && stalledWall >= 290 && stalledWall < 15000, JSON.stringify({ stdout: stalled.stdout, signal: stalled.signal }));

const floor = await attempt(() => loadScale({ cpuMs: 40, args: reports(1) }));
check('a child that finishes faster than its CPU time never shrinks a window below its written value', floor === 1, String(floor));

const zero = await attempt(() => loadScale({ cpuMs: 40, cap: 9, args: reports(0) }));
check('a reported zero is a fast answer, not a failure', zero === 1, String(zero));

const follows = await attempt(() => loadScale({ cpuMs: 100, args: reports(400) }));
check('the factor follows the measured time: 400 ms on the clock for 100 ms of CPU is 4', follows === 4, String(follows));

const marker = path.join(root, 'first-run-done');
const alternating = ['-e', `const fs=require('fs'),f=${JSON.stringify(marker)};console.log(fs.existsSync(f)?400:(fs.writeFileSync(f,''),100))`];
const slowest = await attempt(() => loadScale({ cpuMs: 100, args: alternating }));
check('the slowest of the two runs counts: 100 ms then 400 ms for 100 ms of CPU is 4', slowest === 4 && existsSync(marker), String(slowest));

const ceiling = await attempt(() => loadScale({ cpuMs: 100, args: reports(100000) }));
check('a very slow machine is capped at ten times the written value', ceiling === 10, String(ceiling));

const custom = await attempt(() => loadScale({ cpuMs: 100, cap: 3, args: reports(100000) }));
check('the cap is an option', custom === 3, String(custom));

const broken = await attempt(() => loadScale({ cap: 7, command: '/nonexistent/node' }));
check('a start that fails counts as the cap instead of aborting the file', broken === 7, String(broken));

const silent = await attempt(() => loadScale({ cap: 6, args: ['-e', 'console.log("not a number")'] }));
check('an answer that is not a number counts as the cap', silent === 6, String(silent));

const empty = await attempt(() => loadScale({ cap: 5, args: ['-e', ''] }));
check('an empty answer counts as the cap', empty === 5, String(empty));
