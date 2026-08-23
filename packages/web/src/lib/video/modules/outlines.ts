// packages/web/src/lib/video/modules/outlines.ts
//
// OUTLINES — stateful particle video generator (LZX-style primitive source).
//
// (Was CIRCLES — renamed when the SHAPE selector landed: a spawned shape can
// now be a CIRCLE or a regular N-gon — triangle / square / pentagon / hexagon /
// octagon — inscribed in the diameter, plus a live-global ROTATION that spins
// every shape coherently.)
//
// A gate event (or the internal rate clock) spawns a shape at a seeded-
// random position; shapes move in a latched direction at a latched speed
// and BOUNCE when their CENTER hits a wall, accumulating into a 1024-px
// field. Four outputs derive from a per-pixel overlap-COUNT of the active
// shapes:
//
//   overlap (mono-video): white where ≥1 shape covers the pixel.
//   contour (mono-video): shape OUTLINES only (ring lw = 10% of d, min 2 px)
//                         → "ripples in a pond" as many shapes stack.
//   combine (video):      the overlap region colorized by overlap COUNT via a
//                         hue ramp (1 = first hue; 2,3,4… cycle the spectrum)
//                         with brightness + saturation rising with stack depth.
//   mapped  (video):      the `video` INPUT's contents wherever ≥2 shapes
//                         overlap, black elsewhere.
//
// Inputs:
//   gate    (gate):  a rising edge spawns one shape.
//   collide (gate):  LIVE GLOBAL mode (NOT spawn-latched). While HIGH, shapes
//                    bounce off EACH OTHER (elastic, bounding-circle detection —
//                    circumcircles touch when center distance ≤ r1+r2);
//                    LOW/unpatched = pass-through (the original behaviour).
//   d / v / spd / decay / shape / rotation (cv, paramTarget=…): per-param CV
//                 (diameter / vector / speed / fade-out time / shape selector /
//                 bipolar spin).
//   video (video): sampled by the `mapped` output.
//
// Params (knobs):
//   d   (0..1 → 5..270 px)       shape DIAMETER (circumdiameter), latched per
//                                shape at spawn.
//   v   (0..1 → 0..360°)         spawn VECTOR ANGLE, latched per shape.
//   spd (0..1 → 0..300 px/s)     SPEED, latched per shape (0 = static). The
//                                LATCHED velocity drives integration, so a
//                                later spd change affects ONLY new shapes.
//   decay (0..1 → 0..10 s)       FADE-OUT time, latched per shape. 0 = persist
//                                (FIFO-culled); >0 fades alpha→0 + removes the
//                                shape over that many seconds.
//   shape (0..1 → 6 shapes)      SHAPE SELECTOR (circle / triangle / square /
//                                pentagon / hexagon / octagon), quantised +
//                                latched per shape at spawn. A polygon is
//                                inscribed in the diameter (circumradius = d/2),
//                                so COLLIDE's bounding-circle test is unchanged.
//   rotation (0..1 bipolar)      LIVE GLOBAL spin: center (0.5) = no rotation,
//                                left = fast CCW, right = fast CW. Every live
//                                shape shares one rotation angle (NOT latched),
//                                reflected in the geometry AND every output.
//   rate (0..1, KNOB ONLY)       internal spawn clock. 0 = gate-only; turning
//                                up engages a clock capped at 1 shape/500 ms.
//
// All the numeric behavior (seeded spawn, integration, center-bounce, latch,
// SHAPE geometry, ROTATION accumulation, the rate-clock cadence, the
// max-shape cull, and the per-output derivation) is in outlines-sim.ts —
// WebGL-free + unit-tested. This file owns ONLY the GL plumbing: a 2D scene
// canvas painted per frame (overlap / contour / combine + a mask) uploaded
// into per-output textures, plus a small shader that multiplies the `video`
// input by the mask for `mapped`.
//
// Determinism (VRT / per-port / behavioral): the spawn RNG is seeded. When
// `globalThis.__outlinesVrtSeed` is set BEFORE the module mounts, the sim is
// constructed with that fixed seed (so the painted frame is reproducible);
// otherwise a fixed default seed is used (still deterministic — never
// Math.random()).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { gateEdge, makeGateState, type GateState } from '$lib/video/plex-select';
import {
  OutlinesSim,
  OUTLINES_FIELD,
  MAX_CIRCLES,
  ROT_CENTER,
  ringWidth,
  shapeVertices,
  makeOutlinesField,
  deriveOutlinesField,
  combineRgbFromField,
  type OutlinesField,
  type Circle,
} from './outlines-sim';

/**
 * THE VRT PHASE PIN — how far the sim is advanced, deterministically, before a
 * capture, and in what size steps. Consumed only when `__outlinesVrtSeed` is
 * set (i.e. by the capture harness); see the pin in `draw()`.
 *
 * ⚠ THE STEP SIZE IS A FIXED 60 fps TICK ON PURPOSE. The pin must reproduce a
 * trajectory the live module could actually draw, and the integrator moves each
 * shape by `v * dt` then bounces it off the field walls — so one large step
 * would tunnel shapes straight through the edges. Equal small steps give the
 * real path.
 *
 * ⚠ THE COUNT IS CHOSEN TO POPULATE THE FIELD, which is what makes the baseline
 * worth having. 480 steps is 8.0 s of simulated time; at the shipped
 * `rate` default the internal clock spawns one shape every 2250 ms, so the
 * captured scene holds a handful of shapes that have moved and begun to
 * overlap — the thing the four outputs are derived FROM. A pin of ~0 steps
 * would be perfectly deterministic and would show an empty field, which is the
 * "blind the gate to its own subject" outcome this fix exists to avoid.
 */
