# FACE SPEC — `wavecel` (batch 5)

> **Two owner rulings, 2026-08-11, apply to this file** (verbatim at
> `rings.ts:585-590` and `:645-650`): *"we should prefer almost zero AI authored
> text, and all future faceplate work should reflect that"* and *"lets stop doing
> these and clean up the existing ones, get rid of them. lose the signal flow
> diagrams."* Every proposed `hint` has been **deleted** from §5; its measured
> content is in §3/§4. Do not re-author it. Measurements belong in `docs.controls`
> (the `rings.ts:592-596` precedent), not on the panel.

## 0. STATUS

**Authored 2026-08-10 against `main` at `153e5c36`. UNBUILT** — no `face:` block.

**Verdict: PROMOTE — and the headline is that the marquee STEREO control on a
"stereo wavetable oscillator" leaves the two channels 99.94 % correlated at
maximum.**

archetype: **the STEREO WAVETABLE voice** — the advanced sibling of
`wavetableVco`. Deferred from batch 4 as a genuine candidate with no measurement.

Not in `STRICT_FACES`. In `STRICT_DOCS`; **not** in `STRICT_VRT_MODULES`; **not**
in `PUSH_CARD_CONTROLS`; **not** in `RANGE_BOUND_CARDS`. 10 params, **4 declared
control families** (`wavecel-preset-select`, `-source-select`, `-viz-toggle`,
`-wav-input`), 7 in, 4 out (2 audio + `mono-video` + `video`). contract-lock =
**26 lines**. **A complete `face.order` therefore needs 14 keys, not 10.**

**Method.** The REAL `wavecelDef.factory` (an `AudioWorkletNode` over
`packages/dsp/src/wavecel.ts` + `lib/wavetable-osc` + `lib/adsr-env`) under
`node-web-audio-api`'s `OfflineAudioContext`, 48 kHz. **Determinism control:
`max|run1 − run2| = 0.000e+0`** on identical params, so `Δ` is meaningful here.

---

## 1. WHAT IT DOES AT SPAWN

*Measured*, nothing patched, factory defaults, tail half of a 0.5 s render:

| | peak | rms | rms dB | centroid | L/R |
|---|---|---|---|---|---|
| `out_l` / `out_r` | 0.99981 | 0.57637 | −4.79 | 5382 Hz | **bit-identical** |

