// packages/web/src/lib/ui/modules/moog956/ribbon-actions.ts
//
// THE RIBBON GESTURE, as ONE action seam — press, slide, release — called
// verbatim by all three surfaces that play the 956: the legacy card, the
// face's lane `tileBody` and its dock `fullViewBody`.
//
// It is a plain TypeScript module rather than logic inside a component for the
// reason `module-surfaces` states: a def-reading gate cannot see behaviour
// owned only by a Svelte component, and promotion stops the legacy card
// rendering on normal surfaces — so a gesture implemented three times would be
// three chances to diverge, with nothing able to notice. `livecode`'s RUN is
// the precedent.
//
// ── ⚠ THE ORDER IS THE WHOLE POINT ──────────────────────────────────────────
//
// The two writes a press performs do NOT reach the engine by the same route,
// and the difference is a full scheduler hop:
//
//   * `setNodeParam` writes the Y.Doc. Yjs fires the doc `update` observer
//     synchronously, but the audio reconciler's listener only calls
//     `queueMicrotask(...)` (reconciler.ts `schedule`) — so the AudioParam
//     moves on a LATER MICROTASK, and `enqueue()` is itself async.
//   * `setMomentaryParam` calls the engine DIRECTLY, this instruction
//     (manual-strike-actions.ts).
//
// Written naively — `setNodeParam(pos)` then `setMomentaryParam(gate, true)` —
// the GATE RISES BEFORE THE PITCH MOVES. On the one module whose entire
// promise is that the ribbon HOLDS its last pitch, every note would attack at
// the PREVIOUS note's pitch and glide into the new one. So the press pushes
// the pitch AT THE ENGINE first, synchronously, and only then raises the gate;
// the durable Y.Doc write rides along behind and is only about persistence.
//
// ── WHAT PERSISTS, AND WHAT DOES NOT ────────────────────────────────────────
//
//   `pos`  — DURABLE. It is the last-played pitch, and the def promises it
//            survives a reload. Written through `setNodeParam` (tracked,
//            undoable, synced). A SLIDE must not write it per pointermove
//            (that is the write storm `createDragCommit` exists for), so the
//            durable write is the CALLER's rAF-coalesced pump; this seam
//            exposes `ribbonPersistPos` as that pump's target.
//   `gate` — NEVER DURABLE. It is a finger. `setMomentaryParam` writes the
//            engine only and registers the press with the window-level panic
//            listeners, so a release the surface never sees (dock closed
//            mid-hold, module deleted, tab hidden) still reaches the engine
//            instead of persisting a droning note into the rack.
//
// PURE-ish and node-testable: every dependency is a module-level import that a
// unit test can spy, and no DOM, no component context and no Svelte runes are
// involved. `./ribbon-actions.test.ts` drives it against a fake engine that
// RECORDS THE SEQUENCE of `setParam` calls, which is the only way the ordering
// above is observable at all — the final state is identical either way.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { notifyAutomationTouch, notifyAutomationRelease } from '$lib/audio/automation-touch';
import { momentaryRest } from '$lib/audio/momentary-params';
import { setNodeParam } from '$lib/graph/mutate';
import { patch } from '$lib/graph/store';
import { clampRibbon, moog956Def, ribbonToVOct } from '$lib/audio/modules/moog956';
import type { ModuleNode } from '$lib/graph/types';
import { setMomentaryParam } from '../manual-strike-actions';

/** The param the gesture GATES. Named once so a rename cannot half-land. */
export const RIBBON_GATE_PARAM = 'gate';
/** The param the gesture POSITIONS. */
export const RIBBON_POS_PARAM = 'pos';

/**
 * Push the ribbon position straight at the node's live engine handle — the
 * AudioParam moves on THIS instruction, not on a later microtask.
 *
 * Returns whether it landed, so a caller can tell "the engine is not booted
 * yet" from "the value was applied". A miss is a no-op, never an error over a
 * rack: the durable write below still stands, and the factory seeds its
 * ConstantSources from `node.params` whenever the engine does arrive.
 */
function pushPosOnEngine(nodeId: string, pos: number): boolean {
  const engine = getActiveEngine();
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  if (!engine || !node) return false;
  try {
    engine.setParam(node, RIBBON_POS_PARAM, pos);
    return true;
  } catch {
    return false;
  }
}

