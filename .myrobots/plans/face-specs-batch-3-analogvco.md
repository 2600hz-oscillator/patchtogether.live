# FACE SPEC — `analogVco` (batch 3)

**Status:** SPEC + MOCKUP ONLY. Nothing here is implemented. Designed against the
**PF-20 faceplate platform** on `feat/faceplate-platform-v2` (PR #1301, NOT yet merged) —
`face.title` / `face.hint`, per-band `hint`, `ModuleFaceHero`, `FaceSidebarBlock[]`,
`FaceReadout.valueId`. Every claim about current behaviour carries a file:line. Anything
INFERRED rather than read is labelled.

**Verdict: PROMOTE.** · archetype: **SOURCE — one phase accumulator, six taps.**
Not in `STRICT_FACES` today (`packages/web/src/lib/ui/workflow/strict-faces.ts:42-65`), no
`face:` block on the def. 6 params, 9 inputs, 6 outputs, contract-lock block = **22 lines**
(`packages/web/src/lib/docs/contract-lock.txt:61-82` — 1 meta + 9 in + 6 out + 6 param).

---

## 1. WHAT IT ACTUALLY DOES

**One phase accumulator. Six outputs. The knobs do not all address the same output — and
that is the entire design problem the current card hides.**

Signal path, in DSP order (`packages/dsp/src/analog-vco.dsp`):

1. **Smoothing.** All six sliders pass `si.smoo` (`analog-vco.dsp:8,9,13,14,15,20`) —
   `si.smooth(1 - 44.1/ma.SR)`, τ ≈ **22.67 ms at 48 kHz**, sample-rate invariant. So a
   stepped CV on `shape` is a 23 ms portamento across the morph, not a jump.
2. **Frequency.** `freqHz(pitch, fm) = 261.626 * pow(2, pitch + tune/12 + fine/1200 +
   fmAmount*fm) : max(1) : min(20000)` (`analog-vco.dsp:24-27`). Four facts fall out of
   that one line: `pitch` is in **octaves**; FM is **exponential** and also in octaves, so
   `fmAmount = 1` against a ±1 modulator is **±12 semitones**; the [1 Hz, 20 kHz] clamp is
   unreachable from the panel (tune ±36 + fine ±100 ¢ spans **30.868 – 2217.465 Hz**); and
   the sounding pitch is a sum of four terms, only two of which are knobs.
3. **Hard-sync edge detect.** `syncEdge(s) = (s > 0) & (s' <= 0)` (`analog-vco.dsp:38`) —
   per-sample inside the worklet, correct by construction (the `createEdgeCounter` rule in
   CLAUDE.md governs main-thread `AnalyserNode` rescans, not worklet detectors).
4. **Phase accumulator with reset.** `loop(prev) = (1 - reset) * ma.frac(prev + f/ma.SR)`
   (`analog-vco.dsp:50-53`). At `reset = 0` this is bit-identical to a plain phasor
   (unit-proven, `packages/dsp/src/analog-vco-sync.test.ts:88-112`).
5. **PM injection.** `p = ma.frac(pRaw + pmAmount * pm)` (`analog-vco.dsp:103`) — a phase
   offset **in cycles**, so `pmAmount = 1` is ±360°. `sync_out` is driven from `pRaw`
   (pre-PM) deliberately (`analog-vco.dsp:88-92`).
6. **Four fixed taps off the SAME `p`** (`analog-vco.dsp:56-59, 98`): `saw = 2p-1`,
   `sqr = select2(p<pw, 1, -1)`, `tri = 4|p-0.5|-1` (note: this triangle *starts* at +1 and
   troughs at p = 0.5 — polarity-inverted from the textbook shape), `sn = sin(2πp)`.
7. **The morph tap (5th output).** Two-segment crossfade over the same `p`
   (`analog-vco.dsp:78-84`): below 0.5, `sn·2·shape + saw·(1-2·shape)`; at or above,
   `sqr·(2·shape-1) + sn·(2-2·shape)`. Endpoints exact: 0 = saw, 0.5 = sine, 1 = the
   **live-`pw`** square (`analog-vco.dsp:68-77`).
8. **`sync_out`.** `(pRaw < pRaw') * 1.0` (`analog-vco.dsp:93`) — one +1 sample per wrap,
   a trigger train at the sounding fundamental.

**There is no band-limiting anywhere in the 105-line file** — no PolyBLEP, no oversampling,
no antialiasing filter, no DC blocker, no drift, no noise, no saturation. At C4/48 kHz the
naive saw aliases from harmonic 91 up; at `tune = +36` (2093 Hz) from harmonic **11**.

### The fact the current card cannot express

`shape` touches **only** the `morph` output (`analog-vco.dsp:98` selects the four fixed taps
independently). `pw` touches the `square` tap always, and the morph **only in proportion to
`2·shape − 1`** (`analog-vco.dsp:80,83`) — and `shape` ships at **0**, so at spawn PW's
contribution to the morph tap is **exactly zero**
(`packages/dsp/src/analog-vco-morph.test.ts:204-210` asserts rms < 1e-9 for shape ∈
{0, 0.1, 0.25, 0.4}). Today all six controls sit in one undifferentiated `Fader` row
(`packages/web/src/lib/ui/modules/AnalogVcoCard.svelte:108-113`) with nothing saying which
of the six jacks each one addresses.

---

## 2. THE CONTROLS THAT MATTER — and there is no loser

analogVco has **exactly six** params. The lane budget is six
(`LANE_PLATE_MAX_CELLS = PLATE_COLS * PLATE_MAX_ROWS`,
`packages/web/src/lib/ui/workflow/curated-face.ts:46,65`), so **nothing is cut and nothing
is demoted to dock-only.** That is a finding, not a shortfall: the honest ranking question
here is *which two reach the compact tile* (`faceTierCap('compact', hasGlyph) =
LANE_ROW_MAX_CELLS_WITH_GLYPH = 2`, `curated-face.ts:76-79`), and *which one is the mini*.

| rank | control | why it is here |
|---|---|---|
| 1 | `tune` | the only control that decides what note the module makes, on every one of the six taps (`analog-vco.dsp:25`). Nothing about a VCO is knowable before its pitch. |
| 2 | `shape` | the tap-selector in disguise. It is the only control whose *identity* changes with the patch — a no-op on four outputs and the whole timbre of the fifth (`analog-vco.dsp:98`). Rank 2 so the compact tile carries pitch + character. |
| 3 | `fmAmount` | the deep-modulation lever, in octaves (`analog-vco.dsp:25`). Inert at spawn (default 0, and the `fm` node input is pinned to a 0-offset `ConstantSource`, `analog-vco.ts:157-163`) — it ranks on *reach*, not on liveness. |
| 4 | `pw` | live and audible on the `square` tap from spawn; **0 % authority on the morph tap** at the shipped default (see §4-C). |
| 5 | `fine` | ±1 semitone. Alone it is a sub-1 % trim; against a second oscillator it is the beat rate, which is why it earns a rank at all — and why its readout should be a beat frequency, not a cents number alone. |
| 6 | `pmAmount` | phase offset in cycles, all five taps identically (`analog-vco.dsp:103`). Last because it is doubly inert (default 0 **and** an unpatched input) and because PM is the rarer of the two modulation idioms. |

**Losers: none, and I will not invent any.** What *does* lose is a ranking argument I
rejected: putting `pw` at 2 because it is audible at spawn while `shape` is not. Rejected
because "audible at spawn" is the wrong test on a module whose default state is a bare saw —
`shape` is what makes the module *different from a saw*, and the mini tile showing one knob
should show the pitch, not the duty cycle of an output most patches never use.

---

## 3. THE FACE

```ts
face: {
  title: 'Oscillator',
  hint:
    'One phase accumulator, six taps. SAW / SQUARE / TRIANGLE / SINE are always themselves — ' +
    'SHAPE and PW steer the MORPH tap only. Both modulation inputs are exponential: FM in ' +
    'octaves, PM in cycles.',

  order: [
    // ranks 1-6 ARE the lane budget; nothing here is dock-only.
    'tune', 'shape', 'fmAmount', 'pw', 'fine', 'pmAmount',
    // the hero picture. A panel's first legal rank is 7 (module-face-lint refuses a
    // `panel` cell SELECTED at a lane tier), and 7 is also its place in the story:
    // you set the note, then you look at what came out.
    'analogvco-cycle-{n}',
  ],
  pages: [
    { id: 'pitch',  label: '1 · pitch',      hint: 'one exponent: TUNE in semitones, FINE in cents, V/OCT in octaves — all four terms summed before the pow2',
      controls: ['analogvco-cycle-{n}', 'tune', 'fine'] },
    { id: 'morph',  label: '2 · morph tap',  hint: 'SHAPE crossfades saw → sine → square on the MORPH output only; PW sets the square end of it',
      controls: ['shape', 'pw'] },
    { id: 'mod',    label: '3 · modulation', hint: 'exponential FM in octaves, PM in cycles — both bipolar, and a negative value inverts the modulator rather than reversing the direction',
      controls: ['fmAmount', 'pmAmount'] },
  ],
  glyph: 'scope',   // UNCHANGED in spirit — but see §5: the hero picture SUPPRESSES it at the dock.

  hero: {
    cell:    'analogvco-cycle-{n}',
    control: 'tune',
    readouts: [
      { label: 'knob pitch',    valueId: 'analogvco-knob-hz' },
      { label: 'FM span',       valueId: 'analogvco-fm-span' },
      { label: 'PW authority',  valueId: 'analogvco-pw-authority' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'PITCH SUM',   role: 'generator', note: 'v/oct + tune + fine + fm' },
      { label: 'PHASE ACC',   role: 'generator', note: 'reset on SYNC' },
      { label: 'PM OFFSET',   role: 'bus', parallel: true, note: 'read only' },
      { label: 'SAW',         role: 'bus', note: 'tap' },
      { label: 'SQUARE · PW', role: 'bus', note: 'tap' },
      { label: 'TRIANGLE',    role: 'bus', note: 'tap' },
      { label: 'SINE',        role: 'bus', note: 'tap' },
      { label: 'MORPH',       role: 'bus', note: 'shape xfade' },
      { label: 'SYNC OUT',    role: 'bus', note: 'pre-PM wrap' },
    ] },
    { kind: 'readouts', label: 'aliasing', entries: [
      { label: 'first aliased harmonic', valueId: 'analogvco-alias-harmonic' },
      { label: 'sync out rate',          valueId: 'analogvco-knob-hz' },
    ] },
  ],
}
```

**Why `PM OFFSET` is `parallel: true`.** It is not a stage the signal passes through; it is
added to the phase at the **read** (`analog-vco.dsp:103`) while the accumulator itself
advances on `pRaw`, which is what `sync_out` uses (`analog-vco.dsp:88-93`). Drawn inline
between PHASE ACC and the taps it would teach that PM shifts the sync pulse. It does not.
That is exactly the correctness argument `FaceFlowStage.parallel` was added for
(`packages/web/src/lib/graph/types.ts`, the `parallel` doc comment on the platform branch).

**Why three bands and not two.** Not a fold budget — the dock pane scrolls. The three bands
are three *different questions*: what note, which shape on which output, and how hard an
external signal throws either. Merging 2 and 3 would produce a four-knob band whose members
address two different outputs.

---

## 4. DERIVED READOUTS

⚠ **Platform constraint, stated up front because it changes what is possible.**
`FaceReadoutValue` is typed `(read: (paramId: string) => number | undefined) => string`
(`packages/web/src/lib/ui/workflow/face-readout-values.ts`, on the platform branch). It is a
pure function of **live params only** — it cannot read the engine, the analyser, or a
patched input. So the most valuable readout on this module (the *measured* sounding pitch,
which the card already computes and throws away) is **NOT EXPRESSIBLE ON THE PLATFORM AS
SPECIFIED**. See §7-D for the extension that would unlock it. Everything below is
param-pure and shippable today.

### A. `analogvco-fm-span` — the FM depth in the DSP's own units

```
f0    = 261.626 · 2^(tune/12 + fine/1200)              # analog-vco.dsp:25
cents = 1200 · |fmAmount|                              # fmAmount is OCTAVES, :25
Δup   = f0 · (2^|fmAmount| − 1)
Δdn   = f0 · (1 − 2^−|fmAmount|)
print   "±1200 ¢ · +108 / −77 Hz"   (at fmAmount 0.5, C4)
```

**Negative control — the perturbation a knob readback is blind to:** move **TUNE** (or
FINE). The `fmAmount` dial does not move one pixel, and the Hz deviation scales
proportionally — +108/−77 Hz at C4 becomes +217/−153 Hz an octave up. A readout wired to
`paramId: 'fmAmount'` is invariant to the very thing that decides how much pitch you get.
**Second, sharper control:** flip the SIGN of `fmAmount` from +0.5 to −0.5. A knob readback
swings across zero and back; the derived span **must not move at all**, because
`analog-vco.dsp:10-12` documents the sign as a 180° inversion of the *modulator*, not a
direction. A derivation that moves here is wrong in the opposite direction, and asserting
both legs is what makes the test an instrument rather than a tautology.

### B. `analogvco-pw-authority` — how much of the MORPH tap PW actually owns

```
authority = max(0, 2·shape − 1) × 100 %                # analog-vco.dsp:80,83
morph_DC  = authority/100 · (2·pw − 1)                 # no DC blocker exists anywhere
```

**At the shipped defaults this reads `0 %`** — which is the single most useful sentence this
face can say, and the reason "PW doesn't work" is a reasonable thing for a user to conclude
today. **Negative control:** sweep **SHAPE** 0 → 1 with PW untouched. The PW dial is frozen;
the authority readout walks 0 % → 100 % and the DC figure walks 0 → ±0.9. A `paramId: 'pw'`
readout is invariant to shape and would print `0.50` in both states.
Cross-validated against `packages/dsp/src/analog-vco-morph.test.ts:185-210`.

### C. `analogvco-knob-hz` — the knob-implied fundamental

```
f0 = 261.626 · 2^(tune/12 + fine/1200)                 # analog-vco.dsp:25
```

**Weaker, and I am labelling it honestly.** It is a two-param function, so it is not a
relabelled knob — **negative control:** move FINE alone; a TUNE readback does not move, this
does (261.63 → 263.14 Hz at +10 ¢). But it is **blind to the `pitch` jack, to FM, and to CV
on the `tune`/`fine` jacks**, which is exactly the blindness the existing helper
`currentFreqHz()` already has (`analog-vco.ts:192-197` reads `params.get(…).value`, the
*intrinsic* AudioParam) — and whose own comment at `analog-vco.ts:188-191` discloses only
the `pitch` case, not the CV case. **So the label must say `knob pitch`, not `pitch`.** A
readout that says `pitch` while a sequencer is driving the module two octaves away is a
lie the platform would happily paint.

### D. `analogvco-alias-harmonic` — the honest consequence of a naive oscillator

```
n = floor(sampleRate / (2 · f0))                       # no band-limiting: analog-vco.dsp:56-59
```
91 at C4/48 kHz, **11** at `tune = +36`. **Negative control:** TUNE up an octave halves it
while every knob readout that is not TUNE stays put; and it is **sample-rate dependent**, so
switching the interface to 96 kHz doubles it with no param moving at all. (Sample rate is
not in the param reader — see §7-D; today this must be computed against 48 kHz and *say so*,
or be deferred with A/B/C.)

---

## 5. BESPOKE CELL vs PLATFORM

**One bespoke cell is legitimate: `analogvco-cycle-{n}` — the single-cycle waveform panel.**

The card already draws it (`AnalogVcoCard.svelte:98-103`, a 200×168 `<canvas>` testid
`analog-vco-scope`) and the drawing code is already pure and unit-testable
(`packages/web/src/lib/audio/analog-vco-scope.ts:38-86` `findCycleWindow`, `:98-138`
`drawVcoCycle`). It prefers a **zero-crossing lock on the real signal** and falls back to a
knob-implied period. No amount of def introspection synthesises "what one cycle of the morph
tap looks like at shape 0.62 and pw 0.31" — that is the platform's own stated bar for a
panel (`ModuleFaceHero.cell` doc comment: *"the picture is the one half of a faceplate that
cannot be platform"*).

The proposal is to **promote the existing canvas into the hero slot and draw all five taps**
— four thin ghosts plus the morph in the domain hue — so the "SHAPE only moves one of these"
fact is visible rather than written.

**⚠ The hero picture SUPPRESSES the dock glyph.** `face.hero.cell` makes `heroGlyph` false
at the dock on the platform branch (`ModuleShell.svelte` PF-20 block); the glyph is untouched
at mini / compact / full. That is correct here: the `scope` glyph is a live trace of the
*first* audio output in declaration order (`shell-glyph-live.ts:96` `primaryAudioOutPortId`)
= **`saw`**, which is the one tap no control on this face changes. Painting both would put a
knob-invariant trace next to a knob-derived picture.

**NOT legitimate, and explicitly rejected:** a bespoke sidebar. The signal chain, the
aliasing numbers and the flow legend are `signal-flow` / `readouts` blocks the shared
`FaceSidebar` paints. Every faceplate wants a context column; a per-module component for it
is how faces drift apart.

---

## 6. RANGES AND CURVES — one live bug, no changes proposed

**No range or curve change is proposed.** All six params keep the def's declarations
(`analog-vco.ts:89-95`).

**⚠ THE CARD ALREADY DISAGREES WITH THE DEF, and it is the CLAUDE.md class exactly.**

```svelte
AnalogVcoCard.svelte:110  <Fader value={fmAmount} min={0} max={1} defaultValue={0} … paramId="fmAmount" …/>
AnalogVcoCard.svelte:111  <Fader value={pmAmount} min={0} max={1} defaultValue={0} … paramId="pmAmount" …/>
```

The def declares **−1..1** for both (`analog-vco.ts:93-94`; `contract-lock.txt:78-79`). **The
entire negative half of both modulation-depth controls is unreachable from the UI** — the
bipolar inversion feature that `analog-vco.dsp:10-12` documents and
`packages/dsp/src/analog-vco-modulation.test.ts:156-165` unit-tests has **no user interface
at all.** This is the backdraft defect inverted: the card *under*-exposes rather than
over-writes, so nothing clamps and nothing warns.

**The rule this face ships under:** the ranges live in ONE place — the def — and the card
imports them (`paramSpec()`, `packages/web/src/lib/ui/modules/card-kit.ts:84-87`, which
exists for this). The card additionally hardcodes all twelve other bounds; every one of them
currently *agrees*, which is the hazard, not the reprieve. Fix the two that do not agree and
source the rest in the same commit, and add `analogVco` to `RANGE_BOUND_CARDS`
(`packages/web/src/lib/ui/modules/card-range-source.test.ts:71-78`) so the source-level grep
covers it.

---

## 7. ALREADY-WRONG (found while speccing — report these regardless of whether the face ships)

- **A · card ranges contradict the def** — §6. Highest severity; a shipped feature with no UI.
- **B · `docs.controls.pw` is impossible.** `analog-vco.ts:135` says *"Animate this with an
  LFO for a classic PWM sweep."* There is **no `pw` CV input** — the five CV jacks are
  tune / fine / fmAmount / pmAmount / shape (`analog-vco.ts:75-79`; `contract-lock.txt:62-70`).
  PW is reachable only by mouse, MIDI CC, Electra or clip automation.
- **C · `docs.controls.fmAmount` states the wrong mechanism.** `analog-vco.ts:132`: *"Positive
  sweeps pitch upward, negative downward."* `analog-vco.dsp:10-12` says the sign is a 180°
  modulator inversion. True only for a strictly unipolar modulator.
- **D · the `shape` CV jack throws half its travel away.** `scaleCv`'s
  `halfSpan = (max-min)/2` (`packages/web/src/lib/audio/cv-scale.ts:57-62`) gives `shape`
  ±0.5, and the LUT is baked with the knob value at plug-in time
  (`packages/web/src/lib/audio/engine.ts:438-443`; `cv-scale.ts:117-125`). At the shipped
  `shape = 0` a full ±1 LFO reaches only 0…0.5 — **the morph never gets past sine.**
- **E · "classic analog-modeled" / "like a hardware Moog VCO"** (`analog-vco.ts:101`) — there
  is zero analog modelling in the file (§1). The header itself calls the saw "naive"
  (`analog-vco.ts:32`).
- **F · `sync` in and `sync` out declare no `edge:`** despite being a textbook rising-edge
  consumer (`analog-vco.dsp:38`) and a one-sample trigger emitter (`analog-vco.dsp:93`). A
  real contract gap against the repo's trigger/gate standard, and `module-docs-lint`'s edge
  gate short-circuits on `if (!p.edge) continue` so nothing sees it.
- **G · the primary input is untested end-to-end.**
  `e2e/tests/vco-pitch-tracking.spec.ts:34-41` excludes analogVco: *"its Faust worklet
  doesn't read the audio-rate `pitch` input in this test's setup (returns ~30 Hz at every
  reference pitch)"*. **INFERENCE:** ~30 Hz is suspiciously close to the knob-only floor of
  30.868 Hz (§1), which is consistent with the pitch signal never reaching channel 0. **This
  should be settled before the face ships**, because §4-C's honesty caveat and §7-G may be
  the same bug wearing two hats.
- **H · stale comments.** `analog-vco.ts:14-15` says "the **four** waveform tap-offs" (it is a
  6-channel splitter, `analog-vco.ts:167`);
  `packages/web/src/lib/docs/module-manifest.ts:125` omits morph, PM and sync entirely;
  `e2e/vrt/vrt-exemptions.ts:226-232` claims analogVco "MIGRATED to the live-surface
  registry… now carries a measured companion" — it has **no entry** in `VRT_LIVE_SURFACES`.

---

## 8. THE PLATFORM EXTENSION THIS FACE ASKS FOR (and the one it does not)

**ASKS FOR — `FaceReadoutValue` needs more than params.** Three of the four readouts a VCO
genuinely wants (measured sounding pitch, sync-out rate under CV, the alias harmonic at the
real sample rate) are functions of the *patch*, not of the params. The minimal extension is
to widen the reader:

```ts
export type FaceReadoutValue = (ctx: {
  read: (paramId: string) => number | undefined;
  sampleRate: number;                       // ctx.sampleRate — kills the 48 kHz hardcode
  readLive?: (paramId: string) => number;   // engine.readParam = intrinsic + modulator tap
}) => string;
```

`engine.readParam` already returns *intrinsic + modulator-tap sample*
(`packages/web/src/lib/audio/engine.ts:737-747`) and the card already consumes it, so the
CV-aware half is wiring, not new machinery. **This is a platform PR, not a face PR** — and
until it lands, §4-C ships labelled `knob pitch` and §4-D ships with its sample rate stated.

**DOES NOT ASK FOR — an audition action.** analogVco is a free-running oscillator; it makes
sound at spawn. There is nothing to audition.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+1 line** — `analogVco family analogvco-cycle kind=cell prefix=analogvco-cycle` (the hero panel is a `ControlFamily`; the kickdrum precedent is `contract-lock.txt` `kickdrum family kickdrum-hero kind=cell prefix=kickdrum-hero` on the platform branch). No param, port, range or curve moves. `face.title/hint/hero/sidebar/pages[].hint` are all out of `contract-signature.ts` by construction. |
| **ART** | none. No `.dsp` edit. analogVco has no source-SHA pin (it is not one of the five `docsStrippedRepoSourceSha` defs). |
| **VRT — NEW** | `face-analogVco-compact` + `face-analogVco-dock`, on **two** platforms = **4 baselines**. Scene rows: `e2e/vrt/workflow-shell-faces.spec.ts` `FACES` gains `{ type: 'analogVco', pages: 3 }`. |
| **VRT — MOVES** | none by this PR alone. `vrt.spec.ts/{darwin,linux}/analogVco.png` (the legacy card) moves **only if** the §6 card fix ships with it — and it should. analogVco is **not** in `STRICT_VRT_MODULES` (`vrt-exemptions.ts:865-871`, excluded for the animated scope), so that baseline is on the informational lane, not the required `vrt-strict` gate. |
| **e2e** | +1 `faces-parity` row (7 cells) in the REQUIRED lane. |
