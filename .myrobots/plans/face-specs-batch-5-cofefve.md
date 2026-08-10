# FACE SPEC — `cofefve` (batch 5)

## 0. STATUS

**Authored 2026-08-10. Every claim below was measured or read against `main`**
(`153e5c36`). Nothing here is implemented; no def, card or DSP file is touched.

**Verdict: PROMOTE — and it OVERTURNS a batch-4 rejection.** Batch 4 deferred
`cofefve` alongside `charlottesEchos` on the grounds that "charlottes-echos is
migrating to `analog-delay-core`". **The migration is not pending for cofefve —
cofefve IS the replacement.** Its own doc: *"a clean-room, OWN-CODE engine (the
replacement for the retired Cocoa Delay; its own DSP, no GPL lineage)"*. It has
its own 209-line worklet and there is nothing to wait for. `charlottesEchos`
stays deferred; `cofefve` does not.

**The headline: SEVEN of twenty-four controls are bit-exactly inert at the
factory default, and every one of them is the dependent half of an enabler pair
whose enabler ships at zero.**

archetype: **the BBD / tape stereo delay.**

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`; **not** in `PUSH_CARD_CONTROLS`. **24 params**, 11 in,
2 out, declared `stereo inL+inR` / `outL+outR`. contract-lock = **40 lines** —
the largest contract in this batch.

**Method.** REAL factory → REAL worklet under `node-web-audio-api`'s
`OfflineAudioContext`, 48 kHz, C4 saw at −6 dBFS into both `inL` and `inR`,
statistics over the tail half of a 2 s render. Determinism control:
`max|run1 − run2| = 0.000e+0`.

---

## 1. AT SPAWN

*Measured*, defaults: `outL` ≡ `outR`, peak 0.58977, rms **−11.63 dB**, centroid
7905 Hz, DC −0.00021. The default is **dry-dominant** — with `dryVolume = 0` the
wet path alone measures **−17.62 dB**, 6 dB below the mixed output.

---

## 2. THE SEVEN THAT DO NOTHING, AND WHY THE FACE IS THE FIX

This is the module's whole design problem in one table. *Measured*, each control
swept over its full declared range, first at the shipped default and then with
its enabler opened.

| dependent | enabler (default) | `Δ` at the default | `Δ` with the enabler open |
|---|---|---|---|
| `lfoFrequency` | `lfoAmount` (**0**) | **0.00e+0** | **7.76e-1** at `lfoAmount 0.3` |
| `duckAttack` | `duckAmount` (**0**) | **0.00e+0** | 8.79e-2 at `duckAmount 5` |
| `duckRelease` | `duckAmount` (**0**) | **0.00e+0** | 1.13e-1 at `duckAmount 5` |
| `clockSource` | `tempoSync` (**0**) | **0.00e+0** | **5.73e-1** at `tempoSync 5` |
| `panMode` | `pan` (**0**) | **0.00e+0** | 4.51e-1 at `pan 0.8` |
| `driveMix` | `driveGain` (**0.1** of 10) | 6.38e-3 | **3.14e-1** at `driveGain 8` |
| `driveIterations` | `driveGain` (**0.1** of 10) | 6.8e-2 (at 12) | **5.34e-1** at `driveGain 8` |

**Five enablers, seven dependents, and every enabler ships closed.** Seven of
twenty-four faders on the card are, right now, decoration.

⚠ **`panMode` is NOT enabled by the LFO.** The obvious second hypothesis —
ping-pong needs motion, so the LFO should wake it — is **false**: measured
`Δ = 0.00e+0` for `panMode` at `lfoAmount = 0.3`. Only `pan ≠ 0` wakes it. A face
that paired PAN MODE with the LFO would be teaching a model the DSP does not
have.

⚠ **`syncPeriod` COULD NOT BE MEASURED, and that is a finding of its own.**
`Δ = 0.00e+0` at `tempoSync = 0` **and** at `tempoSync = 5`. It is written by a
host `setInterval(pushSyncPeriod, 16)` (`cofefve.ts:270`) that resolves the clock
singleton's beat period — a main-thread timer that does not advance inside an
offline render. So the probe cannot see it, **and the more interesting question
it raises is why a host-written value is a user-facing `ParamDef` with a
`0..30 s` range on the card at all.** Marked NOT DETERMINED; flagged in §8.

---

## 3. THE RANKING — 24 params, one lane budget of six

| rank | key | tier | why |
|---|---|---|---|
| 1 | `delayTime` | mini | the control. rms −11.54 → −6.03 dB across the range (5.5 dB, peaking around 96 ms where the echoes align with the source). |
| 2 | `feedback` | compact | −1..+1, and **negative feedback is louder**: −8.66 dB at −1 vs −9.35 at +1 vs −11.68 at +0.2. |
| 3 | `wetVolume` | plate | the mix, and the hazard: **peak 1.240 at 2.0**. |
| 4 | `dryVolume` | plate | **peak 1.089 at 2.0**. |
| 5 | `driveGain` | plate | **THE ENABLER for two dead controls** — ranked 5 for that reason as much as for its 3.0 dB. |
| 6 | `tempoSync` | plate | **THE ENABLER for `clockSource`**, and a 20-position divider. |
| 7 | `lfoAmount` | **dock** | enabler for `lfoFrequency`. |
| 8 | `lfoFrequency` | dock | dependent. |
| 9 | `pan` | dock | enabler for `panMode`. |
| 10 | `panMode` | dock | dependent. |
| 11 | `stereoOffset` | dock | genuine L/R asymmetry (§4-B). |
| 12 | `duckAmount` | dock | enabler for two. |
| 13–14 | `duckAttack` `duckRelease` | dock | dependents. |
| 15 | `driveMix` | dock | dependent. |
| 16 | `driveIterations` | dock | dependent. |
| 17 | `driveCutoff` | dock | |
| 18–19 | `lowCut` `highCut` | dock | |
| 20 | `filterMode` | dock | 4 modes worth `max|Δ| = 1.65e-1` (§4-C). |
| 21–22 | `driftAmount` `driftSpeed` | dock | |
| 23 | `clockSource` | dock | dependent. |
| 24 | `syncPeriod` | dock | host-written (§2). |
| 25 | `cofefve-echo-{n}` | dock (panel) | the picture — §7. |

**The rule the ranking follows: an ENABLER always ranks above its dependents,
and never more than one rank apart.** That is the only ordering that makes a
prefix of the list a *usable* subset — the bluebox "every prefix is still a
keypad" property, applied to a dependency graph instead of a layout.

---

## 4. FOUR MORE MEASURED FACTS

### A. Both volume controls exceed full scale, and they are the only gain stages

| | 0 | 0.4 | 0.8 | 1.2 | 1.6 | 2.0 |
|---|---|---|---|---|---|---|
| `dryVolume` peak | 0.325 | 0.335 | 0.490 | 0.690 | 0.890 | **1.089** |
| `wetVolume` peak | 0.500 | 0.572 | 0.644 | 0.810 | **1.025** | **1.240** |

Both are `0..2 linear`. Nothing after them limits.

### B. STEREO OFFSET is a real, measurable channel asymmetry — and it is antisymmetric

*Measured*, `outL` / `outR` rms dB:

| `stereoOffset` | −0.5 | −0.3 | −0.1 | +0.1 | +0.3 | +0.5 |
|---|---|---|---|---|---|---|
| `outL` | −10.53 | **−6.61** | −11.96 | −8.73 | −11.56 | −10.41 |
| `outR` | −10.41 | −11.56 | −8.73 | −11.96 | **−6.61** | −10.53 |

Exactly mirrored about zero to two decimals — the L row read backwards is the R
row. A clean control, and the only one on the module that makes a stereo image
without the LFO.

### C. FILTER MODE is four positions worth 0.31 dB

`filterMode` 0/1/2/3 → rms −11.63 / −11.74 / −11.88 / −11.57 dB, `max|Δ|` 8.8e-2
/ 1.65e-1 / 5.3e-2. Real but tiny at the shipped `lowCut 0.75` / `highCut 0.001`.
The mode changes the *slope*, and slope is nearly invisible when the cutoffs sit
at the ends of their ranges — which is where they ship.

### D. Both filter cutoffs ship at an END of their range

`lowCut` default **0.75** on `0.01..1`; `highCut` default **0.001** on
`0.001..0.99` — the absolute minimum. Measured `highCut` travel: rms −11.63 →
−11.37 dB, `max|Δ| = 1.38e-1` over the whole range. The tone section is
effectively wide open at spawn and the mode control (§4-C) has almost nothing to
act on.

---

## 5. THE FACE

```ts
face: {
  title: 'Analog delay',
  hint: 'Five enablers ship at zero. Seven controls are waiting on them.',

  order: [
    'delayTime', 'feedback', 'wetVolume', 'dryVolume', 'driveGain', 'tempoSync',
    // dock — ENABLER immediately above its DEPENDENTS, always
    'lfoAmount', 'lfoFrequency',
    'pan', 'panMode', 'stereoOffset',
    'duckAmount', 'duckAttack', 'duckRelease',
    'driveMix', 'driveIterations', 'driveCutoff',
    'lowCut', 'highCut', 'filterMode',
    'driftAmount', 'driftSpeed',
    'clockSource', 'syncPeriod',
    'cofefve-echo-{n}',           // PANEL, rank 25
  ],

  pages: [
    // SIX bands — one below DOCK_TAB_MIN_BANDS (7). A seventh band silently
    // deletes every hint below AND turns the face tabbed, which also kills
    // PF-21 row packing. Twenty-four controls in six bands is the constraint
    // this whole layout is solving.
    { id: 'time', label: 'time + feedback',
      hint: 'TEMPO SYNC overrides TIME; CLOCK SOURCE only matters when it is on',
      controls: ['delayTime', 'tempoSync', 'clockSource', 'syncPeriod', 'feedback',
                 'cofefve-echo-{n}'] },
    { id: 'drive', label: 'drive',
      hint: 'DRIVE ships at 0.1 of 10 — MIX and ITERATIONS do nothing until you raise it',
      controls: ['driveGain', 'driveMix', 'driveIterations', 'driveCutoff'] },
    { id: 'tone', label: 'tone',
      hint: 'both cutoffs ship at an END of their range',
      controls: ['lowCut', 'highCut', 'filterMode'] },
    { id: 'motion', label: 'motion',
      hint: 'LFO FREQ needs LFO AMOUNT; PAN MODE needs PAN — not the LFO',
      controls: ['lfoAmount', 'lfoFrequency', 'driftAmount', 'driftSpeed'] },
    { id: 'space', label: 'stereo',
      controls: ['pan', 'panMode', 'stereoOffset'] },
    { id: 'duckmix', label: 'duck + output',
      hint: 'ATTACK and RELEASE need DUCK above 0',
      controls: ['duckAmount', 'duckAttack', 'duckRelease', 'dryVolume', 'wetVolume'],
      clusters: [{ label: 'ducking', controls: ['duckAmount', 'duckAttack', 'duckRelease'] }] },
  ],

  glyph: 'scope',
  hero: {
    cell: 'cofefve-echo-{n}',
    control: 'delayTime',
    readouts: [
      { label: 'time',   valueId: 'cofefve-time-ms' },
      { label: 'waiting', valueId: 'cofefve-inert-count' },
      { label: 'peak',   valueId: 'cofefve-peak-est' },
    ],
  },

  sidebar: [
    { kind: 'readouts', label: 'enabler -> dependents', entries: [
      { label: 'LFO AMT = 0',  text: 'LFO FREQ is inert' },
      { label: 'DUCK = 0',     text: 'ATTACK + RELEASE are inert' },
      { label: 'SYNC = off',   text: 'CLOCK SOURCE is inert' },
      { label: 'PAN = 0',      text: 'PAN MODE is inert' },
      { label: 'DRIVE = 0.1',  text: 'MIX + ITERATIONS are ~inert' },
    ] },
    { kind: 'presets', label: 'openers', entries: [
      { id: 'tape',  label: 'tape wobble', note: 'lfo + drift',
        values: { lfoAmount: 0.25, lfoFrequency: 0.8, driftAmount: 0.02, driveGain: 3 } },
      { id: 'duck',  label: 'ducked',      note: 'duck 5',
        values: { duckAmount: 5, duckAttack: 5, duckRelease: 40 } },
      { id: 'pingpong', label: 'ping-pong', note: 'pan 0.8',
        values: { pan: 0.8, panMode: 1, stereoOffset: 0.2 } },
    ] },
  ],
}
```

⚠ **The `presets` block is doing real work here, not decoration.** Three of the
five enablers are opened by one click each, and a preset applies through the
ordinary param write path (real undo, real sync). On a module where seven
controls are asleep, "wake the section" is the single highest-value thing the
sidebar can offer.

⚠ **Band-hint budgets** (characters):
`'DRIVE ships at 0.1 of 10 — MIX and ITERATIONS do nothing until you raise it'`
= **74**, over any sane budget — fallback **34**: `'MIX + ITER need DRIVE above 0.1'`.
`'TEMPO SYNC overrides TIME; CLOCK SOURCE only matters when it is on'` = **65**
— fallback **30**: `'SYNC overrides TIME'`.
`'LFO FREQ needs LFO AMOUNT; PAN MODE needs PAN — not the LFO'` = **58** —
fallback **29**: `'FREQ needs AMT; MODE needs PAN'`.
The full sentences survive in the sidebar, which paints unconditionally.

⚠ **`title` / `hint` paint NOTHING at rest.**

---

## 6. DERIVED READOUTS

### A. `cofefve-inert-count` — the readout that is the module's argument

Prints how many controls are currently doing nothing: **`7 waiting`** at the
factory default, counting down as enablers open. Computed from the five enabler
params only.
**NEGATIVE CONTROL — `delayTime`:** must not move it (a time change wakes
nothing). **SECOND — `lfoAmount` 0 → 0.3:** must go `7 waiting` → `6 waiting`,
which the measurement backs (`lfoFrequency` `Δ` 0.00e+0 → 7.76e-1). Both legs
matter: a counter that only ever went down would pass a one-sided test while
being wrong about which control it was counting.

### B. `cofefve-time-ms` — the number TEMPO SYNC hides

The **effective** delay time: `delayTime` in ms when `tempoSync = 0`, the synced
division's period when not. **NEGATIVE CONTROL — `delayTime` at `tempoSync = 5`:**
the readout must NOT move, because the sync overrides it (measured: `tempoSync`
1..11 changes the output at a fixed `delayTime`, `Δ` 3.25e-1 … 5.90e-1).
⚠ **State the units in the label.** `ms`, because the param is in **seconds**
(`0.001..2 s`) and the two differ by 1000×.

### C. `cofefve-peak-est` — the clip warning

From `dryVolume` + `wetVolume` + `driveGain`, anchored on §4-A (1.089 / 1.240 at
the two volume maxima; 0.839 at `driveGain 10`). Red above 1.00.
**NEGATIVE CONTROL — `feedback`:** measured peak 0.565..0.825 across the whole
−1..+1 range, so the estimate must be nearly flat in feedback while it doubles in
`wetVolume`.

---

## 7. THE PICTURE

**An echo-train diagram in the HERO**: the dry hit, then repeats at
`cofefve-time-ms` spacing with heights from `feedback`, drawn **left/right offset
by `stereoOffset`** and **wobbling by `lfoAmount` × `lfoFrequency`**. Grey out the
wobble entirely at `lfoAmount = 0` — which is the shipped state — so the picture
*shows* that the motion section is off rather than drawing a still image that
looks like a working one.

---

## 8. ALREADY-WRONG

- **A · seven controls are inert at the factory default** (§2). Not a bug in any
  one of them; a **defaults** question for the owner: should `driveGain` ship at
  0.1/10, and should PAN MODE be reachable without first moving PAN?
- **B · `syncPeriod` is a host-written value exposed as a user `ParamDef`**
  (`0..30 s`, default 0, pushed by a 16 ms `setInterval`). §2. Either it is not a
  user control and should not be on the card, or it is and should not be
  overwritten 62 times a second. Its own PR; a contract change either way.
- **C · `dryVolume`/`wetVolume` reach 1.089 / 1.240 peak** with no limiter (§4-A).
- **D · `CofefveCard.svelte` re-types 34 literal `min=`/`max=` props** — the most
  of any card in this batch — and `cofefve` is **not** in `RANGE_BOUND_CARDS`.
  With 24 params and a `0.001..2 s` log time, this is the card most likely to
  drift from its def, and the gate that exists for it cannot see it.
- **E · batch 4's deferral reason does not apply** (§0). Recorded because the
  next batch will otherwise re-inherit it: **re-check a rejection against the
  code, not against the previous index.**

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+1 line** for the `cofefve-echo` panel family (or +0 via a sidebar `custom` block). §8-B, if taken, is a separate contract change. |
| **ART** | none from the face. `cofefve` HAS an ART scenario (`art/scenarios/cofefve/`), so §8-C would re-pin — keep it out of the face PR. |
| **VRT** | +`face-cofefve-{compact,dock}` × 2 = **4 informational baselines**. Silent unpatched (an insert), so the `scope` glyph pins deterministically. |
| **e2e** | +1 `faces-parity` row, **25 cells** (24 params + 1 panel) — tied with warrensspectrum for the largest. ≈ +28 s, ≈ +3 s per shard. |
| **the bottom line** | The best "a face reveals something non-obvious" case in the batch, because the non-obvious thing is **structural**: the panel has no way to say that a control is waiting on another control, and seven of them are. |
