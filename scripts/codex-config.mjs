// The person's `~/.codex/config.toml` before and after a live run. Codex rewrites two timestamps of
// `[marketplaces.*]` in the background, with no run at all; those two lines are left out of the hash.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MARKETPLACE_CHURN = /^\s*(?:last_updated|last_revision)\s*=/;

/** The config text without marketplace refresh timestamps; every other line stays. */
function codexConfigText(text) {
  let marketplace = false;
  return String(text).split('\n').filter((line) => {
    const header = /^\s*\[\[?\s*([^\]]*)\]/.exec(line);
    if (header) marketplace = /^"?marketplaces"?\s*\./.test(header[1].trim());
    return header || !marketplace || !MARKETPLACE_CHURN.test(line);
  }).join('\n');
}

/** sha256 of the normalised text, or `null` when there is no file to read. */
export function codexConfigSha(file) {
  try {
    return createHash('sha256').update(codexConfigText(readFileSync(file, 'utf8'))).digest('hex');
  } catch {
    return null;
  }
}
