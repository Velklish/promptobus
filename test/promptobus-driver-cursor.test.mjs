// Cursor driver — the second production bus driver (; moved to
// persist sessions in ). Run: npm test
//
// Subject — what Cursor does DIFFERENTLY from Claude Code, and is therefore not checked
// by any earlier suite file: the lift plan (its own flags, its own `.cursor/*` files, its
// own reviewer sandbox), a live persist session in a tmux pane instead of a turn
// process, transcript parse instead of a `stream-json` stream, text injection into the
// TUI input field, a watchdog on transcript silence, and the two kinds of leftover
// processes after teardown.
//
// The loop runs on the real mechanism: CLI, the `cursor` driver, the warden, the bus
// MCP server, the task store, git. Exactly two binaries are substituted — `agent` and
// `tmux` ([harness-cursor.mjs](harness-cursor.mjs)), and the substitution sits on their
// boundary: the driver remains the subject under test.
//
// **The wake loop is not in this file and lives in its own**
// ([promptobus-cursor-wake.test.mjs](promptobus-cursor-wake.test.mjs)): it measures
// wall-clock time — the warden loop, a pause inside a turn — and therefore runs in a
// serial runner group. Here everything that is judged without a clock.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { buildWorkspace, cli, store } from './scenario.mjs';
import {
  CURSOR_HOME_VAR, HANG_CHILD_VAR, HANG_VAR, HANG_WRITE_VAR, diagnoseTrace, installHarness, planParticipant,
  readTrace,
} from './harness-cursor.mjs';
import { waitFor } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-cursor-');
const { home: HARNESS, stateHome, restore } = await installHarness({ binDir: path.join(SB, 'bin') });

const {
  cursorDriver, reviewSandbox, PROVEN_CURSOR_VERSION, PHRASES, KNOWN_HOOK_EVENTS,
  skillsNoteOf,
} = await import(path.join(here, '..', 'lib', 'driver-cursor.js'));
const {
  dropSession, injectText, launchScript, listSessions, readSession, readTranscript, sessionFile,
  sessionKey, silentIsStall, isRuntimeCmd, mcpRuntimeNeedles, BUS_MCP_NEEDLE, toolKidsOf, tmux, transcriptOf,
  turnState,
  workspaceHash, writeSession,
} = await import(path.join(here, '..', 'lib', 'cursor-persist.js'));
const { liftDriver, REGISTRY } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { liftHarness, skillsNote, writeLaunchFiles } = await import(path.join(here, '..', 'lib', 'spawn.js'));

const TASK = 'cursorbus-t20260903-000000';
const WORKER = 'worker:cur';
const REVIEWER = 'reviewer:cur';
const ORCH_SESSION = `orch-cursor-${process.pid}`;

// --- registry and the --harness flag ------------------------------------------------

check(': the Cursor driver sits in the registry map and is taken by name',
  liftDriver('cursor').id === 'cursor' && Object.keys(REGISTRY.drivers).sort().join(',') === 'claude,codex,cursor',
  Object.keys(REGISTRY.drivers).join(','));

check(': without a name the previous driver is taken — Claude Code argv does not move',
  liftDriver().id === 'claude' && liftDriver(null).id === 'claude' && liftDriver('').id === 'claude');

function thrown(fn) {
  try {
    fn();
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e.message };
  }
}

const unknown = thrown(() => liftDriver('no-such'));
check(': an unknown harness is refused at the registry door, with the list of known ones',
  unknown.threw && /no-such/.test(unknown.msg) && /cursor/.test(unknown.msg), unknown.msg);

// --- capabilities and vocabulary ----------------------------------------------------

check(': Cursor capabilities are declared, all nine',
  ['spawn', 'attach', 'activation', 'inspect', 'stop', 'denyTools', 'systemPrompt', 'sessionList', 'enter']
    .every((k) => cursorDriver.capabilities[k] !== undefined)
  && cursorDriver.capabilities.attach === false,
  JSON.stringify(cursorDriver.capabilities));

// Human enter on Cursor is now real: a live session accepts `agent persist attach`, and
// two clients coexist in it. Under headless this capability was not there at all.
check(': human enter and the session list are declared, and the enter route is a persist command',
  cursorDriver.capabilities.enter === true && cursorDriver.capabilities.sessionList === true
  && PHRASES.enter('cursor-a-1') === 'agent persist attach cursor-a-1'
  && PHRASES.sessions === 'agent persist list',
  `${PHRASES.enter('cursor-a-1')} · ${PHRASES.sessions}`);

check(': Cursor activation is push, and the driver has an activate operation',
  cursorDriver.capabilities.activation === 'push' && typeof cursorDriver.activate === 'function'
  && typeof cursorDriver.renderNotification === 'function');

// The channel is injection into a live session, not a socket and not a new process. The
// declared sign: the suite stub channel substitutes delivery only where it really is a
// socket.
check(': the driver channel is declared as injection — there is nothing to substitute in it',
  cursorDriver.options.knockChannel === 'inject', cursorDriver.options.knockChannel);

check(': transcript silence by itself is not a stop — stop only if the pane has no children',
  silentIsStall({ silent: true }, [4242]) === false
  && silentIsStall({ silent: true }, []) === true
  && silentIsStall({ silent: false }, [1]) === false
  && silentIsStall({ silent: false }, []) === false);

const wardenCmd = `node ${BUS_MCP_NEEDLE.replace(/\bmcp\b/, 'warden --task t')}`;
check(': runtime is worker-server and the bus needle; MCP is from the config',
  isRuntimeCmd('node -e setTimeout(() => {}, 60_000); // worker-server') === true
  && isRuntimeCmd(`node ${BUS_MCP_NEEDLE}`) === true
  && isRuntimeCmd(wardenCmd) === false
  && isRuntimeCmd('node index.js --cursor-persist-restore abc sess') === false
  && isRuntimeCmd('foo --stdio', ['foo']) === true
  && isRuntimeCmd('/bin/zsh -c npm test') === false
  && isRuntimeCmd('npm test') === false
  && isRuntimeCmd('node') === false);

check(': a bare interpreter from mcp.json is not a needle',
  JSON.stringify(mcpRuntimeNeedles({ mcpServers: { x: { command: 'node' } } })) === JSON.stringify([])
  && JSON.stringify(mcpRuntimeNeedles({ mcpServers: { x: { command: 'node', args: ['foo'] } } })) === JSON.stringify(['foo']));

{
  const warden = `node ${BUS_MCP_NEEDLE.replace(/\bmcp\b/, 'warden --task t')}`;
  const stdout = [
    '    5     1 node persist-restore',
    `   10     5 node ${BUS_MCP_NEEDLE}`,
    `   20    10 ${warden}`,
  ].join('\n');
  const kids = toolKidsOf(5, { ps: () => ({ status: 0, stdout }) });
  check(': a warden under the bus process is not a tool, silence = stop',
    JSON.stringify(kids) === JSON.stringify([])
    && silentIsStall({ silent: true }, kids) === true, JSON.stringify(kids));
}

{
  const needles = mcpRuntimeNeedles({ mcpServers: { foo: { command: 'foo' } } });
  const stdout = [
    '   10     1 sh -c persist',
    '   20    10 foo --stdio',
    '   30    10 npm test',
  ].join('\n');
  const onlyFoo = toolKidsOf(10, {
    ps: () => ({ status: 0, stdout: '   20    10 foo --stdio\n' }),
    needles,
  });
  const withTool = toolKidsOf(10, { ps: () => ({ status: 0, stdout }), needles });
  check(': a stdio server from mcp.json is not a tool',
    JSON.stringify(needles) === JSON.stringify(['foo'])
    && JSON.stringify(onlyFoo) === JSON.stringify([])
    && JSON.stringify(withTool) === JSON.stringify([30]),
    `${JSON.stringify(needles)} · ${JSON.stringify(onlyFoo)} · ${JSON.stringify(withTool)}`);
}

