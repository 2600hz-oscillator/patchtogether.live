# Blind gates and instrument faults — the 2026-07-29 haul (robot-imagined)

Not asked for. Written because this session found **eight** separate cases of a
measurement or a gate that was confidently, plausibly **wrong**, and the pattern
is more valuable than any individual fix. CLAUDE.md already carries the rule
("VALIDATE THE INSTRUMENT — a wrong metric reads exactly like a finding"); this
is the evidence file behind it.

**The unifying shape: a check that verifies the wrong invariant is
indistinguishable, from its output alone, from a check that passes.**

> ## KEPT — re-verified 2026-08-04. This is the EVIDENCE, not a duplicate of the skill.
> `.claude/skills/blind-gates.md` carries the five *patterns*; **none of the eight
> cases in Part 1, the twelve-row instrument table in Part 2, or the shard-1
> click-cost table in Part 3 appear there or in CLAUDE.md.** Deleting this loses
> the measurements.
>
> ⚠ **And on one point this file is RIGHT where the skill is WRONG.** The skill
> (`blind-gates.md`, "The negative control is the antidote") still asserts that
> E4's `zoom: 0.8` "makes it exercise the real path". Case 4 below says that
> remedy **does not work** — and the live spec agrees with this file, not the
> skill: `e2e/tests/backdraft-pure-tv.spec.ts:278-297` spawns `zoom: 0.8`, then
> states in its own comment that there is *no structure to assert*, that "a flat
> clipped field is the genuine legacy result for this scene", and that "the real
> contrast is with E1 — the pair is the control, not this test alone", backed by
> an explicit anti-vacuity luma floor. **If the two disagree, this file and the
> spec are current; the skill's sentence is stale.**
>
> Cases still live in the tree: the peakstate fix is still the spec-local
> `BEHAVIORAL_OBSERVED_OUTPUT` override
> (`e2e/tests/per-module-per-port-behavioral.spec.ts:2492` — grep the symbol, the
> line drifts), deliberately not an `_drivers.ts` entry, exactly as described.
>
> **Re-verified again 2026-08-12**, all three anchors: the override is still
> spec-local; `backdraft-pure-tv.spec.ts:287` still spawns `zoom: 0.8`; and
> `blind-gates.md:210` **still carries the stale sentence**. Fixing the skill is
> an open item — see the TODO note at the foot of this file.

---

## Part 1 — Gates that passed for the wrong reason

All of these had been GREEN for weeks. Every one was found only because
something *else* (a timeout) made someone look.

### 1. PIXELATE passed on a black frame

`backdraft.spec.ts` — `pixelate` is a **point sample, not an average**: at 1.0,
`cells=1` and every uv maps to the single centre texel. The source used
(`tileN: 6`) is **black at its centre**, so the "collapsed" frame was pure black
— mean 0.0, nonZeroFrac 0.000. Both `varFlat < 5` and `varFlat < varFull/8` are
satisfied by black.

**The test would have passed with BACKDRAFT emitting nothing at all.**

Fix: `tileN 6→5` (lit centre) + a `nonZeroFrac` floor that makes the flatness
checks non-vacuous. Negative-controlled both ways.

### 2. FREEZE holds the output still

Asserted only `expect(b).toEqual(a)`. **Two black frames are perfectly equal.**
Could not distinguish "FREEZE held the picture" from "there was never a picture".

### 3. PURE TV E5 — "OFF is inert"

Every assertion is "these two frames are EQUAL". Same hole.

### 4. PURE TV E4 — the negative control had no control

Worse than vacuous. The suite's **designated negative control** ("legacy does NOT
nest") renders a **fully clipped white** frame — mean 1.000, blown 1.000, row
variance 0.00000. Its own comment claims `zoom: 0.8` was chosen so the legacy path
isn't "a pure additive clip, on which the peak-finder is undefined". **That remedy
does not work**, and sweeping FEEDBACK 0.85 → 0 doesn't change it either (the room
source is already a near-white field).

Left honest rather than papered over: E4 now floors that the frame is *lit* and
states plainly that the real contrast is E1. A strong E4 needs TV ON and OFF
captured in one test (~+40 s CI) — called out, not silently spent.

### 5. MIRROR X/Y (partial)

Three symmetry assertions on `meanAbsDiff < 12`. **Black scores 0.** Only the
kept-half strict `>` could ever have caught a dead render.

### 6. SPATIAL TRANSFORM compared unsettled vs settled

`waitForTimeout(1200)` bought **146 frames on a real GPU but 0 under
SwiftShader** — first-spawn shader compile ate the whole window on the main
thread. The identity capture never got past engine frame 4, so the test compared
*unsettled vs settled* and passed for the wrong reason.

### 7. peakstate's behavioral row is UNSOUND on main

`per-module-per-port-behavioral --grep peakstate` fails **1-in-3 on unmodified
main** — and it is **not a flake**. The sweep observes `mono_out`, which is
stroked at a fixed `#eee`, so `color_speed_cv` **provably cannot** perturb it
(Δμvar 3.59 vs 12.11 for a real hit). The green runs were green on incidental
animation phase.

Fixed with a spec-local `BEHAVIORAL_OBSERVED_OUTPUT` override naming `rgb_out`
(Δμvar now ≈80–88). Deliberately **not** an `_drivers.ts` entry — that file is in
the collab attest basis and this isn't, so the spec-local form avoids a second
re-attest.

> This one generalises: **ask what the sweep is OBSERVING, not just what it is
> driving.** A driver that can't reach the observed output is a vacuous row.

