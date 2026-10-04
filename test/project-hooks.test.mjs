// The project hook records a lift keeps because the repository's promptobus.json trusts them, and
// everything it does not ([ADR-025](../docs/adr/adr-025-foreign-project-hook-records.md)). Run: npm test
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { judgeHookRecords, trustRule } = await import(path.join(here, '..', 'lib', 'project-hooks.js'));
const { createStandaloneHost } = await import(path.join(here, '..', 'dist', 'host-index.js'));
const { admitsAddress, registryOf } = await import(path.join(here, '..', 'dist', 'index.js'));
const { guardHookCommand } = await import(path.join(here, '..', 'dist', 'hooks.js'));

const SB = makeSandbox('promptobus-project-hooks-');
const projectWith = (name, files) => {
  const dir = path.join(SB, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text);
  return dir;
};
const json = (value) => `${JSON.stringify(value)}\n`;

const TRACKER = 'npx --no-install backslop';
const tracker = (event, harness) => `${TRACKER} hook ${event} --harness ${harness}`;
const UNRELATED = 'node scripts/stop-note.mjs';
const GUARD = '"/usr/bin/node" "/opt/promptobus/bin/promptobus.js" guard --role worker:a --task t --home /h';
const GUARD_SPELLINGS = [
  GUARD,
  'node /abs/promptobus.js guard --role worker:a --task t --home /h',
  'npx promptobus guard',
  '"/bin/node" "/bin/agents.js" promptobus guard --role worker:cur',
];
const NEAR_GUARD = 'node scripts/lint.mjs guard';

const trusted = projectWith('trusted', {
  'promptobus.json': json({
    tools: ['codex'],
    trustedHooks: {
      codex: {
        SessionStart: [tracker('session-start', 'codex')],
        Stop: [tracker('stop', 'codex'), UNRELATED, ...GUARD_SPELLINGS, NEAR_GUARD],
        PreToolUse: [UNRELATED],
      },
      cursor: { sessionStart: [tracker('session-start', 'cursor')], stop: [tracker('stop', 'cursor')] },
    },
  }),
});
const unrelatedOnly = projectWith('unrelated', { 'promptobus.json': json({ trustedHooks: { codex: { Stop: [UNRELATED] } } }) });
const trackerConfigOnly = projectWith('tracker-config', { 'backslop.json': json({ prefix: 'X', cli: TRACKER }) });
const notJson = projectWith('not-json', { 'promptobus.json': '{ "trustedHooks": ' });
const notObject = projectWith('not-object', { 'promptobus.json': '[]\n' });
const notObjectString = projectWith('not-object-string', { 'promptobus.json': '"x"\n' });
const noField = projectWith('no-field', { 'promptobus.json': json({ tools: ['codex'] }) });
const otherHarness = projectWith('other-harness', {
  'promptobus.json': json({ trustedHooks: { cursor: { stop: [tracker('stop', 'cursor')] } } }),
});
const misshaped = projectWith('misshaped', { 'promptobus.json': json({ trustedHooks: { codex: { Stop: UNRELATED } } }) });

const codexRecord = (command, extra = {}) => ({ hooks: [{ type: 'command', command, ...extra }] });
const codexFile = (hooks) => JSON.stringify({ hooks });
const judged = (root, hooks) => judgeHookRecords(codexFile(hooks), root, 'codex');
const trackerHooks = {
  SessionStart: [codexRecord(tracker('session-start', 'codex'))],
  Stop: [codexRecord(tracker('stop', 'codex'))],
};

const unrelated = judged(unrelatedOnly, { Stop: [codexRecord(UNRELATED)] });
check(': Codex — an unrelated command the repository trusts is kept, nothing refused',
  unrelated.refused.length === 0 && unrelated.broken === null
  && JSON.stringify(unrelated.accepted) === JSON.stringify([{ key: 'Stop', command: UNRELATED }]),
  JSON.stringify(unrelated));

const declared = judged(trusted, trackerHooks);
check(': Codex — the tracker records the repository trusts are kept, each once',
  declared.refused.length === 0 && declared.accepted.length === 2
  && declared.accepted.filter((r) => r.key === 'Stop' && r.command === tracker('stop', 'codex')).length === 1
  && declared.accepted.filter((r) => r.key === 'SessionStart').length === 1,
  JSON.stringify(declared));

