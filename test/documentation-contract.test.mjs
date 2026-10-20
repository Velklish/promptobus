import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { threadStartConfig } from '../lib/codex-session.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => process.env.PROMPTOBUS_DOCS_REV
  ? execFileSync('git', ['show', `${process.env.PROMPTOBUS_DOCS_REV}:${file}`], { cwd: root, encoding: 'utf8' })
  : readFileSync(path.join(root, file), 'utf8');
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
const wardenRuntime = compact(section(read('docs/guides/hooks-and-trust.md'),
  '## The warden state machine: what is here and what is not').split('\n### ')[0]);
check('docs: the package owns the warden runtime and the Host supplies launch inputs',
  /\bpackage\b.{0,60}\b(?:owns|implements)\b.{0,60}`lib\/warden\.js`/i.test(wardenRuntime)
  && ['detached', 'fs.watch', 'loop', 'Host', 'nodePath()', 'busArgv', 'environment']
    .every((term) => wardenRuntime.includes(term)),
  'the warden process must belong to lib/warden.js with explicit Host launch inputs');

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

const retention = section(protocol, '### Artifacts: how a file becomes a message attachment');
check('docs: artifact retention covers active sweep and whole-task prune',
  has(retention,
    "The same payload under two names yields two metadata records and one immutable blob. Retention is separate: `prune` removes a whole task and its blobs, while `sweep` may remove an accepted sender's artifact records and file entries during an active task. Under the publication lock, `blobNamed` keeps the blob if any surviving metadata record or another hard link still names it; otherwise the sweep removes it. See [the CLI cleanup contract](03-cli.md#sweepartifacts--the-removals-of-one-piece-under-the-publication-lock)."),
  'the artifact section changed a cleanup boundary or survival condition');

const claim = section(protocol, '## Claim').split('\n### ')[0];
check('docs: claim distinguishes enforced identity checks from owner liveness',
  has(claim,
    "`promptobus_mailbox` with `claim: true` rebinds a task's orchestrator mailbox to the calling session. The tool requires the orchestrator address, a session identity and a recorded owner; `claimOwnership` in `lib/store.js` then replaces that owner under the task lock. It does not check whether the previous owner is live. The caller must establish that the previous session has ended before takeover; this is a precondition on the caller, not an enforced liveness gate."),
  'claim must keep the identity gate and caller-side liveness precondition distinct');

const cli = read('docs/reference/03-cli.md');
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
