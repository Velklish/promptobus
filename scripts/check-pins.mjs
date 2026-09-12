// Pin gate: red when a tracked file names a backslop release disagreeing with `cli`
// in backslop.json. Why it exists and what it skips: docs/guides/contributing.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'backslop.json';
const say = (s) => process.stdout.write(`${s}\n`);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cfg = JSON.parse(readFileSync(path.join(ROOT, CONFIG), 'utf8'));

// Spec and separator read off `cli`, the way backslop's own `parseCli` reads them.
// An unpinned `cli` has nothing to compare against and is reported, not passed over.
const parsed = String(cfg.cli ?? '').match(/^npx\s+(?:-\S+\s+)*(\S+?)(#v|@)(\d+\.\d+\.\d+)$/);
if (!parsed) {
  say(`✖ ${CONFIG}: “cli” is not an npx spec with a pinned version: ${JSON.stringify(cfg.cli ?? null)}`);
  process.exit(1);
}
const [, SPEC, SEP, EXPECTED] = parsed;
// Any ref, not only a semver one: `#main`, `#v0.6` and a sha are divergences too, and a
// gate blind to them is green while two live files agree with each other on the wrong ref.
const SEPCHAR = SEP[0];
const WANT = `${SEP.slice(1)}${EXPECTED}`;
const PIN = new RegExp(`${escape(SPEC)}${escape(SEPCHAR)}([^\\s'"\`)\\],;]+)`, 'g');

// Restated from backslop's `liveMarkdown`, not imported: the CLI arrives by npx.
const DOCS = cfg.docs ?? 'docs';
const PREFIX = cfg.prefix ?? '';
const ARCHIVE = new RegExp(`^${escape(DOCS)}/archive/${escape(PREFIX)}-\\d`);
const CARD = new RegExp(`^${escape(PREFIX)}-\\d+(?:\\.\\d+)?-.+\\.md$`);
const historical = (rel) => rel === 'CHANGELOG.md'
  || rel.startsWith(`${DOCS}/adr/`)
  || ARCHIVE.test(rel)
  || CARD.test(path.posix.basename(rel));

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);

const failures = [];
const live = { pins: 0, files: 0 };
const kept = { pins: 0, files: 0 };
// The floor discounts CONFIG: it holds the spec this gate reads, so it matches
// itself whatever the walk does, and a floor it satisfies alone is no floor.
let guarded = 0;

// A file this gate could not read is a failure, never a skip: it cannot vouch for what it
// did not open, and a silent skip is the shape of divergence it exists to catch.
let read = 0;
for (const rel of tracked) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (e) {
    failures.push(`${rel}: unreadable (${e.code ?? e.message}) — the gate cannot vouch for it`);
    continue;
  }
  read += 1;
  const hits = [...text.matchAll(PIN)];
  if (!hits.length) continue;
  const bucket = historical(rel) ? kept : live;
  bucket.pins += hits.length;
  bucket.files += 1;
  if (bucket === kept) continue;
  if (rel !== CONFIG) guarded += hits.length;
  for (const m of hits) {
    if (m[1] === WANT) continue;
    const line = text.slice(0, m.index).split('\n').length;
    failures.push(`${rel}:${line}: names ${SPEC}${SEPCHAR}${m[1]}, expected ${SEPCHAR}${WANT} from ${CONFIG} “cli”`);
  }
}

const seen = `${read} of ${tracked.length} tracked file(s) read · ${live.pins} live ref(s) in ${live.files} file(s), ${kept.pins} historical ref(s) in ${kept.files} record(s) left alone`;

// Findings print before either verdict: an empty live set and an unreadable file happen
// together exactly when the second explains the first, and that is when it is needed.
for (const f of failures) say(`✖ ${f}`);

if (!guarded) {
  say(`✖ pin gate: nothing outside ${CONFIG} names ${SPEC}${SEPCHAR}<ref> — the spec moved or the walk read the wrong tree`);
  say(`✖ pin gate: ${seen}`);
  process.exit(1);
}

if (failures.length) {
  say(`✖ pin gate: ${failures.length} finding(s) · ${seen}`);
  process.exit(1);
}

say(`✔ pin gate: ${SEPCHAR}${WANT} throughout · ${seen}, ${guarded} live ref(s) outside ${CONFIG}`);
