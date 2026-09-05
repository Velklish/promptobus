// Trap fixture for the package import scan. Never compiled: tsconfig.json includes
// only src. Every line below is either something a text pattern reads as a module
// specifier when it is not one, or a real specifier a text pattern loses.
//
// The order is the whole point: the real declarations sit AFTER the traps. A scanner
// that stops making sense of the file at the first trap reports none of them, and
// reports a confident green about a file it never finished reading.

import { readFileSync } from 'node:fs';

// The trap this fixture exists for. A message fragment, not an import: a scan for
// `from` next to a quote takes it for a specifier, and because that specifier ends at
// a `;` rather than a quote, everything after it is read from inside a string that
// never closes.
export const MESSAGE_FROM = ' from ';

// Regular expressions holding one quote each. A scanner that cannot tell a regex
// literal from division opens a string on the apostrophe and loses the file the same
// way.
const QUOTE = /'/g;
const DQUOTE = /"/g;
const SLASHED = /^refs\/remotes\/origin\//;

// A template literal holding quotes, an escape, and an interpolation that itself holds
// a regex with a quote and a nested template.
export const quoted = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

// A whole import statement inside a string, and two more inside comments.
export const SAMPLE = "import { x } from 'no-such-package';";
// import { y } from 'also-no-such-package';

/** A block comment with import { z } from 'nor-this-one'; inside it. */

import defaultExport, { basename } from 'node:path';
import * as os from 'node:os';
export type { Something } from './neighbour.js';
const lazy = () => import('./lazy.js');
const legacy = require('node:url');

export { MESSAGE_FROM as MARK, QUOTE, DQUOTE, SLASHED, defaultExport, basename, os, lazy, legacy };
