import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { openEngine } from 'promptobus';
import { renderBbInstructionSkill, BB_ROLE_SKILLS } from 'promptobus/instructions';

export const sha256 = content => createHash('sha256').update(content).digest('hex');
export function launchFixture(task, actor, role, root, branch = 'main', base = 'a'.repeat(40)) {
  const grant = { actor, task, token: `fixture-${actor}`, state: 'active', phase: 'initial',
    scope: { repository: root, branch, base, operations: ['fixture bounded reads'] }, preconditions: ['fixture owner confirmed'] };
  return { ownedRoots: [root], readRoots: [root], role: { name: BB_ROLE_SKILLS[role], literal: renderBbInstructionSkill(role) }, grant,
    control: { mode: 'inline', snapshot: { ownerConfirmed: true, STOP: false, noNewStages: false, grant, endedTokens: [] }, signals: ['Hold', 'Stop'] },
    preparation: { commands: [], status: 'notRun', reason: 'Fixture has no dependency preparation.' },
    quota: { authority: 'owner', missingUsage: 'informational', soft: 39, hard: 40, maxActiveIncludingOwner: 5, PAYG: false } };
}

export async function evidenceFixture(root, task, source = 'a'.repeat(40), base = 'a'.repeat(40), producer = 'orchestrator', sender = 'orchestrator', { exit = 0, gateNotRun = false } = {}) {
  const engine = openEngine({ root, recover: false, policy: () => ({ allow: true }) });
  const artifacts = [];
  const records = new Map();
  const land = async (kind, value) => {
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    const sent = await engine.send(task, { from: sender, to: ['orchestrator'], type: 'artifact', body: 'Fictional original evidence fixture.',
      artifact: { filename: `fixture-${kind}-${artifacts.length}.txt`, stream: Readable.from([Buffer.from(content)]) } });
    const artifact = sent.artifact;
    artifacts.push({ id: artifact.id, kind, sender, producer, bytes: Buffer.byteLength(content), sha256: sha256(content) });
    records.set(artifact.id, { ...artifact, sender, content });
    return { parts: [artifact.id], bytes: Buffer.byteLength(content), sha256: sha256(content) };
  };
  const stdout = await land('raw', 'Complete original stdout fixture\n');
  const stderr = await land('raw', '');
  const commands = [{ command: ['fiction', gateNotRun ? 'diagnostic' : 'gate'], exit, direct: true, complete: true, tree: source, dirty: false,
    by: producer, timestamp: '2026-10-13T00:00:00.000Z', kind: gateNotRun ? 'verification' : 'gate', stdout, stderr }];
  const receipt = await land('receipt', { ...commands[0], format: 'bb-direct-command-v1', signal: null, error: null });
  commands[0].receipt = receipt.parts[0];
  const checks = Object.fromEntries(['verdictNames', 'mutationProbe', 'treeState', 'environmentalRed', 'gatesNotRun']
    .map(name => [name, { status: 'notRun', reason: 'Fictional transport fixture; no real gate or probe was run.' }]));
  if (gateNotRun) checks.gatesNotRun = { status: 'complete', detail: { gates: [{ command: ['fiction', 'gate'], reason: 'Required fictional gate was not run.' }] } };
  await land('gate', { tree: source, by: producer, dirty: false, gates: gateNotRun ? 0 : 1, green: !gateNotRun && exit === 0 ? 1 : 0 });
  await land('handover', { source, base, by: producer, checks });
  await land('inventory-base', { tree: base, by: producer, status: 'notMeasured', reason: 'No supported test scope in this fixture.' });
  await land('inventory-source', { tree: source, by: producer, status: 'notMeasured', reason: 'No supported test scope in this fixture.' });
  return { manifest: { version: 1, source, base, producer, relayer: sender, dirty: false,
    requiredGates: [['fiction', 'gate']], artifacts, commands, checks }, records, land };
}
