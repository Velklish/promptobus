import fs from 'node:fs';

function waitFile(file, ms) {
  const edge = performance.now() + ms;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file) && performance.now() < edge) Atomics.wait(pause, 0, 0, 5);
  if (!fs.existsSync(file)) throw new Error(`transition schedule: missing ${file}`);
}

function publish(file, value) {
  fs.writeFileSync(`${file}.tmp`, value);
  fs.renameSync(`${file}.tmp`, file);
}

export function instrumentContender({ target, attempt, poised, resumed, late }) {
  const transition = fs.readFileSync(target, 'utf8');
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (...args) => {
    if (String(args[0]) !== transition || fs.existsSync(attempt)) return mkdir(...args);
    if (late) {
      publish(poised, 'before mkdir');
      waitFile(resumed, 8000);
    }
    let outcome = 'acquired';
    try { return mkdir(...args); } catch (error) { outcome = error.code; throw error; }
    finally { publish(attempt, outcome); }
  };
}

export function awaitContender({ late, poised, attempt }) {
  waitFile(late ? poised : attempt, 4000);
}

export function recordObservation({ attempt, resumed }, nativeStarted) {
  publish(resumed, JSON.stringify({ attempt: fs.existsSync(attempt) ? fs.readFileSync(attempt, 'utf8') : null,
    native: fs.existsSync(nativeStarted) }));
}
