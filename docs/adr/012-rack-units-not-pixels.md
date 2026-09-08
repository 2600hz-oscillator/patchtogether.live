# ADR-012: Size modules in rack units, not pixels

- Status: Accepted
- Date: 2026-09-08 (records the owner decisions of 2026-06-13)
- Deciders: project owner; this ADR documents the decisions
- Tags: ui, rack, layout, modules

## Context

Every module surface used to size itself from its own content, so the canvas was
a field of differently-shaped boxes that lined up with nothing. The obvious fix —
"let the user drag a corner" — was rejected: a rack is not a window manager, and
free resizing means every module has to be laid out for an arbitrary aspect
ratio, forever.

The reference is real hardware. A Eurorack module is a fixed height and a
whole number of HP wide; you do not resize it, you choose where it goes.

## Decision

**A module declares a HEIGHT TIER in whole rack units and a WIDTH in whole
tiles, and the canvas snaps to that grid. There is no resize gesture.**

- One square grid tile = `--rack-unit`, **180 px**
  (`packages/web/src/lib/ui/modules/_module-card.css`). Width is
  `hp × --rack-unit`; height is `Nu × --rack-unit`, with `min-height` and
  `max-height` both pinned so a surface cannot grow out of its slot.
- `ModuleDef.size?: RackSize` (`` `${number}u` ``) and `ModuleDef.hp?: number`
  are def fields (`packages/web/src/lib/graph/types.ts`). Most modules are 1u or
  3u; a genuinely large module takes an **exact taller tier** rather than being
  crammed, and every tier is a whole multiple of one tile so the grid never
  breaks.
- The tiers are **measured, not estimated**. `packages/web/src/lib/ui/
  rack-sizes.ts` carries the bulk fallback map with each entry's natural
  rendered size (`offsetHeight × offsetWidth`, the zoom-independent layout box)
  recorded inline as the evidence for its tier: `size = '1u'` if the natural
  height fits the 180 px tile, else a taller tier; `hp = round(width / 180)`,
  minimum 1.
- **A user-decided override beats the measurement, and says so.** Entries marked
  `[LOCKED]` were set by the owner at the preview pass regardless of what the
  probe returned. A card whose content exceeds its tier is compacted; it is not
  re-tiered.
- A def that declares `size`/`hp` **overrides** the map. The map is the bulk
  fallback for modules that predate the field; new modules declare on the def.
- Position within the grid is 1u-granular, so a 1u module sits in a 3u slot
  without inventing a second grid.
- Locking is a **right-click action, not a screw**: `node.data.rackLocked`
  (`packages/web/src/lib/graph/mutate.ts`), set as a single key in place and
  undoable, cleared by deleting the key. It rides `node.data` rather than
  becoming a def field, so no def changes and the WebGL-attest basis does not
  move.

## Consequences

**Good:**

- Modules line up, and a patch stays legible at any zoom, because both axes
  snap to the same unit.
- Sizing is falsifiable: every tier in the fallback map carries the measurement
  that produced it, so a disagreement is settled by re-measuring rather than by
  taste.
- Marking the owner's overrides `[LOCKED]` keeps them from being "corrected" by
  the next person who re-runs the probe.
- Because `rackLocked` lives in `node.data`, locking is shared patch state that
  rides sync, undo and save with no new plumbing.

**Bad / load-bearing:**

- **A module cannot be a little bit too big.** Content that overflows its tier
  is a signal to compact the surface, and control-heavy modules therefore go
  tabbed rather than growing a taller tier or padding a page.
- The fallback map is a hand-maintained population and will drift: a module
  added without `size`/`hp` on its def and without a map entry falls back to
  content-driven sizing. Prefer the def field.
- The key is `rackLocked`, **not** `locked` — the control surface already owns
  `locked` for something else, and merging them would be a silent semantic
  collision across two features.
- The map's own header prose predates the taller tiers now present in its data;
  the type (`` `${number}u` ``) and the entries are the authority.

## References

- `packages/web/src/lib/graph/types.ts` — `RackSize`, `ModuleDef.size`,
  `ModuleDef.hp`.
- `packages/web/src/lib/ui/rack-sizes.ts` — the measured fallback map and the
  `[LOCKED]` overrides.
- `packages/web/src/lib/ui/modules/_module-card.css` — `--rack-unit` and the
  pinned width/height derivation.
- `packages/web/src/lib/graph/mutate.ts` — `rackLocked`.
- `.claude/skills/module-surfaces` — how a surface is built inside its tier.
- Provenance: preserved in the `myrobots-preserved-2026-09` tag snapshot, as
  `plans/module-sizing-DECISIONS-2026-06-13.md` (paths relative to the retired
  agent-evidence tree in that snapshot, not to the worktree).
