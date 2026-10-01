import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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
check('docs: accepted ADRs identify current capability and ownership rules',
  resolutions.every(Boolean), resolutions.map((ok, i) => `${migrated[i]}:${ok}`).join(' '));
migrated.forEach((name, i) => check(name, resolutions[i], name));

const index = read('docs/README.md');
const listed = readdirSync(path.join(root, 'docs/adr')).filter((name) => /^adr-\d{3}-[a-z0-9-]+\.md$/.test(name));
const indexRows = new Map(index.split('\n').flatMap((line) => {
  const row = line.match(/^\| \[adr\/(adr-\d{3}-[a-z0-9-]+\.md)\]\(adr\/(adr-\d{3}-[a-z0-9-]+\.md)\) \| ([^|]+) \| ([^|]+) \|$/);
  return row ? [[row[1], { target: row[2], description: row[3], status: row[4] }]] : [];
}));
check('docs: the index covers every ADR and names the implemented send door',
  indexRows.size === listed.length
  && listed.every((name) => indexRows.get(name)?.target === name)
  && indexRows.get('adr-019-session-address-per-task-lands.md')?.status === 'Accepted'
  && has(indexRows.get('adr-019-session-address-per-task-lands.md')?.description ?? '',
    'a positive binding gates the registered send command')
  && has(indexRows.get('adr-024-approver-acceptance-in-own-worktree.md')?.description ?? '',
    'accepts in its own worktree')
  && has(indexRows.get('adr-024-approver-acceptance-in-own-worktree.md')?.description ?? '',
    'Claude Code, Cursor and Codex'),
  listed.filter((name) => indexRows.get(name)?.target !== name).join(', '));

const manifest = read('test/fixtures/promptobus/MANIFEST.md');
const protocol = read('docs/reference/04-protocol.md');
const provenance = section(manifest, '## Provenance');
const frozen = section(manifest, '## Why the snapshot is frozen');
const legacyStore = section(protocol, '### The v1 store: what is written and in what order');
check('docs: frozen legacy fixture provenance names both consumers and missing source',
  has(manifest.split('\n## Provenance')[0],
    'This frozen `v0.61.0` snapshot is the input to both the [legacy reader test](../../promptobus-legacy-fixture.test.mjs) and the [migration test](../../promptobus-migration.test.mjs). The tests read a copy of the snapshot; they do not regenerate it.')
  && has(provenance,
    'The original generator and the recorded baseline revision are not preserved in this complete public repository. There is no working Git recovery command for either one here. The snapshot itself and its current consumers are the reproducible sources: run the linked tests to check how the legacy reader and migration handle these bytes.')
  && has(frozen, 'The 17 tracked fixture files therefore remain byte-for-byte frozen.')
  && has(legacyStore,
    'The frozen [legacy store snapshot](../../test/fixtures/promptobus/MANIFEST.md) is current input to both the [legacy reader test](../../test/promptobus-legacy-fixture.test.mjs) and the [migration test](../../test/promptobus-migration.test.mjs). Its original generator and recorded baseline revision are absent from the public repository; the manifest describes the available provenance and how to maintain this compatibility input without recapturing it.')
  && !/\bgit\s+show\s+(?:e2ea30a|8ca22be)\b/.test(provenance),
  'the provenance or one of its current consumer relationships changed');

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
