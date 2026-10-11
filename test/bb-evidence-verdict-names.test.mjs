import './home.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extractNodeTestVerdictNames } from '../scripts/bb-evidence-verdict-names.mjs';

// Synthetic names in the retained Node spec format; this is not a run receipt.
// Assertions require callable behavior; an import failure proves no behavior.
const raw = readFileSync(new URL('./fixtures/bb-evidence-verdicts.txt', import.meta.url), 'utf8');
const expected = [
  "new --minor (en): keeps the exact triage parent's empty target (inline)",
  'prefix (one): preserves [brackets], commas; and punctuation!',
  'prefix (two): preserves [brackets], commas; and punctuation!',
  'repeated name (same)',
  'repeated name (same)',
  'duration-like name (12.5ms)',
  'nested (outer (inner)): keeps both pairs',
  'Unicode: résumé — Δ → 東京 (kept)',
  'spacing:  two spaces (kept)',
  "terminal punctuation: 'quotes' / slash : colon (done)!",
];

function incomplete(input) {
  const result = extractNodeTestVerdictNames(input);
  assert.equal(result.complete, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.trim().length > 0, 'an incomplete inventory needs a concrete reason');
  assert.ok(Array.isArray(result.names));
  return result;
}

test('BB verdict names: complete raw fixture preserves exact order, count and multiplicities', () => {
  assert.deepEqual(extractNodeTestVerdictNames(raw), { complete: true, names: expected, reason: null });
});

test('BB verdict names: remove only the final duration, keeping duration-like name parentheses', () => {
  assert.equal(extractNodeTestVerdictNames(raw).names[5], 'duration-like name (12.5ms)');
});

test('BB verdict names: common prefixes and repeated exact names remain separate occurrences', () => {
  const { names } = extractNodeTestVerdictNames(raw);
  assert.deepEqual(names.slice(1, 5), expected.slice(1, 5));
  assert.equal(names.filter(name => name === 'repeated name (same)').length, 2);
});

test('BB verdict names: nested parentheses, Unicode, punctuation and internal spaces stay exact', () => {
  assert.deepEqual(extractNodeTestVerdictNames(raw).names.slice(6), expected.slice(6));
});

test('BB verdict names: separate lint gate status contributes no test name', () => {
  const result = extractNodeTestVerdictNames(raw);
  assert.equal(result.complete, true);
  assert.equal(result.names.length, 10);
  assert.equal(result.names.includes('lint: no errors'), false);
});

for (const [label, input] of [['absent', undefined], ['null', null], ['empty', '']]) {
  test(`BB verdict names: ${label} raw output is explicitly incomplete without invented verdicts`, () => {
    assert.deepEqual(incomplete(input).names, []);
  });
}

test('BB verdict names: verdict lines without a complete footer do not certify an inventory', () => {
  incomplete(raw.slice(0, raw.indexOf('ℹ tests')));
});

test('BB verdict names: missing raw verdict with unchanged footer is incomplete', () => {
  incomplete(raw.replace('✔ repeated name (same) (0.858125ms)\n', ''));
});

test('BB verdict names: footer count disagreement is incomplete', () => {
  incomplete(raw.replace('ℹ tests 10', 'ℹ tests 11'));
});

test('BB verdict names: unsupported verdict line cannot be silently omitted', () => {
  incomplete(raw.replace('(0.858125ms)', '(unmeasured duration)'));
});

test('BB verdict names: failed or skipped summaries cannot certify the supported pass-only format', () => {
  incomplete(raw.replace('ℹ pass 10\nℹ fail 0', 'ℹ pass 9\nℹ fail 1'));
  incomplete(raw.replace('ℹ pass 10', 'ℹ pass 9').replace('ℹ skipped 0', 'ℹ skipped 1'));
});

test('BB verdict names: another reporter format is incomplete without fake PASS or skip entries', () => {
  assert.deepEqual(incomplete('TAP version 13\nok 1 - name (kept)\n1..1\n').names, []);
});

test('BB verdict names: concatenated runs with multiple footers require an explicit incomplete result', () => {
  incomplete(raw + raw);
});

const singleScope = [
  '✔ name (1ms)',
  'ℹ tests 1',
  'ℹ suites 0',
  'ℹ pass 1',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 1',
].join('\n') + '\n';

test('BB verdict names: mixed TAP scope after a complete Node fixture is explicitly incomplete', () => {
  const result = incomplete(raw + 'TAP version 13\nok 1 - extra\n1..1\n');
  assert.match(result.reason, /TAP/i);
});

test('BB verdict names: duration before verdicts cannot replace the terminal footer duration', () => {
  const input = 'ℹ duration_ms 1\n' + singleScope.replace('ℹ duration_ms 1\n', '');
  assert.match(incomplete(input).reason, /footer order/i);
});

test('BB verdict names: duration interleaved before the final footer count is explicitly incomplete', () => {
  const input = singleScope.replace('ℹ todo 0\nℹ duration_ms 1\n', 'ℹ duration_ms 1\nℹ todo 0\n');
  assert.match(incomplete(input).reason, /footer order/i);
});

test('BB verdict names: a verdict after footer counts begin is explicitly incomplete', () => {
  const input = singleScope.replace('✔ name (1ms)\nℹ tests 1\n', 'ℹ tests 1\n✔ name (1ms)\n');
  assert.match(incomplete(input).reason, /footer order/i);
});

test('BB verdict names: a flat passing control has all seven counts before terminal duration and allows gate status', () => {
  assert.deepEqual(extractNodeTestVerdictNames(singleScope + 'lint: no errors\n'), {
    complete: true,
    names: ['name'],
    reason: null,
  });
});
