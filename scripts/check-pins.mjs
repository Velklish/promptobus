// Pin gate. Fails when a tracked file names a backslop release that disagrees
// with `cli` in backslop.json.
//
// `backslop upgrade` rewrites the pin in backslop.json, in `docs/**` and in the
// root `*.md`, and `backslop lint` warns over that same set. Neither reaches
// `package.json` or `.github/workflows/ci.yml`, and both of those are live
// commands rather than prose: a workflow left on the old pin runs `init` at the
// version it names and regenerates the `AGENTS.md` block a raise had just
// moved. PB-167 found the divergence by hand and moved both files by hand;
// nothing stood between the next raise and the same silence. This is that
// guard.
//
// The expected version is read from backslop.json and never written here. A
// gate carrying a literal pin would be one more place for the next raise to
// miss — the shape it exists to catch.
//
// The skipped set is backslop's own `liveMarkdown`, restated rather than
// imported: the CLI is fetched by npx and is not a dependency of this package,
// so the only way to keep the two in step is to say out loud which set this is
// a copy of. Records that describe a moment rather than a runnable command keep
// their historical pins — CHANGELOG.md, ADRs, the task archive, and task cards.
//
// A gate that matches nothing is green for the wrong reason, so a live set
// holding nothing but backslop.json is a failure and both counts are printed on
// success: a reader can see what the walk actually looked at instead of
// trusting that it looked anywhere. The config is discounted deliberately — it
// is where the expected spec is read from, so it matches itself whatever the
// walk does, and a floor it can satisfy alone is no floor at all. That was
// measured rather than reasoned: pointed at a spec no file in the tree carries,
// the first version of this gate reported “1 live pin(s) in 1 file(s)” and
// exited 0.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'backslop.json';
const say = (s) => process.stdout.write(`${s}\n`);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cfg = JSON.parse(readFileSync(path.join(ROOT, CONFIG), 'utf8'));

// The spec and its separator, read off `cli` the way backslop's own `parseCli`
// reads them: `npx [flags] <spec>#v<version>` for a GitHub source, `@<version>`
// for an npm one. A `cli` without a pinned version is a configuration error and
// is reported as one rather than passed over — an unpinned project has nothing
// for this gate to compare against, and saying so beats going quietly green.
const parsed = String(cfg.cli ?? '').match(/^npx\s+(?:-\S+\s+)*(\S+?)(#v|@)(\d+\.\d+\.\d+)$/);
if (!parsed) {
  say(`✖ ${CONFIG}: “cli” is not an npx spec with a pinned version: ${JSON.stringify(cfg.cli ?? null)}`);
  process.exit(1);
}
const [, SPEC, SEP, EXPECTED] = parsed;
const PIN = new RegExp(`${escape(SPEC)}${escape(SEP)}(\\d+\\.\\d+\\.\\d+)`, 'g');

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
let guarded = 0;

for (const rel of tracked) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  const hits = [...text.matchAll(PIN)];
  if (!hits.length) continue;
  const bucket = historical(rel) ? kept : live;
  bucket.pins += hits.length;
  bucket.files += 1;
  if (bucket === kept) continue;
  if (rel !== CONFIG) guarded += hits.length;
  for (const m of hits) {
    if (m[1] === EXPECTED) continue;
    const line = text.slice(0, m.index).split('\n').length;
    failures.push(`${rel}:${line}: names ${SPEC}${SEP}${m[1]}, expected ${SEP}${EXPECTED} from ${CONFIG} “cli”`);
  }
}

const seen = `${live.pins} live pin(s) in ${live.files} file(s), ${kept.pins} historical pin(s) in ${kept.files} record(s) left alone`;

if (!guarded) {
  say(`✖ pin gate: nothing outside ${CONFIG} names ${SPEC}${SEP}<version> — the spec moved or the walk read the wrong tree`);
  say(`✖ pin gate: ${tracked.length} tracked file(s) scanned · ${seen}`);
  process.exit(1);
}

if (failures.length) {
  for (const f of failures) say(`✖ ${f}`);
  say(`✖ pin gate: ${failures.length} disagreeing pin(s) · ${seen}`);
  process.exit(1);
}

say(`✔ pin gate: ${SEP}${EXPECTED} throughout · ${seen}, ${guarded} of them outside ${CONFIG}`);
