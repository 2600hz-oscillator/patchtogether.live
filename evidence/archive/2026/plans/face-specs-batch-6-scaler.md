# FACE SPEC — `scaler` (batch 6)

> **Two owner rulings, 2026-08-11, apply to this file** (verbatim at
> `rings.ts:585-590` and `:645-650`): *"we should prefer almost zero AI authored
> text, and all future faceplate work should reflect that"* and *"lets stop
> doing these and clean up the existing ones, get rid of them. lose the signal
> flow diagrams."* Every proposed `hint` and the `signal-flow` sidebar block have
> been **deleted** from §5; their measured content is in §2/§4/§8. Do not
> re-author them. Measurements belong in `docs.controls` (the `rings.ts:592-596`
> precedent), not on the panel.

## 0. STATUS

**Authored 2026-08-11 against `main` at `52e3d882`. UNBUILT** — no `face:` block.
Every number below was measured against the real engine.

**Verdict: PROMOTE — the cheapest face in the programme, on the strength of TWO
derived readouts. The third readout, the one that matters most, is NOT BUILDABLE
today; §6 names the platform widening rather than faking it.**

archetype: **the trim.** One knob, one in, one out, no DSP.

Not in `STRICT_FACES`. In `STRICT_DOCS`. In `STRICT_VRT_MODULES`
(`vrt-exemptions.ts:1081` — the **required** `vrt-strict` gate). Not in
`DOCKABLE_TYPES`, not in `PUSH_CARD_CONTROLS`, not in
`card-range-source.test.ts`. `rack-sizes.ts:123` — `1u / hp 1`, 160×150 px.
**1 param, 1 input, 1 output, 4 lines of `contract-lock.txt`** — the smallest
control surface in the repo.

**Method.** No worklet and no Faust: the shipping engine IS one `GainNode`
(`scaler.ts:90-105`). Driven through a real `OfflineAudioContext`
(`node-web-audio-api`) at 48 kHz with the same `setValueAtTime` write the factory
uses. **Determinism control: two identical renders bit-equal — `true`.**

---

## 1. THE CONTRACT — all four lines

```
scaler meta domain=audio
scaler in  in  audio accepts=cv,gate,pitch
scaler out out audio adopts=in
scaler param amount 0.1..10 log default=1
```

| kind | id | detail |
|---|---|---|
| param | `amount` | label `AMOUNT`, **0.1 .. 10, log, default 1.0**, no `units` field on the def (the card supplies `units="x"` as a literal). |
| input | `in` | `audio`, **widened** with `accepts: ['cv','pitch','gate']` — the SCOPE-probe pattern. |
| output | `out` | declared `audio`, **`adoptsUpstreamFrom: 'in'`** — the EMITTED cable type is whatever is patched into `in`; `audio` is only the unpatched fallback. |