/** Where the gate rests when nobody is touching — read off the LIVE def rather
 *  than assumed to be 0, the same source the render side reads. */
function gateRest(): number {
  return momentaryRest(moog956Def, RIBBON_GATE_PARAM);
}

/**
 * SLIDE — the glide, while the finger is already down.
 *
 * Engine-immediate so the pitch tracks the pointer at full rate; the caller
 * separately stages the durable value on its `createDragCommit` pump. Clamps
 * through the def's own `clampRibbon`, so the three surfaces cannot disagree
 * about what "off the end of the strip" means.
 *
 * Returns the CLAMPED position, so the caller can stage exactly what the
 * engine got rather than re-deriving it.
 */
export function ribbonSlide(nodeId: string, pos: number): number {
  const p = clampRibbon(pos);
  pushPosOnEngine(nodeId, p);
  return p;
}

/** The DURABLE half of a slide — the target of the caller's rAF-coalesced
 *  commit pump. Tracked, undoable, synced, exactly like a knob turn. */
export function ribbonPersistPos(nodeId: string, pos: number): void {
  setNodeParam(nodeId, RIBBON_POS_PARAM, clampRibbon(pos));
}

/**
 * PRESS — the note attack. PITCH FIRST, then the gate; see the header.
 *
 * The durable write is taken here too rather than left to the drag pump: a TAP
 * (press + release with no pointermove) never schedules a frame, and without
 * this the tapped pitch would reach the engine and never the document.
 */
export function ribbonPress(nodeId: string, pos: number): number {
  // ⚠ THE HAND GRABS `pos` FIRST — before any write, so a clip automating this
  // param is suspended for the whole stroke rather than from the second frame.
  // Every OTHER surface that moves `pos` already does this: the ranked `pos`
  // FADER cell grabs inside `NeonFader`, and MIDI/Electra grab at their own
  // seams. The strip wrote `pos` durably and grabbed nothing, so with a
  // `moog956::pos` clip playing a finger neither suspended playback nor
  // recorded — `drive()` kept re-scheduling over the stroke and the
  // "live wins" contract ($lib/audio/automation-touch) was bypassed on the one
  // surface the promotion makes primary. The legacy card had the same hole;
  // this seam is where it gets closed for all three surfaces at once.
  notifyAutomationTouch({ nodeId, paramId: RIBBON_POS_PARAM }, 'pointer');
  const p = ribbonSlide(nodeId, pos);
  ribbonPersistPos(nodeId, p);
  setMomentaryParam(nodeId, RIBBON_GATE_PARAM, true, gateRest());
  return p;
}

/**
 * RELEASE — the gate falls and the pitch is LEFT WHERE IT IS.
 *
 * ⚠ Writing `pos` here would be the snap-back this module (and #1963, one
 * seam over) exists to refuse: the hardware wiper keeps its voltage, the def
 * promises the patched VCO stays on the last note, and the persisted value is
 * already correct from the press/slide path.
 */
export function ribbonRelease(nodeId: string): void {
  setMomentaryParam(nodeId, RIBBON_GATE_PARAM, false, gateRest());
  // The PHYSICAL release of the grab taken in `ribbonPress` — paired, so
  // automation resumes on the finger lifting rather than at the loop wrap.
  // Called on the unmount path too (the strips release before teardown), which
  // is the case that would otherwise strand a param overridden forever.
  notifyAutomationRelease({ nodeId, paramId: RIBBON_POS_PARAM }, 'pointer');
}

/**
 * The ribbon's pitch as a HUMAN reading, in semitones — one string, one
 * source, for two very different destinations.
 *
 * The legacy card PAINTS it (legacy cards print values and are untouched by
 * the resting-text ruling); the face SPEAKS it, as the strip's
 * `aria-valuetext`, because the ruling puts a derived value on the accessible
 * name and nowhere else. Sharing the formatter is what stops the two surfaces
 * quietly disagreeing about the same number — the divergence class this
 * module's whole shape is arguing against.
 *
 * V/oct → semitones is ×12 by the project's pitch convention (1.0 == one
 * octave), which `ribbonToVOct` is the single source of truth for.
 */
export function ribbonSemitoneText(pos: number, scale: number, offset: number): string {
  return `${(ribbonToVOct(pos, scale, offset) * 12).toFixed(1)} st`;
}
