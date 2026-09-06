// packages/web/src/lib/video/modules/spirographs.ts
//
// SPIROGRAPHS — a classic-spirograph video GENERATOR (a pure synth source: no
// video input). It renders 1–3 INDEPENDENT spirographs — hypotrochoid (rolling
// circle INSIDE the fixed one) or epitrochoid (OUTSIDE) — each with its OWN full
// parameter set + matching CV, each DRIFTING around the screen with its fixed
// circle bouncing off the frame edges like a real spirograph constrained to the
// page.
//
// WHY CANVAS2D, NOT GLSL: a spirograph is a long polyline (a closed trochoid
// sampled over many revolutions) stroked with a genuine, visible LINE WIDTH.
// Canvas2D's stroke pipeline (round joins/caps, real px line width) renders
// that crisply in one pass; doing the same in a fragment shader (distance-to-
// curve over thousands of samples per pixel) is far costlier and the thickness
// control reads worse. So, like SHAPEGEN / TEXTMARQUEE, we paint to an
// OffscreenCanvas and upload it as a GL texture each frame. The curve math + the
// bounce-constraint live in the pure, unit-tested spirographs-math layer.
//
// THE 1–3 INDEPENDENT-SPIRO MODEL:
//   • `count` (discrete 1..3, knob + CV) sets how many spiros render.
//   • Each spiro i∈{1,2,3} has its OWN params (prefix `sI_`): fixedRadius (R),
//     rollingRadius (r), penOffset (p), inside (0=epi/outside, 1=hypo/inside),
//     rotation, scale, xOffset, yOffset, thickness, chroma. EVERY one of these
//     has a knob AND a CV input (port id == param id; the cross-domain CV bridge
//     routes a -1..+1 source into setParam(paramId)).
//   • Each spiro's CENTER drifts independently. Its drift velocity + home
//     position are per-spiro CONSTANTS seeded at construction (so the three
//     never move in lockstep), nudged by that spiro's xOffset/yOffset knobs.
//     The fixed-radius circle (radius R, scaled to screen) is constrained to
//     stay FULLY inside the frame and BOUNCES off the perimeter — closed-form
//     via spirographs-math.advanceCenter. Only the fixed circle's center+R is
//     bound; the drawn CURVE may overflow the viewport and clip (desired).
//
// OUTPUTS (all video, on the yellow drill-down PATCH PANEL — no raw side jacks):
//   • out       (video)      — the full-COLOUR composite (each spiro in its
//                              chroma hue, additively composited on black). This
//                              is the canonical surface.
//   • mono_out  (mono-video) — every spiro stroked WHITE on black (a clean matte
//                              for keying / luma downstream). Reachable via
//                              read('outputTexture:mono_out').
//   • overlap   (video)      — the COLOUR-OVERLAP output: the per-pixel overlap
//                              DENSITY (how many lines stack there — self-cross +
//                              multi-spiro) is colour-mapped into a rainbow that
//                              CASCADES with the count and blooms toward a white
//                              candy core where many lines pile up ("candy gooey"
//                              goodness). Reachable via read('outputTexture:overlap').
//
// INPUTS (PatchPanel, grouped per-spiro): the global `count` CV plus, per spiro,
// the ten per-param CVs. The card groups them into spiro1 / spiro2 / spiro3
// sections in the drill-down.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  advanceCenter,
  type CenterState,
  type SpiroKind,
} from './spirographs-math';
import { drawColorScene, drawMonoScene, drawOverlapScene, type ResolvedSpiro } from './spirographs-draw';

// ── Per-spiro param ids ─────────────────────────────────────────────────────

/** The ten per-spiro param stems. The full param/port id is `s${i}_${stem}`. */
export const SPIRO_PARAM_STEMS = [
  'R',          // fixedRadius
  'r',          // rollingRadius
  'p',          // penOffset
  'inside',     // 0 = epitrochoid (outside), 1 = hypotrochoid (inside)
  'rotation',
  'scale',
  'xOffset',
  'yOffset',
  'thickness',
  'chroma',     // hue 0..1 (colorwheel)
] as const;
export type SpiroParamStem = (typeof SPIRO_PARAM_STEMS)[number];

export const SPIRO_COUNT_MAX = 3;

/** Build the per-spiro param id, e.g. spiroParamId(2, 'R') → 's2_R'. */
export function spiroParamId(i: number, stem: SpiroParamStem): string {
  return `s${i}_${stem}`;
}

// ── Per-spiro defaults (each spiro starts with a distinct look) ──────────────

interface SpiroDefault {
  R: number;
  r: number;
  p: number;
  inside: number;
  rotation: number;
  scale: number;
  xOffset: number;
  yOffset: number;
  thickness: number;
  chroma: number;
}

// Three visually-distinct starting spiros (only `count` of them render).
const SPIRO_DEFAULTS: Record<number, SpiroDefault> = {
  1: { R: 5,   r: 3,   p: 2.2, inside: 1, rotation: 0,    scale: 28, xOffset: 0, yOffset: 0, thickness: 2, chroma: 0.0  },
  2: { R: 7,   r: 3,   p: 3.5, inside: 1, rotation: 0.4,  scale: 22, xOffset: 0, yOffset: 0, thickness: 2, chroma: 0.45 },
  3: { R: 5,   r: 2,   p: 2.0, inside: 0, rotation: 0.9,  scale: 20, xOffset: 0, yOffset: 0, thickness: 2, chroma: 0.72 },
};

