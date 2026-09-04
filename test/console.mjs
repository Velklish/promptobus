// Shared suite helper: console capture for the duration of a call.
// Not `*.test.mjs` — the runner (run.mjs) takes only those from the
// directory, so this file is not in the run.
//
// The helper was copied into fifteen files and drifted. The copies
// differed not only in return shape but in whether they had a bail-out,
// and only two of them carried it: `process.exit()` from `fail()`
// inside the code under test takes the process past `finally` — the
// console stays swapped forever, and the accumulated output goes
// nowhere. The file dies with an empty stdout in exactly the case the
// capture was created for: a person sees a failed test and not one
// line of diagnostics. Here the bail-out is one for every consumer.
//
// Three `console` methods are captured, not descriptors: the CLI writes
// through them (`info`/`warn`/`fail` in util.js), and suite verdicts
// go past the console, straight to descriptor 1 ([check.mjs](check.mjs))
// — so the capture does not swallow them.
import { writeSync } from 'node:fs';
import process from 'node:process';

// The bail-out prints from the `exit` handler, and it has to print
// past `console`: on macOS `process.stderr.write` into a pipe is
// async, and output from this handler is lost entirely — the same
// reason [check.mjs](check.mjs) writes past the console. EAGAIN on a
// full non-blocking pipe is not the end of the write, but a reason to
// finish the rest. The pause between write attempts is the same as in
// [check.mjs](check.mjs), and for the same reason: without it EAGAIN
// spins a hot loop, the process burns a core and gets in the way of
// the one who should drain the pipe. Here it is more expensive — the
// bail-out dumps the whole accumulated output at once. There is no
// event loop here at all (`exit` handler), nothing to yield a tick
// to — we sleep for real.
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

function writeErr(text) {
  const buf = Buffer.from(`${text}\n`);
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(2, buf, off);
    } catch (e) {
      if (e.code !== 'EAGAIN') return;
      Atomics.wait(PAUSE, 0, 0, 2);
    }
  }
}

// The return follows `fn`: a sync call stays sync, an async one
// returns a promise. Otherwise moving fifteen files onto a shared
// module would mean sprinkling `await` in a hundred-plus places,
// including expressions inside `check(...)` itself — a change three
// times the fix, at the same risk. Both branches end in the same
// console restore.
const isThenable = (v) => !!v && typeof v.then === 'function';
const after = (v, cb) => (isThenable(v) ? v.then(cb) : cb(v));

// Core. `onLog` — where `console.log` goes, `onErr` — `console.warn`
// and `console.error` (both stderr: a warning is the same kind of
// diagnostic as a refusal). `onErr === null` means "do not touch
// those two at all": warnings are sometimes the subject of a check,
// and muting them with the work log is pointless (`quietLog`).
function withConsole(fn, onLog, onErr) {
  const log = console.log, warn = console.warn, error = console.error;
  const seen = [];
  const restore = onErr
    ? () => { console.log = log; console.warn = warn; console.error = error; }
    : () => { console.log = log; };
  // Bail-out: diagnostics beat a clean stdout. The hook is removed
  // with the capture — otherwise output of a long-ago call would
  // reprint on process exit, whenever that happened, already as a
  // stray line.
  const bail = () => { restore(); if (seen.length) writeErr(seen.join('\n')); };
  const done = () => { restore(); process.off('exit', bail); };
  process.once('exit', bail);
  console.log = (m) => { seen.push(String(m)); onLog(String(m)); };
  if (onErr) {
    console.warn = (m) => { seen.push(String(m)); onErr(String(m)); };
    console.error = (m) => { seen.push(String(m)); onErr(String(m)); };
  }
  let value;
  try {
    value = fn();
  } catch (e) {
    done();
    throw e;
  }
  if (!isThenable(value)) { done(); return value; }
  return value.then((v) => { done(); return v; }, (e) => { done(); throw e; });
}

// `process.exit()` inside the code under test is `fail()`. The test
// must survive it and check the refusal itself, so for the duration
// of the call exit throws. The swap is restored to exactly what we
// found: suite files swap `process.exit` with a thrower for the whole
// file, and a restored "real" exit would lift that swap from
// everything below.
function withExit(fn) {
  const before = process.exit;
  process.exit = (code) => { const e = new Error(`EXIT:${code ?? ''}`); e.exitCode = code; throw e; };
  const back = () => { process.exit = before; };
  let value;
  try {
    value = fn();
  } catch {
    back();
    return { failed: true, value: undefined };
  }
  if (!isThenable(value)) { back(); return { failed: false, value }; }
  return value.then(
    (v) => { back(); return { failed: false, value: v }; },
    (e) => { back(); return { failed: true, value: undefined }; },
  );
}

// All output as one string — the most common form: the command print
// is the subject of the check.
export function capture(fn) {
  let out = '';
  const sink = (m) => { out += `${m}\n`; };
  return after(withConsole(fn, sink, sink), () => out);
}

// stdout separate from stderr. Needed where the subject is the split
// itself: diagnostics must not enter a substituted value (`a2a path`),
// and merging them would mean not checking at all.
export function captureSplit(fn) {
  let out = '', err = '';
  const ran = withConsole(fn, (m) => { out += `${m}\n`; }, (m) => { err += `${m}\n`; });
  return after(ran, (value) => ({ out, err, value }));
}

// Output is not needed at all — the return is. Accumulated output is
// still kept: the bail-out prints it if the code under test took the
// process.
export function quiet(fn) {
  return withConsole(fn, () => {}, () => {});
}

// Like `quiet`, but `console.warn` and `console.error` stay with the
// caller: warnings are sometimes the subject of a check, and muting
// them with the work log is pointless.
export function quietLog(fn) {
  return withConsole(fn, () => {}, null);
}

// Refusal of the code under test: `{ failed, out, value }`, where
// `out` is all output including stderr, because a refusal is printed
// there.
export function expectFail(fn) {
  let out = '';
  const sink = (m) => { out += `${m}\n`; };
  return after(withConsole(() => withExit(fn), sink, sink),
    (r) => ({ failed: r.failed, out, value: r.value }));
}

// The same with split streams — for commands whose stdout goes into
// a substitution.
export function expectFailSplit(fn) {
  let out = '', err = '';
  const ran = withConsole(() => withExit(fn), (m) => { out += `${m}\n`; }, (m) => { err += `${m}\n`; });
  return after(ran, (r) => ({ failed: r.failed, out, err, value: r.value }));
}

// A throw with no console at all: `planSpawn`/`planReview` refusals
// come as an exception, not through `fail()`. There were two copies,
// word for word.
//
// The class is taken from `constructor.name`, not `e.name`, and one
// cannot be swapped for the other: `class GateError extends Error {}`
// does not set a `name` field, and its `e.name` is "Error". A check
// on the class would then read the same name on any throw and stay
// silent always. The top-level catch in `bin/agents.js` recognises
// the expected error with the same expression — that is the subject
// of the check, so it stands here too.
export function expectThrow(fn) {
  try { fn(); return { threw: false, name: '', msg: '' }; } catch (e) { return { threw: true, name: e?.constructor?.name, msg: e.message }; }
}
