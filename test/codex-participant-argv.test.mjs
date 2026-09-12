// PB-170: the participant argv, and the ORDER in it — 03-cli § The Codex holder.
// `includes(flag)` is green on the broken form, so every assertion is about position.
import { check } from './check.mjs';
import { PARTICIPANT_ARGV } from '../lib/codex-session.js';

const FLAG = '--dangerously-bypass-hook-trust';
const SUB = 'app-server';

{
  check(': the participant argv carries the hook-trust bypass at all',
    PARTICIPANT_ARGV.includes(FLAG), JSON.stringify(PARTICIPANT_ARGV));
}

{
  // `['app-server', '--stdio', FLAG]` has both strings; only the order tells them apart.
  const flagAt = PARTICIPANT_ARGV.indexOf(FLAG);
  const subAt = PARTICIPANT_ARGV.indexOf(SUB);
  check(': the bypass flag precedes the subcommand — codex rejects it after `app-server`',
    flagAt >= 0 && subAt >= 0 && flagAt < subAt, JSON.stringify({ PARTICIPANT_ARGV, flagAt, subAt }));
}

{
  // The subcommand's own arguments live after it, and `--stdio` is one of them.
  const subAt = PARTICIPANT_ARGV.indexOf(SUB);
  check(': `--stdio` stays after the subcommand it belongs to',
    PARTICIPANT_ARGV.indexOf('--stdio') > subAt, JSON.stringify(PARTICIPANT_ARGV));
}

{
  // One constant, so the holder's `spawn` and the driver's plan cannot drift apart.
  check(': the argv is exactly the three tokens, in that order',
    JSON.stringify(PARTICIPANT_ARGV) === JSON.stringify([FLAG, SUB, '--stdio']),
    JSON.stringify(PARTICIPANT_ARGV));
}
