// packages/web/src/lib/audio/modules/moog956.ts
//
// moogafakkin 956 — RIBBON CONTROLLER (moogafakkin System 55 clone).
//
// The 956 is a touch-ribbon: slide a finger along a horizontal strip and
// the position maps to a continuous pitch CV, with a gate that goes HIGH
// while the ribbon is touched. The original is a resistive ribbon whose
// linear position sets a control voltage; ours is a UI-driven CV source in
// the same family as `joystick` / `gamepad` — a pointer on the strip drives
// two internal params (`pos`, `gate`) that the factory mirrors into a pair of
// ConstantSourceNodes.
//
// ⚠ THE POINTER IS NOT "THE CARD'S" ANY MORE (2026-09-02, the promotion).
// Three surfaces now play the same strip — the legacy card, the face's
// `tileBody` on the lane and its `fullViewBody` at the dock — and all three go
// through ONE action seam, `$lib/ui/modules/moog956/ribbon-actions.ts`. Its
// header carries the ordering argument the module lives or dies by; the short
// form is below under `gate`.
//
// Pitch convention: this project speaks V/oct (1.0 == one octave; a
// semitone == 1/12), matching midi-cv-buddy's pitch output. The ribbon
// spans `scale` octaves end-to-end, shifted by `offset` octaves, so
//
//     pitch (V/oct) = offset + pos * scale          (pos in 0..1)
//
// Unlike a momentary controller, a ribbon HOLDS its last pitch when you
// lift off (only the gate falls) — every surface leaves `pos` where it was on
// pointer-up and just clears `gate`, so the patched VCO stays at the last
// played note. That mirrors the hardware (the wiper holds its voltage).
//
// Inputs: none (UI-driven source).
//
// Outputs:
//   pitch (pitch): V/oct, offset .. offset+scale across the ribbon.
//   gate  (gate):  1.0 while touched, 0.0 at rest.
//
// Params:
//   pos    (linear 0..1, default 0):    ribbon position — PERSISTED.
//   gate   (discrete 0..1, default 0):  touch state — a PRESS, never saved.
//   scale  (linear 0..5, default 2):    ribbon span in octaves.
//   offset (linear -2..2, default 0):   base pitch in V/oct (octaves).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Clamp the ribbon position to [0, 1]. Exposed so the clamp semantics are
 *  pinned by unit tests. */
