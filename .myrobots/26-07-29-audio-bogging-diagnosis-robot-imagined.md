# Audio bog-down with video in the patch — diagnosis + what's left (robot-imagined)

Not asked for as a document. Written because the diagnosis cost ~4.5 M tokens of
agent work and the numbers should not have to be re-measured.

> ## RE-VERIFIED 2026-08-12 — four of five remaining items still open
>
> - **#1 Buffer → Stable** — still the 30-second owner experiment. Never reported back.
> - **#2 cap the video engine to 60 fps** — no governor, no fps cap and no
>   `document.hidden` gate in `video/engine.ts`. OPEN, still needs owner sign-off.
> - **#3 narrow `recorderbox`'s pull-exempt** — `isPullExempt`
>   (`video/engine.ts:1013-1020`) still returns `true` for **any** node with
>   non-empty `audioInputs`. So recorderbox still pins the whole upstream chain
>   whether or not it is armed. OPEN, exactly as diagnosed.
> - **#4 card-layer rAF coalescing** — **74 card files, 244 raw
>   `requestAnimationFrame` sites** (was 73 / 239 on 2026-08-04 — it is growing);
>   12 files use the shared ticker. OPEN. Tracked as P0-1 in `FABLE_PERF_PLAN`.
> - **#5 per-module render-cost CI gate** — still does not exist. OPEN.
> - **The separate P0 preset-load DOM leak still has no ticket.** ⚠ Note the
>   later, narrower finding in `2026-08-03-SESSION-STATE.md` §1: #1262 concluded
>   *one* patch-load DOM leak was a **dev-server artifact**. That does not
>   obviously cover the 5-load 4,626 → 52,938 measurement here, but whoever picks
>   this up must reconcile the two before re-measuring.
> - **The two refuted fixes stay refuted** — but note the Fix-E worker default was
>   flipped ON by #1047 (2026-07-10) for unrelated reasons. That does not revive
>   it as a fix for *this* symptom: the cost is peakstate's Canvas2D rasterization,
>   which the texture co-processor does not touch.

**Owner's report:** `performance.ptperf.zip` — *"even in balanced audio mode I have
an issue with the audio engine bogging down and or stopping completely. without
any of the video stuff in the patch that doesn't happen."*

That last clause is a clean control experiment and is why this was diagnosable.

## The patch

28 nodes, 43 edges, `mode: workflow`, 56 MIDI bindings.

```
peakstate ─video→ backdraft ─video→ quadralogical ─┬→ workflow-videoOut → recorderbox
                                                    └→ videoOut-dc3b2def
```
Cross-domain is **CV only** (synesthesia band envelopes → backdraft zoom/rotate;
flipper → mirror gates) plus `mixmstrs.masterL/R → recorderbox.audio_l/r`.

## What was measured (Apple M5, ANGLE Metal, real GPU, `balanced` = latencyHint 0.025)

Main-thread CPU, ms per second (CDP `Performance.ThreadTime`):

| condition | main-thread ms/s | renderer ms/s |
|---|---|---|
| full patch | **202** | 745 |
| − peakstate | 122 (**−80**) | 667 |
| − backdraft | 94 | 616 |
| all video gone | **52** | 559 |

**The video half costs ~120–150 ms/s of main-thread CPU** and ~190 ms/s of
renderer-process CPU. The AudioWorklet render thread shares that renderer process.

Engine `step()` per frame (n=1800):

| | p50 | p99 |
|---|---|---|
| full patch | 0.58 ms | 0.94 |
| **peakstate removed** | **0.05 ms** | 0.10 |

**PEAKSTATE was ~92 % of all video draw time.** Cost linear in `complexity`
(172.9 / 202 / 343 ms/s at 1 / 12 / 32) — that linearity is the control proving
the attribution.

## Mechanism

Same class as the forensically-confirmed SHOES1 output-buffer underrun
(2026-07-01), with two multipliers this patch adds:

