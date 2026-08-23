// packages/web/src/lib/video/modules/ruttetra.ts
//
// RUTTETRA — AUTHENTIC forward-scatter Rutt-Etra raster scope.
//
// A faithful WebGL2 port of p10entrancer's "XYZ" unit
// (P10Entrancer/Shaders/XYZ.metal + Mixer/XYZRenderer.swift). Unlike
// RESHAPER (which is a fragment-shader coordinate REMAP), this is REAL
// line geometry — the classic Rutt-Etra scan-processor look:
//
//   - A cols×rows grid (320×180) of sample points walks the source.
//   - For each grid point: read source luma, compute a shaped H/V ramp
//     base position, displace by luma, emit a vertex.
//   - Draw LINE-LIST segments connecting adjacent COLUMNS within each
//     row. Each row is a horizontal scanline that bows in X/Y by luma.
//   - ADDITIVE blending (CRT phosphor); clear to black.
//
// Bright source pixels push their scanline OUTWARD → a 3D heightmap.
//
// Implementation notes (vs the Metal original):
//   - The engine's compileFragment() only pairs a frag with a shared
//     fullscreen-quad vertex shader. Line geometry needs its own vertex
//     shader, so we build our own program directly via ctx.gl.
//   - Attributeless rendering: an ELEMENT_ARRAY_BUFFER index buffer holds
//     the line list (2*(cols-1)*rows UInt32 grid-point ids, built exactly
//     like XYZRenderer.swift). gl.drawElements(LINES, ..., UNSIGNED_INT).
//     UInt32 indices are core in WebGL2 (no OES_element_index_uint).
//   - In the vertex shader, gl_VertexID == the index value under
//     drawElements (WebGL2), i.e. the grid-point id. We derive
//     col/row/h0/v0 from it and sample Z via vertex texture fetch
//     (WebGL2 guarantees vertex texture units).
//   - Renders into a per-instance FBO from createFbo(); exposes the
//     standard `out` video port + drives the on-card preview via
//     blitOutputToDrawingBuffer, exactly like RESHAPER / videoOut.
//
// Z unpatched: bind a mid-grey source so luma≈0.5 → zero displacement →
// flat scanlines are still drawn (no black void on cold-spawn), matching
// how RESHAPER avoided a black card.
//
// Inputs:
//   z (video): source video — luma drives per-grid-point displacement.
//   xShape / yShape / xDisp / yDisp / intensity / xFreq / yFreq
//     (cv, linear, paramTarget=…): per-param CV.
//
// Outputs:
//   out (video): the additive-blend scanline render.
//
// Params:
//   xShape / yShape (linear 0..1): per-axis ramp shape morph.
//   xDisp / yDisp (linear -1..1): per-axis static displacement.
//   intensity (linear 0..2): luma-to-displacement scale.
//   tintR / tintG / tintB (linear 0..1): scanline tint colour.
//   xFreq / yFreq (linear 0.25..8): per-axis ramp frequency.
//   xPhase / yPhase (linear 0..1): per-axis phase offset.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

/** Grid resolution — matches XYZRenderer.swift (320×180 = 57,600 grid
 *  points). Dense enough to read like a real scanline raster, sparse
 *  enough that the heightmap displacement reads clearly. */
const COLS = 320;
const ROWS = 180;

/**
 * Pure TS mirror of the GLSL `shapedRamp` (port of XYZ.metal). Kept in
 * lockstep with the shader source above so the morph crossfade can be
 * unit-tested without a GL context. Any change here MUST be mirrored in
 * VERT_SRC's shapedRamp and vice-versa.
 *
 *   morph 0      → linear ramp  fract(t)
 *   morph 0.333  → triangle     |2*fract(t)-1|
 *   morph 0.666  → soft-fold    0.5 - 0.5*cos(2π*fract(t))
 *   morph 1      → radial       clamp(|uv-0.5|·√2, 0, 1)
 */
export function shapedRamp(t: number, uvx: number, uvy: number, morph: number): number {
  const lin = t - Math.floor(t); // fract(t)
  const tri = Math.abs(2.0 * lin - 1.0);
  const sf = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * lin);
  const dx = uvx - 0.5;
  const dy = uvy - 0.5;
  const radial = Math.min(Math.max(Math.sqrt(dx * dx + dy * dy) * 1.41421356, 0.0), 1.0);
  const m = Math.min(Math.max(morph, 0.0), 1.0);
  if (m < 0.333) {
    return lin + (tri - lin) * (m * 3.0);
  } else if (m < 0.666) {
    return tri + (sf - tri) * ((m - 0.333) * 3.0);
  } else {
    return sf + (radial - sf) * ((m - 0.666) * 3.0);
  }
}

