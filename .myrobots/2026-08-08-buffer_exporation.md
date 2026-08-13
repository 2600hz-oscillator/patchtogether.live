# Buffer resilience, underrun behaviour, and who we are actually like

Date: 2026-08-08 · Research + design only — no source changed, no PR opened.
Commissioned by the owner: *"what we could be doing to better protect against and
behave as well as possible during underrun conditions … come back with a list of
ideas to improve our buffer resilience and performance, which should be
adversarially reviewed."*

---

## Evidence legend — used on every load-bearing claim

| tag | meaning |
|---|---|
| **[M]** | **Measured by me this session** — a number I produced from a run, with the method stated |
| **[V]** | **Verified this session** by reading the repo source at a named file:line |
| **[D]** | From a repo planning doc — **dated, and re-verify before building on it** |
| **[W]** | Read on the web this session (MDN / project sites), with the URL |
| **[K]** | My own prior knowledge, **NOT verified this session** — treat as a hypothesis |

⚠ **A constraint on this report you should know about:** my WebSearch budget was
already exhausted when I reached Part 2, so the prior-art section leans much more
on **[K]** than I would like. The two things I *did* verify on the web this session
turned out to be the two most important facts in the whole report, which is a
warning about how much of the rest is unverified. Part 2 is written so that its
**reasoning** stands even where a specific product claim turns out wrong; I say so
explicitly where that matters.

---

## 0. Bottom line, up front

**The honest top recommendation is: instrument first, decide later.** That is not
a hedge — it is the finding. Every performance conversation this repo has had
about audio dropouts (SHOES1 2026-07-01, the video bog-down 2026-07-29, the
owner's "bogs down then stops") has been argued from *inference*, because the app
has never once measured the thing under discussion. One of those investigations
cost **~4.5 M tokens of agent work [D]** and its own conclusion was that the real
gap is the missing detector.

Three things came out of the session that change what I would build first:

1. **The API our own plans tell us to use does not exist.** `FABLE_PERF_PLAN` and
   the bog-down diagnosis both grep for `renderCapacity|playoutStats|
   onprocessorerror` and report **0 hits [V — confirmed, 0 hits in
   `packages/web/src`, only self-references inside the two `.myrobots` docs]**. The
   "0 hits" conclusion is right. But the *shipped* Web Audio API for this is
   **`AudioContext.playbackStats` → `AudioPlaybackStats`**, carrying
   `underrunEvents`, `underrunDuration`, `totalDuration`, and
   `averageLatency`/`minimum`/`maximum` **[W, MDN]**. `playoutStats` is a different
   API on a different interface. Anyone implementing P1-2 from the plan as written
   would have feature-detected the wrong property name, got `undefined`, and
   concluded the browser didn't support it.

2. **There is a precise, cheap, previously-unnamed mechanism for the word
   "stops".** When an `AudioWorkletProcessor` throws, *"the processor (and thus the
   node) will output silence throughout its lifetime"* **[W, MDN]** — permanently,
   irrecoverably, silently. We have **64 DSP processors [V]**, **72 of 171 audio
   modules instantiate a worklet [V]**, the **master limiter sits in the terminal
   output path with a load-time fallback but no runtime fallback [V,
   `audio-out.ts:165-180`]** — and **zero `processorerror` handlers anywhere [V]**.
   One throw in the limiter silences the entire rack forever with no console
   output and no UI signal. `processorerror` has been **Baseline widely available
   since April 2021 [W]**. This is a ~20-line fix.

3. **A measured pathology in the brief is real but ~5× smaller than stated, and I
   can show why.** See §1.5 — this is the section where measuring changed the
   answer, and it argues against three of my own ideas later.

If only two things ship from this document, they are **Idea 1 (the underrun
counter)** and **Idea 2 (`processorerror` handlers)**. Together they are perhaps
250 lines, add ~0 CI wall-time, and convert every future "it bogs down" report
from a multi-day inference exercise into a number the owner can read off the
footer.

> **They shipped, as #1425 — Ideas 1, 2 AND 3, one day after this was written.**
> `$lib/audio/playback-stats` (underrun counter off `AudioContext.playbackStats`),
> `$lib/audio/worklet-guard` (the `processorerror` latch, with negative controls
> in both directions), `$lib/audio/audio-out-failover` (the master limiter's
> runtime fail-over to `ceilingClipCurve()`), and the tick-latency histogram —
> plus the footer readout. **The instrument now exists; the ideas below that
> depend on it are unblocked and none of them has been built.** Every design
> warning those three sections carried was preserved in the shipped source (the
> `currentTime`-drift detector is refuted at `playback-stats.ts:43-47`; the wrong
> API names at `:15-23`), so §3's Ideas 1–3 were deleted from this file rather
> than left to drift out of sync with the code.

---

# Part 1 — What actually happens today

## 1.1 The headline, verified

Confirmed with `git grep` over the whole repo:

| symbol | hits in `packages/web/src` | hits anywhere |
|---|---|---|
| `renderCapacity` | **0** | 5 — all inside `.myrobots/*.md` planning prose |
| `playoutStats` | **0** | 4 — all inside `.myrobots/*.md` planning prose |
| `onprocessorerror` / `processorerror` | **0** | 3 — all inside `.myrobots/*.md` planning prose |
| `PerformanceObserver` | **0** | **0** |
| `longtask` / `long-animation-frame` | **0** | **0** |

**[V]** — the headline is true, and *broader* than stated: there is no
`PerformanceObserver` of any kind in the web package either. We have no
underrun detector, no jank detector, no long-task counter, and no frame-budget
counter. **We cannot presently distinguish a user's "it bogs down" from "my laptop
was thermally throttled" from "a worklet died" from "the tab was backgrounded".**

> **As of #1425 the first and third of those four ARE now distinguishable** — the
> underrun counter and the `processorerror` latch shipped. The jank / long-task /
> frame-budget half of this paragraph is still true: no `PerformanceObserver`
> anywhere, and no rAF-callbacks-per-frame counter.

The only health surfaces that exist:

- `audio-gate.svelte.ts:88-98` **[V]** — an `AudioContext` `statechange` listener
  that flips a `running` flag and re-shows the click-to-resume overlay. This is a
  genuine (crude) recovery path for a *context-level* suspension, and it is the
  only one. It is blind to worklet death and to underruns.
- `Canvas.svelte:8345` **[V]** — the footer prints
  `lat {baseLatency}ms / {outputLatency}ms out`. `baseLatency`/`outputLatency` are
  plain non-reactive property reads inside a Svelte template, so this re-evaluates
  only when the `audioCtx` *identity* changes — i.e. it is effectively **a static
  boot-time readout**, not a live meter.
