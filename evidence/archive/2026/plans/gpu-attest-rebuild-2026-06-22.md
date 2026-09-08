# WebGL Attest Suite — determinism rebuild (2026-06-22)

> Goal: make the WebGL/GPU attest lane **deterministic and zero-flake** so it can
> run with `retries=0`, without sacrificing the correctness coverage we care
> about. Converts a wall-clock guessing suite into a layered, freeze-driven,
> single-sample-immune suite.

> **TRIAGE 2026-08-12 — the ARCHITECTURE shipped; the last mile did not.**
> - **Phase 0 (foundation) is DONE**: `globalThis.__videoEnginePause` +
>   `__videoEngineFreezeTime` are a single engine-wide pause+clock-pin, and
>   `e2e/tests/_render-smoke.ts` is the shared
>   `installRenderSmokeHooks` / `stepAndReadStats` / `assertRenderStats` harness.
> - **Phases 1–2 are largely DONE**: 16 `*-render-smoke.spec.ts` files exist and
>   most of the named worst offenders converted (`video-controls` has 23 harness
>   call sites, `freezeframe` 17, `b3ntb0x` 9, `4plexvid` 8, `videobox-output` 6).
> - **The b3ntb0x render-smoke exemplar and the DOOM DBU/OAC exemplar are now REAL
>   CODE** — their ~400 lines of verbatim source have been deleted from this file
>   as pure duplication. The b3ntb0x DRS is `e2e/tests/b3ntb0x.spec.ts`; the DOOM
>   gate rows were dropped from the live table in
>   `e2e/tests/video-audio-cvgate-coverage.spec.ts:127` and are now proven
>   deterministically by `audio/engine-video-audio-bridge.test.ts` (an `it.each`
>   over every video cv/gate output port), with `nibbles.length_cv` kept as the
>   one LIVE proof that a real AudioParam receives the bridged ramp.
> - **The per-spec conversion table and the per-module hook-gap inventory
>   are DELETED.** Both were inventories: several listed specs no longer exist,
>   and the shared engine-wide pause+clock-pin superseded most of the per-module
>   freeze hooks the table demanded (only `__b3ntb0xFreezeTimeSec`,
>   `__bentboxFreezeTime`, `__toyboxFreeze(Time)`, `__wavesculptVrtFreeze` and
>   `__freezeframeForceGate` were actually needed on top of it).
> - **`webgl-attest` IS a required, gating check** (`$WEBGL_ATTEST` is in the `ci`
>   umbrella's failing `if`, no `continue-on-error`) — so half of Phase 4 landed.
>   **The epigraph's goal is still NOT met**: `e2e/playwright.config.ts:130` is
>   still `retries: process.env.CI ? 1 : 0`, and the headline count went the
>   wrong way — **602 `waitForTimeout` calls at authoring, 649 today**.

---

## 1. The common root cause (the finding worth keeping)

**Every flaky GPU assertion verified render output by sampling an un-synchronized
signal on the wall clock instead of awaiting a deterministic readiness anchor, so
a single mistimed sample under scheduler jitter failed the assertion.** The
fragile assertions clustered into exactly three timing-bet mechanisms:

- **`fixed-wait-then-oneshot-read`** — `waitForTimeout(400–1000)` → one
  `getImageData` → threshold. The single largest class.
- **`tight-poll`** — an `expect.poll` / sleep-loop over a fixed budget that
  samples a *transient* (a 10 ms gate pulse, an LFO phase, a rAF-throttled frame)
  that may or may not exist at the instant of capture.
- **`animation-diff`** — assert that two timing-dependent captures *differ*.

The single worst structural offender was `video-audio-cvgate-coverage`: it fired
a ~10 ms gate pulse and polled a ~43 ms `AnalyserNode` window — two clocks that
*must coincide* for a HIGH sample to be captured, **an irreducible race no budget
can fix.** The cure is the same for all three: pin the clock, advance a fixed
frame count synchronously, read once — and for the bridge cases, drop rendered-
signal sampling entirely in favour of asserting the dispatch topology.

At authoring: 602 `waitForTimeout` across 173/292 specs; 74 specs reading raw
pixels; ~150 fragile assertions classified.

---

## 2. Target architecture (three layers) — the durable part

The principle: **correctness lives in fast GPU-free unit tests; the GPU lane only
proves "it renders, deterministically, without GL errors."** Each behaviour is
verified at the cheapest layer that can verify it.

### Layer A — correctness in GPU-free pure-core unit tests (PCU)

Anything that is *math* — a shader's colour transform, an FFT-band mapping, a
camera-CV projection, an envelope, an orientation flip, a draw helper's pixel
layout — is extracted into a pure function and unit-tested with deterministic
inputs. No WebGL, no AudioContext, no scheduler. In-tree exemplars:
`scope-draw.ts`, `analog-vco-scope.ts`, `lfo-state.ts`, `wavecel-draw.ts`.

**Rule:** *DSP/mapping correctness → pure unit-tested cores, never e2e pixel
reads.*

### Layer B — ONE deterministic render-smoke per GPU module (DRS)

Implemented as `e2e/tests/_render-smoke.ts`. The shape:

1. `installRenderSmokeHooks(page)` **before `page.goto`** — pause the engine rAF
   loop (the test owns the exact frame count) and pin the engine clock.
2. Spawn a deterministic source (`shapes` — no decode, no `getUserMedia`, no
   asset fetch) → the module under test.
3. `stepAndReadStats()` — inside **one** `page.evaluate` (no `await`, so
   rAF/decode/blit cannot interleave): drain GL errors, `for (i<FIXED_STEPS)
   vid.step()`, collect GL errors, bind the node's output texture to a scratch
   FBO, `gl.readPixels` **once**, compute sparse luma stats + the exact frame
   delta.
4. `assertRenderStats()` — floors and counts only: exact frame delta, FBO
   readable, `glErrors == []`, non-black, structured (variance floor).

No `waitForTimeout`, no poll, no animation-diff, no exact-pixel assert.
Renderer-tolerant by construction: SwiftShader and a real GPU disagree on exact
pixels but both clear the floors, while a genuine black/flat/GL-error regression
still fails. **"Param visibly changes output" becomes TWO FROZEN READS** (freeze
→ step → read with param A; again with param B; assert they differ) — a
deterministic diff, not an animation-diff.

Two mechanics that are easy to get wrong and are the reason it works:
- **Read the ENGINE FBO, not the on-card 2D canvas** — that removes the card's
  rAF blit from the loop entirely.
- **Pin the module's OWN clock too** if it keeps a private `performance.now()`
  baseline. The engine-wide hook only reaches modules that read `frame.time`.

### Layer C — audio/event bridges as deterministic dispatch tests (DBU + OAC)

For a bridge, stop sampling a rendered signal. Instead: (1) assert the **dispatch
topology** in a GPU/WASM/clock-free unit test — the real source node gets
`.connect()`ed onto the real sink's input and `.disconnect()`ed on edge removal,
which is the actual regression surface; and (2) if an end-to-end render is still
wanted, render a **HELD** signal through `OfflineAudioContext` and read the
destination buffer at fixed indices — one deterministic sample clock, signal HIGH
at every sample, no window to miss.

This also closes the "skip-if-asset-absent makes the e2e vacuous" hole: the
contract is proven in the fast unit lane without the DOOM WASM asset.

---

## 3. What is LEFT

- **Drive `waitForTimeout` down.** 649 under `e2e/` today (up from 602). Delete
  any e2e GPU assertion fully superseded by a PCU/OAC — **do not keep both**
  (reconcile = fix-or-delete). Remove the now-unused `waitForLuma` /
  `waitForMoving` / `waitForCondition` / `outAdvances` helpers. Only legitimate
  fixed waits (e.g. an OS-fullscreen layout settle with no readiness signal)
  stay, documented.
- **Drop `retries` to 0** (`e2e/playwright.config.ts:130`). Requires a **solo 3×**
  green attest on metal first (a concurrent agent run starves WebGL and produces
  a false red), then re-pin the webgl-attest basis. DRS specs are *faster* than
  wall-clock ones (small fixed step counts vs 600–1000 ms sleeps), so this should
  *reduce* wall-time — confirm it doesn't add >2 min anywhere.
- **Finish the stragglers.** Specs still carrying wall-clock waits with no DRS
  harness use: `videovarispeed-output` (6), `video-fullscreen` (3),
  `videovarispeed-switch` (3), `video-hide-controls` (3), `multi-video-playback`
  (4), `video-audio-output` (2). `video-orientation` (6 waits, 1 harness call) and
  `scope-video-out` (5 waits, 4 harness calls) are half-converted.

---

## 4. Non-goals / risks

**Non-goals:**

- **Not** pixel-exact VRT. DRS asserts floors + counts; exact-pixel baselines are
  the separate VRT harness's job.
- **Not** rewriting the audio engine for synchronous frame-stepping. Audio
  modules have no sync step and Web Audio is async by design — their correctness
  goes to PCU / OAC. **Do not add a fake audio stepper.**
- **Not** touching DOM/Yjs-deterministic specs that are already non-fragile
  (`quadralogical-assign`, `toybox-combine-editor`, `toybox-layer-input`,
  `toybox-video-inputs`, `video-full-frame`, `toybox-disk-loading`,
  `toybox-feedback`) — they are the *exemplars*, leave them.
- **Not** keeping both an e2e GPU assertion and its PCU/OAC replacement.

**Risks:**

- **Per-module time-pinning gaps.** A shared `__videoEngineFreezeTime` only helps
  modules that read the engine's `frame.time`. A module with its own
  `performance.now()` baseline needs a one-line edit to read `frame.time` or its
  own freeze hook. **Audit every heavy-WebGL module for a private wall clock
  before assuming the shared hook covers it.**
- **`read('fboTexture')` is not implemented on every module.** Stateless
  processors (chromakey, lumakey, colorizer, reshaper, luma, mixer, monoglitch,
  vdelay) don't expose an output texture via `read()`. **Prefer routing through a
  downstream `videoOut` FBO** rather than adding per-module read plumbing.
- **`gl.finish`/readback on the SwiftShader watchdog.** A tight `gl.finish()` busy
  loop can trip CI's GPU watchdog. DRS avoids it with a small FIXED step count
  and a single readback — **keep step counts ≤ ~12 and never add a wall-clock
  timing probe to a DRS.**
- **Card rAF vs engine step double-render.** Modules whose Card drives its own rAF
  (`cube`, `wavesculpt`, `wavecel`, `clipplayer`) can blit between steps. DRS
  reads the engine FBO inside one `page.evaluate` so the card's rAF can't
  interleave — but the freeze hook must also pause the card's rAF for any on-card
  VRT variant.
- **Attest basis drift.** Flipping to `retries=0` is only safe after a solo 3×
  green attest on metal. Schedule the flip when the lane is uncontended.
