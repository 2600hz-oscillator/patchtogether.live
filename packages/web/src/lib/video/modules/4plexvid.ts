// packages/web/src/lib/video/modules/4plexvid.ts
//
// 4PLEXVID — 4-in / 4-out video router. The video sibling of the audio
// 4Plexer.
//
// Each of the four OUTPUTS carries exactly ONE of the four INPUTS — a
// discrete cross-point switch, never a blend. Every output has:
//   * its own selector knob (sel1..sel4) — a discrete 0..3 index picking
//     in1..in4. Directly settable in the UI; persisted in node params.
//   * its own gate CV input (gate1..gate4). On each gate RISING EDGE that
//     output's selector rotates to the next input (1→2→3→4→1, wrapping).
//     Hold-high advances exactly once (edge-triggered, with hysteresis to
//     absorb LFO/ADSR dead-band chatter — see plex-select.ts).
//
// So the I/O surface is:
//   inputs  : in1..in4 (video) + gate1..gate4 (cv)
//   outputs : out1..out4 (video)
//
// Architecture (mirrors SHAPEDRAMPS's multi-output model):
//   - One FBO per output. Each frame, every output's FBO is rendered with
//     a trivial passthrough/copy shader sampling the CURRENTLY-SELECTED
//     input texture (or black if that input is unpatched). The engine's
//     `lookupInput` resolves multi-output sources via the
//     `read('outputTexture:<portId>')` escape hatch, so all four outputs
//     route independently to downstream consumers.
//   - All four outputs render every frame regardless of patch state, so
//     downstream modules always sample a fresh texture.
//   - The selector index lives in params (sel1..sel4). The gate CV arrives
//     via the cross-domain CV bridge as setParam('gate1'..) calls; a pure
//     rising-edge detector (plex-select.gateEdge) advances the matching
//     selector param on each rising edge.
//
// Inputs:
//   in1..in4 (video): four video inputs.
//   gate1..gate4 (cv, paramTarget=gate{N}): per-output advance gate.
//
// Outputs:
//   out1..out4 (video): per-output discrete tap of in[sel{N}].
//
// Params:
//   sel1..sel4 (discrete 0..PLEX_INPUTS): per-output selector index (0..3).
//   gate1..gate4 (linear 0..1): cached gate-edge state for advance detection.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { patch as livePatch } from '$lib/graph/store';
import {
  PLEX_INPUTS,
  advanceSelector,
  gateEdge,
  makeGateState,
  type GateState,
} from '$lib/video/plex-select';

/**
 * A persisted selector value → a REAL input index, total over every number.
 *
 * ⚠ THE `% PLEX_INPUTS` WRAP ALONE IS NOT TOTAL, AND THE GAP BLACKS AN OUTPUT
 * FOREVER (#1959). The wrap handles out-of-range fine — `7 → 3`, `-1 → 3` — but
 * every arm of it is NaN-preserving:
 *
 *     Math.round(NaN)      = NaN      ((NaN % 4) + 4) % 4      = NaN
 *     Math.round(Infinity) = Infinity ((Inf % 4) + 4) % 4      = NaN
 *
 * and `INPUT_IDS[NaN]` is `undefined`, so `getInputTexture` returns nothing,
 * `uHas` goes to 0 and the shader takes its BLACK branch — on that output, on
 * every frame, for the life of the patch. Nothing recovers it either: the gate
 * path advances `selIndex(...)`, which is NaN, so `advanceSelector` cannot walk
 * it back into range. Measured on the live factory: a node persisting
 * `{ sel1: NaN }` reads `readParam('sel1') === NaN`.
 *
 * A non-finite selector therefore resolves to 0 (IN 1) — the same value a fresh
 * spawn gets, so the recovery state is the one the player already understands.
 */
export function plexSelIndex(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % PLEX_INPUTS) + PLEX_INPUTS) % PLEX_INPUTS;
}

// Passthrough copy shader: write the selected input texture straight
// through, or black when that input is unpatched.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHas;

