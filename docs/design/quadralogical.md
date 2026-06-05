# QUADRALOGICAL — 4-input XY video mixer (Phase 2)

Status: **shipped**. Source of truth for the module's behaviour. Code:
`packages/web/src/lib/video/modules/quadralogical.ts` (engine + shaders + pure
helpers) and `packages/web/src/lib/ui/modules/QuadralogicalCard.svelte` (card).
Tests: `packages/web/src/lib/video/modules/quadralogical.test.ts` (pure unit),
`e2e/tests/quadralogical.spec.ts` (functional e2e),
`e2e/vrt/vrt-quadralogical.spec.ts` (composite-state VRT scenes).

## TL;DR

QUADRALOGICAL is a four-input video mixer steered by a single XY joystick. Each
of the four inputs anchors a corner of the pad; the joystick position decides how
much of each input you see. The headline of Phase 2: instead of one global
"transition" applied everywhere, **each of the four EDGES of the joystick has its
own effect** (DISSOLVE / ADD / MULTIPLY / WIPE / CHROMA / LUMA / DIFF / IRIS),
its own controls, and its own CV inputs. Drag toward an edge and you get that
edge's pair of inputs blended through that edge's effect; sit in the middle and
all four edge-blends composite together.

```
 IN1 (TL) ────── EDGE 1–2 ────── IN2 (TR)
   │                                  │
 EDGE 4–1                         EDGE 2–3
   │                                  │
 IN4 (BR) ────── EDGE 3–4 ────── IN3 (BL)
```

(Geometric note: the four effect slots are the INDEX cycle 1→2→3→4→1, so edge
"2–3" pairs IN2 with IN3 — which on the pad is the TR↔BL diagonal, not a visual
side. The slots are named by input index, which is what a patcher reasons about.
See *The edge cycle* below.)

---

## 1. The joystick weight model

The joystick `(pos_x, pos_y)`, each in `[-1, +1]`, maps to four **corner
weights** `[w1, w2, w3, w4]` that always sum to 1. The corner→input map is:

| Joystick      | Corner | Input |
| ------------- | ------ | ----- |
| `(-1, +1)`    | TL     | IN1   |
| `(+1, +1)`    | TR     | IN2   |
| `(-1, -1)`    | BL     | IN3   |
| `(+1, -1)`    | BR     | IN4   |

The base is a **bilinear** interpolation over the unit square
(`u = (x+1)/2`, `v = (y+1)/2`):

```
b1 = (1-u)·v     b2 = u·v
b3 = (1-u)·(1-v) b4 = u·(1-v)
```

which already gives every corner (one input at 100%), every side (two inputs),
and the center (all four equal). On top of that there's a **diamond-aware
power-sharpening** so the blend stays a soft 4-way mix inside the inner diamond
but snaps to a crisp 2-input region once you push past it toward a side:

```
m = |x| + |y|                  L1 distance from center
t = smoothstep(margin, 1, m)   0 inside the diamond, ramps to 1 at the inscribed square
p = 1 + K·t                    sharpening exponent
si = bi^p                      sharpen each bilinear weight
wi = si / Σ sj                 renormalize (+1e-6 guard at exact corners)
```

- `diamond_margin` (default **0.5**) is the half-diagonal of the inner diamond —
  i.e. the `|x|+|y| ≤ margin` "all-four-composite" zone. The yellow diamond drawn
  on the card is laid out to be **1:1** with this value.
- `blend_sharp` (default **3**) is `K`, the sharpening strength outside the
  diamond.

This math lives in the pure TS helper `quadWeights(x, y, margin, K)` AND is
mirrored **bit-for-bit** inline in the mix shader (`MIX_FRAG_SRC`'s `quadWeights`
GLSL function), so the card's live dot, the drawn diamond, and the rendered
output all agree to the number. The unit suite locks the partition-of-unity,
corner one-hot, side 2-input, center balance, and diamond-zone invariants.

---

## 2. The eight per-edge effects

Every effect is a real 2-input blend `effect(a, b, t, params)` where `a` and `b`
are the two adjacent inputs of that edge and `t` is the within-edge mix ratio
(0 = pure `a`, 1 = pure `b`; see §3). The same math runs as the pure TS reference
`blend2(...)` and as the GLSL `blend(...)` — `blend2` is what the unit tests pin,
the shader is the rendered truth.

