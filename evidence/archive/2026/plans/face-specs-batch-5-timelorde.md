# FACE SPEC — `timelorde` (batch 5)

> **Two owner rulings, 2026-08-11, apply to this file** (verbatim at
> `rings.ts:585-590` and `:645-650`): *"we should prefer almost zero AI authored
> text, and all future faceplate work should reflect that"* and *"lets stop doing
> these and clean up the existing ones, get rid of them. lose the signal flow
> diagrams."* Every proposed `hint` and the `signal-flow` block have been
> **deleted** from §5; their measured content is in §1/§2/§3. Do not re-author
> them. Measurements belong in `docs.controls` (the `rings.ts:592-596` precedent),
> not on the panel.

## 0. STATUS

**Authored 2026-08-10 against `main` at `153e5c36`. UNBUILT** — no `face:` block.

**Verdict: PROMOTE — the rack's clock, and the one module every patch depends on.
Its headline is arithmetic: EVERY multiplier output permanently loses
`(multiplier − 1)` pulses, and nothing anywhere says so.**

archetype: **the MASTER CLOCK** — a singleton (`maxInstances=1 undeletable`),
thirteen gate outputs, a video passthrough.

Not in `STRICT_FACES`. In `STRICT_DOCS`; **not** in `STRICT_VRT_MODULES`; **not**
in `PUSH_CARD_CONTROLS`; **not** in `RANGE_BOUND_CARDS`. 6 params, 5 in, **14 out**,
3 `expose` entries (`bpm`, `swingAmount`, `swingSource` — the transport-bar
controls). contract-lock = **26 lines**.

**Method.** REAL factory → REAL worklet (`packages/dsp/src/timelorde.ts` →
`lib/timelorde-clock-core.ts`) under `node-web-audio-api`'s `OfflineAudioContext`,
48 kHz, 4 s renders. Rising edges counted at the GATE_HI 0.5 threshold; swing
measured as **inter-pulse intervals**, not counts — see §3.

---

## 1. THE MULTIPLIER DEFICIT

*Measured*, rising edges in a 4 s render:

| bpm | `1x` | `2x` | `4x` | `8x` | `1/2` | `1/3` | `1/4` | `1/8` | `1/16` |
|---|---|---|---|---|---|---|---|---|---|
| 60 | 4 | **7** | **13** | **25** | 2 | 2 | 1 | 1 | 1 |
| 120 | 8 | **15** | **29** | **57** | 4 | 3 | 2 | 1 | 1 |
| 240 | 16 | **31** | **61** | **121** | 8 | 6 | 4 | 2 | 1 |

**The dividers are exact. Every multiplier is short by exactly `multiplier − 1`:**
1 pulse on `2x`, 3 on `4x`, **7 on `8x`** — **identical at all three tempos, so it
is a fixed one-master-period deficit, not a rate error.**

