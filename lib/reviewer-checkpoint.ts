import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { GateError, holdsSession, ORCHESTRATOR } from '../dist/index.js';
import type { Engine, ParticipantV1 } from '../dist/index.js';
import { RECORD_ID_RE } from '../dist/v1/model.js';

export const CHECKPOINT_MARK = 'Reviewer finding checkpoint\n';
export const CHECKPOINT_NAME = 'review-findings.txt';
const SCHEMA = 'promptobus/reviewer-checkpoint@1';
const MAX_BYTES = 1_000_000;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function refuse(reason: string): never { throw new GateError('reviewer checkpoint: ' + reason); }
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export type Subject = Record<'assignmentAfterId' | 'head' | 'base' | 'diffSha256', string>;
function validSubject(subject: unknown): subject is Subject {
  return shape(subject, ['assignmentAfterId', 'head', 'base', 'diffSha256'])
    && typeof subject.assignmentAfterId === 'string' && RECORD_ID_RE.test(subject.assignmentAfterId)
    && [subject.head, subject.base].every(value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value))
    && typeof subject.diffSha256 === 'string' && /^[a-f0-9]{64}$/.test(subject.diffSha256);
}
function currentSubject({ metadata: m }: ParticipantV1) {
  return { assignmentAfterId: m.assignmentAfterId, head: m.diffHead, base: m.diffBase, diffSha256: m.diffSha256 };
}
export function prepareCheckpoint(task: string, producer: ParticipantV1, session: string | null, input: unknown) {
  if (!session || !holdsSession(producer, session) || producer.metadata.nativeStop || producer.metadata.nativeUnlaunched)
    refuse('current reviewer session required');
  if (!shape(input, ['content', 'subject']) || typeof input.content !== 'string' || !input.content.trim()) refuse('invalid inline report');
  const subject = input.subject;
  if (!validSubject(subject) || !isDeepStrictEqual(subject, currentSubject(producer))) refuse('stale or invalid assignment/subject');
  const reportBytes = Buffer.byteLength(input.content);
  if (reportBytes > MAX_BYTES) refuse('report exceeds 1000000 UTF-8 bytes');
  return { schema: SCHEMA, task, participant: producer.id, session, subject, report: input.content, reportBytes, reportSha256: digest(input.content) };
}
export interface Reference {
  messageId: string; artifactId: string; filename: string; sha256: string; size: number; session: string; subject: Subject;
}
function* reportLines(report: string) {
  for (const [chunk] of report.matchAll(/[\s\S]{1,256}/gu)) yield JSON.stringify(chunk);
}
function writeReportPage(file: string, header: object, lines: string[]) {
  writeFileSync(file, [JSON.stringify(header), ...lines].join('\n') + '\n', { flag: 'wx', mode: 0o400 });
}
export function writeRecoveryReports(diffPath: string, reports: readonly (Reference & { report: string })[], result: string | null) {
  if (result !== null) {
    const chunks = reportLines(result);
    let next = chunks.next(), page = 1;
    do {
      const lines: string[] = [];
      while (!next.done && lines.length < 256) { lines.push(next.value); next = chunks.next(); }
      writeReportPage(`${diffPath}.result-${page}.jsonl`, { type: 'result', nextPage: next.done ? null : page + 1 }, lines);
      page++;
    } while (!next.done);
  }
  if (!reports.length) return;
  const directory = `${diffPath}.checkpoints`;
  mkdirSync(directory, { mode: 0o700 });
  reports.forEach(({ report, ...reference }, index) => {
    writeReportPage(path.join(directory, `${index + 1}.jsonl`), reference, [...reportLines(report)]);
  });
}
function reference(value: unknown): value is Reference {
  return shape(value, ['messageId', 'artifactId', 'filename', 'sha256', 'size', 'session', 'subject'])
    && typeof value.messageId === 'string' && RECORD_ID_RE.test(value.messageId)
    && typeof value.artifactId === 'string' && RECORD_ID_RE.test(value.artifactId)
    && typeof value.filename === 'string' && typeof value.sha256 === 'string' && typeof value.size === 'number'
    && typeof value.session === 'string' && !!value.session.trim() && validSubject(value.subject);
}
function checkpointReferences(participant: ParticipantV1): Reference[] {
  const refs = participant.metadata.findingCheckpoints;
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || !refs.every(reference)) refuse('invalid checkpoint references');
  return refs;
}
export function readReviewerCheckpoints(engine: Engine, task: string, participant: ParticipantV1) {
  const stored = checkpointReferences(participant);
  const refs = new Map(stored.map(ref => [ref.messageId, ref]));
  const messages = engine.facts(task).messages.filter(m => m.sender === participant.id && m.type === 'artifact' && m.body.startsWith(CHECKPOINT_MARK));
  if (refs.size !== stored.length || messages.length !== refs.size) refuse('incomplete or duplicate checkpoint references');
  return messages.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(m => {
    const ref = refs.get(m.id);
    if (!ref || m.task !== task || m.recipients.length !== 1 || m.recipients[0] !== ORCHESTRATOR
      || m.artifact !== ref.artifactId || m.id <= ref.subject.assignmentAfterId) refuse('message/artifact linkage mismatch');
    const current = currentSubject(participant);
    const retired = participant.metadata.retiredCheckpointBinding as Record<string, unknown> | undefined;
    const retiredProducer = retired && retired.assignmentAfterId === ref.subject.assignmentAfterId
      && typeof retired.through === 'string' && m.id <= retired.through && holdsSession({ metadata: retired }, ref.session);
    if (typeof current.assignmentAfterId === 'string' && m.id > current.assignmentAfterId
      && ((!holdsSession(participant, ref.session) && !retiredProducer) || !isDeepStrictEqual(current, ref.subject))) refuse('stale producer/subject reference');
    const artifact = engine.readArtifact(task, ref.artifactId);
    if (artifact.filename !== ref.filename || artifact.sha256 !== ref.sha256 || artifact.size !== ref.size) refuse('artifact metadata mismatch');
    const envelope: unknown = JSON.parse(engine.readArtifactContent(task, artifact.id).toString('utf8'));
    if (!shape(envelope, ['schema', 'task', 'participant', 'session', 'subject', 'report', 'reportBytes', 'reportSha256'])
      || envelope.schema !== SCHEMA || envelope.task !== task || envelope.participant !== participant.id
      || envelope.session !== ref.session || !isDeepStrictEqual(envelope.subject, ref.subject)
      || typeof envelope.report !== 'string' || !envelope.report.trim() || Buffer.byteLength(envelope.report) !== envelope.reportBytes
      || typeof envelope.reportBytes !== 'number' || envelope.reportBytes > MAX_BYTES || digest(envelope.report) !== envelope.reportSha256) refuse('provenance/report mismatch');
    return { ...ref, report: envelope.report };
  });
}
