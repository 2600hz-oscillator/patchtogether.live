# P3 execution notes — 2026-09-03 (helper supervision + harness device layer)

## What shipped

- `apps/desktop/src/supervisor.ts` — per-helper supervisor in Electron MAIN:
  `stopped → starting → running → restarting(backoff+jitter) → crash-looped`.
  Health = process alive AND hello accepted: a real WS hello probe per protocol
  v1 — against the single-client es9 bridge a 'busy' reply IS the health proof
  (the probe never sends takeover, so an attached app client is never evicted);
  against vst an anonymous hello whose session dies with the probe socket.
  pt-ptz (no socket) = process-alive tier this slice. Crash-loop → red status
  row via the feed; never a modal. Missing binary → 'stopped' with detail, no
  spawn churn. Helpers' stdio forwarded into the shell log; a dead shell
  reaps helpers (SIGTERM + SIGKILL escalation on will-quit, plus the stubs'
  stdin-close orphan guard).
- Binary resolution injectable per helper: `PT_HELPER_<ID>_BIN/_ARGS/_PORT`
  (packaged default `Resources/helpers/`, unpackaged default = submodule
  `.build/release/` + in-tree pt-ptz); `PT_HELPERS=off` for specs it is not
  the subject of. Tuning via `PT_HELPER_BACKOFF_BASE_MS` etc.
- `render-process-gone` → window reload; supervisors/helpers/server live in
  main and are untouched (brief P3 task 4; forced-crash e2e leg deferred).
- `ptNative.helperStatus` (preload): `get()` (current + bounded history — a
  late subscriber misses nothing) + `subscribe()` live pushes — the future
  pre-flight UI's rows.
- **Protocol-faithful Node stubs** (`src/stubs/{es9,vst}-stub.ts` — the
  harness's Tier-A device layer, plain node, runs on Linux): loopback bind +
  BridgeKit defaultOriginPolicy mirror (no-Origin/loopback/patchtogether.live
  allowed, else HTTP 403); es9 single-client slot with busy → `takeover` and
  GRACE takeover (idle > staleAfter, configurable), status 'stopped' on evict,
  deviceInfo/ping faithful; vst hello.clientId park/adopt with `mounted`
  REPLAY, live-socket eviction, instance cap, helperInfo/pluginList/mount.
  Takeover fidelity note: a bare `takeover` claims but does NOT reply —
  the client re-hellos (BridgeService.handleWaitingText sends nothing).

## Harness legs (task desktop:e2e / desktop:e2e:one -- supervision)

supervision.spec.ts, all waits observable-state, zero fixed sleeps:
1. stubs → 'running' through the REAL supervisor; ptz (missing binary) =
   'stopped: binary not found'; clean history ['starting','running'].
2. origin allowlist ON the supervised sockets: `https://evil.example` → 403 on
   both; loopback + patchtogether.live origins → protocol replies.
3. es9: attach → SIGKILL stub → LIVE-subscribed sequence running→restarting
   (attempt 1, delayMs>0)→running under a new pid → reattach → busy/takeover
   eviction → grace takeover via one-shot hello probes (expect.poll).
4. vst: mount → drop → same-clientId reconnect replays `mounted` → live-socket
   eviction → SIGKILL → supervised restart (new pid; 'restarting' in history)
   → fresh hello with NOTHING parked (park is per-bridge-lifetime, asserted).

**Evidence 2026-09-03:** 5/5 specs green; `--repeat-each=3` = 15/15
(boot 760–880 ms, supervision legs 453 ms–1.9 s); zero leaked
electron/stub processes after the sweep.

Real binaries: `task helpers:build` produces all three (es9-bridge 657 KB,
vst-bridge 881 KB, pt-ptz 54 KB from the pinned submodules + tree).
`swift test`: es9 42/42, nativeapps 36/36 (origin-policy suites included).
Outstanding (owner-machine smoke): kill the REAL es9-bridge and watch the
same recovery — Tier B / §7 checklist, not automatable here.

## ⚠ Instrument lesson — waitForFunction async predicates are VACUOUS here

`page.waitForFunction(async () => false)` RESOLVES in ~300 ms in this
Electron harness — the pending Promise itself is truthy on the first poll, so
every status wait written that way passes instantly regardless of reality.
It surfaced only on the vst restart leg (ECONNREFUSED at kill+134 ms, inside
the 200 ms backoff window — the one place reality lagged the lie); the es9
legs stayed green because their subjects were genuinely fast. Diagnosis
required a probe spec asserting an always-false async predicate times out
(it did not). Fix: poll from the NODE side — `expect.poll` over
`page.evaluate` (which awaits promises by contract). SYNC predicates in
waitForFunction remain fine (boot spec, __helperEvents waits). Same family
as vacuous-all()/passing-negative-control memories: ask why green is green.

Also fixed on the way: fixed stub ports raced ACROSS tests (the old shell's
stub dies asynchronously after app.close(), so the next supervisor probe
could greet a lingering stub) — per-launch fresh ports; fix the fixture,
never the timeout.

## Deferred (later P3/PH slices — tracked, not lost)

- Forced `render-process-gone` e2e leg (handler shipped; needs a crash hook).
- Crash-loop e2e leg (state machine + threshold shipped and unit-visible in
  the status feed; a repeated-kill spec later).
- pt-ptz virtual-CoreMIDI-port health probe (macOS-only by nature).
- Wiring stub helpers through supervisor into the WEB app's es9/vst cards
  (bridge-owner URL override seam) — the audible reattach verification.
