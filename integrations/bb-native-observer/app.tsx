import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useRealtimeConnectionState, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract, View } from './contract.js';
import { actorActivity, displayTime, messageLabel, retainSample, sampleStale, visibleMessages, type MessageFilter } from './dashboard.js';
import { poll } from './poll.js';

const styles = `
.pb-dashboard{--pb-bg:var(--background,#171717);--pb-card:var(--card,#202020);--pb-line:var(--border,#363636);--pb-text:var(--foreground,#eee);--pb-muted:var(--muted-foreground,#aaa);height:100%;overflow:auto;background:var(--pb-bg);color:var(--pb-text);font:14px/1.5 system-ui,sans-serif}
.pb-wrap{max-width:1180px;margin:auto;padding:24px;display:grid;gap:20px}
.pb-toolbar,.pb-heading,.pb-meta,.pb-tabs{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.pb-toolbar{justify-content:space-between}.pb-heading{align-items:flex-start;justify-content:space-between}
.pb-heading h1{font-size:25px;letter-spacing:-.04em;margin:2px 0 4px;font-weight:650}

.pb-muted,.pb-caption{color:var(--pb-muted)}.pb-caption{font-size:12px}.pb-dashboard p{margin:4px 0}
.pb-dashboard button,.pb-dashboard select,.pb-dashboard input{font:inherit;color:inherit;background:var(--pb-card);border:1px solid var(--pb-line);border-radius:7px;padding:7px 10px}
.pb-dashboard button{cursor:pointer}.pb-dashboard button:hover{border-color:#888}.pb-dashboard button:disabled{cursor:default;opacity:.5}
.pb-dashboard button:focus-visible,.pb-dashboard select:focus-visible,.pb-dashboard input:focus-visible{outline:2px solid #8cadff;outline-offset:2px}
.pb-dashboard ::selection{background:#8cadff;color:#171717}.pb-dashboard{scrollbar-color:var(--pb-muted) var(--pb-bg)}.pb-stat strong{font-variant-numeric:tabular-nums}.pb-dashboard select{max-width:min(420px,100%)}
.pb-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:99px;font-size:12px;background:#ffffff09;border:1px solid var(--pb-line);white-space:nowrap}
.pb-pill::before{content:'';width:6px;height:6px;border-radius:50%;background:#8d8d8d}
.pb-pill.active::before{background:#8cabf8}.pb-pill.done::before{background:#7ab899}.pb-pill.unknown::before{background:#d2ab66}
.pb-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(250px,1fr);gap:18px}.pb-stack{display:grid;gap:12px;align-content:start}
.pb-card{background:var(--pb-card);border:1px solid var(--pb-line);border-radius:12px;padding:18px;min-width:0}
.pb-card h2{font-size:15px;margin:0 0 12px;font-weight:650}.pb-card h3{font-size:14px;margin:0}
.pb-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.pb-stat{border-left:1px solid var(--pb-line);padding-left:12px}
.pb-stat strong{display:block;font-size:25px;line-height:1.2;font-weight:600}.pb-stat span{font-size:12px;color:var(--pb-muted)}
.pb-section-title{display:flex;justify-content:space-between;align-items:center;gap:10px}.pb-actors{display:grid;gap:10px}
.pb-actor{padding:12px 0;border-bottom:1px solid var(--pb-line)}.pb-actor-head{display:flex;justify-content:space-between;gap:10px;align-items:start;flex-wrap:wrap}
.pb-actor details{margin-top:8px}.pb-dashboard summary{cursor:pointer;color:var(--pb-muted);font-size:12px}
.pb-definition{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-size:12px;margin:8px 0 0}.pb-definition dt{color:var(--pb-muted)}.pb-definition dd{margin:0;overflow-wrap:anywhere}
.pb-tabs{gap:4px;border-bottom:1px solid var(--pb-line);margin-bottom:14px;padding-bottom:10px}
.pb-tabs button{border-color:transparent;background:transparent;padding:5px 9px;font-size:12px}.pb-tabs button[aria-pressed=true]{background:#ffffff0d;border-color:var(--pb-line)}
.pb-message{padding:14px 0;border-bottom:1px solid var(--pb-line)}.pb-message:first-child{padding-top:0}.pb-message:last-child{border-bottom:0;padding-bottom:0}
.pb-message-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.pb-message-body{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0;max-height:360px;overflow:auto}
.pb-type{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--pb-muted)}.pb-empty{padding:24px 6px;text-align:center;color:var(--pb-muted)}
.pb-notice{border:1px solid #8d733d;background:#a8811910;border-radius:9px;padding:12px 14px;font-size:13px}
.pb-diagnostics pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto}.pb-limits{margin:8px 0 0;padding-left:18px;font-size:12px;color:var(--pb-muted)}
@media(max-width:760px){.pb-wrap{padding:16px;gap:14px}.pb-grid{grid-template-columns:minmax(0,1fr)}.pb-toolbar{align-items:stretch}.pb-toolbar label,.pb-toolbar select{width:100%;max-width:100%}.pb-heading h1{font-size:22px}.pb-card{padding:14px}.pb-stats{gap:8px}.pb-stat strong{font-size:22px}}
`;

