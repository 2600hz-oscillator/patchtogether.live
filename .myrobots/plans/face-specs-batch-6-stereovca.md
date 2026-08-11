# FACE SPEC — `stereovca` (batch 6)

## 0. STATUS

**Authored 2026-08-11. Every number below was MEASURED against the shipping
worklet** (`packages/dsp/src/stereovca.ts`), pumped through `process()` in
128-sample blocks at 48 kHz through the repo's own ART capture path. Nothing
here is implemented; no def, card or DSP file is touched.

**Determinism control:** two identical renders are **bit-equal** on both outputs
(`out_l`, `out_r`). The DSP is a five-line per-sample multiply with no state at
all, so this is expected — and it is still printed, because a determinism
control you skip because "it obviously will be" is not a control.

**Verdict: PROMOTE — the module clears the bar on merit, and the argument
against it ("only two params") is the same one that would have rejected `vca`,
which is in `STRICT_FACES`. But it is SEQUENCED BEHIND THE SAME PLATFORM GAP as
`wavetableVco`.**

⚠ **THE SEQUENCING, first.** `StereovcaCard.svelte` renders both params with
`<Fader>`, and **`'fader'` is not a `ParamCellKind` on `main`** —
`shell-control-kind.ts:33-41` is exactly `knob | momentary | toggle | segmented
| selector | grid | color`, and `paramCellKind()` returns `'knob'` for both
(neither is switch-shaped, neither declares `options`, neither is `momentary`).
Promoting today converts two faders into two dials. On a **two-control module**
that substitution is 100 % of the control surface, which is why it is stated
before anything else. See §5 constraint 1.

**The headline: at spawn, with audio patched, this module is BIT-ZERO — and
`LEVEL`, its rank-1-looking control, is bit-exactly inert over its ENTIRE
travel.** Measured: `out_l` peak `0.0000`, `out_r` peak `0.0000`, and
`maxAbsDiff` between `level = 0` and `level = 1` is `0.000e+0` at every value
tested. The enabler is `OFFSET`, which ships at 0. The def declares `level`
first and the card draws it on the left; **this face inverts both.**

archetype: **the two-channel multiply — a VCA, a ring modulator and a mute,
chosen by a signal you cannot see and a knob nobody turns.**

Not in `STRICT_FACES`; no `face:` block. **In `STRICT_DOCS`**
(`strict-docs.ts:143`). **In `STRICT_VRT_MODULES`** (`vrt-exemptions.ts:1061`) —
its card baseline is in the REQUIRED gate. Not in `PUSH_CARD_CONTROLS`.
**2 params, 4 in, 2 out**; `size: '1u'`, `hp: 1` — the canonical 1u reference
tile. contract-lock block = **9 lines**, the smallest in the batch. Two ART
scenarios exist (`profile`, `ring-mod-spectrum`).

---

## 1. EVERY PARAM AND PORT

### Params (2) — both `<Fader>` on the card (see §5 constraint 1)

| id | label | range | curve | default | units | measured authority `max\|Δ\|`, strength UNPATCHED | …with strength = +1 |
|---|---|---|---|---|---|---|---|
| `level` | Level | 0 .. 1 | linear | **1.0** | — | **0.000e+0** | 8.000e-1 |
| `offset` | Offset | **−1 .. 1** | linear | **0.0** | — | 8.000e-1 | 8.000e-1 |

The card's literal ranges **agree with the def** on both (`min={0} max={1}` and
`min={-1} max={1}`) — unlike `wavetableVco` in the same batch. It still re-types
them, and `stereovca` is not in `RANGE_BOUND_CARDS`, so nothing is watching.

### Ports (4 in, 2 out)

| dir | id | type | notes |
|---|---|---|---|
| in | `in_l` | audio | left carrier |
| in | `in_r` | audio | **normalled from `in_l`** when unpatched (Web Audio reports an unconnected input as a zero-length outer array; `inR = inRRaw ?? inLBuf`) |
| in | `strength_l` | **cv, no `cvScale`** | raw bipolar, consumed directly in the multiply with **no scaling** — listed in `PASSTHROUGH_BY_DESIGN` (`cv-scale-registry.test.ts`) |
| in | `strength_r` | cv, no `cvScale` | **normalled from `strength_l`** when unpatched — independently of the audio pair |
| out | `out_l` | audio | `in_l × (strength_l + offset) × level` |
| out | `out_r` | audio | `in_r × (strength_r + offset) × level` |