const VERT_SRC = `#version 300 es
precision highp float;

uniform sampler2D uZ;       // source video (luma drives displacement)
uniform float uCols;
uniform float uRows;
uniform float uXShape;
uniform float uYShape;
uniform float uXDisp;
uniform float uYDisp;
uniform float uIntensity;
uniform float uTintR;
uniform float uTintG;
uniform float uTintB;
uniform float uXFreq;
uniform float uYFreq;
uniform float uXPhase;
uniform float uYPhase;

out vec3 vColor;

#define PI 3.14159265358979323846

// Port of XYZ.metal shapedRamp(). morph crossfades:
//   0=linear, 0.333=triangle, 0.666=soft-fold (raised cosine), 1=radial.
float shapedRamp(float t, vec2 uv, float morph) {
  float lin = fract(t);
  float tri = abs(2.0 * lin - 1.0);
  float sf = 0.5 - 0.5 * cos(2.0 * PI * lin);
  float radial = clamp(length(uv - 0.5) * 1.41421356, 0.0, 1.0);
  morph = clamp(morph, 0.0, 1.0);
  if (morph < 0.333) {
    return mix(lin, tri, morph * 3.0);
  } else if (morph < 0.666) {
    return mix(tri, sf, (morph - 0.333) * 3.0);
  } else {
    return mix(sf, radial, (morph - 0.666) * 3.0);
  }
}

void main() {
  // gl_VertexID == the index value pulled from the bound
  // ELEMENT_ARRAY_BUFFER under drawElements (WebGL2). That value is the
  // grid-point id, exactly the Metal vertex_id.
  float id = float(gl_VertexID);
  float cols = uCols;
  float rows = uRows;
  float col = mod(id, cols);
  float row = floor(id / cols);
  float h0 = col / (cols - 1.0);
  float v0 = row / (rows - 1.0);

  // Sample source. Luma drives displacement; color comes out as-is.
  //
  // Y-FLIP: source frames are uploaded with UNPACK_FLIP_Y_WEBGL, so the
  // input texture's v=0 is the BOTTOM of the source and v=1 the TOP — the
  // same convention every fullscreen-quad module relies on when it samples
  // texture(uTex, vUv) and renders upright (CHROMA, BENTBOX, etc.). Grid
  // row 0 (v0=0) is placed at the NDC TOP (ndcY = 1 - 0), so we must read
  // the texture TOP there: sample at (h0, 1.0 - v0). Without the flip,
  // row 0 read texture v=0 (source bottom) and drew it at the top, i.e.
  // the whole raster came out vertically inverted vs. every sibling.
  //
  // IMPORTANT: use textureLod(..., 0.0), NOT texture(). In GLSL ES 3.00 a
  // VERTEX-stage texture() has no implicit LOD (no fragment-quad
  // derivatives exist), so the LOD it samples is implementation-defined.
  // SwiftShader/ANGLE-Vulkan happens to pick LOD 0, but the macOS
  // ANGLE-Metal backend can return a constant value for every vertex —
  // which collapses lum to a constant and turns the per-vertex luma
  // RELIEF into a UNIFORM raster translation (the owner-reported X/Y Disp
  // bug). textureLod with an explicit LOD of 0.0 forces the base mip on
  // every driver, restoring the per-vertex heightmap.
  vec4 src = textureLod(uZ, vec2(h0, 1.0 - v0), 0.0);
  float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));

  // Shaped ramps → base H/V position. morph 0 = linear, so the unshaped
  // raster reproduces the source 1:1 before luma displacement.
  float h = shapedRamp(h0 * uXFreq + uXPhase, vec2(h0, v0), uXShape);
  float v = shapedRamp(v0 * uYFreq + uYPhase, vec2(h0, v0), uYShape);

  // Bipolar displacement (lum - 0.5 so mid-grey doesn't move).
  float x = h + (lum - 0.5) * uXDisp;
  float y = v + (lum - 0.5) * uYDisp;

  // [0,1] → NDC. UVs are y-down; GL NDC is y-up, so flip Y (matches the
  // Metal port's ndcY = 1 - y*2).
  float ndcX = x * 2.0 - 1.0;
  float ndcY = 1.0 - y * 2.0;

  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);
  vColor = src.rgb * uIntensity * vec3(uTintR, uTintG, uTintB);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, 1.0);
}`;

interface RuttetraParams {
  xShape: number;
  yShape: number;
  xDisp: number;
  yDisp: number;
  intensity: number;
  tintR: number;
  tintG: number;
  tintB: number;
  xFreq: number;
  yFreq: number;
  xPhase: number;
  yPhase: number;
}

