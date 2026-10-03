// The tracker records a lift accepts in a project hooks file, and everything it does not
// ([ADR-025](../docs/adr/adr-025-foreign-project-hook-records.md)). Run: npm test
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { acceptedHookCommands, judgeHookRecords } = await import(path.join(here, '..', 'lib', 'project-hooks.js'));

const SB = makeSandbox('promptobus-project-hooks-');
const CLI = 'npx --no-install backslop';
const project = path.join(SB, 'project');
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, 'backslop.json'), `${JSON.stringify({ prefix: 'X', cli: `  ${CLI} ` })}\n`);
const bare = path.join(SB, 'bare');
mkdirSync(bare, { recursive: true });

const codexRecord = (event) => ({ hooks: [{ type: 'command', command: `${CLI} hook ${event} --harness codex` }] });
const codexFile = (hooks) => JSON.stringify({ hooks });
const judged = (hooks, root = project) => judgeHookRecords(codexFile(hooks), root, 'codex');

const both = judged({ SessionStart: [codexRecord('session-start')], Stop: [codexRecord('stop')] });
check(': Codex — both tracker records with the project cli are accepted, nothing refused',
  both.refused.length === 0 && both.accepted.length === 2
  && both.accepted.some((r) => r.key === 'Stop' && r.command === `${CLI} hook stop --harness codex`),
  JSON.stringify(both));

check(': the accepted commands are read from backslop.json beside the file, trimmed',
  acceptedHookCommands(project, 'cursor').get('stop') === `${CLI} hook stop --harness cursor`
  && acceptedHookCommands(project, 'codex').get('SessionStart') === `${CLI} hook session-start --harness codex`
  && acceptedHookCommands(bare, 'codex').size === 0,
  JSON.stringify([...acceptedHookCommands(project, 'cursor')]));

const foreign = judged({
  Stop: [codexRecord('stop'), { hooks: [{ type: 'command', command: 'echo foreign' }] }],
  PreToolUse: [{ hooks: [{ type: 'command', command: `${CLI} hook stop --harness codex` }] }],
});
check(': Codex — a foreign command and a tracker command under an event it does not own are refused by their text',
  foreign.accepted.length === 1
  && foreign.refused.length === 2
  && foreign.refused.some((r) => r.startsWith('Stop: ') && r.includes('echo foreign'))
  && foreign.refused.some((r) => r.startsWith('PreToolUse: ')),
  JSON.stringify(foreign));

const shaped = judged({
  Stop: [
    { hooks: [{ type: 'command', command: `${CLI} hook stop --harness codex`, timeout: 600 }] },
    { matcher: '*', hooks: [{ type: 'command', command: `${CLI} hook stop --harness codex` }] },
    { hooks: [{ type: 'prompt', command: `${CLI} hook stop --harness codex` }] },
    { hooks: [{ type: 'command', command: `${CLI} hook stop --harness cursor` }] },
  ],
});
check(': Codex — an extra key, a group matcher, another handler type and another harness are each refused',
  shaped.accepted.length === 0 && shaped.refused.length === 4, JSON.stringify(shaped));

const otherCli = judged({ Stop: [{ hooks: [{ type: 'command', command: 'npx other hook stop --harness codex' }] }] });
const noConfig = judged({ Stop: [codexRecord('stop')] }, bare);
check(': a cli other than the project one, or no backslop.json at all, accepts nothing',
  otherCli.accepted.length === 0 && otherCli.refused.length === 1
  && noConfig.accepted.length === 0 && noConfig.refused.length === 1,
  JSON.stringify({ otherCli, noConfig }));

const cursor = judgeHookRecords(JSON.stringify({
  version: 1,
  hooks: {
    sessionStart: [{ command: `${CLI} hook session-start --harness cursor` }],
    stop: [{ command: `${CLI} hook stop --harness cursor` }, { command: 'echo foreign' }],
    afterFileEdit: [{ command: `${CLI} hook stop --harness cursor`, type: 'command' }],
  },
}), project, 'cursor');
check(': Cursor — flat records beside version: tracker ones accepted, the rest refused',
  cursor.accepted.length === 2 && cursor.refused.length === 2
  && cursor.refused.some((r) => r.includes('echo foreign'))
  && cursor.refused.some((r) => r.startsWith('afterFileEdit: ')),
  JSON.stringify(cursor));

const broken = judgeHookRecords('{ not json', project, 'codex');
const topLevel = judgeHookRecords(JSON.stringify({ version: 1, hooks: {} }), project, 'codex');
check(': not JSON and an unknown top-level key are refused, not ignored',
  broken.accepted.length === 0 && broken.refused.length === 1 && broken.refused[0].startsWith('not JSON')
  && topLevel.refused.length === 1 && topLevel.refused[0].startsWith('version: '),
  JSON.stringify({ broken, topLevel }));