Both outputs are `type: 'audio'`, so `glyph` binds to a real analyser tap rather
than the canned `{kind:'static'}` fallback. ⚠ The def does **not** declare
`stereoPairs`, though `out_l`/`out_r` match the `_l`/`_r` stem convention
`markStereoPairs` reads — worth a look, but out of scope for a face PR.

---

## 2. AT SPAWN — THE MODULE IS SILENT, AND ONE OF ITS TWO CONTROLS CANNOT CHANGE THAT

*Measured*, C4 saw at −1.9 dBFS (peak 0.8) into `in_l`, everything else
unpatched, factory defaults (`level 1.0`, `offset 0.0`), 0.5 s:

```
out_l  peak 0.0000   rms −240.00 dBFS   all-zero: TRUE
out_r  peak 0.0000                      all-zero: TRUE
```

### 2-A. LEVEL over its FULL travel, in that state

| `level` | out peak | `maxAbsDiff` vs `level = 1` | bit-equal |
|---|---|---|---|
| 0 | 0.0000 | **0.000e+0** | **true** |
| 0.001 | 0.0000 | **0.000e+0** | **true** |
| 0.25 | 0.0000 | **0.000e+0** | **true** |
| 0.5 | 0.0000 | **0.000e+0** | **true** |
| 0.75 | 0.0000 | **0.000e+0** | **true** |
| 0.999 | 0.0000 | **0.000e+0** | **true** |
| 1 | 0.0000 | — | — |

⚠ **This plateau is NOT quantisation, and the distinction is the one CLAUDE.md
insists on.** There is no "plateau width against a resolution floor" to report,
because the DSP computes `xL * (stL + off) * lv` and with `stL = 0` and
`off = 0` the product is *identically* zero for every value of `lv`. It is a
multiplicative annihilator, not a step size. The honest report is: **the plateau
is the entire dial, and it is exact by construction.**

### 2-B. The instrument, negative-controlled

The SAME metric, with `offset` lifted to 0.5:

| patch | `maxAbsDiff` vs `level = 1` | out peak |
|---|---|---|
| offset 0.5, level 0 | **4.000e-1** | 0.0000 |
| offset 0.5, level 0.5 | **2.000e-1** | 0.2000 |
| offset 0.5, level 1 | 0.000e+0 | 0.4000 |

The metric moves as soon as the enabler opens, so §2-A is a property of the DSP
and not of the probe.

### 2-C. The test suite already knows, and says so in a comment nobody sees

`per-module-per-port-behavioral.spec.ts:876-880`:

> *"stereovca: out = in \* (strength + offset) \* level. With offset=0 +
> unconnected strength, output is silent. offset=1 means unconnected strength
> still passes at unity…"* — `stereovca: { offset: 1, level: 0.8 }`

The behavioral harness **must** open OFFSET to get any coverage at all. That is
the same sentence a new user needs, written down in a file they will never open.
Compare `vca`, three entries above it in the same map: `vca: { base: 1 }`, with
the same comment — and `vca` earned a face partly to say it
(`formatVcaBase` prints `CLOSED`, `vca-gain-model`).

---

## 3. WHAT OFFSET ACTUALLY IS

### 3-A. It is exactly linear, and it INVERTS below zero

*Measured*, strength unpatched (so `out = in × offset × level`), input peak 0.8:

| `offset` | out peak | rms | polarity vs input |
|---|---|---|---|
| −1 | 0.8000 | −6.72 dB | **INVERTED** |
| −0.5 | 0.4000 | −12.74 dB | INVERTED |
| −0.25 | 0.2000 | −18.76 dB | INVERTED |
| **0** | **0.0000** | −240.00 dB | **silent** |
| +0.25 | 0.2000 | −18.76 dB | in phase |
| +0.5 | 0.4000 | −12.74 dB | in phase |
| +1 | 0.8000 | −6.72 dB | in phase |

Peak is `0.8 × |offset| × level` to four digits. **Half the dial is a phase
inverter and the centre is a mute**, and a fader printing `0.00` says none of it.

### 3-B. The gain is UNCLAMPED — up to ×2.0

*Measured*, input peak 0.8:

| strength | offset | level | out peak | gain | past full scale? |
|---|---|---|---|---|---|
| +1 | 0 | 1 | 0.8000 | 1.000 | no |
| +1 | +0.5 | 1 | 1.2000 | 1.500 | **yes** |
| +1 | +1 | 1 | **1.6000** | **2.000** | **yes** |
| +1 | +1 | 0.5 | 0.8000 | 1.000 | no |
| −1 | −1 | 1 | 1.6000 | 2.000 | **yes** |
| +0.5 | +1 | 1 | 1.2000 | 1.500 | **yes** |
| +1 | −1 | 1 | **0.0000** | 0.000 | exact mute |

`gain = strength + offset`, with no clamp anywhere and nothing downstream to
limit it. Two consequences the panel cannot state: **the offset that mutes a
given strength is exactly `−strength`**, and **OFFSET at +1 with a full-scale
modulator is +6.0 dB of peak gain**.

### 3-C. THE STRUCTURAL FACT: you cannot get 0..unity from OFFSET alone

With a full-scale bipolar modulator, `gain ∈ [offset − 1, offset + 1]`. Two
things a patcher wants:

- **never inverts** → needs `offset ≥ 1`
- **never exceeds unity** → needs `offset ≤ 0`

**They intersect nowhere.** `offset = 0` gives `−1 … +1` (inverts twice per LFO
cycle); `offset = 1` gives `0 … +2` (+6 dB peaks). The unipolar-unity VCA — the
thing most people reach for this module to be — is **`offset = 1` AND
`level = 0.5`**, giving `gain = (s + 1)/2 ∈ [0, 1]`. Verified in §3-B row 4:
peak 0.8000 from a 0.8 input, exactly unity.

**That is the single most useful sentence this faceplate can say, and it is a
statement about two knobs at once, which is precisely what a knob readback
cannot be.**

### 3-D. Measured: what a slow LFO through STRENGTH actually does

2 Hz sine into `strength_l`, C4 sine carrier, 2 s:

| `offset` | gain sign flips in 2 s | peak | rms |
|---|---|---|---|
| 0 | **7** | 0.8000 | −7.96 dB |
| 0.5 | 8 | **1.2000** | −6.20 dB |
| 1 | **0** | **1.5999** | −3.19 dB |

At the shipped default a "tremolo" patch **phase-inverts the audio twice per LFO
cycle**. That is not a subtle artefact; it is what makes an LFO-into-VCA patch
sound wrong to a beginner, and OFFSET is the fix nobody knows to reach for.

---

## 4. VCA vs RING MOD — AND AN INSTRUMENT THAT LIED

### 4-A. The measurement that was wrong

Round 1 measured "carrier suppression vs modulator rate" over a 0.5 s window and
read `3.24e-1` of carrier at 0.5 Hz against `2.17e-5` at 2 Hz, and concluded
*"the carrier nulls as the modulator becomes audio-rate — that is the ring-mod
signature."* **That was a WINDOW artifact.** Half a cycle of a 0.5 Hz sine in a
0.5 s window is not zero-mean, so the Goertzel saw a DC component that does not
exist in the signal.

Re-measured over an integer number of **both** the modulator's and the carrier's
cycles (2.0 s):

| modulator | carrier @261.6 | sidebands | suppression |
|---|---|---|---|
| 0.5 Hz | 2.327e-7 | 4.000e-1 | **−124.71 dB** |
| 1 Hz | 4.652e-7 | 4.000e-1 | −118.69 dB |
| 5 Hz | 2.326e-6 | 4.000e-1 | −104.71 dB |
| 20 Hz | 9.317e-6 | 4.000e-1 | −92.66 dB |
| 100 Hz | 4.828e-5 | 4.000e-1 | −78.37 dB |
| 400 Hz | 4.476e-4 | 4.000e-1 | −59.02 dB |

**Carrier suppression is a property of the modulator being ZERO-MEAN, at every
rate.** The residual grows with rate only because the window-truncation error
does. So the def's central claim — *"the behavior is purely a function of how
fast the control signal is"* — is true **perceptually** and has **no spectral
signature at all**. A face that tried to print "VCA / RING MOD" from a spectral
measure would be printing noise. It cannot be derived from params either (the
modulator is a cable). **This face does not claim to know which mode you are
in**, and that is a deliberate refusal.

### 4-B. What CAN be derived: OFFSET is the ring-mod ↔ AM continuum