const DEFAULTS: RuttetraParams = {
  xShape: 0,
  yShape: 0,
  xDisp: 0,
  // Default -0.3 makes bright pixels push UP → the classic "raised
  // terrain" Rutt-Etra look out of the box (matches XYZState.swift).
  yDisp: -0.3,
  // 1.5 keeps the additive lines from looking too dim (matches XYZState).
  intensity: 1.5,
  tintR: 1.0,
  tintG: 1.0,
  tintB: 1.0,
  xFreq: 1.0,
  yFreq: 1.0,
  xPhase: 0,
  yPhase: 0,
};

/** Build the line-list index buffer EXACTLY like XYZRenderer.swift:
 *  connect adjacent columns within each row. 2*(cols-1)*rows indices.
 *  Exposed for unit tests. */
export function buildRuttetraIndices(cols = COLS, rows = ROWS): Uint32Array {
  const out = new Uint32Array(2 * (cols - 1) * rows);
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      out[i++] = r * cols + c;
      out[i++] = r * cols + c + 1;
    }
  }
  return out;
}

export const RUTTETRA_GRID = { cols: COLS, rows: ROWS } as const;

// ⚠ THE MONITOR BOX MOVED OUT OF THIS DEF (2026-08-21). It is now
// `$lib/ui/modules/ruttetra/monitor-box.ts`, imported by the card and the
// faced body exactly as before — the one-source rule is unchanged, only its
// address. It left because ALL of `lib/video/**` is swept into the WebGL
// attest basis, so six layout numbers here made every monitor-box edit a
// real-GPU re-attest; a probe on the monoglitch branch showed those eight lines
// were the ONLY hash contribution of an entire face. See that file's header.

/**
 * The morph anchors of `shapedRamp`, as NAMED WAYPOINTS on a continuous param
 * (PF-10 `landmarks`) — ONE source for both shape params.
 *
 * ⚠ THESE ARE THE SHADER'S OWN ARM BOUNDARIES, not a display table. `:83-89`
 * crossfades `lin → tri` over `[0, 0.333)`, `tri → sf` over `[0.333, 0.666)`
 * and `sf → radial` over `[0.666, 1]`, so 0 / 0.333 / 0.666 / 1 are exactly the
 * four values at which the ramp IS one named shape rather than a blend of two.
 * `knobNameReadout` paints the NEAREST one, which derives the display
 * boundaries (0.1665 / 0.4995 / 0.833) from these anchors instead of re-typing
 * a second set of thresholds the way the legacy card does.
 *
 * ⚠ `radial` AT 1 IS THE DECLARED INTENT, AND THE SHADER OVERSHOOTS IT BY
 * 0.2 % (#1863, open) — arm 3's coefficient reaches 1.002 at `m = 1`, which
 * `ruttetra.test.ts:63-81` pins DELIBERATELY as bit-faithful to the shader.
 * This roster names the intent, not the residue; #1863 is the owner's call on
 * whether the maths or the docs move, and nothing here prejudges it.
 */
const SHAPE_LANDMARKS = [
  { value: 0,     label: 'linear'   },
  { value: 0.333, label: 'triangle' },
  { value: 0.666, label: 'soft'     },
  { value: 1,     label: 'radial'   },
] as const;