const VRT_PIN_STEP_MS = 1000 / 60;
const VRT_PIN_STEPS = 480;

/** The synthetic param the engine's CV-bridge writes the gate value into
 *  (mirrors SHAPEGEN's cv_clock). The port id is the human-readable `gate`;
 *  the param id carries the `cv_` prefix. */
export const OUTLINES_GATE_PARAM_ID = 'cv_gate';
/** The gate input port id. */
export const OUTLINES_GATE_PORT_ID = 'gate';

/** The synthetic param the CV-bridge writes the COLLIDE gate LEVEL into. Unlike
 *  the spawn gate (rising-edge → spawn), this is read as a LIVE LEVEL each frame:
 *  HIGH → inter-shape elastic collision ON, LOW → pass-through. */
export const OUTLINES_COLLIDE_PARAM_ID = 'cv_collide';
/** The collide gate input port id. */
export const OUTLINES_COLLIDE_PORT_ID = 'collide';

/** A gate LEVEL ≥ this counts as HIGH (matches the rising-edge detector's
 *  high threshold; the engine writes 0/1 but CV can arrive analog). */
export const COLLIDE_GATE_HIGH = 0.5;

// ── Back-compat aliases for the pre-rename constant names (was CIRCLES_*).
// New code uses the OUTLINES_* names above; these keep any straggling importer
// resolving (there are no production saved patches referencing them).
export const CIRCLES_GATE_PARAM_ID = OUTLINES_GATE_PARAM_ID;
export const CIRCLES_GATE_PORT_ID = OUTLINES_GATE_PORT_ID;
export const CIRCLES_COLLIDE_PARAM_ID = OUTLINES_COLLIDE_PARAM_ID;
export const CIRCLES_COLLIDE_PORT_ID = OUTLINES_COLLIDE_PORT_ID;

interface OutlinesParams {
  d: number;
  v: number;
  spd: number;
  decay: number;
  shape: number;
  rotation: number;
  rate: number;
  // Synthetic gate param — written by the CV-bridge; hidden from the card.
  cv_gate: number;
  // Synthetic COLLIDE gate LEVEL — written by the CV-bridge; hidden from the
  // card. Read live each frame as the inter-shape collision on/off switch.
  cv_collide: number;
  // Hidden VRT determinism toggle — see its ParamDef.
  freeze: number;
}

const DEFAULTS: OutlinesParams = {
  d: 0.3,    // ~85 px shapes by default (0.3 × the new 5..270 range)
  v: 0.125,  // 45° drift
  spd: 0.4,  // ~120 px/s — visibly moving
  decay: 0,  // 0 = persist (preserve the static-field default; FIFO-capped)
  shape: 0,  // circle by default (the legacy look)
  rotation: ROT_CENTER, // center = no spin by default
  rate: 0.5, // internal clock on by default so the source is alive on spawn
  cv_gate: 0,
  cv_collide: 0, // collide OFF by default (pass-through) until the gate goes HIGH
  // ⚠ `freeze` MUST BE SEEDED HERE, not only declared in `params`. `setParam`
  // below writes through `if (paramId in params)`, and `params` is built from
  // THIS record — so a key missing here makes the VRT harness's write a SILENT
  // NO-OP: the store would agree that freeze=1 and the surface would go on
  // moving. Same trap spirographs documents on its own freeze param.
  freeze: 0,
};

// Fullscreen-quad shader: sample the scene texture (top-left-origin canvas →
// flip Y to GL bottom-left). Used to copy each output's 2D scene canvas into
// its FBO.
const COPY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  outColor = texture(uScene, uv);
}`;

// `mapped` shader: multiply the video INPUT texture by the mask texture
// (white where ≥2 shapes overlap). Both sampled in GL UV space; the mask is
// uploaded from a top-left-origin 2D canvas so it's flipped to match.
const MAPPED_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVideo;   // the video input
uniform sampler2D uMask;    // white where >=2 overlap
uniform float uHasVideo;    // 1 when the video input is patched, else 0
void main() {
  float mask = texture(uMask, vec2(vUv.x, 1.0 - vUv.y)).r;
  vec3 vid = texture(uVideo, vUv).rgb * uHasVideo;
  outColor = vec4(vid * mask, 1.0);
}`;

