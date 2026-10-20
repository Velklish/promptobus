import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { currentEvidenceFiles, prepareCurrentReviewEvidence } from './evidence-builder.js';

export async function evidenceMain(argv: string[]) {
  if (argv.length !== 4 || argv[0] !== '--input' || !path.isAbsolute(argv[1] ?? '')
    || !['--stage', '--uploads'].includes(argv[2] ?? '') || !path.isAbsolute(argv[3] ?? '')) {
    throw new Error('usage: evidence-prepare --input <absolute-input.json> --stage <absolute-directory> | --uploads <absolute-results.json>');
  }
  const input = JSON.parse(readFileSync(argv[1]!, 'utf8'));
  const io = { readOriginal: async (file: string) => new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)) };
  if (argv[2] === '--stage') {
    if (input.derived !== argv[3]) throw new Error('stage directory must equal the explicit derived directory');
    const { files, derived } = await currentEvidenceFiles(input, io);
    mkdirSync(argv[3]!, { recursive: true });
    for (const [file, raw] of derived) writeFileSync(file, raw, { flag: 'wx' });
    const plan = { files: [...files.keys()] };
    writeFileSync(path.join(argv[3]!, 'upload-plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
    return plan;
  }
  const uploads = JSON.parse(readFileSync(argv[3]!, 'utf8')) as Record<string, unknown>;
  return prepareCurrentReviewEvidence(input, { ...io, uploaded: async file => {
    if (!Object.hasOwn(uploads, file)) throw new Error(`missing actual upload result for ${file}`);
    return uploads[file];
  } });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(JSON.stringify(await evidenceMain(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
