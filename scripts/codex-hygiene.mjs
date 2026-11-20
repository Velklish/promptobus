import { processProbe } from '../test/process-probe.mjs';
import { codexConfigSha } from './codex-config.mjs';

const PATTERNS = ['Caskroom/codex', 'app-server --stdio'];

export function readCodexHygiene(file, { read, run } = {}) {
  let sha;
  try {
    sha = codexConfigSha(file, read);
  } catch (error) {
    const code = error?.code ? ` (${error.code})` : '';
    throw new Error(`could not hash ${file}${code}: ${error?.message ?? error}`, { cause: error });
  }
  const pids = PATTERNS.map((pattern) => processProbe('pgrep', ['-f', pattern], run)
    .trim().split('\n').filter(Boolean));
  return { sha, pids };
}

export function checkCodexHygiene(file, before, check, io) {
  let after;
  try {
    after = readCodexHygiene(file, io);
  } catch (error) {
    check('Codex hygiene observed after cleanup', false, error.message);
    return { ok: false };
  }

  const sha = `${before.sha ?? '(none)'} → ${after.sha ?? '(none)'}`;
  check('personal ~/.codex/config.toml did not change over the run (sha)', before.sha === after.sha, sha);
  let processesClear = true;
  for (const [index, pattern] of PATTERNS.entries()) {
    const extra = after.pids[index].filter((pid) => !before.pids[index].includes(pid));
    if (extra.length) processesClear = false;
    check(`no new ${pattern} processes after the loop`, extra.length === 0, extra.join(' | '));
  }
  const summary = [`sha config.toml: ${sha}`, ...PATTERNS.map((pattern, index) =>
    `pgrep ${pattern}: was ${before.pids[index].length}, became ${after.pids[index].length}`)].join('\n');
  return { ok: processesClear && before.sha === after.sha, summary };
}