export const outlinesDef: VideoModuleDef = {
  type: 'outlines',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'outlines',
  category: 'sources',
  inputs: [
    // A gate event spawns a new shape. The CV-bridge routes the gate sample
    // into setParam(cv_gate, value); a rising-edge detector spawns one shape.
    { id: OUTLINES_GATE_PORT_ID, type: 'gate', edge: 'trigger', paramTarget: OUTLINES_GATE_PARAM_ID },
    // LIVE inter-shape COLLIDE mode. The CV-bridge routes this gate's LEVEL
    // into setParam(cv_collide, value); the sim reads it each frame (HIGH →
    // shapes bounce off each other elastically, LOW → pass through).
    { id: OUTLINES_COLLIDE_PORT_ID, type: 'gate', edge: 'gate', paramTarget: OUTLINES_COLLIDE_PARAM_ID },
    // Per-param CV — port id MUST equal the param id (the cross-domain CV
    // bridge routes onto setParam(portId)). `rate` is knob-only (no port).
    // These are CONTINUOUS knob modulators, so each MUST carry a `cvScale`
    // hint: the cv→video bridge (cv-bridge-map.ts) only sweeps a ±1 source
    // across the param's full range CENTERED on the knob when `cvScale` is
    // present. Without it the bridge falls back to GATE semantics (raw
    // passthrough), which clobbers the knob + sends bipolar CV out of the
    // 0..1 range — i.e. the CV input "does nothing useful" (the reported bug).
    { id: 'd',        type: 'cv', paramTarget: 'd',        cvScale: { mode: 'linear' } },
    { id: 'v',        type: 'cv', paramTarget: 'v',        cvScale: { mode: 'linear' } },
    { id: 'spd',      type: 'cv', paramTarget: 'spd',      cvScale: { mode: 'linear' } },
    { id: 'decay',    type: 'cv', paramTarget: 'decay',    cvScale: { mode: 'linear' } },
    // SHAPE selector CV — latched per shape at spawn (like d/v/spd/decay).
    { id: 'shape',    type: 'cv', paramTarget: 'shape',    cvScale: { mode: 'linear' } },
    // ROTATION CV — a LIVE GLOBAL bipolar angular velocity (NOT latched).
    { id: 'rotation', type: 'cv', paramTarget: 'rotation', cvScale: { mode: 'linear' } },
    // The video source for the `mapped` output.
    { id: 'video', type: 'video' },
  ],
  outputs: [
    { id: 'overlap', type: 'mono-video' },
    { id: 'contour', type: 'mono-video' },
    { id: 'combine', type: 'video' },
    { id: 'mapped',  type: 'video' },
  ],
  params: [
    { id: 'd',        label: 'D',     defaultValue: DEFAULTS.d,        min: 0, max: 1, curve: 'linear' },
    { id: 'v',        label: 'V',     defaultValue: DEFAULTS.v,        min: 0, max: 1, curve: 'linear' },
    { id: 'spd',      label: 'Spd',   defaultValue: DEFAULTS.spd,      min: 0, max: 1, curve: 'linear' },
    { id: 'decay',    label: 'Decay', defaultValue: DEFAULTS.decay,    min: 0, max: 1, curve: 'linear' },
    // SHAPE selector knob — 0..1 quantised to 6 discrete shapes at spawn.
    { id: 'shape',    label: 'Shape', defaultValue: DEFAULTS.shape,    min: 0, max: 1, curve: 'linear' },
    // ROTATION knob — BIPOLAR around 0.5 (center = no spin, ± = CW/CCW). Live.
    { id: 'rotation', label: 'Rot',   defaultValue: DEFAULTS.rotation, min: 0, max: 1, curve: 'linear' },
    { id: 'rate',     label: 'Rate',  defaultValue: DEFAULTS.rate,     min: 0, max: 1, curve: 'linear' },
    // Synthetic gate param — hidden from the card; rendered as the gate jack.
    { id: OUTLINES_GATE_PARAM_ID, label: 'GATE', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    // ── freeze — the hidden VRT/determinism toggle ────────────────────────
    // ⚠ IT EXISTS BECAUSE THIS MODULE ANIMATES BY CONSTRUCTION, and the face
    // scene cannot be captured without it. Every live shape drifts and bounces
    // every frame as a function of ELAPSED TIME, and at the shipped rate a new
    // one spawns every 2250 ms — so two captures of identical settings are
    // never the same pixels. The seeded RNG (`__outlinesVrtSeed`) fixes WHERE
    // things spawn; it does nothing about WHEN, and an AudioContext suspend
    // says nothing about a rAF-driven picture.
    //
    // Measured: without this, `workflow-shell-faces.spec.ts` refuses both
    // outlines scenes with "the video surface was still MOVING after writing
    // freeze=1" — `freezeFaceVideo` writes `params.freeze = 1` and there was no
    // such param for it to reach. Same mechanism spirographs added for the same
    // reason.
    //
    // NO CONTROL ANYWHERE — not on the card, not on the faceplate, not on the
    // patch surface: it is `noUserControl` with `writer: 'internal'` and is
    // absent from `face.order`. The harness writes it; nothing else ever does.
    { id: 'freeze', label: 'Freeze', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    // Synthetic COLLIDE gate param — hidden from the card; rendered as the
    // collide jack. Read live as the inter-shape collision on/off level.
    { id: OUTLINES_COLLIDE_PARAM_ID, label: 'COLLIDE', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  // Two SYNTHETIC params that exist only so the CV bridge has somewhere to
  // write a gate level. Neither is a control: the card hides both, and without
  // this declaration `module-face-lint`'s completeness loop demands an
  // interactive cell for each and the face paints two continuous rotaries over
  // raw gate levels. `writer` is checked against THIS def's own `inputs` in
  // both directions by `no-user-control.test.ts`.
  noUserControl: [
    {
      param: OUTLINES_GATE_PARAM_ID,
      writer: 'cv-port',
      why: 'written by the gate bridge as a raw 0..1 level; the module edge-detects it and each RISING EDGE spawns one shape, latching the live D/V/Spd/Decay/Shape values at that instant. The player controls it by patching a clock, never by turning it',
    },
    {
      param: 'freeze',
      writer: 'internal',
      why: 'determinism toggle for VRT capture: at >=0.5 the draw step is a no-op so the field holds its last frame instead of going black. No port targets it and no card or face control sets it — the visual-regression harness writes it before comparing a screenshot, and nothing else ever does',
    },
    {
      param: OUTLINES_COLLIDE_PARAM_ID,
      writer: 'cv-port',
      why: 'written by the collide bridge as a raw 0..1 level and read LIVE every frame (not latched): while high, shapes bounce off each other elastically. It is a patched-cable mode switch, not a dial anyone sets by hand',
    },
  ],

  // ── THE FACEPLATE ──────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR. Most video modules transform the frame you give them.
  // outlines GENERATES one, and it does so as a STATEFUL PARTICLE FIELD: a gate
  // edge (or its own clock) spawns a shape that drifts, bounces off the walls
  // forever, and piles up with the others into a per-pixel overlap count that
  // four different pictures are derived from. The verb is STOCKING A POND —
  // you set what the next thing dropped in will be, and how often.
  //
  // ⚠ THE ONE FACT THE WHOLE FACE IS ORGANISED AROUND: FIVE OF THE SEVEN KNOBS
  // ARE LATCHED AT SPAWN. `d`, `v`, `spd`, `decay` and `shape` are copied into
  // each shape as it is born, and turning them afterwards changes NOTHING about
  // the shapes already on screen. A player who turns SPEED and sees nothing
  // move is not looking at a broken control — they are looking at a control
  // that only applies to the future. Only `rotation` is live, and `rate` is
  // neither: it is GENERATIVE, deciding whether there is a future at all.
  //
  // That is why `pages` groups by WHEN A CONTROL ACTS rather than by what it
  // affects, which is the more obvious grouping and the less useful one. The
  // band labels are the only place this module's hardest-to-discover property
  // is stated on a resting faceplate.
  //
  // THE LADDER, read back as a sentence: mini gives RATE, because it is the
  // control that decides whether the module is a source at all (below its
  // engage threshold the clock is OFF entirely and nothing spawns without a
  // patched gate). Compact adds SHAPE, the most visible identity of what gets
  // dropped in. Plate adds D, SPD, DECAY and ROT. V is dock-only — it is the
  // launch ANGLE, and on a field where everything bounces off four walls
  // forever the initial direction is the least consequential of the five
  // latched values.
  //
  // ⚠ ROTATION RANKS SIXTH DESPITE BEING THE ONLY LIVE CONTROL, and that is the
  // inertness-at-spawn rule doing real work: `mapAngularVel(0.5)` is BIT-EXACTLY
  // 0, and 0.5 is the shipped default. A control that does nothing on a
  // freshly-spawned node has no business high in a six-cell lane budget,
  // however conceptually important it is.
  //
  // No `paramCells`: the card draws plain `<Knob>`s, so the shell's default
  // dial is already the right primitive and there is nothing to declare.
  face: {
    order: ['rate', 'shape', 'd', 'spd', 'decay', 'rotation', 'v'],

    pages: [
      {
        id: 'clock',
        label: 'spawn clock',
        hint: 'how often a shape is born — and at the very bottom of the dial, not at all: below the engage threshold the internal clock is OFF and only a patched GATE spawns',
        controls: ['rate'],
      },
      {
        id: 'birth',
        label: 'latched at birth',
        hint: 'copied into each shape as it spawns — turning these changes the NEXT shape, never the ones already on screen',
        controls: ['shape', 'd', 'spd', 'decay', 'v'],
      },
      {
        id: 'field',
        label: 'live field',
        hint: 'applied to every shape at once, every frame',
        controls: ['rotation'],
      },
    ],

    // ⚠ MANDATORY for a video def: `primaryAudioOutPortId` matches
    // `type === 'audio'` and this def has none, so any other glyph literal
    // resolves to the dead `{kind:'static'}` module-face-lint refuses by name.
    // The live picture arrives via `hasVideoSurface` (lane) and the
    // `fullViewBody` extension (dock).
    glyph: 'none',

    // The SCREEN ON/OFF switch (#1928). Promotion stops both surfaces from
    // rendering `OutlinesCard.svelte`, so the toggle cannot live there.
    extension: 'outlines',

    // ── STOP 2: ONE CARD AFFORDANCE IS NOT REPRODUCED, AND THIS IS ITS
    //    WRITTEN EXEMPTION ──────────────────────────────────────────────────
    //
    // `OutlinesCard.svelte` paints a `[GATED]` badge (`outlines-gated-badge`)
    // whenever the GATE input is the target of any edge. The face does not,
    // and CANNOT as a readout: a `FaceReadoutValue` is
    // `(read: (paramId) => number | undefined) => string` — it sees PARAMS and
    // nothing else, while `gatePatched` is derived from the EDGE LIST. This is
    // the same structural blindness that made five specced samsloop readouts
    // underivable, and freezeframe's gate caption impossible.
    //
    // ⚠ THE INFORMATION IS NOT LOST, WHICH IS WHY THIS IS AN EXEMPTION RATHER
    // THAN A BLOCKER. "Is the gate patched" is a CABLE — the rear card renders
    // the GATE jack with its cable attached, so the fact is on the faceplate,
    // one flip gesture away instead of printed on the front. What is lost is
    // the at-a-glance version, and the honest trade is that a badge restating
    // a visible cable is weaker than a readout naming something invisible —
    // which is what the four `hero.readouts` above do instead.
    //
    // Recorded rather than quietly dropped, because a card affordance that
    // disappears in a promotion with no argument is exactly what STOP 2 exists
    // to catch.

  },

  docs: {
    explanation: "A stateful particle video SOURCE in the LZX tradition. Each gate edge (or the internal rate clock) spawns a shape — a circle or a regular N-gon — at a seeded-random position; it drifts in a latched direction at a latched speed and BOUNCES when its center hits a wall, accumulating into a 1024px field. From the per-pixel overlap COUNT of all live shapes it derives four pictures: overlap (white where any shape covers a pixel), contour (just the shape outlines, so stacking shapes read as ripples in a pond), combine (the overlap region colorized by stack depth via a hue ramp with brightness and saturation rising as more shapes pile up), and mapped (the patched video input shown only where two or more shapes overlap). Usage: leave RATE up for a self-running generator, or set RATE to 0 and clock the GATE input to spawn one shape per pulse; patch COMBINE or CONTOUR into a screen and use the CV inputs to animate size, drift, and spin.",
    inputs: {
      gate: "Spawn trigger (edge). A rising edge spawns ONE shape, which latches the LIVE D / V / Spd / Decay / Shape values at the moment of the edge. Patching it lights the [GATED] badge.",
      collide: "Live inter-shape collision mode (gate, level — read every frame, not latched). While HIGH (>=0.5) shapes bounce off each other elastically (bounding-circle detection); LOW or unpatched passes through with no inter-shape collisions.",
      d: "CV that modulates the D (diameter) control, centered on the knob and swept across its 5..270px range; latched per shape at spawn.",
      v: "CV that modulates the V (vector angle) control across its 0..360 degree range; latched per shape at spawn.",
      spd: "CV that modulates the Spd (speed) control across its 0..300 px/s range; latched per shape at spawn, so a change affects only new shapes.",
      decay: "CV that modulates the Decay (fade-out time) control across its 0..10s range; latched per shape at spawn.",
      shape: "CV that modulates the Shape selector across its six shapes (circle / triangle / square / pentagon / hexagon / octagon); quantised and latched per shape at spawn.",
      rotation: "CV that modulates the Rot control, a LIVE GLOBAL bipolar spin (center = no spin); applied to every live shape at once, not latched.",
      video: "Video source sampled by the MAPPED output — its pixels appear only where two or more shapes overlap. Unpatched, MAPPED is black.",
    },
    outputs: {
      overlap: "Mono-video: white wherever at least one shape covers the pixel, black elsewhere (each shape dimmed by its fade alpha).",
      contour: "Mono-video: shape OUTLINES only (ring width 10% of diameter, min 2px), so many stacked shapes read as concentric ripples.",
      combine: "Video: the overlap region colorized by overlap COUNT via a hue ramp (1 = first hue, then 2,3,4... cycle the spectrum), with brightness and saturation rising as the stack deepens. This is the card preview and default output.",
      mapped: "Video: the VIDEO input's contents shown wherever two or more shapes overlap, black everywhere else (black if VIDEO is unpatched).",
    },
    controls: {
      d: "Shape DIAMETER (circumdiameter). 0..1 maps to 5..270px; latched per shape at spawn. A polygon is inscribed in this diameter (circumradius = d/2).",
      v: "Spawn VECTOR ANGLE. 0..1 maps to 0..360 degrees, the direction each new shape drifts; latched per shape at spawn.",
      spd: "SPEED. 0..1 maps to 0..300 px/s (0 = static). The latched velocity drives integration, so a later change affects only shapes spawned after it.",
      decay: "FADE-OUT time. 0..1 maps to 0..10s; latched per shape. 0 = persist (oldest shapes FIFO-culled at the cap); above 0 fades alpha to 0 and removes the shape over that many seconds.",
      shape: "SHAPE SELECTOR, 0..1 quantised to six shapes: circle, triangle, square, pentagon, hexagon, octagon. Latched per shape at spawn; the card shows the current shape name.",
      rotation: "ROTATION, a LIVE GLOBAL bipolar spin: center (0.5) = no rotation, left = fast counter-clockwise, right = fast clockwise. Every live shape shares one rotation angle (not latched); the card shows CCW / dot / CW.",
      freeze: "Freeze (0/1, default 0): a hidden determinism toggle with NO control anywhere — not on the card, not on the faceplate, not on the patch surface. At 0.5 or above the draw step is a no-op, so the field HOLDS its last frame rather than going black. It exists because this module animates by construction: every live shape drifts and bounces as a function of elapsed time, and at the shipped rate a new one spawns every 2250 ms, so two captures of identical settings are never the same pixels. The seeded spawn RNG fixes WHERE shapes appear and says nothing about WHEN. The visual-regression harness writes it before comparing a screenshot; nothing else ever does.",
      rate: "Internal spawn CLOCK (knob only, no CV input). 0 = gate-only; turning it up engages a clock that tightens from slow toward a cap of one shape every 500ms.",
      cv_gate: "Hidden synthetic gate param backing the GATE jack (not a knob). The engine CV-bridge writes the gate input's sample here; a rising edge spawns ONE shape, latching the live D / V / Spd / Decay / Shape at the moment of the edge.",
      cv_collide: "Hidden synthetic gate param backing the COLLIDE jack (not a knob). The engine CV-bridge writes the collide input's LEVEL here; read live every frame, HIGH (>=0.5) makes shapes bounce off each other elastically, LOW passes through.",
    },
  },
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const copyProgram = ctx.compileFragment(COPY_FRAG_SRC);
    const uScene = gl.getUniformLocation(copyProgram, 'uScene');
    const mappedProgram = ctx.compileFragment(MAPPED_FRAG_SRC);
    const uVideo = gl.getUniformLocation(mappedProgram, 'uVideo');
    const uMask = gl.getUniformLocation(mappedProgram, 'uMask');
    const uHasVideo = gl.getUniformLocation(mappedProgram, 'uHasVideo');

    // One FBO+texture per declared output.
    const fboOverlap = ctx.createFbo();
    const fboContour = ctx.createFbo();
    const fboCombine = ctx.createFbo();
    const fboMapped = ctx.createFbo();

    const params: OutlinesParams = { ...DEFAULTS, ...(node.params as Partial<OutlinesParams>) };

    // ---- Seeded sim ----
    const vrtSeed = (globalThis as unknown as { __outlinesVrtSeed?: number }).__outlinesVrtSeed;
    const sim = new OutlinesSim(typeof vrtSeed === 'number' ? vrtSeed >>> 0 : undefined);
    // A VRT seed is present ONLY under the capture harness, so this is the one
    // switch that separates a captured render from a live one. See the phase
    // pin in draw().
    const vrtPinned = typeof vrtSeed === 'number';
    const gateState: GateState = makeGateState();

    // ---- 2D scene canvases (one for the colour combine + per-mono outputs +
    // the mask). We keep FOUR small 2D canvases (overlap / contour / combine /
    // mask) at field resolution. Both OffscreenCanvas + document may be absent
    // in headless node tests — fall through to null; draw() then no-ops the GL
    // upload (the unit suite covers the sim/derivation directly, never the
    // canvas paint).
    function makeCanvas(): { canvas: OffscreenCanvas | HTMLCanvasElement | null; ctx2d: (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null } {
      let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
      try {
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(OUTLINES_FIELD, OUTLINES_FIELD);
        } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          c.width = OUTLINES_FIELD;
          c.height = OUTLINES_FIELD;
          canvas = c;
        }
      } catch {
        canvas = null;
      }
      const ctx2d = canvas
        ? (canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
        : null;
      return { canvas, ctx2d };
    }

    const overlapScene = makeCanvas();
    const contourScene = makeCanvas();
    const combineScene = makeCanvas();
    const maskScene = makeCanvas();

    // Reusable upload texture: re-bound + re-filled per output per frame.
    function makeUploadTex(): WebGLTexture {
      const t = gl.createTexture();
      if (!t) throw new Error('OUTLINES: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    }
    const texOverlap = makeUploadTex();
    const texContour = makeUploadTex();
    const texCombine = makeUploadTex();
    const texMask = makeUploadTex();

    // Trace one shape's PATH on a 2D context: a circle → arc; a polygon → the
    // rotated vertex polyline (closed). `rot` is the live-global rotation angle
    // (added to each shape's seeded baseAngle), so the painted geometry spins
    // exactly like the derivation math reads it. For the polygon contour we
    // shrink the path by `inset` (so a stroke band sits inside the edge, like
    // the disc contour does).
    function traceShapePath(
      c2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
      ci: Circle,
      rot: number,
      inset: number,
    ): void {
      const verts = shapeVertices(ci, rot);
      if (verts.length === 0) {
        // Circle.
        c2d.arc(ci.x, ci.y, Math.max(0, ci.diameter * 0.5 - inset), 0, Math.PI * 2);
        return;
      }
      if (inset === 0) {
        c2d.moveTo(verts[0]![0], verts[0]![1]);
        for (let i = 1; i < verts.length; i++) c2d.lineTo(verts[i]![0], verts[i]![1]);
        c2d.closePath();
        return;
      }
      // Inset the polygon by pulling each vertex toward the center by `inset`
      // along its radius (approximate — for a thin stroke band this is fine).
      const r = ci.diameter * 0.5;
      const shrink = r > 0 ? Math.max(0, r - inset) / r : 0;
      const v0x = ci.x + (verts[0]![0] - ci.x) * shrink;
      const v0y = ci.y + (verts[0]![1] - ci.y) * shrink;
      c2d.moveTo(v0x, v0y);
      for (let i = 1; i < verts.length; i++) {
        c2d.lineTo(ci.x + (verts[i]![0] - ci.x) * shrink, ci.y + (verts[i]![1] - ci.y) * shrink);
      }
      c2d.closePath();
    }

    // ---- 2D paint of one frame's shapes into the four scene canvases. ----
    function paintScenes(circles: readonly Circle[], rot: number): void {
      // overlap — white shapes on black (count≥1), each dimmed by its fade alpha.
      if (overlapScene.ctx2d) {
        const c = overlapScene.ctx2d;
        c.globalAlpha = 1;
        c.fillStyle = '#000';
        c.fillRect(0, 0, OUTLINES_FIELD, OUTLINES_FIELD);
        c.fillStyle = '#fff';
        for (const ci of circles) {
          c.globalAlpha = ci.alpha ?? 1;
          c.beginPath();
          traceShapePath(c, ci, rot, 0);
          c.fill();
        }
        c.globalAlpha = 1;
      }
      // contour — white outlines (lw = 10% of d, min 2px) on black, dimmed by
      // fade. The stroke is inset by lw/2 so the band sits inside the shape (the
      // sim's ring test is the [edge − lw, edge] band).
      if (contourScene.ctx2d) {
        const c = contourScene.ctx2d;
        c.globalAlpha = 1;
        c.fillStyle = '#000';
        c.fillRect(0, 0, OUTLINES_FIELD, OUTLINES_FIELD);
        c.strokeStyle = '#fff';
        c.lineJoin = 'round';
        for (const ci of circles) {
          c.globalAlpha = ci.alpha ?? 1;
          const lw = ringWidth(ci.diameter);
          c.lineWidth = lw;
          c.beginPath();
          traceShapePath(c, ci, rot, lw * 0.5);
          c.stroke();
        }
        c.globalAlpha = 1;
      }
      // mask — white where ≥2 shapes overlap. We additively accumulate shape
      // coverage (each shape adds a small constant), then any pixel touched by
      // ≥2 shapes reads ≥ the 2-shape threshold. Using 'lighter' compositing
      // sums alpha so overlaps brighten; 1 shape ≈ 0.42 (<0.5), 2 shapes ≈ 0.84
      // (>0.5) → the shader's mask>0.5 test = "≥2 overlaps". (The unit suite
      // pins the exact ≥2 rule on the sim; this canvas path is the GL
      // approximation the shader reads.)
      if (maskScene.ctx2d) {
        const c = maskScene.ctx2d;
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = '#000';
        c.fillRect(0, 0, OUTLINES_FIELD, OUTLINES_FIELD);
        c.globalCompositeOperation = 'lighter';
        for (const ci of circles) {
          // Each shape adds ~0.42 × its fade alpha → a fully-faded shape stops
          // contributing to the ≥2-overlap (>0.5) mask threshold.
          c.fillStyle = `rgba(255,255,255,${0.42 * (ci.alpha ?? 1)})`;
          c.beginPath();
          traceShapePath(c, ci, rot, 0);
          c.fill();
        }
        c.globalCompositeOperation = 'source-over';
      }
      // combine — overlap region colorized by COUNT via the hue ramp. We can't
      // cheaply do per-pixel count in canvas2D for the exact ramp, so we paint a
      // coarse count grid: sample the count at a downsampled grid + fill cells.
      // The downsample keeps it cheap (a 160×160 grid). The COVERAGE for that
      // grid is derived ONCE per frame (deriveOutlinesField: AABB iteration +
      // circumradius pre-reject + cached polygon normals → ZERO per-cell trig),
      // then each non-empty cell is coloured exactly as combineRgbAt did at the
      // cell center (same live `rot`, so the coloured stack spins with the
      // geometry). This is the #699 per-pixel-trig hot-path fix: byte-identical
      // colour, far fewer ops.
      if (combineScene.ctx2d) {
        const c = combineScene.ctx2d;
        c.fillStyle = '#000';
        c.fillRect(0, 0, OUTLINES_FIELD, OUTLINES_FIELD);
        if (circles.length > 0) {
          const GRID = 160;
          const cell = OUTLINES_FIELD / GRID;
          combineField = makeOutlinesField(GRID, combineField);
          deriveOutlinesField(circles, combineField, rot);
          const cnt = combineField.count;
          for (let gy = 0; gy < GRID; gy++) {
            const rowBase = gy * GRID;
            for (let gx = 0; gx < GRID; gx++) {
              const idx = rowBase + gx;
              if (cnt[idx] === 0) continue; // black cell → leave the cleared bg
              const [r, g, b] = combineRgbFromField(combineField, idx, combineRgbScratch);
              c.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
              c.fillRect(gx * cell, gy * cell, Math.ceil(cell), Math.ceil(cell));
            }
          }
        }
      }
    }

    function uploadCanvas(tex: WebGLTexture, canvas: OffscreenCanvas | HTMLCanvasElement | null): void {
      if (!canvas) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas as unknown as TexImageSource);
    }

    function blitToFbo(fbo: WebGLFramebuffer | null, tex: WebGLTexture): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, ctx.res.width, ctx.res.height);
      gl.useProgram(copyProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uScene, 0);
      ctx.drawFullscreenQuad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    let lastTime = -1;

    // ── THE VRT PHASE PIN (see VRT_PIN_STEPS) ────────────────────────────────
    // Set once the deterministic warm-up has run, after which the sim is not
    // advanced again while pinned.
    let vrtPinWarmed = false;
    let framesElapsed = 0;

    // Reused across frames so the combine derive-once path allocates nothing
    // per frame (the coverage buffers + a single RGB scratch triple).
    let combineField: OutlinesField | undefined;
    const combineRgbScratch: [number, number, number] = [0, 0, 0];

    // Snapshot the CURRENT live knob+CV params into the shape the sim latches at
    // spawn. Used both by draw() (every frame) AND by the gate handler (so a
    // gate-spawned shape latches the LIVE spd/v/d/decay/SHAPE at the moment of
    // the edge — not whatever stale params the last draw() happened to push, or
    // the sim's constructor defaults before the first draw ever ran). ROTATION is
    // included too (a LIVE GLOBAL the sim advances each step).
    function liveSpawnParams() {
      return {
        d: params.d,
        v: params.v,
        spd: params.spd,
        decay: params.decay,
        shape: params.shape,
        rotation: params.rotation,
        rate: params.rate,
        collide: params.cv_collide >= COLLIDE_GATE_HIGH,
      };
    }

    const surface: VideoNodeSurface = {
      // Surface.texture is the `combine` output (the default single-output
      // convention + the card preview). Per-output textures are resolved by
      // the engine via read('outputTexture:<portId>').
      fbo: fboCombine.fbo,
      texture: fboCombine.texture,
      draw(frame) {
        const g = frame.gl;

        // VRT determinism: hold the last frame rather than going black. See the
        // `freeze` ParamDef for why this module needs one at all. Read straight
        // off the live params so the harness's write reaches it on the very next
        // frame.
        if (params.freeze >= 0.5) return;

        // ── THE VRT PHASE PIN ────────────────────────────────────────────
        //
        // ⚠ WHAT IS PINNED: the sim's ELAPSED TIME, and nothing else. While a
        // VRT seed is present the sim is advanced by a FIXED number of FIXED-dt
        // steps on the first frame and then never again (dt = 0), so the
        // rendered picture is a pure function of (seed, params) — independent
        // of wall clock, frame count, boot speed, and of whether `freeze` was
        // ever written.
        //
        // ⚠ WHY IT IS NOT ENOUGH TO FREEZE. `freeze` holds the LAST DRAWN
        // frame, so the frozen picture is whatever the field happened to look
        // like when the harness got around to writing it — a different number
        // of elapsed frames on every boot, hence a different set of shape
        // positions. Measured: `face-outlines-dock` missed its own freshly
        // captured baseline by 6724 px against a `DOCK_MAX_DIFF` of 1500 —
        // 4.5x the tolerance, so this is structural, not noise. Re-capturing
        // could not fix it; it would only re-roll the dice, and a capture that
        // passed BY LUCK would convert a red gate into a flaky one.
        //
        // ⚠ WHY IT IS INVISIBLE LIVE, which is the property that makes this a
        // pin and not a behaviour change: `vrtSeed` is `globalThis
        // .__outlinesVrtSeed`, set by the capture harness BEFORE the module
        // mounts and undefined everywhere else. In normal use this branch does
        // not exist and the module integrates the real engine clock exactly as
        // before. It is deliberately NOT keyed on `freeze`, so the live module
        // and the captured module are the same module.
        const t = frame.time;
        let dtMs: number;
        if (vrtPinned) {
          if (vrtPinWarmed) {
            dtMs = 0;
          } else {
            // Advance in FIXED sub-steps rather than one large dt: the
            // integrator moves each shape by `v * dt` and bounces it off the
            // walls, so a single multi-second step would tunnel shapes through
            // the field edges and produce a picture the live module never
            // draws. Small equal steps reproduce the real trajectory exactly.
            for (let i = 0; i < VRT_PIN_STEPS; i++) sim.step(VRT_PIN_STEP_MS);
            vrtPinWarmed = true;
            dtMs = 0;
          }
        } else {
          dtMs = lastTime < 0 ? 1000 / 60 : Math.max(0, (t - lastTime) * 1000);
        }
        lastTime = t;

        // Push live params into the sim. d/v/spd/decay/shape latch per-shape at
        // spawn; `collide` + `rotation` are LIVE GLOBALS (collide = gate LEVEL ≥
        // HIGH → on; rotation = a bipolar spin advanced each step).
        sim.setParams(liveSpawnParams());
        // Advance the sim (rate-clock spawns + rotation + integration + bounce).
        sim.step(dtMs);

        const circles = sim.circles;
        const rot = sim.rotationAngle;

        // Paint + upload the four scene canvases (with the live rotation).
        paintScenes(circles, rot);
        uploadCanvas(texOverlap, overlapScene.canvas);
        uploadCanvas(texContour, contourScene.canvas);
        uploadCanvas(texCombine, combineScene.canvas);
        uploadCanvas(texMask, maskScene.canvas);

        // overlap / contour / combine: straight copy of their scene texture.
        blitToFbo(fboOverlap.fbo, texOverlap);
        blitToFbo(fboContour.fbo, texContour);
        blitToFbo(fboCombine.fbo, texCombine);

        // mapped: multiply the video INPUT by the mask. If unpatched, black.
        const videoTex = frame.getInputTexture(node.id, 'video');
        g.bindFramebuffer(g.FRAMEBUFFER, fboMapped.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(mappedProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, videoTex ?? texMask);
        g.uniform1i(uVideo, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, texMask);
        g.uniform1i(uMask, 1);
        g.uniform1f(uHasVideo, videoTex ? 1 : 0);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.activeTexture(g.TEXTURE0);

        framesElapsed++;
      },
      dispose() {
        gl.deleteFramebuffer(fboOverlap.fbo); gl.deleteTexture(fboOverlap.texture);
        gl.deleteFramebuffer(fboContour.fbo); gl.deleteTexture(fboContour.texture);
        gl.deleteFramebuffer(fboCombine.fbo); gl.deleteTexture(fboCombine.texture);
        gl.deleteFramebuffer(fboMapped.fbo); gl.deleteTexture(fboMapped.texture);
        gl.deleteTexture(texOverlap); gl.deleteTexture(texContour);
        gl.deleteTexture(texCombine); gl.deleteTexture(texMask);
        gl.deleteProgram(copyProgram); gl.deleteProgram(mappedProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId === OUTLINES_GATE_PARAM_ID) {
          params.cv_gate = value;
          // Rising edge → spawn one shape. Push the CURRENT live params into the
          // sim FIRST so the gate-spawned shape latches the live spd/v/d/decay/
          // SHAPE at the moment of the edge. The gate handler runs on the
          // CV-bridge's cadence, which can fire BEFORE the first draw() (sim
          // still on its constructor defaults) or between draws after a knob
          // change — without this the shape would latch stale params (notably
          // decay=0 → never fades, spd → wrong/zero velocity → doesn't move).
          // draw() still pushes params every frame for the rate-clock spawns +
          // the live collide/rotation modes.
          if (gateEdge(gateState, value)) {
            sim.setParams(liveSpawnParams());
            sim.spawnFromGate();
          }
          return;
        }
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Per-output textures for the engine's multi-output lookupInput path.
        if (key === 'outputTexture:overlap') return fboOverlap.texture;
        if (key === 'outputTexture:contour') return fboContour.texture;
        if (key === 'outputTexture:combine') return fboCombine.texture;
        if (key === 'outputTexture:mapped')  return fboMapped.texture;
        // Card preview blits the combine scene.
        if (key === 'sceneCanvas') return combineScene.canvas;
        // Test/telemetry hooks.
        // The live shape list (latched vx/vy/diameter/decayS/shape/baseAngle) —
        // lets tests assert what a gate-/clock-spawned shape latched at spawn
        // through the real module path (e.g. the gate-spawn live-param
        // regression + the SHAPE latch).
        if (key === 'circles') return sim.circles;
        if (key === 'circleCount') return sim.count;
        if (key === 'spawnCount') return sim.spawnCount;
        if (key === 'cullCount') return sim.cullCount;
        if (key === 'decayCount') return sim.decayCount;
        if (key === 'collisionCount') return sim.collisionCount;
        if (key === 'rotationAngle') return sim.rotationAngle;
        if (key === 'framesElapsed') return framesElapsed;
        if (key === 'maxCircles') return MAX_CIRCLES;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
