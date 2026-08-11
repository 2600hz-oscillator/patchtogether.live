# FACE SPEC — `spectrograph` (batch 6)

## 0. STATUS

**Authored 2026-08-11 against `main` at `52e3d882`.** Nothing here is
implemented. Every number below was measured against the real shipped core.

**Verdict: PROMOTE — narrowly, and CONDITIONALLY. The single knob contributes
nothing to the case; the whole case is the renderer port and three readouts.**

archetype: **the display module.** One audio in, one trim knob, two video outs
over the same binned plane.

Not in `STRICT_FACES`; **no `face:` block**. In `STRICT_DOCS`. **Not** in
`STRICT_VRT_MODULES` and **not** in `EXEMPT_FROM_VRT` — it rides the full
(informational) VRT lane with a committed `vrt.spec.ts/spectrograph.png`, no
mask and no `vrt-live-surfaces` companion. Not in `DOCKABLE_TYPES`. Not in
`PUSH_CARD_CONTROLS`. Not in `card-range-source.test.ts`. `rack-sizes.ts:203` —
`2u / hp 2`, 320×220 px. **1 param, 1 input, 2 outputs, 5 lines of
`contract-lock.txt`** — tied with `scaler` for the smallest control surface of
any module considered for a face.

**Method.** The pure core (`spectrograph-draw.ts`) esbuild-bundled from source
and driven directly — no mirror, no re-typed formula. A bin-index probe
(`bins[i] = i`) run through the real `writeSpectrumColumn`, so the row→bin map
is read off the shipping function rather than derived on paper. **Determinism
control: two identical binnings + renders bit-equal — `true`.**

---

## 1. SHOULD IT HAVE A FACE AT ALL? — the argument, both ways

`noise`'s spec concluded **NO FACE ON MERIT** and that was useful. This one does
not, and the difference is worth stating precisely, because the *curation*
argument fails here exactly as it did for `noise`.

**Against.**
1. **One param.** `face.order` would be `['gain']`. There is nothing to rank, no
   tier that shows a subset, no page that groups anything. `faceTierCap` gives
   mini 1 / compact 2 / full 6 against a roster of one.
2. **The glyph cannot show the module.** `glyphBinding` resolves
   `scope`/`meter`/`waveform` to `live-audio` only when
   `primaryAudioOutPortId(def)` is non-null — the first output whose `type` is
   `'audio'` (`shell-glyph-live.ts:95-97`). spectrograph's two outputs are
   `mono-video`, so the resolver falls through every branch to
   **`{ kind: 'static' }`** (`:170`). A spectrograph face with `glyph: 'scope'`
   paints a fixed synthetic trace that has nothing to do with the module.
3. **The card is already correct for what it does** — a live preview, a view
   toggle, one knob, an axis note.

**For, and this is what decides it.**

4. **Promotion is not additive here — it is a SWAP, and the swap is already
   happening.** `laneRenderKind` (`legacy-fallback.ts:106-110`) returns
   `'placeholder'` for a shell-preview lane whose type is **not** in
   `STRICT_FACES`. So **under `?shell=1` today, spectrograph's lane tile is
   already a `ModuleShellPlaceholder` with no preview at all**; only the dock
   still mounts the real card. Promoting it with a panel *restores* the picture
   to the lane. Promoting it **without** one takes the dock's preview away too,
   and makes the resulting blank look deliberate.
5. **The module makes three claims that are false or unstated, and a faceplate
   is the only surface that can carry the corrections** (§4). Two of them are
   printed on the card right now.

**Verdict: PROMOTE, with a hard precondition** — the renderer must move into a
shared surface component that BOTH the card and a `ShellPanelCell` mount, the
`cube` / `CubeVizSurface.svelte` precedent verbatim (`shell-cells.ts:467-498`:
*"the SAME component the legacy card mounts rather than a reduction of it"*).
A face that reduces the sonogram to a second, weaker drawing is the renderer-drift
class that rule exists for.

⚠ **AND THE ORDER MATTERS.** §4-A is a real defect in what the picture *shows*.
Shipping the face first freezes the wrong picture into a VRT baseline and into
`docs`, and then a binning fix moves both. If the binning is going to be fixed,
fix it first; if it is not, the face must say what the axis really is rather
than repeat the card's claim.

---

## 2. THE CONTRACT — everything, in five lines

```
spectrograph meta domain=audio
spectrograph in  in   audio
spectrograph out bw    mono-video
spectrograph out color mono-video
spectrograph param gain 0.25..4 log default=1
```

