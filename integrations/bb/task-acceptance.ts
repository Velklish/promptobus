import { z } from 'zod';
import { evidenceManifestSchema, digest } from './review-evidence.js';
import type { Binding } from './protocol.js';

const text = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const reviewDecisionSchema = z.object({
  format: z.literal('bb-review-decision-v1'), task: text, reviewer: text, assignmentAfterId: text,
  source: sha, base: sha, producer: text, evidenceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['pass', 'changes-required']),
  findings: z.object({ critical: z.number().int().nonnegative(), major: z.number().int().nonnegative() }).strict(),
}).strict();

export function parseReviewDecision(body: string) {
  const lines = body.split('\n').filter(line => line.startsWith('Acceptance decision:'));
  if (body.length > 2400 || lines.length !== 1 || !lines[0]!.startsWith('Acceptance decision: ')) {
    throw new Error('Logical acceptance requires exactly one standalone Acceptance decision line within the bounded result');
  }
  try { return reviewDecisionSchema.parse(JSON.parse(lines[0]!.slice('Acceptance decision: '.length))); }
  catch { throw new Error('Logical acceptance requires a strict bb-review-decision-v1 decision line'); }
}

export function reviewEvidenceIdentity(binding: Binding) {
  if (binding.role !== 'reviewer' || !binding.launchContext?.review || !binding.evidenceManifest) return undefined;
  const manifest = evidenceManifestSchema.parse(binding.evidenceManifest);
  return { source: manifest.source, base: manifest.base, producer: manifest.producer,
    sourceEnvironmentId: binding.launchContext.review.sourceEnvironmentId,
    evidenceManifestSha256: digest(JSON.stringify(manifest)) };
}
