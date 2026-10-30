import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const unavailable = [z.object({ outcome: z.literal('not_applicable') }), z.object({ outcome: z.literal('unavailable') })];
const filePath = z.object({ path: z.string().min(1) });
const statusSchema = z.union([z.object({ outcome: z.literal('available'), workspace: z.object({
  checkout: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('branch'), headSha: z.string().min(1).nullable() }),
    z.object({ kind: z.literal('detached'), headSha: z.string().min(1).nullable() }),
    z.object({ kind: z.literal('unborn') }), z.object({ kind: z.literal('unknown') }),
  ]),
  branch: z.object({ currentBranch: z.string().nullable() }),
  mergeBase: z.object({ baseRef: z.string().nullable(), behindCount: z.number(), files: z.array(filePath) }).nullable(),
  workingTree: z.object({ files: z.array(filePath.extend({ status: z.enum(['M', 'A', 'D', 'R', 'C', 'U', '??', '?']) })) }),
}) }), ...unavailable]);
const patchSchema = z.object({ path: z.string().min(1), patch: z.string(), truncated: z.boolean() });
const filesSchema = z.union([z.object({ outcome: z.literal('available'), truncated: z.boolean(),
  mergeBaseRef: z.string().nullable(), files: z.array(filePath.extend({ revision: z.string().min(1), binary: z.boolean(),
    loadMode: z.enum(['auto', 'on_demand', 'too_large']) })) }), ...unavailable]);
const patchesSchema = z.record(z.string(), z.union([z.object({ outcome: z.literal('available'), patch: patchSchema }), ...unavailable]));
type GitInput = Parameters<BbPluginApi['sdk']['plugins']['callRpc']>[0]['input'];

async function read<T>(bb: BbPluginApi, method: string, input: GitInput, outputSchema: z.ZodType<T>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const result: unknown = await bb.sdk.plugins.callRpc({ pluginId: 'bb--git', method, input, outputSchema, signal });
  signal?.throwIfAborted();
  return outputSchema.parse(result);
}

export function readBbGitStatus(bb: BbPluginApi, input: { environmentId: string; mergeBaseBranch?: string }, signal?: AbortSignal) {
  return read(bb, 'workspaceStatus', input, statusSchema, signal);
}

export async function readBbGitPatches(bb: BbPluginApi, environmentId: string, baseSha: string, paths: string[],
  signal?: AbortSignal, excludeCanonicalStore = false) {
  const target = { type: 'all', mergeBaseBranch: baseSha };
  const inventory = await read(bb, 'files', { environmentId, target, ignoreWhitespace: false }, filesSchema, signal);
  const incomplete = () => new Error('Incomplete patch; leave the environment in place');
  if (inventory.outcome !== 'available' || inventory.truncated || inventory.mergeBaseRef !== baseSha) throw incomplete();
  const files = inventory.files.filter(file => !excludeCanonicalStore || (file.path !== '.promptobus' && !file.path.startsWith('.promptobus/')));
  if (files.length !== paths.length || new Set(files.map(file => file.path)).size !== paths.length
    || files.some(file => !paths.includes(file.path) || file.binary || file.loadMode === 'too_large')) throw incomplete();
  const patches: z.infer<typeof patchSchema>[] = [];
  for (let offset = 0; offset < files.length; offset += 50) {
    const batch = files.slice(offset, offset + 50);
    const keys = batch.map(file => JSON.stringify([environmentId, target, false, file.path, file.revision]));
    const results = await read(bb, 'patches', { keys }, patchesSchema, signal);
    if (Object.keys(results).length !== keys.length || Object.keys(results).some(key => !keys.includes(key))) throw incomplete();
    for (const [index, key] of keys.entries()) {
      const result = results[key];
      if (!result || result.outcome !== 'available' || result.patch.path !== batch[index].path) throw incomplete();
      patches.push(result.patch);
    }
  }
  return patches;
}
