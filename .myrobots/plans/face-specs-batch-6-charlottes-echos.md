# FACE SPEC — `charlottesEchos` (batch 6)

## 0. STATUS

**Authored 2026-08-11. Every number below was MEASURED against the shipping
worklet** (`packages/dsp/src/charlottes-echos.ts` + `lib/analog-delay-core.ts` +
`lib/varispeed-shifter.ts`), captured through the repo's own ART path
(`captureWorkletProcessor` / `renderWorklet`, `art/setup/worklet.ts`) at
48 kHz, 128-sample blocks. Nothing here is implemented; no def, card or DSP file
is touched.

**Determinism control:** two identical renders of every patch are **bit-equal**
(`maxAbsDiff = 0.000e+0`, L and R). The worklet has no RNG on any path
CHARLOTTE engages (`lfoAmount = 0`, `driftAmount = 0` are pinned in
`charlottes-echos.ts:163-164`, and the VarispeedShifter is RNG-free by
construction).

**Verdict: PROMOTE.** archetype: **the four-stage destructive echo — and, on the
arithmetic, a STABILITY CONTROL wearing two knobs that look like "amount".**

**The headline: this module does not stop.** Sixty milliseconds of input at
`decay 0.4 / feedback 0.5` is still ringing at a steady **−19.7 dBFS twenty
seconds later**, and at `feedback 0.9 / decay 0.2` it settles at **+3.2 dBFS rms,
peak 1.6114, forever**. The mechanism is in the source and derivable: the
in-loop `tanh` DriveStage has small-signal gain `1 + decay·(1+k)·0.8` — up to
**4.20** at stage 3 — and that multiplies the feedback inside each stage's own
loop, so `FEEDBACK_MAX = 0.995` does not bound it. The shipped default sits
**0.116 below the boundary in DECAY and 0.113 below it in FEEDBACK**. Nothing on
the card, in the docs, or in any gate says so.

Not in `STRICT_FACES`; no `face:` block. **In `STRICT_DOCS`** (`strict-docs.ts:74`).
**In `STRICT_VRT_MODULES`** (`vrt-exemptions.ts:1044`) — so its card baseline is
in the REQUIRED `vrt-strict` gate. Not in `PUSH_CARD_CONTROLS`. **5 params, 3 in,
2 out**, `stereoPairs: [['L','R']]`. contract-lock block = **12 lines**.
Three ART scenarios exist (`profile`, `single-tap`, `wet-output`).

---

## 1. EVERY PARAM AND PORT

### Params (5) — all `knob` cells; the card already uses `<Knob>` for all five

| id | label | range | curve | default | units | measured authority (max\|Δ\| over the full travel, everything else default) | rms span |
|---|---|---|---|---|---|---|---|
| `delay` | Delay | 0.001 .. 1.5 | **log** | 0.4 | **s** | 6.621e-1 | 11.59 dB |
| `feedback` | Fbk | 0 .. 1 | linear | 0.5 | — | **1.012e+0** | **25.65 dB** |
| `decay` | Decay | 0 .. 1 | linear | 0.2 | — | 6.559e-1 | 13.99 dB |
| `pitchUp` | Ptch | 0 .. 0.2 | linear | **0** | — | 7.300e-1 | 10.19 dB |
| `mix` | Mix | 0 .. 1 | linear | 0.5 | — | 4.653e-1 | 11.25 dB |

*(Authority measured with a 60 ms C4 saw burst at −4.4 dBFS into `L`, `delay`
held at 0.15 s, 1.2 s render.)*

### Ports

| dir | id | type | notes |
|---|---|---|---|
| in | `L` | audio | stage-0 input. The factory pins a silent `ConstantSource` here (`charlottes-echos.ts:104-107`) so the node stays alive — deliberately on input 0 ONLY, so the R normal survives (`mono-normal-not-defeated.test.ts`). |
| in | `R` | audio | normalled from `L` (`inputs[1]?.[0] ?? inputs[0]?.[0]`). **Verified**: mono in → `maxAbsDiff(L,R) = 0.000e+0`. |
| in | `delay` | cv, `cvScale: { mode: 'log' }`, `paramTarget: 'delay'` | sums onto the a-rate `delay` AudioParam. |
| out | `L` | audio | `dry·(1−mix) + clamp(wet, ±2)·mix` |
| out | `R` | audio | ditto, from an entirely independent cascade (§4-D) |

---

## 2. AT SPAWN

*Measured*, factory defaults, 60 ms C4 saw burst into `L`, `R` unpatched, 2 s:

```
L: peak 0.3978  rms 0.1291 (−17.78 dBFS)  dc +0.0030
R: BIT-IDENTICAL to L
first echo at 19200 samples = 0.40000 s exactly   (the knob says 0.4000)
```

The `delay` unit is honest — the 2026-08-03 stage-count fix holds across the
whole travel: measured ratio `firstEcho / delay` = **1.000** at every knob
position from 3 ms up.