**A full-scale, free-running MONO drone.** `side = 0.00000`, `L/R corr =
1.000000` — not "almost", exactly. That is correct and documented ("With nothing
patched into POLY or TRIG … WAVECEL free-runs as a continuous full-level drone"),
and it is the state a face has to be designed for.

---

## 2. THE CONTROLS — 14 keys, and FIVE of them do nothing until a cable arrives

| rank | key | tier | why |
|---|---|---|---|
| 1 | `wavecel-preset-select-{n}` | mini | the loaded TABLE swaps the whole sound — the dx7-preset precedent, and the only rank-1 that is not a knob. |
| 2 | `morph` | compact | the scan: centroid **5382 → 263 Hz (20×)** across 0..1, the largest travel on the module. |
| 3 | `fold` | plate | centroid 5382 → 6930 Hz, level flat. |
| 4 | `spread` | plate | ranked 4, not 2, **on the measurement** — §4-A. |
| 5 | `tune` | plate | |
| 6 | `fine` | plate | |
| 7 | `base_vol` | **dock** | **bit-exactly inert unpatched** — §3. |
| 8–11 | `attack` `decay` `sustain` `release` | **dock** | ditto, all four. |
| 12 | `wavecel-source-select-{n}` | dock | table source. |
| 13 | `wavecel-wav-input-{n}` | dock | the WAV loader. |
| 14 | `wavecel-viz-toggle-{n}` | dock | scope ⇄ 3-D screen. |
| 15 | `wavecel-table-{n}` | dock (panel) | the picture — §7. |

⚠ **Ranks 7–11 are the argument.** All five amplitude controls measure
`Δ = 0.00e+0` in the shipped state; putting any of them in a 192×180 lane tile
paints a dead dial. In the dock they are live *and* the band label can say the
condition. With 14 keys the panel's rank-7 floor is comfortably cleared at rank 15.

⚠ **`face.order` completeness is 14 keys, not 10.** `module-face-lint`'s
`STRICT_FACES` completeness rule counts every declared `ControlFamily`, and wavecel
declares four. **A face authored from `params` alone is red on arrival.**

**NO AUDITION** — the module free-runs, so a "hear it" button has nothing to add,
and a `trigger` press would need an `action` with a `ShellActionCell.probe` reaching
a callable the def does not expose.

---

## 3. INERT AT SPAWN — five of ten params

`base_vol`, `attack`, `decay`, `sustain`, `release`: **`Δ = 0.00e+0` on both audio
outputs across their full declared ranges**, both unpatched and with a gate waveform
on the `trigger` bus.

**POSITIVE CONTROL — a real graph EDGE.** The factory decides gated-vs-drone from
`livePatch.edges`, **not** from bus presence (`wavecel.ts:319-330`), so a driver
buffer alone leaves the module in drone mode. Seeding one real edge into `trigger`
and re-running, gate high 1.0–5.0 s, 100 ms windows:

| patch | measured envelope |
|---|---|
| `A = 0.001` | opens in one window, holds 1.000 |
| `A = 1.000` | 0.098 0.197 0.296 0.395 0.495 … 0.989 → **exactly 1 s to full** |
| `A = 5.000` | 0.020 0.039 … 0.798 at t = 4 s → **exactly 1/5 per second** |
| `D = 2, S = 0.2` | 0.996 → 0.313 over 4 s (2 s time constant) |
| `D = 0.001, S = 0.2` | 0.275 → 0.200 in one window |
| `S = 0.5, base = 0.5` | holds **0.750** = `base + (1−base)·env` ✓ |

So the envelope is correct and complete. **The five controls are gated, not
broken** — and nothing on the panel says so.

---

## 4. WHAT THE FACE MUST MAKE VISIBLE

### A. SPREAD is a mono control — and RMS is the WRONG INSTRUMENT for saying so

*Measured*, second half of a 1 s render, mid/side and L/R correlation:

| `spread` | 1 (default) | 1.5 | 2 | 3 | 4 | 5 (max) |
|---|---|---|---|---|---|---|
| side rms | **0.00000** | 0.00179 | 0.00272 | 0.00368 | 0.00840 | **0.01155** |
| side/mid | **−240 dB** | −50.16 | −46.54 | −43.94 | −36.81 | **−34.06 dB** |
| L/R corr | **1.000000** | 0.999986 | 0.999967 | 0.999941 | 0.999696 | **0.999429** |

**At the top of its travel, the stereo spread of a stereo oscillator puts 34 dB of
side energy under the mid and leaves the channels 99.94 % correlated.** Fold that
to mono and you lose 0.02 % of the energy.

⚠ **AND THE FIRST INSTRUMENT SAID SOMETHING ELSE.** A per-channel RMS sweep read
`out_l −4.79 → −4.78 dB` and `out_r −4.79 → −4.58 dB` and looked like a working,
asymmetric stereo control. **RMS is invariant to correlation** — the exact class of
blindness CLAUDE.md's VALIDATE-THE-INSTRUMENT section is about. The
mid/side/correlation probe is negative-controlled by `spread = 1`, where it must
read **exactly** −240 dB / 1.000000 (it does), and positively by `spread = 5`.

### B. MORPH is 20× of centroid and 3.9 dB of NON-MONOTONIC level

*Measured*, `out_l`, 0..1 in 0.2 steps:

| `morph` | 0 | 0.2 | 0.4 | 0.6 | 0.8 | 1.0 |
|---|---|---|---|---|---|---|
| rms dB | −4.79 | **−1.87** | **−0.92** | −3.84 | −4.04 | −3.01 |
| centroid | 5382 Hz | 5037 | 4651 | 2873 | 503 | **263** |
| peak | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |

Peak is pinned at 1.000 at every position — the oscillator runs at full scale
throughout — while RMS swings **3.87 dB** and is loudest in the *middle*. A player
sweeping MORPH hears a level ride they did not ask for.

### C. A gated wavecel emits EXACTLY ONE render quantum of full-scale drone

*Measured*, `trigger` patched as a real edge, gate held LOW for the whole render:
last non-zero sample = **127**, i.e. **128 samples / 2.667 ms**, peak **0.9971**,
then bit-zero for the remaining 0.997 s. The per-quantum peaks are
`0.9971 0 0 0 0 0 0 0 0 0`.

`trigger_connected` is a k-rate AudioParam written with
`setValueAtTime(1, ctx.currentTime)` at factory time; the first quantum renders
before it lands. **One 2.7 ms full-scale click every time you patch a gate into a
silent wavecel.** Small, precisely bounded, and its own tiny fix.

### D. Four of ten params are not knobs at all

`wavecel-preset-select`, `-source-select`, `-wav-input`, `-viz-toggle` are declared
control families with no `ParamDef`. They are half the module's identity (which
table is loaded) and they are **invisible to every param-reading gate.**

