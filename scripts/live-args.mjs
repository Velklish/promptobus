// Argv of a live script, read before anything is raised: `--help` and a wrong flag must not
// start a paid run. No side effects here, so the suite can call it.
import { writeSync } from 'node:fs';
import process from 'node:process';

export function parseLiveArgs(argv, flags = {}) {
  const values = {};
  const errors = [];
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      help = true;
      continue;
    }
    const flag = flags[arg];
    if (!flag) {
      errors.push(`unknown argument "${arg}"`);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      errors.push(`flag ${arg} needs a value`);
      continue;
    }
    values[flag.key] = value;
    i += 1;
  }
  return { help, values, errors, known: Object.keys(flags) };
}

export function liveHelpText({ usage, purpose, price, flags = {} }) {
  return [
    `Purpose: ${purpose}`,
    `Usage: node ${usage}`,
    `Price of a run: ${price}`,
    'Flags:',
    '  --help  this help; starts nothing',
    ...Object.entries(flags).map(([name, flag]) => `  ${flag.display ?? name}  ${flag.description}`),
  ].join('\n');
}

/** The parsed values, or the process ends here: 1 with the known flags on an error, 0 after `--help`.
 *  `writeSync`: a pipe on macOS is asynchronous, and `exit` would drop the line. */
export function finishLiveArgs(parsed, spec) {
  if (parsed.errors.length) {
    writeSync(2, `✖ ${parsed.errors.join('; ')}. Known flags: ${['--help', ...parsed.known].join(', ')}\n`);
    process.exit(1);
  }
  if (parsed.help) {
    writeSync(1, `${liveHelpText(spec)}\n`);
    process.exit(0);
  }
  return parsed.values;
}
