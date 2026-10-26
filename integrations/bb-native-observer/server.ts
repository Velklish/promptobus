import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { configurationSchema, hostContract, rpcContract, rootsSchema, settingsSchema } from './contract.js';
export { rpcContract } from './contract.js';

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostId: { type: 'string', label: 'Host ID', default: '', experimental_schema: settingsSchema.shape.hostId.or(z.literal('')) },
    storeRoot: { type: 'string', label: 'Promptobus store root', default: '', experimental_schema: rootsSchema.shape.storeRoot.or(z.literal('')) },
    nativeRoot: { type: 'string', label: 'Native Codex state root', default: '', experimental_schema: rootsSchema.shape.nativeRoot.or(z.literal('')) },
    taskId: { type: 'string', label: 'Task ID', default: '', experimental_schema: configurationSchema.shape.taskId },
  });
  let revision = 0;
  settings.onChange(() => { revision++; });
  let operations = Promise.resolve<unknown>(undefined);
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = operations.then(run);
    operations = result.catch(() => undefined);
    return result;
  };
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const configuration = async () => {
    const parsed = configurationSchema.safeParse(await settings.get());
    if (!parsed.success) throw new Error('Configure Host ID and absolute store and native roots in plugin Settings, then select a task');
    return parsed.data;
  };
  const snapshotFor = async (values: Awaited<ReturnType<typeof configuration>>) => {
    const { hostId, ...selected } = settingsSchema.parse(values);
    const value = await host.call('snapshot', selected, { hostId, timeoutMs: 5000 });
    if (value.selection.storeRoot !== selected.storeRoot || value.selection.nativeRoot !== selected.nativeRoot
      || value.selection.taskId !== selected.taskId || value.task.id !== selected.taskId) throw new Error('Snapshot selection differs from the configured task');
    return value;
  };
  const tasksFor = (values: Awaited<ReturnType<typeof configuration>>) => host.call('tasks',
    { storeRoot: values.storeRoot, nativeRoot: values.nativeRoot }, { hostId: values.hostId, timeoutMs: 5000 });
  const unchanged = (started: number) => {
    if (started !== revision) throw new Error('Selected configuration changed while reading; refresh the observer');
  };
  const snapshot = async () => {
    const started = revision, values = await configuration(), value = await snapshotFor(values);
    unchanged(started); return value;
  };
  bb.rpc.register(rpcContract, {
    snapshot,
    async view() {
      const started = revision, values = await configuration();
      const [catalogue, selected] = await Promise.allSettled([tasksFor(values),
        values.taskId ? snapshotFor(values) : Promise.resolve(null)]);
      unchanged(started);
      return { configuration: values,
        snapshot: selected.status === 'fulfilled' ? selected.value : null,
        snapshotError: selected.status === 'rejected' ? String(selected.reason) : null,
        catalogue: catalogue.status === 'fulfilled' ? catalogue.value : null,
        catalogueError: catalogue.status === 'rejected' ? String(catalogue.reason) : null };
    },
    async tasks() {
      const started = revision, value = await tasksFor(await configuration());
      unchanged(started); return value;
    },
    async selectTask({ taskId }) {
      const started = ++revision;
      return serial(async () => {
        const values = await configuration();
        const value = await snapshotFor({ ...values, taskId });
        if (value.task.state === 'not prepared') throw new Error('Selected task is unavailable; refresh the task list');
        unchanged(started);
        await settings.experimental_set({ taskId });
        return value;
      });
    },
  });
  bb.cli.register({ name: 'promptobus-native-panel', summary: 'Read the configured native task snapshot', async run(argv) {
    if (argv.length) return { exitCode: 1, stderr: 'No arguments accepted; use plugin Settings or the dashboard task selector' };
    return { exitCode: 0, stdout: JSON.stringify(await snapshot()) };
  } });
}
