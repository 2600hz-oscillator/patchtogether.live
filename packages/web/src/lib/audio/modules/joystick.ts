// packages/web/src/lib/audio/modules/joystick.ts
//
// JOYSTICK — manual XY controller emitting four bipolar CV outputs.
//
// A user drags a virtual stick anywhere inside a square pad. The pad's
// center maps to (0, 0); the four extremes map to (±1, ±1). Two
// raw outputs (x, y) and two inverted outputs (nx = -x, ny = -y) let
// users drive quadrature or mirrored modulation from a single hand
// without having to copy + invert outside the module.
//
// Implementation notes:
//   * Four ConstantSourceNodes — one per output port. Each carries an
//     offset that we set via setValueAtTime() whenever the card pushes
//     a new position.
//   * The pad UI lives on JoystickCard; the audio module exposes a
//     pair of internal params `pos_x` and `pos_y` (range -1..+1) that
//     the card writes to via setParam. The factory mirrors those into
//     the ConstantSource offsets so the engine's per-param tap
//     analyser sees live activity for the motorized fader path (also
//     useful for tests that poke setParam directly without UI).
//   * Pointer-up snap-back to center is a card-level UX detail (the
//     card sets pos_x/pos_y to 0 on pointer-up). At the audio layer the
//     module is pure: whatever the params say, that's what comes out.
//
// Future work (NOT v1):
//   * Spring-back animation: instead of instant snap, the card could
//     animate values back to 0 over a few hundred ms. Out of scope here.
//   * MIDI-mappable: standard MIDI learn applies once the global MIDI
//     CC routing PR lands.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Clamp v to [-1, +1] — the project CV convention. Exposed for unit
 *  tests so the clamp semantics are pinned. */
export function clampJoy(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

export const joystickDef: AudioModuleDef = {
  type: 'joystick',
  domain: 'audio',
  label: 'JOYSTICK',
  category: 'utility',
  schemaVersion: 1,

  // No inputs — pure manual / future-MIDI-mappable control.
  inputs: [],
  outputs: [
    { id: 'x',  type: 'cv' },
    { id: 'y',  type: 'cv' },
    { id: 'nx', type: 'cv' }, // inverted X
    { id: 'ny', type: 'cv' }, // inverted Y
  ],
  params: [
    // pos_x / pos_y store the current stick position in [-1, +1].
    // They're persisted via the patch store like any knob, so the
    // joystick position survives reload.
    { id: 'pos_x', label: 'X', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'pos_y', label: 'Y', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const initial = node.params ?? {};
    const live = {
      pos_x: clampJoy((initial.pos_x as number | undefined) ?? 0),
      pos_y: clampJoy((initial.pos_y as number | undefined) ?? 0),
    };

    // One ConstantSource per output. We multiply by -1 inside Web Audio
    // for the inverted outputs by feeding the same source through a
    // -1.0-gain GainNode — that keeps the inverted output's value perfectly
    // tracked to the raw output even under future automation.
    function makeCv(initialValue: number): ConstantSourceNode {
      const c = ctx.createConstantSource();
      c.offset.setValueAtTime(initialValue, ctx.currentTime);
      c.start();
      return c;
    }
    const srcX = makeCv(live.pos_x);
    const srcY = makeCv(live.pos_y);

    // Inverters: -1 GainNodes fed from the corresponding source. The
    // inverted source is a separate ConstantSource so it shows up as an
    // independent OUTPUT node (Web Audio requires one node per output
    // port). We just keep them in sync via setParam.
    const srcNX = makeCv(-live.pos_x);
    const srcNY = makeCv(-live.pos_y);

    return {
      domain: 'audio',
      inputs: new Map(),
      outputs: new Map([
        ['x',  { node: srcX,  output: 0 }],
        ['y',  { node: srcY,  output: 0 }],
        ['nx', { node: srcNX, output: 0 }],
        ['ny', { node: srcNY, output: 0 }],
      ]),
      setParam(paramId, value) {
        const v = clampJoy(value);
        if (paramId === 'pos_x') {
          live.pos_x = v;
          srcX.offset.setValueAtTime(v, ctx.currentTime);
          srcNX.offset.setValueAtTime(-v, ctx.currentTime);
          return;
        }
        if (paramId === 'pos_y') {
          live.pos_y = v;
          srcY.offset.setValueAtTime(v, ctx.currentTime);
          srcNY.offset.setValueAtTime(-v, ctx.currentTime);
          return;
        }
      },
      readParam(paramId) {
        if (paramId === 'pos_x') return live.pos_x;
        if (paramId === 'pos_y') return live.pos_y;
        return undefined;
      },
      dispose() {
        for (const s of [srcX, srcY, srcNX, srcNY]) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
      },
    };
  },
};
