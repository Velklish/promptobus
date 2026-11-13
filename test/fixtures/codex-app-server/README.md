# Codex app-server contracts and evidence

The 0.158.0 and 0.167.2 directories contain generated contracts for the minimum and
selected Codex versions. The 0.166.0 consumed contract remains historical.
Each `contract-provenance.json` names the binary version and
generator command. The contract keeps the schema documents consumed by the driver and
tests, with their local `definitions` and `$ref` closure.

Other version directories contain dated live evidence and historical provenance.
The full generated schema captures are available in Git history. To regenerate a
contract from a generator output, follow [Contributing](../../../docs/guides/contributing.md).
Use `--historical` only for a stored capture that includes dated evidence JSON.
