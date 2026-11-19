# Bounded Cursor Stop: Homebrew and upstream Node comparison

The four standalone runs on `791d9bdd7b1b28cba8bb121ea3cdf3825d70763f` passed on November 20, 2026. Neither installed Node build reproduced the historical missing-fallback failure. The historical full-suite failure was separate: the second participant exhausted the remainder of the first participant's Stop window without dispatching native shutdown. This comparison does not identify what made the earlier commands slow.

See [Cursor Stop deadlines and ownership](../reference/05-drivers.md#cursor-the-persist-session) and the [contributing guide's worker path](../guides/contributing.md#worker-path) for the contract and the distinction between standalone and full-suite evidence.

## Reproduce the targeted runs

Build the checkout at the tested revision. Set `NODE` to the absolute path of the installed arm64 Node `26.13.0` binary. Run the following from the checkout root twice per build, serially. For the separate late-body control, run the second command once per build. The fixture uses owned, isolated processes and files; it does not start live Cursor sessions.

```sh
PATH="$(dirname "$NODE"):$PATH" "$NODE" test/cursor-stop-bounded.test.mjs
PATH="$(dirname "$NODE"):$PATH" "$NODE" test/cursor-stop-bounded.test.mjs "$PWD" --late-fallback-start
```

Record the binary's `--version`, `uptime` before and after each run, exit code, and the fixture's `bounded-fallback-receipt` and `bounded-observation-receipt` lines. The measured host was macOS 27.0.1 (26A434), arm64, with eight logical CPUs. Both binaries reported `v26.13.0`. Homebrew formula revision `_2` linked a shared `libnode.147.dylib`; the upstream Darwin arm64 distribution did not link a separate `libnode`. Load was ambient and differed across runs; this was not a controlled benchmark of packaging or scheduler effects.

## Standalone timing

Times are in milliseconds from the start of the corresponding Stop, except where marked otherwise. **Stop settled** is `settledAt`, recorded by the Stop promise callback. **Await resumed** is `returned`, recorded after the fixture's polling and `await pending`. The two need not coincide. Load is the one-minute average from the runtime receipt before the file ran and from `uptime` after it ran.

| Run | Load before → after | File wall s | Delayed fallback budget / native refusal / PID seen / JS request / Stop settled | Positive fallback budget / Stop settled / await resumed |
| --- | --- | ---: | --- | --- |
| Homebrew 1 | 13.94 → 12.57 | 12.51 | 1500 / 618 / 710 / 750 / 1505 | 1500 / 188 / 208 |
| Homebrew 2 | 12.20 → 11.41 | 12.57 | 1500 / 645 / 717 / 784 / 1505 | 1500 / 208 / 208 |
| Upstream 1 | 10.17 → 9.13 | 10.75 | 1575 / 532 / 612 / 616 / 1578 | 1575 / 122 / 122 |
| Upstream 2 | 9.13 → 8.81 | 10.24 | 1500 / 511 / 614 / 566 / 1506 | 1500 / 131 / 131 |

The shell publishes its PID before the JavaScript body runs. The parent polls for that file, so it can see the PID after the body records the request. A settlement shortly after the deadline reflects observed completion and delivery, not permission to mutate after expiry.

| Run | Exhausted: first budget / hold published / first Stop settled | Replaced: first budget / hold published / second Stop starts¹ | Second Stop budget / elapsed² |
| --- | --- | --- | --- |
| Homebrew 1 | 1800 / 523 / 1805 | 5875 / 585 / 612 | 5263 / 657 |
| Homebrew 2 | 1800 / 507 / 1805 | 5000 / 532 / 615 | 4385 / 678 |
| Upstream 1 | 1890 / 200 / 1895 | 5250 / 187 / 203 | 5047 / 228 |
| Upstream 2 | 1800 / 186 / 1805 | 5000 / 192 / 208 | 4792 / 245 |

¹ Relative to the first Stop starting. ² Budget is the first edge minus the second Stop's start; elapsed is measured from the second Stop's start.

All four runs exited 0 with 7/7 verdicts. The delayed fallback yielded while its exact PID and process birth were alive before deadline expiry. It was later dead, with the pane, registry record and home, and native state retained, and no late mutation. The positive fallback followed a native refusal, killed the pane, and retired the exact record. Both held-observer cases retained the first pane and record without authorizing fallback: one after deadline expiry, the other after a registry revision change. In the replacement case the second Stop recorded native confirmation and pane death before the first observer was released. Fixture teardown verified that all remaining owned panes died after the verdicts.

The two late-body controls also exited 0 with 7/7. Both held the JavaScript fallback body until 50 ms past the unchanged 1500 ms deadline. Homebrew (load 7.66 → 7.42) observed the exact PID at +613 ms and Stop settled at +1512 ms. Upstream (load 7.70 → 7.66) observed it at +512 ms and Stop settled at +1509 ms. Both found the child dead and recorded neither a JavaScript fallback request nor a later mutation.

## Compare with the historical fixture

- On November 6, Homebrew standalone runs on `c7da8b83e6e5c7980b9788c039ce38e5c6de5b71` (twice) and exact base `298008bc53336b0da0dd037744c0fd929eb71a9c` (once) exited 1, 6/8 each. The two red verdicts in all three runs were `a delayed native fallback yields while its exact child is still alive` and `expired fallback is terminated with no later native mutation and UNKNOWN retains its pane/record/home`. The 1500 ms budgets ended before native observation, with an unconfirmed fallback timeout (117 ms left and no JavaScript request receipt), and during native observation, respectively. The historical upstream branch run exited 0, 8/8.
- The historical Homebrew full suite on the branch exited 1, 265/266 files. Its red verdict was instead `another owned participant initiates and confirms native Stop while post-native observation remains held`, in `observation-exhausted`. The second Stop started 926 ms into the first Stop's 1800 ms window. It had 874 ms left and returned `Stop deadline elapsed before native observation` after 877 ms. Its pane was still alive and its ledger contained no `native/requested`. The second participant in the separate replacement case passed, with 4538 ms left and 871 ms elapsed. This classifies the exhausted fixture's shared-window failure, not the cause of delay inside an individual subprocess.
- `be492fcddd6921ed38c56ee210ea30ba2b5f26d6` moved fallback readiness to the shell and served a static fallback-session line. `6cca748a8195843c5d39d3d93c086bf2d828adfe` moved the positive fallback mutation to its shell stub and kept the second participant only in the replacement case. That separation accounts for the current 7 verdicts versus the historical 8; the positive concurrency verdict remains. Neither commit changed the production Stop deadline policy for this comparison.

## Not run

No full suite or full gate on the measured revision or on this documentation change. No fresh reruns on the historical revisions, controlled load or runtime-packaging experiment, new mutation probe, or live Cursor check. No new code fix was selected. The current standalone results do not waive the historical full-suite failure or guarantee parity under full-suite load.
