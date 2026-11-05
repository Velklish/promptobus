import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { readCompleteJson, waitFor } from './harness.mjs';

const root = makeSandbox('promptobus-test-read-complete-json-');
const file = path.join(root, 'raised.json');
const complete = { ref: 'worker', pane: { pid: 7 } };
const torn = JSON.stringify(complete).slice(0, 12);
const attempt = (read) => { try { return read(); } catch (error) { return error; } };

check('a missing file reads as null', attempt(() => readCompleteJson(file)) === null);

writeFileSync(file, torn);
const unguarded = attempt(() => JSON.parse(readFileSync(file, 'utf8')));
check('the fixture content is a torn read: an unguarded parse throws on it', unguarded instanceof SyntaxError,
  String(unguarded));
const tornRead = attempt(() => readCompleteJson(file));
check('an unfinished file reads as null instead of throwing', tornRead === null, String(tornRead));

writeFileSync(file, JSON.stringify(complete));
check('a finished file reads as its value',
  JSON.stringify(attempt(() => readCompleteJson(file))) === JSON.stringify(complete));

writeFileSync(file, torn);
setTimeout(() => writeFileSync(file, JSON.stringify(complete)), 300);
const waited = await waitFor(() => readCompleteJson(file), { timeoutMs: 5000, stepMs: 20 }).catch((error) => error);
check('a wait that meets a torn file retries until the file is finished',
  JSON.stringify(waited) === JSON.stringify(complete), String(waited));

const here = path.dirname(fileURLToPath(import.meta.url));
const bare = [];
for (const name of readdirSync(here).filter((n) => n.endsWith('.test.mjs'))) {
  readFileSync(path.join(here, name), 'utf8').split('\n').forEach((line, index) => {
    if (/waitFor\(.*existsSync\(.*JSON\.parse\(readFileSync/.test(line)) bare.push(`${name}:${index + 1}`);
  });
}
check('no waitFor probe parses a marker file bare after an existence check', bare.length === 0, bare.join(' '));
