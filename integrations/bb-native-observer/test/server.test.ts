import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from '../server.js';
import { readProjection, readTasks } from '../projection.js';
import type { Selection, Snapshot, View } from '../contract.js';
import { retainSample } from '../dashboard.js';
import { fixture, treeDigest } from './fixture.js';

type Values = Selection & { hostId: string };
type Handlers = { snapshot(): Promise<Snapshot>; view(): Promise<View>; tasks(): Promise<unknown>;
  selectTask(input: { taskId: string }): Promise<Snapshot> };
function harness(values: Values) {
  const calls: string[] = [], listeners: (() => void)[] = [];
  let rpc!: Handlers, cli!: { run(argv: string[]): Promise<{ exitCode: number; stdout?: string }> };
  let reader = async (method: string, selected: Selection): Promise<unknown> => method === 'snapshot'
    ? readProjection(selected, 'test', 1) : readTasks(selected);
  const change = (patch: Partial<Values>) => { Object.assign(values, patch); listeners.forEach(listener => listener()); };
  plugin({
    settings: { define() { return { async get() { return { ...values }; },
      onChange(listener: () => void) { listeners.push(listener); }, async experimental_set(patch: Partial<Values>) { change(patch); } }; } },
    hosts: { experimental_client() { return { async call(method: string, selected: Selection) { calls.push(method); return reader(method, selected); } }; } },
    rpc: { register(_contract: unknown, handlers: Handlers) { rpc = handlers; } },
    cli: { register(value: typeof cli) { cli = value; } },
  } as never);
  return { rpc, cli, calls, change, values, readHost(fn: typeof reader) { reader = fn; } };
}
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

test('task discovery works before selection and selection survives server reload without changing store bytes', async () => {
  const f = fixture('first-task');
  try {
    f.engine.createTask({ id: 'second-task', title: 'Second task', owner: f.engine.readTask(f.selection.taskId).participants[0] });
    const values = { ...f.selection, hostId: 'host_example', taskId: '' }, server = harness(values), before = treeDigest(f.root);
    const initial = await server.rpc.view();
    assert.equal(initial.snapshot, null); assert.equal(initial.catalogue!.tasks.length, 2);
    const selected = await server.rpc.selectTask({ taskId: 'second-task' });
    assert.equal(selected.task.id, 'second-task'); assert.equal(values.taskId, 'second-task');
    const remounted = harness(values), view = await remounted.rpc.view();
    assert.equal(view.snapshot?.task.id, 'second-task'); assert.equal(view.configuration.storeRoot, f.selection.storeRoot);
    assert.deepEqual(view.snapshot?.selection, { ...f.selection, taskId: 'second-task' });
    assert.equal(treeDigest(f.root), before);
    assert.deepEqual(Object.keys(remounted.rpc), ['snapshot', 'view', 'tasks', 'selectTask']);
  } finally { f.cleanup(); }
});

test('an external configuration change invalidates the entire view and a pending selection', async () => {
  const f = fixture();
  try {
    for (const operation of ['view', 'selectTask'] as const) {
      const server = harness({ ...f.selection, hostId: 'host_example' }), entered = deferred(), release = deferred();
      server.readHost(async (method, selected) => {
        entered.resolve(); await release.promise;
        return method === 'snapshot' ? readProjection(selected, 'test', 1) : readTasks(selected);
      });
      const reading = operation === 'view' ? server.rpc.view() : server.rpc.selectTask({ taskId: f.selection.taskId });
      await entered.promise; server.change({ taskId: 'foreign-task' }); release.resolve();
      await assert.rejects(reading, /configuration changed/);
      assert.equal(server.values.taskId, 'foreign-task');
    }
  } finally { f.cleanup(); }
});

test('wrong snapshot identity is refused even when the host returns another valid task', async () => {
  const f = fixture();
  try {
    const server = harness({ ...f.selection, hostId: 'host_example' });
    server.readHost(async () => ({ ...readProjection(f.selection, 'test', 1), selection: { ...f.selection, taskId: 'foreign-task' } }));
    await assert.rejects(server.rpc.snapshot(), /selection differs/);
  } finally { f.cleanup(); }
});

test('malformed configuration refuses before host access and CLI accepts observation only', async () => {
  const f = fixture();
  try {
    const server = harness({ ...f.selection, hostId: '' });
    await assert.rejects(server.rpc.view(), /Configure/); assert.deepEqual(server.calls, []);
    server.change({ hostId: 'host_example' });
    assert.equal((await server.cli.run(['stop'])).exitCode, 1); assert.deepEqual(server.calls, []);
    const result = await server.cli.run([]); assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout!).task.id, f.selection.taskId);
    await assert.rejects(server.rpc.selectTask({ taskId: 'absent-task' }), /unavailable/);
    assert.equal(server.values.taskId, f.selection.taskId);
  } finally { f.cleanup(); }
});

test('remount keeps the configured identity and healthy sibling discovery when the selected snapshot fails', async () => {
  const { writeFileSync } = await import('node:fs'), { default: path } = await import('node:path');
  const f = fixture('broken-selected', { launchBound: true });
  try {
    const owner = f.engine.readTask(f.selection.taskId).participants[0];
    f.engine.createTask({ id: 'healthy-sibling', title: 'Healthy', owner });
    const values = { ...f.selection, hostId: 'host_example' }, first = harness(values);
    const previous = await first.rpc.view();
    assert.equal(previous.snapshot!.task.id, 'broken-selected');
    const { sessionFileName } = await import('../projection.js');
    writeFileSync(path.join(f.selection.nativeRoot, 'sessions', sessionFileName(f.records[0].ref)), '{INVALID');
    const remounted = harness(values), view = await remounted.rpc.view();
    assert.equal(view.snapshot, null); assert.match(view.snapshotError!, /malformed/);
    assert.deepEqual(view.configuration, values); assert.equal(view.catalogueError, null);
    assert(view.catalogue!.tasks.some(task => task.id === 'healthy-sibling'));
    assert.equal(retainSample(previous, view).snapshot, previous.snapshot);
    for (const delta of [{ taskId: 'different-task' }, { storeRoot: '/different/store' }, { nativeRoot: '/different/native' }, { hostId: 'host_other' }])
      assert.equal(retainSample(previous, { ...view, configuration: { ...view.configuration, ...delta } }).snapshot, null);
    await remounted.rpc.selectTask({ taskId: 'healthy-sibling' });
    const recovered = await remounted.rpc.view();
    assert.equal(recovered.snapshotError, null); assert.equal(recovered.snapshot!.task.id, 'healthy-sibling');
  } finally { f.cleanup(); }
});

test('a catalogue failure remains separate from a healthy selected snapshot', async () => {
  const f = fixture();
  try {
    const server = harness({ ...f.selection, hostId: 'host_example' });
    server.readHost(async (method, selected) => {
      if (method === 'tasks') throw new Error('Discovery unavailable');
      return readProjection(selected, 'test', 1);
    });
    const view = await server.rpc.view();
    assert.equal(view.catalogue, null); assert.match(view.catalogueError!, /Discovery unavailable/);
    assert.equal(view.snapshotError, null); assert.equal(view.snapshot!.task.id, f.selection.taskId);
  } finally { f.cleanup(); }
});
