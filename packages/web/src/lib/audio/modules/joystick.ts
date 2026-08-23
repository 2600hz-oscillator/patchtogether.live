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
//   * The pad UI lives on the faceplate's shared `xy` cell (and, under
//     ?shell=legacy, on JoystickCard); the audio module exposes a pair
//     of internal params `pos_x` and `pos_y` (range -1..+1) that the pad
//     writes via the normal param path. The factory mirrors those into
//     the ConstantSource offsets so the engine's per-param tap
//     analyser sees live activity for the motorized fader path (also
//     useful for tests that poke setParam directly without UI).
//   * THE STICK STAYS WHERE YOU PUT IT. Releasing the pointer does NOT
//     re-centre it (owner ruling, 2026-08-19 on #1963, verbatim
//     "1 - persist"): the position is a persisted value, so it survives
//     a release, a remount and a patch reload. This file used to say the
//     opposite in three places while ALSO promising the value survives a
//     reload — with a snap-back, what survived was always centre, so the
//     two halves could not both be useful and the ruling picked which
//     one dies. At the audio layer the module is pure either way:
//     whatever the params say, that is what comes out.
//
// Future work (NOT v1):
//   * MIDI-mappable: standard MIDI learn applies once the global MIDI
//     CC routing PR lands.
//
// Inputs: none.
//
// Outputs:
//   x (cv): X position, -1..+1.
//   y (cv): Y position, -1..+1.
//   nx (cv): -x (inverted X for mirrored modulation).
//   ny (cv): -y (inverted Y for mirrored modulation).
//
// Params:
//   pos_x (linear -1..1, default 0): persisted X position (written by the card on drag).
//   pos_y (linear -1..1, default 0): persisted Y position.

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
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'joystick',
  category: 'utility',

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

  docs: {
    explanation:
      "A manual XY controller: drag the stick anywhere inside the square pad and its position comes out as four bipolar CV signals. The pad's center is (0, 0) and the four corners reach (±1, ±1); dragging UP gives +Y (screen-y is flipped so 'up' reads positive). Two raw outputs (X, Y) plus two pre-inverted outputs (NX = −X, NY = −Y) let you drive mirrored or quadrature modulation from one hand without wiring an external inverter. Mental model: a hands-on two-axis modulation source — sweep filter cutoff and resonance together, pan a sound while changing its tone, or steer a video param. The stick STAYS WHERE YOU PUT IT: releasing the pointer leaves the position untouched, and the position is stored in the patch like any knob, so it survives a reload. To re-centre it, double-click the pad. A value that is not a finite number (an automation or MIDI source emitting NaN or Infinity) snaps to CENTER rather than to a rail.",
    inputs: {},
    outputs: {
      x: "The stick's horizontal position as bipolar CV, −1 at the left edge through 0 at center to +1 at the right edge.",
      y: "The stick's vertical position as bipolar CV, −1 at the bottom through 0 at center to +1 at the top (the axis is flipped so dragging up reads positive).",
      nx: "The inverted X output (−X): +1 when the stick is at the left edge, −1 at the right — the mirror image of the X output, for driving two things in opposition from one axis.",
      ny: "The inverted Y output (−Y): +1 at the bottom, −1 at the top — the mirror image of the Y output.",
    },
    controls: {
      pos_x:
        "The stick's stored X position in the −1..+1 range, written by dragging the pad. Releasing the pointer leaves it where you dropped it. It is the persisted value behind the X / NX outputs; it survives a patch reload. Anything outside the range is clamped to the nearest rail, and a non-finite value (NaN or ±Infinity) resolves to 0 — the CENTER, not a rail.",
      pos_y:
        "The stick's stored Y position in the −1..+1 range, written by dragging the pad, with +1 at the top (the axis is flipped so dragging up reads positive). Releasing the pointer leaves it where you dropped it. It is the persisted value behind the Y / NY outputs, with the same clamping and the same snap-to-CENTER on a non-finite value.",
    },
  },

  // ⚠ NO `face` YET — Q43 IS BUILT AND HELD, AND THE BLOCKER IS NOT THIS FILE.
  // The migration inventory prescribes the shared `xy` cell for this module and
  // that is still right; what is not ready is the cell. Measured 2026-08-19
  // while building the promotion:
  //
  //   * `XyPad.svelte` painted a `.xy-readout` row — `x <n> / y <n>`, two
  //     resting decimals — which is exactly the text the 2026-08-17 ruling
  //     removes, so promoting would MOVE this module's decimal from the card to
  //     the faceplate rather than delete it (the stated point of the migration);
  //   * the pad exposed NO value in the accessibility tree that the ruling's
  //     "the number survives where it is speakable" half could point at; and
  //   * `face-readout-source.test.ts` lists only `KnobConic` and `NeonFader` in
  //     its `PRIMITIVES`, so the gate that enforces the ruling was BLIND to the
  //     pad — which is why none of this was already red.
  //
  // ✅ ALL THREE ARE CLEARED BY #2038, and this comment is updated rather than
  // deleted so the next reader can see WHY the blocker lifted rather than
  // finding a promotion with no recorded reason. The readout row is DELETED
  // from the primitive (not hidden, and with no prop to re-enable it); the
  // values live in the pad's `aria-label`, which is where a `role="application"`
  // control's value belongs — there is no `aria-valuetext` on that role, so the
  // middle bullet's original wording was asking for the wrong attribute; and
  // `xy-pad-readout-source.test.ts` now denies the class at the PRIMITIVE level,
  // so the gate is no longer blind to it.
  //
  // ⚠ THIS DOES NOT PROMOTE THE MODULE — #2038 is a primitive fix and stops at
  // the primitive.
  //
  // Everything else Q43 needs was done and shipped earlier: the #1963 ruling
  // (no snap-back, the docs corrected), the raw-write debt paid, and a
  // `faceLaneCellHeights` fold bug that attempting the promotion exposed.
  //
  // ── ⚠ AND THERE IS A SECOND, OLDER BLOCKER THIS COMMENT NEVER MENTIONED ────
  //
  // Re-derived 2026-08-23 while cut A batch 2 was assigned this module. The
  // three bullets above are all about the READOUT, and all three really are
  // cleared — so read on its own this comment says "unblocked", which is what
  // it said before it was corrected. It is not, and the reason is structural
  // rather than cosmetic:
  //
  //   THIS MODULE'S LANE TILE WOULD BE EMPTY. `joystick` declares exactly two
  //   params and both are the axes of one pad. `laneOrder` deletes every
  //   declared `xyPads` anchor from the lane order (a pad is square; a lane
  //   knob column is 46 px) and `foldedOrder` removes the partner axis at every
  //   tier, so a face here resolves to ZERO controls at mini, compact AND full.
  //   Nor is there a glyph to fall back on: `glyphBinding` reaches a live trace
  //   only through a primary AUDIO output, and this module declares four `cv`
  //   outputs and no audio, so every glyph literal resolves `{ kind: 'static' }`
  //   — which `module-face-lint`'s dead-glyph clause refuses by name. The tile
  //   would be a title bar and a jack rail with nothing between them, which is
  //   strictly worse than the uniform placeholder it would replace.
  //
  // This is the refusal `strict-faces.ts` records in the `quadralogical` entry
  // and `types.ts` records on `FaceXyPad.surface` — and `quadralogical` is
  // promotable with the SAME pad only because it has eighteen other ranked
  // params. `surface: 'body'` does not answer it either: that field changes
  // WHICH DOCK SURFACE paints the pad, never whether a lane has one.
  //
  // ⚠ IT IS NOW ENFORCED, which it was not when the comment above was written.
  // Nothing in the repo failed on a zero-control lane — the cap-vs-fit-plan
  // clause reads `rendered === face.controls.length`, which is `0 === 0` and
  // green — so a face authored here would have SHIPPED with a blank tile
  // through the whole gate set. `module-face-lint.test.ts` now denies a
  // promoted face that ranks controls and resolves to none of them at a lane
  // tier, with this exact shape as its permanent negative control.
  //
  // So the honest status is BLOCKED, on a platform capability rather than on
  // this file: either a glyph binding that can paint a pad's position (which
  // `types.ts` already prescribes the shape for), or lifting the pad-in-lane
  // restriction (`LANE_CELL_H.xy` is already carried at its real 96 px against
  // that day). Both move every pad-bearing face's lane tile and its baselines,
  // so both are platform work and not a face PR.
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
