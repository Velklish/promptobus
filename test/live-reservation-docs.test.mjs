import './home.mjs';
import { readFileSync } from 'node:fs';
import { check } from './check.mjs';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const cli = read('docs/reference/03-cli.md');
check('live-cap reference documents locked admission and verified owner recovery',
  cli.includes('### Live-cap admission') && cli.includes('launcher PID and process birth')
    && cli.includes('Unknown process identity or incomplete') && cli.includes('promptobus stop ADDRESS --task TASK')
    && cli.includes('`models` and `--dry-run` reserve no seat'));
check('Codex home-sweep reference documents complete and incomplete registry observations',
  read('docs/reference/05-drivers.md').includes('without a valid absolute participant home preserves every home'));
check('README and routing guide distinguish admission from resolver projection',
  read('README.md').includes('including teamleads before child linking')
    && read('docs/guides/model-routing.md').includes('reserves a seat under the task lock for every strategy'));
check('public driver reference specifies optional structural hooks and strict retirement proof',
  read('docs/reference/05-drivers.md').includes('Existing drivers can omit both')
    && read('docs/reference/05-drivers.md').includes('owner: { pid, birth }')
    && read('docs/reference/05-drivers.md').includes('Caller metadata alone is insufficient')
    && read('docs/reference/05-drivers.md').includes('invalid result or `false` retains the record and seat'));
