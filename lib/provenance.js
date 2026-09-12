import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

function textOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function issueText(error) {
  const text = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return text.replace(/\s+/g, ' ').trim() || 'unknown error';
}

function readOwnPackage() {
  try {
    const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
    const version = textOrNull(packageJson.version);
    return {
      path: PACKAGE_PATH,
      version,
      issue: version ? null : 'package.json has no version',
    };
  } catch (error) {
    return {
      path: PACKAGE_PATH,
      version: null,
      issue: `cannot read package.json: ${issueText(error)}`,
    };
  }
}

const OWN_PACKAGE = readOwnPackage();

function packageValue(provenance) {
  if (provenance.packagePath && provenance.packageVersion) {
    return `${provenance.packagePath}@${provenance.packageVersion}`;
  }
  if (provenance.packagePath) {
    return `${provenance.packagePath}@unresolved (${provenance.packageIssue ?? 'version unavailable'})`;
  }
  return `unresolved (${provenance.packageIssue ?? 'package path unavailable'})`;
}

// Provenance names the executing location and reported release, not exact code identity.
// Different revisions at one path and version therefore remain indistinguishable.
export function launchProvenance(host, tool = {}) {
  let mechanismPath = null;
  let mechanismPathIssue = null;
  if (typeof host?.binPath !== 'function') {
    mechanismPathIssue = 'host.binPath unavailable';
  } else {
    try {
      mechanismPath = textOrNull(host.binPath());
      if (!mechanismPath) mechanismPathIssue = 'host.binPath returned an empty path';
    } catch (error) {
      mechanismPathIssue = `host.binPath failed: ${issueText(error)}`;
    }
  }
  return {
    mechanismPath,
    mechanismPathIssue,
    mechanismVersion: textOrNull(host?.version),
    packagePath: OWN_PACKAGE.path,
    packageVersion: OWN_PACKAGE.version,
    packageIssue: OWN_PACKAGE.issue,
    hostVersion: textOrNull(host?.version),
    binaryPath: textOrNull(tool?.bin),
    binaryVersion: textOrNull(tool?.version),
  };
}

export function provenanceLine(provenance = {}) {
  const cli = provenance.mechanismPath
    ?? `unresolved (${provenance.mechanismPathIssue ?? 'path not recorded'})`;
  return `promptobus copy: cli=${cli} package=${packageValue(provenance)} `
    + `host=${provenance.hostVersion ?? 'unknown'} `
    + `participant=${provenance.binaryPath ?? 'unknown'} `
    + `version=${provenance.binaryVersion ?? 'unknown'}`;
}

export function provenanceFromRecord(record = {}) {
  return {
    mechanismPath: record.mechanismPath,
    mechanismPathIssue: record.mechanismPathIssue,
    mechanismVersion: record.mechanismVersion,
    packagePath: record.packagePath ?? OWN_PACKAGE.path,
    packageVersion: record.packageVersion ?? OWN_PACKAGE.version,
    packageIssue: record.packageIssue ?? OWN_PACKAGE.issue,
    hostVersion: record.hostVersion,
    binaryPath: record.binaryPath ?? record.bin,
    binaryVersion: record.binaryVersion,
  };
}