const undeclared = judged(trackerConfigOnly, trackerHooks);
check(': Codex — tracker records beside a tracker config naming its cli, with no trust declaration, are all refused',
  undeclared.accepted.length === 0 && undeclared.refused.length === 2 && undeclared.broken === null,
  JSON.stringify(undeclared));

const scoped = judged(trusted, {
  SessionStart: [codexRecord(tracker('stop', 'codex'))],
  PreToolUse: [codexRecord(UNRELATED)],
  Stop: [codexRecord(tracker('stop', 'cursor')), codexRecord(`${tracker('stop', 'codex')} `), codexRecord('echo foreign')],
});
check(': Codex — another event key, an event a lift does not keep, another harness, a near-miss and a foreign command are refused',
  scoped.accepted.length === 0 && scoped.refused.length === 5
  && scoped.refused.some((r) => r.startsWith('PreToolUse: '))
  && scoped.refused.some((r) => r.startsWith('Stop: ') && r.includes('echo foreign')),
  JSON.stringify(scoped));

const shaped = judged(trusted, {
  Stop: [
    codexRecord(UNRELATED, { timeout: 600 }),
    { matcher: '*', hooks: [{ type: 'command', command: UNRELATED }] },
    { hooks: [{ type: 'prompt', command: UNRELATED }] },
  ],
});
check(': Codex — an extra key, a group matcher and another handler type are each refused though the command is trusted',
  shaped.accepted.length === 0 && shaped.refused.length === 3, JSON.stringify(shaped));

const guard = judged(trusted, { Stop: GUARD_SPELLINGS.map((command) => codexRecord(command)) });
check(': a Promptobus guard is refused even when the declaration lists it, in every spelling',
  guard.accepted.length === 0 && guard.refused.length === GUARD_SPELLINGS.length,
  JSON.stringify(guard));
const nearGuard = judged(trusted, { Stop: [codexRecord(NEAR_GUARD)] });
check(': a listed command whose bare word guard follows no word naming promptobus is kept',
  nearGuard.refused.length === 0 && nearGuard.accepted.length === 1, JSON.stringify(nearGuard));

const withoutField = judged(noField, trackerHooks);
const withoutHarness = judged(otherHarness, trackerHooks);
check(': a promptobus.json with no trustedHooks, or with none for the judged harness, trusts nothing and is not broken',
  withoutField.accepted.length === 0 && withoutField.refused.length === 2 && withoutField.broken === null
  && withoutHarness.accepted.length === 0 && withoutHarness.refused.length === 2 && withoutHarness.broken === null,
  JSON.stringify({ withoutField, withoutHarness }));

const cursor = judgeHookRecords(JSON.stringify({
  version: 1,
  hooks: {
    sessionStart: [{ command: tracker('session-start', 'cursor') }],
    stop: [{ command: tracker('stop', 'cursor') }, { command: 'echo foreign' }, { command: tracker('stop', 'codex') }],
    afterFileEdit: [{ command: tracker('stop', 'cursor'), type: 'command' }],
  },
}), trusted, 'cursor');
check(': Cursor — flat records beside version: trusted ones kept, the rest refused',
  cursor.accepted.length === 2 && cursor.refused.length === 3
  && cursor.refused.some((r) => r.includes('echo foreign'))
  && cursor.refused.some((r) => r.includes('--harness codex'))
  && cursor.refused.some((r) => r.startsWith('afterFileEdit: ')),
  JSON.stringify(cursor));

const unreadable = judged(notJson, trackerHooks);
const wrongShape = judged(misshaped, { Stop: [codexRecord(UNRELATED)] });
check(': a declaration that is not JSON, or not a list of commands, is reported as broken and trusts nothing',
  unreadable.accepted.length === 0 && unreadable.broken?.includes(path.join(notJson, 'promptobus.json'))
  && wrongShape.accepted.length === 0 && wrongShape.refused.length === 1
  && wrongShape.broken?.includes('"trustedHooks"'),
  JSON.stringify({ unreadable, wrongShape }));
const arrayFile = judged(notObject, trackerHooks);
const stringFile = judged(notObjectString, trackerHooks);
check(': a promptobus.json that is JSON but not an object is reported as broken and trusts nothing',
  arrayFile.accepted.length === 0 && arrayFile.broken === `${path.join(notObject, 'promptobus.json')} must hold a JSON object`
  && stringFile.accepted.length === 0 && stringFile.broken === `${path.join(notObjectString, 'promptobus.json')} must hold a JSON object`,
  JSON.stringify({ arrayFile, stringFile }));