1. **The engine loop has no frame-rate cap and no `document.hidden` gate**
   (`video/engine.ts:1797-1818`) — measured **120 fps** on a 120 Hz machine, i.e.
   2× the work of a 60 Hz assumption.
2. **peakstate did 3× the work it needed to** (fixed, below).

Plus a third, unfixed: **`recorderbox` defeats sink-driven pull-eval for the whole
chain.** It publishes `audio_l/audio_r`, so `isPullExempt` (`engine.ts:1013-1027`)
makes it a permanent pull root; `computeActiveSet` then walks back through
videoOut → quadralogical → backdraft → peakstate and marks them all active **every
frame, whether or not anything is recording and whether or not any card is
visible.**

## What is now FIXED (merged 2026-07-29)

**#1261 — peakstate renders only the outputs something consumes.** It was
rasterizing all three (`mono_out`, `rgb_out`, `out_3d`) unconditionally every
frame — each ≈57,600 stroked segments at complexity 12, the 3D tube pass running
it twice, each followed by a 360×360 `texSubImage2D` + fullscreen blit. The
owner's patch consumes only `rgb_out`.

Measured **4.02×**: p50 **13.845 → 3.440 ms/frame** (harness absolutes are higher
than the diagnosis numbers because it saturates the ring; the *ratio* transfers,
predicting ≈0.18 ms/frame in the diagnosis's units).

Seam used: **`VideoFrameContext.connectedOutputPorts(nodeId)`** (`engine.ts:1952`)
— the existing per-port layer beneath node-level `computeActiveSet`, already used
by COLOUR OF MAGIC / VIDEOCUBE / LUSHGARDEN. Covers real edges + cross-domain
bridges + TTL'd preview requests.

⚠ **`rgb_out` is deliberately never gated** — it is also the OffscreenCanvas the
card polls via `read('previewCanvas')`, and that poll is **invisible to the port
seam**, so gating it blacks out the preview of an unpatched module.

⚠ **The three outputs share one pen ring.** `advancePen`, `rotation3d` and the
orbit centre stay **unconditional**; only rasterize+upload+blit is skipped. A
coherence test guards this: two instances through an identical time sequence, one
gated off until the last frame, must emit byte-identical geometry on resume.
Getting this wrong makes the image **jump** mid-performance.

**#1260** also removed BACKDRAFT's in-rack display, taking the card's per-frame GL
readback to **zero**.

## What could NOT be reproduced, and why that is structural

**The dropout itself never reproduced.** At full speed the patch left the main
thread ~80 % idle, missed **zero** scheduler ticks over 7 minutes, and held 120
fps. It only became visible under a **6× CPU handicap**, where the dose-response
matched the owner's control exactly (late 25 ms ticks: full patch 17/20 →
−peakstate 6 → −recorderbox 5 → −backdraft **0** → no video **0**).

**Automated Chromium cannot show it:** headless uses a **null audio sink** —
`outputLatency` **0.072 ms** vs the 10–25 ms a real device reports — so a
device-layer underrun *literally cannot occur*. `AudioContext.renderCapacity` is
not implemented in Playwright's Chromium (three flag spellings tried).

**There was no underrun detection anywhere in the app** (`grep
renderCapacity|playoutStats|onprocessorerror` → 0 hits), and that was the real
gap. **CLOSED by #1425**: `$lib/audio/playback-stats` (the underrun counter, off
`AudioContext.playbackStats` — note two of those three greps were the *wrong API
names*) plus `$lib/audio/worklet-guard`'s `processorerror` latch and the
tick-latency histogram. A re-run of this diagnosis should now read the numbers
instead of inferring them.

## Ruled OUT, with evidence

- **Cross-domain texture-bridge cost** — not engaged; only 2 scalar CV bridges.
  Removing synesthesia changed CPU by ~0.
