# Shared MCP request compatibility witnesses

The in-process fixture (`test/service-mcp-request-fixture.mjs`, run by
`test/service-operation-authority.test.mjs`) supplies the same request interface
as HTTP. Its Host uses a temporary workspace; its observation barriers do not
contact a provider. The HTTP witnesses below exercise layers outside that interface.

| Endpoint | Request or held boundary | Authority change | Expected response | Evidence of entry or refusal |
|---|---|---|---|---|
| Both | POST before reader | Foreign token or expired reservation | 401, original error body | Zero reads |
| Both | Initialize, ping, premature list, initialized, list | None | 200 with session header and negotiated version; 200 `{}` result; 400; empty 202; 200 with tools | Session ID scoped to client and endpoint |
| Both | GET; DELETE across endpoints or protocol versions; valid DELETE | None | 405 with `allow: POST, DELETE`; 404 or 400; empty 204 | Zero reads; deleted session gets 404 |
| Both | Unsupported protocol plus unknown session; unsupported method; bad content type plus bad Accept; bad Accept | None | 400 before session lookup; 405; 415 before 406; 406 | Zero reads |
| Bus | Initialized notification body | Owner replaces grant | 401 | Session remains uninitialized |
| Bus | Initialize Host factory | Owner revokes grant | 401 before inspecting the returned Host | Provisional session removed |
| Bus | Pending native catalog body | Owner realizes binding | 200 with tools; pending tool call gets 403 | No actor needed for static catalog |
| Bus | Native proof / managed observation | Same-identity revision changes once or continuously | Stable GET reaches missing-header 400; sustained drift gets 409 | Two or three proof attempts; no tool retry |
| Bus | Native proof / managed observation | Participant replaced or grant removed; observer reports dead or unknown | 409 for changed identity, 401 for revocation/death, 503 for unknown | No additional observation on terminal refusal |
| Reviewer files | Synchronous managed entry | Occupied task lock or revoked grant | 503 before journal entry or 401 | No receipt directory |
| Both | Duplicate tool call | None | Bus returns saved body; allowed file read returns updated contents; changed arguments get 409 | Ordinary DELETE removes receipt directory |
| Bus | Retry after uncertain start | None | 409, earlier outcome uncertain | Existing started receipt; no automatic repeat |
| Bus | DELETE standalone or BB process session | None | Empty 204 | Completed receipt remains under `root-<nonce>/<session>` |

Existing HTTP witnesses: `test/shared-service-operation-authority.test.mjs`
checks contention after user registration, replay of that partial completed
outcome, generation replacement and the Codex telemetry-only fence.
`test/shared-service.test.mjs` checks a real interrupted completion, reviewer
read ceilings and client isolation. `test/shared-service-standalone-root.test.mjs`
covers standalone generation recovery with retained request history.
`test/shared-service-native-binding.test.mjs` covers pending catalog discovery,
native-call metadata and changes during Host preparation. Cached lifetime status
observations still use a generated-source fixture; they do not authorize requests.
