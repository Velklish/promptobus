// The same trap with a real external import after it. The gate must report `zod`:
// a scanner that stops at the trap passes this file, and that silent pass is the
// failure the trap fixture exists to prevent.

import { readFileSync } from 'node:fs';

export const MESSAGE_FROM = ' from ';

import { parse } from 'zod';

export { readFileSync, parse };