| kind | id | detail |
|---|---|---|
| param | `gain` | label `Gain`, **0.25 .. 4, log, default 1**, no units. Applied by a `GainNode` **before** the analyser tap (`spectrograph.ts:137, 257`) — it shapes the IMAGE, not any audio, because there is no audio output. |
| input | `in` | `audio`, no `accepts` widening — CV, gate and pitch cables are refused. |
| output | `color` | `mono-video`, the blue→cyan→yellow→red heat ramp. |
| output | `bw` | `mono-video`, INVERTED grayscale (quiet = white, loud = black). |

**No `edge` ports, no CV inputs, no control families, no `node.data`.** There is
also **no CV input for `gain`** — the one knob cannot be modulated.

Fixed internals worth knowing, because three of them are what the readouts are
about: `fftSize 1024` → `binCount 512` → **46.875 Hz per bin** at 48 kHz;
`smoothingTimeConstant 0.4`; `SPEC_W 256` × `SPEC_H 128`; display window
`DB_LO −90` … `DB_HI −10`; `COLUMN_INTERVAL_MS 16`.

---

## 3. MEASURED — the row → FFT-bin map

`writeSpectrumColumn` maps each of the 128 image rows to a log-spaced target
frequency over `[20 Hz, min(20 kHz, Nyquist)]` and picks the **nearest single
bin**, clamped to bin 1 (`spectrograph-draw.ts:136-141`). No averaging, no
interpolation. Driven with `bins[i] = i` so the output *is* the bin index:

| | |
|---|---|
| distinct bins reached | **76 of 512** — 14.8 % of the spectrum the FFT computed |
| bins never sampled | **436** |
| rows reading a DUPLICATED bin | **64 of 128** — exactly half the image |
| worst duplication | **bin 1 (46.9 Hz) fills 24 of 128 rows = 18.8 % of the image height** |
| largest jump between ADJACENT rows | **23 bins = 1.08 kHz**, at row 1 |

Sample rows (row · nominal Hz · chosen bin · that bin's true Hz · error):

| row | nominal | bin | true Hz | error |
|---|---|---|---|---|
| 0 | 20 000 Hz | 427 | 20 015.6 | +1 ¢ |
| 1 | 18 941 Hz | 404 | 18 937.5 | −0 ¢ |
| 16 | 8 377 Hz | 179 | 8 390.6 | +3 ¢ |
| 32 | 3 509 Hz | 75 | 3 515.6 | +4 ¢ |
| 64 | 615 Hz | 13 | 609.4 | −17 ¢ |
| 96 | 108 Hz | 2 | 93.8 | **−245 ¢** |
| 110 | 50 Hz | 1 | 46.9 | −126 ¢ |
| 120 | 29 Hz | 1 | 46.9 | **+815 ¢** |
| 127 | **20 Hz** | **1** | **46.9** | **+1475 ¢** |

**The bottom row of the image is labelled 20 Hz and shows 46.9 Hz** — an error
of a twelfth and a bit under 15 semitones. The bottom 24 rows are the *same
bin*, drawn 24 times.

---

## 4. THREE CLAIMS THAT ARE FALSE OR UNSTATED

### A · "20 Hz at the bottom" is off by 1475 cents, and the card prints it

`SpectrographCard.svelte:127` renders the literal axis note
`20 Hz → 20 kHz · newest right`, and `docs.explanation` says
*"frequency runs up the vertical axis (20 Hz at the bottom to 20 kHz at the
top, log scale)"*. Measured (§3): the lowest frequency a 1024-point FFT at
48 kHz can resolve is **46.875 Hz**, the bottom 18.8 % of the image is that one
bin smeared, and half the image reads a bin some other row already read.

Two honest responses, and they are different PRs:
- **Say the truth.** The axis is `47 Hz → 20 kHz`, and the sub-bass end is a
  single bin. Cheap, correct, and it is a `docs` + card-string change, not a
  face change.
- **Fix the binning.** `fftSize 2048` halves `hzPerBin` to 23.4 and reaches bin 1
  at 23 Hz; averaging over each row's bin *span* (rather than nearest-bin
  picking) recovers the 436 unsampled bins at the top. Both change every pixel
  of both video outputs and the committed VRT baseline, so it is a DSP-shaped
  owner-preview PR and **must not ride in a face wave**.

⚠ Whichever is chosen, the face must not repeat the current claim. A faceplate
that reprints a measured-false axis label is worse than no faceplate.

### B · The time axis is a RENDER-RATE axis, and nothing states its span

