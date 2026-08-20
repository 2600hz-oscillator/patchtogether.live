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

/**
 * The four selector detents, shared by all four selectors — ONE roster object,
 * not four copies, because the four selectors are bit-identically symmetric and
 * four literals would be four places for `IN3` to become `IN4`.
 *
 * DERIVED FROM `INPUT_IDS`, so the roster cannot outlive its subject: a fifth
 * video input would extend this automatically rather than leaving a four-name
 * legend on a five-way switch. The label is 1-BASED because the jacks, the
 * docs and the card's old formatter all are (`in1` is `IN1`), while the stored
 * value stays the 0-based index the shader samples — the off-by-one lives in
 * exactly one expression.
 */
const SEL_OPTIONS = INPUT_IDS.map((portId, i) => ({
  value: i,
  label: `IN${i + 1}`,
  title: `Carry video input ${i + 1} (port '${portId}') on this output.`,
}));

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
    // control snaps to integer indices.
    //
    // ⚠ THE `options` ROSTER IS WHERE THE INPUT NAMES NOW LIVE, AND IT HAD TO
    // MOVE HERE FOR THE FACE TO BE HONEST. Before this, `IN1…IN4` existed ONLY
    // inside `FourPlexVidCard.svelte` (`selFmt(v) = \`IN${Math.round(v)+1}\``)
    // — card-local text no def-driven surface can see. Promotion stops that
    // card rendering on BOTH surfaces, so a face authored without this roster
    // would paint a four-position ANONYMOUS dial: the player would be choosing
    // between `0`, `1`, `2` and `3` on a router whose entire job is naming
    // which input reaches which output.
    //
    // With the roster declared, two different surfaces get the names from ONE
    // place: the dock renders a `segmented` row of named buttons (4 <=
    // `SEGMENTED_MAX_OPTIONS`), and the lane renders a KnobConic whose painted
    // readout is the state NAME (`paintsReadout` is true for a bare roster with
    // no `format`, verified against the real predicate). That name is permitted
    // resting text under the 2026-08-19 ruling precisely because it
    // disambiguates the control's OWN position — four otherwise-identical
    // indices — rather than restating a dial as a decimal.
    //
    // ⚠ AND IT IS WHY THIS FACE DECLARES NO `paramCells: 'fader'`. The card
    // mounts four `<NeonFader>`s, and `paramCellKind` returns a DECLARED cell
    // before it ever looks at `options` — so the two are mutually exclusive.
    // The throw was traded for the names deliberately: on a cross-point switch
    // the value IS a name, and a 4-position fader with no legend is the state
    // this module shipped in.
    { id: 'sel1', label: 'OUT 1', defaultValue: DEFAULTS.sel1, min: 0, max: PLEX_INPUTS - 1, curve: 'discrete', options: SEL_OPTIONS },
    { id: 'sel2', label: 'OUT 2', defaultValue: DEFAULTS.sel2, min: 0, max: PLEX_INPUTS - 1, curve: 'discrete', options: SEL_OPTIONS },
    { id: 'sel3', label: 'OUT 3', defaultValue: DEFAULTS.sel3, min: 0, max: PLEX_INPUTS - 1, curve: 'discrete', options: SEL_OPTIONS },
    { id: 'sel4', label: 'OUT 4', defaultValue: DEFAULTS.sel4, min: 0, max: PLEX_INPUTS - 1, curve: 'discrete', options: SEL_OPTIONS },
    // Synthetic gate params — the edge detector's MEMORY, not controls. See
    // the `noUserControl` declaration below for what stops them rendering.
    // curve 'linear' so setParam values arrive raw for the edge detector.
    { id: 'gate1', label: 'G1', defaultValue: DEFAULTS.gate1, min: 0, max: 1, curve: 'linear' },
    { id: 'gate2', label: 'G2', defaultValue: DEFAULTS.gate2, min: 0, max: 1, curve: 'linear' },
    { id: 'gate3', label: 'G3', defaultValue: DEFAULTS.gate3, min: 0, max: 1, curve: 'linear' },
    { id: 'gate4', label: 'G4', defaultValue: DEFAULTS.gate4, min: 0, max: 1, curve: 'linear' },
  ],

  // ── #1958 — THE FOUR "PARAMS" A PLAYER MUST NEVER BE HANDED ────────────────
  //
  // `gate1..4` exist so the cross-domain CV bridge has somewhere to write a raw
  // 0..1 gate swing that `setParam` edge-detects; they are an edge detector's
  // cached level, not a value anyone sets. That was true before this face and
  // it was true of the LEGACY CARD too — which is exactly why the declaration
  // lives on the def rather than inside `face`.
  //
  // ⚠ IT IS A LIVE DEFECT TODAY, NOT A FACE PREREQUISITE. Measured on the real
  // resolver: `listExposableControls('4plexvid')` returns all EIGHT params, so
  // collapsing a rack containing this module offers four knobs that are the
  // edge detector's memory — and dragging one past `GATE_RISE = 0.6` rotates
  // the router. The declaration is what removes them from that bar.
  //
  // ⚠ AND THE FACE COULD NOT HAVE BEEN AUTHORED WITHOUT IT. `module-face-lint`
  // completeness is deny-by-default over every `ParamDef`, and `paramCellKind`
  // answers `'knob'` for these at BOTH tiers (`looksLikeToggle` needs
  // `discrete`, and these are `linear` on purpose). So the only two shapes
  // available were "declare them" and "paint four operable dials over internal
  // state"; there is no skip.
  //
  // `writer: 'cv-port'` is checked against this def's OWN inputs in both
  // directions — each `gate{N}` port declares `paramTarget: 'gate{N}'` above,
  // so the claim is anchored to the wiring rather than asserted.
  noUserControl: [
    {
      param: 'gate1',
      writer: 'cv-port',
      why:
        'the gate1 CV jack writes it through the cross-domain bridge and setParam edge-detects '
        + 'the rising edge to rotate sel1; the stored number is the detector\'s last level, so a '
        + 'knob over it would let a drag past 0.6 rotate the router',
    },
    {
      param: 'gate2',
      writer: 'cv-port',
      why:
        'the gate2 CV jack writes it through the cross-domain bridge and setParam edge-detects '
        + 'the rising edge to rotate sel2; the stored number is the detector\'s last level, so a '
        + 'knob over it would let a drag past 0.6 rotate the router',
    },
    {
      param: 'gate3',
      writer: 'cv-port',
      why:
        'the gate3 CV jack writes it through the cross-domain bridge and setParam edge-detects '
        + 'the rising edge to rotate sel3; the stored number is the detector\'s last level, so a '
        + 'knob over it would let a drag past 0.6 rotate the router',
    },
    {
      param: 'gate4',
      writer: 'cv-port',
      why:
        'the gate4 CV jack writes it through the cross-domain bridge and setParam edge-detects '
        + 'the rising edge to rotate sel4; the stored number is the detector\'s last level, so a '
        + 'knob over it would let a drag past 0.6 rotate the router',
    },
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
      sel1: "OUT 1 selector — a discrete control choosing which input (IN1..IN4, raw index 0..3) output 1 carries. It has four named detents rather than a scale: the faceplate renders them as a row of IN1..IN4 buttons, and gate1 rotates the selection on each rising edge. A non-finite value resolves to IN1.",
      sel2: "OUT 2 selector — a discrete control choosing which input (IN1..IN4, raw index 0..3) output 2 carries. Four named detents rendered as an IN1..IN4 button row on the faceplate; gate2 rotates the selection on each rising edge. A non-finite value resolves to IN1.",
      sel3: "OUT 3 selector — a discrete control choosing which input (IN1..IN4, raw index 0..3) output 3 carries. Four named detents rendered as an IN1..IN4 button row on the faceplate; gate3 rotates the selection on each rising edge. A non-finite value resolves to IN1.",
      sel4: "OUT 4 selector — a discrete control choosing which input (IN1..IN4, raw index 0..3) output 4 carries. Four named detents rendered as an IN1..IN4 button row on the faceplate; gate4 rotates the selection on each rising edge. A non-finite value resolves to IN1.",
      gate1: "NOT A CONTROL — a synthetic param (linear 0..1) holding the gate1 rising-edge detector's last level. The gate1 CV jack writes it through the cross-domain bridge; nothing in the UI offers it, because setting it by hand past the 0.6 rise threshold would rotate the router. Declared noUserControl (writer: cv-port).",
      gate2: "NOT A CONTROL — a synthetic param (linear 0..1) holding the gate2 rising-edge detector's last level, written by the gate2 CV jack through the cross-domain bridge. Declared noUserControl (writer: cv-port), so no knob, encoder or group instrument bar offers it.",
      gate3: "NOT A CONTROL — a synthetic param (linear 0..1) holding the gate3 rising-edge detector's last level, written by the gate3 CV jack through the cross-domain bridge. Declared noUserControl (writer: cv-port), so no knob, encoder or group instrument bar offers it.",
      gate4: "NOT A CONTROL — a synthetic param (linear 0..1) holding the gate4 rising-edge detector's last level, written by the gate4 CV jack through the cross-domain bridge. Declared noUserControl (writer: cv-port), so no knob, encoder or group instrument bar offers it.",
    },
  },
  // ── THE FACE (Q44) ─────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR, VISUALLY: the video sibling of the audio `fourplexer` — a
  // 4x4 DISCRETE CROSS-POINT SWITCH, never a blend. Each output carries exactly
  // one input, chosen by its own selector, and each output's gate jack rotates
  // that selector one step per rising edge. The verb the player performs is
  // CHOOSING WHICH FEED REACHES WHICH SCREEN.
  //
  // ⚠ THE RANKING ARGUMENT IS THAT THERE ISN'T ONE, AND SAYING SO IS THE
  // ARGUMENT. The four selectors are bit-identically symmetric: same range,
  // same curve, same default, same law, one per output. This is the
  // moog992/moog995/moog984 shape — the rank IS declaration order, and any
  // invented priority ("OUT 1 matters most") would be a fiction that reads as
  // defended because it is written down. The merit of this face lives in the
  // `options` roster and in what promotion FIXES, not in the ordering.
  //
  // NO `pages`, DELIBERATELY, and this is the same call the already-faced audio
  // sibling made. One idea, four peers: a single band holding all four
  // selectors. Declaring `pages: [{ id: 'routing', ... }]` would buy exactly one
  // thing — a section heading over the ONLY section — which is "adding a page
  // just to get a header", and it would spend ~81 px of a dock that folds at
  // 720p to restate what the module's own name already says. The dock therefore
  // renders ONE UNLABELLED band; `_shell-faces.ts` still records `pages: 1`,
  // because that roster counts RENDERED bands rather than declared ones.
  //
  // NOT CONTROL-HEAVY: four real controls, one idea. Honest page count 1
  // against `DOCK_TAB_MIN_BANDS = 7`, so no tab rail and no padding toward one.
  //
  // NO HERO. There is no panel to promote (the module's picture is its OUTPUT,
  // which arrives through the `fullViewBody` extension below, not through a
  // `hero.cell` diagram of the patch), and promoting one of four symmetric
  // selectors into a hero would manufacture the priority the paragraph above
  // refuses to invent.
  //
  // NO DERIVED READOUT, AND THE SPEC THAT COMMISSIONED THIS FACE ASKED FOR ONE.
  // The B9.4 spec proposed a `4plexvid-routing` value printing the four live
  // indices as `1·3·1·1`. It is not built, for two independent reasons and
  // either alone would be decisive:
  //   1. The 2026-08-19 owner ruling deleted the hero readout strip and the
  //      sidebar outright — there is no `readouts` field on `ModuleFace` to
  //      declare it in, and re-adding one under a new name is the specific
  //      mistake `face-resting-text-source.test.ts` denies BY SHAPE.
  //   2. `FaceReadoutValue` resolves from STORED params, which on this module
  //      were the wrong half of #1959 — so before the reflect landed the
  //      readout would have printed a confidently wrong string. The spec said
  //      to verify that before promising it; verified, and the answer removes
  //      the readout rather than qualifying it.
  // The routing state is not lost: it is each selector's OWN POSITION, named by
  // the `options` roster, with the full value in `aria-valuetext`.
  //
  // GLYPH: 'none', and it is FORCED rather than chosen. `primaryAudioOutPortId`
  // matches `type === 'audio'` and every output here is `video`, so every other
  // glyph kind resolves `{kind:'static'}` and reddens the dead-glyph clause.
  // The picture arrives through `hasVideoSurface` instead.
  //
  // ⚠ THE TIER LADDER TRUNCATES ASYMMETRICALLY, AND IT IS ACCEPTED ON PURPOSE.
  // With `glyph: 'none'` the compact cap is `LANE_ROW_MAX_CELLS = 3`: mini
  // shows OUT 1, compact shows OUT 1-3 and **OUT 4 disappears**, plate and dock
  // show all four. Hiding one of four symmetric outputs is a genuinely odd tier
  // state and the alternative was worse — capping the face at three selectors
  // would delete a real output everywhere, and there is no honest basis for
  // ranking OUT 4 last other than that the lane budget is three. The dock is
  // where routing gets done; the lane tile is a reminder of what is patched.
  face: {
    extension: '4plexvid',
    glyph: 'none',
    order: [...SEL_IDS],
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