*Measured*, 400 Hz modulator, C4 carrier, 0.5 s:

| `offset` | carrier magnitude | sidebands | carrier suppression |
|---|---|---|---|
| 0 | 1.046e-3 | 2.538e-1 | **−47.70 dB** (true ring mod) |
| 0.1 | 5.187e-2 | 2.544e-1 | −13.81 dB |
| 0.25 | 1.282e-1 | 2.552e-1 | −5.98 dB |
| 0.5 | 2.555e-1 | 2.565e-1 | **−0.03 dB** (100 % AM) |
| 1 | 5.101e-1 | 2.591e-1 | **+5.88 dB** (carrier-dominant AM) |

Clean, monotonic, and a pure function of one param. **OFFSET is not "a DC
offset" — it is the balance between a ring modulator and an amplitude
modulator**, and it happens to also be the enabler and the mute. Three jobs on
one fader labelled `Offset`.

---

## 5. TWO MORE MEASURED FACTS

### A. The CV path is SAMPLE-EXACT — and the KNOBS are not smoothed at all

Measured on a DC carrier (so `out[i]` *is* the gain — a saw carrier cannot
resolve faster than one period, which is how round 1 reported 3.521 ms for a
1 ms ramp):

```
strength STEP 0 -> 1 at sample 9600:
  out[9599] = 0     out[9600] = 1     out[9601] = 1
```

**Sample-exact. No de-zip, no one-pole.** That is a *virtue* and worth saying:
`vca` shipped a 7 Hz smoother on the whole sum until #1313 and turned every
1 ms ADSR attack into a 49.79 ms one. `stereovca` never had it and passes a
percussive envelope intact.

**The knobs have no smoothing either, and that is a hazard.** An a-rate step
schedule on each param, DC carrier:

| param | out[9599] | out[9600] | jump |
|---|---|---|---|
| `level` 1 → 0.2 | 1.0000 | 0.2000 | **0.8000 in ONE sample** |
| `offset` 0 → 0.8 | 0.0000 | 0.8000 | **0.8000 in ONE sample** |