/** Per-spiro center-drift constants (home position as a fraction of the frame +
 *  velocity in frame-fractions per second). Distinct per spiro so they never
 *  move in lockstep — this is the "each spiro moves independently" seed. */
const SPIRO_DRIFT: Record<number, { hx: number; hy: number; vx: number; vy: number }> = {
  1: { hx: 0.35, hy: 0.45, vx: 0.055, vy: 0.041 },
  2: { hx: 0.6,  hy: 0.4,  vx: -0.047, vy: 0.063 },
  3: { hx: 0.5,  hy: 0.6,  vx: 0.071, vy: -0.052 },
};

// ── Param value ranges (for clamping + the card faders) ─────────────────────

export const SPIRO_RANGES: Record<SpiroParamStem, { min: number; max: number }> = {
  R:         { min: 1,    max: 12 },
  r:         { min: 0.5,  max: 11 },
  p:         { min: 0,    max: 8 },
  inside:    { min: 0,    max: 1 },
  rotation:  { min: 0,    max: 6.2832 }, // 0..2π
  scale:     { min: 4,    max: 60 },
  xOffset:   { min: -1,   max: 1 },
  yOffset:   { min: -1,   max: 1 },
  thickness: { min: 0.5,  max: 12 },
  chroma:    { min: 0,    max: 1 },
};

function clampStem(stem: SpiroParamStem, v: number): number {
  const rng = SPIRO_RANGES[stem];
  return Math.max(rng.min, Math.min(rng.max, v));
}

// ── The module's flat param map ─────────────────────────────────────────────
//
// `count` (1..3 discrete) + s{i}_{stem} for i in 1..3 × the ten stems.

function buildDefaults(): Record<string, number> {
  // ⚠ `freeze` MUST BE HERE, not only in `PARAMS`. The factory seeds one live
  // `params` object from this map and its `setParam` is guarded by
  // `if (paramId in params)`, so a key absent here is a param whose writes are
  // SILENTLY DROPPED — the VRT freeze would appear to be written, the store
  // would agree, and the surface would go on moving. `freeze` is the param
  // whose whole job is to be written by something other than a knob, so it is
  // exactly the one that guard would have swallowed.
  const d: Record<string, number> = { count: 1, freeze: 0 };
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    const def = SPIRO_DEFAULTS[i]!;
    for (const stem of SPIRO_PARAM_STEMS) {
      d[spiroParamId(i, stem)] = def[stem];
    }
  }
  return d;
}

const DEFAULTS = buildDefaults();

// ── Param defs + CV input ports ─────────────────────────────────────────────

/**
 * THE NAMES OF `inside`'s TWO STATES, and the one place they exist.
 *
 * `curve: 'discrete'` says the param has two states; nothing in a `ParamDef`
 * says what either one is CALLED, and `SpirographsCard` answered that in a
 * local `formatInside()`. Promoting the module removes that card from both
 * surfaces, so without a roster the faceplate would render a two-position dial
 * reading `0` / `1` for the choice between a HYPOTROCHOID and an EPITROCHOID —
 * the single most visible decision on a spiro. Declared here, `paintsReadout`
 * is true (a bare `options` roster and no `format`), so the dock paints a named
 * button row and the lane dial paints the word.
 *
 * COSMETIC IN THE CONTRACT SENSE (see ParamOption): the projection reads only
 * id/min/max/curve/defaultValue/units, so naming the detents moves nothing in
 * `contract-lock.txt`.
 */
export const SPIRO_INSIDE_OPTIONS: readonly { value: number; label: string; title: string }[] = [
  { value: 0, label: 'OUTSIDE', title: 'Epitrochoid — the rolling circle rolls OUTSIDE the fixed one.' },
  { value: 1, label: 'INSIDE', title: 'Hypotrochoid — the rolling circle rolls INSIDE the fixed one.' },
];

const PARAMS: VideoModuleDef['params'] = (() => {
  const out: Array<{
    id: string;
    label: string;
    defaultValue: number;
    min: number;
    max: number;
    curve: 'linear' | 'discrete';
    options?: readonly { value: number; label: string; title?: string }[];
  }> = [
    { id: 'count', label: 'Count', defaultValue: 1, min: 1, max: SPIRO_COUNT_MAX, curve: 'discrete' },
  ];
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    for (const stem of SPIRO_PARAM_STEMS) {
      const rng = SPIRO_RANGES[stem];
      out.push({
        id: spiroParamId(i, stem),
        label: `${i} ${stem}`,
        defaultValue: DEFAULTS[spiroParamId(i, stem)]!,
        min: rng.min,
        max: rng.max,
        curve: stem === 'inside' ? 'discrete' : 'linear',
        ...(stem === 'inside' ? { options: SPIRO_INSIDE_OPTIONS } : {}),
      });
    }
  }
  // ── freeze — the hidden VRT/determinism toggle, and it is NEW here ────────
  //
  // ⚠ THIS MODULE ANIMATES BY CONSTRUCTION and had no way to stop. Each spiro's
  // centre drifts and bounces off the frame edges as a pure function of
  // `frame.time` (`advanceCenter`), so every rendered frame differs from the
  // last — the analogVco non-determinism class, in video. That is fine for a
  // player and fatal for a pixel baseline: without this the faceplate's dock
  // scene is a moving target and its capture can never settle.
  //
  // The value is written ONLY by the VRT harness (see `videoFaceWhy` on this
  // module's FACES roster entry, and `noUserControl` below). At >= 0.5 `draw`
  // is a no-op so the surface holds its last frame — the same shape backdraft
  // and grainsOfVision already use.
  out.push({ id: 'freeze', label: 'Freeze', defaultValue: 0, min: 0, max: 1, curve: 'linear' });
  return out;
})();