The worklet header states the mechanism (*"Multiplier outputs (8x, 4x, 2x) lag by
exactly one master period due to a predictor-style scheduler"*), which makes it a
**layout fact rather than a bug** — the predictor cannot emit a subdivision until
it has seen a period to subdivide. It is still a fact a player needs: **start a
patch on `8x` and the first beat is missing seven pulses.** Nothing on the card, in
`docs.outputs`, or on the transport says it.

**And it is once-only, not per-cycle** — the deficit is 1/3/7 at 4 s and 1/3/7 at
16 s of clock, **so the ratio error vanishes with time and the *downbeat* error
never does.**

---

## 2. TWO CONTROLS WITH THE SAME OBSERVABLE

*Measured*, 4 s at 120 bpm:

| patch | `1x` | `1/4` | `swing` |
|---|---|---|---|
| default | 8 | 2 | 8 |
| **`running = 0`** | **0** | **0** | **0** |
| **`muteOutputs = 1`** | **0** | **0** | **0** |
| `wizardOn = 0` | 8 | 2 | 8 |

`running` and `muteOutputs` are **indistinguishable at the jacks**. They are not
the same thing — one stops the clock's phase, the other gates its outputs — but
from a patch cable there is no difference, and a rack that is silent because of one
is debugged completely differently from a rack that is silent because of the other.

**This is the single most valuable thing this face can print**, because `timelorde`
is a singleton every other module depends on, and "why is my whole rack stopped" is
the question it answers.

---

## 3. SWING — A PULSE COUNT IS BLIND TO IT, BY CONSTRUCTION

The first pass counted `swing` edges and read **7 at `swingAmount = 45` and 7 at
`swingAmount = 90`** — identical, and a very convincing "the amount does nothing".
It does. *Measured* inter-pulse intervals at 120 bpm:

| `swingAmount` | intervals (ms) |
|---|---|
| 0 | 500.0 500.0 500.0 500.0 500.0 500.0 500.0 |
| 15 | **520.8 / 479.2** alternating |
| 45 | **562.5 / 437.5** |
| 70 | **597.2 / 402.8** |
| 90 | **625.0 / 375.0** |

Exactly linear: `offset = 125 ms × (swing / 90)`, i.e. at 90° the pair is
`625 / 375` = a **5 : 3** ratio. Perfectly honest, perfectly implemented, and
**completely invisible to the instrument that counts pulses** — swing moves *when*
an edge lands, never *how many*.

⚠ **The batch's clearest VALIDATE-THE-INSTRUMENT instance, in its general form: *a
metric that integrates over the window is blind to any control that only
redistributes within it.*** The counter had a passing negative control (it
correctly read 8 → 7 when swing engaged at all), and it was still the wrong
instrument.

`swingSource` (0..11, which divider the swing output follows) is honest too:
measured `swing` = 8 edges at source 0 and **3** at source 5, tracking the chosen
divider.

---

## 4. THE RANKING — 6 params, 14 jacks

| rank | key | tier | why |
|---|---|---|---|
| 1 | `bpm` | mini | the number the whole rack is keyed to. |
| 2 | `running` | compact | the transport, and half of §2. |
| 3 | `swingAmount` | plate | 125 ms of travel at 120 bpm, measured linear. |
| 4 | `swingSource` | plate | picks which of twelve dividers the SWING jack follows. |
| 5 | `muteOutputs` | plate | **ranked 5 and NOT hidden** — it is the other half of §2 and the thing a player forgets is on. |
| 6 | `wizardOn` | plate | |
| 7 | `timelorde-ladder-{n}` | dock (panel) | the picture — §6. |

⚠ **`muteOutputs` at rank 5 is deliberate.** The temptation is to bury a "mute
everything" switch below the lane; the measurement in §2 is the argument against it
— a control observationally identical to the transport stop must be *visible
wherever the transport is*, or the two states are indistinguishable to the player as
well as to the meter.

⚠ **A panel's rank-7 floor is reachable here by exactly one** (6 params) — the
picture can be a real `hero.cell`.

**AN AUDITION IS TEMPTING AND IS NOT DECLARED.** A "tap tempo" pad exists on the
card (`docs.explanation`: *"A TAP button sets the internal tempo by ear"*) and it is
the one genuinely performative control on the module. It is **not** in `face.order`
here because an `action` cell **requires** a `ShellActionCell.probe`, the observable
would have to be the **audition ledger** resolving a callable off the live engine
handle, and **the def exposes no such callable today.** Declaring an action without
a probe that can reach something is how a dead audition ships green (the
`faces-parity` hole audited 2026-08-02). **Name it as the follow-up, do not fake
it** — see §7-C.

---

## 5. THE FACE

```ts
face: {
  title: 'Master clock',

  order: [
    'bpm', 'running', 'swingAmount', 'swingSource', 'muteOutputs', 'wizardOn',
    'timelorde-ladder-{n}',   // PANEL, rank 7 — the first legal rank, reached by one
  ],

  pages: [
    { id: 'transport', label: 'transport',
      controls: ['bpm', 'running', 'muteOutputs', 'timelorde-ladder-{n}'] },
    { id: 'swing', label: 'swing', controls: ['swingAmount', 'swingSource'] },
    { id: 'wizard', label: 'wizard', controls: ['wizardOn'] },
  ],

  glyph: 'none',
  hero: {
    cell: 'timelorde-ladder-{n}',
    control: 'bpm',
    readouts: [
      { label: 'state',  valueId: 'timelorde-transport-state' },
      { label: 'swing',  valueId: 'timelorde-swing-ms' },
      { label: '1/16',   valueId: 'timelorde-div-ms' },
    ],
  },

  sidebar: [
    { kind: 'custom', label: 'the divider ladder', panelId: 'rate-ladder',
      props: { rateParam: 'bpm', divisor: 2, taps: 13, tapPrefix: '' } },
  ],
}
```

⚠ **`glyph: 'none'`, and that is a decision, not an omission.**
`primaryAudioOutPortId` picks the first **audio** output; timelorde has **none**
(thirteen `gate`, one `video`). A `scope` or `meter` glyph would tap nothing and
paint a black rectangle — the `noise` white-tap finding. `'none'` is correct until
the platform gains a declared glyph source, at which point the right tap is `1x`.

⚠ **THREE bands**, so this is one scrolling column, not a tab rail. PF-21 packs
4 + 2 + 1 = 7 cells onto one row.

⚠ **`panelId: 'rate-ladder'` is SHARED with `ninelives` in this same batch** — same
picture, different props (`divisor: 2, taps: 13` vs `divisor: 3, taps: 9`). The
`custom`-block contract working as designed. **Register it once.**

---

## 6. DERIVED READOUTS + THE PICTURE

### A. `timelorde-transport-state` — the readout §2 exists for

Four states from two params: `running` · **`STOPPED`** · **`MUTED`** ·
`STOPPED + MUTED`. **NEGATIVE CONTROL — `bpm`:** must not move it.
**SECOND — the two params SEPARATELY:** `running = 0` alone must read `STOPPED` and
`muteOutputs = 1` alone must read `MUTED`, because the measurement says the *jacks*
cannot tell them apart (§2, both give 0 edges on all three outputs tested). A
readout that collapsed them into one word would be reproducing the exact ambiguity
it exists to remove — and it would pass any test written against the output.

### B. `timelorde-swing-ms` — the pair, in milliseconds

`625 / 375 ms` at swing 90 and 120 bpm; `500 / 500 ms` at swing 0. Derived from
`bpm` and `swingAmount`, anchored on §3.
**NEGATIVE CONTROL — the COUNT.** This readout must move where a pulse count does
not: measured 7 edges at both swing 45 and swing 90, while the intervals go
562.5/437.5 → 625/375. **A readout built on the count is the instrument that
failed.**
**SECOND — `bpm`:** both numbers must scale with it (at 60 bpm the same 90° gives
1250 / 750 ms), so the readout is proven to be computing a duration rather than
echoing the degree value.
⚠ **STATE THE UNITS.** `ms` — `swingAmount` is in **degrees**, and a bare `625` next
to a knob reading `90` is unreadable.

### C. `timelorde-div-ms` — one anchor rung

The `1/16` period in ms (`60000 / bpm / 4`), because it is the rung most sequencers
key to and the ladder picture cannot label all thirteen legibly.

### D. THE PICTURE — the divider ladder, in the HERO

Thirteen rungs, each labelled with its period in ms (or in seconds past 1 s), **the
multipliers drawn with a visible gap at t = 0 of exactly `(multiplier − 1)` missing
pulses** — because that is what §1 measured, and a ladder drawn as thirteen perfect
pulse trains would be a picture certifying behaviour the module does not have.

---

## 7. ALREADY-WRONG

- **A · every multiplier output loses `(multiplier − 1)` pulses at start** (§1) —
  measured 1 / 3 / 7 on `2x` / `4x` / `8x`, identical at 60, 120 and 240 bpm.
  Documented **in the worklet header ONLY — there is no lag/deficit prose anywhere
  in `timelorde.ts`.** `timelorde` is in `STRICT_DOCS`; `docs.outputs` should carry
  it. **A doc PR, not a DSP one.**
- **B · `running = 0` and `muteOutputs = 1` are observationally identical at every
  jack** (§2). Not a bug; **a UX hazard on an undeletable singleton the whole rack
  depends on.**
- **C · the TAP button has no engine-reachable callable**, so a face cannot declare
  it as an `action` (§4). **A small factory-seam PR — the same shape as `karplus`'s
  `manualTrigger` read key — BEFORE the face, if the owner wants TAP on the
  faceplate.**
- **D · `TimelordeCard.svelte` re-types 6 literal range props** in 742 lines;
  `timelorde` is **not** in `RANGE_BOUND_CARDS`.
- **E · no audio output, so the shell glyph has nothing to tap** (§5). Third
  instance in this batch.

**NEGATIVE RESULT — no dead controls.** All six params measure live; **`wizardOn`
was the only dead candidate**, and it leaves the pulse counts unchanged because its
effect is on the card's wizard UI, not the clock.

---

## 8. COST

| | |
|---|---|
| **contract-lock** | **+1 line** for the `timelorde-ladder` panel family (or +0 as a sidebar `custom` block; the panel id is shared with `ninelives`). |
| **ART** | none from the face. |
| **VRT** | +`face-timelorde-{compact,dock}` informational baselines. ⚠ **THE CLOCK FREE-RUNS AT SPAWN** (`running` defaults to 1), so this depends on #1420's pre-frame `AudioContext` freeze — and with `glyph: 'none'` and a param-derived hero picture there is no live tap to be nondeterministic. Derive it the analogVco way anyway (10 separate processes, unmasked): a singleton that is `undeletable` cannot be removed from a scene if it turns out to flake. |
| **e2e** | +1 `faces-parity` row, **7 cells** (6 params + 1 panel). ≈ +13 s. ⚠ `maxInstances = 1` and `undeletable` — the parity harness must spawn it as the rack's *existing* singleton, not a second copy. |
| **the bottom line** | The module the whole rack depends on, and the two facts it most needs to state (STOP vs MUTE, and the multiplier deficit) are both currently unstatable anywhere in the UI. |
