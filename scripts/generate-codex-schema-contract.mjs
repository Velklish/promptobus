import path from 'node:path';
import { readCapture, writeConsumedContract } from './codex-schema-contract.mjs';

const [source, destination, version, mode] = process.argv.slice(2);
if (!source || !destination || !version || (mode && mode !== '--historical')) {
  process.stderr.write('usage: node scripts/generate-codex-schema-contract.mjs SOURCE DIRECTORY VERSION [--historical]\n');
  process.exitCode = 2;
} else {
  const contract = writeConsumedContract(readCapture(path.resolve(source), { allowEvidence: mode === '--historical' }),
    path.resolve(destination), version);
  process.stdout.write(`wrote ${contract.size} consumed schemas for Codex ${version}\n`);
}
