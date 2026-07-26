# I/O Trigger ↔ Gate Sanitization — Audit, Critique & Plan

**Status:** Plan only — no code written. Read-only investigation.
**Date:** 2026-06-13
**Motivating bug:** NUMPAD+ → TIMELORDE advances more than one step per single tick.
**Author:** investigation agent (Opus 4.8)

---

## 1. Summary

The user reports that one tick out of NUMPAD+ makes TIMELORDE (the master
transport singleton) advance **more than one step**, and diagnoses it as "a
trigger being treated as a held-open gate." The investigation confirms a real,
reproducible bug — but the precise mechanism is subtler than "level vs edge,"
and it is **not** in TIMELORDE.

**Root cause (confirmed):** the *consumer's* main-thread edge-detector
re-scans an `AnalyserNode` ring buffer that is **larger than the scheduler tick
interval**, with **no windowing** to the samples that actually arrived since the
last tick. The 2048-sample analyser window (~42 ms @ 48 kHz) overlaps the 25 ms
scheduler tick, so the same rising edge appears in two consecutive scans and is
counted twice → two advances per tick. This is identical to a bug already
discovered and **fixed in `sequencer.ts`** (see its comment "to avoid
double-counting the overlap window"), but the fix was **never backported** to
NUMPAD+, HYDROGEN, or ATLANTIS-CATALYST.

A second, deeper finding: **the codebase has no `trigger` cable type at all.**
Everything trigger-like (clock, reset, strike, strum, sync, start/stop, *and*
sustained gates) is a single `gate` cable (`packages/web/src/lib/graph/types.ts`
lines 41–52, 59–70). The distinction between "fire once on the rising edge"
(trigger) and "do something for as long as the level is high" (gate) lives only
in each consumer's runtime code — and is therefore re-derived (correctly or
not) per module. This is the structural reason the bug class keeps recurring.

This plan delivers: (D1) a real-hardware grounding, (D2) a file:line adversarial
critique, (D3) a module-by-module remediation table plus a single shared
primitive, (D4) the GATEMAIDEN spec, then migration, testing and docs plans.

**Scope of the change.** This is genuinely "a major change to how we consider
I/O," but most of it is *additive and conservative*: we do **not** rip out the
unified `gate` cable type (cross-patching gate↔trigger must remain legal — it's
just CV). We (a) hot-fix the three double-count consumers, (b) introduce one
shared edge-detection seam so no module rolls its own again, (c) add a
*declared semantic* (`edge: 'trigger' | 'gate'`) to input port defs so the model
is explicit and lintable, and (d) add GATEMAIDEN as a convenience converter.

---

## 2. Real-hardware deep dive (with citations)

