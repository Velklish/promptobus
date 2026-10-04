// Persist-session verdicts that refuse on an unread tmux list: the package's `tmuxSessions()`
// returns `[]` when tmux cannot be read, and "nothing left" would then pass on nothing.

/** The session list, or a throw naming why it was not read. */
export function requiredTmuxSessions(read, options = {}) {
  const { sessions, missing } = read(options);
  if (missing !== null || !Array.isArray(sessions)) {
    throw new Error(`tmux list-sessions: ${missing ?? 'the session list was not read'}`);
  }
  return sessions;
}

/** Green only when the list was read, no session was added since `before`, and none of `before` is gone. */
export function tmuxAbsenceVerdict(read, before = new Set(), options = {}) {
  const { sessions, missing } = read(options);
  if (missing !== null || !Array.isArray(sessions)) {
    return { ok: false, detail: missing ?? 'the session list was not read' };
  }
  const names = new Set(sessions.map((session) => session.name));
  const added = sessions.filter((session) => !before.has(session.name)).map((session) => session.name);
  const lost = [...before].filter((name) => !names.has(name));
  return {
    ok: added.length === 0 && lost.length === 0,
    detail: `added: ${added.join(', ') || 'none'} · gone: ${lost.join(', ') || 'none'}`
      + ` · was: ${[...before].join(', ') || 'none'}`,
  };
}