export function clampRibbon(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Map a ribbon position (0..1) to a V/oct pitch given the span (octaves)
 *  and base offset (octaves). Pure — the single source of truth for the
 *  ribbon→pitch math, shared by the factory and the unit tests. */
export function ribbonToVOct(pos: number, scale: number, offset: number): number {
  const p = clampRibbon(pos);
  const s = Number.isFinite(scale) ? scale : 0;
  const o = Number.isFinite(offset) ? offset : 0;
  return o + p * s;
}

export const moog956Def: AudioModuleDef = {
  type: 'moog956',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '956 ribbon',
  category: 'utility',

  // No inputs — a manual touch source (like joystick).
  inputs: [],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate', type: 'gate', edge: 'gate' },
  ],
  params: [
    // `pos` is the ribbon position, written on pointer drag and PERSISTED via
    // the patch store like any knob, so the last-played pitch survives reload.
    { id: 'pos', label: 'Pos', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    // ── `gate` : curve CORRECTED `linear` → `discrete`, 2026-09-02 ──────────
    //
    // ⚠ IT WAS ALWAYS TWO-STATE AND THE DECLARATION SAID OTHERWISE. The
    // factory's own `setParam` two dozen lines down reads it as
    // `value > 0.5 ? 1 : 0` and has since the module shipped, so no value any
    // surface could write ever behaved as a continuum: `linear` described a
    // sweep the module does not have. The move is therefore NEUTRAL BY
    // CONSTRUCTION — every value on either side of that threshold keeps
    // resolving to the same 0 or 1 it always did — and it is a `contract-lock`
    // re-pin (a curve IS projected), taken in the promotion diff rather than
    // deferred, on `mappy:showGrid`'s reasoning one wave earlier.
    //
    // ⚠ WHAT THE MIS-DECLARATION COST, precisely, is why it could not be
    // deferred: `looksLikeSwitch` (shell-control-kind.ts) reaches only params
    // that are ALREADY `0..1 discrete`, so a `linear` gate was invisible to
    // module-face-lint's switch-classification ratchet AND `face.momentary`
    // refused it outright. A mis-declared switch is not merely rendered wrong,
    // it is UNCLASSIFIED and no gate says so.
    //
    // NOT PERSISTED — see `face.momentary` below.
    { id: 'gate', label: 'Gate', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'scale', label: 'Scale', defaultValue: 2, min: 0, max: 5, curve: 'linear' },
    { id: 'offset', label: 'Offset', defaultValue: 0, min: -2, max: 2, curve: 'linear' },
  ],

  docs: {
    explanation:
      "A clean-room recreation of the Moog 956 Ribbon Controller — a touch strip you play with your finger. Slide along the horizontal ribbon and your finger position maps to a continuous 1V/oct pitch CV; a gate goes HIGH the whole time you are touching it and falls when you lift off. Like the hardware's resistive ribbon, lifting off does NOT reset the pitch — the ribbon HOLDS its last value (only the gate drops), so the patched VCO stays on the last note until you touch again. The ribbon spans SCALE octaves end-to-end, shifted by OFFSET, so pitch (V/oct) = OFFSET + position × SCALE. Mental model: a fretless, glide-friendly keyboard alternative in the same family as joystick/gamepad — drive a VCO's pitch with the pitch output and an envelope/VCA with the gate.",
    inputs: {},
    outputs: {
      pitch:
        "1V/oct pitch CV set by your finger position along the ribbon: OFFSET at the far left up to OFFSET + SCALE at the far right. It HOLDS its last value after you lift off (no reset), so patch it into a VCO's 1V/oct pitch for smooth ribbon glides.",
      gate:
        "Gate that stays HIGH (1.0) the entire time you are touching the ribbon and drops to 0 when you lift off — a hold-while-pressed gate. Patch it into an ADSR's gate or a VCA so a note sounds only while your finger is down.",
    },
    controls: {
      pos: "The ribbon position itself (0..1), normally written by dragging on the strip; it persists with the patch so the last-played position survives a reload. The faceplate also gives it as a FADER, which is the same value as a throw you can set without gating a note.",
      gate: "The touch state (0/1), raised by the ribbon on press and dropped on release; it is the same signal carried by the gate output. It is a PRESS, not a setting — it is never saved with the patch and never shared with a peer, so a rack you saved mid-note reloads silent instead of droning. Normally you play it by touching the strip, but the faceplate also gives it as a press-and-hold pad you can strike without moving the pitch.",
      scale: "How many octaves the ribbon spans end-to-end, 0 to 5 (default 2 = a two-octave strip). Larger = wider pitch range but coarser finger resolution.",
      offset: "The base pitch in octaves (V/oct), -2 to +2, that shifts the whole ribbon up or down so its span sits where you want on the keyboard.",
    },
  },

  // ── THE FACE (2026-09-02) — the ribbon is a SURFACE, and the four params
  // are the settings around it ───────────────────────────────────────────────
  //
  // The migration inventory refused this module with "a 1-D touch surface is
  // not a knob", and that clause is TRUE — it is the conclusion that was
  // wrong. What a knob cannot express is not the position (a fader expresses a
  // 0..1 throw perfectly well) but the ONE-POINTER GESTURE: press writes `pos`
  // AND raises `gate`, slide moves `pos` while the gate stands, release drops
  // the gate and LEAVES the pitch. Two cells can reach every value that
  // gesture can; what they cannot do is reach them TOGETHER — which is the
  // same distinction `ModuleFace.xyPads` records for a 2-D pad, one arity
  // down. So the gesture goes on the module's own surfaces (the `moog956`
  // extension's `tileBody` + `fullViewBody`) and every param still ranks as an
  // ordinary cell beneath them. The joystick shape (owner decision
  // 2026-08-31), applied to a 1-D instrument.
  //
  // ⚠ THE `tileBody` IS NOT OPTIONAL HERE, and the reason is a parity hole
  // rather than a look: `faceTierCap('compact', 'none')` is 3, so the compact
  // lane tile paints ranks 1-3 (`pos`, `scale`, `offset`) and `gate` — HALF
  // THIS MODULE'S OUTPUT — would be reachable only by zooming to `full` or
  // opening the dock. A player who can set a pitch on the lane and not sound
  // it has lost the instrument. The tile strip restores the whole gesture
  // where the module is normally met, which is also the skifree/audioIn
  // finding: "a module whose only non-param control lives in the full view is
  // unusable from the lane".
  //
  // ⚠ THE REDUNDANCY IS DELIBERATE AND STATED (the twotracks/joystick shape):
  // at the dock the strip AND the four cells are both live over the same
  // params. The CELLS are the parity-credited controls and the MIDI-learn /
  // Electra / control-surface anchors the hand-rolled card never had; the
  // strip is the module's own instrument and emits NO `control-*` anchor and
  // no cell attributes, or faces-parity counts `pos` twice.
  //
  // ⚠ RANK. `pos` first — it IS the instrument. `paramCells: { pos: 'fader' }`
  // because nothing in a ParamDef separates "a position you throw" from any
  // other 0..1 scalar (the noise/cameraInput fader ruling, 2026-08-10), and a
  // horizontal ribbon read as a rotary is the wrong gesture entirely. `scale`
  // before `offset`: the span changes what a gesture MEANS mid-performance,
  // while the offset is set-and-forget tuning. `gate` LAST because it is the
  // one you play rather than dial — and dropping off the compact tile is what
  // the tile strip is there to cover.
  //
  // ⚠ `momentary: ['gate']` — a PRESS IS NOT STATE. The pad presses and
  // releases through `setMomentaryParam`, which writes the ENGINE and nothing
  // else: no Y.Doc entry, no undo step, no peer sync, and `restedParams` at
  // spawn repairs any rack already saved holding one. A latching render would
  // hold a note forever the first time a surface unmounted mid-press — which
  // pointer capture does not protect against, because it protects a MOVING
  // pointer, not a DELETED element.
  //
  // ⚠ NO `pages`. One band of four controls is one idea, and
  // `DOCK_TAB_MIN_BANDS` is 7 — padding toward a rail is refused.
  //
  // ⚠ `glyph: 'none'` IS FORCED, not chosen: the two outputs are `pitch` and
  // `gate`, so `primaryAudioOutPortId` is null and every glyph literal but
  // 'algorithm' resolves `{ kind: 'static' }`, which the dead-glyph clause
  // refuses by name. (And 'algorithm' would RESOLVE — the layout-source branch
  // fires for any def carrying a `face.extension` string — while pointing at
  // an extension that exports no `glyph` slot. `moog956-face-model.test.ts`
  // pins that trap shut.)
  face: {
    order: ['pos', 'scale', 'offset', 'gate'],
    paramCells: { pos: 'fader' },
    momentary: ['gate'],
    glyph: 'none',
    extension: 'moog956',
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initial = node.params ?? {};
    const live = {
      pos: clampRibbon((initial.pos as number | undefined) ?? 0),
      gate: ((initial.gate as number | undefined) ?? 0) > 0.5 ? 1 : 0,
      scale: (initial.scale as number | undefined) ?? 2,
      offset: (initial.offset as number | undefined) ?? 0,
    };

    function makeCv(initialValue: number): ConstantSourceNode {
      const c = ctx.createConstantSource();
      c.offset.setValueAtTime(initialValue, ctx.currentTime);
      c.start();
      return c;
    }

    const pitchSrc = makeCv(ribbonToVOct(live.pos, live.scale, live.offset));
    const gateSrc = makeCv(live.gate);

    function refreshPitch() {
      pitchSrc.offset.setValueAtTime(
        ribbonToVOct(live.pos, live.scale, live.offset),
        ctx.currentTime,
      );
    }

    return {
      domain: 'audio',
      inputs: new Map(),
      outputs: new Map([
        ['pitch', { node: pitchSrc, output: 0 }],
        ['gate', { node: gateSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'pos') {
          live.pos = clampRibbon(value);
          refreshPitch();
          return;
        }
        if (paramId === 'gate') {
          live.gate = value > 0.5 ? 1 : 0;
          gateSrc.offset.setValueAtTime(live.gate, ctx.currentTime);
          return;
        }
        if (paramId === 'scale') {
          live.scale = value;
          refreshPitch();
          return;
        }
        if (paramId === 'offset') {
          live.offset = value;
          refreshPitch();
          return;
        }
      },
      readParam(paramId) {
        if (paramId === 'pos') return live.pos;
        if (paramId === 'gate') return live.gate;
        if (paramId === 'scale') return live.scale;
        if (paramId === 'offset') return live.offset;
        return undefined;
      },
      dispose() {
        for (const s of [pitchSrc, gateSrc]) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
      },
    };
  },
};
