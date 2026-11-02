import { check } from './check.mjs';
import { standaloneResumeId } from '../lib/standalone-root.js';

const id = 'c7f03247-bf56-4fb2-a8f3-020b3be77cde';
for (const args of [['resume', id], ['--no-daemon', 'resume', id], ['exec', 'resume', id]]) {
  check('documented concrete Codex resume argv selects the exact ID', standaloneResumeId('codex', args) === id);
}
for (const args of [['--resume', id], ['-r', id]]) {
  check('documented concrete Claude resume argv selects the exact ID', standaloneResumeId('claude', args) === id);
}
for (const args of [['resume'], ['resume', '--last'], ['resume', 'friendly-name'], ['exec', 'resume', '--last'], ['--', 'resume', id]]) {
  check('Codex picker latest name and literal prompt are not concrete owner intent', standaloneResumeId('codex', args) === null);
}
for (const args of [['--continue'], ['--resume'], ['--', '--resume', id], ['--append-system-prompt', '--resume', id],
  ['--resume', id, '--fork-session'], ['--model', 'sonnet', '--resume', id]]) {
  check('Claude implicit selection option values fork and unclassified ordering cannot authorize reassignment', standaloneResumeId('claude', args) === null);
}
