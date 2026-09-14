# Review evidence — 2026-09-13

These instruments describe defects in commit `221e4d76d`; they are not a new production test suite. The web probe uses six `it.fails` assertions: a green run means those intended guarantees still fail. The server probe explicitly asserts the stale-read result. Read the printed observations, not just the runner's green summary.

Both packages ran once, then three times with `REPEAT=3`. `validation.log` retains the measurements and test summaries; `measurements.json` includes CI provenance and the local build's static dependency closure. Existing focused tests passed separately: 130 web tests and 10 server tests.

To reproduce from the repository root, temporarily copy `web-probe.ts.txt` to `packages/web/src/lib/adversarial-review.probe.test.ts` and `server-probe.ts.txt` to `packages/server/src/adversarial-review.probe.test.ts`. Preserve any file already at those destinations. Create `/tmp/inet-adversarial-review` for the server probe's result, then run:

```sh
flox activate -- task test:one -- adversarial-review.probe
flox activate -- task test:one PKG=server -- adversarial-review.probe
flox activate -- env REPEAT=3 task test:one -- adversarial-review.probe
flox activate -- env REPEAT=3 task test:one PKG=server -- adversarial-review.probe
```

Remove only the temporary copies after use. When converting an instrument into a regression test, remove `it.fails` and assert corrected behavior; update the server assertion to require the latest saved state. Keep fault injection and the controls.

The probes use actual Yjs, SyncedStore, Awareness, snapshot/reconciler, DOOM transport/helper, clock estimator, snapshot-store, and LFO factory code. Storage, audio hardware, and network boundaries are substituted deliberately. No live database or R2 write occurred, and the LFO probe does not claim an audible-output measurement. Snapshot timings are local Node microbenchmarks, not browser frame times. CI measurements are from the named main-branch runs, not a fresh CI run of the review branch.
