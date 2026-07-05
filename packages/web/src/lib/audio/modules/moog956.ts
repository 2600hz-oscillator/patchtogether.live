// packages/web/src/lib/audio/modules/moog956.ts
//
// moogafakkin 956 — RIBBON CONTROLLER (moogafakkin System 55 clone).
//
// The 956 is a touch-ribbon: slide a finger along a horizontal strip and
// the position maps to a continuous pitch CV, with a gate that goes HIGH
// while the ribbon is touched. The original is a resistive ribbon whose
// linear position sets a control voltage; ours is a UI-driven CV source in
// the same family as `joystick` / `gamepad` — the card's pointer drives two
// internal params (`pos`, `gate`) that the factory mirrors into a pair of
// ConstantSourceNodes.
//
// Pitch convention: this project speaks V/oct (1.0 == one octave; a
// semitone == 1/12), matching midi-cv-buddy's pitch output. The ribbon
// spans `scale` octaves end-to-end, shifted by `offset` octaves, so
//
//     pitch (V/oct) = offset + pos * scale          (pos in 0..1)
//
// Unlike a momentary controller, a ribbon HOLDS its last pitch when you
// lift off (only the gate falls) — the card leaves `pos` where it was on
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
//   pos    (linear 0..1, default 0):  ribbon position (written by the card).
//   gate   (linear 0..1, default 0):  touch state (written by the card).
//   scale  (linear 0..5, default 2):  ribbon span in octaves.
//   offset (linear -2..2, default 0): base pitch in V/oct (octaves).

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
  card: 'Moog956Card',

  // No inputs — a manual touch source (like joystick).
  inputs: [],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate', type: 'gate' },
  ],
  params: [
    // pos / gate are written by the card on pointer drag; persisted via the
    // patch store like any knob so the last-played pitch survives reload.
    { id: 'pos', label: 'Pos', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'gate', label: 'Gate', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
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
      pos: "The ribbon position itself (0..1), normally written by dragging on the strip; it persists with the patch so the last-played position survives a reload. You can also see/set it as a value.",
      gate: "The touch state (0/1), written by the ribbon on press/release; it is the same signal carried by the gate output. Normally you play it by touching, not by editing.",
      scale: "How many octaves the ribbon spans end-to-end, 0 to 5 (default 2 = a two-octave strip). Larger = wider pitch range but coarser finger resolution.",
      offset: "The base pitch in octaves (V/oct), -2 to +2, that shifts the whole ribbon up or down so its span sits where you want on the keyboard.",
    },
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
