// Parsing a harness session state into a stall the bus can report.
// The kinds and what each means: [reference/03-cli.md#stall-parsing](../docs/reference/03-cli.md#stall-parsing)

/** Line about a stalled participant. `route` is what to do, in that harness's words. */
export function stallLine(s, route) {
  // "Stalled", "listed", "gone", and "deaf" are four states with no shared word:
  // "stalled" would promise a session that will unstick, and a deaf one is running
  // and does not know it.
  const what = s.kind === 'stale'
    ? `LISTED, but no process behind it: ${s.reason}`
    : s.kind === 'gone'
      ? `GONE: ${s.reason}`
      : s.kind === 'wake-taken'
        ? `DEAF: ${s.reason}`
        : `stalled: ${s.reason}`;
  return `${s.address} ${what} — session ${s.id ?? s.ref}; ${route}`;
}

// "Until the stall is cleared" is said only where the stall really is cleared: a dead
// record has nothing to clear, and promising return of its messages would be a lie.
export function stallTail(stalled) {
  const forever = stalled.some((s) => s.kind === 'stale' || s.kind === 'gone');
  return `no messages from them${forever ? '' : ' until the stall is cleared'}: `
    + 'each has its own route, named in its line.';
}
