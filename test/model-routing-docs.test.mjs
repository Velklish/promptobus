import { check } from './check.mjs';
import { readFileSync } from 'node:fs';
import { CATALOG_FILE, mergeRouting } from '../lib/model-routing/catalog.js';
import { resolve } from '../lib/model-routing/resolver.js';

const guide = readFileSync(new URL('../docs/guides/model-routing.md', import.meta.url), 'utf8');
const cli = readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8');
const warningSchema = JSON.parse(readFileSync(
  new URL('../schemas/model-routing/decision.schema.json', import.meta.url), 'utf8',
)).properties.warnings.items;

const roleRule = guide.split('## Routed roles and the schema boundary')[1]?.split('## The layers')[0] ?? '';
const inventory = guide.split('**The inventory is not a binary listing.**')[1]?.split('**Where the tier')[0] ?? '';
const telemetry = guide.split('### Participant telemetry: the collecting half')[1]?.split('### ', 1)[0] ?? '';
const unknownRole = cli.match(/^\| `role-unknown` \| ([^\n]+)/m)?.[1] ?? '';
const warningGuide = guide.match(/^Warnings carry .*$/m)?.[0] ?? '';
const warningCli = cli.match(/^A finding carries .*$/m)?.[0] ?? '';
const lateLimit = guide.split('It RETURNS the line to append to the refusal')[1]
  ?.split('It has to be called from HERE')[0] ?? '';
const optionalWarnings = Object.keys(warningSchema.properties)
  .filter((field) => !warningSchema.required.includes(field));
