import { check } from './check.mjs';
import { readFileSync } from 'node:fs';
import { REGISTRY } from '../lib/drivers.js';
import { CATALOG_FILE, mergeRouting } from '../lib/model-routing/catalog.js';
import { resolve } from '../lib/model-routing/resolver.js';

const guide = readFileSync(new URL('../docs/guides/model-routing.md', import.meta.url), 'utf8');
const cli = readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8');
const glossary = readFileSync(new URL('../docs/GLOSSARY.md', import.meta.url), 'utf8');
const roadmap = readFileSync(new URL('../docs/ROADMAP.md', import.meta.url), 'utf8');
const drivers = readFileSync(new URL('../docs/reference/05-drivers.md', import.meta.url), 'utf8');
const adr = readFileSync(new URL('../docs/adr/adr-005-ten-point-scale-absolute-bands-calibrate.md', import.meta.url), 'utf8');
const orchestrate = readFileSync(new URL('../skills/orchestrate/SKILL.md', import.meta.url), 'utf8');
const warningSchema = JSON.parse(readFileSync(
  new URL('../schemas/model-routing/decision.schema.json', import.meta.url), 'utf8',
)).properties.warnings.items;

check('routing skill: balance and calibration are conditional and writes require consent',
  orchestrate.includes('not a general default. Propose it for a long run across subscriptions or when an account runs short')
  && orchestrate.includes('when experience contradicts a pick or after a long series on one harness')
  && orchestrate.includes('`--yes` records prior consent; it cannot replace asking'));

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
const section = (text, heading) => text.split(`\n${heading}\n`)[1]?.split(/\n#{1,6} /, 1)[0] ?? '';

const harnesses = Object.keys(REGISTRY.drivers);
const { tuples } = JSON.parse(readFileSync(new URL('../models/catalog.json', import.meta.url), 'utf8'));
const bases = tuples.filter((tuple) => !tuple.evidence?.interpolatedFrom);
const qualityHypotheses = bases.filter((tuple) => tuple.evidence?.hypothesis?.includes('quality'));
const catalogOrder = [...new Set([...tuples].sort((a, b) => a.priority - b.priority).map((tuple) => tuple.harness))];
const documentedHarnesses = (text) => [...text.matchAll(/`([a-z]+)`/g)].map((match) => match[1]);
const registryPassages = [
  glossary.match(/^\| harness \|.*$/m)?.[0] ?? '',
  roadmap.match(/^2\. \*\*.*harnesses in one CLI\..*$/m)?.[0] ?? '',
  drivers.match(/The CLI registry contains [\s\S]*?\. This is a source inventory/)?.[0] ?? '',
];
const canonicalPriority = section(guide, '### Canonical priority').match(/^- tuples are grouped.*$/m)?.[0] ?? '';
check('routing docs: current harness and catalog inventories match their sources',
  registryPassages.every((text) => documentedHarnesses(text).join() === harnesses.join())
  && documentedHarnesses(canonicalPriority).join() === catalogOrder.join()
  && catalogOrder.join() === harnesses.join()
  && roadmap.includes(`${tuples.length} rated tuples`)
  && section(guide, '## The catalog file').includes(`${tuples.length} rated tuples`)
  && guide.includes(`Of the ${bases.length} base rows (rows without \`evidence.interpolatedFrom\`), ${qualityHypotheses.length} carry a \`quality\` hypothesis`));

const { exports: packageExports } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const validationRef = section(cli, '### Catalog and overlays');
const validationGuide = guide.match(/^Validate a policy layer .*$/m)?.[0] ?? '';
const internalValidator = section(guide, '### Validate: what a catalog or an overlay is refused for');
const supportedValidation = (text) => {
  const imports = [...text.matchAll(/import `([^`]+)` from `promptobus(\/[^`]+)`/g)];
  return imports.length === 2
    && imports.every(([, , specifier]) => Object.hasOwn(packageExports, `.${specifier}`))
    && imports.some(([, name, specifier]) => name === 'routingDiagnosis' && specifier === '/integration')
    && imports.some(([, name, specifier]) => name === 'runPromptobus' && specifier === '/cli')
    && text.includes('await routingDiagnosis(host)')
    && text.includes("await runPromptobus(['models', 'validate'], { host })");
};
check('routing docs: consumer validation uses exported entries, not internal helpers',
  [validationRef, validationGuide].every(supportedValidation)
  && [validationRef, internalValidator].every((text) => /internal implementation\s+details, not package entry points/.test(text)
    && ['loadCatalog', 'validate', 'validateLayers'].every((name) => text.includes(`\`${name}`)))
  && /does not export a pure validator/.test(validationGuide)
  && /no exported pure validator/.test(validationRef)
  && !/so a consumer can check a policy layer|own can check that layer without a subprocess/.test(guide + cli));

const cacheGuide = section(guide, '### The availability cache: the first disk boundary of routing');
check('routing docs: expiry retains dated cache readings without confirming availability',
  /returns `unknown` \/ `stale_cache`/.test(cacheGuide)
  && /retains the last model inventory and window readings/.test(cacheGuide)
  && /original `checkedAt` timestamps.*original age.*labels\s+their source `cache`, not `probe`/.test(cacheGuide)
  && /not fresh telemetry or confirmation of\s+current availability/.test(cacheGuide)
  && /`windowsExpiry` is diagnostic only/.test(cacheGuide)
  && /If the resolver has no usable remaining reading, that\s+timestamp lets `unknown-remaining`/.test(cacheGuide)
  && !/carries nothing of\s+the entry but its `checkedAt`/.test(cacheGuide));

const routingCommands = section(cli, '### Commands');
const telemetryRef = section(cli, '### Participant telemetry');
check('routing docs: descriptive telemetry readers are separate from confirmed rating writes',
  /`stats` reads local telemetry for its run report; `models` reads it for the record count and file size in text output, not in `--json`/.test(routingCommands)
  && /`models calibrate` .* proposes `speed` and `quotaCost` ratings, never `quality`/.test(routingCommands)
  && /A proposal does not change any overlay\. Only `--write` with confirmation applies the proposed `ratings` to the `user` overlay/.test(routingCommands)
  && /Without a terminal it refuses unless `--yes` is also given/.test(routingCommands)
  && /Read paths are `stats`, the text count line of `models`/.test(telemetryRef)
  && !/the only command that reads those records|The reading half is/.test(routingCommands + telemetryRef));

check('routing docs: Codex duration selects a kind before the snapshot and display',
  /^\| window \|.*Codex selects the kind from source duration.*seven days or longer.*`weekly`.*shorter positive duration.*`session`.*\|/m.test(glossary)
  && /\*\*6\. The snapshot\*\*.*Codex adapter chooses that name from source duration.*seven days or longer.*`weekly`.*shorter positive duration.*`session`/.test(adr)
  && /^A `kind` is a name.*Codex adapter selects its kind from source duration before writing the snapshot/m.test(cli)
  && /The length determines `kind`: seven days or longer is `weekly`/.test(guide));

check('routing docs: late-limit marks are read and clearable',
  /preflight reads this cache mark on the next routing decision/.test(lateLimit)
  && /A mark with a readable\s+reset expires at its reset time/.test(lateLimit)
  && /`promptobus models --clear-exhausted <harness>` clears a\s+reset-less mark\./.test(lateLimit));

check('routing docs: Claude inventory includes IDs, aliases and default at the binary version',
  /full (?:model )?IDs/i.test(inventory)
  && /aliases/.test(inventory)
  && /default\s+model/.test(inventory)
  && /The static inventory is independent of the binary's version label;\s+actual CLI\/API unavailable-model errors remain authoritative\./.test(inventory)
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

check('routing docs: named role overrides retain automatic roles and overlay prohibition',
  [guide, cli, orchestrate].every((text) => text.includes('role-not-rated-named')
    && /[Uu]nnamed routing/.test(text)
    && /[Oo]verlays (?:still )?cannot widen/.test(text)
    && /before (?:policy|filtering)/.test(text)
    && /subscription exhaustion/.test(text)
    && /PAYG/.test(text)));

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