{
  // The tail pads the line past 200 characters at any checkout path length: in a
  // participant worktree `PROMPTOBUS_BIN` is longer than in the main clone (218 vs 159
  // characters on the owner machine), and a fixture with a fixed tail went red on main
  // while passing at the worker.
  const busHead = `   10     5 node ${BUS_MCP_NEEDLE} `;
  const busLine = `${busHead}${'z'.repeat(Math.max(40, 221 - busHead.length))}`;
  const wardenLine = `   20    10 node ${BUS_MCP_NEEDLE.replace(/\bmcp\b/, 'warden --task t')}`;
  const longTool = `npm test ${'x'.repeat(200)}`;
  const raw = ['    5     1 persist', busLine, wardenLine, `   30     5 ${longTool}`].join('\n');
  let seenArgs;
  const kids = toolKidsOf(5, {
    ps: (_bin, args) => {
      seenArgs = args;
      const ww = (args ?? []).some((a) => String(a).includes('ww'));
      const stdout = ww ? raw : raw.split('\n').map((l) => l.slice(0, 131)).join('\n');
      return { status: 0, stdout };
    },
  });
  check(': ps -Awwo; a command line longer than 200 characters is read whole',
    Array.isArray(seenArgs) && seenArgs[0] === '-Awwo'
    && seenArgs.includes('pid=,ppid=,command=')
    && busLine.length > 200 && longTool.length > 200
    && JSON.stringify(kids) === JSON.stringify([30])
    && silentIsStall({ silent: true }, kids) === false,
    `${JSON.stringify(seenArgs)} · ${busLine.length} · ${JSON.stringify(kids)}`);
}

check(': the wake text calls the mailbox by the Cursor NAME and carries a message excerpt',
  (() => {
    const text = cursorDriver.renderNotification({
      kind: 'unread', task: 'T', address: 'worker:a', unread: 2,
      messages: [{ type: 'answer', from: 'orchestrator', ts: 'now', body: 'ТЕЛО-СООБЩЕНИЯ' }],
    });
    return text.includes('promptobus-promptobus_mailbox') && text.includes('ТЕЛО-СООБЩЕНИЯ')
      && text.includes('worker:a');
  })(), cursorDriver.renderNotification({ kind: 'unread', task: 'T', address: 'worker:a', unread: 0, messages: [] }).slice(0, 90));

// The declared binary is `cursor-agent`, not the harness name `cursor`: the name
// travels to `host.resolveToolBin` and from there straight to `run`, so it must be
// the name of the binary that actually starts. It said `cursor` until 2026-09-05,
// and a standalone host — which hands a name back without searching — sent that
// through PATH into the operator's own `~/.local/bin/cursor` (PB-2).
check(': the Cursor vocabulary is its own — binary, default model and read-only participant denies',
  cursorDriver.options.tool === 'cursor-agent' && cursorDriver.options.defaultModel === 'composer-2.5'
  && JSON.stringify(cursorDriver.options.denyTools) === JSON.stringify(['Write(**)', 'Shell(**)'])
  && cursorDriver.options.skillsDir === false,
  JSON.stringify(cursorDriver.options));

// tmux is not a harness, it is a workspace utility, and the driver itself declares it:
// without it the participant session does not lift at all. Resolve and the version check
// are called by the adapter under this name.
check(': the driver declares tmux as its workspace utility',
  JSON.stringify(cursorDriver.options.utils) === JSON.stringify(['tmux']),
  JSON.stringify(cursorDriver.options.utils));

check(': Cursor bus tool names use a hyphen — and that is what the participant prompt names',
  cursorDriver.phrases.tool('promptobus', 'promptobus_send') === 'promptobus-promptobus_send',
  cursorDriver.phrases.tool('promptobus', 'promptobus_send'));

check(': harness prompt rules forbid questions and require the mailbox on every turn',
  /Do not ask questions/.test(cursorDriver.phrases.promptRules)
  && /mailbox at the start of every turn/.test(cursorDriver.phrases.promptRules),
  cursorDriver.phrases.promptRules.slice(0, 120));

// The version refusal is its own, not the shared `minVersion`: participant lift sits on
// the `persist` layout, and that was taken on the proven version and nothing else.
check(': a binary older than the proven version — refuse before lift, with the number',
  /2026\.08\.11/.test(String(cursorDriver.optionRefusal({}, { version: '2026.08.11' })))
  && cursorDriver.optionRefusal({}, { version: PROVEN_CURSOR_VERSION }) === null
  && cursorDriver.optionRefusal({}, { version: null }) === null,
  String(cursorDriver.optionRefusal({}, { version: '2026.08.11' })).slice(0, 90));

