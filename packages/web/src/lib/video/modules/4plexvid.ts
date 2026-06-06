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
import {
  PLEX_INPUTS,
  advanceSelector,
  gateEdge,
  makeGateState,
  type GateState,
} from '$lib/video/plex-select';

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
  label: '4PLEXVID',
  category: 'utilities',
  schemaVersion: 1,
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

    // Clamp a persisted selector into a valid 0..PLEX_INPUTS-1 index.
    const selIndex = (selId: (typeof SEL_IDS)[number]): number => {
      const raw = (params as unknown as Record<string, number>)[selId] ?? 0;
      const n = ((Math.round(raw) % PLEX_INPUTS) + PLEX_INPUTS) % PLEX_INPUTS;
      return n;
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
          }
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