### 2.1 Both are binary CV; the difference is *time*
In Eurorack a gate and a trigger are the **same kind of signal** — a binary
on/off control voltage. "Off" is ~0 V; "on" is typically **+5 V to +10 V**. The
only difference is duration. A **trigger** is a very short pulse (length doesn't
matter to the receiver, typically **~1–5 ms**); a **gate** is a variable-width
pulse held high for as long as the event is active (e.g. a key held down).
([Noise Engineering — Gates vs. Triggers](https://noiseengineering.us/blogs/loquelic-literitas-the-blog/getting-started-gates-vs-triggers/),
[Knobulism — Pulses, Gates & Triggers](https://www.knobulism.com/2024/06/04/pulses-gates-triggers-whats-the-diff/),
[ModWiggler — Gates v Triggers](https://modwiggler.com/forum/viewtopic.php?t=88095))

> "Triggers are simply put, very short gates. Their length doesn't matter, and
> they're usually around 2-5ms… a trigger can be thought of as a square wave
> where the pulse width is very short (~1 ms)."

### 2.2 Receivers detect the *rising edge* and ignore the fall
A module looking for a clock/trigger "**just looks for the rising voltage and
ignores the fall**" — so a clock input accepts a square wave, a long gate, or a
narrow pulse interchangeably, as long as the rise crosses the threshold. This is
why cross-patching mostly works.
([Noise Engineering](https://noiseengineering.us/blogs/loquelic-literitas-the-blog/getting-started-gates-vs-triggers/),
[Intellijel Eurorack 101](https://intellijel.com/support/eurorack-101/))

Implication for us: a **trigger input is edge-detected** (fire once per rising
edge, regardless of how long the level stays high). A **gate input is
level-sensitive** (act while high — sustain a note, hold a VCA open) **and**
edge-aware (rising = note-on, falling = note-off). The two are not
interchangeable on the *consumer* side even though the *cable* is identical.

### 2.3 Thresholds & Schmitt-trigger hysteresis
Hardware gate/trigger inputs are usually a **comparator with hysteresis (a
Schmitt trigger)**: two thresholds, an upper to switch HIGH and a lower to
switch LOW, so a noisy or slowly-rising edge doesn't chatter (multiple false
edges).
([All About Circuits — Hysteresis Comparator](https://www.allaboutcircuits.com/tools/hysteresis-comparator-calculator/),
[ModWiggler — Gate/Trigger input comparator hysteresis](https://www.modwiggler.com/forum/viewtopic.php?t=156844),
[Cadence — Schmitt Trigger Hysteresis](https://resources.pcb.cadence.com/blog/2021-schmitt-trigger-hysteresis-provides-noise-free-switching-and-output))

Implication for us: our edge detectors use a **single** 0.5 threshold (no
hysteresis). That's *fine* for the synthetic step gates we generate internally,
but a single threshold on a *slow ramp* near 0.5 is exactly what makes the
overlap-rescan bug double-fire (the ramp sits in the threshold band across two
scans). A real Schmitt trigger would still single-fire because the lower
threshold blocks the second detection until the signal genuinely drops. We
should adopt hysteresis as defense-in-depth (§6.4).

### 2.4 Cross-patching effects
- **Long gate → percussive/digital trigger input:** can mis-retrigger or "stick"
  on some digital modules (the receiver may treat the held level as a sustained
  series of events) — exactly the user's intuition.
- **Short trigger → gate input (e.g. ADSR):** the envelope gets the attack but
  **no sustain** — it snaps to release immediately because the gate never stays
  high. ([ModWiggler](https://www.modwiggler.com/forum/viewtopic.php?t=93058),
  [VCV gates & triggers tutorial](https://soundand.design/gates-and-triggers-in-vcv-rack-d327d26efbb0))

### 2.5 Hardware converters (precedent for GATEMAIDEN)
- **Doepfer A-162 Dual Trigger Delay** — takes a rectangle/gate/trigger in, fires
  on the **rising edge**, and emits a new trigger with **adjustable delay and
  width (~2 ms…>10 s)**. Two independent channels.
  ([Doepfer A-162 manual PDF](https://doepfer.de/a100_man/A162_man.pdf),
  [Doepfer A-162 page](https://doepfer.de/a162.htm))
- **Make Noise Maths / Function** — EOR/EOC pulses enable **trigger→gate** and
  **gate→trigger** conversion, square→pulse conversion, VC clocking. A rise
  whose duration you control is exactly a trigger-to-gate (slew/hold).
  ([Maths V2 supplement PDF](https://w2.mat.ucsb.edu/mat276n/resources/systems/CREATE_teachingSynth/manuals/8c_Maths2013-V1.11-printable.pdf),
  [Perfect Circuit — Maths](https://www.perfectcircuit.com/make-noise-music-maths.html))
- **Gate→trigger** generically: differentiate the rising edge into a fixed short
  pulse (A-162's onset path). **Trigger→gate** generically: a slew/hold or a
  one-shot held for a set width (a "gate delay"/"gate length" stage).

**Our existing precedent:** `packages/dsp/src/lib/trigger-convert-dsp.ts`
(the MOOG 961 INTERFACE) is already a hardware-accurate trigger/gate **format
converter** in this codebase. Its header explicitly states the architectural
truth we're working with (lines 6–8):

> "In OUR graph all triggers are plain `gate` cables (0/1), so polarity is
> COSMETIC and we model only the TIMING behaviours."

It already implements both directions: pass-through with input width (gate-style,
line 119–120) and **fixed-width one-shot on each rising edge** (trigger-style,
lines 122–133). GATEMAIDEN is a focused, user-facing repackaging of these.

---

## 3. Adversarial critique of our implementation (file:line evidence)

### 3.1 There is no `trigger` type — only `gate`
`packages/web/src/lib/graph/types.ts`:
- Cable types union (lines 41–52): `audio | pitch | gate | cv | modsignal |
  polyPitchGate | keys | image | mono-video | video`. **No `trigger`.**
- `CV_FAMILY = new Set(['cv','pitch','gate'])` (line 70) — gate is freely
  interchangeable with cv/pitch in `canConnect` (lines 96–134).
- `PortDef` (≈ lines 231–257): `{ id; type; paramTarget?; accepts?; cvScale? }`
  — there is **no field that says "this input fires on edges" vs "this input is
  level-held."** Every clock/reset/strike/strum and every sustained gate is
  `type: 'gate'` and indistinguishable at the type level.

Consequence: the trigger-vs-gate contract is **implicit and re-implemented per
consumer.** When a consumer gets it wrong (or rolls a subtly different scan),
nothing catches it. This is the structural root of the recurring bug class.

Examples of "trigger" ports typed as `gate` (semantic only in the name/label):
- `numpad-plus.ts` `clock` input → `type: 'gate'` (def lines ~282–283).
- `timelorde.ts` `clock`, `start_in`, `stop_in` → all `type: 'gate'`.
- `moog993.ts` `trig_from1/2`, `trig_out1/2/3` → `type: 'gate'`.
- `moog911a.ts` `trig1/trig2` → `type: 'gate'`.
- `stages.ts` `trig` output → `type: 'gate'`.
- `sample-hold.ts` `gate` (really a sample-trigger) → `type: 'gate'`.
- `rings.ts` `strum` (a strike trigger) → `type: 'gate'`.

### 3.2 THE BUG — main-thread overlap-rescan double-count
The pattern: a main-thread module polls a clock/gate input through an
`AnalyserNode` on the **25 ms** scheduler tick (`scheduler-clock.ts`, `TICK_MS =
25`, line 42), with an analyser `fftSize = 2048` (~42 ms @ 48 kHz). The
scheduler delivers a bare `tick()` with **no elapsed-time / new-sample count**
(`scheduler-clock.ts` `SchedulerTickFn = () => void`, line 45). If the consumer
re-scans the **whole** 2048-sample buffer each tick, ~17 ms of samples overlap
between consecutive scans, so the same rising edge is seen twice → two advances.

`setTargetAtTime(...,0.001)` makes it worse: NUMPAD+ writes its gates with a
~0.7 ms exponential ramp through the 0.5 threshold (`numpad-plus.ts` lines
463–469), so the crossing sits in the threshold band for ~40 samples, broadening
the window in which the overlap can re-detect.

#### CONFIRMED BUGGY (whole-buffer re-scan, no windowing)
**NUMPAD+** — `packages/web/src/lib/audio/modules/numpad-plus.ts`
- `clockInAnalyser.fftSize = 2048` (line 335).
- `pollClockEdges()` (lines 442–452):
  ```ts
  function pollClockEdges(): number {
    clockInAnalyser.getFloatTimeDomainData(clockInBuf);   // full 2048
    let edges = 0;
    for (let s = 0; s < clockInBuf.length; s++) {          // scans EVERYTHING
      const v = clockInBuf[s]!;
      const high = v >= CLOCK_THRESHOLD ? 1 : 0;
      if (high && !lastClockSample) edges++;
      lastClockSample = high;
    }
    return edges;
  }
  ```
- Driver (lines 541–545): `const edges = pollClockEdges(); for (let e=0;
  e<edges; e++) advanceStep();` — N edges → N advances.
- No `lastClockSampleTime`, no `elapsed`, no `newSamples` window. **This is the
  reported bug.** (Note: in the *user's* described patch NUMPAD+ is the source
  and TIMELORDE the consumer; but the same `pollClockEdges` flaw also fires when
  *NUMPAD+ itself is clocked*. Whichever module is the main-thread consumer of a
  near-threshold ramp will double-count. See §3.4 on the patch direction.)

**HYDROGEN** — `packages/web/src/lib/audio/modules/hydrogen.ts`
- Imports `createTransportCv` and uses the **windowed** `transportCv.drain(elapsed)`
  for play/reset/queue CV (lines 75, 584, 681–683) — SAFE there. But its
  clock/trig/reset edge detection rolls its **own** whole-buffer scan:
  - `pollExternalClockEdges()` (lines 667–677): `for (let s = 0; s <
    clockInBuffer.length; s++)` — BUGGY (clock double-advances).
  - per-instrument trig poll (lines 637–643): `for (let s = 0; s <
    trigAnalyserBuf.length; s++)` — BUGGY (a held/slow trig double-strikes a drum).
  - reset poll (lines 652–657): `for (let s = 0; s < resetInBuffer.length;
    s++)` — BUGGY (double reset).

**ATLANTIS-CATALYST** — `packages/web/src/lib/audio/modules/atlantis-catalyst.ts`
- Uses the shared detector but scans the **whole** buffer:
  `nudgeAna.fftSize = 2048` (line 277); `nudgeDet.scan(nudgeBuf, 0,
  nudgeBuf.length)` (line 456) — `start = 0` defeats the windowing. A single
  nudge can transition scenes more than once. BUGGY.

#### CONFIRMED SAFE (windowed to new-samples-since-last-tick)
All of these compute `newSamples = ceil(elapsed * sampleRate)` and scan only
`buf[length-newSamples .. length]`, via `transport-cv.ts`'s `drainOne()` (lines
112–121) or inline:
- `sequencer.ts` clock (lines ~595–616, with the comment "to avoid
  double-counting the overlap window").
- `drumseqz.ts`, `macseq.ts`, `polyseqz.ts`, `score.ts`, `writeseq.ts`,
  `grids.ts`, `cartesian.ts`, `moog960.ts` — clock/reset/transport, all windowed.
- `timelorde.ts` `start_in`/`stop_in` — windowed via `createRisingEdgeDetector` +
  `drain(elapsed)`; **TIMELORDE's `clock` input is processed in the
  sample-accurate worklet** (`packages/dsp/src/timelorde.ts` lines 257–289,
  per-sample `lastClockSample < TH && c >= TH` → `fireMaster()` once). **TIMELORDE
  is innocent** for both its clock and transport inputs.
- `midi-out-buddy.ts` `gate_in` — windowed.

#### EXEMPT (sample-accurate worklets)
Every AudioWorklet consumer reads one sample per iteration and is correct by
construction. The cross-audit found these all edge-detect correctly with a
per-sample `prev<TH && cur>=TH` (or `cur>=TH && prev<TH`) pattern:
- Envelopes: ADSR (Faust `en.adsr`, level-held + edge re-trigger — **correct as
  level-sensitive**, see §3.3), `moog911.ts` (line 178), `peaks.ts`,
  `stages-engine.ts`.
- Drums/voices: `chowkick-dsp.ts` (326), `treeohvox.ts` (202),
  `macrooscillator.ts` (1494).
- LFO sync: `lfo.ts` (175), `tides2-engine.ts` (549).
- S&H: `sample-hold-dsp.ts` (129/135). Logic: `flipper-dsp.ts` (31),
  `fourplexer.ts` (151), `slewswitch.ts` (174/183).
- MI: `rings.ts` (286 strum), `clouds.ts` (294 freeze), `elements.ts` (832).
- Poly chain: `helm.ts` (779/785), `dx7.ts` (495–502), `polyhelm.ts`,
  `cube.ts` (616–618). `twotracks.ts` (611/618/634), `cocoadelay-core.ts` (259).

### 3.3 The one legitimately level-sensitive consumer: ADSR (do NOT "fix")
`adsr.ts` (header lines 5–7, 16): "Rising gate opens the attack stage; the
envelope decays to the sustain level **while the gate is held**; the gate
falling triggers the release." This is the textbook **gate** semantic and is
**correct**. The remediation must NOT blanket-convert gate consumers to
edge-only. The model is: **trigger inputs → edge; gate inputs → level + both
edges.** ADSR's `gate` stays a true gate.

### 3.4 The patch-direction question (must confirm with user)
The user says "NUMPAD+ patched to TIMELORDE." NUMPAD+ has **no dedicated clock
OUT** — its outputs are `l1_gate..l4_gate` (held step gates) and `poly`. So the
likely real patch is **NUMPAD+.lN_gate → TIMELORDE.clock** (using a held step
gate as a clock). Two failure modes combine:
1. The held step gate is a **level**, not a pulse — patched into a clock input it
   produces one rising edge per step, which is *acceptable* (clock ignores the
   fall). But because consecutive "on" steps **never dip to 0** (`applyOutputs`
   holds the gate at 1 across adjacent on-steps, lines 457–470) the *intended*
   one-edge-per-step doesn't happen at all — you'd get **too few** edges, not too
   many. So a held gate alone can't explain "more than one step per tick."
2. The "more than one step" symptom matches the **overlap-rescan double-count**
   precisely. Given TIMELORDE's clock is sample-accurate (innocent), the
   double-count must be on the **NUMPAD+ side** — i.e. the failing patch is
   *something → NUMPAD+.clock* (NUMPAD+ is the consumer), or the user observed
   the symptom on a different consumer. **Open question Q1** resolves which
   module is the consumer in the reported patch; the fix (§4) covers all three
   buggy consumers regardless, so the bug is fixed either way.

> Net: the **edge-vs-level model** the user wants is the right north star, and
> the held-step-gate-as-clock is genuinely bad ergonomics (no dip between
> on-steps), but the *numeric* "more than one step per tick" is the
> overlap-rescan double-count. Both get fixed.

---

## 4. Module-by-module remediation table

Legend — *Edge* = fire once per rising edge (trigger). *Level* = act while high,
react to both edges (gate). *Status*: BUG = must fix now; OK = correct; DECLARE =
add explicit `edge` semantic only (no behavior change).

| Module (file) | Port | Current runtime | Required | Concrete change | Test (suite) |
|---|---|---|---|---|---|
| **numpad-plus.ts** | `clock` in | whole-buffer rescan, double-counts (442–452) | Edge, once/edge | Replace `pollClockEdges` body with shared `EdgeCounter` windowed scan (§5). Track `lastClockSampleTime`; scan only new tail. | unit: `numpad-plus.test.ts` "held-high clock advances exactly once" (new reusable assert §7.1); e2e real source→numpad |
| **hydrogen.ts** | `clock_in`, `reset_in`, 16×`trig_in` | whole-buffer rescan (637–643, 652–657, 667–677) | Edge ×N | Route all three through shared `EdgeCounter`/`drain(elapsed)`; reuse the `elapsed` it already computes for transport (681). | unit: hydrogen "single trig = single strike"; behavioral per-port |
| **atlantis-catalyst.ts** | `nudge` in | `scan(buf,0,len)` no window (456) | Edge | Pass windowed `(buf, start, len)` with `start = len - newSamples`. | unit: atlantis "one nudge = one scene change" |
| **moog912.ts** | `gate` in | threshold **0.1** (line 72) — inconsistent | Level (env follower gate) | Normalize to shared `GATE_HI`/`GATE_LO` hysteresis constants; document why if 0.1 is intentional. | unit: threshold constant test |
| sequencer / drumseqz / macseq / polyseqz / score / writeseq / grids / cartesian / moog960 | clock/reset/transport | windowed, OK | Edge | **DECLARE** `edge:'trigger'` on these inputs (no behavior change). | existing + lint (§7.4) |
| timelorde.ts | `clock` (worklet), `start_in`/`stop_in` (windowed) | OK | Edge | **DECLARE** `edge:'trigger'`. | existing |
| adsr.ts, moog911*.ts envelopes, peaks, stages | `gate` | level + edges, OK | **Level** (gate) | **DECLARE** `edge:'gate'`. Do NOT convert to edge-only. | existing ADSR sustain test |
| sample-hold.ts | `gate` (sample trig) | edge, OK | Edge | DECLARE `edge:'trigger'`; consider rename label "trig". | existing |
| rings.ts `strum`, clouds `freeze`, elements `gate`, chowkick `gate`, treeohvox `gate`, macrooscillator `trig`, lfo `clock`, tides2 `trig`/`clock`, flipper/fourplexer/slewswitch, dx7/helm/polyhelm/cube poly gates, twotracks, cocoadelay | various | sample-accurate edge, OK | Edge or Gate per role | DECLARE the correct `edge` per port. Poly gates = **gate** (note-on/off both edges). Strum/strike/sync = **trigger**. | per-module-per-port sweep already covers |
| moog993.ts, moog911a.ts, moog960.ts, moog961 (trigger-convert) | trig in/out | sample-accurate, OK | Edge | DECLARE; these are the trigger-domain modules. | existing |

**Output-side note (the user's waveform spec).** Today every "trigger/gate"
output is a held level or a fixed-width pulse via `ConstantSource`/worklet. The
user wants triggers rendered as a **short triangle** and gates as a **short
square + held-high**. This is primarily a *visual/UX* affordance (scope shape,
cable legend) — see §6.3. We will standardize **trigger outputs to emit a fixed
short pulse** (default 5 ms, §6.1) so a trigger out is unambiguously a strike,
and **gate outputs to hold high** for the event. The triangle-vs-square *shape*
is an optional cosmetic on the emitted pulse (a 5 ms triangle still rises through
0.5 once); the load-bearing change is "trigger out = short pulse, gate out =
held level," which most modules already do except NUMPAD+'s step gates.

---

## 5. Shared-primitive design (one source of truth)

Mirror the `$lib/audio/midi-timing` precedent (one util every bridge must use).
Create **`$lib/audio/edge-detect.ts`** as the single seam for main-thread
edge detection, and **`$lib/audio/gate-trigger.ts`** for the semantic model +
waveform constants. Worklets keep their per-sample detection but import the
shared **constants** (threshold/hysteresis/pulse width) so everything agrees.

### 5.1 `edge-detect.ts` — the main-thread counter
A small factory that **owns** the analyser-window math so no module re-derives
it (the exact thing that drifted in numpad/hydrogen/atlantis):

```ts
// Pseudocode — design, not final code.
export interface EdgeCounter {
  /** Call once per scheduler tick. Returns rising edges since last call,
   *  windowed to the samples that actually arrived (no overlap double-count). */
  poll(nowSec: number): number;
  reset(): void;
}
export function createEdgeCounter(opts: {
  ctx: BaseAudioContext;
  analyser: AnalyserNode;          // caller wires source → gain → analyser
  hiThreshold?: number;            // default GATE_HI = 0.5
  loThreshold?: number;            // default GATE_LO = 0.5 (set < hi for hysteresis)
}): EdgeCounter;
```

Internally it folds together the two correct existing pieces:
- the windowing from `transport-cv.ts` `drainOne` (lines 112–121): `newSamples =
  ceil(elapsed * sampleRate)`, scan `[len-newSamples, len)`;
- the rising-edge predicate from `transport-helpers.ts`
  `createRisingEdgeDetector` (lines 173–194), generalized to **hysteresis** (two
  thresholds).

`createRisingEdgeDetector` already exists and is correct; the *bug* is callers
not windowing the scan. Folding the window **into** the counter makes misuse
impossible (no `start=0` foot-gun like atlantis line 456). `transport-cv.ts`
itself should be refactored to delegate to `createEdgeCounter` so there is
exactly **one** implementation of the window math.

### 5.2 `gate-trigger.ts` — model, constants, waveforms
```ts
export const GATE_HI = 0.5;      // canonical high threshold (matches today)
export const GATE_LO = 0.45;     // hysteresis low threshold (defense-in-depth)
export const TRIGGER_PULSE_S = 0.005;  // 5 ms default short trigger/short gate

/** Declared semantic of an input port. Drives edge vs level interpretation. */
export type EdgeSemantic = 'trigger' | 'gate';

/** Emit a short trigger pulse onto a ConstantSource (triangle-shaped).
 *  Rises through GATE_HI once; falls back to 0 after TRIGGER_PULSE_S. */
export function fireTrigger(cs: ConstantSourceNode, atSec: number,
  widthSec = TRIGGER_PULSE_S, shape: 'triangle'|'square' = 'triangle'): void;

/** Hold a gate high (square, level-held) from atSec until released. */
export function openGate(cs: ConstantSourceNode, atSec: number): void;
export function closeGate(cs: ConstantSourceNode, atSec: number): void;
```

The **canonical waveforms** (user's spec):
- **Trigger** = short **triangle** pulse (linear ramp up to 1 over width/2, ramp
  back to 0). One clean crossing of `GATE_HI`. Default width `TRIGGER_PULSE_S`
  (5 ms — within the real-hardware 1–5 ms band, §2.1).
- **Gate** = **square**, held high for the event duration; rising edge = start,
  falling edge = end. A "short gate" (e.g. GATEMAIDEN's trigger→gate output) is a
  square of a configurable width.

### 5.3 PortDef: declare the semantic (additive, backward-compatible)
Add an **optional** field to the input port shape in `graph/types.ts`:

```ts
export interface PortDef {
  id: string;
  type: CableType;                 // unchanged — gate cable stays unified
  edge?: 'trigger' | 'gate';       // NEW: declared interpretation (inputs only)
  // …paramTarget, accepts, cvScale unchanged
}
```

- `type` stays the cross-patchable cable (gate↔cv↔pitch all still legal — §2.2,
  the user's rule 3). `edge` is the **consumer contract**: "I edge-detect" vs "I
  level-sample." It is documentation + lint fuel, not a connection restriction.
- A lint/unit gate (§7.4) asserts: **every `type:'gate'` *input* declares an
  `edge`**, and the module's runtime matches (a `trigger` input must route
  through `createEdgeCounter`/worklet edge-detect; a `gate` input must read the
  level). This is what makes "every input is exactly one of {trigger, gate}"
  (user rule 2) *enforceable* instead of aspirational.
- Outputs may optionally carry `edge` too, to drive the cosmetic
  triangle-vs-square scope shape and a cable-legend sub-label.

This is the cleanest seam: one cable type (no migration of saved edges — §6),
one shared detector (no per-module drift), one declarative field (lintable), one
constants module (thresholds/width agree across web + dsp).

---

## 6. Migration & backward-compatibility

### 6.1 Saved racks / edges are untouched
Because we **keep the unified `gate` cable type** and only *add* an optional
`edge` field to **module defs** (not to persisted edges), **no saved patch
changes shape.** A `gate` edge between any two ports remains valid; `canConnect`
is unchanged. There is zero edge-migration risk — the persisted graph never
encoded trigger-vs-gate, and still doesn't. This is the decisive reason to layer
the semantic on defs rather than introduce a `trigger` cable type (which *would*
break every saved `gate`-typed clock patch and require an edge migration).

### 6.2 Rollout order (smallest blast radius first)
1. **P0 hot-fix (no API change):** swap the three buggy consumers
   (numpad/hydrogen/atlantis) to the windowed scan. Ship behind nothing — it's a
   pure correctness fix. This is the user's reported bug.
2. **Shared seam:** land `edge-detect.ts` + `gate-trigger.ts`; refactor
   `transport-cv.ts` and the three fixed consumers to use them; refactor the
   other SAFE main-thread pollers to the shared counter (mechanical, no behavior
   change) so the foot-gun is gone repo-wide.
3. **Declarations:** add `edge:` to every gate input across module defs (one
   sweep). Turn on the lint (§7.4) as **informational**, then **required** once
   green (mirrors the behavioral/@collab gating discipline).
4. **Output waveforms:** standardize trigger outs to short pulses where a module
   currently holds a level for a strike (audit beyond numpad if any). Cosmetic
   triangle/square shaping last.
5. **GATEMAIDEN** (§7) ships once the seam exists.

Each step is independently shippable and green-gated.

### 6.3 Cosmetic / UX (cable legend, scope)
Cable color stays `--cable-gate` (red, `skins/default.ts` line 49) for the
unified gate cable; we do **not** add a new cable color (avoids a
skin-wide change and the cable-type test churn). The trigger-vs-gate
*affordance* is surfaced as: (a) a small sub-glyph on the port (▷ triangle for
trigger, ▭ square for gate) derived from the def's `edge`, and (b) the canonical
emitted waveform so a scope visibly shows a spike (trigger) vs a plateau (gate).

### 6.4 Hysteresis adoption
Default `GATE_LO = GATE_HI` keeps exact current behavior; modules opt into
hysteresis (e.g. `GATE_LO = 0.45`) where a slow/noisy ramp is expected. This is
defense-in-depth on top of windowing (windowing alone fixes the reported bug).

---

## 7. GATEMAIDEN module spec

**One input, two outputs** convenience converter — the user-facing repackaging of
`trigger-convert-dsp.ts`'s two primitives and the Doepfer A-162 / Maths idiom.

### 7.1 I/O & behavior
- **Input** `in` — a **generic CV-family input** (`type: 'gate'`, `accepts:
  ['cv','pitch']`). Per the new model, GATEMAIDEN does **not** declare itself as
  *only* trigger or *only* gate; it **derives both** from the level, so its input
  carries no single `edge` contract — it is the one principled exception (a
  *converter*), and we mark it `edge: 'gate'` *for level-reading* purposes while
  internally also edge-detecting. (Recommended design — see Q3 for the alt.)
- **Output** `gate` (`type:'gate'`, `edge:'gate'`) — **square, level-held**.
- **Output** `trig` (`type:'gate'`, `edge:'trigger'`) — **short triangle pulse**.

Behavior (no mode switch needed — it produces both regardless, like Maths EOR/EOC):
- **`gate` out** = **pass-through of the input level** (held high while input is
  high). If the input is a short trigger, the gate out is the short pulse *or* a
  minimum-width gate of `gateLen` (see param) — i.e. trigger→gate widening.
- **`trig` out** = fires **one short pulse on every rising edge** of the input
  (gate→trigger). If the input is already a trigger, this is effectively a
  re-shaped pass-through (one pulse per input pulse).

This satisfies the user's two cases exactly:
- Trigger in → `trig` out is a passthrough (one pulse per input pulse); `gate` out
  is a short gate starting at the strike (trigger→gate via `gateLen`).
- Gate in → `gate` out is the passthrough (held); `trig` out fires once per gate
  **start** (rising edge → one trigger).

No auto-detection of "is this a trigger or a gate" is needed — it's the cleanest
design precisely *because* it derives both from the level + edges, which works
for any input. (Auto-classification by pulse width would be racy and is
unnecessary.)

### 7.2 DSP
Sample-accurate **worklet** (so it's exempt from the overlap-rescan class and
single-fires by construction). Reuse the exact patterns in
`trigger-convert-dsp.ts`:
- rising-edge detect on `in` (`cur>=GATE_HI && !wasHigh`) → arm a
  `trigPulseRemaining = round(TRIGGER_PULSE_S * sr)` countdown (triangle shape);
- `gate` out = `in >= GATE_HI ? 1 : (gateRemaining>0 ? 1 : 0)` where a rising
  edge arms `gateRemaining = round(gateLen * sr)` to guarantee a minimum gate
  width even from a short trigger.
- one shared `GATE_HI/GATE_LO` import; no `setTargetAtTime` ramp on outputs
  (emit clean shapes).

### 7.3 Params & card UI
- Param `gateLen` (label "Len", log 0.005..2 s, default 0.05 s) — minimum width
  of the derived gate (trigger→gate length).
- Param `trigShape` (discrete 0=triangle,1=square, default triangle) — cosmetic
  emitted-trigger shape per the user's spec.
- Card: tiny scope showing input vs the two derived outputs; the two output ports
  carry the ▷/▭ sub-glyphs from §6.3. Label **lowercase** `gatemaiden`
  (lowercase-label guard). Panel style consistent with other Utility modules.

### 7.4 Placement
`palette: { top: 'Audio modules', sub: 'Utility' }`, `category: 'modulation'`
(same as FLIPPER/SLEWSWITCH/ADSR). Add the `DESCRIPTIONS` entry in
`packages/web/src/lib/docs/module-manifest.ts` (required by the unit gate),
the `EXPECTED_NODE_TYPES` row in `modules-card-map.test.ts`, and a VRT
exemption only if the card is renderer-dependent (it isn't).

### 7.5 Tests
- **unit core** (`packages/dsp` or web pure-core test): drive the worklet
  core with (a) a held gate of N samples → assert `trig` fires **exactly once**
  on the rising edge and `gate` mirrors the held level; (b) a 1-sample trigger →
  assert `gate` out holds for `gateLen` samples and `trig` passes through; (c)
  the **reusable "held-high advances/fires exactly once"** assertion (§8.1).
- **e2e real source→GATEMAIDEN→consumer:** MIDI LANE / POLYSEQZ (or NUMPAD+)
  gate → GATEMAIDEN.in → `trig` → a drum (CHOWKICK) and `gate` → an ADSR → VCA →
  assert (1) exactly one drum strike per source note, (2) audible sustained RMS
  while the gate is held. This is the real-source-chain bar from CLAUDE.md.

---

## 8. Testing plan (catches the whole bug class)

### 8.1 Reusable regression assertion — "trigger held high fires exactly once"
Add to the shared test utils a helper used by **every** trigger-consuming module:
```
assertSingleAdvancePerEdge(driveConsumer, { holdMs }):
  feed a rising edge that STAYS HIGH for holdMs (>> one scheduler tick and
  >> the analyser window), tick the consumer across several scheduler ticks,
  assert the consumer advanced / fired EXACTLY ONCE.
```
This directly encodes the regression: a held level must never cause repeated
action on a *trigger* input. Wire it into numpad/hydrogen/atlantis unit tests
and the per-module-per-port sweep for every `edge:'trigger'` input.

### 8.2 Per-suite coverage (follow CLAUDE.md)
- **unit (vitest):** the three fixed consumers; the shared `createEdgeCounter`
  (window math: overlapping buffers, near-threshold ramp, hysteresis); the
  GATEMAIDEN core. Run with `task test:one -- <file>`; **flake-check 3×**
  (`REPEAT=3`).
- **behavioral / per-module-per-port:** auto-enrolls GATEMAIDEN; assert the
  single-fire invariant per trigger port.
- **e2e:** GATEMAIDEN real-source chain (§7.5); a numpad→consumer chain proving
  one tick = one advance (the reported bug, end-to-end).
- **typecheck:** `task typecheck` after adding the `edge` field + new utils
  (svelte-check stricter than vitest).
- **VRT:** GATEMAIDEN card baseline (darwin + linux); the ▷/▭ port glyphs.
- **lint gate (§5.3):** every `type:'gate'` input declares `edge`; trigger inputs
  route through the shared counter/worklet detector. Land informational →
  required once green.

### 8.3 Don't repeat known traps
- New tests run locally first, scoped, 3× (CLAUDE.md). GATEMAIDEN's e2e drives
  the **real** source chain (not the engine class directly) — the POLYHELM
  green-but-silent lesson. No per-frame writes to the live Y.Doc from any
  modulation path (the TOYBOX write-storm lesson) — GATEMAIDEN is pure DSP, no
  store writes.

---

## 9. Docs plan

- **Per-module docs:** every module's doc must state, for each input, whether it
  is a **trigger** (edge, fire-once) or a **gate** (level, held). Drive this from
  the new `edge` field so docs can't drift from code. Update `module-manifest.ts`
  `DESCRIPTIONS` for GATEMAIDEN and add the long-form doc (model/controls/IO/CV/
  usage) per the "modules need robust docs" standard.
- **Concept doc:** a short "Triggers vs Gates in patchtogether" page mirroring §2
  (edge vs level, the unified gate cable, cross-patching, GATEMAIDEN as the
  converter), citing the same hardware references.
- **Cable legend:** note the ▷ trigger / ▭ gate port glyphs.
- **CLAUDE.md / memory:** add a standard — "trigger inputs MUST use the shared
  `createEdgeCounter` (main-thread) or per-sample worklet edge-detect; never
  re-scan a whole analyser buffer; gate inputs are level-sensitive (don't convert
  to edge-only)." Fold into in-flight work, no ceremony PR.

---

## 10. Open questions for the user

- **Q1 — patch direction.** In your failing patch, which module is the *consumer*
  (the one that double-advanced)? "NUMPAD+ → TIMELORDE" but NUMPAD+ has no clock
  OUT — were you patching a NUMPAD+ **step gate** (`l1_gate`) into
  TIMELORDE.`clock`, or clocking NUMPAD+ from something else? (The fix covers all
  three buggy consumers regardless; this just confirms the exact repro.)
- **Q2 — held step-gate as clock.** NUMPAD+ holds its step gate high across
  consecutive on-steps (no dip), so as a *clock source* it under-edges. Do you
  want NUMPAD+ to also emit a dedicated **clock/trigger OUT** (short pulse per
  step), so it can clock things cleanly? (Recommended; small add.)
- **Q3 — GATEMAIDEN input contract.** Recommended: a single generic CV input that
  derives both outputs (no mode). Acceptable alt: two declared input modes (a
  `trigger`-typed and a `gate`-typed input) — but that contradicts "one input."
  Confirm the single-generic-input design.
- **Q4 — trigger pulse width & shape.** Default **5 ms triangle** for triggers,
  default **50 ms** minimum derived gate. OK, or different defaults?
- **Q5 — hysteresis.** Adopt a second (lower) threshold globally (e.g.
  `GATE_LO=0.45`) as defense-in-depth, or keep single-threshold 0.5 and rely on
  windowing alone? (Windowing fixes the reported bug; hysteresis is extra.)
- **Q6 — new cable color vs glyphs.** Keep the single red `gate` cable and
  distinguish trigger/gate with port **glyphs** (recommended, no skin churn), or
  introduce a distinct trigger cable color (bigger UX/skin change, more VRT)?
- **Q7 — `edge` lint as a required gate.** OK to make "every gate input declares
  `edge` + matches its runtime" a **required** CI check after it's green
  informational (per the behavioral/@collab gating discipline)?

---

### Appendix A — Key files
- Bug: `packages/web/src/lib/audio/modules/numpad-plus.ts` (442–452, 463–469,
  541–545); `hydrogen.ts` (637–643, 652–657, 667–677); `atlantis-catalyst.ts`
  (277, 456).
- Correct reference: `transport-cv.ts` (112–121); `sequencer.ts` (595–616);
  `transport-helpers.ts` `createRisingEdgeDetector` (173–194);
  `scheduler-clock.ts` (42, 45).
- Innocent: `packages/dsp/src/timelorde.ts` (257–289).
- Type system: `packages/web/src/lib/graph/types.ts` (41–52, 59–70, 96–134,
  PortDef ~231–257).
- Converter precedent: `packages/dsp/src/lib/trigger-convert-dsp.ts`.
- Level-sensitive (keep as gate): `packages/web/src/lib/audio/modules/adsr.ts`
  (5–7, 16, 48–72).
- Threshold inconsistency: `moog912.ts` (72, =0.1) vs everywhere else (=0.5).
- UI: `skins/default.ts` (47–55); docs `module-manifest.ts` (77+).
