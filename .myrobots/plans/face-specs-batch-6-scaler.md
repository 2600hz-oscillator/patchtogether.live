# FACE SPEC — `scaler` (batch 6)

## 0. STATUS

**Authored 2026-08-11 against `main` at `52e3d882`.** Nothing here is
implemented. Every number below was measured against the real engine.

**Verdict: PROMOTE — the cheapest face in the programme, on the strength of TWO
derived readouts. And the third readout, the one that matters most, is NOT
BUILDABLE today; the spec names the platform widening it needs rather than
faking it.**

archetype: **the trim.** One knob, one in, one out, no DSP.

Not in `STRICT_FACES`; **no `face:` block**. In `STRICT_DOCS`. In
`STRICT_VRT_MODULES` (`vrt-exemptions.ts:1081` — the **required** `vrt-strict`
gate). Not in `DOCKABLE_TYPES`, not in `PUSH_CARD_CONTROLS`, not in
`card-range-source.test.ts`. `rack-sizes.ts:123` — `1u / hp 1`, 160×150 px.
**1 param, 1 input, 1 output, 4 lines of `contract-lock.txt`** — the smallest
control surface in the repo.

**Method.** There is no worklet and no Faust: the shipping engine IS one
`GainNode` (`scaler.ts:90-105`). Driven through a real `OfflineAudioContext`
(`node-web-audio-api`) at 48 kHz with the same `setValueAtTime` write the
factory uses. **Determinism control: two identical renders bit-equal — `true`.**

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