---

## 5. THE FACE

```ts
face: {
  title: 'Wavetable voice',

  order: [
    'wavecel-preset-select-{n}',  // the table IS the sound (dx7 precedent)
    'morph',                      // 20x centroid — the scan
    'fold',
    'spread',                     // rank 4 on measurement: -34 dB of side at max
    'tune',
    'fine',
    // ranks 7-11 — ALL FIVE measure Delta = 0.00e+0 until a cable lands.
    'base_vol', 'attack', 'decay', 'sustain', 'release',
    'wavecel-source-select-{n}', 'wavecel-wav-input-{n}', 'wavecel-viz-toggle-{n}',
    'wavecel-table-{n}',          // PANEL, rank 15
  ],

  pages: [
    { id: 'table', label: 'wavetable',
      controls: ['wavecel-preset-select-{n}', 'wavecel-source-select-{n}',
                 'wavecel-wav-input-{n}', 'morph', 'wavecel-table-{n}'] },
    { id: 'timbre', label: 'fold + width', controls: ['fold', 'spread'] },
    { id: 'pitch', label: 'pitch', controls: ['tune', 'fine'] },
    { id: 'amp', label: 'amp — needs a gate',
      controls: ['base_vol', 'attack', 'decay', 'sustain', 'release'],
      clusters: [{ label: 'adsr', controls: ['attack', 'decay', 'sustain', 'release'] }] },
    { id: 'screen', label: 'screen', controls: ['wavecel-viz-toggle-{n}'] },
  ],

  glyph: 'scope',
  hero: {
    cell: 'wavecel-table-{n}',
    control: 'morph',
    readouts: [
      { label: 'frame', valueId: 'wavecel-frame' },
      { label: 'width', valueId: 'wavecel-stereo-width' },
      { label: 'amp',   valueId: 'wavecel-amp-mode' },   // ⚠ see §6-C — NOT SHIPPABLE
    ],
  },

  sidebar: [
    { kind: 'readouts', label: 'why is nothing changing?', entries: [
      { label: 'A / D / S / R', text: 'needs POLY or TRIG patched' },
      { label: 'BASE',          text: 'needs POLY or TRIG patched' },
      { label: 'unpatched',     text: 'full-scale drone, mono' },
    ] },
  ],
}
```

⚠ **FIVE bands**, so this face is **not** tabbed. Adding two more turns it into a
tab rail — the threshold is a cliff, not a gradient.

⚠ **Band label budget.** `'amp — needs a gate'` is **18 characters**. Label clipping
is invisible to `faces-parity` (`toHaveText` reads `textContent`), so state the
budget; the full condition lives in the sidebar, which paints unconditionally.

