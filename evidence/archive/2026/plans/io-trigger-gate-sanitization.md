# I/O Trigger ↔ Gate Sanitization — the hardware derivation

**Date:** 2026-06-13 · **Shipped as #758.**
**Motivating bug:** NUMPAD+ → TIMELORDE advances more than one step per single tick.

> **SHIPPED.** `$lib/audio/edge-detect` (`createEdgeCounter`), `$lib/audio/gate-trigger`
> (`GATE_HI` / `TRIGGER_PULSE_S`), `PortDef.edge: 'trigger' | 'gate'` and the
> `gatemaiden` module all exist. **The rule is verbatim in root CLAUDE.md
> ("Triggers vs gates: edge-detect through the shared seam"), which is the
> authority.** This file survives only as the *sourced derivation* behind that
> paragraph, plus the two items below that are still open.
>
> The old "`edge` is declared but not enforced" gap is **CLOSED**:
> `module-docs-lint.test.ts` now demands `edge` **unconditionally** on every
> gate-cable port — no ledger, no exemption list, deliberately no replacement
> counter.
>
> ⚠ Two of the three originally-named buggy consumers **no longer exist in the
> tree**: `hydrogen.ts` (deleted #1013) and `atlantis-catalyst.ts`. Only
> `numpad-plus.ts` survives, fixed.

---

## The root cause, stated precisely

The *consumer's* main-thread edge-detector re-scanned an `AnalyserNode` ring
buffer **larger than the scheduler tick interval**, with **no windowing** to the
samples that actually arrived since the last tick. The 2048-sample analyser
window (~42 ms @ 48 kHz) overlaps the 25 ms scheduler tick, so the same rising
edge appears in two consecutive scans and is counted twice → **two advances per
tick**.

This is identical to a bug already discovered and **fixed in `sequencer.ts`**
(see its comment "to avoid double-counting the overlap window"), but **the fix
was never backported** to NUMPAD+, HYDROGEN or ATLANTIS-CATALYST. That is the
whole shape of the incident: a correct fix that stayed local.

`setTargetAtTime(…, 0.001)` made it worse — NUMPAD+ wrote its gates with a
~0.7 ms exponential ramp through the 0.5 threshold, so the crossing sits in the
threshold band for ~40 samples, broadening the window in which the overlap can
re-detect.

---

## Real-hardware deep dive (with citations)

This is the sourced material CLAUDE.md compresses into one paragraph.

### Both are binary CV; the difference is *time*
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

### Receivers detect the *rising edge* and ignore the fall
A module looking for a clock/trigger "**just looks for the rising voltage and
ignores the fall**" — so a clock input accepts a square wave, a long gate, or a
narrow pulse interchangeably, as long as the rise crosses the threshold. This is
why cross-patching mostly works.
([Noise Engineering](https://noiseengineering.us/blogs/loquelic-literitas-the-blog/getting-started-gates-vs-triggers/),
[Intellijel Eurorack 101](https://intellijel.com/support/eurorack-101/))

Implication: a **trigger input is edge-detected** (fire once per rising edge,
regardless of how long the level stays high). A **gate input is level-sensitive**
(act while high) **and** edge-aware (rising = note-on, falling = note-off). The
two are not interchangeable on the *consumer* side even though the *cable* is
identical.

### Thresholds & Schmitt-trigger hysteresis
Hardware gate/trigger inputs are usually a **comparator with hysteresis (a
Schmitt trigger)**: two thresholds, an upper to switch HIGH and a lower to
switch LOW, so a noisy or slowly-rising edge doesn't chatter.
([All About Circuits — Hysteresis Comparator](https://www.allaboutcircuits.com/tools/hysteresis-comparator-calculator/),
[ModWiggler — Gate/Trigger input comparator hysteresis](https://www.modwiggler.com/forum/viewtopic.php?t=156844),
[Cadence — Schmitt Trigger Hysteresis](https://resources.pcb.cadence.com/blog/2021-schmitt-trigger-hysteresis-provides-noise-free-switching-and-output))

Implication: our edge detectors use a **single** 0.5 threshold (no hysteresis).
That's fine for the synthetic step gates we generate internally, but a single
threshold on a *slow ramp* near 0.5 is exactly what makes the overlap-rescan bug
double-fire — the ramp sits in the threshold band across two scans. A real
Schmitt trigger would still single-fire because the lower threshold blocks the
second detection until the signal genuinely drops. Hysteresis is available as
defense-in-depth; **windowing alone fixes the reported bug.**

### Cross-patching effects
- **Long gate → percussive/digital trigger input:** can mis-retrigger or "stick"
  on some digital modules (the receiver may treat the held level as a sustained
  series of events).
- **Short trigger → gate input (e.g. ADSR):** the envelope gets the attack but
  **no sustain** — it snaps to release immediately because the gate never stays
  high. ([ModWiggler](https://www.modwiggler.com/forum/viewtopic.php?t=93058),
  [VCV gates & triggers tutorial](https://soundand.design/gates-and-triggers-in-vcv-rack-d327d26efbb0))

### Hardware converters (the precedent GATEMAIDEN repackages)
- **Doepfer A-162 Dual Trigger Delay** — takes a rectangle/gate/trigger in, fires
  on the **rising edge**, and emits a new trigger with **adjustable delay and
  width (~2 ms…>10 s)**. Two independent channels.
  ([Doepfer A-162 manual PDF](https://doepfer.de/a100_man/A162_man.pdf),
  [Doepfer A-162 page](https://doepfer.de/a162.htm))
- **Make Noise Maths / Function** — EOR/EOC pulses enable **trigger→gate** and
  **gate→trigger** conversion, square→pulse conversion, VC clocking.
  ([Maths V2 supplement PDF](https://w2.mat.ucsb.edu/mat276n/resources/systems/CREATE_teachingSynth/manuals/8c_Maths2013-V1.11-printable.pdf),
  [Perfect Circuit — Maths](https://www.perfectcircuit.com/make-noise-music-maths.html))
- **Gate→trigger** generically: differentiate the rising edge into a fixed short
  pulse. **Trigger→gate** generically: a slew/hold or a one-shot held for a set
  width.

**Our in-repo precedent:** `packages/dsp/src/lib/trigger-convert-dsp.ts` (the
MOOG 961 INTERFACE) is already a hardware-accurate trigger/gate format
converter. Its header states the architectural truth:

> "In OUR graph all triggers are plain `gate` cables (0/1), so polarity is
> COSMETIC and we model only the TIMING behaviours."

---

## Why there is ONE cable type — the zero-migration argument

Because we **keep the unified `gate` cable type** and only *add* an optional
`edge` field to **module defs** (not to persisted edges), **no saved patch
changes shape.** A `gate` edge between any two ports remains valid; `canConnect`
is unchanged. There is zero edge-migration risk — the persisted graph never
encoded trigger-vs-gate, and still doesn't.

This is the decisive reason the semantic is layered on defs rather than
introduced as a `trigger` cable type, which **would break every saved
`gate`-typed clock patch** and require an edge migration.

---

## Still open

- **NUMPAD+ has no dedicated clock/trigger OUT.** Verified against
  `numpad-plus.ts`: its outputs are `l1..l4_pitch` / `l1..l4_gate` (all
  `edge: 'gate'`) plus `poly`. Nothing emits a short pulse per step. Because
  `applyOutputs` holds the step gate high across *consecutive on-steps* (no dip
  between them), using a step gate as a clock source **under-edges** — you get
  fewer edges than steps. A dedicated clock/trigger OUT (short pulse per step)
  would make NUMPAD+ usable as a clean clock source. Small add; never built.

**Resolved, recorded so it is not re-opened:** `moog912.ts`'s gate threshold of
`0.1` was flagged here as inconsistent with the `0.5` used everywhere else. It
is now `export const GATE_THRESHOLD = 0.1` with the rationale on the file
(`moog912.ts`, header note above the constant): it is an **envelope-follower
detection** threshold (≈ −20 dB of full-scale), deliberately a different number
from the 0/1 CV gate-detection threshold `GATE_HI = 0.5`. Not a defect.