// The adapter resolves the utility by the name the driver named — and asks the binary
// itself for the version, it does not take it from the declaration: `doctor` and the
// lift gate must judge the same machine.
//
// **What to ask is known by the utility** (review note): a live tmux answers `--version`
// with usage and exit 1, and prints the version only on `-V`. Ask with the shared flag —
// and the version is "undefined", so the `minVersion` gate NEVER fires. The stand answers
// exactly on `-V`, so the verdict below goes red if the probe arguments drift from the
// declaration.
const driverSrc = readFileSync(path.join(here, '..', 'lib', 'driver-cursor.js'), 'utf8');
const tmuxFound = cursorDriver.optionRefusal({}, { version: PROVEN_CURSOR_VERSION }, {
  util: () => ({ ok: true, version: '3.6' }),
});
check(': the Cursor driver asks tmux with -V and accepts the found version',
  /run\('tmux', \['-V'\]/.test(driverSrc) && tmuxFound === null,
  `${tmuxFound} · ${/run\('tmux', \['-V'\]/.test(driverSrc)}`);

// The second refusal of the same gate: tmux. It is asked in exactly the same place,
// before the first write to disk, otherwise lift would stall on "pty provider pane did
// not lift" already with a worktree and a branch.
const noTmux = cursorDriver.optionRefusal({}, { version: PROVEN_CURSOR_VERSION }, {
  util: () => ({ ok: false, reason: 'tmux (tmux): not found in PATH or in the known install locations (~/.local/bin).' }),
});
check(': tmux not found — refuse before lift, in the same words as doctor',
  /tmux/.test(String(noTmux)) && /not found in PATH/.test(String(noTmux)),
  String(noTmux));

// --- lift plan ----------------------------------------------------------------------

const ctx = {
  ref: 'Worker: проба (0903-1200)',
  address: WORKER,
  task: TASK,
  home: '/tmp/home',
  role: 'worker',
  mcp: { address: WORKER, task: TASK, home: '/tmp/home', servers: { promptobus: { type: 'stdio', command: 'node', args: [] } } },
  prompt: 'ПРОМПТ',
  cwd: '/tmp/wt',
  model: 'cursor-grok-4.6-xhigh-fast',
  effort: null,
  permissionMode: 'force',
  addDirs: ['/tmp/rules'],
  pluginDir: '/tmp/plugin',
  mcpConfigPath: '/tmp/home/tasks/t/workers/cur.mcp.json',
  settingsPath: '/tmp/home/tasks/t/workers/cur.settings.json',
  guardCommand: '"/bin/node" "/bin/agents.js" promptobus guard --role worker:cur',
};
const workerPlan = cursorDriver.prepare(ctx);

// The participant session is a live TUI, not a headless turn: the first argument is the
// `persist` subcommand, there is no `stream-json` stream in argv at all.
check(': argv lifts a persist session, not a headless turn',
  workerPlan.argv[0] === 'persist' && !workerPlan.argv.includes('-p')
  && !workerPlan.argv.includes('--output-format'),
  workerPlan.argv.join(' '));

// `--workspace` overrides cwd entirely: without it the chat store is keyed by the launch
// directory, and the participant session would ride into a foreign chat. The mechanism
// also recognises its session in the tmux list by it.
check(': worker argv carries --workspace with its working directory',
  workerPlan.argv[workerPlan.argv.indexOf('--workspace') + 1] === '/tmp/wt',
  workerPlan.argv.join(' '));

check(': argv — trust the directory and the model as named',
  workerPlan.argv.includes('--trust') && workerPlan.argv.includes('--force')
  && workerPlan.argv[workerPlan.argv.indexOf('--model') + 1] === 'cursor-grok-4.6-xhigh-fast',
  workerPlan.argv.join(' '));

// `--approve-mcps` approves ALL servers up the tree and writes the approval into a
// foreign project record (REPORT §4.4, §11). A gate, not a wish: the driver never gives
// it.
check(': the driver gives --approve-mcps to neither the worker nor the reviewer',
  !workerPlan.argv.includes('--approve-mcps'), workerPlan.argv.join(' '));

check(': the prompt is the last argument and carries the harness rules',
  workerPlan.argv[workerPlan.argv.length - 1] === 'ПРОМПТ',
  workerPlan.argv.slice(-2).join(' | '));

check(': the Claude Code skills directory is not in argv — Cursor does not read it',
  !workerPlan.argv.includes('--plugin-dir'), workerPlan.argv.join(' '));

const files = Object.fromEntries(workerPlan.files.map((f) => [path.basename(f.path), f]));
check(': the plan puts four .cursor/ files in the working directory — mcp, permissions, hooks and gitignore',
  workerPlan.files.every((f) => f.path.startsWith(path.join('/tmp/wt', '.cursor')))
  && !!files['mcp.json'] && !!files['cli.json'] && !!files['hooks.json'] && !!files['.gitignore']
  && files['.gitignore'].text === '*\n' && workerPlan.files.length === 4,
  workerPlan.files.map((f) => f.path).join(' · '));

check(': without a workspace root the plan honestly says there are no skills, and does not ask for a copy',
  /no \.cursor\/skills/.test(workerPlan.skillsNote)
  && !workerPlan.files.some((f) => f.copyFrom)
  && /no \.cursor\/skills/.test(skillsNote({ launch: workerPlan, pluginDir: null, driver: cursorDriver }))
  && !/does not read the Claude Code skills plugin/.test(skillsNote({ launch: workerPlan, pluginDir: null, driver: cursorDriver })),
  workerPlan.skillsNote);

const skillsRoot = path.join(SB, 'skills-src');
mkdirSync(path.join(skillsRoot, '.cursor', 'skills', 'techdoc-style-ru'), { recursive: true });
writeFileSync(path.join(skillsRoot, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'),
  '---\nname: techdoc-style-ru\ndescription: проба\n---\nтело\n');
mkdirSync(path.join(skillsRoot, '.cursor', 'skills', '_shared'), { recursive: true });
writeFileSync(path.join(skillsRoot, '.cursor', 'skills', '_shared', 'standards.md'), 'общие\n');
const skillScript = path.join(skillsRoot, '.cursor', 'skills', 'techdoc-style-ru', 'run.sh');
writeFileSync(skillScript, '#!/bin/sh\n');
chmodSync(skillScript, 0o755);
writeFileSync(path.join(skillsRoot, '.cursor', 'mcp.json'), '{"from":"workspace-root"}\n');
mkdirSync(path.join(skillsRoot, '.cursor', 'agents'), { recursive: true });
writeFileSync(path.join(skillsRoot, '.cursor', 'agents', 'ls-reviewer.md'), 'субагент\n');
mkdirSync(path.join(skillsRoot, '.cursor', 'rules'), { recursive: true });
writeFileSync(path.join(skillsRoot, '.cursor', 'rules', 'x.mdc'), 'правило\n');

const skillsWt = path.join(SB, 'skills-wt');
const skillsPlan = cursorDriver.prepare({ ...ctx, root: skillsRoot, cwd: skillsWt });
check(': the plan copies .cursor/skills from the root — not mcp, not agents, not rules',
  skillsPlan.files.some((f) => f.copyFrom === path.join(skillsRoot, '.cursor', 'skills')
    && f.path === path.join(skillsWt, '.cursor', 'skills'))
  && skillsPlan.files.filter((f) => f.copyFrom).length === 1
  && /1 from /.test(skillsPlan.skillsNote)
  && skillsPlan.skillsNote.includes(path.join(skillsRoot, '.cursor', 'skills'))
  && skillsPlan.skillsNote.includes(path.join(skillsWt, '.cursor', 'skills')),
  skillsPlan.skillsNote);

const reviewerSkills = cursorDriver.prepare({
  ...ctx, role: 'reviewer', cwd: '/tmp/clone', root: skillsRoot,
  denyTools: cursorDriver.options.denyTools,
});
check(': the reviewer gets the same skills copy into the sandbox',
  reviewerSkills.files.some((f) => f.copyFrom === path.join(skillsRoot, '.cursor', 'skills')
    && f.path.startsWith(reviewSandbox(ctx.settingsPath))),
  reviewerSkills.files.filter((f) => f.copyFrom).map((f) => f.path).join(' · '));

mkdirSync(skillsWt, { recursive: true });
spawnSync('git', ['init', '-q', skillsWt], { encoding: 'utf8' });
writeLaunchFiles(skillsPlan.files);
const copiedScript = path.join(skillsWt, '.cursor', 'skills', 'techdoc-style-ru', 'run.sh');
check(': skills are copied, +x is in place, workspace mcp/agents/rules do not travel',
  existsSync(path.join(skillsWt, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'))
  && existsSync(path.join(skillsWt, '.cursor', 'skills', '_shared', 'standards.md'))
  && (statSync(copiedScript).mode & 0o111) !== 0
  && !existsSync(path.join(skillsWt, '.cursor', 'agents'))
  && !existsSync(path.join(skillsWt, '.cursor', 'rules'))
  && !readFileSync(path.join(skillsWt, '.cursor', 'mcp.json'), 'utf8').includes('workspace-root'),
  readdirSync(path.join(skillsWt, '.cursor')).join(','));

check(': .cursor/.gitignore self-ignores the directory — git status of this tree is clean',
  readFileSync(path.join(skillsWt, '.cursor', '.gitignore'), 'utf8') === '*\n'
  && String(spawnSync('git', ['-C', skillsWt, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '').trim() === '');

mkdirSync(path.join(skillsWt, '.cursor', 'skills', 'leftover'), { recursive: true });
writeFileSync(path.join(skillsWt, '.cursor', 'skills', 'leftover', 'SKILL.md'), 'выпавший\n');
symlinkSync(path.join(skillsRoot, '.cursor', 'skills', '_shared', 'standards.md'),
  path.join(skillsRoot, '.cursor', 'skills', 'ghost-link'));
let copyWarns = '';
const copyWarn0 = console.warn;
console.warn = (m) => { copyWarns += `${m}\n`; };
writeLaunchFiles(skillsPlan.files);
console.warn = copyWarn0;
check(': a second copy removes a leftover skill and warns about a symlink',
  !existsSync(path.join(skillsWt, '.cursor', 'skills', 'leftover'))
  && !existsSync(path.join(skillsWt, '.cursor', 'skills', 'ghost-link'))
  && /ghost-link/.test(copyWarns) && /symbolic link/.test(copyWarns),
  copyWarns);
rmSync(path.join(skillsRoot, '.cursor', 'skills', 'ghost-link'), { force: true });

const gitAt = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
  { encoding: 'utf8' });
const humanClone = path.join(SB, 'human-clone');
mkdirSync(humanClone, { recursive: true });
gitAt(humanClone, 'init', '-q', '-b', 'master');
writeFileSync(path.join(humanClone, 'f'), 'первый\n');
gitAt(humanClone, 'add', 'f');
gitAt(humanClone, 'commit', '-qm', 'первый');
mkdirSync(path.join(humanClone, '.cursor'), { recursive: true });
writeFileSync(path.join(humanClone, '.cursor', 'human.md'), 'личный\n');
const linkedWt = path.join(SB, 'human-wt');
const linkedAdd = gitAt(humanClone, 'worktree', 'add', '-q', '--detach', linkedWt);
writeLaunchFiles(cursorDriver.prepare({ ...ctx, root: skillsRoot, cwd: linkedWt }).files);
const commonDirRaw = String(gitAt(linkedWt, 'rev-parse', '--git-common-dir').stdout ?? '').trim();
const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.join(linkedWt, commonDirRaw);
const commonExclude = path.join(commonDir, 'info', 'exclude');
const commonText = existsSync(commonExclude) ? readFileSync(commonExclude, 'utf8') : '';
const linkedPorc = String(gitAt(linkedWt, 'status', '--porcelain', '-uall').stdout ?? '');
const clonePorc = String(gitAt(humanClone, 'status', '--porcelain', '-uall').stdout ?? '');
check(': a linked worktree hides its .cursor, the clone shared exclude is clean, the human personal .cursor is visible',
  linkedAdd.status === 0
  && readFileSync(path.join(linkedWt, '.cursor', '.gitignore'), 'utf8') === '*\n'
  && !commonText.split('\n').some((l) => l.trim() === '.cursor/' || l.trim() === '.cursor')
  && !linkedPorc.split('\n').some((l) => l.includes('.cursor/'))
  && clonePorc.includes('.cursor/human.md'),
  `${linkedAdd.status} · ${commonExclude} · ${commonText} · wt:${linkedPorc.trim()} · clone:${clonePorc.trim()}`);

const tracked = path.join(SB, 'tracked-clone');
mkdirSync(path.join(tracked, '.cursor'), { recursive: true });
gitAt(tracked, 'init', '-q', '-b', 'master');
writeFileSync(path.join(tracked, '.cursor', 'cli.json'), '{"old":true}\n');
gitAt(tracked, 'add', '.cursor/cli.json');
gitAt(tracked, 'commit', '-qm', 'tracked cursor');
let trackedWarns = '';
const trackedWarn0 = console.warn;
console.warn = (m) => { trackedWarns += `${m}\n`; };
writeLaunchFiles(cursorDriver.prepare({ ...ctx, cwd: tracked, root: null }).files);
console.warn = trackedWarn0;
check(': lift names already-tracked .cursor files — gitignore will not protect them',
  /cli\.json/.test(trackedWarns) && trackedWarns.includes(tracked),
  trackedWarns);

check(': skillsNoteOf without a source — the same honest line as the plan without a root',
  skillsNoteOf({ src: null }) === workerPlan.skillsNote, skillsNoteOf({ src: null }));

check(': the MCP config is marked secret — it has substituted tokens',
  files['mcp.json'].secret === true && !files['cli.json'].secret && !files['hooks.json'].secret
  && !files['.gitignore'].secret);

const hooks = JSON.parse(files['hooks.json'].text);
// Under persist the loop guard sits on `stop`: `sessionEnd` does not fire in a live
// session at all — not at end of turn, not on teardown. The most expensive silent
// translation bug, so the verdict checks BOTH names, not one.
check(': the loop guard sits on stop, not sessionEnd, and calls the same command',
  hooks.hooks?.stop?.[0]?.command === ctx.guardCommand && !hooks.hooks?.sessionEnd,
  JSON.stringify(hooks));

// An unknown event name SILENTLY kills the whole hooks file: not a single one fires,
// including the correctly named (REPORT §4.4). So the gate is not on one name, it is on
// the whole file.
check(': the driver writes only known event names into hooks.json',
  Object.keys(hooks.hooks).every((name) => KNOWN_HOOK_EVENTS.includes(name))
  && KNOWN_HOOK_EVENTS.includes('stop') && KNOWN_HOOK_EVENTS.length === 5,
  `${Object.keys(hooks.hooks).join(',')} · known: ${KNOWN_HOOK_EVENTS.join(',')}`);

check(': worker permissions — its own .cursor/cli.json with empty lists',
  JSON.stringify(JSON.parse(files['cli.json'].text)) === JSON.stringify({ permissions: { allow: [], deny: [] } }),
  files['cli.json'].text);

// The lift script: the pty-provider pane calls the binary through it. Two things in it
// are the subject — dropped `TMUX`/`TMUX_PANE` (otherwise persist silently does not
// persist) and the session mark in the environment, by which its processes are collected
// and its hook finds its record.
const script = launchScript({
  bin: '/bin/agent',
  argv: workerPlan.argv,
  env: { PATH: '/usr/bin', PROMPTOBUS_CURSOR_SESSION: '/state/sessions/a.json' },
});
check(': the lift script drops TMUX and carries the session mark in the environment',
  /env -u TMUX -u TMUX_PANE/.test(script)
  && /PROMPTOBUS_CURSOR_SESSION=\/state\/sessions\/a\.json/.test(script)
  && /persist/.test(script),
  script);

const scriptFromTmux = launchScript({
  bin: '/bin/agent',
  argv: ['persist'],
  env: { PATH: '/usr/bin', TMUX: '/tmp/sock,1,0', TMUX_PANE: '%0', FOO: 'ok' },
});
check(': the script does not put TMUX back after -u — otherwise persist sees a foreign session again',
  /env -u TMUX -u TMUX_PANE/.test(scriptFromTmux)
  && !/\bTMUX=/.test(scriptFromTmux)
  && !/\bTMUX_PANE=/.test(scriptFromTmux)
  && /FOO=ok/.test(scriptFromTmux),
  scriptFromTmux);

// Reviewer: its own sandbox, the reviewed directory on read, deny in the permissions
// file.
const reviewerPlan = cursorDriver.prepare({
  ...ctx, role: 'reviewer', cwd: '/tmp/clone', permissionMode: null, denyTools: cursorDriver.options.denyTools,
});
const sandboxDir = reviewSandbox(ctx.settingsPath);
check(': the reviewer sits in its own sandbox, not in the reviewed clone',
  reviewerPlan.cwd === sandboxDir
  && reviewerPlan.argv[reviewerPlan.argv.indexOf('--workspace') + 1] === sandboxDir
  && reviewerPlan.files.every((f) => f.path.startsWith(sandboxDir)),
  `${reviewerPlan.cwd} · ${reviewerPlan.files.map((f) => f.path).join(' · ')}`);

check(': the reviewed directory is attached to the reviewer for read via --add-dir',
  reviewerPlan.argv.includes('--add-dir') && reviewerPlan.argv.includes('/tmp/clone'),
  reviewerPlan.argv.join(' '));

// Read-only is held by the permissions FILE, and under persist it was checked live
// (REPORT §4.7 spike): a turn "run echo" got `Permission denied`. The `plan` mode as a
// second line was dropped — in a live session it changes TUI behaviour, and it is not
// what gives the guarantee.
const reviewerCli = JSON.parse(reviewerPlan.files.find((f) => f.path.endsWith('cli.json')).text);
check(': reviewer read-only is deny in .cursor/cli.json, without plan mode',
  JSON.stringify(reviewerCli.permissions.deny) === JSON.stringify(['Write(**)', 'Shell(**)'])
  && !reviewerPlan.argv.includes('--mode'),
  `${JSON.stringify(reviewerCli)} · ${reviewerPlan.argv.join(' ')}`);

// Effort on Cursor is a model-id suffix, not a flag: the bracket form is rejected by the
// binary.
const effortPlan = cursorDriver.prepare({ ...ctx, model: 'cursor-grok-4.6', effort: 'xhigh' });
check(': --effort appends a suffix to the model id, Cursor has no separate flag',
  effortPlan.argv[effortPlan.argv.indexOf('--model') + 1] === 'cursor-grok-4.6-xhigh'
  && !effortPlan.argv.includes('--effort'),
  effortPlan.argv.join(' '));

// --- transcript parse ---------------------------------------------------------------

// There is no `stream-json` stream under persist at all: the chat transcript speaks
// about the turn. `turn_ended` is written ONCE on the transition to idle, not on every
// message (REPORT §4.6), so "is a turn in progress" is read by order: a user message
// opens a turn, `turn_ended` closes it.
const transcriptSample = path.join(SB, 'sample.jsonl');
const lines = [
  { role: 'user', message: { content: [{ type: 'text', text: '<user_query>раз</user_query>' }] } },
  { role: 'assistant', message: { content: [{ type: 'text', text: 'ответ' }] } },
  { type: 'turn_ended', status: 'success' },
];
writeFileSync(transcriptSample, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
const seenIdle = readTranscript(transcriptSample);
writeFileSync(transcriptSample, `${[...lines, { role: 'user', message: { content: [] } }].map((l) => JSON.stringify(l)).join('\n')}\n`);
const seenBusy = readTranscript(transcriptSample);
check(': end of turn is read from the transcript — turn_ended closes a turn, a message opens one',
  seenIdle.busy === false && seenIdle.ended === 1 && seenIdle.status === 'success'
  && seenBusy.busy === true && seenBusy.ended === 1,
  `${JSON.stringify(seenIdle)} · ${JSON.stringify(seenBusy)}`);

// `turn_ended` is an end-of-FILE marker, not an event record: the transcript is
// rewritten, and on five lines of two turns there is exactly one (live measurement
// 2026-09-03). Turns cannot be counted by it — the hook keeps the counter; parse must
// survive a form with several markers and name the state by the LAST one.
writeFileSync(transcriptSample, `${[...lines, ...lines].map((l) => JSON.stringify(l)).join('\n')}\n`);
check(': parse survives several markers in the file — state is by the last one',
  readTranscript(transcriptSample).busy === false && readTranscript(transcriptSample).ended === 2,
  JSON.stringify(readTranscript(transcriptSample)));

check(': there is no transcript — parse stays silent and does not invent a state',
  readTranscript(path.join(SB, 'нет-такого.jsonl')) === null);

// --- workspace-directory hash and the injection lock --------------------------------

// Cursor hashes the RESOLVED path: on macOS `$TMPDIR` is a symlink, and a lift from such
// a directory otherwise does not find its own session (live measurement 2026-09-03). We
// check the property on a "symlink — target" pair, not by a hash literal: a literal
// would say nothing about the rule.
const hashTarget = path.join(SB, 'hash-target');
const hashLink = path.join(SB, 'hash-link');
mkdirSync(hashTarget, { recursive: true });
symlinkSync(hashTarget, hashLink);
check(': the workspace-directory hash is taken from the resolved path, not the symlink',
  workspaceHash(hashLink) === workspaceHash(hashTarget),
  `${hashLink} → ${workspaceHash(hashLink)} · ${hashTarget} → ${workspaceHash(hashTarget)}`);

// The injection lock outlives its writer: if the process dies between take and release —
// every later delivery would refuse until the participant is torn down. A live pid holds
// the lock, a dead one does not.
const lockRef = 'Worker: лок (0903-1200)';
const lockRecord = { ref: lockRef, sessionName: 'нет-такой-сессии', tmuxServer: 'нет-такого-сервера' };
writeSession({ ...lockRecord, cwd: SB }, process.env);
const lockPath = path.join(stateHome, 'sessions', `${sessionKey(lockRef)}.inject.lock`);
mkdirSync(path.dirname(lockPath), { recursive: true });
writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
const liveLock = await injectText(lockRecord, 'текст', { env: process.env });
check(': a lock with a LIVE writer holds — a second injection refuses and names the process',
  liveLock.ok === false && /already writing/.test(String(liveLock.error))
  && String(liveLock.error).includes(lockPath) && existsSync(lockPath),
  JSON.stringify(liveLock));

// Dead pid: take a number that is known free — a freshly created process that is already
// gone.
const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
writeFileSync(lockPath, `${JSON.stringify({ pid: dead.pid, at: new Date().toISOString() })}\n`);
const staleLock = await injectText(lockRecord, 'текст', { env: process.env });
check(': an orphan lock is taken over — delivery goes on and then hits the session',
  staleLock.ok === false && !/already writing/.test(String(staleLock.error)),
  `${JSON.stringify(staleLock)} · dead pid ${dead.pid}`);
dropSession(lockRef, process.env);

// --- live loop on stub binaries -----------------------------------------------------

const { ws, repoAbs, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'cursor'] });
mkdirSync(path.join(ws, '.cursor', 'skills', 'techdoc-style-ru'), { recursive: true });
writeFileSync(path.join(ws, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'),
  '---\nname: techdoc-style-ru\ndescription: канон стенда\n---\n');
mkdirSync(path.join(ws, '.cursor', 'skills', '_shared'), { recursive: true });
writeFileSync(path.join(ws, '.cursor', 'skills', '_shared', 'standards.md'), 'общие\n');
writeFileSync(path.join(ws, '.cursor', 'mcp.json'), '{"from":"workspace-root"}\n');
mkdirSync(path.join(ws, '.cursor', 'agents'), { recursive: true });
writeFileSync(path.join(ws, '.cursor', 'agents', 'ls-reviewer.md'), 'субагент\n');
const home = path.join(ws, '.promptobus');
const brief = path.join(SB, 'worker-brief.md');
writeFileSync(brief, '# Cursor driver probe\n\nSend the orchestrator a status and end the turn.\n');

const MARK = 'CURSOR-STATUS-1';
const REVIEW_MARK = 'CURSOR-REVIEW-1';
const NOTE_FILE = 'cursor/note.md';
planParticipant(HARNESS, WORKER, {
  turns: [
    {
      do: [
        // A commit is needed for review: on an empty diff `promptobus review` returns
        // without lifting a reviewer, and the Cursor path would stay unexecuted.
        { write: { path: NOTE_FILE, text: `# ${MARK}\n\nПравка worker'а Cursor.\n` } },
        { commit: { message: `: правка worker'а Cursor` } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK}: worker Cursor на связи` } },
      ],
    },
  ],
});
planParticipant(HARNESS, REVIEWER, {
  turns: [
    { do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${REVIEW_MARK}: замечаний нет` } }] },
  ],
});

// The live-watchdog silence threshold is measured in minutes: the suite shortens it by a
// seam. It is set on `process.env`, not only in command environments: the driver
// `inspect` is also called HERE, from the test process itself, and the contract does not
// pass it an environment of its own.
process.env.PROMPTOBUS_CURSOR_IDLE_MS = '1500';

const env = {
  ...process.env,
  PROMPTOBUS_HOME: home,
  CLAUDE_CODE_SESSION_ID: ORCH_SESSION,
  // The warden is not needed in this file: the wake loop lives in its own file, and a
  // detached process would outlive the run.
  PROMPTOBUS_WARDEN: 'off',
};
store.createTask(home, { id: TASK, title: 'проба driver’а Cursor', owner: ORCH_SESSION });

// Declaration gate: a harness not declared in `promptobus.json` does not lift a
// participant — `sync` did not lay out adapters for it.
const bare = path.join(SB, 'bare-ws');
writeHostConfig(bare, { tools: ['claude'] });
const undeclared = thrown(() => liftHarness(bare, 'cursor'));
check(': a harness outside promptobus.json is refused before lift and names the file and the field',
  undeclared.threw && /promptobus\.json/.test(undeclared.msg) && /"tools" array/.test(undeclared.msg)
  && /"cursor"/.test(undeclared.msg) && !/tools add/.test(undeclared.msg), undeclared.msg);
check(': a declared harness passes the same gate',
  liftHarness(ws, 'cursor').id === 'cursor');

// `--dry-run` prints what lift will execute — and says what is NOT in its output: the
// persist-session name is chosen by the binary itself on start, it cannot be printed in
// advance. Silence about that would read as an omission, and Claude Code has no such
// line at all — there the mechanism chooses the name.
const dry = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cur', '--harness', 'cursor', '--dry-run'], { cwd: ws, env });
const dryClaude = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cl', '--dry-run'], { cwd: ws, env });
check(': --dry-run prints the lift command and the persist-session name form',
  dry.status === 0 && /persist --workspace/.test(dry.out) && /harness session name:/.test(dry.out)
  && /cursor-<directory-slug>/.test(dry.out) && !/harness session name:/.test(dryClaude.out),
  `${dry.out.slice(-600)} · claude: ${dryClaude.out.slice(-200)}`);

check(': --dry-run names the source, the skill count and where they will land',
  dry.status === 0 && /workspace skills: 1 from /.test(dry.out)
  && dry.out.includes(path.join(ws, '.cursor', 'skills'))
  && /does not read the Claude Code skills plugin/.test(dry.out) === false,
  dry.out.split('\n').find((l) => l.includes('workspace skills')) ?? dry.out.slice(0, 300));

const spawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cur', '--harness', 'cursor'], { cwd: ws, env });
check('step 1: promptobus spawn --harness cursor lifted the participant',
  spawned.status === 0 && /worker worker:cur lifted/.test(spawned.out), spawned.out.slice(-500));

const wp = store.participantOf(store.readTask(home, TASK), WORKER);
check('step 1: the participant record carries harness cursor and a snapshot of its capabilities',
  wp?.harness === 'cursor' && wp?.mode === 'managed' && wp?.capabilities?.activation === 'push'
  && wp?.capabilities?.sessionList === true && wp?.capabilities?.enter === true, JSON.stringify(wp));

const ref = wp?.sessionRef ?? '';
const record = readSession(ref, env);
check('step 1: the session landed in the mechanism registry — persist-session name, chat and tmux server',
  !!record && typeof record.sessionName === 'string' && record.sessionName.startsWith('cursor-')
  && typeof record.chatId === 'string' && record.chatId.length > 10
  && record.tmuxServer === 'cursor-agent' && record.cwd === wp?.metadata?.worktree,
  JSON.stringify(record));

// What goes to a human in the participant record is the session NAME — `attach` and
// `stop` are called with it; the full id is the chat, and address ownership is checked
// against it too, because the end-of-turn hook brings it.
check('step 1: the human session handle is its name, the full id is the chat',
  wp?.metadata?.session === record?.sessionName && wp?.metadata?.sessionId === record?.chatId,
  `${wp?.metadata?.session} · ${wp?.metadata?.sessionId} · ${record?.sessionName} · ${record?.chatId}`);

const listed = listSessions({ env });
const mine = listed.find((s) => s.name === record?.sessionName) ?? null;
check('step 1: the persist session lives on the shared server and is marked with the mechanism task and address',
  !!mine && mine.managed === true && mine.chatId === record?.chatId
  && mine.task === TASK && mine.address === WORKER,
  JSON.stringify(listed));

// The pty-provider pane is killed right after confirmation: it is lift machinery, not
// the participant session, and it has no place in the human list.
check('step 1: the one-shot pty-provider pane is gone — its server is empty',
  listSessions({ server: 'promptobus-launch', env }).length === 0,
  JSON.stringify(listSessions({ server: 'promptobus-launch', env })));

// The bus's own server is approved POINTWISE, from the participant directory:
// `--approve-mcps` would have approved every workspace server into a foreign project
// record.
const approvals = readdirSync(path.join(HARNESS, 'approvals'))
  .flatMap((f) => JSON.parse(readFileSync(path.join(HARNESS, 'approvals', f), 'utf8')));
check('step 1: exactly the bus own server is approved, pointwise',
  JSON.stringify(approvals) === JSON.stringify(['promptobus']), JSON.stringify(approvals));

const wt = wp?.metadata?.worktree ?? ws;
check('step 1: four .cursor/ files landed in the participant worktree — mcp, permissions, hooks and gitignore',
  existsSync(path.join(wt, '.cursor', 'mcp.json')) && existsSync(path.join(wt, '.cursor', 'cli.json'))
  && existsSync(path.join(wt, '.cursor', 'hooks.json'))
  && readFileSync(path.join(wt, '.cursor', '.gitignore'), 'utf8') === '*\n',
  readdirSync(path.join(wt, '.cursor')).join(','));

check('step 1: canon skills landed in the worktree, root mcp/agents did not travel',
  existsSync(path.join(wt, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'))
  && existsSync(path.join(wt, '.cursor', 'skills', '_shared', 'standards.md'))
  && !existsSync(path.join(wt, '.cursor', 'agents'))
  && !readFileSync(path.join(wt, '.cursor', 'mcp.json'), 'utf8').includes('workspace-root'),
  readdirSync(path.join(wt, '.cursor')).join(','));

const wtDirty = spawnSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' });
const wtPorc = String(wtDirty.stdout ?? '');
const cloneCommonRaw = String(spawnSync('git', ['-C', repoAbs, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).stdout ?? '').trim();
const cloneCommon = path.isAbsolute(cloneCommonRaw) ? cloneCommonRaw : path.join(repoAbs, cloneCommonRaw);
const cloneExclude = path.join(cloneCommon, 'info', 'exclude');
const cloneExcludeText = existsSync(cloneExclude) ? readFileSync(cloneExclude, 'utf8') : '';
check('step 1: the participant .cursor hides itself with its .gitignore — the clone shared exclude has no .cursor/, status does not see it',
  !cloneExcludeText.split('\n').some((l) => l.trim() === '.cursor/' || l.trim() === '.cursor')
  && !wtPorc.split('\n').some((l) => l.includes('.cursor/')),
  `${cloneExclude} · ${cloneExcludeText} · ${wtPorc.trim()}`);

// `.cursor/*` files do not dirty the clone: they sit INSIDE the service worktree, and
// that is excluded whole (`WORKTREE_DIR_REL`). The worktree itself without its
// `.gitignore` would see `.cursor/` as untracked and `done` would leave the directory.
// We check the clone property, not a string.
const dirty = spawnSync('git', ['-C', repoAbs, 'status', '--porcelain'], { encoding: 'utf8' });
check('step 1: the participant .cursor does not dirty the working copy — the worktree is excluded whole',
  dirty.status === 0 && String(dirty.stdout ?? '').trim() === '',
  `${String(dirty.stdout ?? '').trim()} · ${cloneExcludeText.split('\n').filter(Boolean).slice(-2).join(' | ')}`);

const sent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK)) ?? null, { timeoutMs: 30000 });
check('step 2: the bus loop from Cursor closed — the participant status reached the orchestrator',
  !!sent, `${JSON.stringify(sent)} · ${diagnoseTrace(HARNESS, WORKER)}`);

// End of turn under persist is brought by the `stop` hook: it also sets the end-of-turn
// mark and hands over the contact point. `sessionEnd` does not fire at all — without the
// translation the mark would never appear.
check('step 2: the stop hook ran — the participant end-of-turn mark is in place',
  await waitFor(() => store.lastTurnAt(home, TASK, WORKER) !== null, { timeoutMs: 20000 }),
  String(store.lastTurnAt(home, TASK, WORKER)));

const wake = await waitFor(() => store.readWake(home, TASK, WORKER), { timeoutMs: 20000 });
check('step 2: the contact point was handed over by the hook and carries a finished-turn counter',
  typeof wake?.socket === 'string' && /#\d+$/.test(wake.socket) && wake.session === record?.chatId,
  `${JSON.stringify(wake)} · chat ${record?.chatId}`);

const idle = await waitFor(() => {
  const view = cursorDriver.inspect(ref);
  return view && view.busy === false ? view : null;
}, { timeoutMs: 20000 });
check('step 3: the turn ended — the session is alive, not busy, and is named with the persist-session name',
  idle?.state === 'alive' && idle?.busy === false && idle?.id === record?.sessionName,
  JSON.stringify(idle));

{
  const idleStatus = cli([ 'status', '--task', TASK], { cwd: ws, env });
  const idleLine = idleStatus.out.split('\n').find((l) => l.includes(WORKER)) ?? idleStatus.out;
  check(': idle after a turn — inspect.unknown, status is not a stall of unknown nature',
    idle?.stall?.kind === 'unknown' && /the turn ended/.test(String(idle?.stall?.reason))
    && idleStatus.status === 0 && /waiting for a message/.test(idleLine) && !/STALLED/.test(idleLine),
    `${JSON.stringify(idle)} · ${idleLine}`);
}

check('step 3: the chat transcript was found by its id and written into the registry',
  !!transcriptOf(readSession(ref, env), env) && readSession(ref, env)?.transcript?.includes(record?.chatId),
  String(readSession(ref, env)?.transcript));

check('step 3: the stall route calls a human into the session with a persist command',
  cursorDriver.stallRoute({ kind: 'unknown', address: WORKER, repoAbs: wt }, record?.sessionName)
    .includes(`agent persist attach ${record?.sessionName}`),
  cursorDriver.stallRoute({ kind: 'unknown', address: WORKER, repoAbs: wt }, record?.sessionName));

// A session has one writer, and the lock holds that: two injections at once would glue
// two messages into one — the second text would land in the input field on top of the
// first, between paste and Enter.
const race = await Promise.all([1, 2].map(() => cursorDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
})));
check(': two injections at once — one delivered, the other refused by the lock',
  race.filter((r) => r.ok).length === 1
  && /already writing/.test(String(race.find((r) => !r.ok)?.error)),
  JSON.stringify(race));

const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
check('step 3: promptobus status shows Cursor session liveness in the words of its driver',
  statusOut.status === 0 && statusOut.out.includes(WORKER) && /session /.test(statusOut.out),
  statusOut.out.slice(-400));

// --- Cursor reviewer: its own sandbox and its own cleanup ---------------------------

const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'cursor'], { cwd: ws, env });
check('step 4: promptobus review --harness cursor lifted the reviewer',
  reviewed.status === 0 && /reviewer reviewer:cur started/.test(reviewed.out), reviewed.out.slice(-500));