void main() {
  if (uHas < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outColor = vec4(texture(uTex, vUv).rgb, 1.0);
}`;

interface PlexVidParams {
  sel1: number;
  sel2: number;
  sel3: number;
  sel4: number;
  // Synthetic params for the four gate CV inputs (driven by the CV bridge
  // via setParam). Not exposed as knobs on the card.
  gate1: number;
  gate2: number;
  gate3: number;
  gate4: number;
}

const DEFAULTS: PlexVidParams = {
  sel1: 0,
  sel2: 0,
  sel3: 0,
  sel4: 0,
  gate1: 0,
  gate2: 0,
  gate3: 0,
  gate4: 0,
};

const OUTPUT_IDS = ['out1', 'out2', 'out3', 'out4'] as const;
const SEL_IDS = ['sel1', 'sel2', 'sel3', 'sel4'] as const;
const INPUT_IDS = ['in1', 'in2', 'in3', 'in4'] as const;
const GATE_IDS = ['gate1', 'gate2', 'gate3', 'gate4'] as const;

export const fourPlexVidDef: VideoModuleDef = {
  // Type id is '4plexvid'. ModuleType accepts arbitrary strings.
  type: '4plexvid',
  palette: { top: 'Video modules', sub: 'Utilities' },
  card: 'FourPlexVidCard',
  domain: 'video',
  label: '4plexvid',
  category: 'utilities',
  inputs: [
    { id: 'in1', type: 'video' },
    { id: 'in2', type: 'video' },
    { id: 'in3', type: 'video' },
    { id: 'in4', type: 'video' },
    // Gate CV inputs — one per output. paramTarget == port id so the
    // cross-domain CV bridge routes the gate signal into our setParam.
    { id: 'gate1', type: 'cv', paramTarget: 'gate1' },
    { id: 'gate2', type: 'cv', paramTarget: 'gate2' },
    { id: 'gate3', type: 'cv', paramTarget: 'gate3' },
    { id: 'gate4', type: 'cv', paramTarget: 'gate4' },
  ],
  outputs: [
    { id: 'out1', type: 'video' },
    { id: 'out2', type: 'video' },
    { id: 'out3', type: 'video' },
    { id: 'out4', type: 'video' },
  ],
  params: [
    // Selector knobs — discrete 0..3 (in1..in4). curve 'discrete' so the
    // fader snaps to integer indices.
    { id: 'sel1', label: 'OUT 1', defaultValue: DEFAULTS.sel1, min: 0, max: PLEX_INPUTS - 1, curve: 'discrete' },
    { id: 'sel2', label: 'OUT 2', defaultValue: DEFAULTS.sel2, min: 0, max: PLEX_INPUTS - 1, curve: 'discrete' },
    { id: 'sel3', label: 'OUT 3', defaultValue: DEFAULTS.sel3, min: 0, max: PLEX_INPUTS - 1, curve: 'discrete' },
    { id: 'sel4', label: 'OUT 4', defaultValue: DEFAULTS.sel4, min: 0, max: PLEX_INPUTS - 1, curve: 'discrete' },
    // Synthetic gate params — hidden from the card (rendered as cv jacks
    // via the standard handle row). curve 'linear' so setParam values
    // arrive raw for the edge detector.
    { id: 'gate1', label: 'G1', defaultValue: DEFAULTS.gate1, min: 0, max: 1, curve: 'linear' },
    { id: 'gate2', label: 'G2', defaultValue: DEFAULTS.gate2, min: 0, max: 1, curve: 'linear' },
    { id: 'gate3', label: 'G3', defaultValue: DEFAULTS.gate3, min: 0, max: 1, curve: 'linear' },
    { id: 'gate4', label: 'G4', defaultValue: DEFAULTS.gate4, min: 0, max: 1, curve: 'linear' },
  ],

  docs: {
    explanation: "4PLEXVID is a 4-in / 4-out video router — the video sibling of the audio 4Plexer. It is NOT a blend or mixer: each of the four outputs carries exactly ONE of the four video inputs, a discrete cross-point switch. Every output has its own selector (sel1..sel4 picking IN1..IN4) and its own gate CV input that advances that selector by one on each rising edge (IN1→IN2→IN3→IN4→IN1, wrapping). The fragment shader is a pure passthrough copy of the selected input texture (it writes the input's RGB straight through, or solid black when that input is unpatched), so there is no color processing — pixels pass straight through. All four outputs render their own FBO every frame regardless of patch state, so downstream modules always sample a fresh texture; OUT1 is also exposed as the canonical single-texture surface. Use it to fan one set of sources out to four destinations, to swap which feed reaches a screen, or to drive rhythmic cuts by clocking the gate inputs from an LFO or sequencer.",
    inputs: {
      in1: "Video input 1. A source you can route to any output by setting that output's selector (sel1..sel4) to IN1.",
      in2: "Video input 2. A source you can route to any output by setting that output's selector to IN2.",
      in3: "Video input 3. A source you can route to any output by setting that output's selector to IN3.",
      in4: "Video input 4. A source you can route to any output by setting that output's selector to IN4.",
      gate1: "Gate CV for output 1, edge-triggered (paramTarget gate1). On each rising edge it advances the sel1 selector to the next input, wrapping IN1→IN2→IN3→IN4→IN1. Held-high advances exactly once; hysteresis (rise>0.6, fall<0.4) absorbs LFO/ADSR dead-band chatter.",
      gate2: "Gate CV for output 2, edge-triggered (paramTarget gate2). Each rising edge rotates the sel2 selector to the next input, wrapping; held-high fires once via the same hysteresis edge detector.",
      gate3: "Gate CV for output 3, edge-triggered (paramTarget gate3). Each rising edge rotates the sel3 selector to the next input, wrapping; held-high fires once via the same hysteresis edge detector.",
      gate4: "Gate CV for output 4, edge-triggered (paramTarget gate4). Each rising edge rotates the sel4 selector to the next input, wrapping; held-high fires once via the same hysteresis edge detector.",
    },
    outputs: {
      out1: "Video output 1 — a discrete tap carrying exactly the input chosen by the sel1 selector (black if that input is unpatched). Also the canonical single-texture surface and the card's live OUT 1 preview.",
      out2: "Video output 2 — a discrete tap carrying exactly the input chosen by the sel2 selector (black if that input is unpatched).",
      out3: "Video output 3 — a discrete tap carrying exactly the input chosen by the sel3 selector (black if that input is unpatched).",
      out4: "Video output 4 — a discrete tap carrying exactly the input chosen by the sel4 selector (black if that input is unpatched).",
    },
    controls: {
      sel1: "OUT 1 selector — a discrete fader choosing which input (IN1..IN4, raw index 0..3) output 1 carries. Snaps to integer indices and displays as IN1..IN4; gate1 rotates it on each rising edge.",
      sel2: "OUT 2 selector — a discrete fader choosing which input (IN1..IN4, raw index 0..3) output 2 carries. Snaps to integer indices and displays as IN1..IN4; gate2 rotates it on each rising edge.",
      sel3: "OUT 3 selector — a discrete fader choosing which input (IN1..IN4, raw index 0..3) output 3 carries. Snaps to integer indices and displays as IN1..IN4; gate3 rotates it on each rising edge.",
      sel4: "OUT 4 selector — a discrete fader choosing which input (IN1..IN4, raw index 0..3) output 4 carries. Snaps to integer indices and displays as IN1..IN4; gate4 rotates it on each rising edge.",
      gate1: "Hidden synthetic param (linear 0..1) caching the gate1 CV level for output 1's rising-edge detector; driven by the gate1 jack via the CV bridge, not a knob on the card.",
      gate2: "Hidden synthetic param (linear 0..1) caching the gate2 CV level for output 2's rising-edge detector; driven by the gate2 jack via the CV bridge, not a knob on the card.",
      gate3: "Hidden synthetic param (linear 0..1) caching the gate3 CV level for output 3's rising-edge detector; driven by the gate3 jack via the CV bridge, not a knob on the card.",
      gate4: "Hidden synthetic param (linear 0..1) caching the gate4 CV level for output 4's rising-edge detector; driven by the gate4 jack via the CV bridge, not a knob on the card.",
    },
  },
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHas = gl.getUniformLocation(program, 'uHas');

    // One FBO per output port. Indexed in declaration order so the
    // per-output texture lookup below maps port id → texture by name.
    const fbos = OUTPUT_IDS.map(() => ctx.createFbo());

    // Sentinel 1×1 black texture for unbound inputs. We can't bind our
    // OWN output texture as a placeholder sampler — that creates a GL
    // feedback loop (read+write the same texture) which silently produces
    // garbage on Chrome. Allocate a separate tiny texture. (Same rationale
    // as V-MIXER / SHAPEDRAMPS.)
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('4PLEXVID: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: PlexVidParams = { ...DEFAULTS, ...(node.params as Partial<PlexVidParams>) };

    // Edge-detector state, one per gate input.
    const gateStates = new Map<string, GateState>();
    for (const id of GATE_IDS) gateStates.set(id, makeGateState());

    // Clamp a persisted selector into a valid 0..PLEX_INPUTS-1 index. Total
    // over every number, non-finite included — see `plexSelIndex` (#1959).
    const selIndex = (selId: (typeof SEL_IDS)[number]): number =>
      plexSelIndex((params as unknown as Record<string, number>)[selId] ?? 0);

    // SANITISE AT LOAD, not only at read. A persisted non-finite selector is
    // corrected in the working copy the moment the node spawns, so `readParam`
    // — which every gate, the card and the faceplate read — never hands anyone
    // a NaN to reason about. Doing it only inside `selIndex` would leave the
    // bad value visible everywhere except the one place that draws.
    for (const selId of SEL_IDS) {
      const rec = params as unknown as Record<string, number>;
      if (!Number.isFinite(rec[selId])) rec[selId] = plexSelIndex(rec[selId] ?? 0);
    }

    /**
     * Reflect a gate-advanced selector back into the STORE (#1959).
     *
     * ⚠ WITHOUT THIS THE MODULE'S HEADLINE FEATURE IS INVISIBLE AND DOES NOT
     * PERSIST. `params` above is `{ ...DEFAULTS, ...node.params }` — a FRESH
     * OBJECT — and the gate path mutates only that copy. Measured on the live
     * factory by holding the node:
     *
     *     two rising edges on gate1:
     *       handle.readParam('sel1') = 2          <- what the router draws
     *       node.params.sel1         = undefined  <- what the card renders
     *
     * so `FourPlexVidCard` (which reads `node.params[...]` and passes no
     * `readLive`) shows IN 1 while OUT 1 carries IN 3, permanently — and a
     * reload snaps the router back to the stale stored index.
     *
     * ⚠ THE EXISTING UNIT SUITE CANNOT SEE ANY OF THAT: every assertion in
     * `4plexvid.test.ts` goes through `readParam`, which reads the very copy
     * that is right. `spawn()` does not even keep the node. The regression legs
     * added with this fix HOLD THE NODE OBJECT, which is the only way the two
     * sides can be compared at all.
     *
     * ⚠ IT IS A STORE WRITE FROM AN ENGINE, AND IT IS THE SANCTIONED SHAPE, NOT
     * THE WRITE-STORM ONE. This fires on a RISING EDGE — at most once per gate
     * pulse, never per frame — and the router position is a persisted setting
     * rather than transient modulation, so it MUST reach the Y.Doc. That is
     * `drumseqz`'s `isPlaying` reflect exactly, and it is ledgered the same way
     * (`raw-write-ledger`, kind `sanctioned`). It is NOT the
     * cv-modulation-live-store-write-storm class, which is a continuous value
     * arriving every frame.
     */
    const reflectSelector = (selId: (typeof SEL_IDS)[number], value: number): void => {
      const live = livePatch.nodes[node.id];
      // Sanctioned engine → store reflect, exactly the drumseqz `isPlaying`
      // shape. Annotated INLINE rather than ledgered because the key is a
      // VARIABLE (`selId`) and `raw-write-ledger` matches literal key names: an
      // entry naming sel1..sel4 could not be tied back to this line, so the
      // guard reported it stale AND reported the write unlisted, both at once.
      // The trailing marker is the documented idiom for a new write.
      if (live?.params) live.params[selId] = value; // guard:allow-raw-write
    };

    const surface: VideoNodeSurface = {
      // Expose out1 as the canonical single-texture surface (legacy
      // single-output consumers); the per-output lookup below handles the
      // rest.
      fbo: fbos[0]!.fbo,
      texture: fbos[0]!.texture,
      draw(frame) {
        const g = frame.gl;
        g.useProgram(program);
        for (let o = 0; o < OUTPUT_IDS.length; o++) {
          const sel = selIndex(SEL_IDS[o]!);
          const tex = frame.getInputTexture(node.id, INPUT_IDS[sel]!);
          g.bindFramebuffer(g.FRAMEBUFFER, fbos[o]!.fbo);
          g.viewport(0, 0, ctx.res.width, ctx.res.height);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, tex ?? emptyTex);
          g.uniform1i(uTex, 0);
          g.uniform1f(uHas, tex ? 1.0 : 0.0);
          ctx.drawFullscreenQuad();
        }
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        for (const f of fbos) {
          gl.deleteFramebuffer(f.fbo);
          gl.deleteTexture(f.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (!(paramId in params)) return;
        // Gate path: edge-detect the rising edge + rotate the matching
        // selector. gate{N} drives sel{N}.
        if (paramId.startsWith('gate')) {
          (params as unknown as Record<string, number>)[paramId] = value;
          const state = gateStates.get(paramId);
          if (!state) return;
          if (gateEdge(state, value)) {
            const selId = ('sel' + paramId.slice(4)) as (typeof SEL_IDS)[number];
            const next = advanceSelector(selIndex(selId));
            (params as unknown as Record<string, number>)[selId] = next;
            // ...and tell the STORE, or the card and the saved patch keep the
            // index the router left behind two edges ago (#1959).
            reflectSelector(selId, next);
          }
          return;
        }
        // A selector written directly (a knob, a faceplate cell, automation)
        // is sanitised on the way in for the same reason it is at load: a
        // non-finite write must not be able to black an output (#1959).
        if ((SEL_IDS as readonly string[]).includes(paramId)) {
          (params as unknown as Record<string, number>)[paramId] = plexSelIndex(value);
          return;
        }
        (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Per-output texture lookup (the documented multi-output escape
        // hatch — see VideoNodeHandle.read + engine.lookupInput).
        for (let o = 0; o < OUTPUT_IDS.length; o++) {
          if (key === `outputTexture:${OUTPUT_IDS[o]}`) return fbos[o]!.texture;
        }
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
