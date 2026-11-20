import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { REACHABLE_BINARIES } from './hygiene.mjs';
import { participantFileStem } from '../dist/index.js';
import { threadStartConfig } from '../lib/codex-session.js';
import { sourceFile } from './source-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => process.env.PROMPTOBUS_DOCS_REV
  ? execFileSync('git', ['show', `${process.env.PROMPTOBUS_DOCS_REV}:${file}`], { cwd: root, encoding: 'utf8' })
  : readFileSync(path.join(root, file), 'utf8');
const readSource = (file) => read(sourceFile(file, (candidate) => process.env.PROMPTOBUS_DOCS_REV
  ? spawnSync('git', ['cat-file', '-e', `${process.env.PROMPTOBUS_DOCS_REV}:${candidate}`], {
    cwd: root, stdio: 'ignore',
  }).status === 0
  : existsSync(path.join(root, candidate))));
const adr = (number, slug) => read(`docs/adr/adr-${number}-${slug}.md`);
const compact = (value) => value.replace(/\s+/g, ' ').trim();
const has = (passage, claim) => compact(passage).includes(compact(claim));
const section = (document, heading) => {
  const lines = document.split('\n');
  const start = lines.findIndex((line) => line === heading);
  if (start < 0) return '';
  const depth = heading.match(/^#+/)[0].length;
  const end = lines.findIndex((line, index) => index > start
    && /^#+ /.test(line) && line.match(/^#+/)[0].length <= depth);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};
const decision = (document, label, nextLabel) => section(document, '## Decision')
  .split(`**${label}.**`)[1]?.split(`**${nextLabel}.**`)[0] ?? '';

check('docs: release writer requires a regression for factual corrections, not style alone',
  has(section(read('docs/guides/releasing.md'), '## Technical-writer pass'),
    'A currency correction that changes a documented fact or contract needs a regression check that fails on the old text: a quote, a test, or a lint rule. A style-only edit that changes no fact does not need a currency regression.'));

check('docs: participant file-stem list includes the child root prefix',
  has(read('docs/reference/04-protocol.md'), `\`teamlead-<slug>\`, \`${participantFileStem('root:<slug>')}\`, \`peer-<slug>\``));

check('docs: orchestration send routes admit the child-side root address',
  has(read('skills/orchestrate/SKILL.md'), "governance routes also admit registered teamleads, a child task's `root:<root slug>`, linked peers and `user` under their message-type rules"));

const hostReference = read('docs/reference/02-host.md');
const readerAssertion = read('test/host.test.mjs').match(/const expectedToolBinReaders = (\d+);/)?.[1];
const toolBinDocs = section(hostReference, '## Tool binaries');
check('docs: HostToolBin reader count describes the dynamic source scan',
  readerAssertion !== undefined
  && has(toolBinDocs, 'dynamically discovers driver and availability adapter source files, adds `lib/harness-home.ts`, deduplicates source paths')
  && has(toolBinDocs, `asserts ${readerAssertion} source readers, not a fixed number of drivers or adapters`)
  && has(toolBinDocs, 'investigating which reader was added, removed or missed by the scan')
  && !has(toolBinDocs, 'finds seven readers'));

const standaloneDecision = adr('002', 'standalone-host-contract');
const shortHost = section(hostReference, '### The host contract, in one sentence per member');
check('docs: passed Hosts do not bypass first native bindings or explicit service client context',
  [standaloneDecision, shortHost].every(text => has(text, 'first process-wide harness-home and post-lift tool-binary bindings win')
    && has(text, 'explicit client context') && has(text, 'admission checks the common native bindings'))
  && !/Nothing hidden in module scope joins them|Two hosts in one process stay independent|one process are lawful and independent/.test(compact(standaloneDecision + shortHost)));

const observerRoot = 'integrations/bb-native-observer';
const observerDocs = section(read(`${observerRoot}/README.md`), '## Observer boundary');
const observerContract = read(`${observerRoot}/contract.ts`);
check('docs: observer catalogue and bounded owner feed follow their separate outputs',
  has(observerContract, 'tasks: { input: rootsSchema, output: catalogueSchema }, ownerFeed: { input: selectionSchema, output: ownerFeedSchema }')
  && has(observerDocs, '`tasks` returns the catalogue `{tasks, truncated, scanned}`: at most 256 valid tasks from at most 4096 scanned directory entries')
  && has(observerDocs, '`ownerFeed` returns `taskId`, `state`, `ownerParticipantId`, `ownerSessionRef` and up to 4096 owner message headers in `messages`: `id`, `sender`, `recipients` and `type`, without bodies')
  && has(observerDocs, 'A missing task or store returns `not prepared`, an empty owner participant id, a null session reference and no messages'));

const launchDocs = ['docs/guides/hooks-and-trust.md', 'docs/reference/05-drivers.md'];
for (const [role, file, planner, oldCitation] of [
  ['teamlead', 'spawn', 'planTeamlead', 'lib/spawn.js:726'],
  ['reporter', 'report', 'planReport', 'lib/report.js:180'],
]) {
  const body = read(`lib/${file}.ts`).split(`export async function ${planner}(`)[1]?.split('\nexport ', 1)[0] ?? '';
  check(`docs: ${role} install-root citation identifies the planner that supplies launch cwd`,
    /const root = canonicalPath\(host\.workspaceRoot\(\)\)/.test(body)
    && /driver\.prepare!\(\{[\s\S]*?cwd: root, root,/.test(body)
    && launchDocs.every(doc => has(read(doc), `[\`${planner}\`](../../lib/${file}.ts)`)
      && has(read(doc), 'both pass the canonical `host.workspaceRoot()` as the launch `cwd`')
      && !has(read(doc), oldCitation)));
}

check('docs: readable owner progress neither wakes nor escalates; blocking HOLD needs a question',
  has(read('docs/reference/04-protocol.md'), 'the warden neither knocks nor escalates to `SILENT`')
  && has(read('docs/reference/04-protocol.md'), 'an unreadable inbox remains conservatively actionable')
  && has(read('docs/reference/03-cli.md'), 'Readable progress-only owner mail is not a `SILENT` trigger, but unreadable inboxes are conservatively actionable')
  && has(read('skills/orchestrate/SKILL.md'), 'Before ending a blocking HOLD, send an actionable `question`')
  && has(read('skills/orchestrate/SKILL.md'), 'release comes as `answer`. Use `result` for completion')
  && has(read('lib/prompts/roles.ts'), 'Before ending a blocking HOLD, send a question')
  && !/knocks when mail arrives|wake this owner when mail arrives|deliver postcards when mail arrives/.test(
    read('skills/orchestrate/SKILL.md') + read('docs/reference/03-cli.md') + read('lib/lead.ts')));

const shutdownInstructions = read('skills/orchestrate/SKILL.md');
const stopDecision = adr('012', 'stopping-one-participant-is-a-verb-of-its-own');
check('docs: managed child Stop precedes root self-Stop and authorized proof inspection',
  /first stops each owned child with `stop teamlead:<slug>`.*Then it requests `stop orchestrator`.*pending self-Stop acknowledgement is not confirmation.*authorized observer/.test(shutdownInstructions)
  && has(shutdownInstructions, 'Do not use `done --keep-sessions` before confirmed Stop')
  && has(shutdownInstructions, 'Task closure and service shutdown are separate')
  && has(stopDecision, 'It refuses an unknown or attached participant')
  && has(stopDecision, 'A managed orchestrator is eligible under the same owner gate')
  && has(stopDecision, 'An unconfirmed stop is not a confirmed closure'));

check('docs: native admission requires actual proof and Cursor observation preserves its registry revision',
  has(read('docs/reference/05-drivers.md'), 'Missing proof retains an unresolved binding and refuses actor tools;')
  && has(read('docs/reference/05-drivers.md'), 'Cursor turn-state observation reads or discovers its transcript without rewriting the registry.')
  && !has(read('docs/reference/05-drivers.md'), 'These bindings remain explicitly unresolved, without disabling their ordinary routes'));

check('docs: Cursor admission preserves concurrent wake metadata without accepting ownership changes',
  has(read('docs/reference/05-drivers.md'), 'Admission and wake updates publish under the task lock, preserving concurrent `turns` and `last` metadata.')
  && has(read('docs/reference/05-drivers.md'), 'Every other session field and the participant ownership must still match the captured generation;'));

check('docs: standalone consumer launch preserves its owner entry and direct POSIX parent',
  has(read('docs/reference/02-host.md'), 'A custom consumer Host requires its own POSIX wrapper using the returned `execPlanCommand` prefix.')
  && has(read('docs/reference/02-host.md'), 'Append `--launcher-pid "$$" -- <executable> [args...]`')
  && has(read('docs/reference/02-host.md'), 'source that plan in the same launcher.'));

check('docs: removed detached review delivery is distinct from finite inline protocol proof',
  has(read('docs/reference/05-drivers.md'), 'The current contract removes detached review delivery; the finite `inline` review witness remains valid.')
  && has(read('docs/reference/05-drivers.md'), 'Generic holder RPC forwarding does not certify arbitrary review parameters or establish native workflow readiness.')
  && has(read('CHANGELOG.md'), 'SessionStart and Stop hooks on codex-cli 0.164.0, plus a hidden-model turn'));

check('docs: standalone workflows remain required while ordinary BB creation is optional',
  has(read('docs/reference/02-host.md'), 'Ordinary BB creation is optional for release; this entrypoint remains unsupported.')
  && has(read('docs/reference/02-host.md'), 'Standalone ordinary workflows remain required.'));

check('docs: development generations and managed BB release delivery have distinct installation routes',
  has(read('docs/reference/02-host.md'), 'Development generations use local path delivery:')
  && has(read('docs/reference/02-host.md'), 'Managed releases use the collection below.')
  && !has(read('docs/reference/02-host.md'), 'Supported delivery is a local path:'));

check('docs: the native dashboard includes owner binding and background notifications',
  has(read('docs/reference/02-host.md'), 'Both `selectTask` and `bindOwner` persist plugin configuration.')
  && has(read('docs/reference/02-host.md'), 'Owner notifications are a built-in background service.')
  && has(read('docs/reference/02-host.md'), 'canonical mailbox consumption remains with the owner.')
  && !has(read('docs/reference/02-host.md'), 'An installed bundle may also provide owner notifications;'));

check('docs: replacing a BB path source preserves journals and starts fresh bindings',
  has(read('docs/guides/bb-plugins.md'), 'BB refuses installing a Git source over an id registered from `path:`.')
  && has(read('docs/guides/bb-plugins.md'), 'Keep canonical task stores and original command receipts in place.')
  && has(read('docs/guides/bb-plugins.md'), 'do not restore an old binding database into the new installation.')
  && has(read('docs/reference/02-host.md'), 'Later Git range updates preserve the installed plugin\'s state.'));

check('docs: explicit BB Stop separates runtime observation from child attention suppression',
  has(read('integrations/bb/README.md'), 'childNotifications.complete')
  && has(read('integrations/bb/README.md'), 'A child of a paused parent starts with `off`.')
  && has(read('docs/reference/02-host.md'), 'Stop waits for an in-flight spawn')
  && has(read('docs/reference/02-host.md'), 'Unknown spawn outcomes need operator recovery.')
  && has(read('integrations/bb/README.md'), 'user message. Do not repeat completed commands or widen permissions.')
  && !has(read('integrations/bb/README.md'), '`off` would also suppress attention and is not used.'));

check('docs: replacing a retained BB database starts fresh without deleting journals',
  has(read('docs/guides/bb-plugins.md'), 'BB removal retains the plugin database.')
  && has(read('docs/guides/bb-plugins.md'), 'move its complete private directory into the retained backup')
  && has(read('docs/guides/bb-plugins.md'), 'verify that `bb promptobus bindings` is empty'));

check('docs: bounded BB live measurements retain counts and provider recovery limits',
  has(read('docs/reference/02-host.md'), '1 request and started 1 turn')
  && has(read('docs/reference/02-host.md'), '0 new requests and 0 new turns.')
  && has(read('integrations/bb/README.md'), 'PermissionNotFoundError')
  && has(read('integrations/bb/README.md'), 'the nine commands were not repeated.')
  && !has(read('docs/reference/05-drivers.md'), 'the adapter is source-only and unreleased.'));

check('docs: declined Stop evidence preserves the non-start outcome and null exit',
  has(section(read('docs/reference/05-drivers.md'), '### Codex holder shutdown'),
    'The retained outcome remains `declined` with a null exit; it proves no command or test execution.')
  && has(read('README.md'), 'its null exit stays null.')
  && has(read('CHANGELOG.md'), 'Keep its exit null and reject conflicting evidence during observation and receipt replay.'));

const leaseSection = section(read('docs/reference/03-cli.md'), '## Lease');
check('docs: the publisher result file belongs to the keyed-publication fixture, not the lease contract',
  has(leaseSection, 'promptobus lease [--as <address>]')
  && !has(leaseSection, 'publisher result file')
  && has(section(read('docs/guides/contributing.md'), '## Suite isolation'),
    'Its publisher result file is a fixture artifact.'));

const adr008 = adr('008', 'codex-reviewer-working-directory');
const adr017 = adr('017', 'the-owner-gate-is-a-positive-proof');
const adr019 = adr('019', 'session-address-per-task-lands');
const adr024 = adr('024', 'approver-acceptance-in-own-worktree');
const resolutions = [
  has(section(adr008, '## Current resolution'),
    'worker and reviewer turns recorded Stop; see [hooks and trust](../guides/hooks-and-trust.md#a-participants-hooks-are-not-the-workspaces) and [the Codex driver](../reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver). The approver evidence in [ADR-024](adr-024-approver-acceptance-in-own-worktree.md) records SessionStart. It does not establish that an approver Stop hook ran.'),
  has(section(adr008, '## Current resolution'),
    "The holder now accepts Codex's `mcpServer/elicitation/request` only for a tool-call approval from a server configured in the participant home; other elicitations remain declined. A later live reviewer sent a bus `result` after those approvals."),
  has(section(adr019, '## Decision'),
    'The positive session binding now gates the registered `promptobus send` command. A sender must prove the address it holds in the named task; an unbound participant record grants no send right.'),
  has(section(adr024, '## Decision'),
    'The earlier clone-root approver lift was restricted to Claude Code. That harness restriction no longer governs: acceptance is placed in a separate worktree. The current approver lift is available on Claude Code, Cursor and Codex after a reviewer result; see [the driver contract](../reference/05-drivers.md#approver-lift-after-a-reviewer-result).')
    && has(section(adr024, '## Consequences'),
      'parity now checks the exported runtime lists, both default maps and all six schema surfaces.'),
  has(section(adr017, '## Decision'),
    'The owner gate of `done`, `stop` and `dismiss` grants rights only on positive proof, with the ownerless-task exception stated above. The approver proof for `stop`, `dismiss` and `sweep` is described in [the CLI cleanup contract](../reference/03-cli.md#requiresweeper--who-may-sweep-a-piece).'),
  has(section(adr019, '## Consequences'),
    'A participant whose harness gives its MCP child no identity cannot send. The session-record pointer used by Cursor and Codex MCP children lets the normal lift prove its binding before a harness id appears.')
    && has(section(adr019, '## Consequences'),
      'The barrier that closed that attempt is this positive session binding, and the command is registered only on it.'),
];
const migrated = [
  'docs: Codex Stop is recorded for worker and reviewer turns only',
  'docs: Codex elicitation accepts only a home-configured tool-call approval',
  'docs: send requires a positive session binding',
  'docs: approver lift covers three harnesses in a separate worktree',
  'docs: sweep and the owner gate grant rights only by positive proof',
  'docs: an MCP child without identity cannot send',
];
migrated.forEach((name, i) => check(name, resolutions[i], name));

const index = read('docs/README.md');
const indexRows = new Map(index.split('\n').flatMap((line) => {
  const row = line.match(/^\| \[adr\/(adr-\d{3}-[a-z0-9-]+\.md)\]\(adr\/(adr-\d{3}-[a-z0-9-]+\.md)\) \| ([^|]+) \| ([^|]+) \|$/);
  return row ? [[row[1], { target: row[2], description: row[3], status: row[4] }]] : [];
}));
check('docs: the index names positive send binding and the three-harness approver worktree',
  indexRows.get('adr-019-session-address-per-task-lands.md')?.status === 'Accepted'
  && has(indexRows.get('adr-019-session-address-per-task-lands.md')?.description ?? '',
    'a positive binding gates the registered send command')
  && has(indexRows.get('adr-024-approver-acceptance-in-own-worktree.md')?.description ?? '',
    'accepts in its own worktree')
  && has(indexRows.get('adr-024-approver-acceptance-in-own-worktree.md')?.description ?? '',
    'Claude Code, Cursor and Codex'),
  JSON.stringify([...indexRows].filter(([name]) => /^adr-(019|024)-/.test(name))));

const protocol = read('docs/reference/04-protocol.md');
const shutdown = section(read('docs/reference/05-drivers.md'), '### Codex holder shutdown');
check('docs: Codex Stop distinguishes terminal accounting from interrupt ACK and original tool receipts',
  ['An interrupt ACK is not terminal proof', '`ok: false`', '`attempted: true`', '`stopped: false`',
    'outside the disposable participant `CODEX_HOME`', 'not fabricated original native tool receipts',
    'Null or synthetic negative exits remain unresolved', 'complete final command streams still requires']
    .every(claim => has(shutdown, claim)),
  'unknown exits and incomplete original streams cannot be documented as successful forced drain');
check('docs: native teamlead Stop retains the verified child proof before parent cleanup',
  ['parent, child and session locks, in that order', '`alias: {task, address}`',
    'Both references must be published', 'keeps that entry for a repeat Stop',
    'identical child proof before cleanup', 'parent alias owns no additional private home']
    .every(claim => has(shutdown, claim)),
  'the parent alias must keep its original child evidence, recovery record and lock order');
check('docs: native teamlead relift retains prior proof until the actual generation rebinds',
  ['validates the previous terminal proof', '`nativePendingLaunchId`',
    'actual new launch ID', 'without inheriting `nativeStop`',
    'accepts only the reserved old or intended new generation',
    'completed Stop of the new generation retains its proof', 'Previous receipt files remain unchanged']
    .every(claim => has(shutdown, claim)),
  'relift must fence unresolved dispatch and preserve proof across generation-aware recovery');
const wardenRuntime = compact(section(read('docs/guides/hooks-and-trust.md'),
  '## The warden state machine: what is here and what is not').split('\n### ')[0]);
check('docs: the package owns the warden runtime and the Host supplies launch inputs',
  has(wardenRuntime, 'The shared workspace service owns one package Worker for the task loops')
  && has(wardenRuntime, '`lib/warden.js` owns each loop; `lib/service-warden.js` retains its task entry until the loop\'s actual cleanup has finished.')
  && ['fs.watch', 'Host', 'nodePath()', 'busArgv', 'environment', 'callbacks stay in main',
    'Worker never executes the consumer entry point', 'Only stall formatting crosses back as a typed request']
    .every((term) => wardenRuntime.includes(term)),
  'the package Worker must retain task loops while the original main Host supplies startup and formatting');

const engineOptions = section(protocol, '## Engine');
check('docs: EngineOptions documents injected seams and the reader version',
  ['now?: Clock', '() => Date', 'faults?: FaultHook', 'recover?: boolean', 'cli?: string | null']
    .every((type) => has(engineOptions, type))
  && /\brecover\b[\s\S]{0,80}\btrue\b/.test(engineOptions)
  && /\bcli\b[\s\S]{0,100}reader\/Host version/.test(engineOptions)
  && /package version[\s\S]{0,60}independent/.test(engineOptions),
  'the injected clock, fault seam, open recovery and reader/Host version must remain distinct');

const historyContract = section(protocol, '### Messages: names, order and what a read marks');
check('docs: history exposes a typed page and an opaque cursor toward older records',
  ['task?', 'participant?', 'limit?', 'before?', 'all?', 'strict?', 'HistoryPage',
    'entries: HistoryEntry[]', 'cursor: string | null', 'broken: BrokenNote[]']
    .every((type) => has(historyContract, type))
  && /\bopaque\b[\s\S]{0,40}\bcursor\b[\s\S]{0,80}\bbefore\b[\s\S]{0,80}\bolder\b/.test(historyContract)
  && /\bnull\b[\s\S]{0,40}\bnothing older\b/.test(historyContract)
  && /\bold to new\b/.test(historyContract)
  && /all: true[\s\S]{0,60}\blimit\b/.test(historyContract)
  && /strict: true[\s\S]{0,80}\bunreadable\b[\s\S]{0,30}\bdirectories\b/.test(historyContract),
  'history must document its filters, response and unchanged cursor as before for the next older page');

const bbEvidence = section(protocol, '#### Manifest before reviewer launch');
const bbGuide = read('integrations/bb/README.md');
const evidenceRule = 'Evidence of a check is the command, its exit code and the gate count in the participant report and in';
const bespokeBan = 'Do not build a bespoke verification harness.';
const packetBan = 'wrapper scripts, receipt files, hash manifests or frozen review packets';
const closingRule = "A task's closing criteria must be checkable on the current machine.";
const childCard = 'moves to a child card, and the parent closes on the checkable part.';
const bbParticipants = [
  'promptobus-worker', 'promptobus-reviewer', 'promptobus-approver',
  'promptobus-orchestrator', 'promptobus-teamlead', 'promptobus-reporter',
];
const workerProtocol = section(read('skills/orchestrate/SKILL.md'), '## Worker protocol');
check('docs: a bespoke verification harness is refused in the orchestrate skill and every BB participant skill',
  [workerProtocol, readSource('lib/prompts/bb.js'), ...bbParticipants.map((name) => read(`integrations/bb/skills/${name}/SKILL.md`))]
    .every((text) => has(text, evidenceRule) && has(text, bespokeBan) && has(text, packetBan)
      && has(text, closingRule) && has(text, childCard))
  && has(workerProtocol, 'The orchestrator does not add wrapper scripts, receipt files, hash manifests or frozen review packets.')
  && has(workerProtocol, 'They are not a bespoke verification harness')
  && has(workerProtocol, 'commands/evidence-prepare.js')
  && has(protocol, 'A bespoke verification harness is not that evidence')
  && has(protocol, 'The orchestrator does not add wrapper scripts, receipt files, hash manifests or frozen review packets.')
  && has(protocol, 'The package\'s own BB evidence recipe stays.')
  && has(read('README.md'), 'a bespoke verification harness is not evidence')
  && has(read('integrations/bb/README.md'), bespokeBan)
  && has(read('lib/prompts/README.md'), 'bespoke verification harness')
  && has(read('CHANGELOG.md'), 'bespoke verification harness'),
  'the evidence rule or the ban on a bespoke harness left the orchestrate skill or a BB participant skill');
check('docs: BB evidence preparation follows terminal launcher capture before the first check',
  [bbEvidence, bbGuide, read('skills/orchestrate/SKILL.md')].every((text) =>
    has(text, 'before the first relevant mechanical check')
    && has(text, 'commands/record-command.js')
    && has(text, 'commands/command-runner.js')
    && has(text, 'commands/evidence-prepare.js'))
  && has(bbEvidence, 'An inner receipt with `complete: true` alone does not prove launcher finalization.')
  && [bbEvidence, bbGuide].every((text) => has(text, 'Run the outer recorder from the exact granted command cwd'))
  && has(bbEvidence, 'The constructor does not run commands or suites.'),
  'initial guidance must capture the checked launcher terminal outcome and assemble only finalized originals');
check('docs: compact BB review keeps selected history outside current gate counts',
  [bbEvidence, bbGuide].every((text) => has(text, 'support')
    && has(text, 'zero current gates')
    && has(text, 'required prior findings and failures')
    && has(text, 'unchanged suite'))
  && has(bbEvidence, 'The support selection is covered by the exact owner declaration hash.')
  && has(bbEvidence, 'This does not establish O(current) total I/O or a cache or savings claim.'),
  'required historical evidence must stay explicit, immutable and distinct from current execution proof');
check('docs: resource isolation permits ordinary suites and preserves explicit cooperative conflicts',
  has(section(read('skills/orchestrate/SKILL.md'), '## Machine lease'),
    'ordinary full suites and gates need no global machine lease')
  && has(section(read('docs/reference/01-overview.md'), '## Machine lease'),
    'Full suites and gates require no global lease by default.')
  && has(section(read('docs/reference/03-cli.md'), '## Lease'),
    'The lease coordinates cooperating callers; it is not command authorization or a host scheduler.')
  && has(section(adr('018', 'the-bus-leases-the-machine-for-measurements'), '## Decision'),
    'Current execution authority is revalidated after waiting; a launch-time snapshot is insufficient.'),
  'ordinary isolation, named cooperative conflicts and post-wait authority must agree across canonical guidance');
const fanout = section(protocol, '## Fan-out');
check('docs: task close fences new intents and preserves committed fan-out and adopted artifacts',
  has(fanout, 'Close and new message commit serialize under the same task lock.')
  && has(fanout, 'If close commits first, both send variants refuse with typed `task-closed` before reserving an ID or creating an intent.')
  && has(fanout, 'Published artifact metadata, blobs and adapter file links remain on that refusal because another committed message or intent may already reference them.')
  && has(fanout, 'A committed intent may finish fan-out and recover on a done task.'),
  'terminal publication must distinguish uncommitted sends, committed intents and public artifact ownership');
const upgrade = section(read('docs/reference/01-overview.md'), '### Upgrading a former store');
check('docs: former stores require the pinned upgrade while current malformed records keep their verdicts',
  has(upgrade, 'use the pinned `promptobus` GitHub release `v0.28.0`')
  && has(upgrade, 'including an explicitly named arbitrary home')
  && has(upgrade, 'It is not forensic detection of every damaged directory.')
  && has(upgrade, 'an explicit `schemaVersion` retains its existing validator verdict.')
  && has(upgrade, 'A completed `migrated.json` or preserved `migration-broken/` alone does not block a current store.'),
  'the upgrade route, recognition limit and current-record behavior must remain explicit');

const storeLayout = section(protocol, '## Store layout');
check('docs: publication holds the blob lock and piece sweep removes the worktree and the branch',
  has(storeLayout, '`.lock-blobs/` separately guards artifact payload publication and metadata.')
  && has(storeLayout, 'A piece sweep removes the worktree and the branch.')
  && !storeLayout.includes('sweep reachability')
  && !storeLayout.includes('the piece sweep both ask it')
  && !storeLayout.includes("the only later change to the set is the sweep's own removals"),
  'publication keeps the blob lock; piece sweep removes the worktree and the branch');

const retention = section(protocol, '### Artifacts: how a file becomes a message attachment');
check('docs: artifact retention leaves records on sweep and removes the journal from done',
  has(retention,
    "The same payload under two names yields two metadata records and one immutable blob. Retention is separate: `done` removes a whole closed task and its blobs once that task is older than the age threshold, while `sweep` leaves an accepted sender's artifact records, `files/` entries and blobs on the task journal. `blobNamed` still answers whether any metadata record or other hard link names a payload. See [the CLI cleanup contract](03-cli.md#sweep--clean-up-after-one-accepted-piece)."),
  'the artifact section changed a cleanup boundary or survival condition');

const claim = section(protocol, '## Claim').split('\n### ')[0];
check('docs: claim distinguishes enforced identity checks from owner liveness',
  has(claim,
    "`promptobus_mailbox` with `claim: true` rebinds a task's orchestrator mailbox to the calling session. The tool requires the orchestrator address, a session identity and a recorded owner; `claimOwnership` in `lib/store.js` then replaces that owner under the task lock. It does not check whether the previous owner is live. The caller must establish that the previous session has ended before takeover; this is a precondition on the caller, not an enforced liveness gate."),
  'claim must keep the identity gate and caller-side liveness precondition distinct');

const cli = read('docs/reference/03-cli.md');
const artifactPlan = section(cli, '### `artifactPlan` — the blobs and files of one piece');
const sweepArtifacts = section(cli, '### `sweepArtifacts` — the removals of one piece, under the publication lock');
check('docs: sweepArtifacts prints nothing and retention removes the journal directory',
  has(sweepArtifacts, '`sweep` does not call this. The function prints nothing: it returns counts.')
  && has(sweepArtifacts, 'Retention removes the whole journal directory once the task is past the age threshold.')
  && has(artifactPlan, 'An entry whose inode does not match is left in place.')
  && has(section(cli, '## Status, done, sweep, dismiss, history'),
    'The dry run names each task, its size and its artifact count, and its delete line is `done --task <id> --older-than <days> --yes`.')
  && !artifactPlan.includes('named out loud')
  && !artifactPlan.includes('surface as a line')
  && !sweepArtifacts.includes('names the two states it left in place')
  && !sweepArtifacts.includes("journal retention's reading")
  && !sweepArtifacts.includes('said out loud'),
  'sweepArtifacts must stay silent, artifactPlan must not announce a mismatch, and retention removes the journal directory');
const drivers = read('docs/reference/05-drivers.md');
const driverContract = compact(section(drivers, '### The driver contract'));
check('docs: the package ships native drivers behind a harness-neutral core contract',
  /\bpackage\b.{0,60}\b(?:ships|provides)\b.{0,60}\bdrivers\b/i.test(driverContract)
  && ['lib/drivers.js', 'src/driver.ts', 'harness-neutral', 'Host', 'resolveToolBin',
    'Host-specific overrides', '02-host.md#tool-binaries', '02-host.md#the-standalone-host', 'declared tool name']
    .every((term) => driverContract.includes(term)),
  'packaged native implementations and registry must stay distinct from core and Host binary lookup');
const spawn = section(cli, '## Spawn');
const codexPhrases = section(drivers, '### Codex: the phrases a participant is addressed by');
check('docs: Codex home inventory includes conditional hooks and auth',
  has(spawn,
    "The lift writes an `auth.json` snapshot at mode 0600 when present, with the subscription refresh token removed; a missing copy is reported and an environment API key can still authenticate. A linked worktree with a planned guard hook also receives `hooks.json` in this home, while an ordinary working directory keeps the hook in its own `.codex/`.")
  && has(codexPhrases,
    "The lift writes an `auth.json` snapshot at mode 0600 when it exists, with the subscription refresh token removed; a missing file is reported and an API key in the environment can still authenticate the participant.")
  && has(codexPhrases,
    "A linked worktree with a planned guard hooks file also gets `hooks.json` in the participant home at lift. Codex otherwise resolves the project's hooks file in the main checkout, which the lift does not trust. A directory that is not a linked worktree keeps its planned hook file in its own `.codex/`.")
  && has(decision(adr008, '1B', '2B'),
    "An `auth.json` snapshot is written at mode 0600 when present, with the subscription refresh token removed. A linked worktree with a planned guard hooks file also gets `hooks.json` in this home; other working directories keep that file in their own `.codex/`."),
  'a Codex home passage changed the linked-worktree or optional-auth boundary');

const sessionIdentity = section(read('docs/reference/02-host.md'), '## Session identity');
const afterLift = section(cli, '### The session id after a lift');
check('docs: a Claude Code lift binds the session\'s own id at its handshake through a session-record pointer',
  has(sessionIdentity, "**Claude Code's pointer proves a binding, not an identity.**")
  && has(sessionIdentity, 'The first proven handshake binds and nothing rebinds after it')
  && has(sessionIdentity, '**The order the pointer relies on was measured, not assumed.**')
  && has(afterLift, '**The post-launch persist keeps a handshake binding and checks it against the harness alone.**')
  && has(afterLift, '`claude --bg` 2.1.284 ignores that flag'),
  '02-host § Session identity or 03-cli § The session id after a lift lost the Claude Code session-record pointer');

const workerConfig = threadStartConfig({ role: 'worker', effort: 'high' });
const teamleadConfig = threadStartConfig({ role: 'teamlead' });
const holder = section(cli, '## The Codex holder');
const transports = section(drivers, '#### The two `mcp_servers` transports, and the field that kills the config load');
check('docs: Codex thread/start overrides match the holder and role boundary',
  Object.keys(workerConfig).sort().join(',') === 'bypass_hook_trust,model_reasoning_effort'
  && workerConfig.bypass_hook_trust === true
  && workerConfig.model_reasoning_effort === 'high'
  && Object.keys(teamleadConfig).sort().join(',') === 'bypass_hook_trust,features.hooks'
  && teamleadConfig.bypass_hook_trust === true
  && teamleadConfig['features.hooks'] === false
  && has(holder,
    '`ThreadStartParams.config` always carries `bypass_hook_trust = true`, the hook-trust override for app-server threads. It adds `model_reasoning_effort` when the lift names an effort; the first `turn/start` also carries that effort. A Codex install-root role (teamlead, reporter or orchestrator) also carries `features.hooks = false`, which disables project hook discovery even if project config enables it; admission itself comes from `TEAMLEAD_HARNESSES`, not from this branch ([Spawn](#spawn)).')
  && has(transports,
    '`ThreadStartParams.config` is built by `threadStartConfig`: it always sets `bypass_hook_trust = true` for app-server hook trust, adds `model_reasoning_effort` when the lift names an effort, and sets `features.hooks = false` on Codex install-root roles (teamlead, reporter and orchestrator). Admission itself comes from `TEAMLEAD_HARNESSES`, not from that branch ([03-cli § Spawn](03-cli.md#spawn)). The MCP set remains in the home, not in this request.')
  && has(decision(adr008, '2B', '3C'),
    '`ThreadStartParams.config` always carries `bypass_hook_trust`, optionally carries `model_reasoning_effort`, and a Codex install-root role (teamlead, reporter or orchestrator) adds `features.hooks = false`. Admission itself comes from `TEAMLEAD_HARNESSES`, not from that branch; the current overrides are listed in [the Codex holder](../reference/03-cli.md#the-codex-holder).'),
  JSON.stringify({ workerConfig, teamleadConfig }));

check('docs: the generate dry-run rule does not read as the trustedHooks rule',
  has(spawn, 'the run reads it from the **worktree**, which is what the participant will see, so the two can disagree and the worktree decides. The same file lists, in `trustedHooks`, the project hook commands a Codex or Cursor lift keeps beside its guard, and that field is read where the hooks file it judges is: the main checkout\'s working file for Codex, the worktree\'s index for Cursor'),
  'the Spawn section must state the generate dry-run rule before trustedHooks and say where trustedHooks is read');

const installGuide = read('docs/guides/install.md');
const orchestrateSkill = read('skills/orchestrate/SKILL.md');
const handoff = section(orchestrateSkill, '## Root thread handoff');
check('docs: root rotation checkpoints the run before a fresh conversation',
  has(handoff, "after the agreed batch of tasks or when the owner's context threshold is reached")
  && has(handoff, "Write a new handoff file in the root task's `files/`")
  && has(handoff, 'opens a new conversation with the handoff, not the old transcript'));
check('docs: no outgoing exit before a continuation route and participant owner are agreed',
  has(handoff, 'After checkpointing, agree with the owner on the continuation route and who remains responsible for the original task and its participants. Only then may the outgoing session exit')
  && has(handoff, 'Without that agreement, stay at the checkpoint without dispatching'));
check('docs: fresh root succession requires exact consent and cannot transfer a managed launch',
  has(handoff, 'explicit owner approval for the exact active root task and the full outgoing and incoming session IDs')
  && has(handoff, 'Verify the old session has ended')
  && has(handoff, '`lead --resume --task <id>` recovers the same native thread and history')
  && has(handoff, 'Mail, participants and Stop receipts stay on the original task'));
check('docs: ordinary claim checks resolved authority and host exit before transfer',
  has(handoff, 'one authorized claimant')
  && has(handoff, 'verify the workspace and store, recorded owner, incoming harness identity and effective mailbox for this call')
  && has(handoff, 'neither an idle turn nor a missing or refused wake proves exit')
  && has(handoff, 'Only where the installed dispatcher supports the registered-peer exception')
  && has(handoff, 'an explicitly declared `orchestrator` select the named root for claim from its own exact-session linked peer')
  && has(handoff, 'The exception applies only to explicit claim. Ordinary reads follow current bindings: while the session holds only the peer they select the peer; after a successful claim they may select the orchestrator'));
check('docs: an uncertain claim result requires reconciliation, not replay',
  has(handoff, 'changes ownership and binding and takes unread mail into history before replying')
  && has(handoff, 'Preserve returned headers and IDs')
  && has(handoff, 'On a lost or mismatched reply, do not retry or probe with an ordinary mailbox read: it could consume new root mail')
  && has(handoff, "Reconcile ownership and binding through authorized non-consuming inspection; compare saved IDs with the named task's `history`, which does not mark mail read"));
const wholeRunPause = section(orchestrateSkill, '## Planned whole-run pause');
const pauseAtLimit = section(wholeRunPause, "### Pause at the owner's limit threshold");
const continueAfterReset = section(wholeRunPause, '### Continue after the reset');
check('docs: a planned whole-run pause checkpoints each task before the limit reset',
  has(pauseAtLimit, 'The owner sets the threshold')
  && has(pauseAtLimit, 'is one input, not a trigger')
  && has(pauseAtLimit, 'Send `pause` as `status` mail with `promptobus_send`, one per teamlead')
  && has(pauseAtLimit, 'Before ending the turn, each participating address saves a state file in `files/` of its own task.')
  && has(pauseAtLimit, 'Set a one-shot timer for the reset')
  && has(pauseAtLimit, 'A checkpoint, an idle turn and a timer are not Stop or drain evidence.'));
check('docs: pause and continue correlate status without waking an orchestrator or requiring reporter mail',
  has(pauseAtLimit, 'Use `status` both ways for `pause` and `continue`. Do not use `question` or `answer` for this exchange: it must not create a new question or close an unrelated one.')
  && has(pauseAtLimit, 'Acknowledge with `status` citing the original message ID')
  && has(continueAfterReset, 'send `continue` as `status` and check for a `status` acknowledgment citing that `continue` message ID')
  && has(pauseAtLimit, 'Status-only mail does not wake the root or a teamlead\'s child `orchestrator` mailbox.')
  && has(pauseAtLimit, 'reads `promptobus_mailbox` in its own task and matches acknowledgments by sender and the outbound message ID.')
  && has(pauseAtLimit, 'leave that participant unconfirmed')
  && has(pauseAtLimit, 'The reporter cannot send mail: do not ask it to acknowledge either `pause` or `continue`.')
  && has(pauseAtLimit, 'The root records the reporter\'s observed status separately, with any unknowns, not as an acknowledgment.')
  && has(pauseAtLimit, 'A read-only reviewer sends its state as `status` for its coordinator to save in that task, without gaining write access.')
  && has(spawn, 'Pause and continue use `status` mail both ways with acknowledgments matched by message ID.'));
check('docs: continuation uses the same teamlead address and all three inputs without bypassing authority',
  has(continueAfterReset, 'promptobus spawn --teamlead --brief <continuation-file> --task <root> --slug <existing-slug>')
  && has(continueAfterReset, '- the original brief')
  && has(continueAfterReset, "- the previous teamlead's state file in that child's `files/`")
  && has(continueAfterReset, '- the unread mail for that teamlead in the linked root and child mailbox slots')
  && has(continueAfterReset, 'Codex relift still requires the previous retained terminal proof.')
  && has(continueAfterReset, 'public relift under that condition and real Claude reconnect behavior are unverified.')
  && has(continueAfterReset, 'A relift starts a new session, not the old conversation.')
  && has(continueAfterReset, 'The child health line is scoped to the accepted generation, not inherited from its predecessor.')
  && has(continueAfterReset, 'A startup health line does not prove binding, delivery or Stop.')
  && has(continueAfterReset, 'Synthetic reconnect checks exercise generation and identity fences; they do not establish a live Claude reconnect or public relift with an unreadable registry.')
  && has(spawn, 'Top-level `promptobus --help` lists this syntax')
  && has(read('README.md'), 'skills/orchestrate/SKILL.md#planned-whole-run-pause'));
check('docs: managed root self-Stop acknowledgement is pending until retained proof',
  has(orchestrateSkill, 'A managed Codex root stopping itself receives a pending acknowledgement:')
  && has(orchestrateSkill, 'check the retained Stop proof from another authorized session'));
check('docs: live-cap admission applies across strategies and explicit model choices',
  has(orchestrateSkill, 'live-cap admission enforces it for every strategy and explicit model choice'));
check('docs: Stop decision and driver contract distinguish pending self-Stop from confirmation',
  has(read('docs/adr/adr-012-stopping-one-participant-is-a-verb-of-its-own.md'), 'A managed orchestrator is eligible')
  && has(read('docs/adr/adr-012-stopping-one-participant-is-a-verb-of-its-own.md'), 'own Stop receives a pending acknowledgement')
  && has(read('docs/reference/05-drivers.md'), '`Driver.stopSelf(ref)` is optional:'));
check('docs: every description of the lift order runs the generator after the dependency install',
  has(spawn, 'It runs **after the dependency install**, so a generator may run a tool the repository pins in its own lock')
  && has(installGuide, '`spawn` runs it in the fresh worktree after the checkout and after `npm ci`')
  && has(orchestrateSkill, 'dependency installation runs first and the repository generator after it')
  && has(drivers, 'Dependencies are installed from package-lock.json, then a declared repository generator runs')
  && has(adr024, 'A fresh approver worktree runs its dependency install and then the repository\'s declared generator before launch files.')
  && ![spawn, installGuide, orchestrateSkill, drivers, adr024].some((text) => /generator runs before dependency|runs \*\*before\*\* dependencies|before dependencies are installed|declared generator and dependency install/
    .test(compact(text))),
  'the Spawn section, the install guide, the orchestrate skill, the driver contract and ADR-024 must agree on the order');

check('docs: the generator\'s outcome names a refused install, a tracked change and the lock it does not produce',
  has(spawn, 'A refused install does not skip the generator, and the same upward resolution can then hand it the enclosing copy and a success; so can a repository without a lock, where nothing is installed. When the install refused, or the worktree has no `node_modules` when the generator starts, the preamble says which of the two it observed')
  && has(spawn, 'A generator that fails after a refused install tells the participant to get `npm ci` working first.')
  && has(spawn, 'The note depends on the worktree, not on the generator: one that uses no dependencies, such as `npx --yes <remote tool>`, still gets it when the worktree has no `node_modules`.')
  && has(spawn, 'When git does not answer, what the generator left is reported as not checked rather than as clean.')
  && has(spawn, '`generate` is not a manifest producer, and a `package.json` or `package-lock.json` it writes gets no install.')
  && has(spawn, 'A tracked file the generator changed is reported apart: `.gitignore` cannot cure it')
  && !has(read('CHANGELOG.md'), 'a generator that needs the dependencies fails as well, and the lift prints both warnings'),
  'the Spawn section must state what a refused install, a tracked change and a written lock mean for the generator');

const generatorArgv = (() => {
  try {
    const declared = JSON.parse(read('promptobus.json')).generate;
    return Array.isArray(declared) && declared.length ? declared.join(' ') : null;
  } catch {
    return null;
  }
})();
const agentsDoc = read('AGENTS.md');
const contributingDoc = read('docs/guides/contributing.md');
const approverRecovery = section(cli, '### Approver harness recovery');
check('docs: changing harness requires a fresh owned approver subject, not changing the old participant',
  has(approverRecovery, 'An existing approver keeps its original harness even after it stops.')
  && has(approverRecovery, 'refused before native launch; that refusal is not evidence of a model or native outage.')
  && has(approverRecovery, 'Repeat-reviewer rebind rules do not apply to approvers.')
  && has(approverRecovery, 'explicit owner authorization for a fresh owned subject for the same card, fresh results for that subject, and the intended harness selected on its first approver lift.')
  && has(approverRecovery, 'The exact end-to-end recovery sequence is not verified here.')
  && has(approverRecovery, 'Do not edit, claim or relift the old approver on a different harness.')
  && has(approverRecovery, 'Evidence from the fresh subject cannot serve as Stop proof for the old generation.'),
  approverRecovery);
check('docs: manual worktrees restore root readiness before adapter lint; BB still needs its own install',
  has(agentsDoc, 'In a checkout you made yourself, run `npm ci` and then `init`')
  && has(contributingDoc, 'Before running BB integration checks in either a lifted or manually created worktree, run `npm --prefix integrations/bb ci --no-audit --no-fund`')
  && has(read('integrations/bb/README.md'), 'A lifted Promptobus worktree installs root dependencies, not this separately locked package.'),
  'manual root setup and separately locked integration setup serve different purposes');
check('docs: this checkout restores its generated adapters with the command its promptobus.json declares',
  generatorArgv !== null
  && has(agentsDoc, `are written by \`${generatorArgv}\` and are not tracked`)
  && has(contributingDoc, `Restore them with \`npm ci\` and then \`${generatorArgv}\``)
  && has(contributingDoc, 'leaves both unchanged only while the installed backslop is the pin in `package.json` and `backslop.json` that wrote the committed block')
  && has(agentsDoc, '`git status` does not change from it while the installed backslop is the pin')
  && !has(contributingDoc, 'and leaves tracked files unchanged.')
  && has(contributingDoc, 'At another pin it rewrites them ([measured size of that rewrite](#init-rewrite-at-another-pin)).'),
  generatorArgv === null
    ? 'promptobus.json declares no generate argv here: the file is absent, unreadable or has no non-empty "generate" array'
    : `promptobus.json generate: ${generatorArgv}`);

const addresses = section(protocol, '## Addresses');
const teamleadSkill = section(read('skills/orchestrate/SKILL.md'), '## Teamleads and siblings');
check('docs: stopped Codex teamlead recovery closes the claimed child before the root and keeps Stop proof',
  [spawn, teamleadSkill].every(text => has(text, 'The closed child and the teamlead\'s matching retained Stop proof permit root close after the claim.')
    && has(text, 'promptobus_mailbox { claim: true, task: <child> }')
    && has(text, 'done --task <child>') && has(text, 'done --task <root>')
    && has(text, 'Claiming a live mailbox does not prove Stop.'))
  && has(read('README.md'), 'root `done` accepts the matching retained Stop proof.'),
  'Spawn, orchestrate or README omits claim-then-close or treats a mailbox claim as terminal evidence');
check('docs: a teamlead has one mailbox over its child and root slots, and no drain is documented',
  has(addresses, '**A participant has one mailbox, and its addresses in tasks are address aliases of it**')
  && has(addresses, '| `orchestrator` of a root task | `teamlead:<slug>` | all seven | lands in the root slot `teamlead-<slug>`, part of the teamlead\'s one mailbox |')
  && has(addresses, '| `orchestrator` of a child task | `root:<root slug>` of that task | all seven | delivery enters the root\'s `orchestrator` mailbox as the bound `teamlead:<slug>` |')
  && has(spawn, 'The teamlead has one mailbox: the slot of its child task\'s `orchestrator` and the slot of `teamlead:<slug>` in the root')
  && !has(spawn, 're-delivers before it marks read')
  && has(teamleadSkill, 'A teamlead has one mailbox: its child task\'s `orchestrator` slot and its root `teamlead:<slug>` slot, read as one.')
  && JSON.parse(read('schemas/v1/message.schema.json')).properties.originTask.description
    .includes('the root whose orchestrator\'s mail was delivered into this child task')
  && has(adr('028', 'participant-mailbox'), '1A, 2C, 3A, 4A, 5B, 6A, 7B and 8A, approved by the owner on 2026-10-04.')
  && has(adr('026', 'teamlead-one-mailbox'), '1A and 2B, decided by the owner on 2026-10-03.'),
  'the protocol, the CLI reference, the orchestrate skill, ADR-026 or ADR-028 lost the participant mailbox route');
check('docs: the Codex teamlead\'s two entries read one mailbox, and ADR-028 states the gate and handover order the code has',
  has(drivers, 'Root and sibling mail to `teamlead:<slug>` land in the root slot, both MCP entries read the one participant mailbox, and the root entry still sends as `teamlead:<slug>`')
  && !has(drivers, 'Root mail reaches the child entry\'s mailbox')
  && has(adr('028', 'participant-mailbox'), 'a call that resolves to an address alias is gated at its primary address')
  && has(adr('028', 'participant-mailbox'), '`registerWake` checks the binding of the record the handover names, then resolves the address alias and writes at the primary'),
  '05-drivers or ADR-028 describes the teamlead mailbox, its owner gate or its handover otherwise than the code');
check('docs: 01-overview § join says an address alias is judged at its primary, by join and by the Stop guard',
  has(section(read('docs/reference/01-overview.md'), '### `join` — entering a task: hand over the contact point and lift a listener'),
    'An address alias is judged at its primary address, by `join` and by the Stop guard alike: a session that does not own the child\'s `orchestrator`, or names none, hands over nothing and marks no turn.'),
  '01-overview § join does not state that an address alias hands over only through its primary\'s owner gate');
check('docs: done refuses live native Codex work, the managed owner and a Codex reporter included',
  has(cli, '`done --task <id>` refuses while the managed owner or another native Codex participant lacks confirmed Stop, `--keep-sessions` included.')
  && !has(cli, 'stops the managed owner alongside other managed participants')
  && has(cli, 'A Codex reporter needs confirmed Stop before that `done`, as every native Codex participant does.')
  && !has(cli, 'stops the reporter with the other managed sessions'),
  '03-cli says done stops a native Codex owner or reporter, but done refuses until each has confirmed Stop');
check('docs: Codex Stop sends no signal fallback, and managed-root resume is guarded by process liveness',
  has(cli, 'that `stop` asks the holder to shut down within one deadline, retires the record only after terminal command accounting and sends no signal fallback')
  && !has(cli, 'sends `SIGKILL` to the process GROUP of the holder pid')
  && has(cli, 'A retained managed root whose holder and app-server have both exited can use `lead --resume`;')
  && !has(cli, 'confirm Stop before `lead --resume`')
  && has(drivers, 'with the same native identity once its holder and app-server have both exited.')
  && !has(drivers, 'with the same native identity after confirmed Stop.'),
  '03-cli or 05-drivers ties managed-root resume to a confirmed Stop, which retires the record resume needs, or keeps the old SIGKILL stop');
const readme = read('README.md');
check('docs: the README resumes a managed root after its processes exit and names the native observer package',
  has(readme, 'A retained managed root whose holder and app-server have both exited uses `lead --resume` to start a new app-server only when its current-version native binding and captured process births are retained.')
  && has(readme, 'Legacy birthless records refuse without migration or state deletion.')
  && !has(readme, 'uses `lead --resume` after confirmed Stop')
  && has(readme, 'A second optional package, `integrations/bb-native-observer/`, is a read-only BB dashboard for native Promptobus tasks.'),
  'the README ties managed-root resume to a confirmed Stop or omits the native observer package');
const soloReviewSkill = read('skills/solo-review/SKILL.md');
check('skills: one wording rule for messages to the person, and the asks link to it',
  (orchestrateSkill.match(/^## Messages to the person$/gm) || []).length === 1
  && has(section(orchestrateSkill, '## Messages to the person'),
    'A message to the person — your question, your status report, or the reporter\'s answer — is read with the queue, the run and your context closed.')
  && has(section(orchestrateSkill, '## Messages to the person'),
    'it says what is asked, why, and what each answer changes')
  && has(section(orchestrateSkill, '## Messages to the person'),
    'Use no term or abbreviation you introduced yourself')
  && has(section(orchestrateSkill, '## Messages to the person'),
    'never reach the person without a plain description of the work')
  && has(section(orchestrateSkill, '## Messages to the person'),
    'A definition new to the person is used only after they confirm it.')
  && has(section(orchestrateSkill, '## Messages to the person'),
    'Name a task by its number and its title, never by the number alone: the title goes with the first mention in a message, in every heading and in every table row; later mentions in the same paragraph may use the number alone.')
  && has(orchestrateSkill, 'Word that question as [Messages to the person](#messages-to-the-person) says.')
  && has(section(orchestrateSkill, '## Choosing a flat task or a tree'),
    'Word each ask as [Messages to the person](#messages-to-the-person) says.')
  && has(section(orchestrateSkill, '### The strategy envelope'),
    'Word that agreement as [Messages to the person](#messages-to-the-person) says.')
  && has(section(orchestrateSkill, '### The strategy envelope'),
    'Ask, in the words [Messages to the person](#messages-to-the-person) gives;')
  && has(section(orchestrateSkill, '## Reporter for the person'),
    'Word that answer as [Messages to the person](#messages-to-the-person) says.')
  && !has(section(orchestrateSkill, '## Choosing a flat task or a tree'), 'what each answer changes')
  && !has(section(orchestrateSkill, '### The strategy envelope'), 'what each answer changes')
  && !has(section(orchestrateSkill, '## Reporter for the person'), 'what each answer changes')
  && has(section(read('docs/reference/03-cli.md'), '## Spawn'),
    'The same skill words every message to the person once, in [Messages to the person](../../skills/orchestrate/SKILL.md#messages-to-the-person).')
  && has(read('README.md'), 'one wording rule for a message to the person')
  && has(section(section(read('CHANGELOG.md'), '## [0.31.0] — 2026-10-29'), '### Changed'),
    'The orchestration skill words every message to the person once.'),
  'the skill must state the wording rule once, and the split, shape, envelope and reporter must link to it');
check('skills: shipped guidance requires confirmed native Stop before done and a fresh lift after changed owner access',
  has(orchestrateSkill, '`done` refuses while the managed root or another native Codex participant lacks confirmed Stop.')
  && has(orchestrateSkill, 'Before each model input, the holder refuses changed owner access and requires a fresh lift; restoring the old file does not clear the refusal.')
  && !has(orchestrateSkill, 'the holder reloads fresh access from the original owner account')
  && has(orchestrateSkill, 'first refusing while any native Codex participant lacks confirmed Stop (`--keep-sessions` included)')
  && has(orchestrateSkill, 'An unresolved Codex Stop keeps the record and private home.')
  && has(soloReviewSkill, 'For a Codex reviewer the order is required: `done` refuses while a native Codex participant lacks confirmed Stop.')
  && !has(soloReviewSkill, 'The two halves are independent'),
  'a shipped skill still says done stops native Codex sessions or that the holder reloads changed owner access in place');
const releaseChanged = section(section(read('CHANGELOG.md'), '## [0.30.0] — 2026-10-27'), '### Changed');
check('docs: the 0.30.0 CHANGELOG lists the done and owner-access behaviour changes under Changed',
  has(releaseChanged, '`done` no longer stops native Codex participants. Stop each one with `promptobus stop <address>` first')
  && has(releaseChanged, 'Refuse changed Codex owner access before another model input and require a fresh lift.'),
  'the 0.30.0 CHANGELOG hides a behaviour change an upgrading reader must act on');
const suiteIsolation = section(contributingDoc, '## Suite isolation');
const documentedPath = compact(suiteIsolation).match(/`REACHABLE_BINARIES`[^:]*: ((?:`[^`]+`, )*`[^`]+`)\./)?.[1];
const expectedPath = REACHABLE_BINARIES.map(name => `\`${name}\``).join(', ');
check('docs: sealed PATH lists the REACHABLE_BINARIES inventory',
  documentedPath === expectedPath, `documented: ${documentedPath ?? 'missing list'}; inventory: ${expectedPath}`);
check('docs: a fetch-then-send pause waits for the delivery mark, and a hold stays a sleep',
  has(suiteIsolation, 'only on the pause that sits between that fetch and the send')
  && has(suiteIsolation, 'A scripted pause that must hold the turn, `{ wait: ms }`, stays a sleep for the whole interval')
  && has(suiteIsolation, 'A fixed sleep of one warden tick between the fetch and the send was late when the machine was loaded')
  && has(suiteIsolation, 'A lifecycle file that reads the task journal or a thread file another process writes retries a torn or missing read.')
  && has(read('docs/guides/hooks-and-trust.md'), 'The fetch-then-send pause in the scripted end-to-end turn polls the health file until `deliveredAt` is newer than it was at the fetch, then sends.')
  && has(read('docs/guides/hooks-and-trust.md'), 'A pause that holds the turn stays a sleep for its whole interval.')
  && has(read('README.md'), 'The pause between a mailbox fetch and the following send waits for the warden\'s `deliveredAt` mark instead of sleeping a fixed interval.')
  && has(read('README.md'), 'A pause that holds the turn stays a sleep.')
  && has(section(read('CHANGELOG.md'), '## [0.31.0] — 2026-10-29'), 'The pause between a mailbox fetch and the following send waits for the warden\'s delivery mark instead of sleeping one tick'),
  'suite isolation still tells every scripted pause to poll, or drops the hold that stays a sleep');
check('docs: a probe that parses a file another process writes reads it through readCompleteJson',
  has(suiteIsolation, 'must not let a half-written file throw out of the wait: `readCompleteJson` in `test/harness.mjs` reads a missing or unfinished file as `null` so the wait retries, while a bare `JSON.parse` in the probe aborts the whole suite file')
  && has(section(read('CHANGELOG.md'), '## [0.32.5] — 2026-11-09'), 'Live suites no longer abort when they read a half-written marker file under'),
  'suite isolation no longer names readCompleteJson for the torn read of a file another process writes');
check('docs: a fixture that starts a copy of the Node executable copies it with copyNodeExecutable',
  has(suiteIsolation, 'A fixture that starts a copy of the Node executable copies it with `copyNodeExecutable`')
  && has(suiteIsolation, 'puts a symlink beside the copy to each one it finds in the executable\'s own rpath directories')
  && has(section(read('CHANGELOG.md'), '## [0.32.5] — 2026-11-09'), 'linked against a shared libnode, such as Homebrew'),
  'suite isolation no longer says how a copied Node executable gets its shared library');
check('docs: a stand that kills its participants waits for them to die by the clock',
  has(suiteIsolation, 'sends SIGTERM to every participant and then waits for all of them to exit, up to `timeoutMs` in total, ten seconds by default')
  && has(section(read('CHANGELOG.md'), '## [0.32.5] — 2026-11-09'), 'The stub stand waits for killed participants to exit for up to ten seconds'),
  'suite isolation no longer says how long stopAll waits for a killed participant');
check('docs: a window fixed in milliseconds is stretched by the load of the machine',
  has(suiteIsolation, '`loadScale()` in [test/sandbox.mjs](../../test/sandbox.mjs) starts a child that burns 40 ms of CPU time and reports how long that took on the clock')
  && has(section(read('CHANGELOG.md'), '## [0.32.5] — 2026-11-09'), 'stretch their fixed deadlines and waits by the measured load of the machine'),
  'suite isolation no longer says how fixed windows are stretched on a loaded machine');
const observerReadme = read(`${observerRoot}/README.md`);
check('docs: the observer board has a Done column only for an inferred pipeline',
  has(observerReadme, 'Only a run without a recorded pipeline, where the order is inferred, has a **Done** column')
  && has(observerReadme, 'go under **Next step unconfirmed**, not Done.')
  && !has(observerReadme, 'A piece every step has reported on is in **Done**.')
  && has(read(`${observerRoot}/dashboard.ts`), "label: run.startSteps ? 'Next step unconfirmed' : 'Done'"),
  'the observer README presents Done as universal, or the dashboard no longer limits Done to an inferred pipeline');

check('docs: models probes by default in the orchestrate skill, abandon refuses a BB task, and the sweep ADR keeps artifacts',
  has(orchestrateSkill, '[--refresh | --no-probe] [--json]')
  && has(orchestrateSkill, 'It probes the harnesses by default and updates the availability cache; `--no-probe` reads the cached readings only.')
  && !has(orchestrateSkill, 'It reads the availability cache; `--refresh` probes the harnesses instead.')
  && has(read('docs/reference/03-cli.md'), 'A task on the BB lifecycle is refused.')
  && has(read('docs/reference/03-cli.md'), '`--yes` applies the preview and is refused without `--older-than`.')
  && has(adr('017', 'the-owner-gate-is-a-positive-proof'), 'the artifact records, files and blobs of that piece stay with the journal.')
  && !has(adr('017', 'the-owner-gate-is-a-positive-proof'), 'the blobs and files of that piece, and the temporary stands may go'),
  'a shipped skill or a reference still says models reads only the cache, or abandon, done --yes and sweep contracts are undocumented');

check('docs: automatic native reporter selection applies the shipped reviewer roles',
  [cli, drivers].every(text => has(text, 'The shipped catalog admits Claude and Codex reporters.'))
  && !has(cli, 'an overlay can make an OpenCode tuple eligible'));

check('docs: the optional Host version gates real managed Claude admission',
  has(toolBinDocs, 'If the Host supplies no version, the lift asks `readToolVersion`.')
  && has(toolBinDocs, 'Admission requires a parseable Claude version of at least 2.1.295')
  && has(toolBinDocs, 'Dry runs do not probe the binary.')
  && !has(toolBinDocs, 'the rest are read to talk to a person'));

const soloReview = read('skills/solo-review/SKILL.md');
check('docs: solo review explains routing, recorded branch points and orphan pickup',
  has(soloReview, 'This skill recommends `--strategy quality`.')
  && has(soloReview, 'An explicit `--base <sha|ref>` takes precedence')
  && has(soloReview, 'the worker branch has already merged, the default branch has rewound, or the merge base is unavailable')
  && has(soloReview, 'printed `diff base:`')
  && has(orchestrateSkill, 'a repeated `review <path>` without `--task` skips'));

const bbRange = JSON.parse(read('integrations/bb/package.json')).engines.bb;
check('docs: BB setup and provider selection use the manifest host range',
  ['## Setup', '## Provider and model selection'].every(heading => section(bbGuide, heading).includes(bbRange)));