| #   | Name      | What it does                                                                 | `amount`         | `param`        |
| --- | --------- | ---------------------------------------------------------------------------- | ---------------- | -------------- |
| 0   | DISSOLVE  | Linear cross-dissolve `mix(a, b, t)`                                          | —                | —              |
| 1   | ADD       | Additive / screen: `a + b·t·amount` (clamped)                                | amount of `b`    | —              |
| 2   | MULTIPLY  | Darken: fades `a → a·b` over `t·amount`                                       | depth            | —              |
| 3   | WIPE      | Directional hard/soft wipe; the wipe line tracks `t`                          | angle (×2π)      | softness       |
| 4   | CHROMA    | HSV hue-distance key: keys the key-colour OUT of `a`, revealing `b`          | threshold        | softness       |
| 5   | LUMA      | Rec.601 luma key on `a`; bright/dark `a` reveals `b`                          | threshold        | softness       |
| 6   | DIFF      | Absolute difference: fades `a → \|a−b\|` over `t·amount`                       | depth            | —              |
| 7   | IRIS      | Radial wipe: an iris opens from the center as `t` (and `amount`) rises        | radius bias      | feather        |

Notes on the keyers (CHROMA / LUMA):

- **CHROMA** re-implements the same algorithm as `chromakey.ts` (RGB→HSV,
  hue-circle distance, saturation gate so gray pixels aren't keyed by noisy hue)
  — but the GLSL is **copied into this file**, never imported (the module is a
  hard-isolated unit; see the header constraint). The key colour is the shared
  `keyR/keyG/keyB` params (default green-screen green), so every CHROMA edge keys
  the same colour. `amount` is the hue-distance threshold, `param` the edge
  softness.
- **LUMA** keys `a` by its BT.601 luma. `amount` is the luma threshold, `param`
  the softness band.
- `invert` (global) flips the key alpha for CHROMA and LUMA edges.

Spatial effects (WIPE / IRIS) read the pixel UV, so their output at a given `t`
depends on where the pixel is — that's the whole point of a wipe. The unit tests
assert the spatial split (opposite UVs pick opposite inputs) rather than a pure
endpoint.

---

## 3. The edge-composite model

From the four corner weights we derive, for each edge `a↔b`, a `(mass, ratio)`
pair via the pure helper `edgeWeights(x, y, margin, K)`:

```
pair_mass_ab = w_a + w_b            how "active" the a↔b pair is
ratio_ab     = w_b / (w_a + w_b)    within-edge mix: 0 = pure a → 1 = pure b
```

Each edge runs its own effect on its two adjacent inputs at that ratio, and the
four edge-blends are **layered (composited) weighted by mass**:

```
blend_ab = effect_edge(c_a, c_b, ratio_ab, edge_params)
out      = Σ pair_mass_ab · blend_ab / Σ pair_mass_ab
```

### Why this is the right shape

This is the most faithful reading of "each adjacent pair blends, layered by
relative mix":

- **At a corner** (say TL → `w1=1`, rest 0): the two edges that touch input 1 are
  edge 1–2 (`mass = w1+w2 = 1`, `ratio = w2/(w1+w2) = 0` → pure `c1`) and edge
  4–1 (`mass = w4+w1 = 1`, `ratio = w1/(w4+w1) = 1` → pure `c1`). The other two
  edges have `mass = 0`. So `out = (1·c1 + 1·c1)/(1+1) = c1` — **the pure corner
  input**, every effect collapsing to it.
- **At the center** (all `w = 0.25`): every `mass = 0.5`, every `ratio = 0.5` — a
  perfectly **balanced composite** of the four edge-blends.
- **Continuity**: `mass` and `ratio` are continuous in the (continuous) corner
  weights. The only division risk is `ratio` as `mass → 0`, but a dead edge
  contributes 0 to the composite (its `mass` is 0), so the guarded ratio there
  never reaches the output — no jumps. The unit suite sweeps the diagonal and
  asserts a bounded per-step delta.

The four edge masses always sum to 2 (each corner weight appears in exactly two
edges), which is why we renormalize by `Σ mass`.

### The edge cycle

The four effect slots map to the **index cycle** 1→2→3→4→1:

| Slot label | Inputs | `EDGE_PAIRS` entry |
| ---------- | ------ | ------------------ |
| 1–2        | IN1↔IN2 | `[0, 1]`           |
| 2–3        | IN2↔IN3 | `[1, 2]`           |
| 3–4        | IN3↔IN4 | `[2, 3]`           |
| 4–1        | IN4↔IN1 | `[3, 0]`           |

This is a deliberate design choice: 2–3 and 4–1 are *diagonals* of the pad
geometry, not visual sides. We name the slots by input index because that's what
a patcher reasons about ("blend my two cameras", regardless of which corner they
sit in), and the cycle guarantees each corner still resolves to its single input.

---

## 4. Inputs, outputs, normalling

### Video inputs

`in1..in4` are the four channel inputs. Unpatched inputs **normal** to the
nearest lower-indexed patched input, Eurorack-style (`in4→in3→in2→in1`). So one
patched source blends against itself (never a black hole), and patching more
inputs lights up their corners independently. With nothing patched, all four bind
a 1×1 black sentinel. The resolver is the pure `normalizeInputs(present[])`
helper (unit-tested for parity with the draw-side texture binding).

### Outputs

- **`out`** (canonical surface): the joystick-weighted **MIX** — the edge
  composite. This is what the on-card preview, the default capture, and the `out`
  port emit.
- **`preview`**: a 2×2 tile of the four RAW inputs (IN1 TL, IN2 TR, IN3 BL, IN4
  BR) with a thin separator cross. The engine's `lookupInput` checks
  `read('outputTexture:preview')` before `surface.texture`, so `preview` resolves
  to the preview FBO while `out` falls through to the mix FBO.

### CV targets

Every joystick/tuning param and every per-edge control is CV-patchable; each CV
input declares `paramTarget == its own id` (PR #264 convention).

- `pos_x`, `pos_y` — joystick position.
- `diamond_margin`, `blend_sharp` — weight-model tuning.
- `edge{1..4}_amount`, `edge{1..4}_param` — the two controls of each edge's
  active effect (semantics depend on the selected effect; see the table in §2).
- `keyR`, `keyG`, `keyB` — the shared chroma key colour.

In the default (DISSOLVE-everywhere) patch the per-edge `amount`/`param` CV
inputs are valid no-ops (DISSOLVE ignores them), but they wire up correctly and
become live the moment an edge is switched to an effect that uses them — so they
need no test exemptions; the per-port sweep just confirms the cable survives.

---

## 5. The card

The card centerpiece is a large XY pad (cloned from JoystickCard) with the inner
yellow diamond drawn 1:1 to `diamond_margin`. The dot uses the same
`quadWeights()` as the shader so dragging into the diamond visibly enters the
4-way blend; a corner is a single input; a side is two. Per-axis MIDI learn is on
the pad's bespoke right-click menu (Assign/Forget X and Y).

Below the pad: the on-card MIX preview canvas, then **four per-edge effect
slots** laid out 2×2 (EDGE 1–2 / 2–3 / 3–4 / 4–1). Each slot has an 8-mode
dropdown and that effect's two control faders, re-labelled per the selected
effect (e.g. WIPE shows *Angle* + *Soft*, IRIS shows *Radius* + *Feather*,
DISSOLVE shows "pure dissolve (joystick ratio)" with no faders). When any edge is
set to CHROMA, a shared **CHROMA KEY** R/G/B fader row appears at the bottom.

## 6. Determinism / VRT

`freeze` (hidden param) makes `draw()` a no-op, holding both FBOs on their last
frame. The composite-state VRT scenes feed real test signals (LINES + CHROMA
colour sources) into the four inputs, set the joystick to a position that
exercises a target edge, select that edge's effect, then `freeze` + suspend the
AudioContext for a pixel-stable capture — one representative scene per effect.

## 7. Hard isolation constraint

QUADRALOGICAL is a fully self-contained unit. It MUST NOT import or reference
TOYBOX / B3NTB0X code, nor `chromakey.ts` / `lumakey.ts`. Any shared algorithm
(the chroma/luma keying) is **re-implemented as GLSL text + TS** inside the
module — never imported. This keeps the module independently evolvable while
other agents work the TOYBOX family.
