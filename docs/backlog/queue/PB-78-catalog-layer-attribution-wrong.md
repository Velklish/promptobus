# PB-78 · A host with zero or two writable overlays reaches every routed call as catalog-invalid blaming the read-only shipped catalog, while models validate correctly calls the identical fault overlay-invalid on layer host

- **Order:** 200
- **Scope:** [reference/03-cli](../../reference/03-cli.md) section Error codes, lib/models.js (mergedCatalog), lib/model-routing/catalog.js, lib/model-routing/validate.js, test/model-routing-catalog.test.mjs
- **Created:** 2026-09-06
- **Dependencies:** PB-155

## Context

mergedCatalog (lib/models.js:156-172) catches the GateError loadCatalog raises and tries to guess which layer it concerns by re-parsing every layer's JSON and testing schemaVersion !== 1 (line 165), falling back to layers[0] - the shipped catalog - when nothing matches (line 169). Two independent faults make this misattribute on every routed call, not only on a schema-version mismatch. First, readLayers' writable-count GateError (lib/model-routing/catalog.js:219-238) - thrown when a host declares zero or more than one writable overlay - is about the host's own declaration, not any layer's file content. mergedCatalog's content scan cannot express this fault at all: a declared-but-absent overlay file makes existsSync(l.path) false for every overlay, so find() matches nothing and falls through to layers[0], the catalog, no matter what the schema-version constants say. Second, even for a genuine content fault, the literal 1 at lib/models.js:165 is stale now that CATALOG_SCHEMA_VERSION/OVERLAY_SCHEMA_VERSION are both 2 and models/catalog.json ships 2, so the catalog layer - first in the list - satisfies !== 1 before the scan reaches the layer that actually failed. Reproduced live against the current tree (createStandaloneHost with routingPaths().overlays overridden; routingContext(host, strategy balanced) vs validate({ host }) on the identical host): two writable overlays gives catalog-invalid naming the catalog file on the routed call, but overlay-invalid on layer host from validate; zero writable overlays gives the same pairing; an overlay file that is not valid JSON gives catalog-invalid on the routed call but overlay-invalid on layer workspace from validate; an overlay with schemaVersion 99 gives catalog-invalid on the routed call but overlay-invalid on layer workspace, field schemaVersion, from validate. docs/reference/03-cli.md:176 defines catalog-invalid as the shipped catalog failing schema or reference validation, and :177 defines overlay-invalid as naming the layer - the gate contradicts its own reference documentation on all four cases, and the overlay-invalid branch at lib/models.js:170 is unreachable for any host whose shipped catalog file exists at all. Not caught elsewhere: grep -n cannot be used test/ returns nothing, and the four catalog-invalid assertions in test/model-routing-catalog.test.mjs (lines 219, 826, 867, 1024) all go through validateLayers/validate, confirmed by reading each - never mergedCatalog. Not deliberate: mergedCatalog's own docstring (lib/models.js:142-154) states the opposite intent - which layer it was decides the code the person branches on, so the layers are walked once to find the one that does not hold. PB-25's result (docs/archive/PB-25-host-contract-overlay-state/result.md) - the task that added the writable-count GateError in the first place - says a consumer who forgets the writable declaration learns at the first routing command from the GateError of readLayers, and from models validate; it did not intend that GateError to be re-labelled as a fault of the read-only shipped file. PB-29 (catalog v2 benchmarks) and PB-31 (overlay merge union selectors) are the changes that moved the schema versions and the overlay shape this scan silently stopped tracking.

## Work to do

- Carry the layer on the fault instead of re-deriving it by content inspection. Tag the GateErrors raised in readLayerFile/readLayers/mergeRouting (lib/model-routing/catalog.js) with the layer they concern - the overlay's own id, catalog, or host for the writable-count refusal - and have mergedCatalog map that straight to the error code: host and any overlay id become overlay-invalid, catalog becomes catalog-invalid. This makes the routed-call code match what models validate already reports for the same fault, instead of asking two independent mechanisms to agree by coincidence.
- If a content-scan fallback stays for an untagged GateError, it still needs the schema-version literal fixed (CATALOG_SCHEMA_VERSION/OVERLAY_SCHEMA_VERSION in place of 1) - but that alone does not cover the host-declaration case, which carries no layer content to scan; drop the ?? layers[0] fallback in favour of a message that names no layer rather than the wrong one.
- Add a test asserting that each of the four cases above reaches a routed call (routingContext) with the same code and layer that validate({ host }) reports for the identical host - the invariant mergedCatalog's own docstring claims and nothing currently checks.
- Update docs/reference/03-cli.md section Error codes if the fix narrows what catalog-invalid can mean (e.g. reachable only for a fault in the shipped file itself, never for a host or overlay fault).

## Out of scope

