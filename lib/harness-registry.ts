import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { GateError, pidAlive } from '../dist/index.js';
import { writeJsonAtomic } from '../dist/fs/atomic.js';
import { harnessStateHome } from './harness-home.js';
import { provenanceFromRecord, provenanceLine } from './provenance.js';

export interface HarnessSessionRecord {
  ref: string;
  provenance?: string | null;
  mechanismPath?: string | null; mechanismPathIssue?: string | null; mechanismVersion?: string | null;
  packagePath?: string | null; packageVersion?: string | null; packageIssue?: string | null;
  hostVersion?: string | null; binaryPath?: string | null; binaryVersion?: string | null; bin?: string | null;
  [key: string]: unknown;
}
interface RegistryOptions<T extends HarnessSessionRecord> {
  harness?: string; sidecars?: (ref: string, env: NodeJS.ProcessEnv) => string[];
  onDrop?: (record: T, env: NodeJS.ProcessEnv) => void;
}

export function sessionKey(ref: unknown) {
  const flat = String(ref ?? '');
  const head = flat.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  const hash = createHash('sha1').update(flat).digest('hex').slice(0, 12);
  return head ? `${head}-${hash}` : hash;
}

export function createHarnessRegistry<T extends HarnessSessionRecord = HarnessSessionRecord>({ harness, sidecars = () => [], onDrop = () => {} }: RegistryOptions<T> = {}) {
  if (!harness) throw new TypeError('harness registry needs a harness name');

  const stateHome = (env = process.env) => harnessStateHome(harness, env);
  const sessionsDir = (env = process.env) => path.join(stateHome(env), 'sessions');
  const sessionFile = (ref: string, env = process.env) => path.join(sessionsDir(env), `${sessionKey(ref)}.json`);

  function readSession(ref: string, env = process.env): T | null {
    try {
      return JSON.parse(readFileSync(sessionFile(ref, env), 'utf8'));
    } catch (e) {
      if (e instanceof GateError) throw e;
      return null;
    }
  }

  function writeSession(record: T, env = process.env) {
    mkdirSync(sessionsDir(env), { recursive: true, mode: 0o700 });
    const { provenance, ...rest } = record;
    return writeJsonAtomic(sessionFile(record.ref, env), {
      provenance: provenance ?? provenanceLine(provenanceFromRecord(record)),
      ...rest,
    }, { mode: 0o600 });
  }

  function patchSession(ref: string, patch: Partial<T>, env = process.env) {
    const was = readSession(ref, env);
    if (!was) return null;
    return writeSession({ ...was, ...patch }, env);
  }

  function dropSession(ref: string, env = process.env) {
    const record = readSession(ref, env);
    for (const file of [sessionFile(ref, env), ...sidecars(ref, env)]) {
      rmSync(file, { force: true });
    }
    if (record) onDrop(record, env);
  }

  function registrySessions(env = process.env): T[] {
    let names;
    try {
      names = readdirSync(sessionsDir(env));
    } catch (e) {
      if (e instanceof GateError) throw e;
      return [];
    }
    return names.filter((name) => name.endsWith('.json')).map((name) => {
      try {
        return JSON.parse(readFileSync(path.join(sessionsDir(env), name), 'utf8'));
      } catch {
        return null;
      }
    }).filter(Boolean) as T[];
  }

  return {
    harness,
    stateHome,
    sessionsDir,
    sessionKey,
    sessionFile,
    readSession,
    writeSession,
    patchSession,
    dropSession,
    registrySessions,
    pidAlive,
  };
}
