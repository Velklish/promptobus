// The catalog preflight and the paid lift must see ONE account: the catalog is read from
// the owner home the driver authenticates from, not the ambient CODEX_HOME. Run: npm test
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { codexCatalogEntries, pickCodexModel } from '../scripts/codex-models.mjs';
import { ownerCodexHome } from '../lib/driver-codex.js';

const SB = makeSandbox('promptobus-promptobus-codex-models-');
const owner = path.join(SB, 'owner-a');
const ambient = path.join(SB, 'ambient-b');
for (const home of [owner, ambient]) mkdirSync(home, { recursive: true });
writeFileSync(path.join(owner, 'models.json'), `${JSON.stringify({ models: [
  { slug: 'owner-only-model', visibility: 'list' }, { slug: 'shared-model', visibility: 'list' },
] })}\n`);
writeFileSync(path.join(ambient, 'models.json'), `${JSON.stringify({ models: [
  { slug: 'ambient-only-model', visibility: 'list' }, { slug: 'shared-model', visibility: 'list' },
] })}\n`);
const binDir = path.join(SB, 'bin');
mkdirSync(binDir, { recursive: true });
const bin = path.join(binDir, 'codex');
writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
if (process.argv[2] === 'debug' && process.argv[3] === 'models') {
  const home = process.env.CODEX_HOME;
  try { process.stdout.write(readFileSync(home + '/models.json', 'utf8')); process.exit(0); }
  catch { process.stderr.write('no catalog in ' + home + '\\n'); process.exit(1); }
}
process.stderr.write('codex-fixture: not implemented\\n');
process.exit(2);
`);
chmodSync(bin, 0o755);

const envOf = (home, ownerHome) => {
  const env = { ...process.env, CODEX_HOME: home };
  delete env.PROMPTOBUS_CODEX_OWNER_HOME;
  if (ownerHome) env.PROMPTOBUS_CODEX_OWNER_HOME = ownerHome;
  return env;
};
const slugsOf = (catalog) => catalog?.map((m) => m.slug).join(',') ?? '(null)';

const envOwner = envOf(ambient, owner);
check('models: the lift\'s owner home resolves the durable override over the ambient CODEX_HOME',
  ownerCodexHome(envOwner) === owner, `${ownerCodexHome(envOwner)} · ambient ${ambient}`);
const ownerCatalog = codexCatalogEntries(bin, { env: envOwner });
check('models: the catalog is read from the owner home, not the ambient one',
  slugsOf(ownerCatalog) === 'owner-only-model,shared-model', slugsOf(ownerCatalog));
check('models: an ambient-only model is refused before anything is raised — the lift could not run it',
  pickCodexModel(ownerCatalog, 'ambient-only-model', 'shared-model').reason?.includes('ambient-only-model') === true
  && /owner-only-model, shared-model/.test(pickCodexModel(ownerCatalog, 'ambient-only-model', 'shared-model').reason ?? ''),
  JSON.stringify(pickCodexModel(ownerCatalog, 'ambient-only-model', 'shared-model')));
check('models: an owner-home model is accepted, and the default must be one the catalog knows',
  pickCodexModel(ownerCatalog, 'owner-only-model', 'shared-model').model === 'owner-only-model'
  && pickCodexModel(ownerCatalog, null, 'shared-model').model === 'shared-model',
  JSON.stringify([pickCodexModel(ownerCatalog, 'owner-only-model', 'shared-model'), pickCodexModel(ownerCatalog, null, 'shared-model')]));

const envAmbient = envOf(ambient);
const ambientCatalog = codexCatalogEntries(bin, { env: envAmbient });
check('models: without the override the ambient CODEX_HOME is the owner home, and its catalog is asked',
  ownerCodexHome(envAmbient) === ambient && slugsOf(ambientCatalog) === 'ambient-only-model,shared-model',
  `${ownerCodexHome(envAmbient)} · ${slugsOf(ambientCatalog)}`);

const envUnreadable = envOf(path.join(SB, 'no-such-home'), path.join(SB, 'no-such-owner'));
check('models: an owner home with no catalog refuses the raise rather than verify nothing',
  codexCatalogEntries(bin, { env: envUnreadable }) === null
  && pickCodexModel(null, 'any-model', 'any-model').reason?.includes('no model catalog') === true,
  JSON.stringify(pickCodexModel(null, 'any-model', 'any-model')));