`vca`'s fix put `si.smoo` on its two KNOBS while leaving the CV path at full
bandwidth (`vca.ts` header, #1313 / `290dcdb5`). `stereovca` has the second half
and not the first: dragging either fader steps the gain discontinuously. Not a
face fix — flagged in §8.

### B. The normalling is ONE-DIRECTIONAL, and patching the RIGHT side alone silences the LEFT

*Measured*, input peaks 0.8, `strength_l` = 0.5, `strength_r` = 1.0:

| patch | `out_l` peak | `out_r` peak | L ≡ R |
|---|---|---|---|
| `in_l` only, `strength_l` only | 0.4000 | 0.4000 | **true** |
| `in_l` + `in_r`, `strength_l` only | 0.4000 | 0.4000 | false |
| `in_l` only, both strengths | 0.4000 | 0.8000 | false |
| both + both | 0.4000 | 0.8000 | false |
| **`in_r` only (`in_l` UNPATCHED)** | **0.0000** | 0.4000 | false |
| **`strength_r` only (`strength_l` UNPATCHED)** | **0.0000** | 0.8000 | false |

The two rules are genuinely independent (rows 2 and 3 prove each works without
the other), exactly as the def claims. But **there is no reverse normal**:
patching only the right-hand jack of either pair leaves the left channel silent.
A user who cables `IN R` because it was nearer gets one channel and no
explanation.

---

## 6. DOES IT MERIT A FACE? — THE ARGUMENT, BOTH WAYS

**Against.** Two params. Nine contract-lock lines, the smallest in the batch. A
1u tile. The whole DSP is one line of arithmetic. The `noise` precedent ("NO
FACE ON MERIT") exists for exactly this shape, and a face costs 2 VRT baselines,
a `faces-parity` row and a permanent `*-face-model.test.ts`.

**For, and it wins.**

1. **`vca` is in `STRICT_FACES` with the same two-param shape** and earned it on
   *vocabulary*, not on count: `formatVcaBase` prints `CLOSED / dB / UNITY` and
   `formatVcaCvAmount` prints `OPEN / CV OFF / DUCK`, because — the def's own
   words — *"a linear gain number is the one thing that does not say how loud it
   is."* `stereovca` has strictly **more** to say than `vca`: the same
   closed-at-spawn problem (§2), **plus** an unclamped ×2 gain (§3-B), **plus**
   the offset/level intersection that is the module's real answer (§3-C),
   **plus** two independent normalling rules (§5-B), **plus** the ring-mod↔AM
   continuum (§4-B). Five sentences against `vca`'s two.
2. **The count argument is backwards at the LANE tiers.** With 2 params, `dock`,
   `full` (cap 6) and `compact` (cap 2 with a glyph) all show the **entire
   module**. Only `mini` (cap 1) shows a subset — and it shows `OFFSET`, the one
   that decides whether anything comes out. **Every tier of this face is
   complete or correctly-chosen**, which is a property none of the big faces can
   claim.
3. **It is the 1u reference tile** (`size: '1u'`, `hp: 1`). Whatever a 1u face
   looks like, this module defines it. That is worth getting right once.

**Verdict: PROMOTE**, behind the `fader` kind.

---

## 7. THE FACE

### Three platform constraints

1. ⚠ **BOTH params are `<Fader>` and `'fader'` is not a `ParamCellKind` on
   `main`.** `paramCellKind()` returns `'knob'` for both, so promoting today
   swaps 100 % of this module's control surface from travels to dials. On a
   two-fader utility that reads as a different module. **Hold behind the kind**;
   the `paramCells` block below is written in the form it will take and does not
   typecheck until then, which is the correct loud failure.
2. **2 params, so a panel cannot be ranked.** A panel's first legal rank is 7
   (`faceTierCap('full') = 6`; `module-face-lint`'s `panelTierProblems`), which
   two params can never reach. `hero.cell` stays unset; the picture is a sidebar
   `custom` block (meowbox precedent) and the glyph keeps painting at the dock.
3. ✅ **Both outputs are `type: 'audio'`**, so `glyph: 'meter'` binds to a real
   analyser tap. With nothing patched the output is exactly zero, so the meter
   is **unlit** at capture — the mixer/reverb precedent, deterministic under
   VRT, and honest: an unlit meter on a module that is genuinely silent is the
   correct picture.

```ts
face: {
  title: 'Stereo VCA · ring mod',
  hint:
    'out = in x (strength + offset) x level, per channel. OFFSET is the enabler, the mute, the ' +
    'phase inverter and the ring-mod/AM balance — all four. LEVEL does nothing until it opens.',

  // ⚠ THE ORDER IS THE INVERSE OF THE DEF AND OF THE CARD, and that is the
  // argument. `level` is declared first and drawn on the left, and it is
  // BIT-EXACTLY INERT over its whole travel in the state the module spawns in
  // (measured: maxAbsDiff 0.000e+0 for level 0..1). An ENABLER always ranks
  // above its dependents (the cofefve rule), so OFFSET leads.
  //
  // The property this buys: `mini` (cap 1) shows OFFSET — the control that
  // decides whether the module emits anything at all. Every other tier shows
  // both. There is no tier of this face that shows a subset that lies.
  order: ['offset', 'level'],

  // ONE band. Two params that are one idea (the gain), the way adsr and vca do
  // it. A second band would buy an ~81 px header to separate two knobs.
  pages: [
    {
      id: 'gain',
      label: 'gain',
      hint:
        'gain = strength + offset, unclamped, then x LEVEL. With a full-scale bipolar modulator ' +
        'OFFSET 0 gives -1..+1 (it INVERTS twice per cycle) and OFFSET 1 gives 0..+2 (+6 dB peaks). ' +
        'For a plain 0..unity VCA you need OFFSET 1 AND LEVEL 0.5 — no OFFSET alone does it.',
      controls: ['offset', 'level'],
    },
  ],

  // ⚠ Both are FADERS on the card; `fader` is not a ParamCellKind on main.
  // See constraint 1 — this block is the target shape, not a shippable one.
  paramCells: { offset: 'fader', level: 'fader' },

  // An INSERT with nothing patched outputs exactly zero, so the meter is unlit
  // at capture. That is the truthful picture, not a limitation.
  glyph: 'meter',

  hero: {
    control: 'offset',
    readouts: [
      { label: 'at rest',  valueId: 'svca-at-rest' },
      { label: 'gain',     valueId: 'svca-gain-window' },
      { label: 'headroom', valueId: 'svca-headroom' },
    ],
  },

  sidebar: [
    {
      kind: 'custom', label: 'gain window', panelId: 'gain-window',
      props: { offsetParam: 'offset', levelParam: 'level', strengthPorts: 'strength_l,strength_r' },
    },
    {
      kind: 'signal-flow', label: 'signal flow',
      stages: [
        { label: 'IN L', role: 'generator' },
        { label: 'IN R', role: 'generator', parallel: true, note: 'normals from IN L' },
        { label: 'STRENGTH L', role: 'bus', parallel: true, note: 'raw bipolar CV, no scaling' },
        { label: 'STRENGTH R', role: 'bus', parallel: true, note: 'normals from STRENGTH L' },
        { label: '+ OFFSET', role: 'bus', note: 'the sum IS the gain — unclamped' },
        { label: 'x LEVEL', role: 'bus', note: 'the only way back under unity' },
        { label: 'OUT L / OUT R', role: 'bus' },
      ],
    },
    {
      kind: 'readouts', label: 'normalling',
      entries: [
        // ⚠ text:, NOT valueId: — FaceReadoutValue is params-only and cannot
        // see a cable. These state the RULE; the panel above shows the live
        // state (see §8-D).
        { label: 'IN R',       text: 'mirrors IN L when unpatched' },
        { label: 'STRENGTH R', text: 'mirrors STRENGTH L when unpatched' },
        { label: 'left side',  text: 'no reverse normal — IN R alone leaves L silent' },
        { label: 'CV path',    text: 'sample-exact; a 1 ms attack survives intact' },
      ],
    },
    {
      kind: 'presets', label: 'the four patches',
      entries: [
        { id: 'vca',  label: 'VCA (0..unity)', note: 'the one OFFSET alone cannot do',
          values: { offset: 1, level: 0.5 } },
        { id: 'open', label: 'always open',    note: 'unity at rest, CV ducks it',
          values: { offset: 1, level: 1 } },
        { id: 'ring', label: 'ring mod',       note: 'carrier −47.7 dB',
          values: { offset: 0, level: 1 } },
        { id: 'am',   label: '100 % AM',       note: 'carrier back at −0.03 dB',
          values: { offset: 0.5, level: 0.7 } },
      ],
    },
  ],
}
```

⚠ **`title`, `hint` and the band `hint` paint NOTHING at rest** (the cofefve
finding). On a two-control module that leaves the three hero readouts, the
four-line normalling block, the four presets and the picture doing 100 % of the
work. Everything load-bearing above is in those four.

⚠ **The `vca (0..unity)` preset is the most valuable single thing in this
document.** It is the setting §3-C proves cannot be reached by turning either
fader alone, it is what a patcher means when they say "VCA", and it is the
setting the behavioral harness already applies by hand (`{ offset: 1,
level: 0.8 }`, §2-C) to get any coverage.

---

## 8. DERIVED READOUTS

`FaceReadoutValue` is `(read: (paramId) => number | undefined) => string` —
params only. All three below respect that; §8-D names what does not fit.

### A. `svca-at-rest` — the sentence the panel has never said

What the module does with **no strength patched**: `gain_rest = offset × level`.

```
shipped default (offset 0, level 1)  ->  "MUTED"
offset 0.5, level 1                  ->  "−6.0 dB"
offset 1,   level 1                  ->  "unity"
offset 1,   level 0.5                ->  "−6.0 dB"
offset −0.5, level 1                 ->  "−6.0 dB · INVERTED"
```

Measured exactly: peak = `0.8 × |offset| × level` to four digits across §3-A.

- **NEGATIVE CONTROL — it must read `MUTED` at the shipped default while
  `LEVEL` is at its MAXIMUM.** A `paramId: 'level'` readout prints `1.00` there
  and is, in the plainest possible sense, telling the user the opposite of the
  truth. That single state is the readout's entire justification.
- **SECOND LEG — the `INVERTED` flag.** `offset` −0.5 and +0.5 measure the
  identical peak (0.4000) and rms (−12.74 dB); a level-derived readout prints
  the same string for both. The polarity was measured by correlation against the
  input, so the flag must differ. Two states that a magnitude cannot separate is
  the definition of a fact worth deriving.

### B. `svca-gain-window` — the two-knob fact

The gain range a full-scale bipolar strength produces: `[(offset − 1) × level,
(offset + 1) × level]`, plus the two flags.

```
offset 0,   level 1    ->  "−1.00 … +1.00 · INVERTS"
offset 1,   level 1    ->  "0.00 … +2.00 · +6.0 dB"
offset 1,   level 0.5  ->  "0.00 … +1.00 · unity"      <- the target
offset 0.5, level 1    ->  "−0.50 … +1.50 · INVERTS · +3.5 dB"
```

- **NEGATIVE CONTROL — `level` at the SPAWN state.** This is the deliberately
  awkward one and it is worth stating precisely: `level` is bit-exactly inert on
  the *audio* at spawn (§2-A) and it **must still move this readout**, because
  the readout is a statement about the CONTRACT (what happens when a modulator
  arrives), not about the current output. A readout derived from the live signal
  would be frozen there. Assert both halves: `level` 1 → 0.5 halves the window
  while the rendered output stays bit-identical at `0.000e+0`.
- **SECOND LEG — the `INVERTS` flag must clear at `offset ≥ 1` and only
  there.** Measured, §3-D: 7 sign flips in 2 s at offset 0, 8 at offset 0.5,
  **0** at offset 1. A flag that cleared at 0.5 would be green against a
  one-sided test and wrong about the one patch people actually make.

### C. `svca-headroom` — red above 1.0

`(1 + |offset|) × level`, the peak gain a full-scale modulator can reach.
Anchored on §3-B: 1.000 / 1.500 / **2.000** / 1.000 at the four measured
corners.

- **NEGATIVE CONTROL — the sign of `offset`.** `−1` and `+1` both reach gain
  2.000 (measured rows 3 and 5 of §3-B), so the estimate must use `|offset|`.
  An estimate that read `offset + 1` would print `0.000` for offset −1 and miss
  a ×2 clip entirely.

### D. ⚠ THREE FACTS THAT CANNOT BE `FaceReadout`s, AND WHERE THEY GO

- **"is `IN R` patched, or normalled?"** and **"is `STRENGTH R` patched?"** —
  graph edges. §5-B measured that these change which channels are alive, and
  that patching the right-hand jack alone leaves the left silent. **These go in
  the `gain-window` `custom` panel**, which *can* reach topology:
  `FilterResponsePanel.svelte:31` and `MeowboxFormantBankPanel.svelte:33` both
  `import { patch } from '$lib/graph/store'`, and `patch.edges` is a
  `Record<string, Edge>`. The `readouts` block in §7 states the RULE as fixed
  `text:`; the panel draws the LIVE state.
- **"am I a VCA or a ring modulator right now?"** — needs the strength signal's
  frequency content. Not a param, and §4-A established it has **no spectral
  signature** either. **This face deliberately does not claim to know**, and
  says so in the signal-flow note instead.

⚠ **Counting this module, that is the fourth independent request to widen
`FaceReadoutValue`** (analogVco and macrooscillator filed it; bluebox hit the
same wall from `face.momentary`; `charlottesEchos` in this same batch hits it on
its L/R normal). `engine.readParam` already returns *intrinsic + modulator tap*
(`engine.ts:737-747`); a `{ read, readLive, sampleRate }` reader would close all
four. The panel escape hatch works today and is the right move for a *picture*;
it is the wrong shape for a one-line fact, and four modules now want the
one-line fact.

---

## 9. THE PICTURE — `gain-window`, and why it earns its place on a 2-param module

A single horizontal gain axis from −2 to +2 with:

- **the unity line at +1 and the mute line at 0**, both labelled;
- **the window** `[(offset−1)·level, (offset+1)·level]` drawn as a bar, red where
  it crosses +1 and hatched where it crosses 0 into negative (inverting) gain;
- **the resting point** `offset × level` as a tick — the value §8-A prints;
- **the two normalling legs** (`IN R`, `STRENGTH R`) drawn greyed or lit off
  `patch.edges` (§8-D), so a user who patched the wrong jack sees a dark left
  channel.

That is the whole module in one shape, and it makes §3-C — the fact that no
single fader position gives 0..unity — **visible as a geometric impossibility**
rather than a sentence. On a module with two controls, a picture that shows what
the two controls can and cannot reach together is doing more work than either
control.

Per `sidebar-panels.ts`: it READS, never emits a `control-<paramId>` testid, and
must resolve def defaults for untouched params (the crossover panel's
`WIDTH 0%` bug). Registered generically so `vca` could adopt it.

---

## 10. ALREADY-WRONG

- **A · `LEVEL` is bit-exactly inert at the factory default** (§2). Not a DSP
  bug — the arithmetic is correct and the convention is standard Eurorack — but
  a legibility defect on a two-control module where it is **half the panel**.
  The face is the fix; the alternative (shipping `offset: 1, level: 0.5`) is a
  default change that alters every saved rack's sound and is an owner call.
- **B · Neither knob is de-zipped** (§5-A): a fader move steps the gain by 0.8
  in one sample. `vca` fixed exactly this in #1313 by putting `si.smoo` on its
  knobs *only*, keeping the CV path at full bandwidth. `stereovca` needs the
  same one-sided fix. **Its own PR** — it is a DSP change and it re-pins both
  ART baselines (`stereovca/{profile,ring-mod-spectrum}`).
- **C · The gain is unclamped to ×2 with nothing downstream to limit it**
  (§3-B). Documented, not fixed: clamping would break the phase-inversion and
  boost use-cases the def explicitly sells.
- **D · The normalling has no reverse direction** (§5-B) and nothing says so.
  A doc edit on the existing `in_r` / `strength_r` keys plus the panel leg.
- **E · `StereovcaCard.svelte` re-types both ranges** and `stereovca` is not in
  `RANGE_BOUND_CARDS`. Both agree today — unlike `wavetableVco` in this same
  batch, where the same pattern hides a live defect. Bind through `paramSpec()`
  and enrol it, boy-scout, in the face PR.
- **F · No `stereoPairs` declaration** despite `out_l`/`out_r` matching the
  `_l`/`_r` stem convention (§1). `charlottesEchos` declares it for its pair.
  Worth checking against `markStereoPairs` / the dual-mono ledger; a contract
  change, so its own PR.
- **G · The def's headline claim has no spectral signature** (§4-A). *"the
  behavior is purely a function of how fast the control signal is"* is true
  perceptually and measures as **−124.71 dB of carrier suppression at 0.5 Hz**
  — identical in kind to the 400 Hz case. Not wrong, but a reader who expected
  to *see* the difference cannot. Recorded because it is exactly the shape of
  claim a future gate would try to assert and could only assert falsely.

---

## 11. COST

| | |
|---|---|
| **contract-lock** | **+0 lines.** No new param, port or family; the picture is a sidebar `custom` block and `face` is out of `contract-signature.ts`. §10-F, if taken, is +1 line and its own PR. |
| **STRICT_DOCS** | already in it (`strict-docs.ts:143`). No new keys; §10-D is an edit to existing ones. |
| **ART** | **two scenarios exist** (`stereovca/{profile,ring-mod-spectrum}`). A face PR touches neither. §10-B re-pins both — keep it separate. ⚠ `ring-mod-spectrum.test.ts` drives `stereoVcaMath.render`, the pure mirror **exported from the def**, not the worklet; `profile.test.ts` drives the real processor. A def edit that touched `stereoVcaMath` would move one and not the other. |
| **VRT** | The card is in the REQUIRED `vrt-strict` set. A face PR that does not touch `StereovcaCard.svelte` moves no card baseline; §10-E's `paramSpec` binding is a pixel no-op but capture and diff it anyway. New face scenes: `face-stereovca-{compact,dock}` = **2 baselines**. ⚠ At `compact` the cap is **2 with a glyph**, so the lane tile shows both params — the tile is the whole module, which makes it the most informative compact scene in the roster and the one most worth eyeballing in the changeset gallery. |
| **e2e** | +1 `faces-parity` row, **2 cells** — the smallest face in the repo. ≈ +3 s. Its `driveCell` arm enters the `fader` branch for both once that kind lands; if this is the first such face, delete the `UNEXERCISED_BY_FACES_PARITY` entry in the same PR. |
| **Push 2** | no `PUSH_CARD_CONTROLS` entry; 2 params fit the 8-control card with no re-rank risk. None needed. |
| **BLOCKER** | **the `fader` `ParamCellKind` does not exist on `main`** (§7, constraint 1). On a two-fader module the substitution is the entire control surface. Sequence after the kind. |
| **the bottom line** | The smallest module in the batch and the one whose face says the most per control: at spawn it is silent, half its panel cannot change that, its gain reaches ×2 unclamped, and the patch everybody wants needs both knobs in positions neither knob suggests. Two params, five true sentences none of them can print. |
