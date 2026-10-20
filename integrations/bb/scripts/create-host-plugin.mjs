import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--directory', '--integration', '--promptobus'].includes(key) || !process.argv[i + 1]) throw new Error('Use --directory <new path> --integration <source module> --promptobus <package spec>');
  options[key] = process.argv[i + 1];
}
if (!options['--directory'] || !options['--integration'] || !options['--promptobus']) throw new Error('All three setup options are required');
const destination = path.resolve(options['--directory']);
const integration = path.resolve(options['--integration']);
const relativeIntegration = path.relative(destination, integration).split(path.sep).join('/');
if (!existsSync(integration)) throw new Error('The consumer integration source module is missing');
if (existsSync(destination)) throw new Error('Generate into a new directory; existing files are never overwritten');
mkdirSync(destination, { recursive: true });
for (const name of readdirSync(source)) if (name.endsWith('.ts') && name !== 'host.ts') cpSync(path.join(source, name), path.join(destination, name));
for (const name of ['skills', 'scripts', 'tsconfig.json', '.gitignore', 'README.md', 'PLUGIN_OVERVIEW.md']) cpSync(path.join(source, name), path.join(destination, name), { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
manifest.dependencies.promptobus = options['--promptobus'];
manifest.files = [...manifest.files, 'host.mjs'];
delete manifest.scripts.test;
writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(path.join(destination, 'host.mjs'), [
  '// Generated entry. Change the consumer source integration and regenerate.',
  "import { createHostEntry } from './host-integration.js';",
  "import { createBbHostIntegration } from 'promptobus/bb-host';",
  `import options from ${JSON.stringify(relativeIntegration.startsWith('.') ? relativeIntegration : './' + relativeIntegration)};`,
  "export { experimental_providerBridge } from './reviewer-bridge.js';",
  'export default createHostEntry(createBbHostIntegration(options));', '',
].join('\n'));
console.log(`Generated Promptobus Host plugin in ${destination}`);
