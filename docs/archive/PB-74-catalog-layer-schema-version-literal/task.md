# PB-74 · mergedCatalog's layer-blame scan still tests schemaVersion !== 1, so with CATALOG_SCHEMA_VERSION and OVERLAY_SCHEMA_VERSION both at 2 the shipped catalog is named for every schema fault

- **Scope:** [reference/03-cli](../../reference/03-cli.md) section Error codes, lib/models.js (mergedCatalog), lib/model-routing/catalog.js, test/model-routing-command.test.mjs
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

mergedCatalog (lib/models.js:156-172) catches the GateError from loadCatalog and picks the layer to blame with an inline read: return JSON.parse(readFileSync(l.path, 'utf8'))?.schemaVersion !== 1; (lib/models.js:165), falling back to layers[0] - the shipped catalog, first in layers = [{ id: 'catalog', path: catalogFile }, ...(host.routingPaths?.()?.overlays ?? [])] - when nothing matches (lib/models.js:169). CATALOG_SCHEMA_VERSION and OVERLAY_SCHEMA_VERSION are both 2 (lib/model-routing/catalog.js:36-37) and the shipped models/catalog.json starts schemaVersion: 2, so the catalog layer satisfies !== 1 on the very first check of every scan and is reported as broken regardless of which layer actually failed. Reproduced live against the current tree: a probe host declaring a broken overlay of every content kind (invalid JSON, schemaVersion: 99) routed through the real routingContext reaches the caller as catalog-invalid naming .../promptobus/models/catalog.json, while validate({ host }) on the same host correctly answers overlay-invalid on the actual overlay. readLayerFile (imported at lib/models.js:31, already used at lines 559, 582 and 741 to read a layer with correct GateError semantics) is not reused here - the inline existsSync/readFileSync/JSON.parse duplicates it and drops that handling. Overlays are additionally allowed a legacy schemaVersion 1 (lib/model-routing/catalog.js:601: layer.data.schemaVersion !== OVERLAY_SCHEMA_VERSION && layer.data.schemaVersion !== 1), so a correct fix must keep that per-layer-kind exception rather than compare every layer to one constant. grep -rn cannot be used test/ returns nothing: this branch has no test at all. The four catalog-invalid assertions in test/model-routing-catalog.test.mjs (lines 219, 826, 867, 1024) all exercise validateLayers/validate, confirmed by reading each - none of them reach mergedCatalog.

## Work to do

- Replace the inline existsSync/readFileSync/JSON.parse in mergedCatalog (lib/models.js) with readLayerFile(l.path).data, so a read/parse failure raises the same GateError shape the rest of the file already uses.
- Compare the catalog layer's schemaVersion against CATALOG_SCHEMA_VERSION and every overlay's against OVERLAY_SCHEMA_VERSION, accepting the legacy overlay value 1 - mirror the exception already in lib/model-routing/catalog.js:601 so the two checks cannot drift apart again.
- Add a test in test/model-routing-command.test.mjs, beside the existing overlay-invalid assertion around line 360, that writes a workspace overlay with an unsupported schemaVersion (e.g. 99) and asserts through routingContext that the error is overlay-invalid and names the overlay's path, not the catalog's.

## Out of scope

- The host-declaration fault in readLayers (a writable-layer count of zero or two) is not a schemaVersion mismatch at all - the content scan this fix corrects will still fall through to layers[0] for it, because no layer's JSON is actually invalid in that case. That is a separate, structural gap in how the error is attributed and is filed on its own.
- Whether mergedCatalog should re-run validate's own layer walk instead of a bespoke scan - out of scope for a fix this size.

## Verification

- node --test test/model-routing-command.test.mjs passes, including the new overlay-schemaVersion case.
- Manual: a workspace overlay with schemaVersion: 99 routed through routingContext (or promptobus spawn) reports overlay-invalid naming the overlay file, not models/catalog.json.
