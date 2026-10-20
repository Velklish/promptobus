import { realpathSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { REVIEWER } from '../dist/index.js';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0');
const absolute = value => text(value) && path.isAbsolute(value);
const skillName = value => text(value) && value !== '.' && value !== '..' && !/[\\/]/.test(value);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function exact(value, keys, label) {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label}`);
}
function refs(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} requires an array of context references`);
  return value.map(ref => {
    if (ref?.kind === 'skill') {
      exact(ref, ['kind', 'name'], label);
      if (!skillName(ref.name)) throw new Error(`${label} requires a skill directory name`);
      return { kind: 'skill', name: ref.name };
    }
    exact(ref, ['kind', 'path'], label);
    if (!['rule', 'resource'].includes(ref.kind) || !absolute(ref.path)) throw new Error(`${label} requires an exact absolute rule/resource path`);
    return { kind: ref.kind, path: path.resolve(ref.path) };
  });
}

export function normalizeContextDeclaration(value) {
  exact(value, ['skills', 'resources'], 'task context declaration');
  if (!Array.isArray(value.skills) || !Array.isArray(value.resources)) throw new Error('Task context declaration requires skills and resources arrays');
  const names = new Set(), paths = new Set();
  const skills = value.skills.map(skill => {
    exact(skill, ['name', 'reason', 'requires'], 'declared skill');
    if (!skillName(skill.name) || !text(skill.reason)) throw new Error('Declared skills require a directory name and reason');
    if (names.has(skill.name)) throw new Error(`Duplicate declared skill: ${skill.name}`);
    names.add(skill.name);
    return { name: skill.name, reason: skill.reason, ...(skill.requires === undefined ? {} : { requires: refs(skill.requires, `Declared skill ${skill.name}`) }) };
  });
  const resources = value.resources.map(resource => {
    exact(resource, ['path', 'reason', 'requires'], 'declared resource');
    if (!absolute(resource.path) || !text(resource.reason)) throw new Error('Declared resources require an exact absolute path and reason');
    const file = path.resolve(resource.path);
    if (paths.has(file)) throw new Error(`Duplicate declared resource: ${file}`);
    paths.add(file);
    return { path: file, reason: resource.reason, ...(resource.requires === undefined ? {} : { requires: refs(resource.requires, `Declared resource ${file}`) }) };
  });
  return freeze({ skills, resources });
}