// ── THE FACE'S PAGE GROUPING ────────────────────────────────────────────────
//
// Lives HERE rather than in `spirographs-face-model.ts` purely to keep the
// import one-way: the face model reads the def (for its defaults), so the def
// cannot read the face model back.
//
// THREE IDEAS PER SPIRO, and they are genuinely three questions rather than one
// question split to fill a rail:
//
//   figure  WHAT CURVE IS TRACED — the trochoid itself (R, r, pen, in/out).
//           Change any of these and it is a different shape.
//   place   WHERE IT SITS AND HOW BIG (rotation, scale, X, Y). Change these and
//           it is the same shape, moved.
//   look    HOW IT IS DRAWN (thickness, hue). Change these and it is the same
//           shape in the same place, rendered differently.
//
// Repeated per spiro because the module genuinely has three INDEPENDENT
// figures, not because three is a nice number.
export const SPIRO_PAGE_GROUPS: readonly {
  id: string;
  label: string;
  stems: readonly SpiroParamStem[];
}[] = [
  { id: 'figure', label: 'figure', stems: ['R', 'r', 'p', 'inside'] },
  { id: 'place', label: 'place', stems: ['rotation', 'scale', 'xOffset', 'yOffset'] },
  { id: 'look', label: 'look', stems: ['thickness', 'chroma'] },
];

/**
 * The face's pages: ONE PER SPIRO, each carrying that spiro's whole bank.
 *
 * ⚠ THIS USED TO BE TEN PAGES — `count` plus figure/place/look × 3 — and the
 * owner replaced it by name: *"this should just be 3 tabs, one per spiro"*.
 * The three IDEAS did not go away, they demoted: figure/place/look are now
 * CLUSTERS inside their spiro's page, which is the right grammar for them
 * (a page costs a ~81 px band, a cluster a ~14 px sub-header — and these three
 * are the same idea asked three times, not three different pages).
 *
 * `count` is NOT a page. It is the only true global on the module and it
 * decides how many of the three tabs mean anything, so it belongs in the face's
 * shared chrome — it is promoted to `face.hero.control` and therefore paints
 * ABOVE the rail, present in every view. A tab of its own would have been a
 * rail entry holding exactly one dial.
 *
 * DERIVED, so a page can never name a param the module does not have and a
 * fourth spiro could not arrive without its page.
 */
export function spirographsPages(): readonly {
  id: string;
  label: string;
  controls: string[];
  clusters?: { label: string; controls: string[] }[];
}[] {
  const pages: {
    id: string;
    label: string;
    controls: string[];
    clusters?: { label: string; controls: string[] }[];
  }[] = [];
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    pages.push({
      id: `s${i}`,
      label: `${i}`,
      controls: SPIRO_PAGE_GROUPS.flatMap((g) => g.stems.map((stem) => spiroParamId(i, stem))),
      clusters: SPIRO_PAGE_GROUPS.map((g) => ({
        label: g.label,
        controls: g.stems.map((stem) => spiroParamId(i, stem)),
      })),
    });
  }
  return pages;
}

/** `face.order` — `count` first (it is the hero, and a hero key must already be
 *  claimed by a band), then every page's controls in page order. */
export function spirographsOrder(): readonly string[] {
  return ['count', ...spirographsPages().flatMap((p) => p.controls)];
}

const INPUTS: VideoModuleDef['inputs'] = (() => {
  const out: VideoModuleDef['inputs'] = [
    { id: 'count', type: 'cv', paramTarget: 'count', cvScale: { mode: 'discrete' } },
  ];
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    for (const stem of SPIRO_PARAM_STEMS) {
      const id = spiroParamId(i, stem);
      out.push({
        id,
        type: 'cv',
        paramTarget: id,
        cvScale: { mode: stem === 'inside' ? 'discrete' : 'linear' },
      });
    }
  }
  return out;
})();

// ── Fullscreen-quad shader (samples the painted scene into the FBO) ─────────

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uScene;

void main() {
  // OffscreenCanvas origin is top-left; WebGL UV origin is bottom-left. Flip Y
  // so the painted scene reads upright in the FBO + downstream.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  outColor = texture(uScene, uv);
}`;

// ── Overlap colour-map shader (density accumulation → cascading-rainbow candy) ─
//
// Samples the grayscale overlap-DENSITY buffer (drawOverlapScene: each pixel's
// value ∝ how many lines stack there) and cascades it into a rainbow: the hue
// steps through the spectrum with the count, saturation + brightness rise with
// it, and a very high pile-up melts toward a white candy core ("candy gooey").
const OVERLAP_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uScene;

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  // Accumulated overlap density (grayscale coverage sum), 0..1.
  float a = dot(texture(uScene, uv).rgb, vec3(0.3333));
  if (a <= 0.003) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // CASCADE turns each added overlap into a step through the hue wheel; the
  // 0.58 base seeds the ramp in the cyan/blue range so a single line reads cool
  // and dense pile-ups race through green→yellow→red→magenta.
  const float CASCADE = 2.4;
  float hue = fract(a * CASCADE + 0.58);
  float sat = clamp(0.55 + a * 0.6, 0.0, 1.0);
  float val = clamp(0.18 + a * 1.6, 0.0, 1.0);
  vec3 rgb = hsv2rgb(vec3(hue, sat, val));
  // Very high overlap blooms toward a white candy core (the gooey highlight).
  rgb = mix(rgb, vec3(1.0), smoothstep(0.78, 1.0, a) * 0.7);
  outColor = vec4(rgb, 1.0);
}`;

