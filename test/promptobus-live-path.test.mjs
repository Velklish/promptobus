// Regression probe for the live-script PATH boundary. Run: npm test
//
// The live scripts are deliberately not imported: importing either one starts a
// real run. The probe checks their source after exercising the resolver contract.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { resolveToolBin } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const liveE2e = readFileSync(path.join(here, '..', 'scripts', 'live-e2e.mjs'), 'utf8');
const liveCanary = readFileSync(path.join(here, '..', 'scripts', 'live-canary.mjs'), 'utf8');
const tool = resolveToolBin('node');

check('sandbox resolver returns a PATH name, not an install path',
  tool.ok && tool.path === 'node' && path.dirname(tool.path) === '.', JSON.stringify(tool));
check('live-e2e does not prepend the resolver result to PATH',
  !/(?:\bbinDir\b|process\.env\.PATH\s*=)/.test(liveE2e) && !/local\/bin/.test(liveE2e), liveE2e);
check('live-canary does not prepend the resolver result to PATH',
  !/(?:\bclaudeBin\b|\bbinDir\b|process\.env\.PATH\s*=)/.test(liveCanary) && !/local\/bin/.test(liveCanary), liveCanary);