- `video/engine.ts:1332,1376` **[V]** — a real `frameRate` EMA
  (`0.9·prev + 0.1·(1/dt)`) already exists and is already published on the frame
  context (`:1384`). **This is the one live performance sensor we have**, it is on
  the video side, and nothing consumes it for health purposes.

## 1.2 The audio path as actually built

**AudioContext.** Constructed once at `Canvas.svelte:7242-7246` **[V]** with
`latencyHint: audioLatencyStore.latencyHint`, then `bootedWith()` records the mode.
No `sampleRate` is pinned (a separate known issue, `dsp-stack-bass-freq-audit`
A2a). There is **no `audioCtx.close()` anywhere [V — 0 hits]**, and **no
`WEBGL_lose_context` anywhere [V — 0 hits]**, so a rack switch (which remounts
Canvas under `{#key rackspace.id}`) leaks a whole running audio graph and a GL
context per switch.

**The buffer ladder** (`audio-latency-store.svelte.ts:44-76` **[V]**):

| mode | `latencyHint` | note |
|---|---|---|
| Low | `'interactive'` | smallest buffer |
| **Tight** | **0.012 s** | **DEFAULT** (`:76`) |
| Balanced | 0.025 s | |
| Stable | 0.045 s | "heavy / video-laden patches" |

Two properties of this ladder matter enormously and are both correctly documented
in the file's own header comment **[V, `:18-28`]**:

- `latencyHint` is **construction-only**. Changing it requires a **page reload**.
  The UI says so (`Canvas.svelte:8361`, "⟳ reload to apply").
- The default is the **second-tightest** setting. So the out-of-box configuration
  is the one with the least slack against main-thread contention, on an app whose
  main thread also runs 239 uncoordinated animation loops (below).

The comment at `:24-28` gives the reason a live rebuild was rejected — a
half-rebuilt graph with dangling nodes is itself a click source. That reasoning is
sound and I am **not** proposing to overturn it (see Idea 6, and its kill in §4).

**The scheduler clock — a correction to the brief.** The brief describes "the
`getSchedulerClock()` 25 ms main-thread tick". Reading
`scheduler-clock.ts` **[V]**: the **tick *source* is a Web Worker**
(`:95-115`, an inline Blob worker running `setInterval`), explicitly so that the
cadence survives main-thread jank; there is a `setTimeout` fallback only when
`Worker` construction fails (`:122-126`). The **subscriber callbacks then run on
the main thread** (`:102-105` → `dispatch()`), each guarded by try/catch
(`:85-89`).

That distinction is load-bearing for this report. **The tick cannot be lost, but
its *work* can be arbitrarily delayed** — the worker keeps posting, the messages
queue, and they drain in a burst when the main thread frees up. Combined with the
200 ms lookahead each module keeps, this is why the bog-down diagnosis measured
**0 missed scheduler ticks over 7 minutes at full speed [D]** while the owner was
still reporting dropouts. **The scheduler is not the failure surface. Do not go
looking there again.**

**Worklet population.**

| quantity | count | source |
|---|---|---|
| DSP processor sources (`packages/dsp/src/*.ts`, non-test) | **64** | **[M]** `ls \| wc -l` |
| `audioWorklet.addModule` sites in web src | **72** | **[V]** |
| `new AudioWorkletNode` in `audio/modules/*.ts` | **62** | **[V]** |
| audio modules that instantiate a worklet | **72 of 171** | **[V]** |
| unconditional `return true` in `packages/dsp/src` | **135 across 64 files** | **[V]** |
| `return false` in `packages/dsp/src` | **3 — none of them lifecycle** | **[V]** (`cube.ts:489`, `hypercube.ts:302`, `lib/cube-dsp.ts:83`; all three are wavetable-cache early-outs, not processor termination) |
| dual-mono ledger entries (module built **twice**, once per channel) | **27** | **[V]** `dual-mono.ts` |

`instantiateFaustModule` (`faust-runtime.ts:39-68` **[V]**) returns a bare
`AudioWorkletNode` — the `FaustMonoAudioWorkletNode` wrapper's `destroy()` is
never surfaced to callers and **has zero call sites [V]**. Module `dispose()`
implementations exist and do run (`engine.ts:317,340,907` **[V]**) but they only
`disconnect()`. Per Web Audio lifetime rules **[K]**, a processor whose `process()`
returns `true` stays scheduled by the render thread for the context's lifetime
regardless of connection state. **So every module delete and every preset-slot
switch leaves its processors resident on the render thread.** This is
`FABLE_PERF_PLAN` P0-3, still marked `[U]` — *the verifier declined to rule on it*
**[D]** — and I have not been able to rule on it either (see §5).

## 1.3 What happens on a dropped render quantum today

Four *distinct* failure modes are conflated under "underrun". They need different
detectors and different responses, and nothing in the app currently distinguishes
them:

| # | failure | what the user hears | detectable today? | the right instrument |
|---|---|---|---|---|
| **A** | **Device-layer underrun** — the render thread misses the device deadline; the driver plays silence or a repeat | click / pop / crackle | **NO** | `playbackStats.underrunEvents` **[W]** |
| **B** | **Worklet processor death** — a `process()` throws | that module goes **permanently silent** | **NO** | `processorerror` event **[W]** |
| **C** | **Context suspension** — browser/OS suspends the context | everything stops, overlay returns | **partly YES** | `statechange` **[V]**, already wired |
| **D** | **Scheduler-work delay** — main thread too busy to run tick callbacks inside the lookahead | late/missed sequenced events, tempo jitter | **NO** | tick-latency histogram (cheap; see Idea 3) |

**Mode A is what "buffer resilience" normally means, and it is the one we can do
least about directly** — by the time the device is starved, the damage is done.
The lever is prevention (headroom) plus detection (so the user can be told to take
the headroom).

**Mode B is the one nobody has named**, and it is the one that matches the owner's
words most precisely.

## 1.4 "Bogs down, then stops" — taking the second clause seriously

Every prior investigation modelled this as one phenomenon of increasing severity.
I think it is **two mechanisms**, and the second one has a clean explanation nobody
has proposed:

> **"Once an exception is thrown, the processor (and thus the node) will output
> silence throughout its lifetime."** — MDN, `AudioWorkletNode: processorerror`
> event **[W]**

That is not degradation. That is a **latch**. It is irreversible for the life of
the node, it produces exactly "stops completely", it leaves the AudioContext in
`running` state (so the click-to-resume overlay does *not* appear, and the user's
only recourse is a page reload — which is what the owner does), and **with no
handler registered it prints nothing to the console.**

The exposure is maximal because of where our worklets sit:

