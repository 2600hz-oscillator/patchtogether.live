# FACE SPEC — `unityscalemathematik` (batch 5)

> ⚠ **PLATFORM CORRECTIONS SINCE THIS WAS WRITTEN — 2026-08-12 janitorial sweep.**
> - **PF-22 freed the hero rank** (#1480): `face.hero.cell` no longer consumes a
>   LANE rank, so a `panel` may now rank FIRST. Any argument below that a module
>   cannot be faced because a panel's first legal rank is 7 is OBSOLETE.
> - **A card↔face PRIMITIVE-PARITY gate now exists** (#1480,
>   `card-primitive-parity.test.ts`): ranking a param whose card binds it to a
>   primitive the platform has no cell kind for now FAILS, naming the
>   `(module, param, primitive)` triple. `XyPad` and `NoteEntry` are the two
>   declared gaps.
> - **The faceplate pipeline is PAUSED by owner directive.** This spec is BANKED,
>   not cancelled and not blocked.


## 0. STATUS

**Authored 2026-08-10. Every claim below was measured or read against `main`**
(`153e5c36`). Nothing here is implemented; no def, card or DSP file is touched.

## **Verdict: NO FACE ON MERIT.**

**All five controls are live, all three channels are perfectly orthogonal, every
tier renders the identical five cells, and the one asymmetry worth knowing
(UNITY has no CURVE) is a one-line doc fix, not a faceplate.** This is the
`noise` verdict, reached the same way: by measuring first and finding nothing a
picture could add.

It is in the batch **because the batch needed a real negative**, and because the
measurement produced two things that ARE worth keeping: a confirmed
three-channel orthogonality proof, and the instrument warning in §3.

archetype: **the BIPOLAR CV SHAPER** — a UNITY scaler plus two attenuvert
sections with curve.

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS`; **not** in
`STRICT_VRT_MODULES`; **not** in `PUSH_CARD_CONTROLS`. 5 params, 8 in, 3 out.
contract-lock = **17 lines**.

**Method.** REAL factory (pure Web Audio nodes, no worklet) under
`node-web-audio-api`'s `OfflineAudioContext`, 48 kHz, the same 8 Hz / 0.8 sine
into all three inputs so the three channels are directly comparable.

---

## 1. THE MEASUREMENT

*Measured*, all three inputs identical, tail 70 % of a 0.5 s render. Base:
`u_out` = `a_out` = `b_out` = peak 0.800, rms −4.88 dB — the three channels are
**identical at the defaults**, as they should be.

| swept | `u_out` | `a_out` | `b_out` |
|---|---|---|---|
| `unityAtten` −1 → +1 | **−4.88 / −10.90 / −240.00 / −10.90 / −4.88 dB** | Δ 0.00e+0 | Δ 0.00e+0 |
| `aAtten` −1 → +1 | Δ 0.00e+0 | **−4.88 / −10.90 / −240.00 / −10.90 / −4.88** | Δ 0.00e+0 |
| `bAtten` −1 → +1 | Δ 0.00e+0 | Δ 0.00e+0 | **−4.88 / −10.90 / −240.00 / −10.90 / −4.88** |
| `aCurve` 0 → 1 | Δ 0.00e+0 | **−4.88 → −10.72 dB**, peak 0.800 → 0.512 | Δ 0.00e+0 |
| `bCurve` 0 → 1 | Δ 0.00e+0 | Δ 0.00e+0 | **−4.88 → −10.72**, peak 0.800 → 0.512 |

**Three perfectly orthogonal channels.** Every off-diagonal cell is
`Δ = 0.00e+0` — bit-exact, not approximate. Every attenuverter is
bit-exactly silent at 0 (−240.00 dB) and symmetric about it. Both curves are
monotonic and identical to each other (−5.84 dB over their full travel, peak
0.800 → 0.512).

Nothing here is broken. Nothing here is surprising. That is the finding.

---

## 2. THE ONE ASYMMETRY, AND WHY IT IS NOT A FACE

**`unityAtten` has no `unityCurve`.** Sections A and B each get an attenuverter
*and* a curve; the UNITY section gets only the attenuverter. It is a real
asymmetry, it is worth a sentence in `docs.explanation` (which currently says
*"a UNITY scaler (input × atten) plus two attenuvert sections (A, B) whose curve
knob morphs…"* — accurate, but it never says the UNITY section lacks one), and it
is **not** something a faceplate improves. A face would draw three channel
strips, two with three controls and one with two, which is exactly what the card
already draws.

---

## 3. THE INSTRUMENT WARNING THIS MODULE EARNED — keep it, discard the face

**An attenuverter's defining behaviour is invisible to every level metric.**
*Measured*, `a_out` at `aAtten = −1` and `+1`:

| | rms dB | peak | centroid |
|---|---|---|---|
| `aAtten = −1` | **−4.88** | **0.800** | **8 Hz** |
| `aAtten = +1` | **−4.88** | **0.800** | **8 Hz** |

Identical in all three. They differ by `Δ = 1.60e+0` — exactly twice the 0.8
amplitude, i.e. a pure sign flip. **A sweep that asks "does this control do
anything?" with RMS, peak or centroid answers "no" for the one thing an
attenuverter is for.**

`illogic` in this batch measures the same way (`Δ = 1.80e+0` at ±1, identical
level statistics), and the unfaced tail holds at least four more of this shape
(`polarizer`, `depolarizer`, the `moog9xx` attenuverter family,
`attenumix`'s channels). **Any future sweep over those must use a SIGNED
comparison.** That is the durable output of this file.

---

## 4. WHY NOT A FACE — the four tests, answered

1. **Does a player reach for it?** Occasionally — it is a CV utility, not an
   instrument.
2. **Would a face reveal something non-obvious?** **No.** Five controls, three
   orthogonal channels, no mode, no dead range, no inversion, no level
   asymmetry, nothing gated. The one asymmetry (§2) is visible on the card by
   counting knobs.
3. **Do the tiers buy anything?** **No.** `faceTierCap('full') = 6` and the module
   has **5** params, so `compact`, `full` and `dock` all render the identical five
   cells. The ranking decides `mini` only, and with three interchangeable
   channels there is no principled rank-1.
4. **Can the picture carry it?** A transfer-curve drawing would be genuinely
   nice — and it is **already generic**: the `quantise-grid` / `filter-response-
   curve` family of sidebar panels covers this shape, and if one is ever
   registered for a shaper, `unityscalemathematik` should get it as a **card**
   improvement, not as a promotion into `STRICT_FACES`.

⚠ **And the rank-7 wall makes even that impossible as a hero.** A `panel`'s first
legal rank is 7 (`module-face-lint` refuses a panel selected at a lane tier;
`faceTierCap('full') = 6`) and this face would have **5** keys, so a `hero.cell`
is unreachable. The picture could only ever be a sidebar `custom` block — i.e.
the thing a faceplate adds here is a sidebar, and the module does not need a
promotion to get one.

---

## 5. WHAT TO DO INSTEAD

- **A · one sentence in `docs.explanation`**: the UNITY section has no CURVE
  (§2). `unityscalemathematik` is in `STRICT_DOCS`; this is a `task docs:accept`
  away.
- **B · `UnityscalemathematikCard.svelte` re-types 10 literal range props** in
  68 lines, and the module is **not** in `RANGE_BOUND_CARDS`. Add it — the card
  is small enough that binding the ranges to the def is a fifteen-minute change,
  and it is the cheapest `card-range-source` enrolment available anywhere in this
  batch.
- **C · keep §3** — fold the signed-comparison warning into whatever sweeps the
  attenuverter tail next.

**Cost of the face avoided: 4 VRT baselines, a 5-cell `faces-parity` row, and a
`STRICT_FACES` entry that would have to be maintained forever.** The `noise`
precedent says that is a real saving and worth writing down.
