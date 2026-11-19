import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useBbContext, useBbNavigate, useRealtimeConnectionState, useRpc } from '@get-bb/plugin-sdk/app';
import type { Board, PieceHistory, rpcContract, Source, SourcedBoard, View } from './contract.js';
import { columnsOf, displayTime, historyMessages, messageLabel, pieceSignals, relativeAge, retainSample, sameSource, samePiece, sampleStale, showsPiece, threadNote, type HistoryFilter } from './dashboard.js';
import { poll } from './poll.js';

type Run = Board['runs'][number];
type Opened = { taskId: string; slug: string; source: Source };

const styles = `
.pb-dashboard{--pb-bg:var(--background,#171717);--pb-card:var(--card,#202020);--pb-track:#ffffff06;--pb-line:var(--border,#363636);--pb-text:var(--foreground,#eee);--pb-muted:var(--muted-foreground,#aaa);--pb-accent:#8cadff;--pb-warn:#d2ab66;height:100%;overflow:auto;background:var(--pb-bg);color:var(--pb-text);font:14px/1.5 system-ui,sans-serif}
.pb-wrap{padding:24px;display:grid;gap:22px}
.pb-toolbar,.pb-heading,.pb-meta,.pb-tabs,.pb-signals{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.pb-heading{align-items:flex-start;justify-content:space-between}
.pb-heading h1{font-size:25px;letter-spacing:-.03em;margin:0 0 4px;font-weight:650}
.pb-muted,.pb-caption{color:var(--pb-muted)}.pb-caption{font-size:12px}.pb-dashboard p{margin:4px 0}
.pb-dashboard button,.pb-dashboard select,.pb-dashboard input{font:inherit;color:inherit;background:var(--pb-card);border:1px solid var(--pb-line);border-radius:7px;padding:7px 10px}
.pb-dashboard button{cursor:pointer;transition:border-color .15s ease-out,background-color .15s ease-out}.pb-dashboard button:hover{border-color:#888}.pb-dashboard button:disabled{cursor:default;opacity:.5}
.pb-dashboard button:focus-visible,.pb-dashboard select:focus-visible,.pb-dashboard input:focus-visible,.pb-dashboard summary:focus-visible{outline:2px solid var(--pb-accent);outline-offset:2px}
.pb-dashboard ::selection{background:var(--pb-accent);color:#171717}.pb-dashboard{scrollbar-color:var(--pb-muted) var(--pb-bg)}.pb-dashboard select{max-width:min(420px,100%)}
.pb-primary{background:var(--pb-accent)!important;border-color:var(--pb-accent)!important;color:#141821!important;font-weight:600}.pb-primary:hover{filter:brightness(1.08)}
.pb-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:99px;font-size:12px;background:#ffffff09;border:1px solid var(--pb-line);white-space:nowrap;font-variant-numeric:tabular-nums}
.pb-pill::before{content:'';width:6px;height:6px;border-radius:50%;background:#8d8d8d}
.pb-pill.active::before{background:#8cabf8}.pb-pill.done::before{background:#7ab899}.pb-pill.unknown::before,.pb-pill.warning::before{background:var(--pb-warn)}.pb-pill.warning{border-color:#8d733d;color:#e9cf9e}
.pb-lane{display:grid;gap:12px;padding-bottom:22px;border-bottom:1px solid var(--pb-line)}.pb-lane:last-of-type{border-bottom:0}
.pb-lane-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.pb-lane-head h2{font-size:17px;letter-spacing:-.02em;margin:0;font-weight:650}
.pb-columns{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(210px,1fr);gap:10px;overflow-x:auto;padding-bottom:4px}
.pb-column{background:var(--pb-track);border-radius:10px;padding:10px;display:grid;gap:8px;align-content:start;min-height:96px}
.pb-column-head{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--pb-muted);padding:0 2px 2px;text-transform:capitalize}
.pb-column-head strong{font-weight:600;color:var(--pb-text)}
.pb-piece{display:grid!important;gap:6px;text-align:left;width:100%;padding:11px 12px!important;border-radius:10px!important;background:var(--pb-card)!important;box-shadow:0 1px 2px #0000004d}
.pb-piece[aria-pressed=true]{border-color:var(--pb-accent)!important;box-shadow:0 0 0 1px var(--pb-accent) inset,0 1px 2px #0000004d}
.pb-piece-slug{font-weight:600;overflow-wrap:anywhere}.pb-piece-status{font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.pb-piece-foot{display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap}.pb-signals{gap:4px}
.pb-column-empty{font-size:12px;color:var(--pb-muted);padding:8px 2px}
.pb-section{background:var(--pb-card);border:1px solid var(--pb-line);border-radius:12px;padding:16px 18px}
.pb-section>summary{cursor:pointer;font-weight:600}.pb-section[open]>summary{margin-bottom:12px}.pb-dashboard summary{color:var(--pb-text)}
.pb-finished{display:grid;gap:2px;margin:0;padding:0;list-style:none}.pb-finished li{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--pb-line);font-size:13px}.pb-finished li:last-child{border-bottom:0}
.pb-definition{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-size:12px;margin:8px 0 0}.pb-definition dt{color:var(--pb-muted)}.pb-definition dd{margin:0;overflow-wrap:anywhere}
.pb-tabs{gap:4px;border-bottom:1px solid var(--pb-line);padding-bottom:10px}
.pb-tabs button{border-color:transparent;background:transparent;padding:5px 9px;font-size:12px}.pb-tabs button[aria-pressed=true]{background:#ffffff0d;border-color:var(--pb-line)}
.pb-message{padding:14px 0;border-bottom:1px solid var(--pb-line)}.pb-message:last-child{border-bottom:0}
.pb-message-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.pb-message-body{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0;max-height:320px;overflow:auto}
.pb-type{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--pb-muted)}.pb-empty{padding:24px 6px;text-align:center;color:var(--pb-muted)}
.pb-notice{border:1px solid #8d733d;background:#a8811910;border-radius:9px;padding:12px 14px;font-size:13px}
.pb-drawer{position:fixed;top:0;right:0;bottom:0;width:min(480px,100%);background:var(--pb-bg);border-left:1px solid var(--pb-line);box-shadow:-12px 0 32px #00000059;display:grid;grid-template-rows:auto auto minmax(0,1fr);z-index:10;animation:pb-in .2s cubic-bezier(.16,1,.3,1)}
@keyframes pb-in{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.pb-drawer{animation:none}.pb-dashboard button{transition:none}}
.pb-drawer-head{padding:18px 20px 14px;border-bottom:1px solid var(--pb-line);display:grid;gap:10px}
.pb-drawer-title{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.pb-drawer-title h2{font-size:19px;letter-spacing:-.02em;margin:0;overflow-wrap:anywhere}
.pb-drawer-tabs{padding:10px 20px 0}.pb-drawer-body{overflow:auto;padding:0 20px 20px}
.pb-diagnostics pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto}.pb-limits{margin:8px 0 0;padding-left:18px;font-size:12px;color:var(--pb-muted)}
.pb-settings{display:grid;gap:14px}.pb-settings label{display:grid;gap:4px}
@media(max-width:760px){.pb-wrap{padding:16px;gap:16px}.pb-heading h1{font-size:22px}.pb-columns{grid-auto-columns:minmax(78%,1fr)}.pb-toolbar select{width:100%;max-width:100%}}
`;