- The **master limiter is a worklet in the terminal path** (`audio-out.ts` stage 2
  **[V]**). Its `try/catch` at `:165-180` covers **`addModule` failure only** — a
  load-time fallback to a `WaveShaper` hard-clip curve (`ceilingClipCurve()`,
  `:80-89`). **A runtime throw inside `process()` is not covered by that catch and
  cannot be**, because it happens on the render thread after construction
  succeeded. If the limiter latches, *the whole rack goes silent*, permanently,
  with no diagnostic.
- 72 of 171 audio modules carry a worklet **[V]**; 27 modules are built **twice**
  under dual-mono **[V]**, doubling the number of processor instances that can
  latch.

**Is this what actually happened to the owner? I do not know, and I want to be
explicit that I am proposing a mechanism, not diagnosing a cause** — this is the
exact trap the `agent-orchestration` skill records ("a plausible mechanism is not a
measurement"). What I can say is: it is *consistent with the reported symptom in a
way that CPU contention is not*, it is **free to rule in or out** (one event
handler), and until we add that handler we can never rule it out at all.

The "bogs down" clause remains best explained by main-thread contention starving
the render thread — the mechanism the 2026-07-29 diagnosis established with a real
dose-response curve (late 25 ms ticks under a 6× CPU handicap: full patch 17/20 →
−peakstate 6 → −recorderbox 5 → −backdraft 0 → no video 0) **[D]**. That is good
evidence and I am not relitigating it.

## 1.5 The measured pathologies, re-verified

This is the section where measuring changed the answer.

### samsloop's O(n²) capture — REAL, but ~5× smaller than the brief states, and structurally bounded

The brief cites *"an O(n²) capture loop in samsloop burning ~14% of a core at
60 s"*. I found the loop, and it is **worse per-callback than described** — and
then **capped far below the cited duration**, which makes the headline number
describe a recording the module cannot make.

**The loop [V].** Two of them, actually. `SamsloopCard.svelte:283-296` —
`onTapChunk` grows **both** accumulators by full copy on every message:

```js
const lNext = new Float32Array(accL.length + l.length);
lNext.set(accL, 0);
lNext.set(l, accL.length);
accL = lNext;
// …and the identical block again for accR
```

with the same pattern a third time in `samsloop.ts:692-706` (`samsloopRecAppend`).
The producer is the `samsloop-tap` worklet, which posts **one message per
128-sample block** (`packages/dsp/src/samsloop-tap.ts:72` **[V]**) = **375
messages/second at 48 kHz**, each carrying two cloned `Float32Array(128)`. It all
runs on the **main thread**, in a `MessagePort` listener
(`SamsloopCard.svelte:262-271` **[V]**).

**The measurement [M].** I ran the shipped algorithm at the real message rate in
Node (script: `scratchpad/samsloop-append.mjs`, `samsloop-tail.mjs`; single
channel, so **double every figure below** for the shipped L+R path):

```
 10s recording | msgs=3750  | grow-by-copy  112.6 ms | prealloc 0.3 ms | 449x  | memcpy   3.6 GB
 30s recording | msgs=11250 | grow-by-copy 1319.5 ms | prealloc 0.4 ms | 3446x | memcpy  32.4 GB
 60s recording | msgs=22500 | grow-by-copy 4860.8 ms | prealloc 0.8 ms | 5868x | memcpy 129.6 GB
```

Per-callback cost late in the recording — the number that actually matters for
jank, since this is 375 discrete main-thread tasks per second:

```
elapsed | per-callback (median of last 200) | vs 2.667ms quantum | vs Tight 12ms buffer
  10s   |  0.055 ms                          |   2%               |  0%
  30s   |  0.175 ms                          |   7%               |  1%
  60s   |  0.301 ms                          |  11%               |  3%
 180s   |  1.535 ms                          |  58%               | 13%
```

**Now the correction.** Recording auto-stops at `maxSecondsExact`, derived from
`SAMSLOOP_RECORD_BUDGET_BYTES = 250_000` **[V,
`samsloop-record.ts:32`]** divided by `rate × bytesPerSample × channels`, with
options `{22050, 44100} × {8, 16} × {1, 2}` **[V, `:38-40`]**:

- **Default** (44100/16/2, `:49-53` **[V]**) → **1.42 s**
- **Longest legal recording** (22050/8/1) → **11.34 s**

So the real worst case is the **10 s row**: `112.6 ms × 2 channels = 225 ms` of
main-thread CPU over 10 s ≈ **2.3 % of one core average**, tail per-callback
`0.055 × 2 = 0.11 ms` ≈ **4 % instantaneous**. The 60 s figure describes a
recording samsloop refuses to make.

> **⚠ The finding is the correction, not the bug.** "~14 % of a core" and "~2 % of
> a core" lead to completely different priorities, and the difference was one
> `grep` for the cap constant. The quadratic *shape* is real and worth fixing on
> principle (it is a 6-line change to a preallocated buffer, and the measured
> speedup is **449×** even at the 10 s bound), but **samsloop is not the owner's
> "bogs down then stops"** — the timescale is wrong by an order of magnitude, and
> the owner's report was about a video-laden patch, not a recording session.
> I am moving it out of the top tier of my own list on the strength of this.

### Everything else, re-verified today

| claim in brief | status | measured value |
|---|---|---|
| ~239 raw rAF sites across 73 card files | **CONFIRMED exactly [M]** | **239 sites / 73 files** in `ui/modules`; 302 sites / 101 files across all of `packages/web/src` |
| only 9 on the shared `onMeterFrame` ticker | **CONFIRMED, and it's 8 [M]** | **8** `onMeterFrame(` call sites: 5 real cards (Dockscope, Drumseqz, Macseq, Polyseqz, Scope) + 2 shared controls (`VuMeter`, `ScopeScreen`) + `shell-glyph-live.ts`. **KriaCard's import at `:17` is still dead** — imports the ticker, never calls it, still runs a raw loop |
| 0 worklet `destroy()` call sites | **CONFIRMED [V]** | 0 call sites; 135 unconditional `return true` across 64 DSP files; the 3 `return false` are wavetable cache-hits, not lifecycle |
| video engine has no fps cap / no `document.hidden` gate | **CONFIRMED [V]** | `engine.ts:1797-1818` — `ensureLoop` reschedules unconditionally while `nodes.size > 0`; the only gate is an **e2e-only** `__videoEnginePause` hook (`:1809`) |
| `recorderbox` pull-exempt pins the upstream chain | **CONFIRMED [V]** | `isPullExempt` (`:1013-1020`) returns `true` for **any** handle with non-empty `audioInputs`, regardless of arming |
| preset/patch load leaks 7,700–9,800 DOM nodes per load | **COULD NOT RECONCILE — see §5** | I could not reproduce this without a browser session, and could not locate #1262's evidence in the tree. **Treat as unresolved, not as fact.** |
| Electra CC writes "murdered video rendering" | **superseded [D + V]** | fixed in #1030 via `createCcCommit` transient-first; `cc-commit` is now consumed by both `electra/host.ts:173` and `push2-control.svelte.ts:831` **[V]** |
| 733 `readLive` polling sites (plan said 691) | **grew [M]** | **733 sites / 122 files** — each `readLive` prop spins a private permanent rAF in `Knob.svelte:147-152` / `Fader.svelte:199-201` **[V]**, ungated by visibility |

**Thread inventory [V].** Beyond main + the AudioWorklet render thread we spawn up
to four workers: `scheduler-clock` (inline Blob), `es9/bridge.worker`,
`video/worker/render-worker` (**default ON since #1047** **[D]**), and
`recorderbox-recorder`'s encoder worker. On a video-laden patch that is ~6 threads
contending, and **the AudioWorklet render thread shares the renderer process with
the compositor and all the WebGL work [D]**.

## 1.6 What instrumentation would have answered the owner's report in one session

This is the practical outcome the brief asks for. Five signals, all cheap, all
implementable in a day, that would have collapsed the 4.5 M-token investigation.
**Signals 1–3 shipped as #1425. Signals 4 and 5 did not, and are still open** —
the rAF-per-frame counter, and making the footer's `outputLatency` reactive
rather than a static boot-time read.

| # | signal | source | which of A/B/C/D it isolates | cost |
|---|---|---|---|---|
| 1 | `underrunEvents`, `underrunDuration`, `totalDuration`, `max/avgLatency` | `ctx.playbackStats` **[W]** | **A** definitively | ~40 lines |
| 2 | `processorerror` fired, with node id + module type | `AudioWorkletNode` event **[W]** | **B** definitively | ~20 lines |
| 3 | scheduler tick-latency histogram (worker post → main dispatch) | `scheduler-clock.ts` `dispatch()` | **D**, and separates "main thread busy" from "audio thread starved" | ~30 lines |
| 4 | rAF callbacks/frame + the existing `frameRate` EMA | `meter-frame.ts` counter + `engine.ts:1332` **[V]** | attributes **A** to the render load | ~15 lines |
| 5 | live `outputLatency` in the footer (it is already there, just not reactive) | `Canvas.svelte:8345` **[V]** | confirms the buffer setting actually took | ~5 lines |

Together these answer, from **one screenshot of a footer**, every one of the six
open questions the bog-down diagnosis had to leave for the owner **[D]** — which
machine, was recorderbox armed, does Stable fix it, time-to-onset, fullscreen or
not, and what the latency readout said.

**That is the argument for "instrument first" in its strongest form: the
instrumentation is cheaper than one round of the guessing it replaces.**

---

# Part 2 — Prior art, and the question he actually asked

## 2.1 Why "multiuser DAW" is the wrong search term

The owner couldn't find another multiuser DAW. I think that is because the
category is genuinely near-empty, but also because **product category is the wrong
axis**. Decomposing by what actually constrains us:

| axis | our load | who else has this |
|---|---|---|
| **1. Hard-realtime audio thread** | 128-frame quantum, 12 ms buffer default, 64 WASM/JS processors | native DAWs, pro-audio infra, game audio middleware, a handful of browser DAWs |
| **2. CRDT multiplayer over shared mutable state** | Yjs/syncedStore, ≤4 users/rack, relay + IndexedDB | Figma, tldraw, Excalidraw, Miro, Linear |
| **3. Continuous GPU render loop** | uncapped rAF, one shared WebGL2 context, 94 video modules | Hydra, Cables.gl, Shadertoy, Rive |
| **4. Hundreds of independent live UI animations** | 239 rAF sites, 733 `readLive` polls | ~nobody — this is unusual |
| **5. All four on ONE main thread, simultaneously, in a browser** | yes | **nobody I can identify** |

Axes 1–4 each have mature prior art. **Axis 5 is the actual product, and I could
not find a precedent for it.** That is not romanticism — it is the reason our
failure mode is *cross-domain contention* (video starving audio) rather than any
single domain being too slow, which is exactly what the 2026-07-29 diagnosis
measured **[D]**.

## 2.2 The defensible answer to "who are we most like"

**We are Figma's CRDT load and Hydra's render load sharing a main thread with a
hard-realtime audio graph that neither of them has.** The honest short answer the
brief pre-authorised turns out to be the correct one. But two refinements make it
more useful than a shrug:

**Closest single product: Audiotool** — a browser-based *modular* studio where you
patch cables between devices on an infinite canvas, from the same lineage as
**openDAW** (both André Michelle; openDAW confirmed this session as a web DAW,
AGPL, with a WASM audio engine on its roadmap for Q2 2026 **[W,
github.com/andremichelle/opendaw]**). Audiotool matches us on the *interaction
model* — spatial patch canvas, cables, many small DSP devices — which is a far
better match than any linear-timeline DAW. **What I could not verify this session
[K]:** whether Audiotool's collaboration is genuinely realtime-concurrent or
turn-based/asynchronous, and what its overload strategy is. **openDAW's README
does not mention collaboration or underrun handling at all [W]** — which is itself
a data point supporting the owner's search coming up empty: the most serious open
browser-DAW effort in 2026 is not attempting multiplayer.

**Closest single *engineering problem*: a game engine.** Not a DAW. Games solved
exactly our shape — a hard-realtime audio thread that must never miss, a render
loop that may, and shared mutable world state — and they solved it with a
**priority hierarchy that is declared, not emergent**: audio is a fixed-cost
budget that is never yielded, rendering absorbs all variance, and gameplay logic
runs on a fixed timestep decoupled from both. **We have the same three workloads
and no hierarchy at all** — our video loop and our audio graph compete as peers,
and the video loop is the one with no cap.

## 2.3 Neighbour by neighbour — what they do about overload that we don't

⚠ **Everything in this table is [K] unless marked otherwise, and was not
re-verified this session.** The *transferability* column is my own reasoning and
is where the value is; treat the middle column as a hypothesis to check before
building.

| neighbour | what they do about overload **[K]** | transferable to our main thread? |
|---|---|---|
| **JACK** (pro audio infra) | First-class **xrun accounting**: a callback, a counter, and `jack_get_xrun_delayed_usecs`. An xrun is a *named, counted, reportable event*, not a vibe | **YES, directly.** This is precisely `playbackStats.underrunEvents` **[W]**. The transferable idea is cultural: *give the failure a name and a counter and put it in the UI* |
| **CoreAudio** | `kAudioDeviceProcessorOverload` notification to the client | **YES** — same shape; same answer |
| **PipeWire** | **Quantum negotiation**: the graph's buffer size is dynamic and renegotiated per-client at runtime | **PARTIALLY, and this is the interesting one.** Web Audio's `latencyHint` is construction-only **[V]**, so we cannot renegotiate. But PipeWire's *policy* — "the graph picks a quantum that satisfies its heaviest member" — maps onto **choosing the boot buffer from the patch** (Idea 5), which we *can* do, because the context boots after patch sync |
| **Native DAWs** (Ableton/Bitwig/Reaper) | Always-visible CPU meter; a **visible dropout/overload indicator**; explicit user levers (buffer size, freeze/bounce, plugin bypass); Reaper will *auto-bypass* the offending FX chain rather than glitch the master | **YES for the meter and the indicator** (Idea 1). **Freeze/bounce is the deep idea we lack entirely** — the ability to render a heavy subgraph to a buffer and play *that*. Large; parked |
| **Game engines / FMOD / Wwise** | **Voice stealing + priority + virtualisation**: a hard voice cap, and when exceeded the *least important* voices go "virtual" (position tracked, not rendered). Audio thread is highest priority and its budget is fixed | **YES conceptually** — we already have an LRU voice allocator (#991 **[D]**). The missing half is **module-level** priority: nothing declares that BACKDRAFT is more sacrificeable than MIXMSTRS |
| **Fixed-timestep game loop** ("Fix Your Timestep") | Simulation on a fixed step, render interpolated, **accumulator clamped** so a slow frame cannot spiral | **YES** — our video `ensureLoop` **[V]** has no cap and no accumulator clamp, so on a 120 Hz display it does 2× the work of the 60 Hz assumption **[D: measured 120 fps]** |
| **Figma** | Renders in **WASM+WebGL off the main JS thread**; multiplayer state is a purpose-built CRDT with server-side authority; sends *deltas*, coalesces cursor/awareness traffic aggressively | **PARTIALLY.** The big transferable is **awareness/cursor traffic is not graph traffic** — separate channel, separate rate. Moving our render off-thread is #1047's texture co-processor, already default-ON **[D]** |
| **tldraw / Excalidraw** | rAF-coalesced single render loop; **one** loop for the whole document, never per-shape | **YES, strongly.** This is the single sharpest contrast: they have **1** loop for N shapes; we have **239** for N cards **[M]**. Their architecture makes our P0-1 structurally impossible to regress into |
| **Hydra / Cables.gl** | Single GPU pipeline, one rAF, explicit resolution/fps controls exposed *to the user* as first-class performance levers | **YES** — the *user-facing* framing matters: they treat "drop resolution / drop fps" as a normal creative control, not an error state. That is the right framing for Idea 4 |
| **BandLab / Soundtrap / Amped / Soundation** **[K, low confidence]** | Timeline DAWs; my understanding is they lean on **pre-rendered/bounced audio** and comparatively light live-DSP graphs, with collaboration that is project-level rather than realtime-concurrent | **Weak neighbours.** Their constraint is streaming and mixdown, not a live modular graph. I would not mine them for overload strategy |
| **Ableton Note / web bits** **[K, low confidence]** | Mobile-first, small fixed instrument set | Weak neighbour |

## 2.4 The three ideas from prior art we most conspicuously lack

Stripping the table to what is actually missing:

1. **A named, counted, user-visible overload event.** Universal in pro audio
   (JACK xruns, CoreAudio overload, every native DAW's dropout LED). We have
   nothing. This is Idea 1.
2. **A declared degradation hierarchy.** Games/FMOD decide *in advance* what gets
   sacrificed. We have no priority ordering between audio, video, and UI at all —
   under pressure everything degrades equally, which for a musical instrument is
   the worst possible policy. This is Idea 4.
3. **One render loop, not N.** tldraw/Figma/Hydra all have exactly one. We have
   239 **[M]**. This is the existing P0-1 and I am not going to pretend I improved
   on it — but prior art says it is not merely an optimisation, it is *the*
   architectural difference.

---

# Part 3 — Ideas, ranked

Ranked by (expected win) ÷ (cost × risk). Each carries how I would measure whether
it worked — and for the ones where the measurement is the hard part, that is
called out.

> **Two traps every idea below is checked against, per the brief:**
> **(i)** no renderer-dependent budget expressed in milliseconds — count frames;
> **(ii)** no page-side quantity sampled by a Playwright-side poll loop —
> accumulate inside the page.

### Summary table

| # | idea | win | cost | risk | tier |
|---|---|---|---|---|---|
| 1 | Underrun counter from `playbackStats` + footer readout | **transformative** — the missing sense organ | S (~40 LOC) | very low | **SHIPPED #1425** |
| 2 | `processorerror` handler on every worklet node | **transformative** — explains "stops"; makes it recoverable | S (~20 LOC) | very low | **SHIPPED #1425** |
| 3 | Scheduler tick-latency histogram | high (separates A from D) | S (~30 LOC) | very low | **SHIPPED #1425** |
| 4 | Audio-first degradation policy, **user-chosen** | high | M | med (visible) | do second |
| 5 | Patch-aware boot buffer default | med-high | S | low | do second |
| 6 | Live buffer change without reload | med | L | **high** | **KILLED — §4** |
| 7 | Fix samsloop's O(n²) + audit the pattern repo-wide | low-med (bounded) | S | very low | boy-scout |
| 8 | Worklet termination (P0-3) | unknown — **measure first** | S then L | med | **measure before building** |
| 9 | rAF coalescing (existing P0-1) | high, known | M-L | med | already planned; endorse |
| 10 | Video engine: fps cap + `document.hidden` gate + accumulator clamp | high | S | med (visible) | owner sign-off |
| 11 | CRDT back-pressure: awareness split from graph traffic | med | M | med | after 1-3 |
| 12 | Per-module render-cost CI gate | med (prevents regressions) | M | **blind-gate risk** | after 1-3 |

---

### Ideas 1, 2 and 3 — **SHIPPED as #1425, one day after this was written**

The underrun counter (`$lib/audio/playback-stats`), the `processorerror` handler
on every worklet node (`$lib/audio/worklet-guard`, plus the master limiter's
runtime fail-over in `$lib/audio/audio-out-failover`) and the scheduler
tick-latency histogram all landed together. Their design sections are deleted
rather than left here to drift out of sync with the code they became — every
warning they carried survives as source comments, negative-controlled in both
directions in the unit lane.

Two of those warnings are worth restating because they generalise:

- **`underrunEvents` can never be asserted in Playwright.** Headless Chromium
  uses a **null audio sink** — measured `outputLatency` **0.072 ms** vs 10–25 ms
  on real hardware — so a device underrun *literally cannot occur* and
  `expect(underruns).toBe(0)` is **vacuously green forever**. Real validation is
  owner hardware, or a debug worklet that busy-waits per quantum.
- **Comparing `ctx.currentTime` against `performance.now()` is NOT an underrun
  detector.** The device clock keeps consuming at 48 kHz whether the buffer held
  real audio or silence, so `currentTime` advances at wall-clock rate straight
  *through* a dropout. It returns a clean, confident, always-zero number — the
  Pearson-correlation failure of 2026-07-28 in a new costume.

**What this changes for everything below:** Ideas 4, 5, 8 and 10 were all blocked
on having a sensor. They are not blocked any more, and none of them has been
built.

---

### Idea 4 — An audio-first degradation policy the **user** chooses

**Mechanism.** A declared priority hierarchy, driven by Idea 1's counter, with the
policy exposed as a **setting, not a surprise**:

- **"Protect audio"** (default for a music instrument): on sustained underruns,
  degrade video first — halve the video engine's step rate, then drop preview
  resolution, then stop off-screen card presents entirely.
- **"Protect visuals"**: for VJ use; leave video alone and surface the audio
  warning instead.
- **"Don't adapt"**: report only.

**Expected win.** Degraded video instead of glitched audio, which for an instrument
is the correct trade. This is the FMOD/Wwise virtualisation idea and the Hydra
resolution-control idea combined.

**Cost.** M. Depends entirely on Idea 1 shipping first.

**Risk.** **Medium and visible.** A frame-rate change is a look change → owner
review before merge, per `video-aspect-resolution-review-before-merge` **[memory]**.
⚠ **A real hazard the plan already flags [D]:** pong/modtris/doom tick *inside*
`video/engine.ts` `step()`, so halving the step rate **halves those games' logic
rate**. Any governor must exempt game modules or decouple their tick — otherwise
"protect audio" silently makes DOOM run at half speed.

**Why user-chosen.** The brief asks explicitly whether the user chooses. **Yes, and
it matters.** An automatic governor that silently halves the frame rate during a
VJ set is a bug from the user's point of view, however correct it is from the audio
thread's. Prior art agrees: Hydra/Cables expose resolution and fps as creative
controls, not as error handling.

**How I'd measure.** Underrun counter (Idea 1) with the governor on vs off, on the
owner's heavy patch, on real hardware. ⚠ **Count frames, never milliseconds**, for
any assertion about the governor's effect on the render loop — under
`E2E_SWIFTSHADER=1` we measure **7.9 fps vs ~60 on a real GPU** **[repo standard]**,
so a "video halved within 2 s" assertion is a different assertion on every machine.
Assert *frames advanced per N ticks of the audio clock*.

---

### Idea 5 — Patch-aware boot buffer default

**Mechanism.** The AudioContext boots on a user gesture *after* the patch has
synced **[V, `Canvas.svelte:7242`]**, so the patch composition is known at
construction time — the one moment `latencyHint` can be set **[V]**. If the patch
contains video-domain nodes, or more than N worklet-bearing modules, boot
**Balanced/Stable** instead of Tight. Show why ("heavy patch — booted at Stable"),
and let the user override.

**Expected win.** The default configuration stops being the least-resilient one for
exactly the patches that need resilience most. This is PipeWire's quantum
negotiation, implemented within the one constraint Web Audio gives us.

**Cost.** S — a function from the synced patch to a mode id, plus a UI line.

**Risk.** Low. Worst case a light patch boots with 45 ms latency; the override is
one click and the user already understands the control.

**How I'd measure.** Unit-test the classifier (pure function, patch → mode).
Real-world: the Idea 1 counter, cold-boot on the owner's patch, before/after.

---

### Idea 6 — Live buffer change without a reload · **KILLED — see §4**

---

### Idea 7 — Fix samsloop's grow-by-copy, then audit the pattern

**Mechanism.** Preallocate to the known cap (`SAMSLOOP_MAX_SAMPLES` /
`maxSecondsExact` are both known at record start **[V]**) and write at an offset,
instead of `new Float32Array(n+k)` + full copy, in all three sites
(`SamsloopCard.svelte:283-296` ×2, `samsloop.ts:692-706`).

**Expected win.** **449× on the copy at the 10 s bound [M]**, and it removes ~375
allocations/second of GC pressure. But in absolute terms only **~2 % of one core
[M]** — see §1.5. **This is a cleanliness fix, not a resilience fix.**

**Cost.** S, ~6 lines per site. **Risk.** Very low.

**The reason it is still worth doing:** the *pattern* is the risk, not this
instance. A `new TypedArray(n+k)` + full copy inside a per-quantum message handler
is a quadratic loop waiting for someone to raise a cap. A source-level grep for
that shape across message handlers is cheap and would catch the next one — which is
the repo's own "guard it at the SOURCE level" precedent.

> **PARTLY DONE — #1422.** The CARD's capture path was pre-allocated, and the
> live-peak fold (a second quadratic term this section missed) with it. **And it
> raised the cap 1.42 s → 31.25 s, i.e. 22×**, which is precisely the "someone
> raises a cap" scenario above. **`samsloopRecAppend`
> (`audio/modules/samsloop.ts:698-713`) still does `new Float32Array(n+take)` +
> full copy on every call**, and the repo-wide source grep for the shape was
> never done. Both remain open.

**How I'd measure.** The scratch harness already written
(`scratchpad/samsloop-append.mjs`) — same shape, before/after, asserting the
prealloc path is O(1) per callback.

---

### Idea 8 — Worklet termination (P0-3) · **MEASURE BEFORE BUILDING**

**Mechanism.** Phase 1: surface and call Faust's `destroy()` in module disposes.
Phase 2: a shared `worklet-lifecycle` port message → processors `return false`.

**Why it is not in the top tier despite looking like the biggest structural win.**
The claim is that orphaned processors accumulate monotonically on the render
thread. The mechanism is real **[K, Web Audio lifetime rules]** and the greps hold
**[V: 0 `destroy()` call sites, 135 unconditional `return true`, 3 non-lifecycle
`return false`]** — but **`FABLE_PERF_PLAN` marks P0-3 `[U]`: its own adversarial
verifier declined to rule on it [D]**, and I could not rule on it either. I have
**no measurement** that the render thread's CPU actually grows across
add/delete/slot-switch cycles.

**And the measurement is now cheap, because Idea 1 provides it.** With the underrun
counter and `playbackStats.averageLatency` live, a scripted soak (10× add-20-modules
→ delete-all) either shows a monotonic climb or it doesn't. **That is a one-hour
experiment that decides between an S-effort fix, an L-effort fix touching all 64
worklet sources and re-pinning ~48 ART `.sha` files [D], and doing nothing.**

Running it before building is the entire point of §1.5's lesson.

---

### Idea 9 — Finish the rAF coalescing (existing P0-1) · endorse, don't redesign

**239 sites / 73 files, 8 on the ticker [M]** — re-counted 2026-08-12 as **244
sites / 74 files, 12 on the ticker**, so the population is *growing*.
tldraw/Figma/Hydra all run exactly one loop **[K]**. I have nothing to add to the
existing plan's design and I am not going to pretend otherwise — **the
contribution here is prior-art confirmation that this is architectural, not an
optimisation.** Two concrete notes:

- **KriaCard is still a 2-line fix** — it already imports `onMeterFrame`
  (`KriaCard.svelte:17`) and never calls it, running its own rAF at `:222`
  instead. Still true 2026-08-12. Free.
- **The 733 `readLive` knob/fader polls [M]** are a separate, larger population
  than the 239 card loops and are governed by only **2 shared components**
  (`Knob.svelte`, `Fader.svelte` **[V]**). Fixing 2 files coalesces hundreds of
  loops — the best effort-to-win ratio in the whole coalescing program.

**How I'd measure.** A rAF-callback-per-frame counter *inside the ticker*, read
from a page-side accumulator. ⚠ **Never poll this from the Playwright side** —
`await page.evaluate(read)` in a loop is one round-trip per sample **on the same
main thread as the subject**, so a loaded runner starves sampler and subject
together and "frozen" is indistinguishable from "never looked" **[repo standard]**.
Accumulate in-page on a `setInterval` finer than the tick, return the whole series,
and report `samples`/`elapsedMs` in the assertion message.

---

### Idea 10 — Video loop: fps cap + `document.hidden` gate + accumulator clamp

**Mechanism.** `ensureLoop` (`engine.ts:1797-1818` **[V]**) reschedules
unconditionally while `nodes.size > 0`, with the only gate being an e2e-only
`__videoEnginePause` hook (`:1809`). Add: (a) a frame-rate cap so a 120 Hz display
does not do 2× the work of the 60 Hz assumption (**measured 120 fps, −27 ms/s when
capped** **[D]**); (b) a `document.hidden` gate; (c) a fixed-timestep accumulator
with a clamp, so a slow frame cannot spiral.

**Cost.** S. **Risk.** Medium and visible — same game-module tick hazard as Idea 4;
needs owner sign-off **[D]**.

**How I'd measure.** Frames advanced per N audio-clock ticks, before/after — **not
a wall-clock budget**, for the SwiftShader reason above.

---

### Idea 11 — CRDT back-pressure: split awareness from graph traffic

**Mechanism.** Figma's lesson **[K]**: cursor/awareness/presence is high-frequency,
lossy, and must never share a rate limit with document mutations, which are
low-frequency and lossless. Audit whether our awareness updates and our graph
updates flow through the same coalescing budget, and split them if so.

**Status.** The worst offenders here are **already fixed** and I want to be clear
about that rather than re-propose them: knob/fader writes are rAF-coalesced, node
positions commit on dragstop only, and the Electra CC write-storm was fixed by
`createCcCommit`'s transient-first path (#1030), now consumed by both Electra and
Push 2 **[V]**. `FABLE_PERF_PLAN` explicitly says **"Do not re-optimize input
handlers" [D]** and I agree.

**What is left** is the *read* side: 19 module files enumerating
`Object.values(livePatch.nodes|edges)` over the SyncedStore proxy inside 40 Hz
scheduler ticks (P1-3 **[D]**). That is main-thread cost on the exact thread whose
contention starves the render thread. **Medium priority, well-specified already.**

---

### Idea 12 — Per-module render-cost CI gate

**Mechanism.** A budget per module for per-frame cost, asserted in CI, so a 10×
regression is caught by a named gate rather than by an unrelated test timing out —
which is the worst possible signal and burned four consecutive main runs **[D]**.

**⚠ I am flagging my own idea as blind-gate-prone**, per the repo standard:

- On CI's **SwiftShader** renderer, per-frame cost is ~7.6× the real-GPU figure
  **[repo standard]** and varies with shard contention across *ten* parallel
  shards. A wall-clock budget here is not one assertion — it is a different
  assertion per run. **It must be a relative/ratio metric** (this module vs a
  fixed reference module in the same run), never an absolute millisecond budget.
- ~~**It must ratchet in both directions** (`actual <= CEILING` *and*
  `CEILING - actual === 0`).~~ **DEAD ADVICE as of 2026-08-10 — do not build
  this.** Ratchets were eliminated repo-wide (#1455 / #1458 / #1486) under a P0
  owner directive: *"eliminate ratchets entirely even if we lose test coverage as
  a result."* A hand-typed per-module cost ceiling is exactly the construct that
  auto-merges cleanly and wrongly across parallel branches. If this gate is ever
  built it must be a **relative** assertion (this module vs a reference module in
  the same run) with **no typed population count and no typed budget literal**.
- **It must state its own scope**: which modules it covers, asserted at zero for
  the ones it doesn't, so "not covered" cannot read as "covered and passing".

Without all three, this gate is decoration. **With them it is still the weakest
item on the list**, which is why it is last.

---

# Part 4 — Adversarial review of my own list

## 4.1 KILLED: Idea 6, live buffer change without a reload

I proposed it because "reload to apply" is genuinely poor UX for a performer, and
because PipeWire's dynamic quantum is attractive prior art. **It should not be
built, and the repo already knew why before I proposed it.**

`audio-latency-store.svelte.ts:24-28` **[V]** states the case, and it is correct:

> *We deliberately do NOT live-rebuild the whole AudioContext + audio graph: a
> graceful teardown/reboot that re-creates every worklet node, re-wires the
> reconciler, and re-acquires the ES-9 duplex stream is far riskier than a reload,
> and a half-rebuild that leaves dangling nodes is exactly the kind of click-source
> we're fixing.*

Three independent reasons it fails on contact with our workload:

1. **It would rebuild 72 worklet-bearing modules and up to 27 dual-mono doubles
   [V]** — mid-performance, while audio is playing. The failure mode of a partial
   rebuild is *the exact symptom we are trying to eliminate*.
2. **It contradicts Idea 8's own premise.** If orphaned processors really do
   accumulate (P0-3 **[D]**), then a live context rebuild that drops the old
   context without closing it is the single most efficient way to leak an entire
   audio graph. And we have **no `audioCtx.close()` anywhere [V]** — so the leak is
   guaranteed, not hypothetical.
3. **PipeWire is not transferable here.** Its renegotiation works because the
   *server* owns the graph and can quiesce it atomically. In Web Audio the page
   owns the graph and there is no atomic quiesce. The prior art is real; the
   analogy is false. **This is me being seduced by a neighbour's solution to a
   problem they have and we don't.**

Idea 5 (patch-aware boot default) captures ~80 % of the user-visible benefit at
~5 % of the risk, by making the *one* moment we are allowed to choose the buffer a
smart choice instead of a constant. **Ship 5, never build 6.**

## 4.2 Ideas that optimise something that is not the bottleneck

**Idea 7 (samsloop) — demoted by my own measurement.** I nearly ranked it in the
top tier on the strength of the brief's "~14 % of a core at 60 s". Measuring it
produced **~2 % at the enforced 11.34 s cap [M]**, because
`SAMSLOOP_RECORD_BUDGET_BYTES` bounds the recording to 1.42–11.34 s **[V]**. The
449× speedup is real and the number is seductive; the *absolute* saving is small,
and it is on a code path the owner was not using when he reported the problem. **A
ratio is not an impact.**

**Idea 12 (CI cost gate) — solves a governance problem, not this problem.** It
prevents future regressions; it does nothing for the owner's current symptom. I
have ranked it last and flagged it as the item most likely to ship as a green,
blind decoration.

**Idea 11's input half — already done.** If I had proposed "coalesce the knob
writes" as new work I would have been re-proposing #1030 and #1031. Named in-place
so nobody spends a sprint on it.

## 4.3 Where my own reasoning is weakest

**The `processorerror` hypothesis (Idea 2) is a mechanism, not a diagnosis — and
it is the most seductive thing in this report.** It fits the owner's words
beautifully: "stops completely", permanent, no console output, survives until
reload. That fit is *exactly* what should make me suspicious. The
`agent-orchestration` skill records a coordinator asserting three different causes
before measuring and being wrong all three times; MDN confirming that the mechanism
*exists* **[W]** is not evidence that it *occurred*.

What saves the recommendation is that **it does not depend on being right.** The
handler costs ~20 lines, and its value if the hypothesis is *false* — definitively
ruling out an entire failure class that we currently cannot even ask about — is
nearly as high as if it is true. **I am recommending it as an experiment, not as a
fix.** If it were expensive I would be recommending measuring first.

**The bounded-vs-unbounded reasoning on samsloop could be wrong in one place.** I
verified the auto-stop at `SamsloopCard.svelte:338` fires on
`elapsedSec >= maxSecondsExact` **[V]** — but `elapsedSec` is derived from
`accL.length / sr`, i.e. **from the accumulator being appended to**. If messages
ever queued badly enough that the handler fell behind, the *check* falls behind
with the thing it bounds. I do not think this bites (the budget is small and the
handler is fast at those sizes) but I did not test it, and it is the same
self-referential-instrument shape this repo keeps getting caught by.

**Part 2 is the weakest section in the report and I want that on the record.** My
WebSearch budget was exhausted before I reached it, so the neighbour table is
largely **[K]**. The *decomposition* by axis and the *transferability* reasoning
are mine and I stand behind them. The specific claims about what BandLab,
Soundtrap, Audiotool, Figma and FMOD do internally are **unverified recollection**
and at least one of them is probably wrong. The two neighbour facts I *did* verify
this session (openDAW exists, is a serious browser DAW, and mentions **neither
collaboration nor underrun handling** **[W]**) both happen to support the owner's
conclusion that the category is empty — which is a weak signal, not a strong one,
because I could not check the products most likely to contradict it.

## 4.4 The idea I most expect to fail in practice

**Idea 4, the degradation policy.** Not because the mechanism is wrong — it is the
correct trade for a musical instrument and it is what every game engine does — but
because **a governor is only as good as its sensor, and its sensor is
Chromium-only, experimental, and untestable in CI [W + D]**. If `playbackStats` is
absent or noisy on the owner's actual machine, Idea 4 has nothing to trip on and
degrades to a manual toggle.

That dependency is the strongest argument in this document for the ordering I have
chosen: **ideas 1–3 are not merely first because they are cheap. They are first
because 4, 5, 8 and 10 are all unvalidatable without them.** Building an adaptive
governor before the sensor exists would mean tuning a control loop against a
quantity we cannot observe — which is how you end up shipping a servo that
oscillates and a correlation metric that says it doesn't.

---

# Part 5 — What I could not determine

Named explicitly, per the honesty requirement:

1. ~~Whether `AudioContext.playbackStats` is available.~~ **RESOLVED by shipping
   it (#1425)** — it is available and feature-detected, with a documented "—"
   fallback for Firefox/Safari. `renderCapacity` and `playoutStats`, the two
   names our older planning docs told implementers to use, are both **wrong**;
   that finding is now recorded at `playback-stats.ts:15-23` where it can be read
   by whoever needs it.
2. **Whether orphaned worklet processors actually accumulate render-thread cost**
   (Idea 8). The mechanism is sound and the greps hold **[V]**, but P0-3 is marked
   `[U]` by its own verifier **[D]** and I added no measurement. **This is the
   biggest open question in the report**, and Idea 1 makes it cheap to close.
3. **The preset-load DOM leak (7,700–9,800 nodes/load).** I could not reproduce it
   without a browser session and could not locate #1262's contradicting evidence in
   the tree. The brief asked me to reconcile the two and **I could not.** It
   remains unresolved in both directions — do not cite either number as settled.
4. **What the owner's actual failure was.** I did not diagnose it. I have proposed
   a mechanism for the "stops" clause (§1.4) that nobody had named, and a way to
   test it for ~20 lines. **That is a hypothesis with a cheap experiment attached,
   not a finding**, and the moment it is treated as a finding this report has done
   more harm than good.
5. **Audiotool's collaboration model and overload strategy** — the single most
   relevant competitor datapoint, and the one I most wanted. Its site returned a
   parse error and my search budget was gone. **Worth 10 minutes of someone's time
   with a working browser**; it is the closest thing to a peer this product has.

---

## Appendix — scratch artifacts

Measurement scripts written for §1.5 (scratchpad, not committed):

- `scratchpad/samsloop-append.mjs` — total grow-by-copy cost vs preallocated, at
  the real 375 msg/s tap rate
- `scratchpad/samsloop-tail.mjs` — per-callback cost late in a recording, against
  the 2.667 ms quantum and the 12 ms Tight buffer

Both are reusable as the before/after harness for Idea 7.

**Sources consulted on the web this session:**
- [MDN — AudioWorkletNode: processorerror event](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode/processorerror_event)
- [MDN — AudioPlaybackStats](https://developer.mozilla.org/en-US/docs/Web/API/AudioPlaybackStats)
- [MDN — AudioContext.playbackStats](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/playbackStats)
- [MDN — AudioContext](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext)
- [openDAW on GitHub](https://github.com/andremichelle/opendaw)
