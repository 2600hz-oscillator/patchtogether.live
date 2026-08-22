# batch-22 G3 — corrections to the banked derivation

`.myrobots/2026-08-21-batch-22-video-thin-tail-derivation.md` is **untracked** —
it exists only in the primary checkout, so it cannot be corrected from a
worktree and a future session may well read the stale version. This file is
committed precisely so the stale claims cannot bite unopposed. **Where the two
disagree, this file is later and was verified against the tree.**

## 1. ⚠ "onetonine.showGrid — declare the toggle in the FACE, leave the def alone" is NOT EXECUTABLE

The banked decision record says to declare the toggle at face level and keep the
def's `curve: 'linear'`, leaving #2090 open as a deferred record.

**There is no face-level toggle mechanism.** Every `ModuleFace` field was
enumerated: `paramCells` is `'grid' | 'color' | 'hue' | 'fader'`, and
`momentary` means a rising-edge press-pad, which this is not. A latching toggle
resolves *only* from the param's own shape:

```ts
looksLikeToggle = p.curve === 'discrete' && p.min === 0 && p.max === 1
```

`showGrid` was `0..1 linear`, so that returns **false** and the face would have
drawn a 2-state param as a **KNOB** — the moog962 inert-control defect, where
most of the sweep does nothing and the player cannot reliably land on a state.

**Resolution (coordinator-approved, 2026-08-22): retype to `discrete` and close
#2090 with the PR.** The issue's refusal premise was *"no consumer reads
`curve`"* — true while the module was card-only, because the card draws a
`<button>` regardless. **Facing the module creates the consumer.** The retype is
therefore load-bearing rather than gate-greening, which is the exact condition
#2090 said would have to change first.

Behaviour is preserved, verified at the read site rather than assumed:
`gridOn()` thresholds at `params.showGrid >= 0.5` and discrete snapping rounds
to nearest, so `0.7 → 1 → ON` and `0.3 → 0 → OFF` both match; the `0.5` tie
rounds up, matching the `>=`. Stronger still, `node.data.showGrid` (a real
boolean) takes **precedence** over the param, so any rack that ever touched the
card is unaffected regardless.

## 2. ⚠ G3 is NOT a zero-attest group — three of its four modules move the hash

The derivation treats G3 as ordinary. It is not:

| module | why the hash moves |
|---|---|
| `posterbox` | `depth` gains an `options` roster (names like `1-bit`, `5-6-5`) |
| `tiler` | `tile` gains an `options` roster (`off`, `2×2`, …) |
| `onetonine` | `showGrid` retyped `linear` → `discrete` |
| `sourcery` | **free** — knob-drawn, no roster, no retype |

`params` is in the WebGL content basis; `face`, `docs`, `paramCells` and
`noUserControl` are not.

## 3. ⚠ A FADER CANNOT SHOW NAMES — a discrete roster is a selector, not a stepped fader

This one cost a gate failure and is worth banking. Both `posterbox.depth` and
`tiler.tile` are drawn on their CARDS as stepped faders with named tick rails,
so declaring `paramCells: 'fader'` looked like straight parity.
`module-face-lint` refused it on two counts:

> a throw needs a CONTINUOUS param … **a fader cannot show names** — it would
> render the roster as unlabelled detents on a scale. Drop one of the two
> declarations.

So the platform's rule is: **a discrete param carrying an `options` roster
belongs on a segmented row / selector / grid**, all of which name their states.
The face's primitive therefore differs from the card's here, and the NAMES are
what survive — which is the correct trade, since the names are the entire reason
the roster (and its attest cost) exists. The tick rail was a card-only way of
showing the same information.

**Generalisation for later batches:** "declare the primitive the card drew" is
right for *continuous* controls, and is **not** a licence to declare `fader` on
a discrete param. Check the param's curve before reaching for `paramCells`.

## 4. Card-shape re-derivation at current main (the drift rule), for the record

| module | params | card primitive |
|---|---|---|
| `posterbox` | 3 | `NeonFader` ×3 (`depth` stepped, named tick rail) |
| `tiler` | 1 | `NeonFader` with named tick rail |
| `sourcery` | 4 | `Knob` ×4 |
| `onetonine` | 1 | `<button>` GRID ON/OFF |

None of the four reads a clock — zero `uTime` / `frame.time` / `ctx.time` /
`performance.now()` between them — so every VRT scene settles without a `freeze`
param or a `simPin`. All four were already in `STRICT_DOCS` with `docs` blocks,
so there was no boy-scout debt in this group.
