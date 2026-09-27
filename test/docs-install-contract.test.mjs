import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const version = JSON.parse(read('package.json')).version;

const install = read('docs/guides/install.md');
const english = read('README.md');
const russian = read('README.ru.md');
const snippet = (heading, language) => install.split(heading)[1]?.split('\n### ')[0]
  ?.match(new RegExp(`\x60\x60\x60${language}\\n([\\s\\S]*?)\\n\x60\x60\x60`))?.[1] ?? '';
const json = (value) => {
  try { return JSON.parse(value); } catch { return null; }
};
const release = `github:Velklish/promptobus#v${version}`;
check('PB-290 supported release source for local and global installation',
  [install, english, russian].every((doc) => doc.includes(`npm install ${release}`)
    && doc.includes(`npm install -g ${release}`)
    && !/^npm install promptobus\s*$/m.test(doc)),
  'All three installation surfaces must use the current GitHub tag for both forms');

const claudeMcp = json(snippet('### Claude Code:', 'json'));
const cursorMcp = json(snippet('### Cursor:', 'json'));
const codexMcp = snippet('### Codex:', 'toml');
const home = '/absolute/path/to/workspace/.promptobus';
check('PB-291 orchestrator MCP setup names three project formats',
  install.includes('`.mcp.json`')
    && install.includes('`.cursor/mcp.json`')
    && install.includes('`.codex/config.toml`')
    && claudeMcp?.mcpServers?.promptobus?.env?.PROMPTOBUS_HOME === home
    && cursorMcp?.mcpServers?.promptobus?.env?.PROMPTOBUS_HOME === home
    && /^\[mcp_servers\.promptobus\]$/m.test(codexMcp)
    && /^\[mcp_servers\.promptobus\.env\]$/m.test(codexMcp)
    && codexMcp.includes(`PROMPTOBUS_HOME = "${home}"`)
    && install.includes('claude mcp list')
    && install.includes('cursor-agent mcp list-tools promptobus')
    && install.includes('codex mcp list')
    && install.includes('PROMPTOBUS_HOME')
    && english.includes('Register the orchestrator\'s stdio server separately in the project file for its harness: Claude Code `.mcp.json`, Cursor `.cursor/mcp.json`, or Codex `.codex/config.toml`.')
    && russian.includes('регистрируют отдельно в project-файле его инструмента: `.mcp.json` для Claude Code, `.cursor/mcp.json` для Cursor, `.codex/config.toml` для Codex.')
    && !english.includes('harness\'s project MCP file:')
    && !russian.includes('project-файле MCP её инструмента:'),
  'The guide must give a destination, syntax and read-only verification for each harness');
