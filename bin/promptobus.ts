#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 26) {
  process.stderr.write(`Promptobus requires Node.js >=26; current runtime is ${process.versions.node}. No configuration was changed.\n`);
  process.exit(1);
}
const { runPromptobus } = await import('../lib/cli.js');

const pkg: { version: string } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);
const binPath = fileURLToPath(import.meta.url);

function helpHost() {
  return {
    kind: 'promptobus-host' as const,
    commandName: 'promptobus',
    version: pkg.version,
  };
}

function isHelpish(args: readonly string[]) {
  const first = args[0];
  return first === undefined
    || first === 'help' || first === '--help' || first === '-h'
    || first === '--version' || first === '-v';
}

async function loadHost(cwd = process.cwd()) {
  const { createStandaloneHost } = await import('../dist/host-index.js');
  return createStandaloneHost({
    cwd,
    commandName: 'promptobus',
    version: pkg.version,
    binPath,
    nodePath: process.execPath,
  });
}

const host = isHelpish(argv) ? helpHost() : await loadHost();
const code = await runPromptobus(argv, {
  host,
  cwd: process.cwd(),
  env: process.env,
  input: process.stdin,
  output: process.stdout,
  createHost: ({ cwd }) => loadHost(cwd),
});
if (typeof code === 'number' && code !== 0) process.exitCode = code;
