#!/usr/bin/env node
// Отсоединённый держатель процесса `codex app-server --stdio`. Запускает его driver
// после записи сессии: CLI spawn не переживает первый ход, а stdio app-server должен
// кто-то держать. Тело — [codex-session.js](codex-session.js) `holdMain`.
import { holdMain } from './codex-session.js';

await holdMain(process.argv.slice(2));
