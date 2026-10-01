import { check } from './check.mjs';
import { canonicalSkillOverrides } from '../lib/codex-session.js';

const root = '/fixture/private-home/skills';
const listed = { data: [{ skills: [
  { name: 'same', path: `${root}/same/SKILL.md`, scope: 'user' },
  { name: 'same', path: '/fixture/personal/alias/SKILL.md', scope: 'user' },
  { name: 'unrelated', path: '/fixture/personal/unrelated/SKILL.md', scope: 'user' },
  { name: 'same', path: '/fixture/system/same/SKILL.md', scope: 'system' },
] }] };
const disabled = canonicalSkillOverrides(listed, root);
check('canonical skill content wins by exact listed personal path even with a different folder name',
  JSON.stringify(disabled) === JSON.stringify([{ path: '/fixture/personal/alias/SKILL.md', enabled: false }]));
check('a worker project copy suppresses its colliding user skill',
  canonicalSkillOverrides({ data: [{ skills: [
    { name: 'same', path: '/fixture/worktree/.codex/skills/same/SKILL.md', scope: 'repo' },
    { name: 'same', path: '/fixture/personal/same/SKILL.md', scope: 'user' },
  ] }] }, '/fixture/worktree/.codex/skills').length === 1);
check('a sibling directory cannot masquerade as the canonical directory',
  canonicalSkillOverrides({ data: [{ skills: [
    { name: 'same', path: `${root}-personal/same/SKILL.md`, scope: 'user' },
  ] }] }, root).length === 0);
check('without a loaded canonical copy no personal skill is suppressed',
  canonicalSkillOverrides({ data: [{ skills: [listed.data[0].skills[1]] }] }, root).length === 0);
