// Local gate: the Codex protocol fixtures are a citation, and a citation is worth its version
// tag. Red when the installed binary is a version the fixtures were not taken from (`PB-242`).
// No binary on this machine means nothing to compare — CI has none, so that path exits 0.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { PROVEN_CODEX_VERSION } from '../lib/driver-codex.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'codex-app-server')
const say = (s) => process.stdout.write(`${s}\n`)

const dir = path.join(FIXTURES, PROVEN_CODEX_VERSION)
if (!existsSync(dir)) {
  say(`✖ no fixtures for the proven version ${PROVEN_CODEX_VERSION}`)
  say(`  regenerate: codex app-server generate-json-schema --out ${dir}`)
  process.exit(1)
}

let installed = null
try {
  installed = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
} catch {
  say(`✔ codex is not installed here — nothing to compare; fixtures stay at ${PROVEN_CODEX_VERSION}`)
  process.exit(0)
}

// `codex --version` prints `codex-cli <semver>`; the number is what the fixtures are named by.
const version = installed.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null
if (!version) {
  say(`✖ cannot read a version out of \`codex --version\`: ${JSON.stringify(installed)}`)
  process.exit(1)
}

if (version === PROVEN_CODEX_VERSION) {
  const files = readdirSync(dir).length
  say(`✔ codex ${version} matches the fixtures (${files} schema files in ${path.relative(ROOT, dir)})`)
  process.exit(0)
}

say(`✖ codex ${version} is installed, the fixtures were taken from ${PROVEN_CODEX_VERSION}`)
say(`  the suite would stay green about a protocol this machine no longer speaks`)
say(`  remeasure: codex app-server generate-json-schema --out ${path.join(FIXTURES, version)}`)
say(`  then set PROVEN_CODEX_VERSION in lib/driver-codex.js to ${version}`)
process.exit(1)