const rp = store.participantOf(store.readTask(home, TASK), REVIEWER);
check('step 4: the reviewer record carries the same harness and the denied tools are declared',
  rp?.harness === 'cursor' && rp?.capabilities?.denyTools === true, JSON.stringify(rp?.capabilities));

// The reviewer sits in ITS own sandbox: the binary has no one-shot settings file, and
// sitting in the reviewed clone would mean writing three files into a foreign working
// tree.
const sandbox = reviewSandbox(store.participantSettingsPath(home, TASK, REVIEWER));
check('step 4: the reviewer sandbox is created, and it is a git directory — otherwise the bus config is not read',
  existsSync(path.join(sandbox, '.git')) && existsSync(path.join(sandbox, '.cursor', 'mcp.json'))
  && existsSync(path.join(sandbox, '.cursor', 'cli.json')),
  existsSync(sandbox) ? readdirSync(sandbox).join(',') : 'no sandbox');

check('step 4: the reviewer got canon skills in the sandbox',
  existsSync(path.join(sandbox, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md')),
  existsSync(path.join(sandbox, '.cursor')) ? readdirSync(path.join(sandbox, '.cursor')).join(',') : 'no .cursor');

check('step 4: reviewer read-only sits in its .cursor/cli.json',
  JSON.stringify(JSON.parse(readFileSync(path.join(sandbox, '.cursor', 'cli.json'), 'utf8')).permissions.deny)
  === JSON.stringify(['Write(**)', 'Shell(**)']),
  readFileSync(path.join(sandbox, '.cursor', 'cli.json'), 'utf8'));

const reviewSent = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(REVIEW_MARK)) ?? null, { timeoutMs: 30000 });
check('step 4: the Cursor reviewer report reached the orchestrator on the same bus',
  !!reviewSent, `${JSON.stringify(reviewSent)} · ${diagnoseTrace(HARNESS, REVIEWER)}`);