`advance()` is called from `drawFrame()` — i.e. once per rendered frame — and
`COLUMN_INTERVAL_MS = 16` only *suppresses a second call inside one frame* (its
own comment says so: "so two drawFrame calls in one bridge tick don't
double-scroll"). It is a floor, not a rate. Columns per second = the render
rate, capped at 62.5:

| renderer | col/s | the 256-column image spans |
|---|---|---|
| 120 Hz display | 62.5 (capped) | **4.10 s** |
| 60 Hz display | 60.0 | **4.27 s** |
| 30 Hz | 30.0 | **8.53 s** |
| CI SwiftShader (measured 7.9 fps, CLAUDE.md #1214) | 7.9 | **32.41 s** |

**The same patch shows 7.6× more history on a slow renderer**, and no surface
anywhere states the span. This is CLAUDE.md's frame-vs-milliseconds rule
appearing in production rather than in a test: a wall-clock gate silently
becomes a different picture on every machine.

### C · GAIN has ±12.04 dB against an 80 dB window

`gain` spans 0.25 .. 4 = **−12.04 … +12.04 dB = 24.08 dB of authority**, against
a display window of `DB_LO −90 … DB_HI −10` = **80 dB**. So the knob can shift
the image by **30.1 % of the ramp**, ±12.04 dB from centre. Measured colour-ramp
positions for a −60 dBFS partial:

| gain | shift | lands at | ramp position |
|---|---|---|---|
| ×0.25 | −12.04 dB | −72.0 dBFS | 22.4 % |
| ×0.5 | −6.02 dB | −66.0 dBFS | 30.0 % |
| ×1 | 0 dB | −60.0 dBFS | 37.5 % |
| ×2 | +6.02 dB | −54.0 dBFS | 45.0 % |
| ×4 | +12.04 dB | −48.0 dBFS | 52.6 % |

The docs promise it *"boosts a quiet source up into the −90..−10 dB display
window"*. Measured: a source at −90 dBFS is clamped to ramp 0 at every setting,
and full boost only reaches −77.96 dBFS = **ramp 15.1 %** — still the darkest
sixth of the heat ramp. The claim over-promises by roughly a factor of three in
window coverage.

*(A fourth fact, not a false claim but worth a readout: `smoothingTimeConstant
0.4` means one image column is not one FFT frame. Step response by frame:
60.0 % / 84.0 % / 93.6 % / 97.4 % / 99.0 % — a transient takes about three
columns to reach full brightness.)*

---

## 5. THE FACE

```ts
face: {
  title: 'Sonogram',
  hint:
    'One FFT plane, two colormaps. Frequency up the log axis, time scrolling ' +
    'left to right — and the time axis is a FRAME axis, so its span depends on ' +
    'what is drawing it.',

  order: [
    'gain',                       // 1 — the only param
    'spectrograph-view-{n}',      // 2 — the PICTURE (panel; dock-only by lint rule)
  ],

  pages: [
    { id: 'image', label: 'the image',
      hint: 'GAIN trims the input into the −90…−10 dBFS ramp — 24 dB of authority over an 80 dB window',
      controls: ['spectrograph-view-{n}', 'gain'] },
  ],

  // ⚠ NO GLYPH. `glyph: 'scope'` would resolve to {kind:'static'} — a fixed
  // synthetic trace — because glyphBinding needs an AUDIO-typed output and both
  // of this module's outputs are mono-video. A face that painted it would be
  // painting a picture of nothing beside a module whose whole job is a picture.
  glyph: 'none',

  hero: {
    cell: 'spectrograph-view-{n}',
    control: 'gain',
    readouts: [
      { label: 'span',  valueId: 'spectrograph-span' },
      { label: 'floor', valueId: 'spectrograph-floor' },
      { label: 'trim',  valueId: 'spectrograph-trim' },
    ],
  },

  sidebar: [
    { kind: 'readouts', label: 'the plane', entries: [
      { label: 'fft',      text: '1024 pt · 46.9 Hz per bin' },
      { label: 'rows',     text: '128 over 76 distinct bins' },
      { label: 'sub-bass', text: 'the bottom 24 rows are ONE bin' },
      { label: 'window',   text: '−90 … −10 dBFS' },
      { label: 'smoothing',text: '0.4 — a transient takes ~3 columns' },
    ] },
    { kind: 'readouts', label: 'both outputs', entries: [
      { label: 'COLOR', text: 'heat ramp · silent = dark blue rgb(0,0,80)' },
      { label: 'B/W',   text: 'inverted · silent = WHITE' },
      { label: 'same plane', text: 'one FFT, one scroll buffer, two colormaps' },
    ] },
  ],
}
```

**Cell arithmetic:** 1 param + 1 family = **2 cells**. `heroFacePlan` promotes
both out of the single band, which would empty it — so the `pages` count the
VRT scene asserts is **`{ type: 'spectrograph', pages: 0 }`**, and that needs
checking against `heroFacePlan`'s emptied-band drop before the row is written.
If an empty band is not representable, keep `gain` in the band and promote only
the picture (`hero.cell`, no `hero.control`), giving `pages: 1`. **Verify which,
in a browser, before authoring the roster row** — this is the one structural
detail a 2-cell face can get wrong.

**No `paramCells`, no `momentary`, no `rear`.** Three ports; the derivation is
already right. No switch-shaped params, so no `ACKNOWLEDGED_LATCHING` entries.

⚠ **The card's COLOR / B/W preview toggle is component state, not a param and
not `node.data`** (`SpectrographCard.svelte:32`, `let viewBw = $state(false)`).
It must stay that way in the shared surface — a private view setting must not
ride the Y.Doc and re-flip every collaborator's screen (`ShellPanelProbe`'s own
`text`-effect rationale, `shell-cells.ts:236-247`). Which makes it the natural
probe: click the toggle, assert a *different* element's text changed.

---

## 6. DERIVED READOUTS

`FaceReadoutValue = (read: (paramId) => number | undefined) => string`
(`face-readout-values.ts:149`) — params only. Two of the three below are pure
functions of `gain`; the third is a constant-shaped honesty statement.

### A. `spectrograph-trim` — the knob in the unit the window is in

`gain` is a linear multiplier on a log fader; the display window is in dB. Prints
`×2.00 · +6.02 dB · 7.5 % of the ramp`. **NEGATIVE CONTROL:** it must be exactly
`20·log10(gain)` — perturb `gain` 1 → 4 and the dB figure must move by 12.04, not
by the fader fraction (the log taper makes those two very different numbers, and
echoing the fraction is the failure mode).

### B. `spectrograph-floor` — the frequency the bottom of the picture really is

Constant at the shipped `fftSize`: `47 Hz · the bottom 24 rows are one bin`.
It is a readout rather than prose because **it changes if anyone edits
`fftSize`**, and a readout derived from the constant goes stale loudly where a
sentence goes stale silently. Compute it as
`sampleRate / fftSize` and the duplicate-row count from the real
`writeSpectrumColumn`, in a `spectrograph-face-model.ts` re-derived on every run.

**NEGATIVE CONTROL — `gain`:** must not move it (the bin grid is independent of
level). **SECOND LEG:** feed the model `fftSize 2048` and the printed floor must
halve to 23 Hz and the duplicate count must drop — otherwise the readout is a
hard-coded string wearing a function's clothes.

### C. `spectrograph-span` — the readout that is the module's real problem

The image's time span. **This one cannot be derived from params** — it is
`SPEC_W ÷ (the rate `drawFrame` is being called at)`, i.e. §4-B. Two options,
and the spec recommends the second:

1. **Measure it in the panel.** The surface component owns an rAF loop already;
   it can count its own advances and print `4.3 s` / `32 s`. That is a *live*
   number and therefore correct — and it makes the panel's own state, not
   `node.params`, the source, which is why it belongs in the picture's caption
   rather than in the `valueId` registry.
2. **State the mechanism instead.** `256 columns · one per frame` as a fixed
   `text` readout. Honest, static, VRT-deterministic, and it teaches the thing
   that actually surprises people.

⚠ **Option 1 is a VRT hazard and option 2 is not.** A live span readout makes
the dock baseline a race against boot latency — the exact reason `clouds`'
hero panel deliberately has no clock (`strict-faces.ts`: *"anything derived from
`AudioContext.currentTime` would make the VRT baseline a race against boot
latency"*). **Take option 2 for the hero readout and put option 1 in the
panel's caption behind the same freeze the rest of the roster uses.**

---

## 7. THE PICTURE — and the precondition restated

**`spectrograph-view-{n}`, a `ShellPanelCell` mounting the SAME renderer the
card mounts.** The port is mechanical and the precedent is exact:

- extract `SpectrographCard.svelte`'s canvas + rAF + `getVideoSource(...).drawFrame`
  pull (`:42-88`) into `spectrograph/SpectrographSurface.svelte`;
- the card mounts it; the hero panel mounts it; **there is one renderer.**

**What it must NOT be:** a second, simpler drawing of the same buffer. cube's
entry says why in one line — *"a hero that reduced it to a 2-D silhouette would
be a second, weaker renderer to keep in step with the DSP"* — and here the
temptation is stronger, because a static bar-graph of the current FFT would look
fine and would silently stop being a *sonogram*.

**Probe** (`ShellPanelProbe`, required): `testid: 'spectrograph-view'`,
`action: 'click'`, `effect: { kind: 'text', testid: 'spectrograph-view-mode', expect: 'changed' }`
— the COLOR/BW toggle driving a caption that names the current colormap. Two
different testids, which `shell-cells.test.ts` requires so a control that only
relabels itself cannot pass. `data-rev` is not available (nothing here touches
`node.data`) and would be the weak form anyway.

### The VRT consequence, and it is the one thing that could go wrong

The existing `vrt.spec.ts/spectrograph.png` is deterministic **by accident of
silence**: measured, an unpatched analyser reads the `minDecibels` floor,
`normDb(−100) = −0.125` clamps to 0, and every pixel is `rgb(0,0,80)` for COLOR
/ `rgb(255,255,255)` for B/W. A uniform field. That is why the card carries no
`VRT_MODULE_MASKS` entry and no `vrt-live-surfaces` companion today.

The new `face-spectrograph-{compact,dock}` scenes inherit that property **only
while the graph is silent**, which `#1420`'s `freezeAudioContext` in
`_shell-faces.ts` guarantees. So the two new baselines should be
pixel-deterministic with no mask — but **a uniform field is also what a DEAD
panel renders**, so the scene needs a companion assertion that the surface is
alive, not merely uniform. The cheapest honest one: assert the panel's
colormap caption and its canvas dimensions, and let `faces-parity`'s probe
carry operability.

---

## 8. ALREADY-WRONG

- **A · the printed axis is wrong at the bottom by 1475 cents** (§3, §4-A), on
  the card and in `docs.explanation`. Fix the string, or fix the binning; the
  two are different PRs and the second is owner-preview.
- **B · half the image is duplicated bins and 85.2 % of the spectrum is never
  sampled** (§3). Nearest-bin picking without averaging. A DSP-shaped change.
- **C · the time axis varies 7.6× by renderer and is unlabelled** (§4-B).
- **D · `gain`'s docs over-promise its window coverage by ~3×** (§4-C).
- **E · `frozenSpectrum` is a MODULE-LEVEL `let`** (`spectrograph.ts:71`),
  memoised on `binCount` alone and therefore **shared across every spectrograph
  instance in the rack**. Only reachable under `__spectrographVrtFreeze`, so it
  is a test-seam bug rather than a production one — but two instances in one VRT
  scene would share a buffer, which is exactly what a face scene with a lane
  tile *and* a dock could produce.
- **F · there is no CV input for `gain`** and no `accepts` widening on `in`. Both
  may be deliberate; neither is stated.
- **G · spectrograph is not in `card-range-source.test.ts`** and the card
  re-types `min={0.25} max={4} defaultValue={1} curve="log"` as literals
  (`SpectrographCard.svelte:117-121`) while never importing the def. One param,
  so the exposure is small — but it is the one class of divergence no runtime
  gate can see, and the card is being edited anyway for the surface extraction.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+1 line** for the `spectrograph-view` panel family. `face` is contract-transparent. |
| **shared registries** | `strict-faces.ts`, `_shell-faces.ts` (one row — **verify the `pages` count in a browser**, §5), `shell-cells.ts` (panel + probe), `face-readout-values.ts` (2–3 `valueId`s), `card-range-source.test.ts` (§8-G). No `ACKNOWLEDGED_LATCHING` entries. |
| **VRT** | +`face-spectrograph-{compact,dock}` = **2 baselines**, linux-authored. The existing `vrt.spec.ts/spectrograph.png` is in the **informational** lane (not `STRICT_VRT_MODULES`), so a card edit does not move a required gate — but extracting the surface WILL move that baseline and it should be reviewed as a changeset-gallery diff. |
| **e2e** | +1 `faces-parity` row at **2 cells** → derived budget 30 000 + 600×2 = **31.2 s** (45 000 + 3 600 = 48.6 s under `SLOW_RENDER`). Essentially the fixed cost of any face. Well under the ~2 min flag. |
| **ART** | none — spectrograph has no ART scenario and no audio output to profile. |
| **the risk** | Entirely in the renderer port. If the surface component is not shared, the module goes dark the day it is promoted, and the blank reads as intentional. |
| **the bottom line** | The single knob is irrelevant to this face. What is relevant is that under `?shell=1` the lane preview is **already gone**, that the shell glyph is structurally unable to replace it, and that three of the module's printed claims are measurably wrong. Promote it as a picture-and-readouts face or not at all — there is no useful middle. |