**No CV input.** `amount` cannot be modulated by anything. That is deliberate
(`docs.explanation`: *"unlike a VCA it has no CV input — it is a fixed,
set-and-forget trim"*) and it is also the single largest structural fact about
the module: every other utility in its family carries one.

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

**Unity sits at frac 0.500000 → arc 0.000° — the exact knob centre**, which the
def's header claims and which is now measured rather than argued. The taper is
**0.1481 dB per degree, uniform** (`10^(2/270)` = ×1.01720 per degree), so the
control has the same resolution everywhere: half the travel cuts (−20 … 0 dB),
half boosts (0 … +20 dB), **40 dB total**.

### B · No dead zone anywhere — and both numbers, not one

The full 270° arc swept in 1° steps (271 renders), each compared to its
neighbour:

| | |
|---|---|
| adjacent-degree pairs rendering **bit-identically** | **0 of 270** |
| smallest non-zero adjacent move (the **quantisation floor**) | **8.601e-4** |

There is no plateau of any width, so the plateau-to-floor ratio the clouds
finding turned on does not exist here. Reported because a spec that only ever
prints dead controls is not measuring — this one is alive over its whole travel
and the negative result is the finding.

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
sample-to-sample discontinuity at the moment of the write, against the signal's
own worst natural step:

| move | worst jump | × the natural slew |
|---|---|---|
| ×1 → ×2 | 0.05759 | 2.0× |
| ×1 → ×10 | 0.28794 | 10.0× |
| **×0.1 → ×10** | **0.28794** | **100.0×** |

⚠ **This is the HOUSE PATTERN, not a scaler defect, and the spec says so
because the temptation is to report it as one.** Grepped: `polarizer.ts:100`,
`depolarizer.ts:103`, `attenumix.ts:221` and `moog995.ts:108` all use
`setValueAtTime`; the SMOOTHED modules (`mixer`, `vca`) are Faust and get
`si.smoo` (~23 ms one-pole) for free. What is scaler-specific is only the
*magnitude*: it is the one member of the pure-gain family that can **boost**, so
its worst step is 100× the natural slew where an attenuator's is bounded by 1×.
Fixing it is a one-line `setTargetAtTime` across five modules and an owner
audition, **not a face PR**.

---

## 3. WHAT DOES A FACE ADD OVER THE CARD? — the question, answered

`ScalerCard.svelte` is 91 lines: a title, a `PatchPanel`, and one `<Knob>` whose
`min` / `max` / `defaultValue` come **from the def** (`def('amount').min`, etc.)
rather than from literals. It is already one of the better-behaved cards in the
repo. So the question is real and the honest answers are short.

**What a face does NOT add.**
- **Curation.** One param. `face.order` is `['amount']`. There is no tier that
  shows a subset, no page that groups anything, no ranking decision to make.
  Every argument the faceplate platform exists to serve is vacuous here.
- **A rear.** Two ports. The derivation is already right.
- **A better lane tile.** 160×150 card vs a 192×180 shell tile with one knob and
  a glyph. A wash.

**What a face DOES add — and it is exactly two things plus one it cannot.**

1. **The dB, which the knob structurally cannot print.** The card shows
   `2.50 x`. A mixing decision is made in dB, and a *log* fader over a
   multiplier is precisely the case where the printed number and the mental
   model differ. `×2.50 · +7.96 dB` is one derived readout (§4-A).
2. **The clip threshold, which nothing anywhere states.** `−20·log₁₀(amount)`
   is the input level at which this scaler's output reaches full scale. At the
   shipped default that is `0.0 dBFS`; at ×10 it is **−20.0 dBFS**. A player who
   sets ×10 has silently declared that anything above −20 dBFS will clip
   downstream, and no surface says so (§4-B).
3. **⚠ The emitted cable type — WHICH IS THE ONE FACT THAT MATTERS AND IS NOT
   BUILDABLE TODAY.** `out` carries `adoptsUpstreamFrom: 'in'`, and the def's own
   header records why: a hard-`audio` output made SCALER's scaled CV saturate
   through the audio→video bridge's RMS envelope follower, *"and the AMOUNT knob
   had ZERO effect at a video destination (the 'dead knob' bug)"*
   (`scaler.ts:28-37`). So the module's defining behaviour is that **the same
   knob means something different depending on what is patched upstream** — and
   neither the card nor a face can say which mode you are in. The card's stripe
   is a hard-coded `var(--cable-audio)` (`ScalerCard.svelte:76`) regardless.

   **It is not buildable because `FaceReadoutValue = (read: (paramId: string) =>
   number | undefined) => string`** (`face-readout-values.ts:149`) — params only.
   No engine, no graph, no edges. The resolved type is a function of the
   incoming EDGE, which a param reader cannot see. §6 names the widening.

**So: PROMOTE, cheaply, for readouts 1 and 2 — and record readout 3 as the
reason to revisit.** A one-cell face whose whole justification is two numbers is
a thin case, and the spec states it as thin rather than dressing it up. What
tips it over is that both numbers are *true facts the control cannot show*,
which is the bar this programme set, and that the cost is the floor (§7).

---

## 4. DERIVED READOUTS

### A. `scaler-gain-db` — the same knob in the unit the decision is made in

`20·log₁₀(amount)`, printed beside the multiplier: `×2.50 · +7.96 dB`.
At the default: `×1.00 · 0.0 dB`.

**NEGATIVE CONTROL — the LOG FADER FRACTION.** The failure mode here is
specific and easy to write by accident: on a log taper the arc fraction and the
dB are *linearly related* (frac 0.5 ↔ 0 dB, frac 0.75 ↔ +10 dB), so a readout
that echoed `frac × 40 − 20` would be numerically correct and would still be a
relabelled knob. The assertion that separates them: feed the model
`amount = 3.16` and require **+9.99 dB**, not +10.00 — the measured value, from
`20·log₁₀(3.16)`, which the fraction form cannot produce. **SECOND LEG:**
`amount = 1` must print exactly `0.0 dB`, and `amount = 0.1` exactly `−20.0`.

### B. `scaler-clip-at` — the number nobody has ever seen

The input level at which the output reaches full scale:
`−20·log₁₀(amount)` dBFS. Prints `clips above −20.0 dBFS` at ×10,
`clips above 0.0 dBFS` at unity, and **`cannot clip`** for any `amount ≤ 1`
(the threshold would be positive, i.e. above full scale, so the module can only
attenuate).

Anchored on the measurement in §2-C: 0.5 in at ×10 → 5.0000 out; 0.1 in at ×10 →
1.0000 out exactly — the threshold is 1/amount, confirmed at the boundary.

**NEGATIVE CONTROL — the CUT half of the dial.** Sweeping `amount` from 1.0 down
to 0.1 must leave the readout on `cannot clip` throughout: a readout that kept
printing a falling threshold would be arithmetically consistent and would be
telling the player about a hazard that does not exist. That asymmetry — the
readout must go *silent*, not just move — is what makes it a statement about the
module rather than a rendering of the param. **SECOND LEG:** ×2 → `−6.0 dBFS`,
×10 → `−20.0 dBFS`.

### C. `scaler-emitting` — NOT BUILDABLE, and named so it is not quietly dropped

Would print `emitting: cv` / `emitting: audio (nothing patched)`. Needs the
resolved upstream type of the edge into `in`. See §6.

---

## 5. THE FACE

```ts
face: {
  title: 'Trim',
  hint:
    'out = in × amount, sample-accurate, on one GainNode. Unity sits at the ' +
    'exact knob centre; half the travel cuts to a tenth and half boosts ' +
    'ten-fold, with nothing limiting either end.',

  order: ['amount'],

  pages: [
    { id: 'trim', label: 'trim',
      hint: '×0.1 … ×10 on a log taper — 40 dB over the arc, 0.148 dB per degree, unity dead centre',
      controls: ['amount'] },
  ],

  // `scope` resolves to live-audio on `out` (the only audio-typed output), so
  // it is a real trace rather than the {kind:'static'} fallback. It is a flat
  // line on an unpatched rack — the mixer/clouds insert reason — which is
  // honest here: an insert with nothing in it IS outputting zero.
  glyph: 'scope',

  hero: {
    control: 'amount',
    readouts: [
      { label: 'gain',  valueId: 'scaler-gain-db' },
      { label: 'headroom', valueId: 'scaler-clip-at' },
      { label: 'cv',    text: 'OUT adopts the cable patched into IN' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'IN',   role: 'generator', note: 'audio · cv · pitch · gate' },
      { label: '× AMOUNT', role: 'bus', note: 'one GainNode, sample-accurate' },
      { label: 'OUT',  role: 'bus', note: 'type ADOPTED from IN' },
    ] },
    { kind: 'readouts', label: 'what it is not', entries: [
      { label: 'no CV',    text: 'AMOUNT cannot be modulated — that is a VCA' },
      { label: 'no limit', text: '×10 on a full-scale input leaves at 10×' },
      { label: 'no smoothing', text: 'the write is a step, not a ramp' },
      { label: 'taper',    text: '0.148 dB per degree, everywhere' },
    ] },
  ],
}
```

**Cell arithmetic: 1 param, 0 families = 1 cell.** `hero.control` promotes
`amount` out of the `trim` band, **which empties it** — so the
`_shell-faces.ts` row is `{ type: 'scaler', pages: 0 }` if `heroFacePlan` drops
an emptied band, and `pages: 1` if it does not. **Verify in a browser before
authoring the row.** If an empty band is not representable, drop `hero.control`
and let `amount` stay in the band: the hero then carries only readouts, which is
still the whole value (§3) and costs nothing.

⚠ **`title`, `hint` and the band `hint` paint NOTHING at rest** —
`faceAnnotations` gates all three behind annotate mode
(`dock-faceplate-model.ts:182-191`). Everything load-bearing above is in the
**hero readouts** and the **sidebar**, which paint unconditionally. On a
one-knob module that distinction is the entire design: a face whose content
lived in `hint` would be a face with no content.

⚠ **No `hero.cell`.** There is no picture to draw. A gain curve is a straight
line; a level meter is the `scope` glyph, which the face already has. Inventing
a panel here would be the bespoke-cell-that-should-be-a-readout mistake
`macrooscillator`'s §6 names.

---

## 6. THE PLATFORM WIDENING THIS FACE WANTS (and does not get)

**`FaceReadoutValue` must be able to see the node's RESOLVED EMITTED TYPE.**

Today: `(read: (paramId: string) => number | undefined) => string`
(`face-readout-values.ts:149`). Params only, by design — the header's argument
is that a readout must be a pure function so it is testable without a DOM or an
engine, and that argument is right.

The widening that preserves it: pass a second, still-pure argument — the
resolved emitted cable type of each output port, computed by the *same*
derivation the cable renderer already uses for `adoptsUpstreamFrom`, and handed
in as a plain string. The reader stays a pure function of its inputs; only the
input set grows. `analogVco`'s and `macrooscillator`'s specs asked for the same
class of widening (`sampleRate`, the played pitch) and were both deferred — so
this is the **third** independent request, which is itself the argument for
doing it once rather than three times.

**Until then, `scaler-emitting` is a fixed `text` readout** (`'OUT adopts the
cable patched into IN'`) — true, useful, and honestly static. Do not fake it
with a param-derived value; there is none.

⚠ **Related, and cheaper: the card's stripe is a hardcoded
`var(--cable-audio)`** (`ScalerCard.svelte:76`) on a module whose whole point is
that its output type varies. That is a one-line fix in the card and does not
need any platform change.

---

## 7. COST — the floor, and worth stating because it IS the argument

| | |
|---|---|
| **contract-lock** | **+0 lines.** No new params, no ports, no families. `face` is contract-transparent (`contract-signature.ts` emits `id min..max curve default=X unit=Y` only). |
| **ART** | **+0 re-pins, and this is verified rather than assumed.** `art/scenarios/scaler/profile.test.ts:82` pins `docsStrippedRepoSourceSha('…/modules/scaler.ts')`, which routes through `stripDocsForPin` → `normalizeForHash` (`scripts/attest-code-basis.ts`), and that normalizer strips the **`face`** property of a module-scope def literal. Adding a `face:` block to `scaler.ts` leaves the `.sha` byte-identical. *(PF-11 in the 2026-07-27 program doc says scaler needs a `docs-hash-ignore` wrapper around `face:` — that instruction is STALE; the 2026-08-09 conversion made it unnecessary. Do not re-add the marker.)* |
| **shared registries** | `strict-faces.ts`, `_shell-faces.ts` (one row), `face-readout-values.ts` (2 `valueId`s). **No** `shell-cells.ts` entry (no panel, no action, no selector). **No** `ACKNOWLEDGED_LATCHING`. **No** `module-manifest` change. Four files. |
| **VRT** | +`face-scaler-{compact,dock}` = **2 baselines**, linux-authored. ⚠ The existing `vrt.spec.ts/scaler.png` is in **`STRICT_VRT_MODULES`** — if the card is touched at all (e.g. the §6 stripe fix) it moves a REQUIRED baseline, so keep the card edit out unless it is wanted. |
| **e2e** | +1 `faces-parity` row at **1 cell** → derived budget 30 000 + 600 = **30.6 s** (45 000 + 1 800 = 46.8 s under `SLOW_RENDER`). That is the FIXED cost of any face row; scaler adds essentially nothing on top of it. Well under the ~2 min flag. |
| **existing coverage it must not break** | `e2e/tests/scaler-cv-passthrough.spec.ts` drives the CV-through-the-scaler path that §3-3 is about. A face does not touch it, but it is the spec that would catch a regression of the type adoption. |
| **the bottom line** | Four files, two baselines, ~31 s of CI, zero contract and zero ART movement. The lowest-cost promotion available. Its case is two numbers a knob cannot print — and a third that the platform cannot yet express, which is the more interesting half. |

---

## 8. ALREADY-WRONG

- **A · the emitted cable type is invisible everywhere** (§3-3, §6). The
  module's own header calls the type-adoption the fix for a real "dead knob"
  bug; nothing in the UI reports which side of it you are on, and the card's
  stripe actively asserts `audio`.
- **B · `amount` cannot be modulated** — no CV input, no `paramTarget`. Stated
  in `docs` as a deliberate distinction from a VCA; worth an owner check now
  that `scaler` is routinely used on CV lines, because "a fixed trim" and "the
  only gain stage on a CV chain" are different jobs.
- **C · the write is a 100×-natural-slew step at the extremes** (§2-D). A
  five-module family fix, not a scaler fix, and not a face PR.
- **D · nothing limits above unity** (§2-C). ×10 on a full-scale input leaves at
  10×. §4-B is the face's answer.
- **E · `scaler` is not in `card-range-source.test.ts`** — but unusually, the
  card is already bound to the def for `min`/`max`/`defaultValue`
  (`ScalerCard.svelte:54-56`). Only `curve="log"` and `units="x"` are literals,
  and `units` has no def field to disagree with. **Enrolling it is a two-line
  boy-scout move that would make the binding a checked property instead of a
  coincidence**, and it costs no VRT movement because it changes no pixels.