export const ruttetraDef: VideoModuleDef = {
  type: 'ruttetra',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  // Display name only — the type id stays 'ruttetra' so existing patches/edges
  // /persistence and all test/VRT/registry keys are untouched (shallow rename).
  label: 'xyz',
  category: 'output',
  // schemaVersion 2: the type id `ruttetra` previously belonged to the
  // coord-remap (now RESHAPER, schemaVersion 1). Patches saved before the
  // rename recorded `ruttetra: 1`; the persistence loader remaps those to
  // `reshaper` so old saves keep their look. See graph/persistence.ts.
  inputs: [
    // Single source video. Polymorphic 'video' so mono-video / image /
    // keys upcast in via the engine's implicit upcasts. (No X/Y
    // coordinate-field inputs — the ramp is internal; that's the
    // difference from RESHAPER.)
    { id: 'z', type: 'video' },
    // CV inputs for the expressive params. port id == param id so the
    // cross-domain CV bridge routes audio cv → setParam(portId).
    { id: 'xShape',    type: 'cv', paramTarget: 'xShape',    cvScale: { mode: 'linear' } },
    { id: 'yShape',    type: 'cv', paramTarget: 'yShape',    cvScale: { mode: 'linear' } },
    { id: 'xDisp',     type: 'cv', paramTarget: 'xDisp',     cvScale: { mode: 'linear' } },
    { id: 'yDisp',     type: 'cv', paramTarget: 'yDisp',     cvScale: { mode: 'linear' } },
    { id: 'intensity', type: 'cv', paramTarget: 'intensity', cvScale: { mode: 'linear' } },
    { id: 'xFreq',     type: 'cv', paramTarget: 'xFreq',     cvScale: { mode: 'linear' } },
    { id: 'yFreq',     type: 'cv', paramTarget: 'yFreq',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    // ⚠ THE TWO SHAPE PARAMS CARRY `landmarks` AND MUST STAY KNOBS. The card
    // re-types seven thresholds (`RuttetraCard.svelte:57-66`: 0.083 / 0.25 /
    // 0.416 / 0.583 / 0.75 / 0.916) that appear NOWHERE in this def, so a
    // def-driven face would have lost the morph name entirely and porting the
    // table would have shipped the same re-typed mapping with fresh paint.
    // These four anchors are the shader's OWN arms (`shapedRamp`, :83-89), so
    // nearest-match derives the boundaries (0.1665 / 0.4995 / 0.833) instead of
    // re-typing them.
    //
    // ⚠ AND THE CELL KIND IS LOAD-BEARING, WHICH IS NOT OBVIOUS AND WAS NEARLY
    // GOT WRONG. `landmarks` is read by exactly ONE primitive: `KnobConic`
    // (`ModuleShell.svelte`, `landmarks={pd.landmarks}` on the knob branch).
    // `NeonFader` is passed `options` and NOT `landmarks`, so declaring
    // `paramCells: 'fader'` for these two — which card fidelity would otherwise
    // argue for, since the card draws all twelve as throws — would silently
    // drop every name while leaving this declaration looking honoured. The
    // face therefore leaves xShape/yShape at the shell's DEFAULT dial and
    // declares `fader` for the other ten; `ruttetra-face-model.test.ts` pins
    // that pairing with the fader case as its negative control.
    { id: 'xShape',    label: 'X Shape',   defaultValue: DEFAULTS.xShape,    min: 0,    max: 1, curve: 'linear',
      landmarks: SHAPE_LANDMARKS },
    { id: 'yShape',    label: 'Y Shape',   defaultValue: DEFAULTS.yShape,    min: 0,    max: 1, curve: 'linear',
      landmarks: SHAPE_LANDMARKS },
    { id: 'xDisp',     label: 'X Disp',    defaultValue: DEFAULTS.xDisp,     min: -1,   max: 1, curve: 'linear' },
    { id: 'yDisp',     label: 'Y Disp',    defaultValue: DEFAULTS.yDisp,     min: -1,   max: 1, curve: 'linear' },
    { id: 'intensity', label: 'Intensity', defaultValue: DEFAULTS.intensity, min: 0,    max: 2, curve: 'linear' },
    // ⚠ `R` / `G` / `B`, NOT `Tint R` / `Tint G` / `Tint B`. The redundancy the
    // owner's caption ruling targets is the word "Tint" under a page already
    // called BEAM — not the letter, which is the ONLY thing separating three
    // otherwise-identical controls and is therefore tidyVco's `A`/`D`/`S`/`R`,
    // which the ruling explicitly KEEPS. So the fix is the label, and
    // `face.bareCells` is deliberately NOT declared: hiding these captions
    // would leave three indistinguishable knobs. It also aligns the def with
    // the card, which has always passed `label="R"` (`:281-283`).
    { id: 'tintR',     label: 'R',         defaultValue: DEFAULTS.tintR,     min: 0,    max: 1, curve: 'linear' },
    { id: 'tintG',     label: 'G',         defaultValue: DEFAULTS.tintG,     min: 0,    max: 1, curve: 'linear' },
    { id: 'tintB',     label: 'B',         defaultValue: DEFAULTS.tintB,     min: 0,    max: 1, curve: 'linear' },
    { id: 'xFreq',     label: 'X Freq',    defaultValue: DEFAULTS.xFreq,     min: 0.25, max: 8, curve: 'linear' },
    { id: 'yFreq',     label: 'Y Freq',    defaultValue: DEFAULTS.yFreq,     min: 0.25, max: 8, curve: 'linear' },
    { id: 'xPhase',    label: 'X Phase',   defaultValue: DEFAULTS.xPhase,    min: 0,    max: 1, curve: 'linear' },
    { id: 'yPhase',    label: 'Y Phase',   defaultValue: DEFAULTS.yPhase,    min: 0,    max: 1, curve: 'linear' },
  ],

  // ── THE FACEPLATE (#2009) ────────────────────────────────────────────────
  //
  // The verb is TILT: you are sculpting relief out of a flat image. Every page
  // below is ONE expression of the vertex shader, which is why there are four
  // of them and not the six the queue proposed — `h0 * uXFreq + uXPhase` is one
  // expression with two terms, not two ideas, and splitting BEAM off TINT would
  // leave a one-control page for a control that is not this module's identity.
  //
  // ⚠ UNTABBED BY OWNER RULING ("2 - a"), and the arithmetic agrees rather than
  // merely permitting it. `DOCK_TAB_MIN_BANDS` is 7; four honest bands pack to
  // TWO ROWS under `dock-row-plan`'s `DOCK_ROW_MAX_CONTROLS = 10` ((2+2) then
  // (4+4)), which is the compact plate the width ruling asks for. Reaching the
  // rail would have meant padding the pages to hit a threshold — the thing the
  // ruling forbids — and ruttetra, the module the tabbed ruling first NAMED, is
  // the weakest tab candidate in the video bank.
  face: {
    // ⚠ `order` AND `pages` DELIBERATELY DISAGREE, and both are derived.
    // `order` is the TIER LADDER (which controls survive down to a lane tile),
    // ranked by how much of the picture each moves; `pages` groups by IDEA for
    // the dock. Y leads X throughout because Y is the relief axis: the def
    // spends its ONE non-neutral default on `yDisp` (-0.3, "the classic raised
    // terrain look"), while every other geometry param ships at its identity
    // value. That single fact selects the hero, and it is a proof rather than a
    // sample — on `mirrorpool` the same argument selects nothing, and on
    // `spirographs` the ranking argument is inertness instead.
    //
    // The ladder as a sentence, MEASURED through `curatedFace` rather than
    // inferred from `LANE_PLATE_MAX_CELLS`: at mini you get RELIEF; at compact,
    // relief and its X partner; and everything else — the shapes, the scan pair,
    // the beam, the tint and the phases — is DOCK-ONLY.
    //
    // ⚠ THIS SENTENCE USED TO PROMISE "at plate, the whole geometry story" AND
    // THAT WAS FALSE (corrected 2026-08-21, #2085). `FACE_TIER_CAPS.full` is
    // `LANE_PLATE_MAX_CELLS` = 6, but `faceTierCap` does not return that
    // constant — it runs `laneBodyPlan`, which fits CELLS INTO GEOMETRY, and a
    // `fader` is a TALL cell. With the video surface taking its share this face
    // resolves plate = compact = 2 (`yDisp`, `xDisp`), so the plate never showed
    // a "geometry story" at all. Measured identically on `monoglitch` (8 params)
    // and `reshaper` (6): every video fader face is plate = 2. The same wrong
    // inference was made independently on both of those and corrected there;
    // this is the last copy of it.
    order: [
      'yDisp', 'xDisp', 'yShape', 'xShape', 'yFreq', 'xFreq',
      'intensity', 'tintR', 'tintG', 'tintB', 'yPhase', 'xPhase',
    ],

    pages: [
      {
        id: 'relief',
        label: 'relief',
        hint: 'the (luma - 0.5) x disp term - the module\'s whole identity: how far a bright pixel pushes its scanline out of the plane',
        controls: ['yDisp', 'xDisp'],
      },
      {
        id: 'shape',
        label: 'shape',
        hint: 'shapedRamp\'s morph argument - the geometry the source is laid along before luma displaces it, from a 1:1 linear raster through triangle and soft-fold to radial',
        controls: ['yShape', 'xShape'],
      },
      {
        id: 'scan',
        label: 'scan',
        hint: 'the ramp argument itself - how many cycles span the frame and where each starts. One expression with two terms, which is why frequency and phase are one page',
        controls: ['yFreq', 'xFreq', 'yPhase', 'xPhase'],
      },
      {
        id: 'beam',
        label: 'beam',
        hint: 'the whole of vColor - the phosphor colour and how hard it is driven into the additive blend. Disjoint from the geometry above: these four move colour and nothing else',
        controls: ['intensity', 'tintR', 'tintG', 'tintB'],
      },
    ],

    // ⚠ MANDATORY AND COUNTER-INTUITIVE, the same trap backdraft, spirographs,
    // mirrorpool and grainsOfVision all document. `primaryAudioOutPortId` needs
    // a `type: 'audio'` output and this def has none, so ANY other glyph literal
    // falls through `glyphBinding` to `{kind:'static'}` and reddens
    // module-face-lint's dead-glyph clause. The live picture arrives from two
    // OTHER seams entirely — `hasVideoSurface(def)` mounting VideoTileThumb at
    // the lane, and the `fullViewBody` extension at the dock — so assert
    // `hasVideoSurface`, never this declaration: 'none' + blank tile and
    // 'none' + live thumb are indistinguishable from the declaration alone.
    glyph: 'none',

    // THE SCREEN SWITCH, THE RESIZE HANDLE AND THE MONITOR TOGGLE ALL ARRIVE
    // THROUGH THIS SLOT, and they have to (#1928 / #2009). Promotion sets
    // `migrated('ruttetra')` true and neither surface renders
    // `RuttetraCard.svelte` again, so anything authored on the card is deleted
    // by the promotion meant to keep it.
    extension: 'ruttetra',

    // ⚠ MONITOR MODE — the seam this face exists to prove (#2009). The def's
    // own `docs` have always advertised the gesture in the user's words
    // ("hiding the controls turns it into a resizable monitor"), so promoting
    // without it would have left the SHIPPED DOCUMENTATION describing a control
    // that no longer exists — a failure no def-reading gate can see, because
    // every one of them reads the same def that tells the lie.
    monitor: {
      why:
        'RUTTETRA\'s output is a RASTER SCOPE: 57,420 additive line segments over black, and '
        + 'the relief it builds is a shape you read by LOOKING at it, not a value any control '
        + 'reports. Every dial here — the two disp terms, the two ramp morphs, the scan pair, '
        + 'the beam — is aimed at that picture, so "sculpt it, then watch it" is the module\'s '
        + 'actual working loop rather than a convenience. Its docs have advertised the monitor '
        + 'since it shipped, and the picture is also the ONLY surface that can show the flyback '
        + 'streaks and the shape-morph geometry #1862/#1863 are open about.',
    },

    // The card draws all twelve as `<NeonFader>` THROWS, and nothing in a
    // ParamDef separates "a throw" from any other continuous scalar — so
    // undeclared, the face would repaint every one as a dial and stop looking
    // like the control the player already knows.
    //
    // ⚠ TWO ARE DELIBERATELY ABSENT, and it is not an oversight: `xShape` and
    // `yShape` declare `landmarks`, which ONLY `KnobConic` renders (the fader
    // branch is passed `options` and not `landmarks`). Declaring `fader` for
    // them would silently delete the linear/triangle/soft/radial names while
    // leaving the `landmarks` declaration looking honoured — a green gate over
    // a live regression. They stay dials on purpose; see the param comment.
    paramCells: {
      yDisp: 'fader', xDisp: 'fader',
      yFreq: 'fader', xFreq: 'fader', yPhase: 'fader', xPhase: 'fader',
      intensity: 'fader', tintR: 'fader', tintG: 'fader', tintB: 'fader',
    },

    // ⚠ NO `hero`, NO READOUT ROW, NO SIDEBAR. Two derived readouts were
    // specced for this face — peak relief as a fraction of frame height, and
    // the fraction of the frame the ramp actually covers — and the 2026-08-19
    // rulings deleted the SHAPE they would have been painted in. Saying which
    // finding lost its surface, as the ruling requires: the `Freq < 1` case,
    // where the whole picture compresses into the left/top quarter of the
    // output. It survives in `docs.controls` (corrected in this diff, which is
    // where it should have been all along) rather than as resting text.
    //
    // ⚠ NO `bareCells` EITHER — see the tint label comment above; hiding those
    // three captions is the one thing that would make them indistinguishable.
  },

  docs: {
    explanation: `An authentic forward-scatter Rutt/Etra scan-processor. A 320x180 grid of sample points walks the Z source; for each point it reads the source luma, places it along an internally-generated H/V ramp, then displaces that position by (luma - 0.5) so bright pixels push their scanline outward and dark pixels recede - building a 3D heightmap relief out of the picture. Adjacent grid points within each row are joined into horizontal LINE segments, and the whole raster is drawn with additive (phosphor) blending over a black field, exactly like a CRT scope. With everything at default the ramp is a linear 1:1 mapping and Y Disp = -0.3, so the source is read upright and bright areas raise the terrain - the classic Rutt/Etra "raised landscape" look. Patch any video, image, or keyer into Z; sweep Y Disp (and X Disp) for relief depth, raise Intensity for a brighter glow, morph the X/Y Shape ramps toward triangle/soft/radial for warped scan geometry, and modulate the params with CV for animated topography. Z left unpatched binds a mid-grey sentinel (luma 0.5 = zero displacement), so the card shows flat scanlines rather than a black void. There is a live preview screen with the picture, and two switches beside it that do opposite things: SCREEN turns the preview off to reclaim its space (the module goes on rendering either way), and MONITOR hides the control bands so the picture has the whole plate to itself - drag the bottom-right corner to size it, and click MONITOR again to bring the controls back. Either way it is a viewport only; neither changes the output resolution.`,
    inputs: {
      z: "Z (video) - the source frame. Its per-pixel luma (0.299R+0.587G+0.114B) is sampled at each of the 320x180 grid points and drives that point's outward displacement; the source RGB is also carried through as the scanline color. Accepts video, mono-video, image, or keys (upcast by the engine). Unpatched, a mid-grey 1x1 texture is bound so luma is 0.5 everywhere and the scanlines draw flat instead of going black.",
      xShape: "X Shape (cv) - modulates the X Shape control, morphing the horizontal ramp shape (linear -> triangle -> soft-fold -> radial) that positions each scanline across the frame.",
      yShape: "Y Shape (cv) - modulates the Y Shape control, morphing the vertical ramp shape (linear -> triangle -> soft-fold -> radial) that stacks the scanlines down the frame.",
      xDisp: "X Disp (cv) - modulates the X Disp control, scaling how far each point is pushed left/right by its luma (bipolar around mid-grey).",
      yDisp: "Y Disp (cv) - modulates the Y Disp control, scaling how far each point is pushed up/down by its luma; this is the main relief/height knob of the heightmap.",
      intensity: "Intensity (cv) - modulates the Intensity control, scaling the brightness of the additively-blended scanlines.",
      xFreq: "X Freq (cv) - modulates the X Freq control, setting how many horizontal ramp cycles span the frame (0.25..8); higher values repeat the scan pattern across X.",
      yFreq: "Y Freq (cv) - modulates the Y Freq control, setting how many vertical ramp cycles span the frame (0.25..8); higher values repeat the scan pattern down Y.",
    },
    outputs: {
      out: "out (video) - the rendered Rutt/Etra raster: additive horizontal scanlines, luma-displaced into a heightmap, over a black phosphor field. Chainable into any video input and also feeds the on-card preview screen.",
    },
    controls: {
      xShape: "X Shape (0..1, default 0) - morphs the horizontal ramp shape that lays the source across each scanline. 0 = linear (1:1, the unwarped raster), ~0.33 = triangle, ~0.66 = soft-fold (raised cosine), 1 = radial (distance from center). The dial is marked at those four anchors and names the nearest one as you sweep it (linear / triangle / soft / radial); the legacy card prints the crossfades between them as well.",
      yShape: "Y Shape (0..1, default 0) - morphs the vertical ramp shape that stacks the scanlines down the frame, through the same linear -> triangle -> soft-fold -> radial sequence as X Shape, marked and named at the same four anchors.",
      xDisp: "X Disp (-1..1, default 0) - bipolar amount that luma pushes each point horizontally. (luma - 0.5) * X Disp, so mid-grey never moves; negative and positive deflect bright pixels to opposite sides.",
      yDisp: "Y Disp (-1..1, default -0.3) - bipolar amount that luma pushes each point vertically; this builds the 3D relief. The default -0.3 makes bright pixels rise (the classic raised-terrain look).",
      intensity: "Intensity (0..2, default 1.5) - multiplies the scanline color before the additive blend; raises or dims the overall glow of the raster (default 1.5 keeps the additive lines from looking too faint). It affects brightness only, not relief depth.",
      tintR: "R (0..1, default 1) - red multiplier applied to every scanline's color. Lower it to drain red from the phosphor tint. No CV input (panel control only).",
      tintG: "G (0..1, default 1) - green multiplier applied to every scanline's color. Lower it to drain green from the phosphor tint. No CV input (panel control only).",
      tintB: "B (0..1, default 1) - blue multiplier applied to every scanline's color. Combine R/G/B to push the whole raster toward a monochrome CRT hue. No CV input (panel control only).",
      xFreq: "X Freq (0.25..8, default 1) - horizontal ramp frequency: how many shape-ramp cycles span the frame in X. 1 = one pass; higher values repeat/fold the scan pattern across the width. BELOW 1 the ramp never completes, so the picture is COMPRESSED into that fraction of the width and the rest of the frame stays black - at 0.25 the whole raster occupies the left quarter. On the faceplate it sits on the SCAN page beside X Phase; the legacy card keeps it under the ADVANCED disclosure.",
      yFreq: "Y Freq (0.25..8, default 1) - vertical ramp frequency: how many shape-ramp cycles span the frame in Y. 1 = one pass; higher values repeat/fold the scanlines down the height. BELOW 1 the scanlines are compressed into that fraction of the height - at 0.25 the whole raster occupies the top quarter. On the faceplate it sits on the SCAN page; the legacy card keeps it under ADVANCED.",
      xPhase: "X Phase (0..1, default 0) - phase offset added to the horizontal ramp after the frequency multiply and before shaping, sliding the X scan pattern sideways. Panel control only (no CV input); on the SCAN page of the faceplate, under ADVANCED on the legacy card.",
      yPhase: "Y Phase (0..1, default 0) - phase offset added to the vertical ramp after the frequency multiply and before shaping, sliding the Y scan pattern up/down. Panel control only (no CV input); on the SCAN page of the faceplate, under ADVANCED on the legacy card.",
    },
  },
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // ---- Build our own program (line geometry needs a custom vertex
    //      shader; the engine's compileFragment only does fullscreen
    //      quads). ----
    function compile(type: number, src: string): WebGLShader {
      const sh = gl.createShader(type);
      if (!sh) throw new Error('RUTTETRA: createShader failed');
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`RUTTETRA: shader compile failed: ${log}`);
      }
      return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram();
    if (!program) throw new Error('RUTTETRA: createProgram failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`RUTTETRA: program link failed: ${log}`);
    }

    const uZ         = gl.getUniformLocation(program, 'uZ');
    const uCols      = gl.getUniformLocation(program, 'uCols');
    const uRows      = gl.getUniformLocation(program, 'uRows');
    const uXShape    = gl.getUniformLocation(program, 'uXShape');
    const uYShape    = gl.getUniformLocation(program, 'uYShape');
    const uXDisp     = gl.getUniformLocation(program, 'uXDisp');
    const uYDisp     = gl.getUniformLocation(program, 'uYDisp');
    const uIntensity = gl.getUniformLocation(program, 'uIntensity');
    const uTintR     = gl.getUniformLocation(program, 'uTintR');
    const uTintG     = gl.getUniformLocation(program, 'uTintG');
    const uTintB     = gl.getUniformLocation(program, 'uTintB');
    const uXFreq     = gl.getUniformLocation(program, 'uXFreq');
    const uYFreq     = gl.getUniformLocation(program, 'uYFreq');
    const uXPhase    = gl.getUniformLocation(program, 'uXPhase');
    const uYPhase    = gl.getUniformLocation(program, 'uYPhase');

    // ---- Index buffer + VAO (attributeless; gl_VertexID supplies the
    //      grid-point id). ----
    const indices = buildRuttetraIndices(COLS, ROWS);
    const indexCount = indices.length;
    const vao = gl.createVertexArray();
    const ibo = gl.createBuffer();
    if (!vao || !ibo) throw new Error('RUTTETRA: VAO / index buffer alloc failed');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    // ---- Per-instance FBO (output target + chainable `out` texture). ----
    const { fbo, texture } = ctx.createFbo();

    // Mid-grey 1×1 sentinel for unpatched Z — luma 0.5 → zero
    // displacement → flat scanlines (visible, not a black void).
    const greyTex = gl.createTexture();
    if (!greyTex) throw new Error('RUTTETRA: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, greyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([128, 128, 128, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: RuttetraParams = { ...DEFAULTS, ...(node.params as Partial<RuttetraParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const zTex = frame.getInputTexture(node.id, 'z');

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);

        // Clear to black (CRT phosphor backdrop) then additive-blend the
        // scanlines. Save/restore so we don't leak blend state to the
        // next module in the topo order (fullscreen-quad modules assume
        // blend is off).
        g.clearColor(0, 0, 0, 1);
        g.clear(g.COLOR_BUFFER_BIT);
        g.enable(g.BLEND);
        g.blendFunc(g.ONE, g.ONE);
        g.blendEquation(g.FUNC_ADD);

        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, zTex ?? greyTex);
        g.uniform1i(uZ, 0);

        g.uniform1f(uCols, COLS);
        g.uniform1f(uRows, ROWS);
        g.uniform1f(uXShape,    params.xShape);
        g.uniform1f(uYShape,    params.yShape);
        g.uniform1f(uXDisp,     params.xDisp);
        g.uniform1f(uYDisp,     params.yDisp);
        g.uniform1f(uIntensity, params.intensity);
        g.uniform1f(uTintR,     params.tintR);
        g.uniform1f(uTintG,     params.tintG);
        g.uniform1f(uTintB,     params.tintB);
        g.uniform1f(uXFreq,     params.xFreq);
        g.uniform1f(uYFreq,     params.yFreq);
        g.uniform1f(uXPhase,    params.xPhase);
        g.uniform1f(uYPhase,    params.yPhase);

        g.bindVertexArray(vao);
        g.drawElements(g.LINES, indexCount, g.UNSIGNED_INT, 0);
        g.bindVertexArray(null);

        g.disable(g.BLEND);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(greyTex);
        gl.deleteBuffer(ibo);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'fboTexture') return texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