// The option vocabulary is asked of THIS participant driver, not the lift driver
// (review note): a re-review already has a record, and a check against a foreign
// vocabulary would let a Claude Code level through into Cursor — that would ride out as
// a model-id suffix.
const alienEffort = cli([ 'review', wt, '--task', TASK, '--effort', 'ultracode'], { cwd: ws, env });
check('step 4: --effort is checked against the reviewer own harness vocabulary, not the lift one',
  alienEffort.status !== 0 && /ultracode/.test(alienEffort.out) && !/ultracode/.test(cursorDriver.options.effortLevels.join(',')),
  alienEffort.out.slice(-260));

const alienHarness = cli([ 'review', wt, '--task', TASK, '--harness', 'claude'], { cwd: ws, env });
check('step 4: --harness on an already lifted reviewer is refused, not silently ignored',
  alienHarness.status !== 0 && /was started by harness cursor/.test(alienHarness.out), alienHarness.out.slice(-260));

// An "address already working" refusal must name an EXECUTABLE harness route. Under
// persist it appeared: `agent persist stop <name>` really kills the session, after which
// a second spawn goes through — under headless there was nothing to kill a single
// session with at all.
const busyAddr = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'cur', '--harness', 'cursor'], { cwd: ws, env });
check('step 4: spawn on a live address refuses with a route that really kills the session',
  busyAddr.status !== 0 && /agent persist stop/.test(busyAddr.out) && /--worker/.test(busyAddr.out),
  busyAddr.out.slice(-300));

