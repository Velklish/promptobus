import { check } from './check.mjs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeSandbox } from './sandbox.mjs';

const ROOT = makeSandbox('promptobus-shared-warden-');
const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'claude-fixture.mjs'), DECOY = path.join(ROOT, 'process-profile'), PRIVATE = path.join(ROOT, 'explicit-private-profile');
const AMBIENT_HOME = path.join(ROOT, 'ambient-home'), OS_HOME = path.join(ROOT, 'os-fallback');
const ID = 'common-profile-native', DETAIL = 'common profile detail', AT = '2026-10-30T00:00:00.000Z';
const fixture = (home, detail, at) => {
  const job = path.join(home, 'jobs', ID); mkdirSync(job, { recursive: true });
  writeFileSync(path.join(job, 'state.json'), JSON.stringify({ detail }));
  writeFileSync(path.join(job, 'timeline.jsonl'), `${JSON.stringify({ detail: DETAIL, at })}\n`);
  writeFileSync(path.join(home, 'list.json'), JSON.stringify([{ id: ID, name: 'common-ref', state: 'blocked', profile: detail }]));
};
fixture(DECOY, 'foreign process profile detail', '2001-01-01T00:00:00.000Z');
fixture(path.join(AMBIENT_HOME, '.claude'), 'foreign ambient home detail', '2002-01-01T00:00:00.000Z');
fixture(PRIVATE, 'explicit private profile detail', AT);
writeFileSync(FAKE, `#!${process.execPath}
import {readFileSync} from 'node:fs';
import path from 'node:path';
const home=process.env.CLAUDE_CONFIG_DIR||path.join(process.env.HOME||process.env.USERPROFILE||${JSON.stringify(OS_HOME)},'.claude');
console.log(readFileSync(path.join(home,'list.json'),'utf8'));
`, { mode: 0o755 });
for (const mode of ['explicit-config', 'home-fallback', 'os-fallback']) {
  const commonHome = path.join(ROOT, mode), commonConfig = mode === 'explicit-config' ? path.join(commonHome, 'config') : path.join(commonHome, '.claude');
  fixture(commonConfig, DETAIL, AT);
  const code = `import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {bindHarnessBins,bindPollEnvironment} from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, 'lib/harness-home.js')).href)};
import {readBgSessions} from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, 'lib/liftoff.js')).href)};
import {sessionDetail,sessionDetailAt} from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, 'lib/driver-claude.js')).href)};
const original=JSON.stringify([process.env.CLAUDE_CONFIG_DIR,process.env.HOME,process.env.USERPROFILE]);
const pollEnv={...process.env,HOME:${JSON.stringify(commonHome)},USERPROFILE:${JSON.stringify(commonHome)}};
${mode === 'explicit-config' ? `pollEnv.CLAUDE_CONFIG_DIR=${JSON.stringify(commonConfig)};` : 'delete pollEnv.CLAUDE_CONFIG_DIR;'}
${mode === 'os-fallback' ? `delete pollEnv.HOME;delete pollEnv.USERPROFILE;
const userInfo=os.userInfo;os.userInfo=(options)=>({...userInfo(options),homedir:${JSON.stringify(OS_HOME)}});syncBuiltinESMExports();` : ''}
bindPollEnvironment(pollEnv);bindHarnessBins({resolveToolBin:()=>({ok:true,bin:${JSON.stringify(FAKE)}})});
const listed=readBgSessions({fresh:true}).list?.[0];
console.log(JSON.stringify({listed,detail:sessionDetail(${JSON.stringify(ID)}),at:sessionDetailAt(${JSON.stringify(ID)},${JSON.stringify(DETAIL)}),
privateDetail:sessionDetail(${JSON.stringify(ID)},${JSON.stringify(PRIVATE)}),privateAt:sessionDetailAt(${JSON.stringify(ID)},${JSON.stringify(DETAIL)},${JSON.stringify(PRIVATE)}),unchanged:JSON.stringify([process.env.CLAUDE_CONFIG_DIR,process.env.HOME,process.env.USERPROFILE])===original}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: DECOY, HOME: AMBIENT_HOME, USERPROFILE: AMBIENT_HOME } });
  const response = result.status === 0 ? JSON.parse(result.stdout) : {};
  check(`Claude ${mode}: session listing uses the bound common profile despite a different process profile`, result.status === 0 && response.listed?.profile === DETAIL, result.stderr);
  check(`Claude ${mode}: default detail and timeline use the same bound profile without environment flips`, response.detail === DETAIL && response.at === Date.parse(AT) && response.unchanged,
    JSON.stringify({ detail: response.detail, at: response.at }));
  check(`Claude ${mode}: an explicit private detail path remains explicit`, response.privateDetail === 'explicit private profile detail' && response.privateAt === Date.parse(AT));
}
