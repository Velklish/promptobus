// The release guide and writer config keep CLI help and shipped skills in scope.
import './home.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(path.join(repo, 'backslop.json'), 'utf8'));
const guide = readFileSync(path.join(repo, 'docs', 'guides', 'releasing.md'), 'utf8');
const contributing = readFileSync(path.join(repo, 'docs', 'guides', 'contributing.md'), 'utf8');
const stepHeading = '## Technical-writer pass';
const step = guide.indexOf(stepHeading);
const release = guide.indexOf('## Release commit');
const nextHeading = step < 0 ? -1 : guide.indexOf('\n## ', step + stepHeading.length);
const section = step < 0 ? '' : guide.slice(step, nextHeading < 0 ? guide.length : nextHeading);
const localHeading = '### Local writer rules';
const localStart = contributing.indexOf(localHeading);
const localEnd = localStart < 0 ? -1 : contributing.indexOf('\n## ', localStart + localHeading.length);
const localRules = localStart < 0 ? '' : contributing.slice(localStart, localEnd < 0 ? contributing.length : localEnd);
const style = config.writer?.style ?? [];
const currency = config.writer?.currency ?? [];
const upgrade = contributing.split('\n\n')
  .find((paragraph) => paragraph.startsWith('To update backslop,')) ?? '';

check('writer styles CLI help', style.includes('lib/cli.js'));
check('writer checks shipped skills for currency only',
  currency.includes('skills/**') && !style.includes('skills/**'));
check('release guide invokes backslop-writer before the release commit',
  step >= 0 && release > step
  && section.includes('`backslop-writer` in release mode'));
check('release guide names configured help and skill scope',
  section.includes('`lib/cli.js`') && section.includes('`helpText` block')
  && section.includes('every shipped skill under `skills/` to currency review only'));
check('local style rule confines the CLI glob to helpText',
  localRules.includes('`writer.style` glob selects `lib/cli.js`')
  && localRules.includes('only to its human-facing `helpText` block')
  && localRules.includes('Refusal strings and comments elsewhere in that file are outside the style pass')
  && section.includes('selects all of `lib/cli.js`')
  && section.includes('narrows style review to the human-facing `helpText` block'));
check('release guide treats README.ru.md as a translation',
  section.includes('`README.ru.md` as a faithful translation of `README.md`'));
check('release guide names the writer ledgers',
  section.includes('currency ledger row for each behaviour-changing commit')
  && section.includes('style ledger row for each `backslop-humanizer` pattern'));
check('release currency ledger covers CLI help and every shipped skill',
  localRules.includes('one row for the CLI help and one row for **every** shipped skill')
  && localRules.includes('`no change touches it`')
  && section.includes('one row for the CLI help and one for every shipped skill')
  && section.includes('`no change touches it`'));
check('release ledgers live in the writer fixes commit body',
  localRules.includes('Releases have no writer task: put both ledgers in the message body of the commit carrying the writer fixes')
  && section.includes('A release has no writer task, so put both ledgers in the message body of the commit carrying the writer fixes'));
const upgradeSteps = [
  '`devDependencies.backslop`', '`npm install`', '`npx --no-install backslop upgrade`',
  '`npm run pins`', '`upgrade --to X.Y.Z`',
];
check('backslop upgrade guide installs the selected tag before upgrade and pins',
  upgradeSteps.every((step, index) => upgrade.includes(step)
    && (index === 0 || upgrade.indexOf(step) > upgrade.indexOf(upgradeSteps[index - 1])))
  && upgrade.includes('when the chosen tag is older than the latest release'),
  upgrade);
