import { recordBbDirectCommand } from '../lib/bb-direct-command.js';

const argv = process.argv.slice(2), separator = argv.indexOf('--');
if (separator !== 4 || argv[0] !== '--output' || argv[2] !== '--by' || !argv[1] || !argv[3] || !argv[5]) {
  throw new Error('usage: node scripts/bb-record-command.mjs --output <absolute-stem> --by <actor> -- <executable> [args]');
}
const command = argv.slice(5), by = argv[3];
try {
  const result = await recordBbDirectCommand({ command, stem: argv[1], by });
  process.stdout.write(`${JSON.stringify(result.receipt)}\n`);
  process.exitCode = result.exitCode;
} catch (failure) {
  process.stderr.write(`${JSON.stringify(failure.receipt ?? { command, by, notRun: true, complete: false, error: failure.message })}\n`);
  process.exitCode = 1;
}
