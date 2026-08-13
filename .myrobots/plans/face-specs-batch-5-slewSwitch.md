# FACE SPEC — `slewSwitch` (batch 5)

> ⚠ **PLATFORM CORRECTIONS SINCE THIS WAS WRITTEN — 2026-08-12 janitorial sweep.**
> - **The `signal-flow` sidebar kind was DELETED** (#1468, removed with its twelve
>   adopters). `packages/web/src/lib/graph/types.ts:798` now reads "THERE IS NO
>   `signal-flow` KIND, and re-adding one is the mistake this note prevents."
>   **Any `signal-flow` sidebar block proposed below is VOID** — the surviving
>   kinds are the three in `FaceSidebar.svelte`.
> - **PF-22 freed the hero rank** (#1480): `face.hero.cell` no longer consumes a
>   LANE rank, so a `panel` may now rank FIRST. Any argument below that a module
>   cannot be faced because a panel's first legal rank is 7 is OBSOLETE.
> - **A card↔face PRIMITIVE-PARITY gate now exists** (#1480,
>   `card-primitive-parity.test.ts`): ranking a param whose card binds it to a
>   primitive the platform has no cell kind for now FAILS, naming the
>   `(module, param, primitive)` triple. `XyPad` and `NoteEntry` are the two
>   declared gaps.
> - **The faceplate pipeline is PAUSED by owner directive.** This spec is BANKED,
>   not cancelled and not blocked.


## 0. STATUS

**Authored 2026-08-10. Every claim below was measured or read against `main`**
(`153e5c36`). Nothing here is implemented; no def, card or DSP file is touched.

**Verdict: PROMOTE — on a number that is exactly √2. At `LENGTH = 1` the
SWITCHED output is the input × 1.4142 (+3.01 dB), and two of the seven outputs
go bit-silent.**

archetype: **the QUAD SLEW + SEQUENTIAL SWITCH** — two utilities in one box.
Deferred from batch 4 as a genuine candidate with no measurement.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`; **not** in `PUSH_CARD_CONTROLS`. 7 params, 10 in,
**7 out**. contract-lock = **25 lines**.

**Method.** REAL factory → REAL worklet (`packages/dsp/src/slewswitch.ts`) under
`node-web-audio-api`'s `OfflineAudioContext`, 48 kHz. Two stimulus sets: slow
sines (2/3/5/7 Hz at 0.9/0.5/0.7/0.3) for the slew half, and **four DC levels**
(+0.90 / −0.60 / +0.30 / −0.10) with a 4 Hz clock for the switch half, because a
switch between constants makes the switch's own arithmetic readable.

---

## 1. WHAT IT IS

Four independent slew limiters (`in1..in4 → out1..out4`, per-channel time
constant) **plus** a 4→1 sequential switch over the same four inputs
(`switched`), advanced by `step_clock`, with `step_idx` and `eoc` as position
outputs. `mode` picks the stepping order; `length` sets the cycle length;
`xfadeTime` is the switch's crossfade.

*Measured*, defaults, the slow-sine set, tail 70 %:

| out | peak | rms dB |
|---|---|---|
| `out1` | 0.17661 | −19.93 |
| `out2` | 0.07231 | −27.98 |
| `out3` | 0.04880 | −31.84 |
| `out4` | 0.02031 | −39.43 |
| `switched` | 0.12211 | −26.05 |
| `step_idx` | 1.00000 | −1.66 |
| `eoc` | 1.00000 | −18.45 |

The four slew outputs are **heavily attenuated at the shipped default** — the
default `slew` of 0.5 s against a 2 Hz input is a 0.9 → 0.177 peak, i.e. **−14.1
dB of the input**, and 0.3 → 0.020 for the 7 Hz one (−23.5 dB). That is what a
slew limiter is for; it is also why a face must not present these as unity paths.

---

## 2. THE √2

*Measured*, four DC inputs, `slew* = 0.001` (out of the way), 4 Hz clock,
distinct `switched` values in the settled half:

| `mode` | `length` | `switched` range | `step_idx` max | `eoc` rising edges |
|---|---|---|---|---|
| 0 | **1** | **+0.90 … +1.27** | **0.00** | **0** |
| 0 | 2 | −0.60 … +0.90 | 1.00 | 4 |
| 0 | 4 | −0.60 … +0.90 | 1.00 | 2 |
| 1 | **1** | **+0.90 … +1.27** | **0.00** | **0** |
| 1 | 2 | −0.60 … +0.90 | 1.00 | 4 |
| 1 | 4 | −0.60 … +0.90 | 1.00 | 1 |
| 2 | **1** | **+0.90 … +1.27** | **0.00** | **0** |
| 2 | 2 | −0.60 … +0.90 | 1.00 | 7 |
| 2 | 4 | −0.61 … +0.90 | 1.00 | 7 |

**Three things, all measured, all invisible from the card.**

**(i) `LENGTH = 1` outputs `in1 × 1.2728`.** The input is exactly +0.90 and the
settled output is **+1.2728 = 0.90 × 1.41421**. An equal-power crossfade
(`cos/sin`, the pop-free kind) between a source and *itself* sums to `√2`, and at
`LENGTH 1` the switch crossfades slot 1 into slot 1 forever. **+3.01 dB, exactly,
on a CV utility whose whole job is not to change the value.** It is identical in
all three modes.

**(ii) `LENGTH = 1` kills `step_idx` and `eoc`.** `step_idx` max **0.00** and
`eoc` **zero rising edges** — bit-silent, in every mode. Two of seven outputs go
dead at one setting of one knob, and the knob is `1..4 discrete` so it is one
detent away.

**(iii) `eoc` does not mean the same thing in `mode 2`.** At `length 4` it fires
**2** times in modes 0, **1** time in mode 1 and **7** times in mode 2 over the
same clock. In the first two it is an end-of-cycle; in mode 2 it fires more often
than a cycle can complete, so it is reporting something else (a wrap of a random
walk). Marked: measured; the semantics of `eoc` in mode 2 **read-in-code as a
random-mode wrap and NOT confirmed** — an owner should say what it is meant to
be before a face labels it.

⚠ **`step_idx` is a 0..1 NORMALISED CV, not a step index.** Max is 1.00 at
`length 2` **and** at `length 4`. Its `PortDef` id says index; the signal says
position. A face that printed "step 3 of 4" from it would be inventing a scale.

---

## 3. THE SLEW HALF, AND WHERE IT ENDS

*Measured*, `out1` vs `slew1`, the 2 Hz / 0.9 input, log sweep:

| `slew1` (s) | 0.001 | 0.0084 | 0.0707 | 0.5946 | 5.0 |
|---|---|---|---|---|---|
| `out1` peak | **0.900** | 0.895 | 0.673 | 0.158 | **0.027** |
| `out1` rms dB | −3.69 | −3.72 | −6.27 | −21.16 | **−36.36** |

Clean, monotonic, 32.7 dB of range, and **perfectly orthogonal**: sweeping
`slew1` leaves `out2`, `out3`, `out4` at `Δ = 0.00e+0` throughout, and the same
holds for each of the other three. Four independent channels, verified.

`xfadeTime` touches **only** `switched` (`out1..4` all `Δ = 0.00e+0` across
0.001..2 s) and is worth 4.65 dB there (−25.85 → −30.50 dB).

`mode` touches **only** `switched`, `step_idx`, `eoc` — the slew outputs are
`Δ = 0.00e+0` across all three modes. Also verified.

**So the module really is two independent utilities, and the measurement proves
it rather than the doc asserting it.** That is the structural fact a face should
present: two bands that never talk to each other.

---

## 4. THE FACE

```ts
face: {
  title: 'Slew + switch',
  hint: 'Two utilities, no shared state. LENGTH 1 is +3 dB and kills STEP and EOC.',

  order: [
    'mode',        // rank 1: it is the only control that changes what EOC means
    'length',      // rank 2: the LENGTH-1 trap (+3.01 dB, two dead outputs)
    'slew1', 'slew2', 'slew3', 'slew4',
    'xfadeTime',   // rank 7 — DOCK ONLY, and deliberately (see below)
    'slewswitch-map-{n}',   // PANEL, rank 8
  ],

  pages: [
    { id: 'switch', label: 'sequential switch',
      hint: 'LENGTH 1 outputs IN1 x 1.41 and stops STEP / EOC',
      controls: ['mode', 'length', 'xfadeTime', 'slewswitch-map-{n}'] },
    { id: 'slew', label: 'four slew limiters',
      hint: 'independent — nothing here reaches the switch',
      controls: ['slew1', 'slew2', 'slew3', 'slew4'] },
  ],

  glyph: 'scope',
  hero: {
    cell: 'slewswitch-map-{n}',
    control: 'length',
    readouts: [
      { label: 'cycle', valueId: 'slewswitch-cycle' },
      { label: 'gain',  valueId: 'slewswitch-switch-gain' },
      { label: 'eoc',   valueId: 'slewswitch-eoc-meaning' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'two utilities, no shared state', stages: [
      { label: 'IN 1-4',   role: 'generator' },
      { label: 'SLEW x4',  role: 'bus', note: 'OUT 1-4' },
      { label: 'SWITCH',   role: 'bus', parallel: true, note: 'SWITCHED' },
    ] },
    { kind: 'readouts', label: 'measured', entries: [
      { label: 'LENGTH 1', text: 'SWITCHED = IN1 x 1.41  (+3.01 dB)' },
      { label: 'LENGTH 1', text: 'STEP and EOC are silent' },
      { label: 'STEP',     text: 'a 0..1 CV, not a step number' },
    ] },
  ],
}
```

⚠ **`mode` at rank 1 and `xfadeTime` at rank 7** are both arguments.
`faceTierCap('full') = 6`, so rank 7 is dock-only: `xfadeTime` is a *set-once*
smoothing time whose entire measured effect (4.65 dB on one output) is
inaudible-as-a-value, and spending a lane cell on it would push a slew channel
off. `mode` goes to rank 1 because it is the only control on the module that
changes what another *output* means (§2-iii).

⚠ **TWO bands** — well under `DOCK_TAB_MIN_BANDS` (7), so the band hints render,
and PF-21 packs 4 + 4 cells onto one row.

⚠ **Band-hint budget**: `'LENGTH 1 outputs IN1 x 1.41 and stops STEP / EOC'` =
**47 characters**; shorter fallback **26**: `'LENGTH 1: +3 dB, no STEP'`.
The full fact is in the sidebar, which paints unconditionally.

⚠ **`title` / `hint` paint NOTHING at rest.**

⚠ **A panel's first legal rank is 7** and this face has 7 params, so rank 8 is
reachable and the picture can be a real `hero.cell`.

---

## 5. DERIVED READOUTS

### A. `slewswitch-switch-gain` — the √2

Prints **`x1.41 (+3.01 dB)`** at `length = 1` and `x1.00` otherwise. It is a
function of one param and it is the single most useful string this module could
paint. **NEGATIVE CONTROL — `xfadeTime`:** the gain must be invariant to it
(measured: `switched` levels at `length 1` are +0.90…+1.2728 regardless of
`xfadeTime`). **SECOND — `mode`:** also invariant (measured identical in all
three modes) — so a derivation that made it mode-dependent is falsified.

### B. `slewswitch-cycle` — how many slots, and whether the position outputs live

`4 slots` / `3 slots` / `2 slots` / **`1 slot — STEP + EOC silent`**.
**NEGATIVE CONTROL — `mode`:** the *count* must not move with it (measured:
`step_idx` max 1.00 at length 2 and 4 in every mode). **SECOND — `length` 1 → 2**,
where the measured `eoc` count goes 0 → 4 and the readout must change class.

### C. `slewswitch-eoc-meaning` — the honest one

`end of cycle` in modes 0 and 1; **`wrap (random)`** in mode 2, because the
measurement says it fires 7× where a cycle completes twice. ⚠ **This readout is
provisional** — §2-iii marks the mode-2 semantics as unconfirmed. If the owner
says mode 2's `eoc` is meant to be a cycle end, this readout becomes a bug report
rather than a label, and the face should ship without it until then.

---

## 6. THE PICTURE

**The switch map, in the HERO**: four input slots in a ring, the active one lit,
the arrow pattern drawn per `mode` (forward / pendulum / random), the ring
truncated to `length` — **and at `length = 1` the ring collapses to a single slot
with the `×1.41` printed on it.** A picture that drew a one-slot ring as normal
would be hiding the batch's cleanest defect.

---

## 7. ALREADY-WRONG

- **A · `LENGTH = 1` applies +3.01 dB** to `switched` (§2-i). An equal-power
  crossfade of a source with itself. One-line DSP fix (short-circuit the
  crossfade when the source and destination slots are equal), **its own PR**.
- **B · `LENGTH = 1` bit-silences `step_idx` and `eoc`** (§2-ii). Arguably
  correct (a one-slot cycle never advances); arguably `eoc` should fire once per
  clock. Owner call.
- **C · `eoc` in `mode 2` fires 7× where modes 0/1 fire 2× and 1×** (§2-iii).
  **NOT DETERMINED** — needs an owner statement before a face labels it.
- **D · `step_idx` is a normalised 0..1 CV whose id says "index"** (§2). A
  documentation fix; `slewSwitch` is in `STRICT_DOCS`.
- **E · `SlewSwitchCard.svelte` re-types 4 literal range props** and `slewSwitch`
  is **not** in `RANGE_BOUND_CARDS`.
- **No dead controls.** All seven params measure live, and the four slew channels
  are verified orthogonal (§3) — which is itself worth recording, because "four
  identical knobs" is exactly the shape that usually hides a cross-talk bug.

---

## 8. COST

| | |
|---|---|
| **contract-lock** | **+1 line** for the `slewswitch-map` panel family (or +0 as a sidebar `custom` block). |
| **ART** | none from the face. §7-A is an audio change; `slewSwitch` has no ART scenario today, so it would want one *with* the fix. |
| **VRT** | +`face-slewSwitch-{compact,dock}` × 2 = **4 informational baselines**. Silent unpatched (a utility with no internal source) → the `scope` glyph pins deterministically. |
| **e2e** | +1 `faces-parity` row, **8 cells** (7 params + 1 panel). ≈ +14 s, ≈ +1.5 s per shard. |
| **the bottom line** | A small face with one exact number (√2) and two dead outputs behind one detent. It is also the batch's cleanest example of a module whose two halves genuinely do not interact — proven, not asserted. |
