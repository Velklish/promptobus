export function extractNodeTestVerdictNames(raw: unknown) {
  const names: string[] = [];
  const incomplete = (reason: string) => ({ complete: false, names, reason });
  if (typeof raw !== 'string' || !raw.trim()) return incomplete('Raw test output is missing.');
  const counts: Record<string, number> = {};
  let duration = false;
  for (const line of raw.split('\n')) {
    if (line.startsWith('✔ ')) {
      const verdict = /^✔ (.+) \((\d+(?:\.\d+)?)ms\)$/.exec(line);
      if (!verdict || Object.keys(counts).length || duration) return incomplete('Unsupported test verdict or footer order.');
      names.push(verdict[1]);
    } else if (line.startsWith('ℹ ')) {
      const count = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
      if (count) {
        if (duration) return incomplete('Unsupported Node spec footer order.');
        if (Object.hasOwn(counts, count[1])) return incomplete('Multiple test footers are unsupported.');
        counts[count[1]] = Number(count[2]);
      } else if (/^ℹ duration_ms \d+(?:\.\d+)?$/.test(line)) {
        if (Object.keys(counts).length !== 7 || duration) return incomplete('Unsupported Node spec footer order.');
        duration = true;
      } else {
        return incomplete('Unsupported Node spec information.');
      }
    } else if (/^(?:TAP version |(?:not )?ok \d+\b|\d+\.\.\d+\b)/.test(line)) {
      return incomplete('TAP output is unsupported.');
    } else if (/^[✖▶↷]/u.test(line)) {
      return incomplete('Failed, skipped or nested test formats are unsupported.');
    } else if (Object.keys(counts).length && !duration && line.trim()) {
      return incomplete('Unsupported Node spec footer order.');
    }
  }
  if (Object.keys(counts).length !== 7 || !duration) return incomplete('A complete test footer is missing.');
  if (counts.suites || counts.fail || counts.cancelled || counts.skipped || counts.todo) {
    return incomplete('Only a flat passing Node spec scope is supported.');
  }
  if (counts.tests !== names.length || counts.pass !== names.length) {
    return incomplete('Test footer counts do not match raw verdict occurrences.');
  }
  return { complete: true, names, reason: null };
}