export function selectParticipantContext(host, { root, role, task, preparedSelection: prepared }) {
  const declaration = task?.context === undefined ? undefined : normalizeContextDeclaration(task.context);
  if (typeof host.selectParticipantContext !== 'function') {
    if (prepared) throw new Error('Host context selector disappeared; prepare context again');
    if (declaration) throw new Error('Explicit task context declaration requires Host selector support');
    return null;
  }
  if (!task || !text(task.id) || !['technical', 'user-facing', 'author-voice'].includes(task.purpose)) {
    throw new Error('Selected Host context requires an explicit task identity and purpose');
  }
  const selectedTask = freeze({ id: task.id, purpose: task.purpose, ...(declaration ? { context: declaration } : {}) });
  if (prepared && !isDeepStrictEqual(prepared.task, selectedTask)) throw new Error('Host context task selection changed; prepare context again');
  const selected = host.selectParticipantContext({ repoDir: root, role, task: selectedTask });
  if (!selected || !Array.isArray(selected.rules) || !Array.isArray(selected.skills) || !Array.isArray(selected.resources === undefined ? [] : selected.resources)) {
    throw new Error('Host context selection requires rules and skills arrays and optional resources array');
  }
  for (const rule of selected.rules) {
    if (!record(rule) || !absolute(rule.path) || !text(rule.reason) || !Array.isArray(rule.requires === undefined ? [] : rule.requires) || (rule.requires ?? []).some(file => !absolute(file))) {
      throw new Error('Selected Host rules require absolute paths, a reason and exact required paths');
    }
  }
  const requiredBy = file => selected.rules.find(rule => rule.requires?.some(required => path.resolve(required) === path.resolve(file)))?.path;
  const canonical = (file, parent) => {
    try { return realpathSync(file); } catch (failure) {
      const source = parent ?? requiredBy(file);
      throw new Error(`${source ? `Required Host context ${source} -> ${file}` : `Selected Host resource ${file}`} unavailable: ${failure.message}`);
    }
  };
  const regular = (file, parent) => {
    const result = canonical(file, parent);
    if (!statSync(result).isFile()) throw new Error(`Selected Host resource is not a file: ${result}`);
    return result;
  };
  const ruleMap = new Map(), skillMap = new Map(), resourceMap = new Map();
  for (const rule of selected.rules) {
    const file = regular(rule.path), requires = (rule.requires ?? []).map(required => canonical(required, file));
    const prior = ruleMap.get(file);
    if (prior) prior.requires = [...new Set([...prior.requires, ...requires])];
    else ruleMap.set(file, { path: file, reason: rule.reason, requires: [...new Set(requires)] });
  }
  const canonicalRefs = (value, parent) => refs(value === undefined ? [] : value, parent).map(ref => ref.kind === 'skill' ? ref : { kind: ref.kind, path: canonical(ref.path, parent) });
  const addSkill = skill => {
    if (!record(skill) || !skillName(skill.name) || !absolute(skill.root) || !text(skill.reason)) throw new Error('Selected Host skills require a name, an absolute root and a reason');
    const sourceRoot = path.resolve(skill.root), directory = canonical(sourceRoot);
    if (!statSync(directory).isDirectory()) throw new Error(`Selected Host skill root is not a directory: ${directory}`);
    const prior = skillMap.get(skill.name), requires = canonicalRefs(skill.requires, `skill ${skill.name}`);
    if (prior && (prior.root !== directory || prior.sourceRoot !== sourceRoot)) throw new Error(`Ambiguous selected Host skill ${skill.name}: ${prior.sourceRoot}, ${sourceRoot}`);
    if (prior) prior.requires.push(...requires);
    else skillMap.set(skill.name, { name: skill.name, root: directory, sourceRoot, reason: skill.reason, requires });
  };
  selected.skills.forEach(addSkill);
  const module = host.resolveRepoModule(root), reviewSkill = role === REVIEWER && module?.meta?.review?.skill;
  if (reviewSkill) addSkill({ name: reviewSkill, root: host.reviewSkillDir(reviewSkill, root), reason: 'Required module review skill' });
  for (const resource of selected.resources ?? []) {
    if (!record(resource) || !absolute(resource.path) || !text(resource.reason)) throw new Error('Selected Host resources require an exact absolute path and reason');
    const sourcePath = path.resolve(resource.path), file = regular(sourcePath), requires = canonicalRefs(resource.requires, `resource ${file}`);
    const prior = resourceMap.get(file);
    if (prior && prior.sourcePath !== sourcePath) throw new Error(`Ambiguous selected Host resource: ${prior.sourcePath}, ${sourcePath}`);
    if (prior) prior.requires.push(...requires);
    else resourceMap.set(file, { path: file, sourcePath, reason: resource.reason, requires });
  }
  const notAdmitted = (kind, address) => {
    const parent = [...skillMap.values(), ...resourceMap.values()].find(node => node.requires.some(ref => ref.kind === kind && (ref.name ?? ref.path) === address));
    return new Error(`Required Host context ${parent?.name ?? parent?.path ?? `task ${task.id}`} -> ${address} is not admitted by Host policy`);
  };
  for (const skill of declaration?.skills ?? []) {
    const admitted = skillMap.get(skill.name);
    if (!admitted) throw notAdmitted('skill', skill.name);
    admitted.requires.push(...canonicalRefs(skill.requires, `skill ${skill.name}`));
  }
  for (const resource of declaration?.resources ?? []) {
    const file = canonical(resource.path, `resource ${resource.path}`), admitted = resourceMap.get(file);
    if (!admitted) throw notAdmitted('resource', file);
    admitted.requires.push(...canonicalRefs(resource.requires, `resource ${resource.path}`));
  }
  for (const rule of ruleMap.values()) for (const dependency of rule.requires) {
    if (!ruleMap.has(dependency)) throw new Error(`Required Host rule ${rule.path} -> ${dependency} is missing from selected rules; select the full closure and prepare context again`);
  }
  for (const node of [...skillMap.values(), ...resourceMap.values()]) {
    node.requires = [...new Map(node.requires.map(ref => [JSON.stringify(ref), ref])).values()];
    for (const ref of node.requires) {
      const present = ref.kind === 'skill' ? skillMap.has(ref.name) : (ref.kind === 'rule' ? ruleMap : resourceMap).has(ref.path);
      if (!present) throw new Error(`Required Host context ${node.name ?? node.path} -> ${ref.name ?? ref.path} is missing from selected ${ref.kind}s; select the full closure and prepare context again`);
    }
  }
  const selection = { task: selectedTask, rules: [...ruleMap.values()], skills: [...skillMap.values()], resources: [...resourceMap.values()] };
  if (prepared) {
    for (const rule of selection.rules) if (!prepared.rules.some(prior => prior.path === rule.path)) throw new Error(`Host context selection expanded to ${rule.path}; prepare context again`);
    for (const skill of selection.skills) if (!prepared.skills.some(prior => prior.name === skill.name && prior.root === skill.root && (!prior.sourceRoot || prior.sourceRoot === skill.sourceRoot))) {
      throw new Error(`Host context selection expanded to skill ${skill.root}; prepare context again`);
    }
    for (const resource of selection.resources) if (!(prepared.resources ?? []).some(prior => prior.path === resource.path && (!prior.sourcePath || prior.sourcePath === resource.sourcePath))) {
      throw new Error(`Host context selection expanded to resource ${resource.path}; prepare context again`);
    }
  }
  for (const skill of selection.skills) {
    const file = regular(path.join(skill.root, 'SKILL.md'), `skill ${skill.name}`), relative = path.relative(skill.root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Selected Host skill instructions escape their root: ${file}`);
  }
  return freeze(selection);
}
