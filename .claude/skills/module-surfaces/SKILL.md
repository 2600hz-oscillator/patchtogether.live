---
name: module-surfaces
description: Build or review module faces, ModuleShell extensions, bespoke surfaces, legacy-card parity, STRICT_FACES promotion, and face-migration cleanup. Use for any face or legacy-removal work.
---

# Module surfaces

## Establish the real state

1. Read the module def/factory, its face + extension bodies line by line, and
   its tests. (The generated face-migration inventory is gone: it tracked the
   card→face migration, which is finished — every module has a face and there is
   no card to migrate FROM. `STRICT_FACES` is the promoted set.)
2. If an active `.myrobots/` spec/mock package exists, read it as design
   evidence and re-verify every claim against the current tree. Do not delete or
   mark it consumed before the surface ships.
3. Inventory everything the legacy card lets a player do or see: params, ports,
   `node.data`, files, actions, editors, menus, component mount/destroy work,
   timers, subscriptions, registries, and child surfaces.

## Preserve runtime ownership

A def-reading gate cannot see behavior owned only by a Svelte component.
Promotion stops rendering the legacy card on normal surfaces, so component-only
behavior can disappear while every registry test stays green.

- One-shot behavior belongs in one plain TypeScript action seam called by both
  legacy and v2 surfaces.
- Ongoing behavior belongs in the module factory/runtime and must work with no UI
  mounted.
- Durable collaborative state belongs on the node/graph, not component state.
- Test the effect, not merely that a control exists or can be clicked.

`livecode` is the reference shape: its factory is intentionally inert, so RUN
was extracted from the card into one action used by the legacy card, face body,
and ranked shell cell.

## Choose the smallest honest surface

Use the existing ladder before inventing a new primitive: declarative face,
shared shell cell/panel, shell extension, then bespoke surface. Thin modules
still need faces. Do not promote when any load-bearing legacy affordance has no
reachable replacement.

A control's range comes from one place — the def — and the surface imports it.
Never re-type a bound in a card or a face; a def-reading gate cannot see a card
that widens what the contract allows, so the pads write values the model then
silently clamps. On a card whose def is in the WebGL attest basis, bind with
`paramSpec(def, id)` rather than exporting a `*_RANGE` constant: the export moves
the attest hash and the accessor does not. `card-range-source.test.ts` and
`card-control-ranges.test.ts` hold this at the source, per card.

Keep resting surfaces minimal: no descriptive/sidebar/readout text outside a
control. A video module keeps its live preview and SCREEN on/off behavior through
both legacy and v2 paths; persist that state on the node and do not stop the
producer merely because the screen is hidden.

## Promote and verify

- Add the face/surface and `STRICT_FACES` promotion together.
- Run `task face:accept`, focused parity/behavior tests, and `REPEAT=3` for
  changed tests.
- Exercise default and `?shell=legacy` paths while migration is live.
- Use the `renderer-tests` skill for visual coverage and baselines.
- Re-run the generated inventory; never type its counts into prose.
- Obtain owner visual review for a new or materially changed surface.

Do not create an issue unless the owner explicitly approves it. A PR does not
need an issue.