### 8. The WebGL hash "transparency" check was self-referential

A comment-only change to `e2e/webgl-heavy-globs.ts` was correctly wrapped in
`docs-hash-ignore` markers, and the agent verified the hash was identical **with
and without the block**. That proves the block is stripped. It does **not** prove
the file hashes the same as **main** — and it didn't, because one stray `//` line
sat *outside* the markers:

```
// docs-hash-ignore:end
//                      <-- not on main
// This list was inlined in playwright.config.ts …
```

`DOCS_IGNORE_RE` consumes `:start` through `:end` plus its newline; that trailing
`//` survives the strip. One line ⇒ attest invalidated for a comment.

Proof needs no GPU: apply the real regex to both files and **diff the results**.

> **"The block is stripped" and "the file hashes the same as main" are different
> claims, and only the second is what the gate asserts.**

---

## Part 2 — Instruments that lied during investigation

Caught *before* they became findings. Each would have produced a confident false
conclusion.

| instrument | what it did | why |
|---|---|---|
| **`longtask` API** | reported **0 ms/s** for a pipeline consuming **150 ms/s** | the work is ~120 *short* tasks/second; the API only fires above 50 ms. Switched to CDP `ThreadTime`/`ProcessTime`. |
| **`performance.memory`** | frozen at exactly **117.3 MB** across eight consecutive windows | quantized, not measuring. Switched to CDP `JSHeapUsedSize`. |
| **Headless Chromium on macOS** | silently used **SwiftShader on a real-GPU machine** | must force ANGLE/Metal *and print the renderer string every run*. |
| **`/rack`** | **refuses a workflow-mode patch** — first dose-response ran against an empty rack | assert node count after load, always. |
| **Card visibility** | offscreen cards make pull-eval skip whole chains | zoom out and assert `cardVisible` before any figure means anything. |
| **`engine.domains.video` lookup** | wrong path ⇒ `pullStats`/`videoFps` **absent, not zero** | a `{}` reads exactly like "video is free". |
| **Cold vs warm** | an "8.4 → 2.8 s" win was really **3.2 → 2.8** | cold run compared against warm. Bit the same agent **twice**. |
| **10-worker contention harness** | showed no improvement | it measured machine saturation from the *other* nine GL pages, not this spec's cost. |
| **`mean < p50`** | impossible for a unimodal sample | the 1500 ms pull-eval watch TTL expired *inside* a synchronous burst; the tail read ~0 ms. Size bursts under the TTL and report skipped-step counts. |
| **Pearson correlation** (earlier session) | a genuine period-2 limit cycle read `corr = 1.0` | invariant to global brightness + even sampled lags. |
| **`getBoundingClientRect()`** | reported a 310 px overflow as 230 px | xyflow's zoom transform — **viewport-scaled px, not CSS px**. Normalise by the zoom scale (0.981 on one probe run) before quoting any width. |

---

## Part 3 — The other big wrong diagnosis: "shard 1 is over budget"

I said this to the owner across several ticks. **It was wrong**, and the
disproof is a measurement I should have taken first: **median click-step duration
per spec file, same runner, same workers, same minute.**

| spec file | median click |
|---|---|
| **backdraft-full-output.spec.ts** | **7946 ms** |
| blood-keyboard.spec.ts | 471 ms |
| cable-drag-section-expand.spec.ts | 213 ms |
| aut-patch-panel.spec.ts | 141 ms |

A 17–56× outlier against healthy neighbours. **The shard was fine.** The *page*
rendered at ~1 fps, and **Playwright paces actionability on rAF** — "visible,
enabled and stable" is two consecutive frames, so each click cost ~8 s and five
pointer actions ate 41 s of a 60 s budget.

That also explains why the earlier timeout bump didn't help: **a per-round-trip
tax scales WITH the ceiling.** The case came back at 64.8 s instead of 34.8 s.

> When N tests in one area time out, compare that area's per-action cost against
> its neighbours on the same run **before** concluding anything about the shard.

---

## Cheap defences, in rough order of value

1. **Negative-control the instrument, not just the code** — perturb the thing it
   claims to measure and confirm the number moves. Every quantitative claim in
   the audio diagnosis had one (+79 ms/s under an injected 100 ms/s burn; p99 174
   ms under 150 ms/s; peakstate attribution confirmed by linear scaling across
   complexity 1/12/32).
2. **Force the dead-render control**: make every read return black and confirm
   the test FAILS. Four vacuous assertions fell out of one pass of this.
3. **Ask what the metric is invariant to** before believing it.
4. **State units in the assertion message** (CSS px vs screen px, frames vs ms).
5. **Reproduce under the environment that actually failed** — `E2E_SWIFTSHADER=1`.

---

## ⚠ OPEN: `.claude/skills/blind-gates.md:210` is still wrong about E4

The skill's "The negative control is the antidote" section still asserts that
E4's `zoom: 0.8` *"makes it exercise the real path"*. **Case 4 above measured
that it does not**, and the live spec agrees with this file rather than the
skill: `backdraft-pure-tv.spec.ts` states in its own comment that there is no
structure to assert, that a flat clipped field is the genuine legacy result for
that scene, and that the real contrast is with E1 — backed by an explicit
anti-vacuity luma floor. **Correct the skill sentence to match**, or a future
reader will "fix" the spec back to a control that has no control.

(A strong E4 needs TV ON and OFF captured in one test, ~+40 s CI. Called out
here rather than silently spent.)