- The narrower fix of replacing the literal 1 with the real schema-version constants is necessary but not sufficient here, and is filed as its own smaller entry - it fixes the two content-mismatch cases above but not the two host-declaration cases, which carry no layer content to scan.
- Any change to readLayers' writable-count rule itself, or to what models validate reports - both are correct; only mergedCatalog's translation of the GateError into a routed-call error is wrong.

## Verification

- A test exercising all four scenarios (two writable overlays, zero writable overlays, invalid-JSON overlay, wrong schemaVersion) asserts the routed call's error code and named layer match validate({ host })'s finding for the same host.
- Manual: promptobus spawn (or models) against a workspace with two writable overlays reports overlay-invalid on layer host, not catalog-invalid naming models/catalog.json.

## Consolidated evidence from PB-74

### PB-74 · mergedCatalog's layer-blame scan still tests schemaVersion !== 1, so with CATALOG_SCHEMA_VERSION and OVERLAY_SCHEMA_VERSION both at 2 the shipped catalog is named for every schema fault

- **Scope:** [reference/03-cli](../../reference/03-cli.md) section Error codes, lib/models.js (mergedCatalog), lib/model-routing/catalog.js, test/model-routing-command.test.mjs
- **Created:** 2026-09-06
- **Recorded dependencies:** none

### Context

mergedCatalog (lib/models.js:156-172) catches the GateError from loadCatalog and picks the layer to blame with an inline read: return JSON.parse(readFileSync(l.path, 'utf8'))?.schemaVersion !== 1; (lib/models.js:165), falling back to layers[0] - the shipped catalog, first in layers = [{ id: 'catalog', path: catalogFile }, ...(host.routingPaths?.()?.overlays ?? [])] - when nothing matches (lib/models.js:169). CATALOG_SCHEMA_VERSION and OVERLAY_SCHEMA_VERSION are both 2 (lib/model-routing/catalog.js:36-37) and the shipped models/catalog.json starts schemaVersion: 2, so the catalog layer satisfies !== 1 on the very first check of every scan and is reported as broken regardless of which layer actually failed. Reproduced live against the current tree: a probe host declaring a broken overlay of every content kind (invalid JSON, schemaVersion: 99) routed through the real routingContext reaches the caller as catalog-invalid naming .../promptobus/models/catalog.json, while validate({ host }) on the same host correctly answers overlay-invalid on the actual overlay. readLayerFile (imported at lib/models.js:31, already used at lines 559, 582 and 741 to read a layer with correct GateError semantics) is not reused here - the inline existsSync/readFileSync/JSON.parse duplicates it and drops that handling. Overlays are additionally allowed a legacy schemaVersion 1 (lib/model-routing/catalog.js:601: layer.data.schemaVersion !== OVERLAY_SCHEMA_VERSION && layer.data.schemaVersion !== 1), so a correct fix must keep that per-layer-kind exception rather than compare every layer to one constant. grep -rn cannot be used test/ returns nothing: this branch has no test at all. The four catalog-invalid assertions in test/model-routing-catalog.test.mjs (lines 219, 826, 867, 1024) all exercise validateLayers/validate, confirmed by reading each - none of them reach mergedCatalog.

### Work to do

- Replace the inline existsSync/readFileSync/JSON.parse in mergedCatalog (lib/models.js) with readLayerFile(l.path).data, so a read/parse failure raises the same GateError shape the rest of the file already uses.
- Compare the catalog layer's schemaVersion against CATALOG_SCHEMA_VERSION and every overlay's against OVERLAY_SCHEMA_VERSION, accepting the legacy overlay value 1 - mirror the exception already in lib/model-routing/catalog.js:601 so the two checks cannot drift apart again.
- Add a test in test/model-routing-command.test.mjs, beside the existing overlay-invalid assertion around line 360, that writes a workspace overlay with an unsupported schemaVersion (e.g. 99) and asserts through routingContext that the error is overlay-invalid and names the overlay's path, not the catalog's.

### Out of scope

- The host-declaration fault in readLayers (a writable-layer count of zero or two) is not a schemaVersion mismatch at all - the content scan this fix corrects will still fall through to layers[0] for it, because no layer's JSON is actually invalid in that case. That is a separate, structural gap in how the error is attributed and is filed on its own.
- Whether mergedCatalog should re-run validate's own layer walk instead of a bespoke scan - out of scope for a fix this size.

### Verification

- node --test test/model-routing-command.test.mjs passes, including the new overlay-schemaVersion case.
- Manual: a workspace overlay with schemaVersion: 99 routed through routingContext (or promptobus spawn) reports overlay-invalid naming the overlay file, not models/catalog.json.

## Triage — 2026-09-07

- **Track:** R — Routing policy, overlays and availability.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/models.js:156`, `lib/model-routing/catalog.js:219`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Includes PB-74. Replace duplicated layer-blame inference rather than landing two independent fixes to the same catch. Preserve valid version-1 overlays without scaled keys; cover host-declaration faults and all content faults.
