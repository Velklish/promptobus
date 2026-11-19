# Codex app-server contracts and evidence

The 0.158.0 and 0.170.0 directories contain generated contracts for the minimum and
selected Codex versions. The 0.166.0 and 0.167.2 consumed contracts remain historical.
Each `contract-provenance.json` names the binary version and
generator command. The contract keeps the schema documents consumed by the driver and
tests, with their local `definitions` and `$ref` closure.

Other version directories contain dated live evidence and historical provenance.
Git history retains schema files that were previously checked in, but not the 0.165.0 consumed schemas.
The [0.165.0 capture record](0.165.0/README.md) points to a comparison summary in a commit message.
To regenerate a contract from a generator output, follow [Contributing](../../../docs/guides/contributing.md).
Use `--historical` only for a stored capture that includes dated evidence JSON.
