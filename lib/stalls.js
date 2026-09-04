// Words about a stalled participant — the ones shared by every harness. "Stalled",
// "LISTED", "GONE", and "DEAF" describe a state, not a tool, and therefore live here;
// the ROUTE after a stall — a command of a specific harness — arrives here as a ready
// string from that harness's driver.
//
// The module is a leaf on purpose: adapter builds the string when it prints
// `promptobus status` or answers `promptobus_mailbox`, and the warden journal uses the
// same words. If it lived on a driver, adapter would import the driver directly; if it
// lived on adapter, a driver would import adapter. A shared leaf removes both
// dependencies, and the channels cannot drift: there is one function.

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
