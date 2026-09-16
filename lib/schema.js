// Checking a published record against its own schema file, with no runtime dependency.
// Where the numbers come from: docs/reference/04-protocol.md § The gate record.

// Words that carry no constraint: present on a node, they change no verdict.
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$defs', 'examples']);

// Everything the reader implements. A schema keyword outside this set is a refusal to
// run rather than a silent pass: a schema that grew one would otherwise lose coverage.
const KEYWORDS = new Set([
  ...ANNOTATIONS,
  '$ref', 'type', 'const', 'required', 'properties', 'additionalProperties',
  'propertyNames', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'minimum', 'maximum', 'pattern', 'oneOf',
]);

// Shapes the reader implements only in their bare form. `$ref` and `oneOf` answer the whole
// node and drop its siblings; `items` is read as one schema, so the tuple form is not read.
function unsupportedShapes(node) {
  const constraints = Object.keys(node).filter((k) => !ANNOTATIONS.has(k));
  const out = [];
  for (const word of ['$ref', 'oneOf']) {
    if (Object.hasOwn(node, word) && constraints.length > 1) {
      out.push(`${word} beside ${constraints.filter((k) => k !== word).sort().join(', ')}`);
    }
  }
  if (Array.isArray(node.items)) out.push('items as a list of schemas');
  if (Array.isArray(node.type)) out.push('type as a list of names');
  return out;
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Where a schema holds another schema. `properties` and `$defs` are maps whose KEYS are
// names, so only their values are schemas; the rest hold one schema or a list of them.
function subschemas(node) {
  const out = [];
  if (isObject(node.properties)) out.push(...Object.values(node.properties));
  if (isObject(node.$defs)) out.push(...Object.values(node.$defs));
  if (isObject(node.additionalProperties)) out.push(node.additionalProperties);
  if (isObject(node.propertyNames)) out.push(node.propertyNames);
  if (isObject(node.items)) out.push(node.items);
  if (Array.isArray(node.oneOf)) out.push(...node.oneOf);
  return out;
}

/** What of this schema the reader does not implement — a keyword by name, or a shape of one
 * it reads only bare; sorted, and empty when the schema is covered whole. */
export function unsupportedKeywords(schema) {
  const unknown = new Set();
  const queue = [schema];
  while (queue.length) {
    const node = queue.pop();
    if (!isObject(node)) continue;
    for (const key of Object.keys(node)) if (!KEYWORDS.has(key)) unknown.add(key);
    for (const shape of unsupportedShapes(node)) unknown.add(shape);
    queue.push(...subschemas(node));
  }
  return [...unknown].sort();
}

function typeOk(type, value) {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function resolve(ref, root) {
  const name = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : null;
  const target = name ? root.$defs?.[name] : null;
  if (!target) throw new Error(`schema reference ${ref} does not resolve — only #/$defs/<name> is implemented`);
  return target;
}

function checkNode(node, value, at, root, errors) {
  if (typeof node.$ref === 'string') {
    checkNode(resolve(node.$ref, root), value, at, root, errors);
    return;
  }
  if (Array.isArray(node.oneOf)) {
    // The branch that came closest is the diagnosis: "matches none of two shapes" alone
    // leaves the author guessing which one they were aiming at.
    const tried = node.oneOf.map((branch) => {
      const own = [];
      checkNode(branch, value, at, root, own);
      return own;
    });
    const matched = tried.filter((own) => !own.length).length;
    if (matched !== 1) {
      const closest = tried.slice().sort((a, b) => a.length - b.length)[0] ?? [];
      errors.push({ at, note: `matches ${matched} of ${node.oneOf.length} allowed shapes, expected exactly one` });
      errors.push(...closest);
    }
    return;
  }
  if (typeof node.type === 'string' && !typeOk(node.type, value)) {
    errors.push({ at, note: `expected ${node.type}` });
    return;
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) {
    errors.push({ at, note: `expected ${JSON.stringify(node.const)}` });
    return;
  }
  if (typeof value === 'string') {
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) {
      errors.push({ at, note: `does not match grammar ${node.pattern}` });
    }
    if (Number.isInteger(node.minLength) && value.length < node.minLength) {
      errors.push({ at, note: `shorter than ${node.minLength} characters` });
    }
    if (Number.isInteger(node.maxLength) && value.length > node.maxLength) {
      errors.push({ at, note: `longer than ${node.maxLength} characters` });
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) errors.push({ at, note: `below ${node.minimum}` });
    if (typeof node.maximum === 'number' && value > node.maximum) errors.push({ at, note: `above ${node.maximum}` });
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(node.minItems) && value.length < node.minItems) {
      errors.push({ at, note: `fewer than ${node.minItems} entries` });
    }
    if (Number.isInteger(node.maxItems) && value.length > node.maxItems) {
      errors.push({ at, note: `more than ${node.maxItems} entries` });
    }
    if (isObject(node.items)) {
      value.forEach((item, i) => checkNode(node.items, item, `${at}/${i}`, root, errors));
    }
  }
  if (isObject(value)) checkObject(node, value, at, root, errors);
}

// A field holding `undefined` is an absent field, as the reference reads it: a parsed
// document cannot hold one, and a hand-built fixture must not get a second verdict.
function checkObject(node, value, at, root, errors) {
  for (const key of node.required ?? []) {
    if (value[key] === undefined) errors.push({ at: `${at}/${key}`, note: 'required field is missing' });
  }
  for (const [key, own] of Object.entries(value)) {
    if (own === undefined) continue;
    const where = `${at}/${key}`;
    // The whole subschema judges the NAME, not its `pattern` alone: a bound or a `$ref`
    // beside it would otherwise be read as no constraint at all.
    if (isObject(node.propertyNames)) {
      const named = [];
      checkNode(node.propertyNames, key, where, root, named);
      for (const fault of named) errors.push({ at: fault.at, note: `field name ${fault.note}` });
    }
    const declared = node.properties?.[key];
    if (declared) {
      checkNode(declared, own, where, root, errors);
      continue;
    }
    if (node.additionalProperties === false) {
      errors.push({ at: where, note: 'field the schema does not define' });
      continue;
    }
    if (isObject(node.additionalProperties)) checkNode(node.additionalProperties, own, where, root, errors);
  }
}

/**
 * Where the document breaks its schema: `{ at, note }` per fault, empty — it is accepted.
 * A schema the reader does not fully implement throws instead of answering: a partial
 * verdict presented as a pass is the failure this check exists against.
 */
export function schemaErrors(schema, document) {
  const unknown = unsupportedKeywords(schema);
  if (unknown.length) {
    throw new Error(`schema ${schema.$id ?? '(unnamed)'} uses what this reader does not implement: `
      + `${unknown.join('; ')} — the check cannot be given as a verdict`);
  }
  const errors = [];
  checkNode(schema, document, '', schema, errors);
  return errors;
}

/** The faults as one line, for a refusal a person reads. */
export function sayErrors(errors) {
  return errors.map(({ at, note }) => `${at || '(document)'}: ${note}`).join('; ');
}
