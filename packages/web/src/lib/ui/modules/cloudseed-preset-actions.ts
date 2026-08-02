// packages/web/src/lib/ui/modules/cloudseed-preset-actions.ts
//
// THE ONE CLOUDSEED PRESET RECALL — shared by the legacy card's slot footer and
// the curated face's PRESET cell (via SHELL_PARAM_WRITES).
//
// ── THE BUG THIS EXISTS TO KILL (a state-consistency bug, not a UI polish) ──
//
// The preset bank used to live in two places that did DIFFERENT things:
//
//   * `CloudseedCard.svelte`'s footer wrote all 46 values into the GRAPH in one
//     undoable `mutateNode`. Correct: the reconciler diffs `node.params` and
//     pushes each changed key to the engine, so store and worklet agree.
//   * the engine handle's `setParam('preset_index', …)` pushed the preset into
//     the WORKLET only and explicitly left the store alone.
//
// The second path is what a `preset_index` KNOB fires. So in the dock the SOUND
// changed while the persisted Y.Doc kept the OLD 45 values — and the next knob
// move, save/reload or peer join silently reverted it. The worklet leg is
// deleted (`cloudseed.ts`); this module is the single surviving stamp, and both
// surfaces call it.
//
// The behaviour change worth stating out loud: a recall now arrives at a
// collaborator as 46 visible param writes (one transaction, one undo step)
// rather than as an invisible worklet nudge. That is the point — the invisible
// version was the bug.
//
// PURE CORE + THIN ACTION. `cloudseedPresetStamp` is a pure `slot → {paramId:
// value}` projection with its own unit test (the "all 46 land" half of the
// regression is checkable with no browser and no engine); `applyCloudseedPreset`
// is the one line that touches the graph.

import { mutateNode } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import {
  CLOUDSEED_CLEAR_TAIL_KEY,
  CLOUDSEED_MACRO_CPP_MAP,
  CLOUDSEED_MESSAGE_PARAMS,
  CLOUDSEED_PRESETS,
} from '$lib/audio/modules/cloudseed';

/**
 * C++ `Parameter` enum index → our string param id, DERIVED from the two
 * tables that already carry the mapping (the macro map + the message-param
 * roster) rather than hand-transcribed.
 *
 * The card used to carry a 45-case `switch` restating exactly this. That is the
 * two-sided-contract shape the repo keeps getting burned by: a renamed param
 * silently drops out of preset recall (its value never lands) while every
 * def-reading gate stays green, because the switch is the only place the pairing
 * is written down twice.
 */
const PARAM_ID_BY_CPP_ID: Readonly<Record<number, string>> = (() => {
  const out: Record<number, string> = {};
  for (const [paramId, cppId] of Object.entries(CLOUDSEED_MACRO_CPP_MAP)) out[cppId] = paramId;
  for (const p of CLOUDSEED_MESSAGE_PARAMS) out[p.cppId] = p.id;
  return Object.freeze(out);
})();

/** The def param id for a C++ Parameter index, or null when unmapped. Pure. */
export function cloudseedParamIdForCppId(cppId: number): string | null {
  return PARAM_ID_BY_CPP_ID[cppId] ?? null;
}

/** Every C++ index the preset bank can address → param id (gate helper). Pure. */
export function cloudseedCppIdMap(): Readonly<Record<number, string>> {
  return PARAM_ID_BY_CPP_ID;
}

/** The RACKLINE display label for a preset slot: the bank name with the
 *  `[FX] ` marker stripped and lowercased, matching the kit's lowercase
 *  control vocabulary. The stored `preset.name` is NOT touched — the ART
 *  impulse-response scenario matches on `.includes('SHORT')`. Pure. */
export function cloudseedPresetLabel(name: string): string {
  return name.replace(/^\[FX\]\s*/, '').toLowerCase();
}

/**
 * The full param stamp for a preset slot: every value the recall writes,
 * `preset_index` included, keyed by def param id. `null` for a slot outside the
 * bank. Pure — this is the half of the recall a unit test can pin exactly.
 */
export function cloudseedPresetStamp(slot: number): Record<string, number> | null {
  const idx = Math.round(slot);
  if (!Number.isFinite(idx) || idx < 0 || idx >= CLOUDSEED_PRESETS.length) return null;
  const preset = CLOUDSEED_PRESETS[idx]!;
  const stamp: Record<string, number> = {};
  for (const [cppIdStr, v] of Object.entries(preset.values)) {
    const paramId = cloudseedParamIdForCppId(Number(cppIdStr));
    if (paramId) stamp[paramId] = v;
  }
  stamp.preset_index = idx;
  return stamp;
}

/**
 * Recall a preset into the graph — ONE undoable `mutateNode` transaction, so
 * undo is a single step and collaborators receive a single update.
 * Out-of-range slots are ignored (the roster is the authority).
 */
export function applyCloudseedPreset(nodeId: string, slot: number): void {
  const stamp = cloudseedPresetStamp(slot);
  if (!stamp) return;
  mutateNode(nodeId, (live) => {
    // The write below is in-place on the LIVE node INSIDE mutateNode's
    // origin-tagged transact — the sanctioned multi-field seam, not a bare
    // store write. One transaction ⇒ one undo step ⇒ one collab update.
    for (const [paramId, v] of Object.entries(stamp)) {
      live.params[paramId] = v; // guard:allow-raw-write
    }
  });
}

/** Minimal engine surface the CLEAR TAIL action needs (structural, so this
 *  module never pulls the whole PatchEngine import chain in). */
export interface CloudseedClearEnv {
  engine: { write(node: ModuleNode, key: string, value: unknown): void } | null;
  node: ModuleNode | undefined;
}

/** Flush the reverb tank (every delay line / diffuser / shelf / lowpass).
 *  A no-op before the audio engine boots — there is no tail to clear. */
export function clearCloudseedTail(env: CloudseedClearEnv): void {
  if (!env.engine || !env.node) return;
  env.engine.write(env.node, CLOUDSEED_CLEAR_TAIL_KEY, 1);
}
