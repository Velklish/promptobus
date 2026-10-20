import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordBbDirectCommand } from 'promptobus/bb-host';

export async function recordMain(argv: string[]) {
  if (argv.indexOf('--') !== 4 || argv[0] !== '--output' || argv[2] !== '--by' || !argv[1] || !argv[3] || !argv[5]) {
    throw new Error('usage: record-command --output <absolute-stem> --by <actor> -- <executable> [args]');
  }
  return recordBbDirectCommand({ command: argv.slice(5), stem: argv[1], by: argv[3] });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await recordMain(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result.receipt) + '\n'); process.exitCode = result.exitCode;
  } catch (error) {
    const receipt = (error as { receipt?: object }).receipt;
    process.stderr.write(JSON.stringify(receipt ?? { notRun: true, complete: false, error: String(error) }) + '\n'); process.exitCode = 1;
  }
}
