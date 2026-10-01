import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexDriver } from '../lib/driver-codex.js';
import { hostOf } from '../lib/host.js';
import { pipelineOf } from '../dist/pipeline.js';
import { planSpawn } from '../lib/spawn.js';

const base=mkdtempSync(path.join(tmpdir(),'pb-git-metadata-'));
const repo=path.join(base,'repos/fixture/repo'), worktree=path.join(base,'worker');
function git(cwd,...args) {
  const run=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  return run.stdout.trim();
}
mkdirSync(repo,{recursive:true});
git(repo,'init','-b','main');
git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Fixture');
git(repo,'worktree','add','-b','worker',worktree);
const gitDirs=git(worktree,'rev-parse','--path-format=absolute','--absolute-git-dir','--git-common-dir').split('\n').map((dir)=>realpathSync(dir));
const context={cwd:worktree,root:base,prompt:'fixture',model:'gpt-6-astra',ref:'git-metadata-fixture',settingsPath:path.join(base,'reviewer.settings.json'),mcp:{servers:{}},addDirs:[repo],env:{...process.env,PROMPTOBUS_CODEX_HOME:path.join(base,'registry')}};
test.after(()=>rmSync(base,{recursive:true,force:true}));

for(const role of ['worker','approver']) {
  test(`${role} workspace-write includes actual linked git-dir and common-dir`,()=>{
    const prepared=codexDriver.prepare({...context,role});
    assert.equal(prepared.settings.sandbox,'workspace-write');
    for(const dir of gitDirs) assert(prepared.settings.addDirs.includes(dir),`missing exact Git metadata root ${dir}`);
    assert.equal(new Set(prepared.settings.addDirs).size,prepared.settings.addDirs.length);
  });
}
for(const [role,permissionMode] of [['reviewer',null],['reporter',null],['teamlead',null],['worker','read-only'],['approver','read-only']]) {
  test(`${role}/${permissionMode??'default'} does not gain Git metadata write roots`,()=>{
    const prepared=codexDriver.prepare({...context,role,permissionMode});
    for(const dir of gitDirs) assert(!prepared.settings.addDirs.includes(dir),`unexpected metadata root ${dir}`);
  });
}
test('subdirectory cwd resolves metadata from Git rather than appending .git',()=>{
  const nested=path.join(worktree,'src');mkdirSync(nested);
  const prepared=codexDriver.prepare({...context,cwd:nested,role:'worker'});
  for(const dir of gitDirs) assert(prepared.settings.addDirs.includes(dir));
  assert(!prepared.settings.addDirs.includes(path.join(nested,'.git')));
});
test('future worktree planning grants no guessed metadata paths',()=>{
  const future=path.join(base,'not-created');
  const prepared=codexDriver.prepare({...context,cwd:future,role:'approver'});
  assert.deepEqual(prepared.settings.addDirs,[future,repo]);
});
test('caller Git environment cannot redirect metadata write roots to another repo',()=>{
  const foreign=path.join(base,'foreign');mkdirSync(foreign);git(foreign,'init','-b','main');
  const foreignGit=realpathSync(path.join(foreign,'.git'));
  const prepared=codexDriver.prepare({...context,role:'worker',env:{...context.env,GIT_DIR:foreignGit,GIT_COMMON_DIR:foreignGit,GIT_WORK_TREE:foreign}});
  for(const dir of gitDirs) assert(prepared.settings.addDirs.includes(dir));
  assert(!prepared.settings.addDirs.includes(foreignGit));
});
const declaration={owner:{name:'builder',kind:'edits-tree'},gates:[{name:'inspector',kind:'reads-diff'},{name:'acceptor',kind:'writes-main-tree'}]};
writeFileSync(path.join(base,'promptobus.json'),JSON.stringify({tools:['codex'],pipeline:declaration}));
const validatedSteps=pipelineOf(hostOf(base));
for(const step of [validatedSteps[0],validatedSteps[2]]) {
  test(`validated custom pipeline ${step.name}/${step.kind} receives Git metadata`,()=>{
    const prepared=codexDriver.prepare({...context,role:step.name,executionKind:step.kind});
    for(const dir of gitDirs) assert(prepared.settings.addDirs.includes(dir),`missing Git metadata for ${step.name}`);
  });
}
test('renamed approver explicit read-only receives no Git metadata',()=>{
  const step=validatedSteps[2];
  const prepared=codexDriver.prepare({...context,role:step.name,executionKind:step.kind,permissionMode:'read-only'});
  for(const dir of gitDirs) assert(!prepared.settings.addDirs.includes(dir));
});
test('unknown role and reads-diff execution kind do not gain Git metadata',()=>{
  for(const config of [{role:'unknown'},{role:validatedSteps[1].name,executionKind:validatedSteps[1].kind}]) {
    const prepared=codexDriver.prepare({...context,...config});
    for(const dir of gitDirs) assert(!prepared.settings.addDirs.includes(dir));
  }
});
test('public spawn rebuild passes validated custom owner execution kind',async()=>{
  const host=hostOf(base);
  const brief=path.join(base,'custom-brief.md');writeFileSync(brief,'Resolve custom builder Git metadata.');
  const plan=await planSpawn(host,{repo:'repos/fixture/repo',newTask:true,taskTitle:'Custom builder metadata',worker:'custom',harness:'codex',brief});
  assert.equal(plan.ownerName,'builder');
  git(repo,'worktree','add','-b',plan.branch,plan.worktreePath,'main');
  const rebuilt=plan.rebuild({kind:'none',argv:null});
  const expected=git(plan.worktreePath,'rev-parse','--path-format=absolute','--absolute-git-dir','--git-common-dir').split('\n').map(dir=>realpathSync(dir));
  for(const dir of expected) assert(rebuilt.launch.settings.addDirs.includes(dir));
});