---

## 3. THE FINDING — THE MODULE NEVER STOPS, AND TWO DIALS DECIDE

### 3-A. Measured: absolute rms per 2 s bucket after a single 60 ms burst

*(delay 0.15 s, mix 1, 20 s render, dBFS)*

| patch | 0–2 s | 2–4 s | 4–6 s | 8–10 s | 14–16 s | **18–20 s** | final peak |
|---|---|---|---|---|---|---|---|
| decay 0, fb 0.5 | −10.3 | −234.0 | −240.0 | −240.0 | −240.0 | **−240.0** | 0.0000 |
| **decay 0.2, fb 0.5 (SHIPPED)** | −13.2 | −82.1 | −178.6 | −240.0 | −240.0 | **−240.0** | 1.6e−42 |
| decay 0.4, fb 0.5 | −13.3 | −18.6 | −20.1 | −19.7 | −19.7 | **−19.7** | 0.1346 |
| decay 0.6, fb 0.5 | −16.8 | −17.7 | −17.2 | −17.2 | −17.2 | **−17.2** | 0.1605 |
| decay 1.0, fb 0.5 | −32.3 | −31.0 | −31.0 | −31.0 | −30.9 | **−31.0** | 0.0376 |
| decay 0.2, fb 0.9 | +2.8 | +3.2 | +3.2 | +3.2 | +3.2 | **+3.2** | **1.6114** |
| decay 1.0, **fb 0** | −72.2 | −240.0 | −240.0 | −240.0 | −240.0 | **−240.0** | 0.0000 |

**Both negative controls are in that table and they run in opposite
directions.** `decay 0 / fb 0.5` dies (so it is not the forward path);
`decay 1 / fb 0` dies (so it is not the drive alone). It is the drive
*inside* the feedback loop, exactly as the source says.

### 3-B. The law, and a POSITIVE control on it

From `charlottes-echos.ts:196` (`s.driveGain = decay * (1 + k) * 0.8`) and
`analog-delay-core.ts:290-291` (`drive = 1 + s.driveGain`, `tanh(y·drive)`,
whose small-signal gain is `drive`), plus `FEEDBACK_MAX = 0.995`:

```
per-stage loop gain    g_k = feedback · 0.995 · (1 + decay·(1+k)·0.8)
sustains when          max_k g_k ≳ 1                (k = 3 is always the largest)
```

| decay | drive small-signal gain, stages 0/1/2/3 | wetVolume, stages 0/1/2/3 |
|---|---|---|
| 0 | 1.00 / 1.00 / 1.00 / 1.00 | 1.000 / 1.000 / 1.000 / 1.000 |
| 0.2 | 1.16 / 1.32 / 1.48 / **1.64** | 1.000 / 0.880 / 0.774 / 0.681 |
| 0.4 | 1.32 / 1.64 / 1.96 / **2.28** | 1.000 / 0.760 / 0.578 / 0.439 |
| 1.0 | 1.80 / 2.60 / 3.40 / **4.20** | 1.000 / 0.400 / 0.160 / 0.064 |

