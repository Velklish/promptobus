#!/usr/bin/env node
// Detached holder of `codex app-server --stdio`: a CLI spawn does not outlive the first turn.
// Body — [codex-session.js](codex-session.js) `holdMain`; [03-cli.md § The Codex holder](../docs/reference/03-cli.md#the-codex-holder).
import { holdMain } from './codex-session.js';

await holdMain(process.argv.slice(2));