const dirtyAfterReview = spawnSync('git', ['-C', repoAbs, 'status', '--porcelain'], { encoding: 'utf8' });
check('step 4: the reviewed clone stayed clean — the reviewer put nothing into it',
  String(dirtyAfterReview.stdout ?? '').trim() === '', String(dirtyAfterReview.stdout ?? '').trim());

// --- teardown and cleanup -----------------------------------------------------------

// After a session two kinds of processes remain, and both were measured in the spike
// (REPORT §4.8): tool children that `persist stop` does not touch at all, and an orphan
// `worker-server` that lives for minutes even after a NORMAL end of turn. We take the
// list BEFORE teardown — after it it is empty by construction, and the verdict would be
// green even if they had never been there.
function processesOf(pattern, marker = null) {
  const listedPs = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  const out = [];
  for (const line of String(listedPs.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m || !pattern.test(m[2])) continue;
    if (marker) {
      const dump = spawnSync('ps', ['eww', '-o', 'command=', '-p', m[1]], { encoding: 'utf8' });
      if (!String(dump.stdout ?? '').includes(marker)) continue;
    }
    out.push(Number(m[1]));
  }
  return out;
}
const marker = `PROMPTOBUS_CURSOR_SESSION=${sessionFile(ref, env)}`;
const orphansBefore = processesOf(/worker-server/, marker);
const paneBefore = readSession(ref, env)?.panePid ?? null;
const kidsBefore = processesOf(/tool child/).filter((pid) => {
  const dump = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
  return Number(String(dump.stdout ?? '').trim()) === Number(paneBefore);
});
check('step 5: before teardown both kinds of process are alive — the orphan and the tool child',
  orphansBefore.length > 0 && kidsBefore.length > 0,
  `orphans ${JSON.stringify(orphansBefore)} · children ${JSON.stringify(kidsBefore)} of pane ${paneBefore}`);

