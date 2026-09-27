import { check } from './check.mjs';
import { readFileSync } from 'node:fs';

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
