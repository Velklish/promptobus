import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

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

const adr007 = adr('007', 'codex-participant-isolated-home');
const adr008 = adr('008', 'codex-reviewer-working-directory');
const adr011 = adr('011', 'a-session-address-is-per-task');
const adr013 = adr('013', 'approver-is-a-fourth-addressed-participant');
const adr016 = adr('016', 'cleaning-up-after-one-accepted-piece-is-a-verb-of-its-own');
const adr019 = adr('019', 'session-address-per-task-lands');
const resolutions = [
  has(section(adr007, '## Current resolution'),
    'worker and reviewer turns recorded Stop; see [hooks and trust](../guides/hooks-and-trust.md#a-participants-hooks-are-not-the-workspaces) and [the Codex driver](../reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver). The approver evidence in [ADR-024](adr-024-approver-acceptance-in-own-worktree.md) records SessionStart. It does not establish that an approver Stop hook ran.'),
  has(section(adr008, '## Current resolution'),
    "The holder now accepts Codex's `mcpServer/elicitation/request` only for a tool-call approval from a server configured in the participant home; other elicitations remain declined. A later live reviewer sent a bus `result` after those approvals."),
  has(section(adr011, '## Current resolution'),
    'The positive session binding in [ADR-019](adr-019-session-address-per-task-lands.md) now gates the registered `promptobus send` command. A sender must prove the address it holds in the named task; an unbound participant record grants no send right.'),
  has(section(adr013, '## Current resolution'),
    'The earlier clone-root approver lift was restricted to Claude Code under [ADR-015](adr-015-approver-lift-is-a-flag-on-review.md). [ADR-024](adr-024-approver-acceptance-in-own-worktree.md) supersedes that harness restriction and places acceptance in a separate worktree. The current approver lift is available on Claude Code, Cursor and Codex after a reviewer result; see [the driver contract](../reference/05-drivers.md#approver-lift-after-a-reviewer-result).')
    && has(section(adr013, '## Consequences'),
      'records the separate consolidation. In exchange, parity now checks the exported runtime lists, both default maps and all six schema surfaces.'),
  has(section(adr016, '## Current resolution'),
    'The owner gate of `done`, `stop` and `dismiss` grants rights only on positive proof, with the ownerless-task exception stated in [ADR-017](adr-017-the-owner-gate-is-a-positive-proof.md). The approver proof for `stop`, `dismiss` and `sweep` is described in [the CLI cleanup contract](../reference/03-cli.md#requiresweeper--who-may-sweep-a-piece).'),
  has(section(adr019, '## Consequences'),
    'A participant whose harness gives its MCP child no identity cannot send. [ADR-014](adr-014-mcp-session-proof.md) supplies the session-record pointer used by Cursor and Codex MCP children, so the normal lift can prove its binding before a harness id appears.')
    && has(section(adr019, '## Consequences'),
      '[ADR-011](adr-011-a-session-address-is-per-task.md) has the amendment naming the barrier that closed its first attempt.'),
];
check('docs: accepted ADRs identify current capability and ownership rules',
  resolutions.every(Boolean), resolutions.map((ok, i) => `${['007', '008', '011', '013', '016', '019'][i]}:${ok}`).join(' '));

const index = read('docs/README.md');
const listed = readdirSync(path.join(root, 'docs/adr')).filter((name) => /^adr-\d{3}-[a-z0-9-]+\.md$/.test(name));
const indexRows = new Map(index.split('\n').flatMap((line) => {
  const row = line.match(/^\| \[adr\/(adr-\d{3}-[a-z0-9-]+\.md)\]\(adr\/(adr-\d{3}-[a-z0-9-]+\.md)\) \| ([^|]+) \| ([^|]+) \|$/);
  return row ? [[row[1], { target: row[2], description: row[3], status: row[4] }]] : [];
}));
check('docs: the index covers every ADR and names the implemented send door',
  indexRows.size === listed.length
  && listed.every((name) => indexRows.get(name)?.target === name)
  && indexRows.get('adr-011-a-session-address-is-per-task.md')?.status === 'Accepted'
  && has(indexRows.get('adr-011-a-session-address-is-per-task.md')?.description ?? '',
    'ADR-019 records the positive binding that now gates the registered send command')
  && has(indexRows.get('adr-013-approver-is-a-fourth-addressed-participant.md')?.description ?? '',
    'ADR-024 updates its harness and worktree boundary'),
  listed.filter((name) => indexRows.get(name)?.target !== name).join(', '));