const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
check('step 5: promptobus done closed the task and stopped the Cursor participants',
  done.status === 0, done.out.slice(-600));

check('step 5: no mechanism persist sessions left on the tmux server',
  listSessions({ env }).length === 0, JSON.stringify(listSessions({ env })));

check('step 5: no session record left in the registry — the directory does not pile up',
  !existsSync(sessionFile(ref, env)) && cursorDriver.inspect(ref)?.state === 'gone',
  `${sessionFile(ref, env)} · ${JSON.stringify(cursorDriver.inspect(ref))}`);

check('step 5: teardown collected both the orphan and the tool child — nothing left on the machine',
  processesOf(/worker-server/, marker).length === 0
  && kidsBefore.every((pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return e.code !== 'EPERM';
    }
  }),
  `orphans were ${JSON.stringify(orphansBefore)}, became ${JSON.stringify(processesOf(/worker-server/, marker))};`
  + ` children ${JSON.stringify(kidsBefore)}`);

check('step 5: the participant MCP config with tokens was removed by task cleanup',
  !existsSync(store.participantMcpPath(home, TASK, WORKER)),
  store.participantMcpPath(home, TASK, WORKER));

// The same cleanup sweeps the reviewer sandbox: inside it is the same MCP config with
// substituted tokens, and leaving it would mean leaving them on disk.
check('step 5: the reviewer workspace was removed by task cleanup together with its bus config',
  !existsSync(sandbox), sandbox);

// `done` always removes the sandbox. The worktree — only an uninhabited one: a worker
// branch with a commit off default stays, and the skills with it — the same life as the
// other `.cursor/` files.
check('step 5: skills live with the participant directory — gone from the sandbox, in place on a left worktree',
  !existsSync(path.join(sandbox, '.cursor', 'skills'))
  && (existsSync(wt)
    ? existsSync(path.join(wt, '.cursor', 'skills', 'techdoc-style-ru', 'SKILL.md'))
    : true),
  `${wt} · ${sandbox}`);

// --- watchdog on transcript silence and the stale state -----------------------------

// A turn that does not end cannot be killed under persist: the mechanism no longer has
// a turn process. The silence threshold therefore gives a VERDICT — "the transcript has
// been silent longer than the threshold" — and the session stays alive, and a message
// will be delivered to it.
const HANG_TASK = 'cursorhang-t20260903-000000';
const HANG_WORKER = 'worker:hang';
store.createTask(home, { id: HANG_TASK, title: 'молчащий ход Cursor', owner: ORCH_SESSION });
const hangEnv = { ...env, [HANG_VAR]: '1' };
// Its own brief: the work-chunk title sets the session name, and the session name is
// the registry key.
const hangBrief = path.join(SB, 'hang-brief.md');
writeFileSync(hangBrief, '# Silent Cursor turn\n\nDo nothing.\n');
const hangSpawn = cli([ 'spawn', '--repo', repo, '--brief', hangBrief, '--task', HANG_TASK,
  '--worker', 'hang', '--harness', 'cursor'], { cwd: ws, env: hangEnv });
const hangRef = store.participantOf(store.readTask(home, HANG_TASK), HANG_WORKER)?.sessionRef ?? '';
check(': a participant with a silent turn is up — the session is live, and the turn does not end',
  hangSpawn.status === 0 && !!hangRef && hangRef !== ref, `${hangSpawn.out.slice(-200)} · ${hangRef}`);

