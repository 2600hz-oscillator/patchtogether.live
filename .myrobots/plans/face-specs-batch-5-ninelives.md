# FACE SPEC — `ninelives` (batch 5)

> **Two owner rulings, 2026-08-11, apply to this file** (verbatim at
> `rings.ts:585-590` and `:645-650`): *"we should prefer almost zero AI authored
> text, and all future faceplate work should reflect that"* and *"lets stop doing
> these and clean up the existing ones, get rid of them. lose the signal flow
> diagrams."* Every proposed `hint` has been **deleted** from §4; its measured
> content is in §1/§2. Do not re-author it. Measurements belong in `docs.controls`
> (the `rings.ts:592-596` precedent), not on the panel.

## 0. STATUS

**Authored 2026-08-10 against `main` at `153e5c36`. UNBUILT** — no `face:` block.

**Verdict: PROMOTE — the one module in the batch where the ENTIRE face is a table
of numbers the panel cannot possibly show. Two knobs, nine outputs, and four of
those outputs cannot complete a cycle in twenty seconds at ten times the default
rate.**

archetype: **the MULTI-RATE LFO** — one oscillator, nine taps on a geometric ⅓
ladder, plus a reset trigger.

Not in `STRICT_FACES`. In `STRICT_DOCS`; **not** in `STRICT_VRT_MODULES`; **not**
in `PUSH_CARD_CONTROLS`; **not** in `RANGE_BOUND_CARDS`. **2 params**, 1 in,
**9 out**. contract-lock = **13 lines**.

**Method.** REAL factory → REAL worklet (`packages/dsp/src/ninelives.ts`) under
`node-web-audio-api`'s `OfflineAudioContext`, 48 kHz. **Determinism control:
`max|run1 − run2| = 0.000e+0`.** Periods measured by rising zero-crossings over a
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
| **`out6`** | **0** | — | 0.0412 Hz | 0.72581 | **+0.10771** |
| **`out7`** | **0** | — | 0.0137 Hz | 0.31106 | **+0.66852** |
| **`out8`** | **0** | — | 0.0046 Hz | 0.15780 | **+0.27948** |
| **`out9`** | **0** | — | 0.0015 Hz | 0.05499 | **+0.09547** |

`out(n) = rate / 3^(n−1)`, **exact to four decimals**. At the **SHIPPED default of
1 Hz** that ladder is:

| out | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| period | 1 s | 3 s | 9 s | 27 s | 81 s | **4.05 min** | **12.2 min** | **36.5 min** | **1 h 49 min** |

And at the **maximum** rate of 100 Hz, `out9` still has a **65.6 s** period.
**There is no setting of the RATE knob at which output 9 completes a cycle inside a
minute.** Outputs 6–9 are, for every practical purpose, four slowly-drifting DC
offsets — measured DC **+0.108 / +0.669 / +0.279 / +0.095** over a 20 s window at
ten times the default rate.

That is not a bug. It is what a ⅓ ladder with nine rungs *is*. It is also
completely unknowable from a panel with two knobs and nine unlabelled jacks, and it
is the entire argument for this face.

---

## 2. `shape` IS A 3-POSITION SELECTOR DECLARED `linear`

`{ id: 'shape', min: 0, max: 2, curve: 'linear', defaultValue: 0 }`
(`ninelives.ts:65`). *Measured*, `rate = 1`:

| `shape` | `out1` rms dB | `out1` peak | `out3` peak | `out9` peak |
|---|---|---|---|---|
| **0** | −3.01 | 1.000 | 1.000 | 0.004 |
| 0.5 | **−13.08** | **0.500** | 0.276 | 0.499 |
| **1** | −4.77 | 1.000 | 0.778 | 1.000 |
| 1.5 | **−10.79** | **0.500** | 0.444 | 0.001 |
| **2** | **0.00** | 1.000 | 1.000 | 1.000 |

**The three named positions are at 0, 1 and 2; every value between them is 6 dB
down in peak and up to 10 dB down in RMS.** A `linear` curve renders a continuous
fader, so half the travel lands in a state that is neither of the neighbouring
shapes and is quieter than both.

⚠ **Before "fixing" this to `curve: 'discrete'`, check the consumer — and here the
check PASSES.** CLAUDE.md's standing warning is that four cards pass
`curve="linear"` where the def says `discrete` and writing `discrete` would change
nothing, because all four are `<Knob>` and `Knob.svelte` has no `discrete` branch.
**`NinelivesCard.svelte` uses `<Fader>`, which DOES implement `discrete`** — so
unlike those four cases, **fixing this one would actually take effect.** It is
still a contract change (`contract-lock`, `docs:accept`) and its own PR.

⚠ **The level ladder is its own finding**: shape 0 → −3.01 dB, shape 1 → −4.77,
shape 2 → **0.00 dB**. **4.77 dB between the quietest and loudest named shape**, on
a CV source where "the same LFO, a different wave" is the promise.

---

## 3. THE RANKING — two params, nine outputs

| rank | key | tier | why |
|---|---|---|---|
| 1 | `rate` | mini | the only continuous control, and the one that sets all nine periods. |
| 2 | `shape` | compact | the 3-position/linear problem (§2) and 4.77 dB of level. |
| 3 | `ninelives-ladder-{n}` | dock (panel) | **the face** — §5. |

