# cellshade — the BANDS roster: decided, and why the first answer was wrong

A parked branch (`worktree-agent-a8c2faa3362df5eea`, commit `d25345768`, based on
`a216ff243`) carried a cellshade face from ~2026-08-11 with this question still
open. **It is now decided.** This file exists so the parked branch's framing
cannot resurface — if you find that branch, prefer this.

## The decision

**Declare an `options` roster on `bits`, with labels promoted from
`CELLSHADE_BAND_STEPS`.** It costs a real-GPU re-attest, and it is required
rather than optional.

## The reasoning, including the wrong first answer

The rule in play was: *promote names that ALREADY EXIST in the code; if no names
exist, the roster is invented — ship WITHOUT it.*

**First answer (WRONG): "no names exist, ship without."** `CELLSHADE_BAND_STEPS`
is `readonly number[] = [2, 3, 4, 6, 8]` — no `name` field, no names array, and
the card's only text is a computed `{bands} BANDS` readout. On that reading the
roster looked invented.

**Two things overturned it.**

1. ⚠ **Shipping without the roster is not neutral — it is a WRONG accessible
   value.** Verified at the read site, not taken from the parked branch's prose:
   `NeonFader`'s `readoutText` is `formatValue ? formatValue(v) : format(v, units)`
   and it feeds `aria-valuetext`. `bits` stores an **index 0..4**; the player is
   choosing a **band count 2/3/4/6/8**. `CellshadeCard.svelte` bridges the two
   with a `formatValue` prop and a labelled tick rail — **card-side props
   `ModuleShell` does not pass**. So an undeclared `bits` makes the faceplate
   ANNOUNCE THE INDEX: it says "2" while the picture shows FOUR bands. That is a
   wrong number, not a missing one, and it flips the default.

2. ⚠ **"No names exist" was the wrong test.** `TILER_STEPS` has no `name` field
   either — it is `{total, cols, rows}` numbers — and `tiler`'s roster labels are
   built as `${cols}×${rows}`. Deriving a label from existing structured data is
   **promotion**; invention would be adding words that appear nowhere, e.g.
   naming these bands "coarse"/"fine". `CELLSHADE_BAND_STEPS` is the array the
   shader's quantiser indexes, so its values are the module's own data.

## Why it survives the no-resting-text ruling

The permitted case is a declared option **NAME** that disambiguates a control's
own position; the forbidden case is a number that **restates the dial**. Here the
dial's position is the **INDEX** and the label is the **BAND COUNT** — different
quantities, so the label says something the control does not. Same argument as
`tiler`.

⚠ Note what is NOT ported: the card's `{bands} BANDS` readout. That is exactly
the resting derived text the 2026-08-17 ruling removes. The count reaches the
player as the option label instead.

## Cost

`params` is in the WebGL content basis (`face`, `paramCells` and `docs` are
not), so the roster moves the attest hash — the full staged-handoff protocol
applies. ⚠ The **contract-lock diff is EMPTY**: `options` is not recorded there
and the curve was already `discrete`. So this is a case where the attest moves
while the contract does not, which is worth knowing before someone concludes
from a clean `docs:accept` that nothing changed.

## Rebuilt, not resumed

The parked commit predates the readout, width, `EXTENSION_BODY_ROLES` and
switch-classification gates, and marked itself UNVERIFIED. Everything was
re-derived against current main: 6 params, card draws 6 × `NeonFader` / 0 `Knob`,
no `hideControls` (so no MONITOR mode), already in `STRICT_DOCS` with `docs`, and
zero clock references (so the VRT scene needs no `freeze` param or `simPin`).
