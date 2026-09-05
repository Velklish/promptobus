// Ambient-state gate for the Promptobus package. Run: npm test
//
// Subject — the boundary «the package receives context via ARGUMENTS, not by substitution».
// removed the `useHost` and `useRouting` seams from the package, through which the adapter used
// to hand in diagnostics, session identity, and routing policy from outside; the mutation probe
// at acceptance re-added the same shape under a different name — `let ambientNote = null; export
// function useNote(fn) { ambientNote = fn; }` — and no gate went red. Explainable: the
// environment gate ([promptobus-package.test.mjs](promptobus-package.test.mjs)) regex-searches
// for `process.env` and streams, and ambient substitution needs neither — it is plain JS, and it
// does not interfere with the standalone copy. The boundary held on the author's discipline
// alone.
//
// **A cheap gate here is idle.** «No export on `use[A-Z]` in `index.ts`» catches one removed
// form and misses every other one — an internal setter without an export, an object field, a
// closure — while staying green and looking like it works. An honest predicate cannot be
// expressed as a regex: the package has legitimate stashes of the same shape, and only a tree
// parse can tell them apart from a bridge. Hence `ast-grep` and an explicit allowlist.
//
// **The predicate is two rules joined by name.** `ast-grep` does not join two matches itself,
// so declarations and writes are picked up separately and reconciled here, PER FILE: a
// same-named local variable in a neighboring module would otherwise merge with this one's
// stash.
//   • declaration — a module-level `let`/`const`/`var`: not inside a function body and not
//     inside a class body;
//   • write — assignment to the name, an increment, assignment to its property (`x.y = …` and
//     computed `x[k] = …` alike: a registry keyed by name is the most natural bridge shape) or
//     a mutating call FROM A FUNCTION. Module-level initialization does not count as a write:
//     the module itself sets up the stash, and a write from outside is what turns it into a
//     bridge.
//
// **The allowlist of legitimate stashes lives here, each with a reason.** Adding to it is an
// edit to this file — a subject for review, not a silent exclusion. The reason has the same
// shape every time: a stash holds ITS OWN process state — a counter, a cache, a registry — and
// the package itself puts the value into it. A bridge holds SOMEONE ELSE'S: the adapter puts the
// value into it from outside.
//
// **The gate lives in the integration suite.** Resolving `ast-grep` — PATH and known prefixes
// ([sandbox.mjs](sandbox.mjs)); the core does not depend on the external binary. No binary — a
// red verdict with the install command, not a skip: a gate that stays silent without the tool is
// green for any implementation.
//
// The file only reads the repository tree. The mutation probe's fixtures get their own sandbox:
// the same fixtures verify that the gate not only catches a bridge but also does NOT flag a
// legitimate stash red.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { AST_GREP_INSTALL, findAstGrep, makeSandbox } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(here, '..');

const DECL = 'module-binding';
const WRITE = 'fn-write';

// The `ast-grep` rules, both in TypeScript. A match yields the metavariable `$NAME` — it is
// what joins declarations and writes. The backslash in the rule's regex is escaped TWICE: the
// string is a template literal, and `\b` inside it is a backspace character, not a word
// boundary; ast-grep rejects such a rule with «Cannot parse rule INLINE_RULES», i.e. it goes red
// on parsing, not silently — but the diagnostic points into the YAML, which a person does not
// see in this file.
const RULES = `
id: ${DECL}
language: ts
rule:
  kind: variable_declarator
  has:
    field: name
    kind: identifier
    pattern: $NAME
  not:
    inside:
      any:
        - kind: statement_block
        - kind: class_body
      stopBy: end
---
id: ${WRITE}
language: ts
rule:
  any:
    - kind: assignment_expression
      has: { field: left, kind: identifier, pattern: $NAME }
    - kind: augmented_assignment_expression
      has: { field: left, kind: identifier, pattern: $NAME }
    - kind: update_expression
      has: { field: argument, kind: identifier, pattern: $NAME }
    - kind: assignment_expression
      has:
        field: left
        any:
          - kind: member_expression
          - kind: subscript_expression
        has: { field: object, kind: identifier, pattern: $NAME }
    - kind: augmented_assignment_expression
      has:
        field: left
        any:
          - kind: member_expression
          - kind: subscript_expression
        has: { field: object, kind: identifier, pattern: $NAME }
    - kind: call_expression
      has:
        field: function
        kind: member_expression
        all:
          - has: { field: object, kind: identifier, pattern: $NAME }
          - has:
              field: property
              regex: '^(set|add|delete|clear|push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$'
  inside:
    any:
      - kind: function_declaration
      - kind: function_expression
      - kind: generator_function_declaration
      - kind: arrow_function
      - kind: method_definition
    stopBy: end
`;