**No CV input.** `amount` cannot be modulated by anything. Deliberate
(`docs.explanation`: *"unlike a VCA it has no CV input — it is a fixed,
set-and-forget trim"*) and the single largest structural fact about the module:
every other utility in its family carries one.

**No control families, no `node.data`, no switch-shaped params**, therefore no
`paramCells`, no `momentary`, and **no `ACKNOWLEDGED_LATCHING` entries**.

---

## 2. MEASURED

### A · The gain law, and where unity sits

The `log` curve is `frac = ln(v/min) / ln(max/min)`, inverse
`v = min · (max/min)^frac` (`knob-conic-model.ts:42, :66`), over a 270° arc
(`KNOB_ARC_DEG`). Measured through the real `GainNode` with a 0.5 sine in:

| `amount` | frac | arc° | dB | measured peak | measured dB |
|---|---|---|---|---|---|
| 0.1 | 0.0000 | −135.0 | −20.00 | 0.050000 | −20.000 |
| 0.316 | 0.2498 | −67.5 | −10.01 | 0.158000 | −10.006 |
| 0.5 | 0.3495 | −40.6 | −6.02 | 0.250000 | −6.021 |
| **1.0** | **0.5000** | **0.000** | 0.00 | 0.500000 | 0.000 |
| 2 | 0.6505 | +40.6 | +6.02 | 1.000000 | +6.021 |
| 3.16 | 0.7498 | +67.5 | +9.99 | 1.580000 | +9.994 |
| 10 | 1.0000 | +135.0 | +20.00 | 5.000000 | +20.000 |

**Unity sits at frac 0.500000 → arc 0.000° — the exact knob centre.** The taper
is **0.1481 dB per degree, uniform** (`10^(2/270)` = ×1.01720 per degree), so the
control has the same resolution everywhere: half the travel cuts (−20 … 0 dB),
half boosts (0 … +20 dB), **40 dB total**.

### B · No dead zone anywhere — and the NEGATIVE RESULT is the finding

The full 270° arc swept in 1° steps (271 renders), each compared to its
neighbour:

| | |
|---|---|
| adjacent-degree pairs rendering **bit-identically** | **0 of 270** |
| smallest non-zero adjacent move (the **quantisation floor**) | **8.601e-4** |

No plateau of any width, so the plateau-to-floor ratio the clouds finding turned
on does not exist here. Recorded because **a spec that only ever prints dead
controls is not measuring** — this one is alive over its whole travel.

### C · It can only multiply

| input peak | `amount` | output peak |
|---|---|---|
| 1.00 | ×2 | **2.0000** |
| 1.00 | ×10 | **10.0000** |
| 0.50 | ×10 | **5.0000** |
| 0.10 | ×10 | 1.0000 |

Nothing limits, soft-clips or warns. **Any input hotter than −20 dBFS clips at
full boost**, and that threshold is a pure function of `amount` — which is what
§4-B turns into a readout.

### D · The write is a hard step, and the family it belongs to

`setParam` calls `gain.gain.setValueAtTime(value, ctx.currentTime)`
(`scaler.ts:104`) — no ramp, no `setTargetAtTime`, no smoothing. Measured
sample-to-sample discontinuity at the write, against the signal's own worst
natural step:

| move | worst jump | × the natural slew |
|---|---|---|
| ×1 → ×2 | 0.05759 | 2.0× |
| ×1 → ×10 | 0.28794 | 10.0× |
| **×0.1 → ×10** | **0.28794** | **100.0×** |

⚠ **HOUSE PATTERN, not a scaler defect.** Grepped: `polarizer.ts:100`,
`depolarizer.ts:103`, `attenumix.ts:221` and `moog995.ts:108` all use
`setValueAtTime`; the SMOOTHED modules (`mixer`, `vca`) are Faust and get
`si.smoo` (~23 ms one-pole) for free. Scaler-specific is only the *magnitude*: it
is the one member of the pure-gain family that can **boost**, so its worst step
is 100× the natural slew where an attenuator's is bounded by 1×. A one-line
`setTargetAtTime` across five modules plus an owner audition — **not a face PR**.

---

## 3. WHAT A FACE ADDS OVER THE CARD

`ScalerCard.svelte` is 91 lines: a title, a `PatchPanel`, and one `<Knob>` whose
`min` / `max` / `defaultValue` come **from the def** (`def('amount').min`, etc.).

**Does NOT add:** curation (one param — `face.order` is `['amount']`, no tier
shows a subset, no ranking decision exists); a rear (two ports, the derivation is
already right); a better lane tile (160×150 card vs a 192×180 shell tile — a wash).

**DOES add — two things, plus one it cannot:**

1. **The dB, which the knob structurally cannot print.** The card shows
   `2.50 x`. A mixing decision is made in dB, and a *log* fader over a multiplier
   is precisely the case where the printed number and the mental model differ
   (§4-A).
2. **The clip threshold, which nothing anywhere states.** `−20·log₁₀(amount)` is
   the input level at which output reaches full scale — `0.0 dBFS` at the shipped
   default, **−20.0 dBFS** at ×10. A player who sets ×10 has silently declared
   that anything above −20 dBFS clips downstream, and no surface says so (§4-B).
3. **⚠ The emitted cable type — THE ONE FACT THAT MATTERS, NOT BUILDABLE TODAY.**
   `out` carries `adoptsUpstreamFrom: 'in'`, and the def's header records why: a
   hard-`audio` output made SCALER's scaled CV saturate through the audio→video
   bridge's RMS envelope follower, *"and the AMOUNT knob had ZERO effect at a
   video destination (the 'dead knob' bug)"* (`scaler.ts:28-37`). The module's
   defining behaviour is that **the same knob means something different depending
   on what is patched upstream** — and neither card nor face can say which mode
   you are in. Not buildable because `FaceReadoutValue` is params-only. §6 names
   the widening.

**PROMOTE, cheaply, for readouts 1 and 2 — and record readout 3 as the reason to
revisit.** Both numbers are true facts the control cannot show; the cost is the
floor (§7).

---

## 4. DERIVED READOUTS

### A. `scaler-gain-db`

`20·log₁₀(amount)`, printed beside the multiplier: `×2.50 · +7.96 dB`. At the
default: `×1.00 · 0.0 dB`.

**NEGATIVE CONTROL — the LOG FADER FRACTION.** On a log taper the arc fraction and
the dB are *linearly related* (frac 0.5 ↔ 0 dB, frac 0.75 ↔ +10 dB), so a readout
echoing `frac × 40 − 20` would be numerically correct and still a relabelled
knob. The assertion that separates them: feed `amount = 3.16` and require
**+9.99 dB**, not +10.00 — the measured value from `20·log₁₀(3.16)`, which the
fraction form cannot produce. **SECOND LEG:** `amount = 1` prints exactly
`0.0 dB`, `amount = 0.1` exactly `−20.0`.

### B. `scaler-clip-at`

The input level at which the output reaches full scale: `−20·log₁₀(amount)` dBFS.
Prints `clips above −20.0 dBFS` at ×10, `clips above 0.0 dBFS` at unity, and
**`cannot clip`** for any `amount ≤ 1`.

Anchored on §2-C: 0.5 in at ×10 → 5.0000 out; 0.1 in at ×10 → 1.0000 out exactly
— the threshold is 1/amount, confirmed at the boundary.

**NEGATIVE CONTROL — the CUT half of the dial.** Sweeping `amount` 1.0 → 0.1 must
leave the readout on `cannot clip` throughout: a readout that kept printing a
falling threshold would be arithmetically consistent and would be warning about a
hazard that does not exist. **The readout must go *silent*, not just move.**
**SECOND LEG:** ×2 → `−6.0 dBFS`, ×10 → `−20.0 dBFS`.

### C. `scaler-emitting` — NOT BUILDABLE, named so it is not quietly dropped

Would print `emitting: cv` / `emitting: audio (nothing patched)`. Needs the
resolved upstream type of the edge into `in`. See §6.

---

## 5. THE FACE

```ts
face: {
  title: 'Trim',

  order: ['amount'],

  pages: [
    { id: 'trim', label: 'trim', controls: ['amount'] },
  ],

  // `scope` resolves to live-audio on `out` (the only audio-typed output), so
  // it is a real trace rather than the {kind:'static'} fallback. Flat on an
  // unpatched rack — honest here: an insert with nothing in it IS outputting zero.
  glyph: 'scope',

  hero: {
    control: 'amount',
    readouts: [
      { label: 'gain',  valueId: 'scaler-gain-db' },
      { label: 'headroom', valueId: 'scaler-clip-at' },
      { label: 'cv',    text: 'OUT adopts the cable patched into IN' },
    ],
  },
}
```

**Cell arithmetic: 1 param, 0 families = 1 cell.** `hero.control` promotes
`amount` out of the `trim` band, **which empties it** — so the `_shell-faces.ts`
row is `{ type: 'scaler', pages: 0 }` if `heroFacePlan` drops an emptied band, and
`pages: 1` if it does not. **Verify in a browser before authoring the row.** If an
empty band is not representable, drop `hero.control` and let `amount` stay in the
band: the hero then carries only readouts, which is still the whole value (§3).

⚠ **No `hero.cell`.** There is no picture to draw. A gain curve is a straight
line; a level meter is the `scope` glyph the face already has.

---

## 6. THE PLATFORM WIDENING THIS FACE WANTS (and does not get)

**`FaceReadoutValue` must be able to see the node's RESOLVED EMITTED TYPE.** Today
it is params only (`face-readout-values.ts:149`), by design — a readout must be a
pure function so it is testable without a DOM or an engine, and that argument is
right.

The widening that preserves it: pass a second, still-pure argument — the resolved
emitted cable type of each output port, computed by the *same* derivation the
cable renderer already uses for `adoptsUpstreamFrom`, handed in as a plain string.
The reader stays a pure function of its inputs; only the input set grows.

⚠ **`analogVco` (sampleRate) and `macrooscillator` (played pitch) asked for the
same class of widening and were both deferred — so this is the THIRD independent
request, which is itself the argument for doing it once rather than three times.**

**Until then, `scaler-emitting` is a fixed `text` readout** (`'OUT adopts the
cable patched into IN'`) — true, useful, honestly static. **Do not fake it with a
param-derived value; there is none.**

⚠ **Related, and cheaper: the card's stripe is a hardcoded `var(--cable-audio)`**
(`ScalerCard.svelte:76`) on a module whose whole point is that its output type
varies. One-line card fix, no platform change.

---

## 7. COST — the floor, and worth stating because it IS the argument

| | |
|---|---|
| **contract-lock** | **+0 lines.** No new params, ports or families. `face` is contract-transparent (`contract-signature.ts` emits `id min..max curve default=X unit=Y` only). |
| **ART** | **+0 re-pins, verified rather than assumed.** `art/scenarios/scaler/profile.test.ts:82` pins `docsStrippedRepoSourceSha('…/modules/scaler.ts')`, which routes through `stripDocsForPin` → `normalizeForHash` (`scripts/attest-code-basis.ts`), and that normalizer strips the **`face`** property of a module-scope def literal. Adding `face:` leaves the `.sha` byte-identical. ⚠ **STALE INSTRUCTION CORRECTION:** PF-11 in the 2026-07-27 program doc says scaler needs a `docs-hash-ignore` wrapper around `face:`. That is **STALE** — the 2026-08-09 attest conversion made it unnecessary. **Do not re-add the marker.** |
| **shared registries** | `strict-faces.ts`, `_shell-faces.ts` (one row), `face-readout-values.ts` (2 `valueId`s). **No** `shell-cells.ts` entry, **no** `ACKNOWLEDGED_LATCHING`, **no** `module-manifest` change. Four files. |
| **VRT** | +`face-scaler-{compact,dock}` = **2 baselines**, linux-authored. ⚠ The existing `vrt.spec.ts/scaler.png` is in **`STRICT_VRT_MODULES`** — if the card is touched at all (e.g. the §6 stripe fix) it moves a REQUIRED baseline, so keep the card edit out unless it is wanted. |
| **e2e** | +1 `faces-parity` row at **1 cell** → derived budget 30 000 + 600 = **30.6 s** (46.8 s under `SLOW_RENDER`). The FIXED cost of any face row; scaler adds essentially nothing on top. Well under the ~2 min flag. |
| **existing coverage it must not break** | `e2e/tests/scaler-cv-passthrough.spec.ts` drives the CV-through-the-scaler path §3-3 is about. |
| **the bottom line** | Four files, two baselines, ~31 s of CI, zero contract and zero ART movement. The lowest-cost promotion available. |

---

## 8. ALREADY-WRONG

- **A · the emitted cable type is invisible everywhere** (§3-3, §6). The module's
  own header calls type-adoption the fix for a real "dead knob" bug; nothing in
  the UI reports which side of it you are on, and **the card's stripe actively
  asserts `audio`** (`ScalerCard.svelte:76`) — a one-line fix needing no platform
  change.
- **B · `amount` cannot be modulated** — no CV input, no `paramTarget`. Stated in
  `docs` as a deliberate distinction from a VCA; **worth an owner check** now that
  `scaler` is routinely used on CV lines, because "a fixed trim" and "the only
  gain stage on a CV chain" are different jobs.
- **C · the write is a 100×-natural-slew step at the extremes** (§2-D). A
  five-module family fix, not a scaler fix, and not a face PR.
- **D · nothing limits above unity** (§2-C). ×10 on a full-scale input leaves at
  10×. §4-B is the face's answer.
- **E · `scaler` is not in `card-range-source.test.ts`** — but unusually, the card
  is already bound to the def for `min`/`max`/`defaultValue`
  (`ScalerCard.svelte:54-56`). Only `curve="log"` and `units="x"` are literals, and
  `units` has no def field to disagree with. **Enrolling it is a two-line
  boy-scout move** that makes the binding a checked property instead of a
  coincidence, and it costs no VRT movement because it changes no pixels.