⚠ **THE TIERS COLLAPSE COMPLETELY.** Two params, so `compact`, `full` and `dock`
all render the identical two cells. Exactly the `noise` shape — **and unlike
`noise`, this one still earns its face**, because the module's information is not
in its controls at all. It is in the nine numbers on the jacks, which no tier
currently shows.

⚠ **This face has TWO keys, so a panel's rank-7 floor is unreachable** — the
drummergirl wall at its most extreme. The picture **must** be a sidebar `custom`
block: the meowbox answer.

**NO AUDITION** — a free-running LFO with nothing to strike. (Its `reset` input is a
trigger, but firing it writes no param and the def exposes no callable, so an
`action` cell would need a `ShellActionCell.probe` reaching nothing.)

---

## 4. THE FACE

```ts
face: {
  title: 'Nine-rate LFO',

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
  ],
}
```

⚠ **`glyph: 'waveform'`, not `'scope'`.** `primaryAudioOutPortId` picks the first
**audio** output — ninelives has **none** (nine `cv` outputs). A `scope` glyph
would tap nothing. `'waveform'` is param-derived (it draws the shape from `shape` +
`glyphDepthGain`) and needs no tap, which is exactly right for a module whose
outputs are all CV. **This is the `drumseqz`/`featurecv` glyph-source problem, and
`'waveform'` is the one answer that does not require a platform change.**

⚠ **With no pages there are no band labels, so every fact on this face is a readout
or a sidebar entry.**

⚠ **`panelId: 'rate-ladder'` must be registered in `sidebar-panels.ts`**, and it is
written generically (`divisor`, `taps`, `tapPrefix`) because `timelorde` in this
same batch has thirteen divider outputs and wants the same picture. **Register it
once.**

---

## 5. DERIVED READOUTS + THE PICTURE

### A. `ninelives-rate-1` / `-5` / `-9`

`rate / 3^(n−1)`, printed **in the right unit per magnitude**: `10.0 Hz`,
`0.12 Hz`, **`1 h 49 min`**. Anchored on §1 (measured 10.0000 / 0.1235 / 0.0015 Hz
at `rate = 10`).
**NEGATIVE CONTROL — `shape`:** all three must be invariant to it (measured: the
zero-crossing periods are identical at every shape; only the amplitude moves).
**SECOND — `rate`:** all three must move *together*, in a fixed 1 : 1/81 : 1/6561
proportion; a derivation where they drifted apart would be inventing per-tap tuning
the DSP does not have.
⚠ **STATE THE UNITS, and switch them.** `out9` at the default rate is
**0.00015 Hz**; printing that as a number is useless and printing it as
`1 h 49 min` is the whole point of the readout.

### B. `ninelives-shape-name`

`sine` / `triangle` / `square` at 0 / 1 / 2, and **`between (−6 dB)`** anywhere
else, because that is what was measured (§2). A readout that rounded to the nearest
named shape would be hiding a state the fader can reach.
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
  implement `discrete`**, so unlike the four `<Knob>` cases in CLAUDE.md this one
  would actually take effect. Its own PR.
- **B · 4.77 dB between the three named shapes** (§2). A CV source that changes
  level when you change wave is a patch-breaker downstream. **Owner call.**
- **C · outputs 6–9 cannot complete a cycle in a minute at ANY rate** (§1). Not a
  bug — the ladder is exact — but undocumented and unknowable. ⚠ **PARTIALLY
  FIXED**: `ninelives.ts:84` now documents out9 as *"At Rate ≈ 1 Hz this is one slow
  sweep every ~109 minutes"*. **The full 6–9 period table is still absent** —
  `docs.outputs.out6/7/8` give only the ratio (`Rate ÷ 243` etc.), which is the
  number that hides the finding rather than stating it.
- **D · `NinelivesCard.svelte` re-types 4 literal range props** in 57 lines;
  `ninelives` is **not** in `RANGE_BOUND_CARDS`.
- **E · no audio output, so the shell glyph has nothing to tap** (§4). Third
  instance in this batch (`featurecv`, `ninelives`, `timelorde`).

**NEGATIVE RESULT — no dead controls.** Both params are live; the *outputs* are the
problem.

---

## 7. COST

| | |
|---|---|
| **contract-lock** | **+0.** No control family, no audition, the picture is a sidebar `custom` block. §6-A, if taken, is a `curve` diff. |
| **ART** | none from the face. `ninelives` HAS an ART scenario, which §6-A/B would re-pin — keep them out of the face PR. |
| **VRT** | +`face-ninelives-{compact,dock}` informational baselines. ⚠ **FREE-RUNNING** (it is an LFO), so it exercises #1420's pre-frame freeze — and the `waveform` glyph is param-derived, so it is deterministic by construction regardless. |
| **e2e** | +1 `faces-parity` row, **2 cells** — the smallest in the batch, ≈ +9 s, essentially all page boot. |
| **the bottom line** | Two controls and a completely collapsed tier ladder — and it still earns a face, because the face is not about the controls. Nine jacks whose periods span **1 second to 1 hour 49 minutes**, and the only place that can ever be said is the sidebar. |
