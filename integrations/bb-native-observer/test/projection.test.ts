import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { experimental_createHostEntryHarness } from '@get-bb/plugin-sdk/testing/host';
import { selectionSchema, snapshotSchema } from '../contract.js';
import hostEntry from '../host.js';
import { ownedText, readProjection, readTasks, sessionFileName } from '../projection.js';
import { fixture, treeDigest } from './fixture.js';

test('portable configuration refuses relative roots and path-bearing task IDs', () => {
  for (const delta of [{ storeRoot: 'relative' }, { nativeRoot: '' }, { taskId: '../foreign' }])
    assert.equal(selectionSchema.safeParse({ storeRoot: '/owned/store', nativeRoot: '/owned/native', taskId: 'a', ...delta }).success, false);
});
test('absent selected store remains absent without recovery or creation', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pb-native-panel-absent-')));
  try {
    const selection = { storeRoot: path.join(root, 'absent'), nativeRoot: path.join(root, 'also-absent'), taskId: 'new-task' };
    const value = readProjection(selection, 'observer', 1);
    assert.equal(value.task.state, 'not prepared'); assert.equal(existsSync(selection.storeRoot), false);
    assert.equal(existsSync(selection.nativeRoot), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('arbitrary task and three actors retain bytes, unread inbox and launch identity across observer generations', () => {
  const f = fixture('ordinary-task-42', { launchBound: true });
  try {
    const before = treeDigest(f.root), inbox = f.engine.inboxIdentity(f.selection.taskId, 'actor-0');
    const first = snapshotSchema.parse(readProjection(f.selection, 'observer-a', 1));
    const second = snapshotSchema.parse(readProjection(f.selection, 'observer-b', 2));
    assert.equal(first.task.id, 'ordinary-task-42'); assert.equal(first.actors.length, 3);
    assert.equal(first.actors[0].launchId, second.actors[0].launchId);
    assert.deepEqual(first.actors[0].commands, { starts: 1, terminals: 1, rawSelected: 0, incompleteTail: false });
    assert.equal(first.messages.length, 2);
    assert.equal(first.task.title, 'SECRET-TITLE');
    assert(first.messages.some(message => message.body === 'SECRET-UNREAD-BODY'));
    assert.doesNotMatch(JSON.stringify(first), /SECRET-OWNER|SECRET-RECORD|SECRET-PARTICIPANT|SECRET-COMMAND|SECRET-OUTPUT|token|commandReceiptFile|sourceHead/);
    assert.equal(treeDigest(f.root), before); assert.deepEqual(f.engine.inboxIdentity(f.selection.taskId, 'actor-0'), inbox);
  } finally { f.cleanup(); }
});
test('only canonical session files are opened; a foreign malformed registry file is ignored', () => {
  const f = fixture(undefined, { launchBound: true });
  try {
    writeFileSync(path.join(f.selection.nativeRoot, 'sessions', 'foreign.json'), 'FOREIGN-INVALID-JSON');
    assert.equal(readProjection(f.selection, 'observer', 1).actors.length, 3);
    rmSync(path.join(f.selection.nativeRoot, 'sessions', sessionFileName(f.records[0].ref)));
    const actor = readProjection(f.selection, 'observer', 1).actors[0];
    assert.equal(actor.busy, null); assert.equal(actor.state, 'native record unavailable');
    assert.equal(actor.launchId, f.records[0].launchId); assert.equal(actor.commands, null);
  } finally { f.cleanup(); }
});
test('launch substitution and foreign receipt paths are refused', () => {
  const f = fixture(undefined, { launchBound: true });
  try {
    const file = path.join(f.selection.nativeRoot, 'sessions', sessionFileName(f.records[0].ref));
    writeFileSync(file, JSON.stringify({ ...f.records[0], launchId: 'another-launch', commandReceiptFile: null }));
    assert.throws(() => readProjection(f.selection, 'observer', 1), /launch identity mismatch/);
    writeFileSync(file, JSON.stringify({ ...f.records[0], commandReceiptFile: path.join(f.root, 'foreign') }));
    assert.throws(() => readProjection(f.selection, 'observer', 1), /outside/);
  } finally { f.cleanup(); }
});
test('malformed selected records and receipt rows do not expose source fragments in errors', () => {
  const f = fixture(undefined, { launchBound: true });
  try {
    const file = path.join(f.selection.nativeRoot, 'sessions', sessionFileName(f.records[0].ref));
    writeFileSync(file, '{"token":"SECRET-TOKEN"');
    assert.throws(() => readProjection(f.selection, 'observer', 1), error => error instanceof Error && error.message === 'Selected native JSON is malformed');
    writeFileSync(file, JSON.stringify(f.records[0]));
    writeFileSync(f.records[0].commandReceiptFile, 'SECRET-COMMAND-OUTPUT\n');
    assert.throws(() => readProjection(f.selection, 'observer', 1), error => error instanceof Error && error.message === 'Selected native JSON is malformed');
  } finally { f.cleanup(); }
});
test('owned reads reject symlinks, oversized files and aliased selected roots', () => {
  const f = fixture();
  try {
    const file = path.join(f.selection.nativeRoot, 'link');
    symlinkSync(f.records[0].commandReceiptFile, file);
    assert.throws(() => ownedText(f.selection.nativeRoot, file), /symlink/);
    assert.throws(() => ownedText(f.selection.nativeRoot, f.records[0].commandReceiptFile, 2), /boundary/);
    const alias = path.join(f.root, 'alias'); symlinkSync(f.selection.storeRoot, alias);
    assert.throws(() => readProjection({ ...f.selection, storeRoot: alias }, 'observer', 1), /symlinks/);
  } finally { f.cleanup(); }
});
test('partial final receipt remains explicit while sequence gaps and wrong launch headers fail', () => {
  const f = fixture(undefined, { launchBound: true });
  try {
    const file = f.records[0].commandReceiptFile, content = readFileSync(file, 'utf8');
    writeFileSync(file, content + '{');
    assert.equal(readProjection(f.selection, 'observer', 1).actors[0].commands?.incompleteTail, true);
    writeFileSync(file, content.replace('"sequence":2', '"sequence":4'));
    assert.throws(() => readProjection(f.selection, 'observer', 1), /sequence/);
    writeFileSync(file, content.replace('"launch-0"', '"foreign-launch"'));
    assert.throws(() => readProjection(f.selection, 'observer', 1), /receipt launch identity/);
  } finally { f.cleanup(); }
});
test('real typed host boundary admits snapshot only and preserves the fixture', async () => {
  const f = fixture(), harness = experimental_createHostEntryHarness(hostEntry);
  try {
    const before = treeDigest(f.root);
    const snapshot = await harness.experimental_call('snapshot', f.selection);
    assert.equal(snapshot.actors.length, 3); assert.equal(treeDigest(f.root), before);
    await assert.rejects(() => harness.experimental_call('snapshot', { ...f.selection, command: 'send' } as never));
    await assert.rejects(() => harness.experimental_call('stop' as never, f.selection as never));
    assert.deepEqual(Object.keys(hostEntry.contract), ['snapshot', 'tasks']);
  } finally { await harness.experimental_dispose(); f.cleanup(); }
});
test('task discovery and projection include unread mail without consuming or duplicating it', () => {
  const f = fixture('selected-feed');
  try {
    f.engine.sendSync(f.selection.taskId, { from: 'actor-0', to: ['owner'], type: 'question', body: 'Please choose the next task' });
    const inbox = f.engine.inboxIdentity(f.selection.taskId, 'owner'), before = treeDigest(f.root);
    const catalogue = readTasks({ storeRoot: f.selection.storeRoot, nativeRoot: f.selection.nativeRoot });
    assert.deepEqual(catalogue.tasks.map(task => task.id), ['selected-feed']);
    const view = readProjection(f.selection, 'dashboard', 3);
    assert.equal(view.messages.filter(message => message.type === 'question').length, 1);
    assert.equal(view.messages.find(message => message.type === 'question')?.body, 'Please choose the next task');
    assert.deepEqual(f.engine.inboxIdentity(f.selection.taskId, 'owner'), inbox);
    assert.equal(treeDigest(f.root), before);
    f.engine.read(f.selection.taskId, 'owner');
    assert.deepEqual(readProjection(f.selection, 'dashboard', 4).messages, view.messages);
  } finally { f.cleanup(); }
});
test('message preview truncates explicitly and leaves original canonical bytes intact', () => {
  const f = fixture();
  try {
    const body = 'x'.repeat(17000);
    f.engine.sendSync(f.selection.taskId, { from: 'actor-0', to: ['owner'], type: 'result', body });
    const before = treeDigest(f.root), view = readProjection(f.selection, 'dashboard', 3);
    const result = view.messages.find(message => message.type === 'result')!;
    assert.equal(result.body.length, 16000); assert.equal(result.bodyTruncated, true);
    assert.equal(treeDigest(f.root), before);
  } finally { f.cleanup(); }
});
test('selected canonical task errors omit source fragments', () => {
  const f = fixture('malformed-selected');
  try {
    writeFileSync(path.join(f.selection.storeRoot, 'tasks', f.selection.taskId, 'task.json'), 'SECRET-PANEL-TASK-DATA');
    assert.throws(() => readProjection(f.selection, 'review', 1), error => {
      assert(error instanceof Error); assert.doesNotMatch(error.message, /SECRET-PAN/);
      assert.match(error.message, /Selected canonical task/); return true;
    });
  } finally { f.cleanup(); }
});
test('an unrelated legacy sibling cannot break the selected task snapshot', () => {
  const f = fixture('selected-valid');
  try {
    const before = readProjection(f.selection, 'review', 1);
    const foreign = path.join(f.selection.storeRoot, 'tasks', 'unselected-legacy'); mkdirSync(foreign);
    writeFileSync(path.join(foreign, 'task.json'), JSON.stringify({ id: 'unselected-legacy', status: 'active', participants: [{ address: 'worker:legacy' }] }));
    const bytes = treeDigest(f.root), after = readProjection(f.selection, 'review', 1);
    assert.deepEqual(after.actors, before.actors); assert.deepEqual(after.messages, before.messages);
    assert.equal(treeDigest(f.root), bytes);
  } finally { f.cleanup(); }
});
test('selected history refuses a symlink outside the owned store', () => {
  const f = fixture('history-boundary');
  try {
    const entry = f.engine.history({ task: f.selection.taskId, limit: 1, strict: true }).entries[0];
    const file = path.join(f.selection.storeRoot, 'tasks', f.selection.taskId, 'history', entry.participant, entry.message.id + '.json');
    const foreign = path.join(f.root, 'outside-selected-store.json');
    writeFileSync(foreign, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), sender: 'foreign-reader' }));
    rmSync(file); symlinkSync(foreign, file);
    assert.throws(() => readProjection(f.selection, 'review', 1), /Selected canonical history/);
  } finally { f.cleanup(); }
});
test('canonical task reads reject invalid schemas, identity mismatches and nonregular or oversized files', () => {
  for (const variant of ['schema', 'identity', 'directory', 'oversized']) {
    const f = fixture();
    try {
      const file = path.join(f.selection.storeRoot, 'tasks', f.selection.taskId, 'task.json');
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (variant === 'schema') writeFileSync(file, JSON.stringify({ ...value, 'SECRET-PANEL-TASK-DATA': true }));
      if (variant === 'identity') writeFileSync(file, JSON.stringify({ ...value, id: 'another-task' }));
      if (variant === 'directory') { rmSync(file); mkdirSync(file); }
      if (variant === 'oversized') writeFileSync(file, JSON.stringify({ ...value, title: 'x'.repeat(262145) }));
      assert.throws(() => readProjection(f.selection, 'review', 1), error => {
        assert(error instanceof Error); assert.doesNotMatch(error.message, /SECRET-PAN/);
        assert.match(error.message, /Selected canonical task/); return true;
      }, variant);
    } finally { f.cleanup(); }
  }
});
test('canonical history reads reject malformed or oversized content, nonregular files and wrong task identity', () => {
  for (const variant of ['json', 'identity', 'directory', 'oversized']) {
    const f = fixture();
    try {
      const entry = f.engine.history({ task: f.selection.taskId, limit: 1, strict: true }).entries[0];
      const file = path.join(f.selection.storeRoot, 'tasks', f.selection.taskId, 'history', entry.participant, entry.message.id + '.json');
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (variant === 'json') writeFileSync(file, 'SECRET-PANEL-HISTORY-DATA');
      if (variant === 'identity') writeFileSync(file, JSON.stringify({ ...value, task: 'another-task' }));
      if (variant === 'directory') { rmSync(file); mkdirSync(file); }
      if (variant === 'oversized') writeFileSync(file, JSON.stringify({ ...value, body: 'x'.repeat(262145) }));
      assert.throws(() => readProjection(f.selection, 'review', 1), error => {
        assert(error instanceof Error); assert.doesNotMatch(error.message, /SECRET-PAN/);
        assert.match(error.message, /Selected canonical history/); return true;
      }, variant);
    } finally { f.cleanup(); }
  }
});