const fieldsIn = (text) => [...(text ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
const sameFields = (text, expected) => JSON.stringify(fieldsIn(text)) === JSON.stringify([...expected].sort());

check('routing docs: late-limit marks are read and clearable',
  /preflight reads this cache mark on the next routing decision/.test(lateLimit)
  && /A mark with a readable\s+reset expires at its reset time/.test(lateLimit)
  && /`promptobus models --clear-exhausted <harness>` clears a\s+reset-less mark\./.test(lateLimit));

check('routing docs: Claude inventory includes IDs, aliases and default at the binary version',
  /full (?:model )?IDs/i.test(inventory)
  && /aliases/.test(inventory)
  && /default\s+model/.test(inventory)
  && /version floor/.test(inventory)
  && !/inventory reported here is the driver's own\s+alias set/.test(inventory));

check('routing docs: telemetry includes generations and explicit unrouted models',
  /one JSON Lines record per harness generation/.test(telemetry)
  && /closed generation/.test(telemetry)
  && /unrouted/.test(telemetry)
  && /--model/.test(telemetry)
  && !/one JSON Lines record per routed participant|one row per participant run/.test(telemetry));

check('routing docs: declared routed steps map to catalog roles',
  /declared routed step/.test(roleRule)
  && /catalog role/.test(roleRule)
  && /declared routed step/.test(unknownRole)
  && /catalog role/.test(unknownRole));

check('routing docs: decision warnings include schema optional fields',
  sameFields(warningGuide.match(/Warnings carry required (.*?);/)?.[1], warningSchema.required)
  && sameFields(warningGuide.match(/decision schema also permits optional (.*?) on a `near-limit` warning/)?.[1], optionalWarnings)
  && sameFields(warningCli.match(/A decision warning requires (.*?);/)?.[1], warningSchema.required)
  && sameFields(warningCli.match(/optional (.*?) carry the near-limit snapshot facts/)?.[1], optionalWarnings));

const fixtureDoc = readFileSync(new URL('./fixtures/model-routing/README.md', import.meta.url), 'utf8');
const fixture = (name) => JSON.parse(readFileSync(
  new URL(`./fixtures/model-routing/${name}.json`, import.meta.url), 'utf8',
));
const clock = Date.parse('2026-09-05T09:00:12.000Z');
const goldenCatalog = fixture('catalog');
const balanceCatalog = fixture('balance-catalog');

function fixtureDecision(catalog, snapshot, strategy) {
  const policy = mergeRouting({ canonical: catalog, overlays: [], now: clock });
  policy.layers = [{ id: 'catalog', path: CATALOG_FILE, present: true }];
  return resolve({
    role: 'worker', strategy, constraints: {}, policy, snapshot, liveParticipants: [], now: clock,
    strategyCommands: { economy: 'promptobus models strategy --set economy' },
  });
}

const golden = fixtureDecision(goldenCatalog, fixture('snapshot'), 'balanced');
const balanceSnapshot = fixture('balance-snapshot');
const balancedPair = fixtureDecision(balanceCatalog, balanceSnapshot, 'balanced');
const balancePair = fixtureDecision(balanceCatalog, balanceSnapshot, 'balance');
const candidate = (decision, id) => decision.candidates.find((row) => row.tupleId === id);
const signed = (number) => `${number < 0 ? '−' : '+'}${Math.abs(number).toFixed(2)}`;
const goldenSummary = fixtureDoc.match(/That gives `example-quick` (\d+(?:\.\d+)?), `other-steady` (\d+(?:\.\d+)?) \((\d+(?:\.\d+)?) − (\d+(?:\.\d+)?) for unknown availability\), and `example-deep-high` (\d+(?:\.\d+)?)\./);
const balancedChoice = fixtureDoc.match(/`balanced` picks `([^`]+)` at (\d+(?:\.\d+)?) —/);
const balanceChoice = fixtureDoc.match(/`balance` picks `([^`]+)` at (\d+(?:\.\d+)?),/);

check('routing fixture docs: the rating formula uses the ten-point scale',
  /1–10 scale/.test(fixtureDoc)
  && /\(r − 1\) \/ 9 × 100/.test(fixtureDoc)
  && /\(10 − r\) \/ 9 × 100/.test(fixtureDoc)
  && /5 × \(quotaCost − 1\) \/ 9/.test(fixtureDoc)
  && !/1–5 scale|\(5 − r\) \/ 4|\(quotaCost − 1\) \/ 4/.test(fixtureDoc));

check('routing fixture docs: golden scores match the resolver',
  goldenSummary !== null
  && Number(goldenSummary[1]) === candidate(golden, 'example-quick').score.total
  && Number(goldenSummary[2]) === candidate(golden, 'other-steady').score.total
  && Number(goldenSummary[3]) === candidate(golden, 'other-steady').score.base
  && Number(goldenSummary[4]) === candidate(golden, 'other-steady').score.base
    - candidate(golden, 'other-steady').score.total
  && Number(goldenSummary[3]) - Number(goldenSummary[4]) === Number(goldenSummary[2])
  && Number(goldenSummary[5]) === candidate(golden, 'example-deep-high').score.total);

check('routing fixture docs: balance penalties and effective pace match the resolver',
  balancePair.candidates.filter((row) => row.pace?.eligible).every((row) => {
    const rating = balanceCatalog.tuples.find((tuple) => tuple.id === row.tupleId).ratings.quotaCost;
    return fixtureDoc.includes(`| \`${row.tupleId}\` | ${rating} | ${row.pace.spendPenalty.toFixed(2)} | ${signed(row.pace.effective)} |`);
  }));

check('routing fixture docs: balanced and balance choices match the resolver',
  balancedChoice !== null && balanceChoice !== null
  && balancedChoice[1] === balancedPair.chosen.tupleId
  && Number(balancedChoice[2]) === candidate(balancedPair, balancedChoice[1]).score.total
  && balanceChoice[1] === balancePair.chosen.tupleId
  && Number(balanceChoice[2]) === candidate(balancePair, balanceChoice[1]).score.total);

check('routing fixture docs: the models command comparison is implemented',
  /The command check \(`test\/model-routing\.test\.mjs`\) runs the real command/.test(fixtureDoc)
  && !/pending until the `models` command exists/.test(fixtureDoc));

const spendPenalty = (quotaCost) => {
  const catalog = structuredClone(balanceCatalog);
  catalog.tuples.find((tuple) => tuple.id === 'claude-opus').ratings.quotaCost = quotaCost;
  return candidate(fixtureDecision(catalog, balanceSnapshot, 'balance'), 'claude-opus').pace.spendPenalty;
};

check('routing CLI docs: quotaCost 1, 5 and 10 use resolver penalties',
  cli.includes(`\`quotaCost\` 1, 5 and 10 give up ${spendPenalty(1)}, ${spendPenalty(5)} and ${spendPenalty(10)} percentage points`)
  && !/quotaCost` of 5 gives up exactly one band/.test(cli));