// ── Module def ──────────────────────────────────────────────────────────────

export const spirographsDef: VideoModuleDef = {
  type: 'spirographs',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'spirographs',
  category: 'sources',
  inputs: INPUTS,
  outputs: [
    { id: 'out', type: 'video' },           // full-colour composite (canonical)
    { id: 'mono_out', type: 'mono-video' }, // white-on-black matte
    { id: 'overlap', type: 'video' },       // overlap-density → cascading-rainbow candy
  ],
  params: PARAMS,

  // `freeze` is a ParamDef because the engine's param plumbing is how the VRT
  // harness reaches it, and it is declared here because a player never sets it.
  // `writer: 'internal'` is asserted against this def's OWN ports: nothing in
  // `INPUTS` targets `freeze`, so the day a CV port is added for it this entry
  // stops being true and `no-user-control.test.ts` says so. Face completeness
  // then requires it to render exactly ZERO cells, which is why it is absent
  // from `face.order` — and `module-face-lint` refuses a `noUserControl` param
  // that IS ranked, so the two declarations cannot drift apart.
  noUserControl: [
    {
      param: 'freeze',
      writer: 'internal',
      why:
        'the VRT capture harness writes it to hold the last frame; this module animates by '
        + 'construction (every spiro centre drifts and bounces as a pure function of frame.time), '
        + 'so without it the faceplate scenes are moving targets and no baseline can settle. '
        + 'Nothing on the faceplate, the faceplate or the patch surface exposes it.',
    },
  ],

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR. Three independent classic spirographs on one frame. The
  // verb is DIAL A FIGURE — pick a ratio, watch the petals fall out of it — and
  // what it does that its siblings do not is give you three of them, each with
  // its own complete parameter bank and its own drifting centre, composited in
  // its own hue.
  //
  // ── TABBED, UNDER THE 2026-08-18 OWNER RULING ────────────────────────────
  //
  // MEASURED against the ruling's bar ("lots of controls of DIFFERENT types"):
  // 31 params across TEN distinct control shapes — `discrete 1..3`, `linear
  // 1..12`, `0.5..11`, `0..8`, `discrete 0..1`, `0..2pi`, `4..60`, `-1..1`,
  // `0.5..12`, `0..1`. Both halves of the bar are met with room to spare, so
  // this face is TABBED rather than crammed into dense bands.
  //
  // TEN PAGES: `count`, then figure/place/look for each of the three spiros.
  // `dockTabPlan` engages the rail at DOCK_TAB_MIN_BANDS = 7, so ten pages rail
  // comfortably — and they are not padded to get there. The alternative
  // grouping (one page per spiro, four pages total) was rejected on the
  // ruling's own words: it does not reach the rail AND it puts TEN controls in
  // a band, which is `DOCK_ROW_MAX_CONTROLS` exactly — the dense-band shape the
  // ruling names. figure/place/look are three different questions (what curve /
  // where it sits / how it is drawn), and the repetition across spiros is the
  // module's own structure rather than a way to reach a threshold.
  //
  // `count` EARNS A PAGE ON ONE CONTROL because it is the module's identity
  // control in the strongest possible sense: it ships at 1, so TWENTY OF THE
  // THIRTY-ONE PARAMS ARE BIT-EXACTLY INERT AT SPAWN. Spiro 2 and spiro 3 have
  // full, plausible-looking banks that draw nothing at all until it rises.
  //
  // ── THE RANK ─────────────────────────────────────────────────────────────
  //
  // `order` and `pages` AGREE here, which is unusual and is the honest answer.
  // `count` first, because nothing else on the module does anything until it is
  // set. Then, within a spiro, figure before place before look — a strict
  // dependency order rather than a taste: `place` moves a shape that `figure`
  // decides, and `look` renders a shape that both have already fixed. And spiro
  // 1 before 2 before 3 because that is the order `count` brings them to life
  // in, so the lane tiers surface exactly the ones that are drawing.
  //
  // THE TIER LADDER: mini shows COUNT; compact shows COUNT + spiro 1's R and r
  // (three columns, no glyph); the plate shows the top six — COUNT plus spiro
  // 1's whole figure page and its rotation; the dock shows all thirty-one on a
  // THREE-TAB rail, one tab per spiro, with COUNT and the live picture above it
  // in the shared chrome.
  //
  // ── glyph: 'none' — REQUIRED, and counter-intuitively so ──────────────────
  //
  // A video def has NO `audio` output, so `primaryAudioOutPortId` returns null
  // and any glyph other than `'none'` resolves to `{kind:'static'}` and reddens
  // the dead-glyph clause. The picture arrives from a DIFFERENT seam entirely —
  // `hasVideoSurface(def)` gives the shell a live thumbnail of the module's own
  // output — so `'none' + blank tile` and `'none' + live picture` are
  // indistinguishable from this declaration alone. The face test therefore
  // asserts `hasVideoSurface`, not the glyph, which is the only way to tell
  // them apart.
  //
  // ── THE LAYOUT: THREE TABS, ONE PER SPIRO (owner, 2026-08-19) ────────────
  //
  // *"this should just be 3 tabs, one per spiro"*, against the CARD as the
  // reference layout: *"this is all it needs and it needs all this including
  // the color picker"*.
  //
  // The face this replaced had TEN pages — `count` plus figure/place/look for
  // each of the three spiros — which put nine rail chips in front of a player
  // who thinks in figures, not in categories. The three ideas survive as
  // CLUSTERS inside each spiro's page (a ~14 px sub-header against a page's
  // ~81 px band), which is the right grammar for them: they are the same idea
  // asked three times, not three different pages.
  //
  // `count` is the only true global and it decides how many tabs mean anything,
  // so it is the HERO CONTROL — shared chrome above the rail, present in every
  // view, rather than a rail chip holding one dial.
  //
  // ⚠ THE RAIL IS AN OWNER-INSTRUCTED OPT-IN (`face.tabbed`), NOT A THRESHOLD
  // WIN. Three bands is well under `DOCK_TAB_MIN_BANDS` (7), so without the
  // declaration this face would render as one column. The opt-in is fenced:
  // see `FACE_TAB_OPT_IN` in dock-tabs-model.test.ts, which requires the
  // instruction VERBATIM per module and refuses an undeclared adopter. It does
  // NOT generalise — the default is still honest pages and a rail at 7.
  //
  // ⚠ AND THE HERO EMPTIES ITS OWN BAND, which is why DockFullView now computes
  // the rail from the POST-hero bands. `count` is ranked but on no page, so it
  // lands in the defensive `__unpaged` band; promoting it to the hero empties
  // that band and `heroFacePlan` drops it. A rail built from the PRE-hero plan
  // would have painted a fourth chip opening onto nothing.
  //
  // ── THE HUE WHEEL ────────────────────────────────────────────────────────
  //
  // Each spiro's `chroma` declares `paramCells: 'hue'` — the conic ring, the
  // control this module has always drawn by hand. It is a distinct primitive
  // from
  // `'color'` (which is a DISCRETE packed-RGB picker): a hue is CONTINUOUS over
  // one turn and WRAPS, so a KnobConic would put its end stops in the middle of
  // a continuous space and make two adjacent reds a full drag apart.
  //
  // ⚠ THE READOUTS ARE GONE. This face declared a hero strip (`live / closes /
  // clip`) and a sidebar `figures` block, and both are deleted platform-wide by
  // the resting-text ruling — it was THIS module's sidebar the owner was looking
  // at when he gave it. The three facts they printed (how many spiros are live,
  // which never close, which overflow the frame) still exist as pure functions;
  // they have no renderer, and per the ruling they are not to get one.
  //
  face: {
    order: spirographsOrder(),
    glyph: 'none',
    pages: spirographsPages(),

    // OWNER-INSTRUCTED TAB OPT-IN — see the note above and the fenced
    // FACE_TAB_OPT_IN registry. Three bands is under the threshold; this is
    // what makes the rail appear anyway.
    tabbed: true,

    // COUNT is the shared chrome: the one global, above the rail, in every view.
    hero: { control: 'count' },

    // Each spiro's HUE as the conic wheel the card drew by hand.
    paramCells: Object.fromEntries(
      Array.from({ length: SPIRO_COUNT_MAX }, (_, i) => [spiroParamId(i + 1, 'chroma'), 'hue']),
    ) as Record<string, 'hue'>,

    // ⚠ THE SCREEN ON/OFF SWITCH ARRIVES THROUGH THIS SLOT, AND IT HAD TO
    // (#1928). The 2026-08-18 owner ruling gives every video module a screen
    // on/off toggle. This module shipped one — on `SpirographsCard.svelte` —
    // and was then promoted into STRICT_FACES, which makes `migrated()` true
    // and stops BOTH surfaces from rendering that card. The required control
    // was therefore unreachable from the faceplate that replaced it: the ruling
    // was satisfied on a surface nobody sees any more.
    //
    // There is no generic affordance to fall back on — `previewCollapsed`
    // appears in ZERO shell files — so it comes through `fullViewBody`, the
    // route `backdraft` and `videoOut` already take, per the owner's
    // instruction to make this behave the way backdraft does.
    //
    // Contract-transparent: `face.extension` is a STRING, not a component, so
    // the shell never imports a spirographs file, and `face` is stripped from
    // the attest basis — declaring it costs no re-attest and no contract line.
    extension: 'spirographs',
  },

  docs: {
    explanation: "A pure video source (no input) that renders 1-3 independent classic spirographs and uploads them to the GPU each frame. Each spiro is a trochoid traced by a pen at offset p inside a rolling circle of radius r that rolls without slipping on a fixed circle of radius R: inside=hypotrochoid (rolling circle inside the fixed one), outside=epitrochoid (rolling circle outside it). The R:r ratio sets how many petals/loops the figure makes and how many revolutions it takes to close (a rational ratio closes; a near-irrational one densely fills the annulus, capped at a sane max). Each spiro has its own full parameter bank (R, r, pen, in/out, rotation, scale, X/Y, thickness, hue) and its own center that drifts independently across the frame, with the fixed-radius circle bouncing elastically off the four edges (only the fixed circle is kept fully in-frame; the drawn curve may overflow and clip, which is intended). The COLOR out composites each curve in its hue additively (lighter blend) on black so crossings glow toward white; switch its output port to get a white-on-black matte or a density-mapped rainbow \"candy\" overlap instead. Usage: pick a count, then use the per-spiro tabs to dial each figure (try a 5:2 inside spiro for a 5-petal star), and feed an LFO into a rotation or scale CV for slow living motion.",
    inputs: {
      count: "modulates Count (discrete CV, 1-3): how many of the three spiros render this frame.",
      s1_R: "modulates spiro 1 Fixed radius (R, 1-12): the fixed outer circle; with r sets the petal ratio.",
      s1_r: "modulates spiro 1 Roll radius (r, 0.5-11): the rolling circle's radius; R:r drives the figure.",
      s1_p: "modulates spiro 1 Pen offset (p, 0-8): pen distance from the rolling circle's center.",
      s1_inside: "modulates spiro 1 In/Out (discrete CV): high = inside (hypotrochoid), low = outside (epitrochoid).",
      s1_rotation: "modulates spiro 1 Rotation (0-2pi radians): spins the whole figure about its center.",
      s1_scale: "modulates spiro 1 Scale (4-60): spiro-space-to-pixels zoom of the figure.",
      s1_xOffset: "modulates spiro 1 X offset (-1..1): nudges its drift home position horizontally.",
      s1_yOffset: "modulates spiro 1 Y offset (-1..1): nudges its drift home position vertically.",
      s1_thickness: "modulates spiro 1 Width (0.5-12 px): stroke line width of the curve.",
      s1_chroma: "modulates spiro 1 Hue (0-1 colorwheel): the curve's color in the COLOR output.",
      s2_R: "modulates spiro 2 Fixed radius (R, 1-12): the fixed outer circle; with r sets the petal ratio.",
      s2_r: "modulates spiro 2 Roll radius (r, 0.5-11): the rolling circle's radius; R:r drives the figure.",
      s2_p: "modulates spiro 2 Pen offset (p, 0-8): pen distance from the rolling circle's center.",
      s2_inside: "modulates spiro 2 In/Out (discrete CV): high = inside (hypotrochoid), low = outside (epitrochoid).",
      s2_rotation: "modulates spiro 2 Rotation (0-2pi radians): spins the whole figure about its center.",
      s2_scale: "modulates spiro 2 Scale (4-60): spiro-space-to-pixels zoom of the figure.",
      s2_xOffset: "modulates spiro 2 X offset (-1..1): nudges its drift home position horizontally.",
      s2_yOffset: "modulates spiro 2 Y offset (-1..1): nudges its drift home position vertically.",
      s2_thickness: "modulates spiro 2 Width (0.5-12 px): stroke line width of the curve.",
      s2_chroma: "modulates spiro 2 Hue (0-1 colorwheel): the curve's color in the COLOR output.",
      s3_R: "modulates spiro 3 Fixed radius (R, 1-12): the fixed outer circle; with r sets the petal ratio.",
      s3_r: "modulates spiro 3 Roll radius (r, 0.5-11): the rolling circle's radius; R:r drives the figure.",
      s3_p: "modulates spiro 3 Pen offset (p, 0-8): pen distance from the rolling circle's center.",
      s3_inside: "modulates spiro 3 In/Out (discrete CV): high = inside (hypotrochoid), low = outside (epitrochoid).",
      s3_rotation: "modulates spiro 3 Rotation (0-2pi radians): spins the whole figure about its center.",
      s3_scale: "modulates spiro 3 Scale (4-60): spiro-space-to-pixels zoom of the figure.",
      s3_xOffset: "modulates spiro 3 X offset (-1..1): nudges its drift home position horizontally.",
      s3_yOffset: "modulates spiro 3 Y offset (-1..1): nudges its drift home position vertically.",
      s3_thickness: "modulates spiro 3 Width (0.5-12 px): stroke line width of the curve.",
      s3_chroma: "modulates spiro 3 Hue (0-1 colorwheel): the curve's color in the COLOR output.",
    },
    outputs: {
      out: "COLOR: the canonical full-color composite, each spiro stroked in its hue and additively blended (lighter) on black so overlaps glow toward white.",
      mono_out: "MONO: every spiro stroked white on black, a clean matte for keying or luma effects downstream.",
      overlap: "CANDY: the per-pixel line-stack density mapped to a cascading rainbow that blooms to a white core where many lines pile up (hue-independent: driven by density, not the chroma controls).",
    },
    controls: {
      count: "Count (1-3, discrete): how many of the three spiros render. Independent of which tab you are editing.",
      s1_R: "Spiro 1 Fixed (R, 1-12): the fixed outer circle radius; with Roll it sets the petal/loop ratio.",
      s1_r: "Spiro 1 Roll (r, 0.5-11): the rolling circle radius; the R:r ratio defines the figure and revolutions to close.",
      s1_p: "Spiro 1 Pen (p, 0-8): pen offset in the rolling circle; 0 traces a plain circle, larger makes deeper loops.",
      s1_inside: "Spiro 1 In/Out toggle: INSIDE = hypotrochoid (rolling circle inside), OUTSIDE = epitrochoid (rolling circle outside).",
      s1_rotation: "Spiro 1 Rot (0-2pi radians): static rotation of the whole figure about its center.",
      s1_scale: "Spiro 1 Scale (4-60): zoom from spiro-space units to pixels; with R it also sets the fixed circle's bounce inset.",
      s1_xOffset: "Spiro 1 X (-1..1): nudges the drift home position horizontally (center still drifts and bounces).",
      s1_yOffset: "Spiro 1 Y (-1..1): nudges the drift home position vertically (center still drifts and bounces).",
      s1_thickness: "Spiro 1 Width (0.5-12 px): stroke line width, drawn with round joins and caps.",
      s1_chroma: "Spiro 1 Hue (0-1 colorwheel): the curve's color in the COLOR output (MONO and CANDY ignore it).",
      s2_R: "Spiro 2 Fixed (R, 1-12): the fixed outer circle radius; with Roll it sets the petal/loop ratio.",
      s2_r: "Spiro 2 Roll (r, 0.5-11): the rolling circle radius; the R:r ratio defines the figure and revolutions to close.",
      s2_p: "Spiro 2 Pen (p, 0-8): pen offset in the rolling circle; 0 traces a plain circle, larger makes deeper loops.",
      s2_inside: "Spiro 2 In/Out toggle: INSIDE = hypotrochoid (rolling circle inside), OUTSIDE = epitrochoid (rolling circle outside).",
      s2_rotation: "Spiro 2 Rot (0-2pi radians): static rotation of the whole figure about its center.",
      s2_scale: "Spiro 2 Scale (4-60): zoom from spiro-space units to pixels; with R it also sets the fixed circle's bounce inset.",
      s2_xOffset: "Spiro 2 X (-1..1): nudges the drift home position horizontally (center still drifts and bounces).",
      s2_yOffset: "Spiro 2 Y (-1..1): nudges the drift home position vertically (center still drifts and bounces).",
      s2_thickness: "Spiro 2 Width (0.5-12 px): stroke line width, drawn with round joins and caps.",
      s2_chroma: "Spiro 2 Hue (0-1 colorwheel): the curve's color in the COLOR output (MONO and CANDY ignore it).",
      s3_R: "Spiro 3 Fixed (R, 1-12): the fixed outer circle radius; with Roll it sets the petal/loop ratio.",
      s3_r: "Spiro 3 Roll (r, 0.5-11): the rolling circle radius; the R:r ratio defines the figure and revolutions to close.",
      s3_p: "Spiro 3 Pen (p, 0-8): pen offset in the rolling circle; 0 traces a plain circle, larger makes deeper loops.",
      s3_inside: "Spiro 3 In/Out toggle: INSIDE = hypotrochoid (rolling circle inside), OUTSIDE = epitrochoid (rolling circle outside).",
      s3_rotation: "Spiro 3 Rot (0-2pi radians): static rotation of the whole figure about its center.",
      s3_scale: "Spiro 3 Scale (4-60): zoom from spiro-space units to pixels; with R it also sets the fixed circle's bounce inset.",
      s3_xOffset: "Spiro 3 X (-1..1): nudges the drift home position horizontally (center still drifts and bounces).",
      s3_yOffset: "Spiro 3 Y (-1..1): nudges the drift home position vertically (center still drifts and bounces).",
      s3_thickness: "Spiro 3 Width (0.5-12 px): stroke line width, drawn with round joins and caps.",
      s3_chroma: "Spiro 3 Hue (0-1 colorwheel): the curve's color in the COLOR output (MONO and CANDY ignore it).",
      freeze: "Freeze (0/1, default 0): a hidden determinism toggle with NO control anywhere — not on the faceplate, not on the faceplate, not on the patch surface. At 0.5 or above the draw step is a no-op, so every output holds its last frame instead of going black. It exists because this module animates by construction: each spiro's centre drifts and bounces off the frame edges as a function of elapsed time, so two captures of the same settings are never the same pixels. The visual-regression harness writes it before comparing a screenshot; nothing else ever does.",
    },
  },
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uScene = gl.getUniformLocation(program, 'uScene');
    // Separate program for the overlap output: same fullscreen quad, but the
    // frag colour-maps the density buffer into the cascading-rainbow candy.
    const overlapProgram = ctx.compileFragment(OVERLAP_FRAG);
    const uOverlapScene = gl.getUniformLocation(overlapProgram, 'uScene');

    const colorFbo = ctx.createFbo();
    const monoFbo = ctx.createFbo();
    const overlapFbo = ctx.createFbo();

    const params: Record<string, number> = { ...DEFAULTS, ...(node.params as Record<string, number>) };

    // ---- Two scene canvases (colour + mono) + their upload textures ----
    // Both may be absent in headless node test envs — fall through to null so
    // the factory still spawns + draw() no-ops the paint/upload.
    function makeCanvas(): OffscreenCanvas | HTMLCanvasElement | null {
      try {
        if (typeof OffscreenCanvas !== 'undefined') {
          return new OffscreenCanvas(ctx.res.width, ctx.res.height);
        }
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          c.width = ctx.res.width;
          c.height = ctx.res.height;
          return c;
        }
      } catch {
        return null;
      }
      return null;
    }
    const colorCanvas = makeCanvas();
    const monoCanvas = makeCanvas();
    const overlapCanvas = makeCanvas();
    const colorCtx = colorCanvas
      ? (colorCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
      : null;
    const monoCtx = monoCanvas
      ? (monoCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
      : null;
    const overlapCtx = overlapCanvas
      ? (overlapCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
      : null;

    function makeSceneTex(): WebGLTexture {
      const t = gl.createTexture();
      if (!t) throw new Error('SPIROGRAPHS: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      return t;
    }
    const colorTex = makeSceneTex();
    const monoTex = makeSceneTex();
    const overlapTex = makeSceneTex();

    let framesElapsed = 0;

    /** Resolve the live per-spiro params + bounce-constrained center into the
     *  renderer's ResolvedSpiro list for the first `count` spiros. */
    function resolveSpiros(timeSec: number): ResolvedSpiro[] {
      const count = Math.max(1, Math.min(SPIRO_COUNT_MAX, Math.round(params.count ?? 1)));
      const W = ctx.res.width;
      const H = ctx.res.height;
      const list: ResolvedSpiro[] = [];
      for (let i = 1; i <= count; i++) {
        const R = clampStem('R', params[spiroParamId(i, 'R')] ?? 5);
        const r = clampStem('r', params[spiroParamId(i, 'r')] ?? 3);
        const p = clampStem('p', params[spiroParamId(i, 'p')] ?? 2);
        const insideV = params[spiroParamId(i, 'inside')] ?? 1;
        const kind: SpiroKind = insideV >= 0.5 ? 'inside' : 'outside';
        const rotation = clampStem('rotation', params[spiroParamId(i, 'rotation')] ?? 0);
        const scale = clampStem('scale', params[spiroParamId(i, 'scale')] ?? 24);
        const xOff = clampStem('xOffset', params[spiroParamId(i, 'xOffset')] ?? 0);
        const yOff = clampStem('yOffset', params[spiroParamId(i, 'yOffset')] ?? 0);
        const thickness = clampStem('thickness', params[spiroParamId(i, 'thickness')] ?? 2);
        const chroma = clampStem('chroma', params[spiroParamId(i, 'chroma')] ?? 0);

        // The screen radius of the FIXED circle (R, scaled). This is what the
        // bounce-constraint insets the center by so the circle never leaves frame.
        const fixedRadiusPx = R * scale;

        // Home position (xOffset/yOffset nudge the drift's home a little) + the
        // per-spiro drift velocity, converted from frame-fractions to pixels.
        const drift = SPIRO_DRIFT[i]!;
        const homeX = (drift.hx + xOff * 0.25) * W;
        const homeY = (drift.hy + yOff * 0.25) * H;
        const base: CenterState = {
          x: homeX,
          y: homeY,
          vx: drift.vx * W,
          vy: drift.vy * H,
        };
        const c = advanceCenter(base, fixedRadiusPx, W, H, timeSec);

        list.push({
          kind, R, r, p, rotation, scale,
          cx: c.x, cy: c.y,
          thickness, hue: chroma,
        });
      }
      return list;
    }

    const surface: VideoNodeSurface = {
      fbo: colorFbo.fbo,
      texture: colorFbo.texture,
      draw(frame) {
        const g = frame.gl;
        // FREEZE — hold the last frame. Every surface this module owns keeps
        // whatever it last held, so the picture does not go black; it stops.
        // See the `freeze` ParamDef for why this module needs one at all.
        if ((params.freeze ?? 0) >= 0.5) return;
        const timeSec = frame.time;
        const spiros = resolveSpiros(timeSec);
        const W = ctx.res.width;
        const H = ctx.res.height;

        // 1. Paint all three scenes (colour + mono matte + overlap density) on
        //    their 2D canvases.
        if (colorCtx) drawColorScene(colorCtx, spiros, W, H);
        if (monoCtx) drawMonoScene(monoCtx, spiros, W, H);
        if (overlapCtx) drawOverlapScene(overlapCtx, spiros, W, H);

        // 2. Upload each painted canvas to its texture, then run a fullscreen-
        //    quad shader to write it into the matching FBO. The colour + mono
        //    outputs use the plain copy program; the overlap output uses the
        //    density→rainbow colour-map program.
        const uploadAndBlit = (
          canvas: OffscreenCanvas | HTMLCanvasElement | null,
          tex: WebGLTexture,
          fbo: WebGLFramebuffer | null,
          prog: WebGLProgram,
          uSampler: WebGLUniformLocation | null,
        ) => {
          if (!canvas || !fbo) return;
          g.bindTexture(g.TEXTURE_2D, tex);
          g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
          g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, canvas as unknown as TexImageSource);
          g.bindFramebuffer(g.FRAMEBUFFER, fbo);
          g.viewport(0, 0, W, H);
          g.useProgram(prog);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, tex);
          g.uniform1i(uSampler, 0);
          ctx.drawFullscreenQuad();
          g.bindFramebuffer(g.FRAMEBUFFER, null);
        };
        uploadAndBlit(colorCanvas, colorTex, colorFbo.fbo, program, uScene);
        uploadAndBlit(monoCanvas, monoTex, monoFbo.fbo, program, uScene);
        uploadAndBlit(overlapCanvas, overlapTex, overlapFbo.fbo, overlapProgram, uOverlapScene);

        framesElapsed++;
      },
      dispose() {
        gl.deleteFramebuffer(colorFbo.fbo);
        gl.deleteTexture(colorFbo.texture);
        gl.deleteFramebuffer(monoFbo.fbo);
        gl.deleteTexture(monoFbo.texture);
        gl.deleteFramebuffer(overlapFbo.fbo);
        gl.deleteTexture(overlapFbo.texture);
        gl.deleteTexture(colorTex);
        gl.deleteTexture(monoTex);
        gl.deleteTexture(overlapTex);
        gl.deleteProgram(program);
        gl.deleteProgram(overlapProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) params[paramId] = value;
      },
      readParam(paramId) {
        return params[paramId];
      },
      read(key) {
        // Multi-output texture lookup (engine's lookupInput calls this for any
        // edge whose source port id != the canonical 'out').
        if (key === 'outputTexture:out') return colorFbo.texture;
        if (key === 'outputTexture:mono_out') return monoFbo.texture;
        if (key === 'outputTexture:overlap') return overlapFbo.texture;
        if (key === 'framesElapsed') return framesElapsed;
        // Card preview snapshot hook (mirrors AcidwarpCard/ShapegenCard).
        if (key === 'sceneCanvas') return colorCanvas;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