const silent = await waitFor(() => {
  const view = cursorDriver.inspect(hangRef);
  return view?.stall?.kind === 'watchdog' ? view : null;
}, { timeoutMs: 30000 });
check(': a turn silent past the threshold — a watchdog verdict, and the session stays alive',
  silent?.state === 'alive' && silent?.busy === true && /silent/.test(String(silent?.stall?.reason)),
  `${JSON.stringify(silent)} · ${JSON.stringify(turnState(readSession(hangRef, env), env))}`);

const hangStatus = cli([ 'status', '--task', HANG_TASK], { cwd: ws, env });
const hangLine = hangStatus.out.split('\n').find((l) => l.includes(HANG_WORKER)) ?? hangStatus.out;
check(': the status line of a standing Cursor does not contain claude — the route is from its driver',
  hangStatus.status === 0 && /STALLED/.test(hangLine) && !/claude /.test(hangLine)
  && /agent persist/.test(hangLine),
  hangLine);

const HANG_CHILD_TASK = 'cursorhangchild-t20260903-000000';
const HANG_CHILD_WORKER = 'worker:hangchild';
store.createTask(home, { id: HANG_CHILD_TASK, title: 'молчащий ход с живым процессом', owner: ORCH_SESSION });
const hangChildEnv = { ...env, [HANG_CHILD_VAR]: '1' };
const hangChildBrief = path.join(SB, 'hang-child-brief.md');
writeFileSync(hangChildBrief, '# Silent Cursor turn with a live child\n\nWait.\n');
const hangChildSpawn = cli([ 'spawn', '--repo', repo, '--brief', hangChildBrief,
  '--task', HANG_CHILD_TASK, '--worker', 'hangchild', '--harness', 'cursor'],
{ cwd: ws, env: hangChildEnv });
const hangChildRef = store.participantOf(store.readTask(home, HANG_CHILD_TASK), HANG_CHILD_WORKER)
  ?.sessionRef ?? '';
check(': a participant with silence and a live pane child is up',
  hangChildSpawn.status === 0 && !!hangChildRef, `${hangChildSpawn.out.slice(-200)} · ${hangChildRef}`);

const living = await waitFor(() => {
  const view = cursorDriver.inspect(hangChildRef);
  return view?.busy && !view?.stall && /processes are alive/.test(String(view?.note)) ? view : null;
}, { timeoutMs: 30000 });
check(': transcript silence with a live pane child is not a stop, the line is honest',
  living?.state === 'alive' && living?.stall === null
  && /silent for \d+ s, processes are alive/.test(String(living?.note))
  && !/stood/i.test(String(living?.note)),
  JSON.stringify(living));

const livingStatus = cli([ 'status', '--task', HANG_CHILD_TASK], { cwd: ws, env });
const livingLine = livingStatus.out.split('\n').find((l) => l.includes(HANG_CHILD_WORKER))
  ?? livingStatus.out;
check(': status on silence with live processes does not say STALLED',
  livingStatus.status === 0 && /is alive/.test(livingLine) && !/STALLED/.test(livingLine)
  && /processes are alive/.test(livingLine),
  livingLine);

cli([ 'done', '--task', HANG_CHILD_TASK], { cwd: ws, env });

// The third liveness signal, and the shape the first two are blind to (PB-7): the turn
// edits files inside one long call, so the transcript does not grow AND nothing was
// spawned — yet the session is working. Twice on live runs this was reported as a stall
// while the owner's panel showed sixteen files edited.
const HANG_WRITE_TASK = 'cursorhangwrite-t20260903-000000';
const HANG_WRITE_WORKER = 'worker:hangwrite';
store.createTask(home, { id: HANG_WRITE_TASK, title: 'молчащий ход, который правит файлы', owner: ORCH_SESSION });
const hangWriteEnv = { ...env, [HANG_WRITE_VAR]: '1' };
const hangWriteBrief = path.join(SB, 'hang-write-brief.md');
writeFileSync(hangWriteBrief, '# Silent Cursor turn that edits files\n\nEdit.\n');
const hangWriteSpawn = cli([ 'spawn', '--repo', repo, '--brief', hangWriteBrief,
  '--task', HANG_WRITE_TASK, '--worker', 'hangwrite', '--harness', 'cursor'],
{ cwd: ws, env: hangWriteEnv });
const hangWriteRef = store.participantOf(store.readTask(home, HANG_WRITE_TASK), HANG_WRITE_WORKER)
  ?.sessionRef ?? '';
check(': a participant that edits files with neither transcript growth nor a tool process is up',
  hangWriteSpawn.status === 0 && !!hangWriteRef, `${hangWriteSpawn.out.slice(-200)} · ${hangWriteRef}`);

// The wait is on the TRANSCRIPT being silent past the threshold first: without that a
// green verdict would only mean the turn had not been silent long enough yet, which is
// true of every session in its first seconds.
const working = await waitFor(() => {
  const seen = turnState(readSession(hangWriteRef, env), env);
  if (!seen.silent) return null;
  const view = cursorDriver.inspect(hangWriteRef);
  return view?.busy ? view : null;
}, { timeoutMs: 30000 });
check(': a silent turn writing in its worktree is not a stall, and the line says how recently',
  working?.state === 'alive' && working?.stall === null
  && /silent for \d+ s, and the worktree was written \d+ s ago/.test(String(working?.note)),
  JSON.stringify(working));

const workingStatus = cli([ 'status', '--task', HANG_WRITE_TASK], { cwd: ws, env });
const workingLine = workingStatus.out.split('\n').find((l) => l.includes(HANG_WRITE_WORKER))
  ?? workingStatus.out;
check(': status does not call an editing participant STALLED',
  workingStatus.status === 0 && !/STALLED/.test(workingLine) && /worktree was written/.test(workingLine),
  workingLine);

cli([ 'done', '--task', HANG_WRITE_TASK], { cwd: ws, env });

// And the other end of the same criterion: a session nothing writes for still stalls,
// and the verdict names each of the three measurements with its span.
check(': the stall verdict names what was measured and for how long',
  /transcript has been silent for \d+ s \(threshold \d+ s\)/.test(String(silent?.stall?.reason))
  && /no tool processes under the pane/.test(String(silent?.stall?.reason))
  && /nothing was written in the worktree for \d+ s|the worktree could not be read/
    .test(String(silent?.stall?.reason)),
  String(silent?.stall?.reason));

check(': the route names the three signals without claiming a measurement it cannot see', (() => {
  // The route is handed the stall KIND and nothing else — not the numbers, and not whether
  // the worktree could be read at all. A reviewer's cwd is a sandbox with no commits, so
  // "could not be read" is its permanent state, and a route asserting the worktree "is not
  // being written" would be stating a measurement nobody made.
  const route = cursorDriver.stallRoute({ kind: 'watchdog', address: HANG_WORKER, repoAbs: wt }, 'x');
  return /or it could not be read/.test(route) && /no write was detected/.test(route);
})(), cursorDriver.stallRoute({ kind: 'watchdog', address: HANG_WORKER, repoAbs: wt }, 'x'));

check(': the silence really happened — the stand marked it in the participant trace',
  readTrace(HARNESS, HANG_WORKER).some((e) => e.kind === 'hang'),
  diagnoseTrace(HARNESS, HANG_WORKER));

// The `stale` state appeared under persist: a session can be killed from outside, and
// the `persist` state lives in `/tmp` and does not survive a reboot. Under headless it
// was not there on any outcome.
const hangRecord = readSession(hangRef, env);
tmux(['kill-session', '-t', hangRecord.sessionName], { env });
const gone = cursorDriver.inspect(hangRef);
check(': the session is not on the tmux server, and the record is — that is stale, and the route calls the list',
  gone?.state === 'stale' && gone?.stall?.kind === 'stale'
  && /persist list/.test(cursorDriver.stallRoute({ kind: 'stale', address: HANG_WORKER }, gone.id)),
  `${JSON.stringify(gone)} · ${cursorDriver.stallRoute({ kind: 'stale', address: HANG_WORKER }, gone.id)}`);

const wakeStale = await cursorDriver.activate({ ref: hangRef }, {
  kind: 'unread', task: HANG_TASK, address: HANG_WORKER, unread: 1, messages: [],
});
check(': there is nothing to deliver into a session killed from outside — the refusal names the reason',
  wakeStale?.ok === false && /on the tmux server/.test(String(wakeStale?.error)), JSON.stringify(wakeStale));

cli([ 'done', '--task', HANG_TASK], { cwd: ws, env });
restore();
