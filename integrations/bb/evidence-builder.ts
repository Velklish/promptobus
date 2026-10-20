import path from 'node:path';
import { z } from 'zod';
import { digest, evidenceManifestSchema, validateReviewEvidence } from './review-evidence.js';
import type { EvidenceArtifact, EvidenceManifest } from './review-evidence.js';

const absolute = z.string().refine(file => path.isAbsolute(file), 'requires an absolute original path');
const manifestFields = evidenceManifestSchema.shape;
export const evidencePreparationSchema = z.object({
  source: manifestFields.source, base: manifestFields.base, producer: manifestFields.producer, relayer: manifestFields.relayer,
  requiredGates: manifestFields.requiredGates, requirePassingGates: z.boolean(), checks: manifestFields.checks,
  commands: z.array(z.object({ receipt: absolute, kind: z.enum(['gate', 'verification']),
    finalization: z.object({ receipt: absolute, admission: absolute }).strict().optional(),
  }).strict()).min(1),
  inventories: z.object({ base: absolute, source: absolute }).strict(), inventoryRaw: z.array(absolute).optional(), derived: absolute,
  support: z.object({ index: absolute, required: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) }).strict()),
    originals: z.array(absolute) }).strict().optional(),
}).strict();
export type EvidencePreparation = z.infer<typeof evidencePreparationSchema>;
export const uploadResultSchema = z.object({ parts: z.array(z.object({ id: z.string().min(1), filename: z.string().endsWith('.txt'),
  size: z.number().int().min(0).max(900_000), sha256: z.string().regex(/^[a-f0-9]{64}$/), sender: z.string().min(1),
}).passthrough()).min(1), bytes: z.number().int().min(0).max(64 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type EvidenceUploadResult = z.infer<typeof uploadResultSchema>;
type Originals = { readOriginal: (file: string) => Promise<string> };

export async function currentEvidenceFiles(input: unknown, io: Originals) {
  const prepared = evidencePreparationSchema.parse(input), files = new Map<string, string>();
  const read = async (file: string) => {
    if (!files.has(file)) files.set(file, await io.readOriginal(file));
    return files.get(file)!;
  };
  const commands = [];
  for (const selected of prepared.commands) {
    const receipt = JSON.parse(await read(selected.receipt));
    if (receipt.format !== 'bb-direct-command-v1' || receipt.complete !== true || receipt.direct !== true
      || receipt.signal !== null || receipt.error !== null || receipt.finalizationComplete === false || receipt.finalizationError || receipt.notRun === true) {
      throw new Error('evidence preparation: original receipt is not finalized');
    }
    for (const stream of ['stdout', 'stderr']) {
      const scope = receipt[stream];
      if (!scope || !path.isAbsolute(scope.file ?? '')) throw new Error('evidence preparation: original stream path is required');
      const raw = await read(scope.file);
      if (Buffer.byteLength(raw) !== scope.bytes || digest(raw) !== scope.sha256) throw new Error('evidence preparation: original stream bytes/hash mismatch');
    }
    if (selected.finalization) await read(selected.finalization.admission);
    commands.push({ receipt, selected });
  }
  for (const file of [prepared.inventories.base, prepared.inventories.source, ...(prepared.inventoryRaw ?? [])]) await read(file);
  const latest = new Map(commands.filter(command => command.selected.kind === 'gate').map(command => [JSON.stringify(command.receipt.command), command.receipt]));
  const derived = new Map([
    [path.join(prepared.derived, 'gate.txt'), JSON.stringify({ tree: prepared.source, by: prepared.producer, dirty: false,
      gates: latest.size, green: [...latest.values()].filter(command => command.exit === 0).length }) + '\n'],
    [path.join(prepared.derived, 'handover.txt'), JSON.stringify({ source: prepared.source, base: prepared.base, by: prepared.producer, checks: prepared.checks }) + '\n'],
  ]);
  for (const [file, raw] of derived) {
    if (files.has(file)) throw new Error('evidence preparation: derived output collides with an original');
    files.set(file, raw);
  }
  if (prepared.support) for (const file of [prepared.support.index, ...prepared.support.originals]) await read(file);
  return { prepared, commands, files, derived };
}

export async function prepareCurrentReviewEvidence(input: unknown, io: Originals & {
  uploaded: (file: string) => Promise<unknown>;
}) {
  const { prepared, commands, files } = await currentEvidenceFiles(input, io);
  const records = new Map<string, EvidenceArtifact>();
  const landed = new Map<string, { scope: { parts: string[]; bytes: number; sha256: string }; refs: EvidenceManifest['artifacts'] }>();
  for (const [file, original] of files) {
    const upload = uploadResultSchema.parse(await io.uploaded(file)), bytes = Buffer.from(original, 'utf8');
    if (upload.bytes !== bytes.length || upload.sha256 !== digest(original)) throw new Error(`evidence preparation: upload original bytes/hash ${file}`);
    let offset = 0;
    const refs: EvidenceManifest['artifacts'] = [];
    for (const part of upload.parts) {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + part.size));
      if (digest(raw) !== part.sha256 || records.has(part.id)) throw new Error('evidence preparation: upload part hash or reused identity');
      records.set(part.id, { ...part, content: raw }); offset += part.size;
      refs.push({ id: part.id, kind: 'raw', sender: part.sender, producer: prepared.producer, bytes: part.size, sha256: part.sha256 });
    }
    if (offset !== bytes.length) throw new Error('evidence preparation: upload ordered part sizes mismatch');
    landed.set(file, { scope: { parts: upload.parts.map(part => part.id), bytes: upload.bytes, sha256: upload.sha256 }, refs });
  }
  const artifacts: EvidenceManifest['artifacts'] = [];
  const add = (file: string, kind: EvidenceManifest['artifacts'][number]['kind']) => {
    const upload = landed.get(file);
    if (!upload) throw new Error(`evidence preparation: missing original ${file}`);
    if (kind !== 'raw' && upload.refs.length !== 1) throw new Error(`evidence preparation: ${kind} record requires one artifact`);
    for (const ref of upload.refs) if (!artifacts.some(existing => existing.id === ref.id)) artifacts.push({ ...ref, kind });
    return upload.scope;
  };
  const currentCommands = commands.map(({ receipt, selected }) => ({
    command: receipt.command, exit: receipt.exit, direct: receipt.direct, complete: receipt.complete, tree: receipt.tree,
    dirty: receipt.dirty, by: receipt.by, timestamp: receipt.timestamp, kind: selected.kind,
    stdout: add(receipt.stdout.file, 'raw'), stderr: add(receipt.stderr.file, 'raw'), receipt: add(selected.receipt, 'receipt').parts[0]!,
    ...(selected.finalization ? { finalization: { receipt: landed.get(selected.finalization.receipt)?.scope.parts[0],
      admission: add(selected.finalization.admission, 'raw') } } : {}),
  }));
  for (const file of prepared.inventoryRaw ?? []) add(file, 'raw');
  add(prepared.inventories.base, 'inventory-base'); add(prepared.inventories.source, 'inventory-source');
  add(path.join(prepared.derived, 'gate.txt'), 'gate'); add(path.join(prepared.derived, 'handover.txt'), 'handover');
  const support = prepared.support && { index: landed.get(prepared.support.index)!.scope,
    artifacts: landed.get(prepared.support.index)!.refs.map(({ kind, ...ref }) => ({ ...ref, source: prepared.source, base: prepared.base })),
    required: prepared.support.required };
  return validateReviewEvidence({ version: 1, source: prepared.source, base: prepared.base, producer: prepared.producer, relayer: prepared.relayer,
    dirty: false, requiredGates: prepared.requiredGates, artifacts, commands: currentCommands, checks: prepared.checks,
    ...(support ? { support } : {}) }, prepared, async id => {
    const record = records.get(id);
    if (!record) throw new Error(`evidence preparation: required uploaded original missing ${id}`);
    return record;
  });
}