const broken = judgeHookRecords('{ not json', trusted, 'codex');
const topLevel = judgeHookRecords(JSON.stringify({ version: 1, hooks: {} }), trusted, 'codex');
check(': not JSON and an unknown top-level key are refused, not ignored',
  broken.accepted.length === 0 && broken.refused.length === 1 && broken.refused[0].startsWith('not JSON')
  && topLevel.refused.length === 1 && topLevel.refused[0].startsWith('version: '),
  JSON.stringify({ broken, topLevel }));

const declaredText = json({ trustedHooks: { codex: { SessionStart: [tracker('session-start', 'codex')], Stop: [tracker('stop', 'codex')] } } });
const noDeclaration = judgeHookRecords(codexFile(trackerHooks), trusted, 'codex', { declaration: null });
const fromText = judgeHookRecords(codexFile(trackerHooks), trackerConfigOnly, 'codex', { declaration: declaredText });
check(': a declaration handed in as text stands in for the file on disk, and null stands for no file',
  noDeclaration.accepted.length === 0 && noDeclaration.broken === null
  && fromText.accepted.length === 2 && fromText.refused.length === 0,
  JSON.stringify({ noDeclaration, fromText }));

// A host whose guard argv names no promptobus: install writes its guard without identity flags.
const customHost = { nodePath: () => '/usr/bin/node', guardArgv: (args) => ['/x/mytool.js', 'bus', ...args] };
const customGuard = guardHookCommand(customHost, { address: 'worker:a', taskId: 't', home: '/h' });
const installedCustomGuard = guardHookCommand(customHost);
const customSpellings = [installedCustomGuard, 'node /x/mytool.js bus guard'];
const customTrusted = projectWith('custom-guard', { 'promptobus.json': json({ trustedHooks: { codex: { Stop: customSpellings } } }) });
const customHooks = { Stop: customSpellings.map((command) => codexRecord(command)) };
const withoutOwnGuard = judgeHookRecords(codexFile(customHooks), customTrusted, 'codex');
const withOwnGuard = judgeHookRecords(codexFile(customHooks), customTrusted, 'codex', { guard: customGuard });
check(': a listed guard of a host whose guard argv names no promptobus is refused by the lift\'s own guard command',
  withoutOwnGuard.accepted.length === 2
  && withOwnGuard.accepted.length === 0 && withOwnGuard.refused.length === 2,
  JSON.stringify({ customGuard, withoutOwnGuard, withOwnGuard }));

const rule = trustRule(trusted, 'cursor');
check(': the rule names the declaration file and the event keys, and no tracker',
  rule.includes(path.join(trusted, 'promptobus.json'))
  && rule.includes('"trustedHooks.cursor.sessionStart"') && rule.includes('"trustedHooks.cursor.stop"')
  && !/backslop|--harness/.test(rule),
  rule);

const installRoot = projectWith('install-root', {
  'promptobus.json': json({
    tools: ['codex'],
    pipeline: { owner: { name: 'worker', kind: 'edits-tree' }, gates: [{ name: 'security', kind: 'reads-diff' }] },
  }),
});
const nested = path.join(installRoot, 'repos', 'r');
mkdirSync(nested, { recursive: true });
const admits = (cwd, address) => admitsAddress(registryOf(createStandaloneHost({ cwd })), address);
const rootBefore = createStandaloneHost({ cwd: nested }).workspaceRoot();
const stepBefore = admits(nested, 'security:x');
writeFileSync(path.join(nested, 'promptobus.json'), json({ trustedHooks: { codex: { Stop: [UNRELATED] } } }));
const hostAfter = createStandaloneHost({ cwd: nested });
check(': a repository promptobus.json holding only trustedHooks becomes the root of a standalone host started inside it',
  rootBefore === installRoot && hostAfter.workspaceRoot() === nested
  && hostAfter.promptobusHome() === path.join(nested, '.promptobus'),
  JSON.stringify({ rootBefore, after: hostAfter.workspaceRoot(), home: hostAfter.promptobusHome() }));
check(': inside that repository a step declared only in the install root pipeline is no longer an address; shipped roles still are',
  stepBefore && admits(installRoot, 'security:x')
  && !admits(nested, 'security:x') && admits(nested, 'worker:x'),
  JSON.stringify({ stepBefore, atRoot: admits(installRoot, 'security:x'), nested: admits(nested, 'security:x') }));