function NativePanel() {
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState();
  const [connected, setConnected] = useState(true), [view, setView] = useState<View | null>(null);
  const [selectedId, setSelectedId] = useState(''), [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null), [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MessageFilter>('all'), [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const snapshot = view?.snapshot, tasks = view?.catalogue?.tasks ?? [];
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!connected || selecting) return;
    const current = generation.current;
    return poll(() => rpc.call('view', null), value => {
      if (current !== generation.current) return;
      setView(previous => retainSample(previous, value)); setSelectedId(value.configuration.taskId); setError(null); setNow(Date.now());
    }, cause => { if (current === generation.current) setError(String(cause)); });
  }, [rpc, connected, connection, selecting]);
  async function selectTask(taskId: string) {
    generation.current++;
    setSelecting(true); setSelectedId(taskId); setView(null); setFilter('all'); setActionError(null); setError(null);
    try { await rpc.call('selectTask', { taskId }); }
    catch (cause) { setActionError(String(cause)); }
    finally { setSelecting(false); }
  }
  function toggleObserver() {
    generation.current++;
    setConnected(!connected);
  }
  const messages = snapshot ? visibleMessages(snapshot.messages, filter) : [];
  const questions = snapshot?.messages.filter(message => message.type === 'question').length ?? 0;
  const results = snapshot ? visibleMessages(snapshot.messages, 'results').length : 0;
  const snapshotError = error || view?.snapshotError;
  const stale = !connected || Boolean(snapshotError) || connection !== 'connected' || Boolean(snapshot && sampleStale(snapshot.sampledAt, now));
  return <main className="pb-dashboard">
    <style>{styles}</style>
    <div className="pb-wrap">
      <div className="pb-toolbar">
        <label className="pb-caption">Task <select aria-label="Selected task" value={selectedId} disabled={selecting || !connected} onChange={event => void selectTask(event.target.value)}>
          {!tasks.some(task => task.id === selectedId) && <option value={selectedId}>{selectedId || 'Select a task'}</option>}
          {tasks.map(task => <option key={task.id} value={task.id}>{task.title || task.id} · {task.state}</option>)}
        </select></label>
        <button onClick={toggleObserver}>{connected ? 'Disconnect observer' : 'Reconnect observer'}</button>
      </div>
      <header className="pb-heading">
        <div><h1>{snapshot?.task.title || selectedId || 'Your development workspace'}</h1>
          <p className="pb-caption">{snapshot?.task.id || 'Choose a task to see its work'}{snapshot && ` · Updated ${displayTime(snapshot.task.updated)}`}</p></div>
        <span className={`pb-pill ${snapshot?.task.state === 'done' ? 'done' : 'active'}`}>{snapshot?.task.state ?? (selecting ? 'Switching task' : view?.snapshotError ? 'Snapshot unavailable' : view ? 'No task selected' : 'Loading')}</span>
      </header>
      {view && <dl className="pb-definition" aria-label="Selected store identity"><dt>Host</dt><dd>{view.configuration.hostId}</dd><dt>Store</dt><dd>{view.configuration.storeRoot}</dd><dt>Native registry</dt><dd>{view.configuration.nativeRoot}</dd></dl>}
      {(snapshotError || actionError) && <div className="pb-notice" role="alert">{actionError || snapshotError}{snapshotError && snapshot && <p>The view below is the last successful sample.</p>}</div>}
      {view?.catalogueError && <div className="pb-notice" role="alert">Task discovery failed: {view.catalogueError}. The selected snapshot is read independently.</div>}
      {view?.catalogue?.truncated && <p className="pb-notice">Task discovery stopped at 256 valid tasks or 4096 scanned entries. More tasks may exist; the selected task is still read independently.</p>}
      {!connected && <div className="pb-notice">Observer disconnected. Native work continues independently; the view is paused.</div>}
      <div className="pb-meta pb-caption"><span className={`pb-pill ${stale ? 'unknown' : 'active'}`}>{stale ? 'View paused or stale' : view ? `Observer · ${connection}` : 'Connecting observer'}</span><span>Last successful sample: {displayTime(snapshot?.sampledAt)}</span></div>
      <section className="pb-card pb-stats" aria-label="Task summary">
        <div className="pb-stat"><strong>{snapshot?.actors.length ?? '—'}</strong><span>Managed participants</span></div>
        <div className="pb-stat"><strong>{questions}</strong><span>Questions in recent messages</span></div>
        <div className="pb-stat"><strong>{results}</strong><span>Results & reviews in recent messages</span></div>
      </section>
      <div className="pb-grid">
        <section className="pb-card">
          <h2>Messages & outcomes</h2>
          <div className="pb-tabs" aria-label="Message filters">{(['all', 'questions', 'results'] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All messages' : value === 'questions' ? 'Questions' : 'Results & reviews'}</button>)}</div>
          {!snapshot && <p className="pb-empty">{selecting ? 'Switching task…' : view?.snapshotError ? 'Selected snapshot unavailable. Choose another task above, or reconnect after fixing its records.' : view && !view.configuration.taskId ? (tasks.length ? 'Select a task above to see its work.' : 'No tasks found in the configured store.') : 'Waiting for a task snapshot…'}</p>}
          {snapshot && messages.length === 0 && <p className="pb-empty">No {filter === 'all' ? 'messages' : filter} in the recent task journal.</p>}
          {messages.map(message => <article className="pb-message" key={message.id}>
            <div className="pb-message-header"><div><strong>{message.sender}</strong><span className="pb-caption"> → {message.recipients.join(', ')}</span></div><span className="pb-type">{messageLabel(message, snapshot?.actors ?? [])}</span></div>
            <pre className="pb-message-body">{message.body}</pre>
            {message.artifact && <p className="pb-caption">Artifact: {message.artifact}</p>}
            {message.bodyTruncated && <p className="pb-caption">Preview shortened. The canonical message retains the full body.</p>}
            <p className="pb-caption">{displayTime(message.created)} · {message.id}</p>
          </article>)}
          <p className="pb-caption" style={{ marginTop: 16 }}>Canonical messages are shown as recorded, with their participant IDs. A participant result is not owner acceptance.</p>
        </section>
        <aside className="pb-stack">
          <section className="pb-card">
            <div className="pb-section-title"><h2>Managed participants</h2><span className="pb-caption">Promptobus sessions</span></div>
            <div className="pb-actors">{snapshot?.actors.map(actor => {
              const activity = actorActivity(actor);
              return <article className="pb-actor" key={actor.address}>
                <div className="pb-actor-head"><div><h3>{actor.address}</h3><p className="pb-caption">{actor.role} · {actor.harness}</p></div><span className={`pb-pill ${activity.tone}`}>{activity.label}</span></div>
                <p className="pb-caption">{actor.model || 'Model not recorded'}{actor.effort ? ` · ${actor.effort}` : ''}</p>
                <details><summary>Session details</summary><dl className="pb-definition"><dt>Canonical ID</dt><dd>{actor.participantId}</dd><dt>Session reference</dt><dd>{actor.sessionRef || 'Unavailable'}</dd><dt>Native thread</dt><dd>{actor.threadId || 'Unavailable'}</dd><dt>Launch</dt><dd>{actor.launchId || (actor.state === 'native launch binding unavailable' ? 'Canonical launch binding unavailable' : 'Unavailable')}</dd><dt>Profile</dt><dd>{actor.sandbox || 'Unavailable'}</dd><dt>Registry state</dt><dd>{actor.state}</dd>{actor.commands && <><dt>Selected commands</dt><dd>{actor.commands.terminals} terminal events / {actor.commands.starts} starts{actor.commands.incompleteTail ? ' · incomplete receipt tail' : ''}</dd></>}</dl></details>
              </article>;
            })}</div>
            {snapshot?.actors.length === 0 && <p className="pb-empty">No managed native participants in this task.</p>}
            <p className="pb-caption" style={{ marginTop: 12 }}>These are native sessions, not BB threads. Recorded activity does not prove OS process liveness. Full native transcripts and command output are unavailable.</p>
          </section>
          <section className="pb-card">
            <h2>Task owner</h2>
            <p>{snapshot?.task.owner?.id ?? 'Owner unavailable'}</p>
            <p className="pb-caption">{snapshot?.task.owner?.harness}</p>
            <dl className="pb-definition"><dt>Session</dt><dd>{snapshot?.task.owner?.sessionRef ?? 'Unavailable'}</dd></dl>
            <p className="pb-caption">Results and reviews are recorded messages. Owner acceptance is not inferred from them.</p>
          </section>
        </aside>
      </div>
      <details className="pb-card pb-diagnostics"><summary>Diagnostics & evidence limits</summary>
        <ul className="pb-limits">{snapshot?.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
        <pre data-testid="snapshot">{snapshot ? JSON.stringify(snapshot, null, 2) : 'No successful sample'}</pre>
      </details>
    </div>
  </main>;
}
export default definePluginApp(app => {
  app.slots.navPanel({ id: 'native-panel', title: 'Promptobus', icon: 'Activity', path: 'promptobus-native-panel', component: NativePanel });
});
