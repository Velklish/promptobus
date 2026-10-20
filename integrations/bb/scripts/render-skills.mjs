import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BB_ROLE_SKILLS, renderBbInstructionSkill } from 'promptobus/instructions';

const check = process.argv.includes('--check');
for (const [role, name] of Object.entries(BB_ROLE_SKILLS)) {
  const dir = new URL(`../skills/${name}/`, import.meta.url);
  const file = new URL('SKILL.md', dir);
  const text = `---\nname: ${name}\ndescription: Promptobus ${role} duties in BB with authenticated runtime bindings.\n---\n\n${renderBbInstructionSkill(role).trimEnd()}\n`;
  if (check) {
    if (readFileSync(file, 'utf8') !== text) throw new Error(`Skill differs from the exported renderer: ${name}`);
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
  }
}