- **`attachLocalReplica` / silent cross-domain audio** — not applicable.
- **CV modulation writing the live Y.Doc** — `syncMirrorFromEngine` is
  change-guarded, writes only on gate flips. syncedstore reads ~0.6 % of profile.
- **Progressive degradation in-session** — 7 min at full speed: 0 late ticks,
  heap oscillating 60–87 MB, context `running`.
- **WebGL context exhaustion** — exactly 1 shared WebGL2 context.

## ⚠ The two fixes I predicted would help — BOTH REFUTED

Worth recording because I told the owner otherwise before the evidence arrived:

- **Fix E worker hoist — NO.** The cost is peakstate's **Canvas2D** rasterization,
  not a GL workload the texture co-processor targets. Backdraft, Fix E's actual
  target, costs 0.05 ms/frame of CPU. The plan's own economics note says moving a
  mid-graph input-consuming module can be net-negative. **Leave parked.**
- **seq-clock worklet (PR-B #969) — NO.** It protects step timing when the main
  thread stalls past the **200 ms** lookahead; measured stalls max **37 ms**.
  Different failure. (Also: it has **zero consumers** on main and its branch is
  **348 commits behind**.)

## Remaining work, ranked

1. **OWNER, 30 seconds, zero code: Buffer → Stable (45 ms) + reload.** They tried
   Balanced; Stable exists for heavy/video-laden patches. **Diagnostic as well as
   likely fix** — if it works, the underrun mechanism is confirmed.
2. **Cap the video engine loop to 60 fps** (perf-plan P1-4). Halves all engine-side
   video cost on ProMotion (measured −27 ms/s, videoFps 120→60). **Needs owner
   sign-off**: visible frame-rate change, and it halves game-module tick rates
   because pong/modtris/doom tick inside `step()`.
3. **Narrow `recorderbox`'s pull-exempt** to "recording or audio actually
   consumed", so it stops pinning the whole upstream chain when idle.
4. **Card-layer rAF coalescing** (perf-plan P0-1) — ~80 of the 150 ms/s. The card
   present layer is entirely ungated: an offscreen video card still does a
   full-res GL blit + a `drawImage` GPU sync every frame. **74 card files hold
   244 raw rAF sites; 12 files use the shared `onMeterFrame` ticker** (2026-08-12
   re-count — the population is growing, not shrinking). Already half-built.
5. **A per-module render-cost CI gate.** There is none. A module can regress its
   per-frame cost 10× and nothing notices until an unrelated test times out — a
   flaky timeout is the worst possible signal for a perf regression, and it burned
   four consecutive main runs this session.

## SEPARATE P0 found along the way — no ticket yet

**Every patch/preset load permanently leaks ~7,700–9,800 DOM nodes, ~850–1,000
event listeners, and ~25–33 Blink audio handlers**, surviving a forced
`HeapProfiler.collectGarbage`.

Over 5 loads: **4,626 → 52,938 DOM nodes**, 273 → 5,213 listeners, renderer CPU
per cycle **5.3 → 11 s**. **Clearing the rack drops none of it.**

It scales with card count, **not** with video (A/B'd: +9,795 nodes with video vs
+7,657 without), so it does **not** explain the owner's conditional — but for a
performer switching preset slots during a set it is a monotonic drain that would
present exactly as *"bogs down, then stops."*

**If the owner's onset is after N minutes or after switching slots — this, not the
video contention, is the likely culprit.**

## Open questions for the owner

1. Which machine/display do they actually perform on? (All numbers are M5/120 Hz.)
2. **Was RECORDERBOX armed when it happened?** Its full-res `drawImage` +
   main-thread H.264 encode is **entirely unmeasured** and plausibly large.
3. Does Buffer → Stable fix it?
4. Time-to-onset — immediate, or after minutes / preset switches?
5. Video fullscreen or on a second display? (Takes a hard render lease, activates
   the currently-skipped second `videoOut`.)
6. A 10 s Chrome Performance recording during the bog-down + the footer
   `lat …ms / …ms out` readout.
