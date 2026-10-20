import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import { assertBbDirectCommand, extractNodeTestVerdictNames } from 'promptobus/bb-host';
import { buildIdentitySchema } from './build-identity.js';

const text = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const rawSchema = z.object({ parts: z.array(text).min(1), bytes: z.number().int().nonnegative(), sha256: hash }).strict();
const artifactIdentity = { id: text, sender: text, producer: text, bytes: z.number().int().nonnegative(), sha256: hash };
export const historicalArtifactSchema = z.object({ ...artifactIdentity, source: sha, base: sha }).strict();
export const supportSchema = z.object({ artifacts: z.array(historicalArtifactSchema).min(1), index: rawSchema,
  required: z.array(z.object({ id: text, reason: text.refine(value => Boolean(value.trim()), 'required history needs an explicit reason') }).strict()) }).strict();
export const supportIndexSchema = z.object({ version: z.literal(1), artifacts: z.array(historicalArtifactSchema),
  entries: z.array(z.object({ id: text, kind: z.enum(['finding', 'context', 'raw', 'receipt']), source: sha, base: sha, producer: text,
    raw: rawSchema, streams: z.object({ stdout: rawSchema, stderr: rawSchema }).strict().optional(),
  }).strict().refine(entry => entry.kind !== 'receipt' || entry.streams !== undefined, 'historical receipts require original stdout/stderr')),
}).strict();
export const evidenceCommandSchema = z.object({
  command: z.array(text).min(1), exit: z.number().int(), direct: z.literal(true), complete: z.literal(true),
  tree: sha, dirty: z.literal(false), by: text, timestamp: text, kind: z.enum(['gate', 'verification']),
  stdout: rawSchema, stderr: rawSchema,
  receipt: text,
  finalization: z.object({ receipt: text, admission: rawSchema }).strict().optional(),
}).strict();
export const handoverChecks = ['verdictNames', 'mutationProbe', 'treeState', 'environmentalRed', 'gatesNotRun'] as const;
const check = z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), detail: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ status: z.literal('notRun'), reason: text }).strict(),
]);
export const evidenceManifestSchema = z.object({
  version: z.literal(1), source: sha, base: sha, producer: text, relayer: text, dirty: z.literal(false),
  requiredGates: z.array(z.array(text).min(1)).min(1),
  artifacts: z.array(z.object({
    id: text, kind: z.enum(['gate', 'handover', 'receipt', 'inventory-base', 'inventory-source', 'raw']),
    sender: text, producer: text, bytes: z.number().int().nonnegative(), sha256: hash,
  }).strict()).min(1),
  commands: z.array(evidenceCommandSchema).min(1),
  checks: z.object(Object.fromEntries(handoverChecks.map(name => [name, check])) as Record<typeof handoverChecks[number], typeof check>).strict(),
  support: supportSchema.optional(),
}).strict();
export type EvidenceManifest = z.infer<typeof evidenceManifestSchema>;
export type EvidenceArtifact = { id: string; filename: string; size: number; sha256: string; sender: string; content: string };
export const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export async function validateReviewEvidence(input: unknown, expected: { source: string; base: string; producer: string; requiredGates: string[][]; requirePassingGates: boolean },
  read: (id: string) => Promise<EvidenceArtifact>) {
  if (input === undefined) throw new Error('review evidence manifest is required before reviewer start');
  const parsed = evidenceManifestSchema.safeParse(input);
  if (!parsed.success) throw new Error(`review evidence manifest: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const manifest = parsed.data;
  if (!isDeepStrictEqual(manifest.requiredGates, expected.requiredGates)) throw new Error('review evidence manifest: assigned required gate scope mismatch');
  for (const field of ['source', 'base', 'producer'] as const) {
    if (manifest[field] !== expected[field]) throw new Error(`review evidence manifest: ${field} mismatch`);
  }
  const records = new Map<string, EvidenceArtifact>();
  for (const ref of manifest.artifacts) {
    if (records.has(ref.id)) throw new Error(`review evidence manifest: duplicate artifact ${ref.id}`);
    const artifact = await read(ref.id);
    if (artifact.id !== ref.id || !artifact.filename.endsWith('.txt')) throw new Error(`review evidence manifest: artifact identity ${ref.id}`);
    if (artifact.sender !== ref.sender || ref.producer !== manifest.producer
      || ![manifest.producer, manifest.relayer].includes(ref.sender)) throw new Error(`review evidence manifest: producer/sender ${ref.id}`);
    if (artifact.size !== ref.bytes || Buffer.byteLength(artifact.content) !== ref.bytes
      || digest(artifact.content) !== ref.sha256 || artifact.sha256 !== ref.sha256) throw new Error(`review evidence manifest: bytes/hash ${ref.id}`);
    records.set(ref.id, artifact);
  }
  const one = (kind: EvidenceManifest['artifacts'][number]['kind']) => {
    const refs = manifest.artifacts.filter(ref => ref.kind === kind);
    if (refs.length !== 1) throw new Error(`review evidence manifest: exactly one ${kind} artifact required`);
    return JSON.parse(records.get(refs[0]!.id)!.content) as Record<string, unknown>;
  };
  const receiptIds = new Set<string>();
  const receipts = new Map<string, ReturnType<typeof JSON.parse>>();
  for (const command of manifest.commands) {
    const ref = manifest.artifacts.find(ref => ref.id === command.receipt && ref.kind === 'receipt');
    if (!ref || receiptIds.has(ref.id)) throw new Error('review evidence manifest: original command receipt missing or reused');
    receiptIds.add(ref.id);
    const receipt = JSON.parse(records.get(ref.id)!.content);
    if (receipt.format !== 'bb-direct-command-v1' || receipt.direct !== true || receipt.complete !== true
      || receipt.signal !== null || receipt.error !== null || receipt.notRun === true
      || receipt.finalizationComplete === false || receipt.finalizationError) throw new Error('review evidence manifest: incomplete or pipe-masked collector receipt');
    receipts.set(ref.id, receipt);
    for (const field of ['command', 'exit', 'tree', 'dirty', 'by', 'timestamp'] as const) {
      if (!isDeepStrictEqual(receipt[field], command[field])) throw new Error(`review evidence manifest: original direct receipt ${field} mismatch`);
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      if (receipt[stream]?.bytes !== command[stream].bytes || receipt[stream]?.sha256 !== command[stream].sha256) throw new Error(`review evidence manifest: original receipt ${stream} bytes/hash mismatch`);
    }
    assertBbDirectCommand(command.command);
  }
  if (manifest.artifacts.some(ref => ref.kind === 'receipt' && !receiptIds.has(ref.id))) throw new Error('review evidence manifest: unscoped original receipt');
  const handover = one('handover');
  if (handover.source !== manifest.source || handover.base !== manifest.base || handover.by !== manifest.producer
    || !isDeepStrictEqual(handover.checks, manifest.checks)) throw new Error('review evidence manifest: handover tree/producer/all five checks mismatch');
  const probe = manifest.checks.mutationProbe;
  if (probe.status === 'complete') {
    const detail = z.object({ tree: sha, treeLag: text.optional(), mutated: text.regex(/^[^\n:]+:[0-9]+$/), applied: z.literal(true),
      mutatedRunExit: z.number().int().min(1).max(127), verdicts: z.object({ baseTotal: z.number().int().positive(),
        passed: z.number().int().nonnegative(), unaccounted: z.literal(0) }).strict(),
      expected: z.array(text).min(1), reddened: z.array(text).min(1) }).strict().parse(probe.detail);
    const remaining = [...detail.reddened];
    for (const name of detail.expected) {
      const at = remaining.indexOf(name);
      if (at < 0) throw new Error('review evidence manifest: mutation probe missed an expected verdict');
      remaining.splice(at, 1);
    }
    if (detail.verdicts.baseTotal !== detail.verdicts.passed + detail.reddened.length
      || (detail.tree !== manifest.source && !detail.treeLag)) throw new Error('review evidence manifest: mutation probe incomplete total or unexplained SHA');
  }
  const state = manifest.checks.treeState;
  if (state.status === 'complete') z.object({ beforeProbe: z.literal(''), afterRestore: z.literal('') }).strict().parse(state.detail);
  const reds = manifest.checks.environmentalRed;
  if (reds.status === 'complete') z.object({ claims: z.array(z.object({ name: text, assertion: text,
    isolated: z.tuple([z.object({ command: z.array(text).min(1), exit: z.number().int().min(1) }).strict(),
      z.object({ command: z.array(text).min(1), exit: z.number().int().min(1) }).strict()]),
    onBase: z.object({ command: z.array(text).min(1), exit: z.number().int().min(1), red: z.literal(true) }).strict(),
    failures: z.object({ branchOnly: z.array(text).length(0), baseOnly: z.array(text) }).strict() }).strict()) }).strict().parse(reds.detail);
  const rawContent = (input: unknown, label: string) => {
    const scope = rawSchema.parse(input);
    let content = '';
    for (const id of scope.parts) {
      const ref = manifest.artifacts.find(ref => ref.id === id && ref.kind === 'raw');
      if (!ref) throw new Error(`review evidence manifest: missing raw part ${id}`);
      content += records.get(id)!.content;
    }
    if (Buffer.byteLength(content) !== scope.bytes || digest(content) !== scope.sha256) throw new Error(`review evidence manifest: truncated ${label} or wrong ordered raw hash`);
    return content;
  };
  const finalizationRaw = new Set<string>(), terminalReceipts = new Set<string>();
  for (const command of manifest.commands) {
    const receipt = receipts.get(command.receipt)!;
    if (receipt.admission === undefined && command.finalization === undefined) continue;
    const finalization = command.finalization;
    if (!receipt.admission || !finalization) throw new Error('review evidence manifest: admitted command requires original terminal launcher proof');
    const outer = manifest.commands.find(candidate => candidate.receipt === finalization.receipt);
    if (!outer || outer === command || outer.kind !== 'verification' || terminalReceipts.has(outer.receipt)
      || receipts.get(outer.receipt)!.admission !== undefined) throw new Error('review evidence manifest: terminal launcher must be a distinct original verification command');
    terminalReceipts.add(outer.receipt);
    const [{ bindingSchema }, { commandDigest }] = await Promise.all([import('./protocol.js'), import('./control.js')]);
    const admission = z.object({ binding: bindingSchema, commandId: text }).strict().parse(JSON.parse(rawContent(finalization.admission, 'admission')));
    for (const id of finalization.admission.parts) finalizationRaw.add(id);
    const grant = admission.binding.launchContext?.grant;
    const executed = grant?.execution?.commands.find(candidate => candidate.id === admission.commandId);
    const argv = outer.command;
    if (!grant || !executed || !path.isAbsolute(argv[1] ?? '') || path.basename(argv[1]!) !== 'command-runner.js'
      || !/^node(?:\.exe)?$/.test(path.basename(argv[0]!)) || argv[2] !== '--admission' || !path.isAbsolute(argv[3] ?? '')
      || !isDeepStrictEqual(argv.slice(4), ['--output', executed.output, '--by', grant.actor, '--', ...executed.argv])
      || !isDeepStrictEqual(executed.argv, command.command) || executed.cwd !== receipt.cwd
      || receipt.stdout.file !== `${executed.output}.stdout.txt` || receipt.stderr.file !== `${executed.output}.stderr.txt`
      || grant.actor !== command.by || outer.by !== command.by || outer.tree !== command.tree
      || receipts.get(outer.receipt)!.cwd !== executed.cwd || outer.exit !== command.exit
      || admission.binding.task !== grant.task || admission.binding.participant !== grant.actor
      || admission.binding.environmentPath !== grant.scope.repository || admission.binding.baseSha !== manifest.base
      || !isDeepStrictEqual(receipt.admission, { task: grant.task, token: grant.token, phase: grant.phase,
        commandId: executed.id, commandSha256: commandDigest(executed) })) {
      throw new Error('review evidence manifest: terminal launcher invocation/actor/source/output/admission mismatch');
    }
    z.object({ buildIdentity: buildIdentitySchema.nullable(), sha256: hash }).strict().parse(receipt.launcher);
    const terminal = JSON.parse(rawContent(outer.stdout, 'terminal launcher stdout'));
    if (!isDeepStrictEqual(terminal, receipt) || terminal.finalizationComplete === false || terminal.finalizationError) {
      throw new Error('review evidence manifest: terminal launcher frame differs from original inner receipt or finalization failed');
    }
  }
  const inventories = new Map<string, string[]>();
  const inventoryRaw = new Set<string>();
  for (const kind of ['inventory-base', 'inventory-source'] as const) {
    const inventory = one(kind);
    const tree = kind === 'inventory-base' ? manifest.base : manifest.source;
    if (inventory.tree !== tree || inventory.by !== manifest.producer) throw new Error(`review evidence manifest: ${kind} tree/producer mismatch`);
    if (inventory.status === 'notMeasured' && typeof inventory.reason === 'string' && inventory.reason.trim()) {
      if (inventory.raw !== undefined) {
        rawContent(inventory.raw, kind);
        for (const id of rawSchema.parse(inventory.raw).parts) inventoryRaw.add(id);
      }
      continue;
    }
    if (inventory.status !== 'complete' || inventory.format !== 'node-spec-flat') throw new Error(`review evidence manifest: ${kind} unsupported inventory certification; retain authoritative complete scope and declare notMeasured`);
    const raw = rawContent(inventory.raw, kind);
    const extracted = extractNodeTestVerdictNames(raw);
    if (!extracted.complete || !isDeepStrictEqual(inventory.names, extracted.names)) throw new Error(`review evidence manifest: ${kind} incomplete raw inventory: ${extracted.reason ?? 'verdict occurrences mismatch'}`);
    inventories.set(kind, extracted.names);
    for (const id of rawSchema.parse(inventory.raw).parts) inventoryRaw.add(id);
  }
  const usedRaw = new Set<string>();
  for (const command of manifest.commands) {
    if (command.tree !== manifest.source || command.by !== manifest.producer) throw new Error('review evidence manifest: command tree/producer mismatch');
    for (const stream of ['stdout', 'stderr'] as const) {
      const scope = command[stream];
      for (const id of scope.parts) {
        const ref = manifest.artifacts.find(ref => ref.id === id && ref.kind === 'raw');
        if (!ref || usedRaw.has(id)) throw new Error(`review evidence manifest: missing/reused raw part ${id}`);
        usedRaw.add(id);
      }
      rawContent(scope, stream);
    }
  }
  if (manifest.artifacts.some(ref => ref.kind === 'raw' && !usedRaw.has(ref.id) && !inventoryRaw.has(ref.id) && !finalizationRaw.has(ref.id))) throw new Error('review evidence manifest: unscoped raw part');
  if (manifest.checks.verdictNames.status === 'complete') {
    if (inventories.size !== 2) throw new Error('review evidence manifest: verdictNames complete requires both complete supported inventories');
    const remaining = [...inventories.get('inventory-source')!];
    const removed = inventories.get('inventory-base')!.filter(name => {
      const at = remaining.indexOf(name);
      if (at < 0) return true;
      remaining.splice(at, 1); return false;
    });
    const declared = manifest.checks.verdictNames.detail.removed;
    if (!Array.isArray(declared) || !isDeepStrictEqual(declared.map(row => row.name), removed)
      || declared.some(row => typeof row.reason !== 'string' || !row.reason.trim())) throw new Error('review evidence manifest: removed verdict multiplicities/reasons mismatch');
  }
  const latest = new Map(manifest.commands.filter(c => c.kind === 'gate').map(c => [JSON.stringify(c.command), c]));
  const required = manifest.requiredGates.map(c => JSON.stringify(c));
  const notRun = manifest.checks.gatesNotRun;
  const omitted = notRun.status === 'complete' ? z.array(z.object({ command: z.array(text).min(1), reason: text }).strict()).parse(notRun.detail.gates) : [];
  const accounted = [...latest.keys(), ...omitted.map(row => JSON.stringify(row.command))];
  if (new Set(required).size !== required.length || new Set(accounted).size !== accounted.length
    || accounted.length !== required.length || required.some(c => !accounted.includes(c))) {
    throw new Error('review evidence manifest: required gate scope mismatch');
  }
  const gates = one('gate');
  const green = [...latest.values()].filter(c => c.exit === 0).length;
  if (expected.requirePassingGates && green !== required.length) throw new Error('review evidence manifest: assigned mandatory gates are not all passing; no reviewer start');
  if (gates.tree !== manifest.source || gates.by !== manifest.producer || gates.dirty !== false
    || gates.gates !== latest.size || gates.green !== green) throw new Error('review evidence manifest: gate aggregate disagrees with direct exits/tree/producer');
  if (manifest.support) await validateSupport(manifest, read);
  return manifest;
}

async function validateSupport(manifest: EvidenceManifest, read: (id: string) => Promise<EvidenceArtifact>) {
  const support = manifest.support!;
  const unique = <T extends { id: string }>(refs: T[]) => {
    if (new Set(refs.map(ref => ref.id)).size !== refs.length) throw new Error('review evidence support: duplicate identity');
    return new Map(refs.map(ref => [ref.id, ref]));
  };
  const currentIds = new Set(manifest.artifacts.map(ref => ref.id));
  const indexRefs = unique(support.artifacts);
  const content = async (scope: z.infer<typeof rawSchema>, refs: Map<string, z.infer<typeof historicalArtifactSchema>>) => {
    let raw = '';
    if (new Set(scope.parts).size !== scope.parts.length) throw new Error('review evidence support: reused part');
    for (const id of scope.parts) {
      const ref = refs.get(id);
      if (!ref || currentIds.has(id)) throw new Error(`review evidence support: missing or current part ${id}`);
      const artifact = await read(id);
      if (artifact.id !== id || !artifact.filename.endsWith('.txt') || artifact.sender !== ref.sender
        || artifact.size !== ref.bytes || Buffer.byteLength(artifact.content) !== ref.bytes
        || artifact.sha256 !== ref.sha256 || digest(artifact.content) !== ref.sha256) throw new Error(`review evidence support: identity/sender/bytes/hash ${id}`);
      raw += artifact.content;
    }
    if (Buffer.byteLength(raw) !== scope.bytes || digest(raw) !== scope.sha256) throw new Error('review evidence support: wrong ordered bytes/hash');
    return raw;
  };
  if (support.index.parts.length !== indexRefs.size || support.artifacts.some(ref => ref.source !== manifest.source
    || ref.base !== manifest.base || ref.producer !== manifest.producer || ![manifest.producer, manifest.relayer].includes(ref.sender))) {
    throw new Error('review evidence support: index source/base/producer/scope mismatch');
  }
  const index = supportIndexSchema.parse(JSON.parse(await content(support.index, indexRefs)));
  const refs = unique(index.artifacts), entries = unique(index.entries);
  unique(support.required);
  for (const entry of index.entries) for (const scope of [entry.raw, ...Object.values(entry.streams ?? {})]) {
    for (const id of scope.parts) {
      const ref = refs.get(id);
      if (!ref || indexRefs.has(id) || currentIds.has(id) || ref.source !== entry.source || ref.base !== entry.base || ref.producer !== entry.producer) {
        throw new Error('review evidence support: entry metadata source/base/producer mismatch');
      }
    }
  }
  for (const selected of support.required) {
    const entry = entries.get(selected.id);
    if (!entry) throw new Error(`review evidence support: required historical entry missing ${selected.id}`);
    const original = await content(entry.raw, refs);
    for (const scope of Object.values(entry.streams ?? {})) await content(scope, refs);
    if (entry.kind === 'receipt') {
      const receipt = JSON.parse(original);
      if (receipt.format !== 'bb-direct-command-v1' || receipt.tree !== entry.source || receipt.by !== entry.producer) {
        throw new Error('review evidence support: historical receipt source/producer mismatch');
      }
      for (const stream of ['stdout', 'stderr'] as const) {
        const scope = entry.streams![stream];
        if (receipt[stream]?.bytes !== scope.bytes || receipt[stream]?.sha256 !== scope.sha256) throw new Error('review evidence support: historical receipt raw mismatch');
      }
    }
  }
}
