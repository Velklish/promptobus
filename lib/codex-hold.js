#!/usr/bin/env node
// Detached holder of the `codex app-server --stdio` process. The driver starts it
// after writing the session: CLI spawn does not outlive the first turn, and someone
// must hold the stdio app-server. Body — [codex-session.js](codex-session.js) `holdMain`.
import { holdMain } from './codex-session.js';

await holdMain(process.argv.slice(2));
