# FACE SPEC — `ninelives` (batch 5)

## 0. STATUS

**Authored 2026-08-10. Every claim below was measured or read against `main`**
(`153e5c36`). Nothing here is implemented; no def, card or DSP file is touched.

**Verdict: PROMOTE — and it is the one module in the batch where the ENTIRE face
is a table of numbers the panel cannot possibly show. Two knobs, nine outputs, and
four of those outputs cannot complete a cycle in twenty seconds at ten times the
default rate.**

archetype: **the MULTI-RATE LFO** — one oscillator, nine taps on a geometric ⅓
ladder, plus a reset trigger.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`; **not** in `PUSH_CARD_CONTROLS`. **2 params**, 1 in,
**9 out**. contract-lock = **13 lines**.

**Method.** REAL factory → REAL worklet (`packages/dsp/src/ninelives.ts`) under
`node-web-audio-api`'s `OfflineAudioContext`, 48 kHz. Determinism control:
`max|run1 − run2| = 0.000e+0`. Periods measured by rising zero-crossings over a
**20 s** render at `rate = 10 Hz` (ten times the default) so the slow taps get
their best possible chance.

---

## 1. THE LADDER IS EXACT, AND THAT IS THE PROBLEM

*Measured*, `rate = 10 Hz`, 20 s:

| out | rising zero-crossings | period | frequency | ac rms | **DC** |
|---|---|---|---|---|---|
| `out1` | 200 | 0.1000 s | **10.0000 Hz** | 0.70711 | 0.00000 |
| `out2` | 66 | 0.3000 s | 3.3333 Hz | 0.70673 | 0.00358 |
| `out3` | 22 | 0.9000 s | 1.1111 Hz | 0.70665 | 0.00592 |
| `out4` | 7 | 2.7000 s | 0.3704 Hz | 0.70949 | 0.03944 |
| `out5` | 2 | 8.1000 s | 0.1235 Hz | 0.69985 | 0.12771 |
| **`out6`** | **0** | — | 0.0412 Hz | 0.72581 | 0.10771 |
| **`out7`** | **0** | — | 0.0137 Hz | 0.31106 | **0.66852** |
| **`out8`** | **0** | — | 0.0046 Hz | 0.15780 | 0.27948 |
| **`out9`** | **0** | — | 0.0015 Hz | 0.05499 | 0.09547 |

`out(n) = rate / 3^(n−1)`, exact to four decimals. **At the SHIPPED default of
1 Hz** that ladder is:

| out | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| period | 1 s | 3 s | 9 s | 27 s | 81 s | **4.05 min** | **12.2 min** | **36.5 min** | **1 h 49 min** |

And at the **maximum** rate of 100 Hz, `out9` still has a **65.6 s** period.
**There is no setting of the RATE knob at which output 9 completes a cycle inside
a minute.** Outputs 6–9 are, for every practical purpose, four slowly-drifting DC
offsets — measured DC +0.108 / **+0.669** / +0.279 / +0.095 over a 20 s window at
ten times the default rate.

That is not a bug. It is what a ⅓ ladder with nine rungs *is*. It is also
completely unknowable from a panel with two knobs and nine unlabelled jacks, and
it is the entire argument for this face.

---

## 2. `shape` IS A 3-POSITION SELECTOR DECLARED `linear`

`{ id: 'shape', min: 0, max: 2, curve: 'linear', defaultValue: 0 }`. *Measured*,
`rate = 1`:

| `shape` | `out1` rms dB | `out1` peak | `out3` peak | `out9` peak |
|---|---|---|---|---|
| **0** | −3.01 | 1.000 | 1.000 | 0.004 |
| 0.5 | **−13.08** | **0.500** | 0.276 | 0.499 |
| **1** | −4.77 | 1.000 | 0.778 | 1.000 |
| 1.5 | **−10.79** | **0.500** | 0.444 | 0.001 |
| **2** | **0.00** | 1.000 | 1.000 | 1.000 |

**The three named positions are at 0, 1 and 2; every value between them is 6 dB
down in peak and up to 10 dB down in RMS.** A `linear` curve renders a
continuous fader, so half the travel lands in a state that is neither of the
neighbouring shapes and is quieter than both.

⚠ **Before "fixing" this to `curve: 'discrete'`, check the consumer.**
CLAUDE.md's standing warning applies literally: `NinelivesCard.svelte` uses
`<Fader>`, which **does** implement a discrete branch — unlike the four `<Knob>`
cards named in that note. So here the change would take effect. It is still a
contract change (`contract-lock`, `docs:accept`) and its own PR.

⚠ **And the level ladder is its own finding**: shape 0 → −3.01 dB, shape 1 →
−4.77, shape 2 → **0.00 dB**. **4.77 dB between the quietest and loudest named
shape**, on a CV source where "the same LFO, a different wave" is the promise.

---

## 3. THE RANKING — two params, nine outputs

| rank | key | tier | why |
|---|---|---|---|
| 1 | `rate` | mini | the only continuous control, and the one that sets all nine periods. |
| 2 | `shape` | compact | the 3-position/linear problem (§2) and 4.77 dB of level. |
| 3 | `ninelives-ladder-{n}` | dock (panel) | **the face** — §5. |

⚠ **THE TIERS COLLAPSE COMPLETELY.** `faceTierCap('full') = 6` and this module
has **two** params, so `compact`, `full` and `dock` all render the identical two
cells. Exactly the `noise` shape — **and unlike `noise`, this one still earns its
face**, because the module's information is not in its controls at all. It is in
the nine numbers on the jacks, which no tier currently shows.

⚠ **A panel's first legal rank is 7** (`module-face-lint` refuses a panel
selected at a lane tier; `faceTierCap('full') = 6`). **This face has TWO keys, so
rank 7 is unreachable** — the drummergirl wall at its most extreme. The picture
**must** be a sidebar `custom` block, which carries no `face.order` key and
therefore no rank: the meowbox answer. The `hero.cell` above is written as a
sidebar block in §4 for exactly this reason.

**NO AUDITION** — a free-running LFO with nothing to strike. (Its `reset` input
is a trigger, but firing it writes no param and the def exposes no callable, so
an `action` cell would need a `ShellActionCell.probe` reaching nothing.)

---

## 4. THE FACE

```ts
face: {
  title: 'Nine-rate LFO',
  hint: 'out(n) = RATE / 3^(n-1). At the default RATE, out9 has a 1 h 49 min period.',

  order: ['rate', 'shape'],
  // NO pages: two controls is one band.
  glyph: 'waveform',

  hero: {
    control: 'rate',
    // NO `cell` — rank 7 is unreachable with two keys (§3). The picture is the
    // sidebar block below.
    readouts: [
      { label: 'out1', valueId: 'ninelives-rate-1' },
      { label: 'out5', valueId: 'ninelives-rate-5' },
      { label: 'out9', valueId: 'ninelives-rate-9' },
      { label: 'wave', valueId: 'ninelives-shape-name' },
    ],
  },

  sidebar: [
    { kind: 'custom', label: 'the ladder', panelId: 'rate-ladder',
      props: { rateParam: 'rate', divisor: 3, taps: 9, tapPrefix: 'out' } },
    { kind: 'readouts', label: 'measured', entries: [
      { label: 'ratio',    text: 'exactly 1/3 per tap' },
      { label: 'out6 - 9', text: 'DC over any listening window' },
      { label: 'SHAPE',    text: '3 positions; between them is -6 dB' },
    ] },
  ],
}
```

⚠ **`glyph: 'waveform'`, not `'scope'`.** `primaryAudioOutPortId` picks the first
**audio** output — ninelives has **none** (nine `cv` outputs). A `scope` glyph
would tap nothing. `'waveform'` is param-derived (it draws the shape from
`shape` + `glyphDepthGain`) and needs no tap, which is exactly right for a module
whose outputs are all CV. **This is the `drumseqz`/`featurecv` glyph-source
problem, and `'waveform'` is the one answer that does not require a platform
change.**

⚠ **`title` / `hint` paint NOTHING at rest.** With no pages there are no band
labels either, so **every fact on this face is a readout or a sidebar entry.**
That is a constraint the two-param modules share and it is why the sidebar here
is doing all the work.

⚠ **`panelId: 'rate-ladder'` must be registered in `sidebar-panels.ts`**, and it
is written generically (`divisor`, `taps`, `tapPrefix`) because `timelorde` in
this same batch has thirteen divider outputs and wants the same picture.

---

## 5. DERIVED READOUTS + THE PICTURE

### A. `ninelives-rate-1` / `-5` / `-9` — three rungs, in units a player can act on

`rate / 3^(n−1)`, printed **in the right unit per magnitude**: `10.0 Hz`,
`0.12 Hz`, **`1 h 49 min`**. Anchored on §1 (measured 10.0000 / 0.1235 / 0.0015 Hz
at `rate = 10`).
**NEGATIVE CONTROL — `shape`:** all three must be invariant to it (measured: the
zero-crossing periods are identical at every shape; only the amplitude moves).
**SECOND — `rate`:** all three must move *together*, in a fixed 1 : 1/81 : 1/6561
proportion; a derivation where they drifted apart would be inventing per-tap
tuning the DSP does not have.
⚠ **STATE THE UNITS, and switch them.** `out9` at the default rate is
**0.00015 Hz**; printing that as a number is useless and printing it as `1 h
49 min` is the whole point of the readout.

### B. `ninelives-shape-name` — and the honest in-between

`sine` / `triangle` / `square` at 0 / 1 / 2, and **`between (−6 dB)`** anywhere
else, because that is what was measured (§2). A readout that rounded to the
nearest named shape would be hiding a state the fader can reach.
**NEGATIVE CONTROL — `rate`:** must not move it.

### C. THE PICTURE — nine rungs, one column

Nine horizontal bars, one per output, length ∝ log period, each labelled with its
own period in its own unit, **and the ones whose period exceeds a stated window
(say 60 s) drawn in the warn colour with the word `DC`**. Four of nine will be in
that state at every rate the knob can reach. A picture that drew nine identical
happy LFO traces would be the exact "green gate certifying a live bug" shape
CLAUDE.md warns about — here, a happy picture certifying four dead jacks.

---

## 6. ALREADY-WRONG

- **A · `shape` is a 3-position selector declared `linear`** (§2), so half the
  fader is a −6 dB in-between. Contract change; **the consumer (`<Fader>`) does
  implement `discrete`**, so unlike the four `<Knob>` cases in CLAUDE.md this
  one would actually take effect. Its own PR.
- **B · 4.77 dB between the three named shapes** (§2). A CV source that changes
  level when you change wave is a patch-breaker downstream. Owner call.
- **C · outputs 6–9 cannot complete a cycle in a minute at ANY rate** (§1). Not
  a bug — the ladder is exact — but it is undocumented and unknowable. `ninelives`
  is in `STRICT_DOCS` and `docs.outputs` should carry the table.
- **D · `NinelivesCard.svelte` re-types 4 literal range props** in 57 lines;
  `ninelives` is **not** in `RANGE_BOUND_CARDS`.
- **E · no audio output, so the shell glyph has nothing to tap** (§4). Third
  instance in this batch (`featurecv`, `ninelives`, and `timelorde`).
- **No dead controls.** Both params are live; the *outputs* are the problem.

---

## 7. COST

| | |
|---|---|
| **contract-lock** | **+0.** No control family, no audition, the picture is a sidebar `custom` block. §6-A, if taken, is a `curve` diff. |
| **ART** | none from the face. `ninelives` HAS an ART scenario, which §6-A/B would re-pin — keep them out of the face PR. |
| **VRT** | +`face-ninelives-{compact,dock}` × 2 = **4 informational baselines**. ⚠ **FREE-RUNNING** (it is an LFO), so it is the *fourth* face to exercise #1420's pre-frame freeze — and the `waveform` glyph is param-derived, so it is deterministic by construction regardless. |
| **e2e** | +1 `faces-parity` row, **2 cells** — the smallest in the batch, ≈ +9 s, essentially all page boot. |
| **the bottom line** | Two controls and a completely collapsed tier ladder — and it still earns a face, because the face is not about the controls. Nine jacks whose periods span **1 second to 1 hour 49 minutes**, and the only place that can ever be said is the sidebar. |