function PieceCard({ run, piece, selected, now, open }: { run: Run; piece: Run['pieces'][number]; selected: boolean; now: number; open: () => void }) {
  const holder = piece.holder, signals = pieceSignals(piece);
  return <button className="pb-piece" data-piece={`${run.id}/${piece.slug}`} aria-pressed={selected}
    aria-label={`${piece.slug} in ${run.title || run.id}${piece.unfinishedDelivery ? ' · Unfinished delivery' : ''}`} onClick={open}>
    <span className="pb-piece-slug">{piece.slug}</span>
    <span className="pb-caption">{holder ? `${holder.role} · ${holder.model ?? holder.harness}` : piece.step === null ? 'Finished' : 'Waiting for a participant'}</span>
    {holder?.status && <span className="pb-piece-status">{holder.status.line || 'Empty status'}</span>}
    <span className="pb-piece-foot">
      <span className="pb-caption">{holder?.status ? relativeAge(holder.status.at, now) : 'No status yet'}</span>
      {signals.length > 0 && <span className="pb-signals">{signals.map(signal => <span key={signal.label} className={`pb-pill ${signal.tone}`}>{signal.label}</span>)}</span>}
    </span>
  </button>;
}

function PieceDrawer({ run, piece, history, error, now, close }: { run: Run; piece: Run['pieces'][number]; history: PieceHistory | null; error: string | null; now: number; close: () => void }) {
  const navigate = useBbNavigate(), [filter, setFilter] = useState<HistoryFilter>('all'), closeButton = useRef<HTMLButtonElement>(null);
  const holder = piece.holder, messages = history ? historyMessages(history.messages, filter) : [];
  const roles = piece.participants.map(entry => ({ participantId: entry.participantId, role: entry.step }));
  useEffect(() => { closeButton.current?.focus(); }, [run.id, piece.slug]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return <aside className="pb-drawer" aria-label={`Piece ${piece.slug}`}>
    <div className="pb-drawer-head">
      <div className="pb-drawer-title"><div><h2>{piece.slug}</h2><p className="pb-caption">{run.title || run.id}</p></div>
        <button ref={closeButton} onClick={close} aria-label="Close piece details">Close</button></div>
      <div className="pb-meta"><span className={`pb-pill ${piece.step === null ? 'done' : 'active'}`}>{piece.step ?? 'Done'}</span>
        {pieceSignals(piece).map(signal => <span key={signal.label} className={`pb-pill ${signal.tone}`}>{signal.label}</span>)}</div>
      {piece.unfinishedDelivery && <p className="pb-caption">A message to or from this piece still has an open delivery intent.</p>}
      {holder ? <>
        <dl className="pb-definition"><dt>Participant</dt><dd>{holder.address}</dd><dt>Harness</dt><dd>{holder.harness}{holder.model ? ` · ${holder.model}` : ''}</dd>
          <dt>Last status</dt><dd>{holder.status ? `${relativeAge(holder.status.at, now)} · ${holder.status.line}` : 'None yet'}</dd>
          {holder.stall && <><dt>Stall</dt><dd>{holder.stall}</dd></>}
          {!holder.bbThreadId && <><dt>Session</dt><dd>{holder.sessionRef ?? 'Not recorded'}</dd></>}</dl>
        {holder.bbThreadId
          ? <div><button className="pb-primary" onClick={() => navigate.toThread(holder.bbThreadId!)}>Open thread</button></div>
          : <p className="pb-caption">{threadNote(holder)}</p>}
      </> : <p className="pb-caption">No participant holds the {piece.step} step of this piece yet.</p>}
      <dl className="pb-definition" aria-label="Participants by step">{piece.participants.map(entry => <Fragment key={entry.step}><dt>{entry.step}</dt><dd>{entry.participantId}</dd></Fragment>)}</dl>
    </div>
    <div className="pb-drawer-tabs"><div className="pb-tabs" aria-label="History filters">{(['all', 'work', 'status', 'questions'] as const).map(value =>
      <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value === 'work' ? 'Briefs & results' : value === 'status' ? 'Status' : 'Questions'}</button>)}</div></div>
    <div className="pb-drawer-body" aria-live="polite">
      {error && <p className="pb-notice" role="alert">History unavailable: {error}</p>}
      {history?.notice && <p className="pb-notice">{history.notice}</p>}
      {!history && !error && <p className="pb-empty">Reading the piece history…</p>}
      {history && messages.length === 0 && <p className="pb-empty">No {filter === 'all' ? '' : 'matching '}messages {history.notice ? 'in this sample' : 'for this piece yet'}.</p>}
      {messages.slice().reverse().map(message => <article className="pb-message" key={message.id}>
        <div className="pb-message-header"><div><strong>{message.sender}</strong><span className="pb-caption"> → {message.recipients.join(', ')}</span></div><span className="pb-type">{messageLabel(message, roles)}</span></div>
        <pre className="pb-message-body">{message.body}</pre>
        {message.artifact && <p className="pb-caption">Artifact: {message.artifact}</p>}
        {message.bodyTruncated && <p className="pb-caption">Preview shortened. The canonical message keeps the full body.</p>}
        <p className="pb-caption">{displayTime(message.created)} · {message.id}</p>
      </article>)}
      {history && <p className="pb-caption">Up to 64 sampled messages to or from this piece's participants, newest first.</p>}
    </div>
  </aside>;
}

function NativePanel() {
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState(), context = useBbContext();
  const [ownerThreadId, setOwnerThreadId] = useState(context.threadId ?? ''), [bindingOwner, setBindingOwner] = useState(false);
  const [connected, setConnected] = useState(true), [view, setView] = useState<View | null>(null), [board, setBoard] = useState<SourcedBoard | null>(null);
  const [selectedId, setSelectedId] = useState(''), [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null), [boardError, setBoardError] = useState<string | null>(null), [actionError, setActionError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [history, setHistory] = useState<PieceHistory | null>(null), [historyError, setHistoryError] = useState<{ piece: Opened; text: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const closePiece = useCallback(() => setOpened(previous => {
    // The card may have moved column and remounted, so it is found again by its run and slug.
    if (previous) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-piece="${CSS.escape(`${previous.taskId}/${previous.slug}`)}"]`)?.focus());
    return null;
  }), []);
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
      setView(previous => retainSample(previous, value)); setSelectedId(value.configuration.taskId); setError(null);
    }, cause => { if (current === generation.current) setError(String(cause)); });
  }, [rpc, connected, connection, selecting]);
  useEffect(() => {
    if (!connected) return;
    return poll(() => rpc.call('board', null), value => {
      // A piece this board no longer shows, from another source or a run that left, closes its panel and history poll.
      setBoard(value); setBoardError(null); setOpened(previous => previous && !showsPiece(value, previous) ? null : previous);
    }, cause => setBoardError(String(cause)), 2000);
  }, [rpc, connected, connection]);
  useEffect(() => {
    setHistory(null); setHistoryError(null);
    if (!opened || !connected) return;
    return poll(() => rpc.call('pieceHistory', opened), value => {
      if (samePiece(value, opened)) { setHistory(value); setHistoryError(null); }
    }, cause => setHistoryError({ piece: opened, text: String(cause) }), 2000);
  }, [rpc, connected, opened]);
  async function selectTask(taskId: string) {
    generation.current++;
    setSelecting(true); setSelectedId(taskId); setView(null); setActionError(null); setError(null);
    try { await rpc.call('selectTask', { taskId }); }
    catch (cause) { setActionError(String(cause)); }
    finally { setSelecting(false); }
  }
  async function bindOwner(enabled: boolean) {
    if (!view?.configuration.taskId) return;
    setBindingOwner(true); setActionError(null);
    try {
      const taskId = view.configuration.taskId;
      await rpc.call('bindOwner', enabled ? { taskId, threadId: ownerThreadId, enabled: true } : { taskId, enabled: false });
    }
    catch (cause) { setActionError(String(cause)); }
    finally { setBindingOwner(false); }
  }
  function toggleObserver() {
    generation.current++;
    setConnected(!connected);
  }
  const active = board?.runs.filter(run => run.state === 'active') ?? [], finished = board?.runs.filter(run => run.state === 'done') ?? [];
  const openRun = opened && board && sameSource(board.source, opened.source) && board.runs.find(run => run.id === opened.taskId), openPiece = openRun && openRun.pieces.find(piece => piece.slug === opened.slug);
  const stale = !connected || Boolean(boardError) || connection !== 'connected' || Boolean(board && sampleStale(board.sampledAt, now));
  return <main className="pb-dashboard">
    <style>{styles}</style>
    <div className="pb-wrap">
      <header className="pb-heading">
        <div><h1>Promptobus runs</h1>
          <p className="pb-caption">{board ? `${active.length} active · ${finished.length} finished · sampled ${displayTime(board.sampledAt)}` : 'Reading the configured store…'}</p></div>
        <div className="pb-toolbar"><span className={`pb-pill ${stale ? 'unknown' : 'active'}`}>{stale ? 'View paused or stale' : `Observer · ${connection}`}</span>
          <button onClick={toggleObserver}>{connected ? 'Pause observer' : 'Resume observer'}</button></div>
      </header>
      {(boardError || actionError) && <div className="pb-notice" role="alert">{actionError || boardError}{boardError && board && <p>The board below is the last successful sample.</p>}</div>}
      {board?.truncated && <p className="pb-notice">Run discovery reached its limit of 256 runs, 4096 scanned entries or 8 MiB of task records. More runs may exist.</p>}
      {!connected && <div className="pb-notice">Observer paused. Runs continue on their own; the board is not refreshing.</div>}
      {board && active.length === 0 && <p className="pb-empty">{board.truncated ? 'No active runs among the runs discovery reached.' : 'No active runs in the configured store. A run appears here as soon as Promptobus starts one.'}</p>}
      {active.map(run => <section className="pb-lane" key={run.id} aria-label={run.title || run.id}>
        <div className="pb-lane-head"><h2>{run.title || run.id}</h2>
          <span className="pb-caption">{run.id}{run.owner ? ` · owner on ${run.owner}` : ''} · updated {relativeAge(run.updated, now)}</span></div>
        {run.inferred && <p className="pb-caption">Step order inferred: this run has no recorded pipeline. Extra steps follow the shipped ones in the order their participants appear.</p>}
        {run.notice && <p className="pb-notice">{run.notice} Step placement and message signals may be incomplete.</p>}
        {run.error && <p className="pb-notice" role="alert">{run.error}</p>}
        {!run.error && run.pieces.length === 0 && <p className="pb-caption">No pieces yet: the orchestrator has not handed work to a step.</p>}
        {run.pieces.length > 0 && <div className="pb-columns">{columnsOf(run).map(column => <div className="pb-column" key={column.label}>
          <div className="pb-column-head"><strong>{column.label}</strong><span>{column.pieces.length}</span></div>
          {column.pieces.map(piece => <PieceCard key={piece.slug} run={run} piece={piece} now={now}
            selected={opened?.taskId === run.id && opened.slug === piece.slug} open={() => board && setOpened({ taskId: run.id, slug: piece.slug, source: board.source })} />)}
          {column.pieces.length === 0 && <p className="pb-column-empty">Nothing here</p>}
        </div>)}</div>}
      </section>)}
      {finished.length > 0 && <details className="pb-section"><summary>Finished runs ({finished.length})</summary>
        <ul className="pb-finished">{finished.map(run => <li key={run.id}><span>{run.title || run.id}</span><span className="pb-caption">{displayTime(run.updated)}</span></li>)}</ul>
      </details>}
      <details className="pb-section"><summary>Owner notifications</summary>
        <div className="pb-settings">
          <label className="pb-caption">Run to watch<select aria-label="Run to watch" value={selectedId} disabled={selecting || !connected} onChange={event => void selectTask(event.target.value)}>
            {!tasks.some(task => task.id === selectedId) && <option value={selectedId}>{selectedId || 'Select a run'}</option>}
            {tasks.map(task => <option key={task.id} value={task.id}>{task.title || task.id} · {task.state}</option>)}
          </select></label>
          {(error || view?.snapshotError) && <p className="pb-notice" role="alert">{error || view?.snapshotError}</p>}
          {view?.catalogueError && <p className="pb-notice" role="alert">Run discovery failed: {view.catalogueError}</p>}
          <label className="pb-caption">BB owner thread<input aria-label="BB owner thread" placeholder="thr_…" value={ownerThreadId} onChange={event => setOwnerThreadId(event.target.value)} /></label>
          <div className="pb-toolbar"><button disabled={bindingOwner || !view?.configuration.taskId || !ownerThreadId} onClick={() => void bindOwner(true)}>Connect owner notifications</button>
            {view?.wake.enabled && <button disabled={bindingOwner} onClick={() => void bindOwner(false)}>Disable owner notifications</button>}</div>
          <p className="pb-caption">Notifications: {view?.wake.state ?? 'Unknown'}{view?.wake.ownerThreadId ? ` · ${view.wake.ownerThreadId}` : ''}</p>
          {view?.wake.error && <p className="pb-notice" role="alert">{view.wake.error}</p>}
          <p className="pb-caption">New questions, results and reviews of the watched run can wake the bound BB owner even while this panel is closed. Existing messages are not replayed.</p>
          <dl className="pb-definition"><dt>Owner</dt><dd>{snapshot?.task.owner?.id ?? 'Unavailable'}{snapshot?.task.owner?.harness ? ` · ${snapshot.task.owner.harness}` : ''}</dd><dt>Session</dt><dd>{snapshot?.task.owner?.sessionRef ?? 'Unavailable'}</dd>
            {view && <><dt>Host</dt><dd>{view.configuration.hostId}</dd><dt>Store</dt><dd>{view.configuration.storeRoot}</dd><dt>Native registry</dt><dd>{view.configuration.nativeRoot}</dd></>}</dl>
        </div>
      </details>
      <details className="pb-section pb-diagnostics"><summary>Diagnostics & evidence limits</summary>
        <ul className="pb-limits">{[...(board?.limits ?? []), ...(snapshot?.limits ?? [])].map(limit => <li key={limit}>{limit}</li>)}</ul>
        <pre data-testid="board">{board ? JSON.stringify(board, null, 2) : 'No successful board sample'}</pre>
        <pre data-testid="snapshot">{snapshot ? JSON.stringify(snapshot, null, 2) : 'No watched-run sample'}</pre>
      </details>
    </div>
    {openRun && openPiece && <PieceDrawer run={openRun} piece={openPiece} history={samePiece(history, opened) ? history : null}
      error={samePiece(historyError?.piece, opened) ? historyError!.text : null} now={now} close={closePiece} />}
  </main>;
}
export default definePluginApp(app => {
  app.slots.navPanel({ id: 'native-panel', title: 'Promptobus', icon: 'Activity', path: 'promptobus-native-panel', component: NativePanel });
});