test('selected task identity excludes messages and actors from a sibling task', () => {
  const f = fixture('chosen-task');
  try {
    const owner = f.engine.readTask(f.selection.taskId).participants[0];
    f.engine.createTask({ id: 'sibling-task', title: 'Sibling only', owner });
    f.engine.addParticipant('sibling-task', { ...owner, id: 'foreign-worker', role: 'worker', mode: 'managed',
      sessionRef: null, metadata: { address: 'worker:foreign' } });
    f.engine.sendSync('sibling-task', { from: owner.id, to: ['foreign-worker'], type: 'question', body: 'SIBLING-ONLY-MESSAGE' });
    f.engine.sendSync(f.selection.taskId, { from: 'actor-1', to: [owner.id], type: 'result', body: 'Review: zero findings' });
    const snapshot = readProjection(f.selection, 'test', 1);
    assert.deepEqual(snapshot.selection, f.selection);
    assert(snapshot.messages.some(message => message.body === 'Review: zero findings'));
    assert.doesNotMatch(JSON.stringify(snapshot), /SIBLING-ONLY|worker:foreign|Sibling only/);
    assert.deepEqual(snapshot.actors.map(actor => [actor.participantId, actor.role]), [['actor-0', 'worker'], ['actor-1', 'reviewer'], ['actor-2', 'worker']]);
    const sibling = readProjection({ ...f.selection, taskId: 'sibling-task' }, 'test', 1);
    assert.equal(sibling.messages.length, 1); assert.equal(sibling.actors.length, 1);
    assert.equal(sibling.messages[0].body, 'SIBLING-ONLY-MESSAGE');
  } finally { f.cleanup(); }
});