// The package's legitimate stashes: key and reason. Every single one holds the state of ITS OWN
// process and is filled by the package itself — no one puts anything into them from outside. The
// list was checked against the tree, not copied from the spec: the `migrated` the spec names is
// `const MARK = 'migrated.json'` (migrate.ts) — a string, not a stash, and the parse does not
// find it.
const ALLOWED = [
  ['src/fs/atomic.ts::atomicSeq',
    "suffix counter for the atomic write's temporary neighbor: names within the process must not collide"],
  ['src/fs/lock.ts::held',
    'tracks locks taken by THIS process: without it a nested call would sit out waitMs against itself'],
  ['src/legacy-store.ts::seq',
    'legacy store record id counter: the number ends up in the file name and preserves send order'],
  ['src/legacy-store.ts::tmpSeq',
    'legacy store temporary-name counter, separate from seq: that one ends up in the record name'],
  ['src/legacy-store.ts::taskCache',
    'single-request journal cache: one command reads task.json four to six times; writeTask and withTaskLock invalidate it'],
  ['src/sidecar.ts::suspenders',
    'registry of onTaskLock wrappers: there are two stores in the package, and the second registrar has no right to cancel the first'],
  ['src/v1/artifacts.ts::tmpSeq',
    'v1 blob-file temporary-name counter'],
  ['src/v1/messages.ts::seq',
    'v1 sender counter in the record id: string sort order equals send order'],
  ['src/v1/messages.ts::sentSeen',
    'incremental parse of sends: each record is read once per process lifetime, the canon is immutable'],
];

