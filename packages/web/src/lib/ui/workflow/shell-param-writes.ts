// packages/web/src/lib/ui/workflow/shell-param-writes.ts
//
// PF-13 — the PARAM WRITE OVERRIDE registry.
//
// ModuleShell's param cells all commit through `setNodeParam(id, paramId, v)`,
// which is exactly right for a param that means ONE number. A MACRO param does
// not: cloudseed's `preset_index` means "recall this whole space", and writing
// only the index leaves the other 45 values stale — which is precisely the
// state-consistency bug the cloudseed face fixes (see
// `$lib/ui/modules/cloudseed-preset-actions`).
//
// So the shell asks this registry first: `shellParamWrite(type, paramId)` hands
// back a replacement writer or `null`, and the cell uses `override ?? the
// normal setter`. Everything else about the cell — the primitive, MIDI-learn,
// the motorized readback, the faces-parity drive — is unchanged: only the
// COMMIT is redirected.
//
// ── WHY THE STORM GUARD IS NOT OPTIONAL ─────────────────────────────────────
//
// A macro write AMPLIFIES: one number in, a 46-key `mutateNode` transaction
// out. The per-control pumps already coalesce the incoming stream (a knob drag
// rides `createDragCommit` at ~60/s; a learned CC rides `createCcCommit` at
// ~7/s while hot) — but each survivor still detonates a full 46-param
// transaction, snapshot rebuild and reconciler pass. Coalescing the stream is
// not the same as coalescing the amplification, so the override goes through
// `createSettleCommit`: repeats are dropped, and a sweep commits ONCE when it
// settles. See `midi-cc-write-storm-fix`.

import { applyCloudseedPreset } from '$lib/ui/modules/cloudseed-preset-actions';
import { setShowGrid, setSurfaceCountTo } from '$lib/ui/modules/mappy-edit';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { createSettleCommit } from './settle-commit';

/** A replacement durable writer for one (module type, param) pair. */
export type ShellParamWriter = (nodeId: string, value: number) => void;

/**
 * A single flat param off the LIVE node, or `undefined` when the node or key is
 * absent (not yet synced, deleted, store not bound). A plain proxy read — no
 * transaction, no undo entry, no subscription.
 *
 * ⚠ Read through the live `patch` ESM binding, which `bindRackspace()`
 * REASSIGNS on rackspace change, so this must not capture it. Kept out of
 * `graph/mutate.ts` because a shell-local read helper is not a graph mutation;
 * it also used to avoid a re-attest of the multiplayer semaphore, but that
 * attest was deleted 2026-08-17.
 */
function readNodeParam(nodeId: string, paramId: string): number | undefined {
  const live = patch?.nodes?.[nodeId] as ModuleNode | undefined;
  const v = live?.params?.[paramId];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Storm-guarded cloudseed preset recall — keyed by nodeId, so two cloudseeds
 * being swept at once coalesce independently.
 *
 * ⚠ `readCurrent` IS LOAD-BEARING, not defensive. Without it the guard dedupes
 * against its own page-lifetime memory of the last slot it committed, and
 * `preset_index` moves by three paths it never sees — undo, a rack-mate, a rack
 * load — plus the legacy card's direct `applyCloudseedPreset`. The moment
 * memory and graph disagree, clicking the segment whose value equals the
 * remembered one is a TOTAL no-op. Reproduced in a real browser: recall
 * `short room`, ⌘Z, click `short room` again → nothing happens. Reading the
 * live param makes the dedupe a statement about reality instead of about
 * bookkeeping.
 */
const cloudseedPresetCommit = createSettleCommit<number>(
  (nodeId, slot) => applyCloudseedPreset(nodeId, slot),
  { readCurrent: (nodeId) => readNodeParam(nodeId, 'preset_index') },
);

/**
 * `moduleType → paramId → writer`. Deliberately tiny and explicit: an override
 * makes a param's write path stop being the one every other param uses, so
 * each entry has to be worth reading about.
 */
export const SHELL_PARAM_WRITES: Readonly<Record<string, Readonly<Record<string, ShellParamWriter>>>> = {
  cloudseed: {
    // The whole-space recall. Rounded because the writer indexes a roster and
    // the dial's `discrete` snap is a display concern, not a guarantee about
    // what a CV/MIDI-motorized value hands us.
    preset_index: (nodeId, v) => cloudseedPresetCommit.write(nodeId, Math.round(v)),
  },

  // ── MAPPY — the registry's SECOND entry, and a different KIND of macro ─────
  //
  // cloudseed's override exists because one number stands for forty-six. This
  // one exists because the number is not the whole write: raising
  // `surfaceCount` must also DROP THE NEWLY-LIVE SURFACE IN SOMEWHERE VISIBLE.
  //
  // ⚠ WITHOUT IT THE CELL IS A CONTROL THAT APPEARS TO DO NOTHING, and every
  // gate stays green. Every surface's quad DEFAULTS to the full-frame
  // UNIT_QUAD, so a bare `setNodeParam('surfaceCount', 3)` makes surfaces 2 and
  // 3 exact full-frame duplicates stacked on surface 1 — the composite is
  // pixel-identical, the corner handles land on top of each other, and there is
  // nothing to grab. `addSurface` is the card's `+`, and it drops each
  // newly-live surface that is still at the untouched default in as
  // `insetQuadForIndex`: a staggered box you can see and drag onto a physical
  // face. The faceplate must make the SAME write the card's button makes, not
  // merely arrive at the same number.
  //
  // ⚠ NO STORM GUARD, and the difference from cloudseed is the amplification.
  // A macro write detonates a 46-key transaction per survivor, so its override
  // must coalesce. This one commits a handful of corner arrays at most SIX
  // times over the param's whole range, the per-control drag pump already
  // coalesces the incoming stream, and `addSurface` skips a surface the player
  // has shaped — so a sweep is bounded by the range rather than by the gesture.
  mappy: {
    // Absolute, idempotent, clamped: a dial drag and a six-state Segmented jump
    // (1 → 5) both land on the same state, applying the inset drop for each
    // surface that becomes live on the way.
    surfaceCount: (nodeId, v) => { setSurfaceCountTo(nodeId, Math.round(v)); },
    // ⚠ THE GRID OVERRIDE IS ROUTED FOR SYMMETRY, NOT FOR A DIFFERENT WRITE.
    // `setShowGrid` writes the same `showGrid` param `setNodeParam` would, so
    // this override changes no value — it makes the faceplate's Toggle, the
    // card's GRID button and the MAP editor's bar button all commit through ONE
    // function. That is what keeps a later change to how the override is stored
    // from repairing two surfaces and leaving the third reading the old thing,
    // which is the failure this module already had once (the `node.data` mirror
    // the factory preferred).
    showGrid: (nodeId, v) => { setShowGrid(nodeId, v >= 0.5); },
  },
};

/** The override for a param, or `null` when the shell should use its normal
 *  `setNodeParam` commit. Pure lookup. */
export function shellParamWrite(moduleType: string, paramId: string): ShellParamWriter | null {
  return SHELL_PARAM_WRITES[moduleType]?.[paramId] ?? null;
}

/** Force any staged macro write to commit NOW (test/teardown seam). */
export function flushShellParamWrites(): void {
  cloudseedPresetCommit.flush();
}