test('discovery counts valid tasks after more than 256 raw legacy entries', () => {
  const f = fixture('valid-first');
  try {
    const owner = f.engine.readTask(f.selection.taskId).participants[0];
    f.engine.createTask({ id: 'valid-second', title: 'Second', owner });
    for (let index = 0; index < 255; index++) {
      const directory = path.join(f.selection.storeRoot, 'tasks', `legacy-${index}`); mkdirSync(directory);
      writeFileSync(path.join(directory, 'task.json'), '{INVALID-LEGACY');
    }
    const before = treeDigest(f.root), catalogue = readTasks({ storeRoot: f.selection.storeRoot, nativeRoot: f.selection.nativeRoot });
    assert.deepEqual(catalogue.tasks.map(task => task.id).sort(), ['valid-first', 'valid-second']);
    assert.equal(catalogue.scanned, 257); assert.equal(catalogue.truncated, false);
    assert.equal(readProjection(f.selection, 'test', 1).task.id, 'valid-first');
    assert.equal(treeDigest(f.root), before);
  } finally { f.cleanup(); }
});

test('discovery reports valid-task and scan truncation without blocking a selected task', () => {
  for (const variant of ['valid', 'scan']) {
    const f = fixture('selected-outside-catalogue');
    try {
      const task = f.engine.readTask(f.selection.taskId), owner = task.participants.find(p => p.id === task.owner)!;
      for (let index = 0; index < (variant === 'valid' ? 260 : 4100); index++) {
        const id = `entry-${index}`, directory = path.join(f.selection.storeRoot, 'tasks', id); mkdirSync(directory);
        if (variant === 'valid') writeFileSync(path.join(directory, 'task.json'), JSON.stringify({ ...task, id, participants: [owner] }));
      }
      const catalogue = readTasks({ storeRoot: f.selection.storeRoot, nativeRoot: f.selection.nativeRoot });
      assert.equal(catalogue.truncated, true, variant);
      assert(catalogue.scanned <= 4096);
      assert(catalogue.tasks.length <= 256);
      if (variant === 'valid') {
        assert.equal(catalogue.tasks.length, 256);
        const omitted = Array.from({ length: 260 }, (_, i) => `entry-${i}`).find(id => !catalogue.tasks.some(task => task.id === id))!;
        assert.equal(readProjection({ ...f.selection, taskId: omitted }, 'test', 1).task.id, omitted);
      }
      assert.equal(readProjection(f.selection, 'test', 1).task.id, f.selection.taskId);
    } finally { f.cleanup(); }
  }
});