---

## 6. DERIVED READOUTS

### A. `wavecel-frame` — where MORPH is pointing

`frame = morph × (frameCount − 1)`, printed as `7 / 16`. **NEGATIVE CONTROL —
`fold`:** must not move it (fold changes the centroid by 1.3× and the frame by
nothing). **SECOND — `spread`:** must not move it either, because SPREAD reads
*neighbouring* frames without moving the centre; a derivation that folded spread
into the frame number would be describing a different module.

### B. `wavecel-stereo-width` — the readout that IS the face

Prints the side/mid ratio for the current `spread`, anchored on §4-A: **`mono`** at
1, `−46 dB` at 2, **`−34 dB`** at 5. **NEGATIVE CONTROL — `morph`:** the width must
be invariant to it (measured: side/mid is a function of `spread` alone).
**SECOND — `spread = 1`:** it must print the *word* `mono`, not `−240 dB`, because
the channels are bit-identical and a number implies a difference exists.

### C. `wavecel-amp-mode` — NAMED AND NOT SHIPPABLE TODAY

It would print `drone (full scale)` vs `gated`. **It cannot ship**:
`FaceReadoutValue` is params-only, and the distinction is a function of the **patch
edges**. Recorded here so the next author does not "fix" it into existence as a
static string — the same call batch 4 made for
`sidecar-reduction-db` / `clouds-buffer-fill`. **Until `FaceReadoutValue` widens,
the fact lives in the sidebar `readouts` block above**, which paints unconditionally
and says the same thing without pretending to be live.

---

## 7. THE PICTURE

**The wavetable, in the HERO** — all frames drawn as a small waterfall with the
`morph` frame highlighted, and the SPREAD neighbours drawn at reduced opacity so
the width control's *mechanism* (adjacent frames, one shared phase) is visible.
That is exactly the thing §4-A shows the ear cannot hear, and it is the honest way
to present a control that measures −34 dB: **show what it does, do not imply how
much.**

Do not put a scope trace here. The dock glyph is suppressed by `hero.cell` anyway,
and the free-running waveform looks the same at half the settings.

---

## 8. ALREADY-WRONG

- **A · SPREAD at maximum is 99.94 % correlated** (§4-A). **Whether the spread
  depth should be widened is a DSP question and its own PR** — it would re-pin
  `wavecel`'s ART scenario **and** `wavecel-spread-parity.test.ts`.
- **B · 2.667 ms of full-scale output when a gate cable lands** (§4-C). One render
  quantum; **the fix is to seed `trigger_connected` in `processorOptions`** rather
  than through a k-rate write. **Tiny, and its own PR.**
- **C · MORPH swings 3.87 dB non-monotonically** (§4-B) on a control documented
  purely as a timbre scan. **`wavecel` is in `STRICT_DOCS`.**
- **D · `WavecelCard.svelte` re-types 20 literal `min=`/`max=` props** and `wavecel`
  is **not** in `RANGE_BOUND_CARDS`, so `card-range-source` is structurally unable
  to see a divergence. The backdraft class.
- **E · the `poly`/`trigger` connectedness read is `livePatch.edges`**, *"which is
  correct and is also why every offline probe of this module is wrong by default"*
  (§3). **Worth a line in the def comment for the next person with a harness.**

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+1 line** for the `wavecel-table` panel family. **+0** if the picture goes to a sidebar `custom` block instead. |
| **ART** | none from the face. §8-A/B are audio changes and are not in the face PR. |
| **VRT** | +`face-wavecel-{compact,dock}` informational baselines. ⚠ **FREE-RUNNING** — derive glyph determinism the analogVco way (10 separate processes, unmasked). |
| **e2e** | +1 `faces-parity` row, **15 cells** (10 params + 4 families + 1 panel). ≈ +20 s. |
| **the bottom line** | A strong promotion with one genuinely surprising number. The five gated controls make the "why is nothing happening" band the most useful thing on the faceplate. |