**Measured boundary vs predicted** (bisection on "is the last 2 s of a 12 s
render above −100 dBFS", 22 iterations):

| fixed | measured boundary | predicted | loop gain at the measured point |
|---|---|---|---|
| fb 0.40 | decay **0.4577** | 0.4727 | 0.981 |
| fb 0.50 | decay **0.2977** | 0.3156 | 0.972 |
| fb 0.70 | decay **0.1190** | 0.1362 | 0.962 |
| fb 0.90 | decay **0.0122** | 0.0365 | 0.931 |
| decay 0 | fb **0.9192** | *"never"* | 0.915 |
| decay 0.1 | fb **0.7308** | 0.7614 | 0.960 |
| decay 0.2 | fb **0.5926** | 0.6128 | 0.967 |
| decay 0.5 | fb **0.3807** | 0.3865 | 0.985 |
| decay 1.0 | fb **0.2554** | 0.2393 | 1.068 |

The law predicts within **≈0.02** of the knob everywhere, and the measured
boundary consistently sits at a loop gain of **0.93–0.99** rather than exactly
1 — there is ~3–7 % of additional in-loop gain the linearised drive term does
not account for (the Catmull-Rom read, the eased pointer, the tone filter's
passband). ⚠ **The `decay = 0` row is the one that matters for how the face
states this:** with the drive at an exact bypass the law says "never sustains",
and the module still sustains from `fb 0.9192`. **So the law is a LOWER BOUND
on danger, never a safety certificate**, and a readout must be anchored on the
measured surface, not on the formula alone.

**The shipped default (`decay 0.2, feedback 0.5`) has a stage-3 loop gain of
0.8159** — margin **0.116** in DECAY, **0.113** in FEEDBACK. Two small nudges of
two dials that look like taste controls and the module is a drone.

⚠ **AND THE BOUNDARY HAS A THIRD INPUT: `delay`.** The spec's first draft
asserted the boundary was delay-independent — the loop-gain expression contains
no delay term, so it *looked* obvious. **Measured, it is false.** Bisecting the
decay boundary at `fb 0.5` for three delays:

| `delay` | boundary `decay` | tail at the shipped `decay 0.2` |
|---|---|---|
| 0.02 s | **0.3184** | 0.25 s |
| 0.15 s | **0.2977** | 1.85 s |
| 0.60 s | **0.2079** | 7.60 s |

**0.11 of DECAY across the delay travel**, and the tail length moves 30×. The
tone filter and the eased read pointer are per-*sample* losses, so a longer tape
means fewer round trips per second and less loss per unit time. This was caught
only because the claim was measured before it was written down; it is recorded
here because it is the difference between a readout that is right and one that
is confidently wrong in the direction of "you are safe".

### 3-C. …and it clips on the way

*Measured*, sustained C4 saw at −4.4 dBFS, delay 0.15 s, 1.5 s render, fraction
of samples past full scale at the OUTPUT:

| patch | peak | rms | samples > 1.0 |
|---|---|---|---|
| **shipped default** | 0.7046 | −11.55 dB | **0.00 %** |
| DECAY to 0 | 1.2208 | −7.45 dB | 1.35 % |
| FEEDBACK to 0.9 | 1.1738 | −4.77 dB | 2.80 % |
| both | 1.3000 | −0.45 dB | **42.82 %** |
| both + MIX 1 | **2.0000** | +5.39 dB | **87.58 %** |

2.0000 is not a coincidence: it is `Math.max(-2, Math.min(2, sigL))` at
`charlottes-echos.ts:221`. At the last row the internal clamp is the waveform —
**87.58 % of samples are pinned to the rail**. Fraction of samples at `|x| ≥ 2`
on the wet path alone: 0.14 % at `decay 0 / fb 0.5`, **80.20 % at
`decay 0 / fb 0.9`**.

**And it does NOT self-oscillate from nothing** — `feedback 1`, no input, 3 s:
peak `0.0000`, rms −240 dB. It needs a seed; once seeded it keeps it.

---

## 4. FOUR MORE MEASURED FACTS

### A. The bottom 9.48 % of the DELAY dial is bit-exactly dead

`AnalogDelayCore` clamps each stage at 0.5 ms (`analog-delay-core.ts:456`) and
CHARLOTTE runs each stage at `delay / 4`, so the cascade floors at **2.000 ms**.
The def's `min` is 0.001 s.

Bisected against `delay = 0.001` (1 ms click, mix 1, 0.3 s render, 40
iterations): **bit-identical up to `delay = 0.002000000` s exactly.**

- plateau WIDTH: **1.000e-3 s**
- resolution floor immediately above the plateau (smallest change that still
  moves a bit): **2.328e-10 s** — i.e. the float32 resolution of the parameter
  itself
- **plateau / floor = 4.29e+6 ×**
- plateau as a fraction of the LOG dial travel: **9.48 %**

⚠ Both numbers are given because neither means anything alone (CLAUDE.md).
A plateau four million times the resolution floor is a dead zone; a plateau one
floor wide is quantisation. And the instrument is negative-controlled: the same
metric at `delay = 0.001` with `feedback 0.5 → 0.9` reads **1.774e+0**, so it is
not blind.

Measured first-echo time confirms it independently: 0.001 / 0.0015 / 0.002 all
land the first wet sample at **0.00202 s**.

### B. PITCHUP IS DISCONTINUOUS AT ZERO — AND IT IS A TIME CONTROL

`VarispeedShifter` seeds `lag = window/2` and its window is 30 ms
(`varispeed-shifter.ts:51-58`), so **the instant `pitchUp` leaves 0 the three
engaged stages each insert 15.000 ms of read lag**. *Measured*, 1 ms click,
delay 0.15 s, mix 1:

| `pitchUp` | first wet | Δ vs p = 0 | bit-equal to p = 0 |
|---|---|---|---|
| 0 | 0.15002 s | 0.000 ms | **true** |
| 1e-12, 1e-10 | 0.15002 s | 0.000 ms | **true** (below the shifter's `\|rate−1\| < 1e-9` bypass) |
| **1e-9 … 1e-6** | **0.19502 s** | **+45.000 ms** | false |
| 0.001 | 0.19404 s | +44.021 ms | false |
| 0.01 | 0.18569 s | +35.667 ms | false |
| 0.05 | 0.16662 s | +16.604 ms | false |
| 0.1 | 0.16598 s | +15.958 ms | false |
| 0.2 | 0.17417 s | +24.146 ms | false |

3 × 15.000 = 45.000 ms, to the sample. Above that the lag has swept away from
`W/2` by the time the transient arrives, and the offset lands **anywhere in
16.6–25.2 ms depending on the grain phase at the moment of the transient** —
which is not a function of any parameter. §6-C is built on that.

**And it costs 15–30 dB.** Three independent probes, rms over [0.6, 1.4] s:

| `pitchUp` | sine burst | saw burst | noise burst | centroid (noise) |
|---|---|---|---|---|
| 0 | −17.96 | −19.00 | −24.35 | 1044 Hz |
| 0.005 | −31.11 | −33.45 | −38.02 | 351 Hz |
| 0.01 | **−49.25** | −46.73 | −39.96 | 1847 Hz |
| 0.05 | −42.02 | −32.30 | −44.97 | 1222 Hz |
| 0.2 | −36.26 | −31.94 | −40.02 | 3161 Hz |

⚠ **Three probes because one would have lied.** A single sine through a two-tap
crossfade can null; the loss survives on a saw and on deterministic LCG noise
too, and is non-monotonic on all three, so it is the mechanism and not the
probe. Mechanism: the two grain taps sum with `g1 + g2 ≡ 1` but read content
15 ms apart, so the *power* sum is `g1² + g2² ≤ 1` — ≥ 3 dB per engaged stage
before any comb cancellation, compounding across three stages in series.

**The shimmer itself is real.** Goertzel magnitudes on a C4 sine burst, fb 0.7,
window [0.8, 1.8] s: at `pitchUp = 0.05` the original 261.6 Hz reads
**1.62e-4** while the k = 6 partial at 350.6 Hz reads **7.92e-3** — **49× the
energy at the transposed partial**. The ascending shimmer works; it costs 14.5 dB
against the unshifted tail (4.21e-2 at p = 0).

### C. DECAY is three controls at once, and none of them is called "decay"

*Measured*, wet only (mix 1), delay 0.15 s:

| `decay` | wet peak | wet rms | centroid | predicted `(1−0.6d)^6` |
|---|---|---|---|---|
| 0 | **2.0000** (the clamp) | −10.02 dB | 1040 Hz | 0.00 dB |
| 0.2 (shipped) | 0.9306 | −12.91 dB | 837 Hz | −6.66 dB |
| 0.5 | 0.3436 | −14.15 dB | 658 Hz | −18.59 dB |
| 1 | 0.0381 | −32.02 dB | **125 Hz** | −47.75 dB |

It is a **level** control (22 dB), a **tone** control (a 8.3× centroid drop), and
— §3 — the **stability** control. The measured level sits well above the naive
`(1 − 0.6·decay)^6` cascade product because the drive is putting gain back.
DECAY is the single most overloaded control on the module and its label says
none of it.

### D. It is DUAL MONO, not stereo — zero cross-talk, measured

| probe | result |
|---|---|
| mono in `L`, `R` unpatched | `maxAbsDiff(L,R) = 0.000e+0`, bit-equal |
| C4 in `L`, G4 in `R` | `maxAbsDiff(L,R) = 8.307e-1`; L −18.93 dB, R −19.33 dB |
| silence in `L`, G4 in `R` | **L peak 0.0000**; 392 Hz magnitude in L = **0.000e+0**, in R = 8.959e-3 |

The two channels are independent cascades sharing one parameter set. There is no
width, no ping-pong, no stereo offset — `charlottes-echos.ts:166-168` pins
`stereoOffset`, `pan` and `panMode` to 0 for every stage. The def's header calls
it a "stereo delay"; a faceplate that says **"two independent mono cascades, one
control set"** is the true sentence, and it is also the one that tells a patcher
why the echoes never move.

### E. MIX = 0 is a bit-exact bypass

*Measured*: at `mix = 0` the output is **bit-identical to the input buffer**.
Worth one line on the face, because on a module that can rail at +5 dB rms,
"there is a setting that is provably the wire" is useful.

### F. Tail length to −60 dB (delay 0.15, mix 1, 10 s render)

| feedback (decay 0.2) | tail | | decay (fb 0.5) | tail |
|---|---|---|---|---|
| 0.1 | 0.35 s | | 0 | 0.90 s |
| 0.25 | 0.60 s | | 0.1 | 1.20 s |
| 0.4 | 1.10 s | | 0.2 | **1.85 s** |
| **0.5 (shipped)** | **1.85 s** | | 0.4 | **never** |
| 0.6 | 8.75 s | | ≥ 0.6 | never |
| ≥ 0.7 | **never** | | | |

⚠ Read the DECAY column with §3-A beside it: the tail gets *longer* as DECAY
rises **while getting quieter** (−22 dB over the same travel). A "-60 dB
relative to its own peak" number alone would read as "DECAY lengthens the tail",
which is true and misleading. Both columns, always.

---

## 5. THE FACE

### Two platform facts checked first, and one of them is a non-blocker

- ✅ **The card uses `<Knob>` for all five params**, so this face is NOT blocked
  by the missing `'fader'` `ParamCellKind`. `paramCellKind()` returns `'knob'`
  for all five (none is switch-shaped, none declares `options`, none is
  `momentary`), which is what the card already paints. **`charlottesEchos` is
  the only module in batch 6 that can ship today** — its two siblings both use
  `<Fader>` and have to wait for the kind.
- ✅ **The glyph binding resolves off an AUDIO OUTPUT** and this module has two
  (`L`, `R`, both `type: 'audio'`), so `glyph: 'scope'` binds to a real analyser
  tap rather than falling through to a canned `{kind:'static'}` trace.

### The layout constraint that decides the shape

`charlottesEchos` has **5 params**. `faceTierCap('full')` is **6**
(`LANE_PLATE_MAX_CELLS = PLATE_COLS × PLATE_MAX_ROWS`), and
`module-face-lint`'s `panelTierProblems` fails any PANEL cell *selected* at a
lane tier — so **a panel's first legal rank is 7**, and a module with five
params can never reach it. This is the exact wall `drummergirl` hit and worked
around by dropping its picture (`strict-faces.ts`).

**So the picture goes in the SIDEBAR as a `custom` block** — the meowbox
precedent: a sidebar block carries no `face.order` key and therefore no rank at
all. `hero.cell` stays **unset**, which also means the `scope` glyph keeps
painting at the dock (a `hero.cell` suppresses it).

```ts
face: {
  title: 'Destructive echo',
  hint:
    'Four analog delays in series, each with its own feedback loop and its own in-loop drive. ' +
    'DECAY and FEEDBACK are not amount controls — together they decide whether the module ever ' +
    'stops. Two independent mono cascades, one control set.',

  // 5 params, all of them in the lane plate. No panel key: a panel cannot rank
  // below 7 on a 5-param module (module-face-lint: panels are dock-only), so
  // the picture is a sidebar `custom` block instead.
  order: [
    'delay',      // 1 — the unit the module is named for; its bottom 9.48 % is dead
    'feedback',   // 2 — the largest authority (25.65 dB rms span) and half the boundary
    'decay',      // 3 — the other half, plus 22 dB of level and 8.3x of centroid
    'mix',        // 4 — and the setting that turns the internal ±2 clamp into an output clip
    'pitchUp',    // 5 — set-once; it costs 15-30 dB and moves the echo time by up to 45 ms
  ],

  pages: [
    {
      id: 'time',
      label: 'time',
      hint:
        'PITCH is a TIME control too: leaving 0 inserts 3 x 15 ms of grain lag, so the first ' +
        'echo jumps +45 ms and then drifts with the grain. The bottom 2 ms of TIME is a floor.',
      controls: ['delay', 'pitchUp'],
    },
    {
      id: 'loop',
      label: 'the loop',
      hint:
        'the in-loop drive has small-signal gain 1 + DECAY x (1+stage) x 0.8, up to 4.2 at ' +
        'stage 4 — so DECAY raises the loop gain while lowering the level. Past the boundary ' +
        'the echoes never stop. MIX 0 is a bit-exact bypass; MIX 1 exposes the internal ±2 clamp.',
      controls: ['decay', 'mix'],
      clusters: [{ label: 'stability', controls: ['decay'] }],
    },
  ],

  glyph: 'scope',   // an INSERT: silent unpatched, so the tile pins deterministically.

  hero: {
    // No `cell` — see the rank-7 arithmetic above. FEEDBACK is promoted because
    // it is the control two of the three readouts are about, and the one with
    // the largest measured authority on this module.
    control: 'feedback',
    readouts: [
      { label: 'tail',     valueId: 'ce-tail' },
      { label: 'headroom', valueId: 'ce-headroom' },
      { label: 'spacing',  valueId: 'ce-spacing' },
    ],
  },

  sidebar: [
    {
      kind: 'signal-flow', label: 'signal flow',
      stages: [
        { label: 'IN L / IN R', role: 'generator', note: 'R normals from L' },
        { label: 'DRY',   role: 'bus', parallel: true, note: 'MIX 0 = a bit-exact wire' },
        { label: 'STAGE 1-4', role: 'bus', note: 'in SERIES, each delay/4, each with its own loop' },
        { label: 'DRIVE (in loop)', role: 'bus', parallel: true, note: 'gain 1 + DECAY x (1+k) x 0.8' },
        { label: 'GRAIN SHIFT', role: 'bus', note: 'x(1+PITCH)^k between stages; +15 ms each' },
        { label: '±2 CLAMP', role: 'bus', note: 'the only limiter anywhere' },
        { label: 'MIX -> OUT L / OUT R', role: 'bus', note: 'two independent cascades' },
      ],
    },
    {
      kind: 'custom', label: 'echo train', panelId: 'echo-train',
      props: { timeParam: 'delay', feedbackParam: 'feedback', decayParam: 'decay', shiftParam: 'pitchUp', stages: 4 },
    },
    {
      kind: 'readouts', label: 'the loop',
      entries: [
        { label: 'stage 4 gain', valueId: 'ce-loop-gain' },
        { label: 'margin',       valueId: 'ce-margin' },
        { label: 'stereo',       text: 'dual mono — no width, no ping-pong' },
      ],
    },
    {
      kind: 'presets', label: 'openers',
      entries: [
        { id: 'slap',    label: 'clean slapback', note: 'decays in 0.35 s',
          values: { delay: 0.09, feedback: 0.1, decay: 0.05, pitchUp: 0, mix: 0.3 } },
        { id: 'dub',     label: 'dub tail',       note: 'decays in 1.85 s',
          values: { delay: 0.28, feedback: 0.5, decay: 0.2, pitchUp: 0, mix: 0.5 } },
        { id: 'shimmer', label: 'ascending',      note: 'the signature; -15 dB',
          values: { delay: 0.15, feedback: 0.5, decay: 0.2, pitchUp: 0.08, mix: 0.6 } },
        { id: 'drone',   label: 'never stops',    note: 'past the boundary — on purpose',
          values: { delay: 0.15, feedback: 0.5, decay: 0.45, pitchUp: 0, mix: 0.7 } },
      ],
    },
  ],
}
```

⚠ **`face.title`, `face.hint` and every band `hint` paint NOTHING at rest** —
`facePageHeader()` and `bandHeaderPlan` are both annotation-gated (the cofefve
finding, `strict-faces.ts`). So this face's argument rests entirely on the three
**hero readouts**, the **sidebar `readouts` block** and the **echo-train
picture**, all of which paint unconditionally. The hints carry the mechanism as a
fourth tier for annotation mode. Do not put anything load-bearing in them.

⚠ **`clusters: [{ label: 'stability', controls: ['decay'] }]` is a one-cell
cluster** — a ~14 px sub-header over a single knob. That is deliberate (it is
the cheapest way to LABEL the fact without buying an ~81 px band) but it is
unusual; if the shell renders a one-cell cluster badly, drop the cluster and
keep the band.

---

## 6. DERIVED READOUTS

All three are `valueId` entries in `face-readout-values.ts`. ⚠ `FaceReadoutValue`
is `(read: (paramId) => number | undefined) => string` — **params only**. None of
these may depend on a cable, an analyser or the clock.

### A. `ce-tail` — the readout the module exists for

Prints the tail length, or `NEVER DECAYS`. Derived from the measured boundary
surface in §3-B (anchored on measurement, **not** on the formula alone — §3-B's
`decay = 0` row is why), with §4-F's tail table interpolated below it.

```
shipped default  ->  "1.9 s"
decay 0.45       ->  "NEVER DECAYS · loop 1.05"
feedback 0.9     ->  "NEVER DECAYS · loop 1.47"
```

- **NEGATIVE CONTROL — `mix`.** The loops are inside the stages; MIX is after
  them. *Measured* at `fb 0.5, decay 0.2, delay 0.15`:

  | `mix` | rms (first 2 s) | tail |
  |---|---|---|
  | 0.25 | −23.03 dB | **1.85 s** |
  | 0.50 | −18.93 dB | **1.85 s** |
  | 0.75 | −15.69 dB | **1.85 s** |
  | 1.00 | −13.23 dB | **1.85 s** |

  **9.80 dB of level movement, 0.00 s of tail movement.** A tail readout derived
  from level would track the first column. This one must track the second.
- **SECOND LEG — `decay` 0.2 → 0.4 at `fb 0.5`** must flip it from a number to
  `NEVER`. Measured: 1.85 s → still −19.7 dBFS at 20 s. The bisected boundary is
  **0.2977**, so a readout that flipped at 0.5 or at 0.2 would be wrong in a way
  the one-sided test would not catch.
- **THIRD LEG — `delay`.** Both the boundary and the length depend on it
  (§3-B): 0.25 / 1.85 / 7.60 s at delay 0.02 / 0.15 / 0.60 with everything else
  fixed. The readout MUST take `delay` as an input. ⚠ **This leg exists because
  the first draft of this spec asserted the opposite** and the measurement
  refuted it.

### B. `ce-headroom` — the peak estimate, red above 1.0

From `feedback`, `decay` and `mix`, anchored on §3-C's measured grid
(0.7046 / 1.2208 / 1.1738 / 1.3000 / 2.0000) and §4-C's wet-peak column.

- **NEGATIVE CONTROL — `pitchUp`.** Measured, PITCHUP *lowers* the wet level by
  15–30 dB on all three probes, so the estimate must not rise when it is
  engaged. A naive "more controls open = louder" heuristic fails this.
- **SECOND LEG — `decay` 0.2 → 0** must push the estimate over 1.0 while
  `feedback` stays put. That is the counter-intuitive direction (turning a knob
  *down* makes it clip) and it is the whole point of printing it.

### C. `ce-spacing` — and the readout that REFUSES to print a number

The effective first-echo time. At `pitchUp = 0` this is `delay`, exactly
(measured ratio 1.000 from 3 ms up), printed in **ms** — ⚠ state the unit,
because the param is in **seconds** and the two differ by 1000×.

At `pitchUp > 0` it prints **`400 ms + grain`**, not a number.

**That is the finding, not a cop-out.** §4-B measured the added offset at
45.000 ms as `pitchUp → 0⁺` and then anywhere in **16.6–25.2 ms** thereafter,
because it depends on where the free-running grain sweep sits when the transient
arrives — which is not a function of any parameter. A readout that printed
`416.6 ms` would be inventing precision the DSP does not have, which is the same
class of error as a metric blind to its own dimension.

- **NEGATIVE CONTROL — `pitchUp` 0 → 1e-9.** No other param moved, `delay` is
  untouched, and the readout MUST change (measured: the first echo genuinely
  moved 0.15002 → 0.19502 s). A `paramId: 'delay'` readout prints `0.400 s` in
  both states and is wrong in the second by 45 ms.
- **SECOND LEG — it must NOT print a precise total at `pitchUp > 0`.** Assert
  the string form, not just the value.

### D. `ce-loop-gain` / `ce-margin` (sidebar)

`ce-loop-gain` prints `max_k feedback·0.995·(1 + decay·(1+k)·0.8)` — the stage-4
number, 0.8159 at the shipped default. `ce-margin` prints how far the dials are
from the **measured** boundary: `DECAY +0.116 · FBK +0.113` at the default,
turning to `PAST` past it.

- ⚠ **`ce-loop-gain` and `ce-margin` are DIFFERENT KINDS OF NUMBER and the
  captions must say so.** The loop gain is the closed form, exactly derivable
  from the source. The margin is an interpolation over §3-B's **measured**
  surface, which is a function of *three* params (`feedback`, `decay` **and**
  `delay` — §3-B's correction), and which the closed form over-estimates by
  3–7 %. Presenting an interpolated measurement as a derived law is the error
  `macro-aux-offset` calls out; label the margin `measured`.
- **NEGATIVE CONTROL — `mix`.** MIX is outside every loop (measured: 9.80 dB of
  level, 0.00 s of tail, §6-A), so both numbers must be exactly flat in it. That
  is the one input where "independent" is measured rather than assumed.
- **SECOND LEG — `delay`.** `ce-loop-gain` must be **flat** in `delay` (no delay
  term in the expression) while `ce-margin` must **move** (0.3184 → 0.2079
  across the travel). Two readouts side by side that respond differently to the
  same knob is the cheapest possible demonstration that one is a law and the
  other is a measurement.

### E. ⚠ ONE FACT THAT IS NOT EXPRESSIBLE AS A READOUT

**"is `R` patched, or is it normalled from `L`?"** — §4-D measured that the two
channels never interact and that a mono source into `L` gives bit-identical
outputs, so whether the module is running one signal or two is a real,
user-visible distinction. It is a graph edge, and `FaceReadoutValue` is
`(read: (paramId) => number | undefined) => string` — **params only**. The
`stereo` line in §5's sidebar is therefore a fixed `text:`, not a `valueId:`,
and it states the invariant ("dual mono — no width, no ping-pong") rather than
the live state.

**The `echo-train` `custom` panel CAN carry the live half**, because a sidebar
panel reaches topology: `FilterResponsePanel.svelte:31` and
`MeowboxFormantBankPanel.svelte:33` both `import { patch } from
'$lib/graph/store'`, and `patch.edges` is a `Record<string, Edge>`. So the panel
draws **one** echo train when `R` is normalled and **two** when it is genuinely
patched. Put it there, not in a readout.

⚠ **Counting this, it is the fourth independent request to widen that reader**
(analogVco and macrooscillator both filed it; bluebox hit the same wall from the
`face.momentary` side). `engine.readParam` already returns *intrinsic +
modulator tap* (`engine.ts:737-747`); a `{ read, readLive, sampleRate }` reader
closes all four. The panel escape hatch is the right move now and the wrong
long-term shape — a one-line fact wants a `readouts` entry, not a Svelte
component.

---

## 7. THE PICTURE — `echo-train`, a GENERIC sidebar panel

A four-stage echo-train diagram: the dry hit, then the taps at `delay` spacing,
heights from the measured level law, **each successive tap tinted darker by
`decay`** (the centroid really does fall 1040 → 125 Hz, §4-C) and **stepped up
by `(1 + pitchUp)^k`**. Two things it must draw that nothing else can:

1. **The clamp line at ±2**, with the tap heights actually touching it when the
   settings say so — that is §3-C made visible.
2. **When the loop gain crosses 1, the train does not fade** — draw the tail as
   a flat band rather than a decaying one. That is the module's whole behaviour
   in one shape.

Registered generically (`props: { timeParam, feedbackParam, decayParam,
shiftParam, stages }`) so `cofefve`, `delay` and any future multi-tap can reuse
it. Per `sidebar-panels.ts` rule 2: it READS, it must never emit a
`control-<paramId>` testid, and it must resolve def defaults for untouched
params (the crossover-panel `WIDTH 0%` bug).

---

## 8. ALREADY-WRONG

- **A · The module never stops past a boundary nobody documents** (§3). This is
  the one to raise with the owner. It is not obviously a *bug* — a destructive
  echo that self-sustains is a legitimate instrument — but the boundary is at
  `decay 0.2977` with feedback at its own default, i.e. **inside the normal
  working range of a dial whose doc sentence is about "darkening"**. Either the
  in-loop drive's small-signal gain should be normalised (`tanh(y·drive)/drive`,
  a real audio change that re-pins all three ART baselines) or the surfaces must
  say it. **The face says it; the DSP is untouched** — CLAUDE.md, and batch-3
  INDEX rule 5.
- **B · The bottom 9.48 % of the DELAY dial is bit-exactly dead** (§4-A). A
  `min` of 0.001 s against a cascade that floors at 0.002 s. Fixable in the def
  in one character (`min: 0.002`), but that is a contract change that clamps
  saved racks, so it is its own PR with an owner call.
- **C · `pitchUp` leaving 0 is a 45 ms discontinuity in the DELAY time**
  (§4-B). The def's own doc for `pitchUp` says *"At 0 the internal varispeed
  grain shifter is bypassed entirely"* — true — and stops there. It does not say
  what happens at 0 + ε. Documentable on the def in the same PR as the face.
- **D · `pitchUp` costs 15–30 dB** (§4-B), measured on three probes. The doc
  calls it "the signature ascending shimmer" with no mention that engaging the
  signature drops the wet path by up to 30 dB.
- **E · `CharlottesEchosCard.svelte` re-types all 10 literal ranges** the def
  already declares (`min={0.001} max={1.5}` etc.), and `charlottesEchos` is
  **not** in `RANGE_BOUND_CARDS`. All five agree today. Bind through `paramSpec`
  and enrol it in the same PR — that is the boy-scout fix, and it is what makes
  the divergence visible to a gate at all.
- **F · The card's `shimmer` animation is a latent `vrt-strict` hazard.**
  `CharlottesEchosCard.svelte` runs a 1.6 s CSS keyframe on the stripe when
  `feedback > 0.6`. `charlottesEchos` is in `STRICT_VRT_MODULES`, whose
  promotion rule 4 is "no animated chrome". It passes today only because the
  default (0.5) is below the threshold. Any PR that raises the default `feedback`
  — including one motivated by §3 — turns a REQUIRED baseline
  non-deterministic. Noted, not fixed.
- **G · The def calls it a stereo delay; it is dual mono** (§4-D). Not a bug —
  the ports are a legitimate `stereoPairs` — but the prose implies an image the
  DSP cannot produce.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+0 lines.** No new param, port or family: the picture is a sidebar `custom` block (no `face.order` key), and `face` is out of `contract-signature.ts` entirely. §8-B, if taken, is +0 lines and 1 changed line — a separate PR. |
| **STRICT_DOCS** | already in it (`strict-docs.ts:74`). No new port/param, so no new `docs.*` key is required; §8-C/§8-D are doc *edits* to existing keys, which `module-docs-lint` accepts. |
| **ART** | **three scenarios exist** (`charlottes-echos/{profile,single-tap,wet-output}.test.ts`) and their `.sha` pins cover `charlottes-echos.ts` + `analog-delay-core.ts` + `varispeed-shifter.ts`. **A face PR touches none of them** — but §8-A, if ever taken, re-pins all three. Keep them apart. |
| **VRT** | **The card is in the REQUIRED `vrt-strict` gate.** A face PR that does not touch `CharlottesEchosCard.svelte` moves no card baseline; the `paramSpec` binding in §8-E is a no-op on pixels (same numbers) but should still be captured and diffed. New face scenes: `face-charlottesEchos-{compact,dock}` = **2 baselines** (one set — linux CI authors it). |
| **e2e** | +1 `faces-parity` row, **5 cells** — the smallest in recent batches. ≈ +6 s, well under the 2 min wall-time threshold. |
| **Push 2** | no `PUSH_CARD_CONTROLS` entry, so the card is generic-tier over 5 params — all five fit the 8-control card, so no re-rank risk. No entry needed. |
| **the bottom line** | A five-knob card where **two of the knobs are a stability boundary**, the module can rail at +5 dB rms and 87.6 % clipped from one 60 ms hit, and the signature control is discontinuous at zero. Every one of those is derivable from the shipping source and none of them is visible anywhere today. |
