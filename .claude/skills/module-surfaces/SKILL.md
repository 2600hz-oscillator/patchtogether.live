---
name: module-surfaces
description: Build or review module faces, ModuleShell extensions, bespoke surfaces, STRICT_FACES promotion, and surface cleanup. Use for any module-surface work.
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
3. Inventory everything the module lets a player do or see, on every surface it
   has: params, ports, `node.data`, files, actions, editors, menus, component
   mount/destroy work, timers, subscriptions, registries, and child surfaces.

## Preserve runtime ownership

A def-reading gate cannot see behavior owned only by a Svelte component, so
component-only behavior can disappear — a surface stops being rendered, a pane
is closed — while every registry test stays green.

- One-shot behavior belongs in one plain TypeScript action seam, so a second
  surface is a call rather than a copy.
- Ongoing behavior belongs in the module factory/runtime and must work with no UI
  mounted.
- Durable collaborative state belongs on the node/graph, not component state.
- Test the effect, not merely that a control exists or can be clicked.

`livecode` is the reference shape: its factory is intentionally inert, so RUN
lives in one action that the face body and the ranked shell cell both call.

## Choose the smallest honest surface

Use the existing ladder before inventing a new primitive: declarative face,
shared shell cell/panel, shell extension, then bespoke surface. Thin modules
still need faces. Do not promote when any load-bearing affordance the module
already had has no reachable replacement.

A control's range comes from one place — the def — and the surface imports it.
Never re-type a bound on a surface; a def-reading gate cannot see a surface that
widens what the contract allows, so the pads write values the model then silently
clamps. When the def is in the WebGL attest basis, bind with `paramSpec(def, id)`
rather than exporting a `*_RANGE` constant: the export moves the attest hash and
the accessor does not.

⚠ THE GENERAL SOURCE GATE FOR THIS IS GONE. `card-range-source.test.ts` and
`card-control-ranges.test.ts` read the surfaces the removal deleted and died with
them. What survives is targeted: `device-card-source.test.ts` and
`treeohvox-range-source.test.ts`. Treat a re-typed bound as uncaught until a
gate names it.

Keep resting surfaces minimal: no descriptive/sidebar/readout text outside a
control. A video module keeps its live preview and SCREEN on/off behavior on
every surface that has one; persist that state on the node and do not stop the
producer merely because the screen is hidden.

## Promote and verify

- Add the face/surface and `STRICT_FACES` promotion together.
- Run `task face:accept`, focused parity/behavior tests, and `REPEAT=3` for
  changed tests.
- Exercise the shipping shell. A green run on any other surface is not evidence
  about a face.
- Use the `renderer-tests` skill for visual coverage and baselines.
- Derive any module count from `STRICT_FACES` or the registry; never type one.
- Obtain owner visual review for a new or materially changed surface.

Do not create an issue unless the owner explicitly approves it. A PR does not
need an issue.
