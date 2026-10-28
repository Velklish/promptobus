# Codex app-server 0.164.0 capture

No-model schema generation from the installed codex-cli 0.164.0 on macOS arm64.
The version command and `codex app-server generate-json-schema --out <worktree>/test/fixtures/codex-app-server/0.164.0` both exited 0 using the same executable. `capture-provenance.json` preserves the historical full-capture inventory; the generated files it inventories remain in Git history. `contract-provenance.json` names the current consumed contract and generator command.

Native evidence is version-scoped. This capture establishes the generated protocol; holder turns and hook events require separate live measurements on this binary. Finite consumed-contract witnesses do not certify arbitrary caller-forwarded RPC; `currentTime/read` remains a separately documented extension.

## Live measurements on 2026-10-28

`command -v codex` resolved the installed CLI on `PATH`; `codex --version` returned `codex-cli 0.164.0` with exit 0. The binary hash before and after schema generation was `d8990e3ee7acfbc26f91265b12a1a83f0fee40d0e0f8f1f40a37d4ec21f499cf`. `npm run codex-schema` exited 0 against this binary: 320 committed and 320 installed schemas, with 16 requests, 16 responses, four notifications and 10 server requests in the consumed contract.

`TMPDIR=$(mktemp -d /private/tmp/pb-XXXX) node scripts/live-codex.mjs --model gpt-6.1-sol` exited 0 with 11/11 verdicts on both a first loop and a journal-capture loop. On the latter, the worker holder journal recorded `hook/started sessionStart` at 07:01:05.951Z, `hook/completed sessionStart completed` at 07:01:06.089Z, `hook/started stop` at 07:01:32.776Z, `hook/completed stop completed` at 07:01:32.942Z, then `turn/completed` at 07:01:32.953Z. All four hook lines named the participant home's `hooks.json`; its Stop and SessionStart commands named `guard --role worker:live`. The scenario stopped the holder and app-server and left the owner's Codex config hash unchanged.

`model/list` returned eight visible model IDs. With `includeHidden: true`, it also returned `gpt-reserve` and `codex-auto-review`, both marked `hidden: true`. The command `TMPDIR=$(mktemp -d /private/tmp/pb-XXXX) node scripts/live-codex.mjs --model gpt-reserve` exited 0 with 11/11 verdicts. The worker sent its status, then `hook/completed stop completed` at 07:02:58.029Z preceded `turn/completed` at 07:02:58.051Z. The scenario stopped its session. No `-free` or `-contributor` model was used.

A separate disposable Codex-only task used `gpt-6-sol` with worker and approver effort `high` and reviewer effort `xhigh`. Each role's lift was preceded by a successful `--dry-run`; all three lifts exited 0 and each session was stopped before the next role was raised. The reviewer read a committed one-file diff and sent a result; the approver lift followed that result. The holder journals were read after their `turn/completed` events:

| Role | SessionStart completed | Stop completed | Turn completed | Hook source |
| --- | --- | --- | --- | --- |
| worker | 07:14:22.731Z | 07:14:54.978Z | 07:14:54.991Z | participant home `hooks.json` |
| reviewer | 07:15:00.668Z | 07:15:39.406Z | 07:15:39.422Z | reviewer sandbox `.codex/hooks.json` |
| approver | 07:15:45.017Z | 07:15:57.319Z | 07:15:57.330Z | participant home `hooks.json` |

Each source file was read before Stop and carried a `guard --role` command naming its respective address. Each `codexDriver.stop` returned `ok: true, stopped: true`. The approver used a separate worktree from the disposable clone and sent its bound status. This measures lift and hook delivery, not an acceptance commit.

A no-model `codex app-server --stdio` probe exited 0 after `initialize`, `thread/start` and `mcpServer/tool/call`. Its MCP child returned exactly these environment names: `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `PB285_EXPLICIT`, `SHELL`, `TERM`, `TMPDIR`, `USER`, `__CF_USER_TEXT_ENCODING`. `PB285_EXPLICIT` was set in the server entry. Parent sentinels named `CLAUDE_CODE_SESSION_ID`, `CURSOR_CONVERSATION_ID`, `CODEX_THREAD_ID`, `PROMPTOBUS_CURSOR_SESSION` and `PROMPTOBUS_CODEX_SESSION` did not appear. The probe did not ask for a model turn or test a generated participant entry's record pointer.

The worker holder journal received this complete `account/rateLimits/updated` payload during the hidden-model turn; it contains no token, account identifier or email:

```json
{"rateLimits":{"limitId":"codex","limitName":null,"normalModelSlug":null,"primary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":1793775091},"secondary":null,"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},"individualLimit":null,"spendControlReached":null,"planType":"pro","rateLimitReachedType":null}}
```

The live notification states a window duration. The unsupported `account/rateLimits/read` fallback was not exercised because this binary supports that request.