// Tree parse: `<dir>/src` into «file::name» keys with the declaration site and write sites. The
// directory is invoked from `cwd`, not an absolute path — that way `file` in the response comes
// back as `src/…` for both the package's tree and the fixtures, so the key has the same shape
// for both.
function ambientState(dir) {
  const r = spawnSync(AG, ['scan', '--inline-rules', RULES, '--json=compact', 'src'],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let matches = null;
  try { matches = JSON.parse(r.stdout ?? ''); } catch { /* did not parse — handled below */ }
  if (!Array.isArray(matches)) {
    return { failed: `ast-grep did not return a parse (status ${r.status}): ${String(r.stderr ?? r.error?.message ?? '').slice(0, 300)}`, found: new Map() };
  }
  const decls = new Map();
  const writes = new Map();
  for (const m of matches) {
    const name = m?.metaVariables?.single?.NAME?.text;
    if (!name) continue;
    const bin = m.ruleId === DECL ? decls : writes;
    // The path separator is normalized: on win32 `ast-grep` returns `src\\fs\\atomic.ts`, and
    // the key would then diverge from the list, which is written with `/` — both verdicts
    // would go red at once on a correct tree.
    const key = `${m.file.split(path.sep).join('/')}::${name}`;
    bin.set(key, [...(bin.get(key) ?? []), (m.range?.start?.line ?? 0) + 1]);
  }
  const found = new Map();
  for (const [key, at] of decls) {
    if (writes.has(key)) found.set(key, { at: at[0], writes: writes.get(key) });
  }
  return { failed: null, found };
}

const where = (found, keys) => keys.map((k) => `${k} (declared at ${found.get(k)?.at}, written at ${found.get(k)?.writes.join(', ')})`).join('; ');

const AG = findAstGrep();
check(': ast-grep is found on the machine — without it the gate goes red, not silent',
  AG, `no binary in PATH or in the known install locations — install it: ${AST_GREP_INSTALL}`);

if (AG) {
  // ── package tree ──────────────────────────────────────────────────────────────────────
  const pkg = ambientState(PKG);
  check(': package source parse succeeded — ast-grep returned JSON', !pkg.failed, pkg.failed ?? '');

  const allowed = new Set(ALLOWED.map(([key]) => key));
  const unlisted = [...pkg.found.keys()].filter((key) => !allowed.has(key));
  check(': no ambient state in the package sources — only allowlisted stashes',
    unlisted.length === 0,
    `not in the allowlist: ${where(pkg.found, unlisted)}`);

  // Without this check the list rots silently: a removed stash leaves an entry behind, and a
  // blinded parse (a broken rule, the wrong directory) makes the gate green over nothing. It
  // also serves as a positive control: all nine entries must be found in the tree.
  const stale = [...allowed].filter((key) => !pkg.found.has(key));
  check(': the allowlist has not rotted — every one of its entries was found in the tree',
    stale.length === 0, `in the list but not in the tree: ${stale.join(', ')}`);

  // ── mutation probe on fixtures ────────────────────────────────────────────────────────
  //
  // The three forms from the spec  at once, with the same parse that judges the package tree.
  // The third is a false-positive check: it is the very target of the probe's second move (a
  // naive edit of «any module-level let is a failure» must flag exactly this one red).
  const FIX = makeSandbox('promptobus-ambient-');
  mkdirSync(path.join(FIX, 'src'), { recursive: true });
  const fixture = (name, body) => writeFileSync(path.join(FIX, 'src', name), body);

  // The form that stayed green at acceptance , — an exported setter.
  fixture('bridge-exported.ts', `let ambientNote: unknown = null;
export function useNote(fn: unknown): void { ambientNote = fn; }
export function note(): unknown { return ambientNote; }
`);
  // The same bridge without an export: the setter is internal, and a neighboring exported call
  // is what feeds it the value. The cheap gate «no export on use[A-Z]» misses this form.
  fixture('bridge-quiet.ts', `let ambientHost: unknown = null;
function useHostQuietly(fn: unknown): void { ambientHost = fn; }
export function adopt(fn: unknown): void { useHostQuietly(fn); }
`);
  // A substitution registry — two forms absent from the two fixtures above, each caught by the
  // rule's own branch. `ambient[name] = fn` in the tree is a `subscript_expression`, not a
  // `member_expression`; `chain.unshift(fn)` is a mutator from the tail of the list. Both sit in
  // one fixture on purpose: narrow the rule from either end, and the verdict goes red.
  fixture('bridge-registry.ts', `const ambient: Record<string, unknown> = {};
export function use(name: string, fn: unknown): void { ambient[name] = fn; }
const chain: unknown[] = [];
export function prepend(fn: unknown): void { chain.unshift(fn); }
`);
  // A legitimate stash — the same shape as `seq` in v1/messages.ts: a process counter that the
  // module fills itself.
  fixture('counter.ts', `let seq = 0;
export function nextId(): string { seq = (seq + 1) % 10000; return String(seq); }
`);

  const fix = ambientState(FIX);
  const fixAllowed = new Set(['src/counter.ts::seq']);
  const fixUnlisted = [...fix.found.keys()].filter((key) => !fixAllowed.has(key));

  check(': probe — the gate catches an exported setter (the useNote form)',
    fixUnlisted.includes('src/bridge-exported.ts::ambientNote'),
    `gate failures on fixtures: ${fixUnlisted.join(', ') || 'none'}`);
  check(': probe — the gate catches an internal setter without an export just like an exported one',
    fixUnlisted.includes('src/bridge-quiet.ts::ambientHost'),
    `gate failures on fixtures: ${fixUnlisted.join(', ') || 'none'}`);
  check(': probe — the gate catches a substitution registry in both forms: ambient[name] = fn and chain.unshift(fn)',
    fixUnlisted.includes('src/bridge-registry.ts::ambient')
      && fixUnlisted.includes('src/bridge-registry.ts::chain'),
    `gate failures on fixtures: ${fixUnlisted.join(', ') || 'none'}`);
  // Both halves are required. The first — the parse SEES the stash: without it the verdict
  // would be green even for a gate that is fully blind. The second — it is the allowlist that
  // makes it green, not blindness.
  check(': probe — the gate does not flag a legitimate allowlisted stash',
    fix.found.has('src/counter.ts::seq') && !fixUnlisted.includes('src/counter.ts::seq'),
    `parse saw the stash: ${fix.found.has('src/counter.ts::seq')} · failures: ${fixUnlisted.join(', ') || 'none'}`);
}
