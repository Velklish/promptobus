#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPromptobus } from '../lib/cli.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const argv = process.argv.slice(2);
const binPath = fileURLToPath(import.meta.url);

function helpHost() {
  return {
    kind: 'promptobus-host',
    commandName: 'promptobus',
    version: pkg.version,
  };
}

function isHelpish(args) {
  const first = args[0];
  return first === undefined
    || first === 'help' || first === '--help' || first === '-h'
    || first === '--version' || first === '-v';
}

async function loadHost() {
  const { createStandaloneHost } = await import('../dist/host-index.js');
  return createStandaloneHost({
    cwd: process.cwd(),
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
});
if (typeof code === 'number' && code !== 0) process.exitCode = code;
