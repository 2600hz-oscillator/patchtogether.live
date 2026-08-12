// packages/web/src/lib/ui/modules/wavesculpt-face-model.ts
//
// The derived model behind WAVESCULPT's faceplate: the ROOM.
//
// ── WHAT THIS FILE EXISTS TO SAY ───────────────────────────────────────────
//
// WAVESCULPT is a room you stand inside. Four wavetable voices are bolted to
// four walls and aimed at its centre, and ONE camera position is simultaneously
// the viewpoint and the mix desk — `distanceGain(src, vec, eye)` is the single
// number that scales a voice's ribbon AND its audio gain
// (`wavesculpt.ts`: `envDist.gain = v.env * distG`).
//
// That gain has a DIRECTIONAL term, `max(0, dot(emission, toCamera))`, and it
// clamps at zero. So an emitter that faces AWAY from you is not quiet — it is
// SILENT, and its per-voice tap (`out_red/grn/blu/alp`, which hangs downstream
// of `envDist`) emits digital zero with it. Nothing in the legacy card says so.
// Every function below exists so the faceplate can.
//
// ── MEASURED, ON THIS BRANCH, THROUGH THE REAL EXPORTS ─────────────────────
//
// These numbers are not transcribed from a design note; `wavesculpt-face-model
// .test.ts` recomputes each one from `eyeFromCamera` + `distanceGain` (the
// same two functions the factory calls) and fails if it moves.
//
//   AT THE SPAWN CAMERA (pos 0,0,0 · zoom 1 · rot 0), eye = [0, 0, 2.5]:
//     RED    5.3229e-2   −25.48 dB
//     GREEN  4.8029e-2   −26.37 dB
//     BLUE   0.0000e+0   DARK      ← the eye stands directly behind it
//     ALPHA  7.0273e-2   −23.06 dB
//   → `3 of 4` live, quietest `BLUE dark`, spread over the live three 3.31 dB.
//
//   AND IT IS NOT A KNIFE EDGE: holding pos/zoom at default and sweeping `rot`,
//   BLUE is exactly zero across |rot| < 0.370 — a 0.74-wide dead window in a
//   −1..+1 knob, i.e. **36.7 %** of that knob's travel (401-point sweep).
//
//   ⚠ THE FACE SPEC SAID 74 %, AND THAT IS THE WINDOW WIDTH READ AS A
//   FRACTION. `rot` spans 2.0, not 1.0, so 0.74 of it is 37 %. Recorded here
//   because the number was about to be repeated onto a faceplate: the sweep in
//   the test file is what the prose is now pinned to, and it fails if it moves.
//
// ⚠ THIS IS A DEFAULT DEFECT, NOT A GEOMETRY DEFECT, and this file does not
// try to fix it. All four voices go silent somewhere (measured over a 40 131
// point sweep of the whole reachable camera space: RED 18.1 %, GREEN 25.9 %,
// BLUE 28.4 %, ALPHA 29.4 % of it), which is the intended design — the walls
// aim their cones through the room centre so you can stand in the middle and
// hear them meet. The bug is that the SHIPPED DEFAULT stands on one of the
// zeros. Moving the default camera, or flooring the directional term, changes
// the sound of every saved patch at spawn: a def/DSP change with owner ears and
// an ART re-pin, deliberately NOT folded into a face PR. What the face does is
// make it impossible to miss.
//
// ── ⚠ WHAT THE READOUT PATH CANNOT SEE, AND WHY THE LABELS SAY `knob` ──────
//
// A registered `FaceReadoutValue` is handed a DURABLE-param reader
// (`ModuleShell.readoutValue` → `node.params`). On this module that blind spot
// is not hypothetical: ALL FIVE camera axes carry `paramTarget` CV inputs
// (`pos_x`, `pos_y`, `pos_z`, `zoom`, `rot`), so a camera being flown by an LFO
// is invisible to it. The hero readouts are therefore captioned `knob …` — the
// analogVco `knob pitch` precedent — and the HERO PANEL, which can reach the
// engine handle, is where the CV-displaced truth lives.
//
// ── THE INSTRUMENT, AND ITS NEGATIVE CONTROLS ──────────────────────────────
//
// The obvious readout here is a `paramId: 'rot'` knob readback, and it is
// WRONG in the exact way CLAUDE.md's "validate the instrument" section warns
// about: it prints `0.00` at spawn and `0.30` at the VRT scene's camera, both
// of which are BLUE-is-silent positions, with no hint that a voice is dead. It
// is invariant to the very quantity in dispute. Every derivation below is
// negative-controlled in the unit lane against an input a knob readback is
// blind to — see the test file, which is a permanent leg, not an authoring-time
// check.

import {
  WALL_LAYOUT,
  distanceGain,
  eyeFromCamera,
  wavesculptDef,
  BLINK_MODE_OPTIONS,
  VIDEO_MODE_OPTIONS,
} from '$lib/audio/modules/wavesculpt';

// ── THE FOUR VOICES ────────────────────────────────────────────────────────

/** One wall voice: what it is called, which jack taps it, and which colour
 *  param tints it. `wall` is DERIVED from `WALL_LAYOUT` rather than typed, so a
 *  layout edit cannot leave this file describing the old room. */
export interface WavesculptVoice {
  /** 0..3, the `WALL_LAYOUT` / `oscChains` index. */
  idx: number;
  /** Display name, matching the card's `OSC_COLOR_LABELS`. */
  label: string;
  /** The per-voice AUDIO tap for this oscillator (a real `def.outputs` id). */
  outPort: string;
  /** Its packed-RGB colour param, or `null` for ALPHA (the mask layer). */
  colorParam: string | null;
  /** `'+X wall · y −1.0'` — derived from `WALL_LAYOUT[idx].src`. */
  wall: string;
}

const VOICE_LABELS = ['RED', 'GREEN', 'BLUE', 'ALPHA'] as const;
const VOICE_TAPS = ['out_red', 'out_grn', 'out_blu', 'out_alp'] as const;
const VOICE_COLOR_PARAMS = ['red_color', 'grn_color', 'blu_color', null] as const;

/** `[1, -1, 0]` → `'+X wall · y −1.0'`. The wall is whichever of X/Z the source
 *  sits on; the height is the raw Y. Uses U+2212 MINUS, matching the docs. */
function wallTag(src: readonly [number, number, number]): string {
  const onX = Math.abs(src[0]) >= Math.abs(src[2]);
  const axis = onX ? 'X' : 'Z';
  const along = onX ? src[0] : src[2];
  const y = src[1];
  return `${along >= 0 ? '+' : '−'}${axis} wall · y ${y < 0 ? '−' : '+'}${Math.abs(y).toFixed(1)}`;
}

/** The four voices, in `WALL_LAYOUT` order (0=RED, 1=GREEN, 2=BLUE, 3=ALPHA —
 *  the mapping the def's per-voice tap docs and the card's colour labels both
 *  already pin). */
export const WAVESCULPT_VOICES: readonly WavesculptVoice[] = WALL_LAYOUT.map((w, i) => ({
  idx: i,
  label: VOICE_LABELS[i]!,
  outPort: VOICE_TAPS[i]!,
  colorParam: VOICE_COLOR_PARAMS[i],
  wall: wallTag(w.src),
}));

// ── THE CAMERA ─────────────────────────────────────────────────────────────

/** The five camera axes, resolved. */
export interface WavesculptCamera {
  pos_x: number;
  pos_y: number;
  pos_z: number;
  zoom: number;
  rot: number;
}

/** Every param id this model reads, so a caller can poll exactly these. */
export const WAVESCULPT_CAMERA_PARAMS = ['pos_x', 'pos_y', 'pos_z', 'zoom', 'rot'] as const;

/**
 * Resolve the camera from a param reader, falling back to the DEF DEFAULT for
 * anything untouched.
 *
 * ⚠ THE FALLBACK IS MANDATORY, not defensive. `node.params` is a SPARSE overlay
 * of what has been touched: reading it bare gives `undefined` for every dial
 * nobody has moved, and coercing that to 0 would put `zoom` at 0 — outside its
 * own declared 0.3..3 range — and print a room nobody is standing in.
 */
export function wavesculptCamera(read: (paramId: string) => number | undefined): WavesculptCamera {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = wavesculptDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`wavesculpt-face-model: no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    pos_x: val('pos_x'),
    pos_y: val('pos_y'),
    pos_z: val('pos_z'),
    zoom: val('zoom'),
    rot: val('rot'),
  };
}

/** The eye position this camera puts you at — the module's own pure helper. */
export function wavesculptEye(cam: WavesculptCamera): [number, number, number] {
  return eyeFromCamera(cam.pos_x, cam.pos_y, cam.pos_z, cam.zoom, cam.rot);
}

/**
 * The four distance gains at this camera, in `WALL_LAYOUT` order.
 *
 * This is the SAME call the factory makes per voice (`wavesculpt.ts`:
 * `distanceGain(WALL_LAYOUT[i].src, WALL_LAYOUT[i].vec, camPos)`), through the
 * same two exported functions — not a re-derivation. A shader/geometry edit
 * therefore moves this picture with the audio rather than leaving the two to
 * disagree.
 */
export function wavesculptVoiceGains(cam: WavesculptCamera): number[] {
  const eye = wavesculptEye(cam);
  return WALL_LAYOUT.map((w) => distanceGain(w.src, w.vec, eye));
}

/** How many of the four are audible at all. A gain of exactly 0 is the clamped
 *  directional term — the voice is behind you, not merely far away. */
export function wavesculptLiveCount(gains: readonly number[]): number {
  return gains.reduce((n, g) => (g > 0 ? n + 1 : n), 0);
}

/** The lowest-gain voice. Ties resolve to the lowest index, deterministically —
 *  a tie is reachable (two dark voices both read 0). */
export function wavesculptQuietest(gains: readonly number[]): { idx: number; gain: number } {
  let idx = 0;
  for (let i = 1; i < gains.length; i++) if (gains[i]! < gains[idx]!) idx = i;
  return { idx, gain: gains[idx]! };
}

/**
 * The level SPREAD across the four voices, in dB — `20·log10(max/min)`.
 *
 * `null` when any voice is exactly zero (the ratio is unbounded), which the
 * caller prints as `∞` rather than as a very large number. At spawn the three
 * LIVE voices span 3.31 dB, which is pure wall geometry: the four sit at
 * different heights on different walls, so "all four voices set identically"
 * has never produced four equal levels and no surface has ever said so.
 */
export function wavesculptSpreadDb(gains: readonly number[]): number | null {
  let lo = Infinity;
  let hi = 0;
  for (const g of gains) {
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  if (!(lo > 0) || !(hi > 0)) return null;
  return 20 * Math.log10(hi / lo);
}

/** The spread across only the voices that are actually audible. `null` when
 *  fewer than two are. */
export function wavesculptLiveSpreadDb(gains: readonly number[]): number | null {
  const live = gains.filter((g) => g > 0);
  if (live.length < 2) return null;
  return wavesculptSpreadDb(live);
}

// ── FORMATTERS ─────────────────────────────────────────────────────────────

/** A gain scalar as dB, or `dark` at exactly zero. Never `-Infinity dB`. */
export function wavesculptGainText(gain: number): string {
  if (!(gain > 0)) return 'dark';
  return `${(20 * Math.log10(gain)).toFixed(1)} dB`;
}

/** `3 of 4` — the readout that justifies this faceplate. */
export function wavesculptVoicesLiveText(cam: WavesculptCamera): string {
  const gains = wavesculptVoiceGains(cam);
  return `${wavesculptLiveCount(gains)} of ${gains.length}`;
}

/** `BLUE dark` at spawn; a real dB figure wherever all four are audible. */
export function wavesculptQuietestText(cam: WavesculptCamera): string {
  const gains = wavesculptVoiceGains(cam);
  const q = wavesculptQuietest(gains);
  return `${WAVESCULPT_VOICES[q.idx]!.label} ${wavesculptGainText(q.gain)}`;
}

/**
 * `3.31 dB` across the live voices; `∞ · 1 dark` when one is clamped out.
 *
 * ⚠ IT REPORTS THE **LIVE** SPREAD, and the `∞` is what keeps that honest.
 * Reporting only the live voices means the number stays readable while a voice
 * is behind you — but silently dropping a voice from a "spread" is exactly how
 * a metric goes blind, so the dark count rides along in the same string.
 */
export function wavesculptSpreadText(cam: WavesculptCamera): string {
  const gains = wavesculptVoiceGains(cam);
  const dark = gains.length - wavesculptLiveCount(gains);
  const live = wavesculptLiveSpreadDb(gains);
  if (live === null) return dark >= gains.length ? 'all dark' : `— · ${dark} dark`;
  const span = `${live.toFixed(2)} dB`;
  return dark > 0 ? `${span} · ${dark} dark` : span;
}

// ── THE VIEW COMBINATION — all nine states, and which of them bite ─────────

/** The name of a discrete state, off the def's own roster. Never re-typed. */
function optionLabel(options: readonly { value: number; label: string }[], v: number): string {
  const n = Math.round(v);
  return options.find((o) => o.value === n)?.label ?? options[0]!.label;
}

/**
 * `PROXIMITY · RIBBONS` — the current point in the 3×3 VIEW × BLINK grid.
 *
 * ⚠ ALL NINE COMBINATIONS ARE REACHABLE AND PRESERVED, and this readout exists
 * because only THREE of them are live at a time. BLINK selects how the four
 * oscillators are drawn INSIDE the 3D scene: `WavesculptCard.tick()` returns
 * early for `video_mode` 1 (BIRDSEYE, a 2-D floorplan) and 2 (SPECTROGRAPH, an
 * STFT), so `drawScopes()` — the only reader of BLINK, and of `scale` with it —
 * is never reached from either. The BLINK value is NOT lost: it persists on the
 * patch and takes effect the moment VIEW returns to PROXIMITY.
 *
 * So the readout prints the pair and says `idle` when the second half of it is
 * not currently drawing anything. That is the honest rendering of a 3×3 grid
 * where six cells are a deferred choice rather than a distinct picture, and it
 * is the only place in the UI a player can learn it.
 */
export function wavesculptViewComboText(read: (paramId: string) => number | undefined): string {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return wavesculptDef.params.find((p) => p.id === id)!.defaultValue;
  };
  const view = Math.round(val('video_mode'));
  const blink = Math.round(val('blink_mode'));
  const viewName = optionLabel(VIDEO_MODE_OPTIONS, view);
  const blinkName = optionLabel(BLINK_MODE_OPTIONS, blink);
  // PROXIMITY is the only mode that reaches the ribbon/scope programs.
  return view === 0 ? `${viewName} · ${blinkName}` : `${viewName} · ${blinkName} idle`;
}

/** Does `scale` do anything at this VIEW × BLINK pair? `uScale[]` is read only
 *  by the SCOPE program, which runs only at `blink_mode > 0` inside PROXIMITY.
 *  Exported so the panel and the test agree on one predicate. */
export function wavesculptScaleBites(videoMode: number, blinkMode: number): boolean {
  return Math.round(videoMode) === 0 && Math.round(blinkMode) > 0;
}

// ── THE HERO PICTURE — a top-down plan of the room ─────────────────────────

/** Half-extent of the plan, in room units. The unit box is ±1; the eye reaches
 *  ±(1.5 + 2.5/zoom), i.e. ±8.3 at the minimum zoom, so the marker is CLAMPED
 *  to the frame and flagged rather than the frame being rescaled under the
 *  hand — a plan whose scale moves while you drag is not a joystick. */
export const ROOM_PLAN_EXTENT = 3;

/** One emitter, placed on the top-down plan. Plan coords are −1..+1 with
 *  `px` running +X to the right and `py` running +Z DOWN (a floor plan seen
 *  from above, so "back wall" is at the bottom). */
export interface RoomPlanEmitter {
  idx: number;
  label: string;
  /** Plan position, −1..+1 each. */
  px: number;
  py: number;
  /** Unit direction the cone is aimed, in plan space. */
  dx: number;
  dy: number;
  /** The live distance gain (0 = clamped dark). */
  gain: number;
  dark: boolean;
}

export interface RoomPlan {
  emitters: RoomPlanEmitter[];
  /** The camera, in plan coords, CLAMPED to the frame. */
  eyeX: number;
  eyeY: number;
  /** True when the true eye is outside the drawn frame (the marker is pinned
   *  to the edge and the caption carries the real numbers). */
  eyeClamped: boolean;
  /** Half-extent of the room box itself, in plan coords. */
  boxHalf: number;
}

function toPlan(v: number): number {
  return Math.max(-1, Math.min(1, v / ROOM_PLAN_EXTENT));
}

/** The whole picture, as pure data. The component only paints it. */
export function wavesculptRoomPlan(cam: WavesculptCamera): RoomPlan {
  const gains = wavesculptVoiceGains(cam);
  const emitters = WALL_LAYOUT.map((w, i) => {
    const len = Math.hypot(w.vec[0], w.vec[2]) || 1;
    return {
      idx: i,
      label: WAVESCULPT_VOICES[i]!.label,
      px: toPlan(w.src[0]),
      py: toPlan(w.src[2]),
      dx: w.vec[0] / len,
      dy: w.vec[2] / len,
      gain: gains[i]!,
      dark: !(gains[i]! > 0),
    };
  });
  const eye = wavesculptEye(cam);
  return {
    emitters,
    eyeX: toPlan(eye[0]),
    eyeY: toPlan(eye[2]),
    eyeClamped: Math.abs(eye[0]) > ROOM_PLAN_EXTENT || Math.abs(eye[2]) > ROOM_PLAN_EXTENT,
    boxHalf: 1 / ROOM_PLAN_EXTENT,
  };
}

/**
 * Invert the plan: where must `pos_x` / `pos_z` sit for the EYE to land on this
 * plan point?
 *
 * `eyeFromCamera` is `eye = pos·1.5 + rotationalOffset(zoom, rot)`, so the
 * inverse is exact rather than a search. Both axes clamp to the params'
 * declared −1..+1, which is why dragging past the reachable set parks the
 * marker on the boundary instead of doing nothing.
 *
 * ⚠ NOTHING IN PRODUCTION CALLS THIS TODAY, and that is deliberate rather than
 * an oversight. The plan's drag wrote `pos_x`/`pos_z`, duplicating the POSITION
 * pad's x-axis against a DIFFERENT second axis; one gesture per axis was the
 * fix, so the plan is now a read-only picture and the camera is flown by the
 * two joysticks. The mapping is kept because it is the exact inverse of a
 * shipped function and is asserted as such below — if a plan drag ever returns
 * it must land where you drop it, and re-deriving this by search is how that
 * stops being true. It is NOT a ledger entry: there is nothing to track and
 * nothing to pay off.
 */
export function wavesculptDragToCamera(
  cam: WavesculptCamera,
  planX: number,
  planY: number,
): { pos_x: number; pos_z: number } {
  const baseDist = 2.5 / Math.max(0.05, cam.zoom);
  const rad = cam.rot * Math.PI;
  const offX = Math.sin(rad) * baseDist;
  const offZ = Math.cos(rad) * baseDist;
  const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));
  return {
    pos_x: clamp1((planX * ROOM_PLAN_EXTENT - offX) / 1.5),
    pos_z: clamp1((planY * ROOM_PLAN_EXTENT - offZ) / 1.5),
  };
}

// ── THE OUTPUT TAP — the hero's selectable output ──────────────────────────

/** The audio outputs a player can choose between. `mix` is the summed stereo
 *  bus (`L`/`R`, POST master gain); the other four are the per-voice taps
 *  (PRE master gain), which is the distinction the caption exists to state. */
export type WavesculptTap = 'mix' | 'red' | 'grn' | 'blu' | 'alp';

export interface WavesculptTapChoice {
  id: WavesculptTap;
  label: string;
  /** The def output id(s) this choice names. */
  ports: string;
  /** `null` for the mix; otherwise the voice index it taps. */
  voice: number | null;
}

/** The five choices, derived from the voice table so a renamed tap cannot leave
 *  a chip pointing at a jack that is not there. */
export const WAVESCULPT_TAPS: readonly WavesculptTapChoice[] = [
  { id: 'mix', label: 'MIX', ports: 'L + R', voice: null },
  ...WAVESCULPT_VOICES.map((v, i) => ({
    id: (['red', 'grn', 'blu', 'alp'] as const)[i]!,
    label: v.label,
    ports: v.outPort,
    voice: i,
  })),
];

/**
 * The hero panel's caption for one tap choice.
 *
 * ⚠ THE MIX AND VOICE CAPTIONS CAN NEVER BE EQUAL — asserted in the test file,
 * because that is what makes the panel's operability probe non-vacuous. The
 * parity sweep clicks a tap chip and demands this string change; if two chips
 * could ever render the same caption the probe would be a coin flip.
 */
export function wavesculptTapCaption(cam: WavesculptCamera, tap: WavesculptTap): string {
  const gains = wavesculptVoiceGains(cam);
  const choice = WAVESCULPT_TAPS.find((t) => t.id === tap) ?? WAVESCULPT_TAPS[0]!;
  if (choice.voice === null) {
    const live = wavesculptLiveCount(gains);
    return `MIX · L + R · post master gain · ${live} of ${gains.length} voices in it`;
  }
  const v = WAVESCULPT_VOICES[choice.voice]!;
  const g = gains[choice.voice]!;
  return `${v.label} · ${v.outPort} · pre master gain · ${v.wall} · ${wavesculptGainText(g)}`;
}

/** `x +0.00  z +0.00  · eye +0.00, +2.50` — the camera, stated in both the
 *  knob space you drag in and the room space the gains are computed in, which
 *  are different numbers and have never been shown together. */
export function wavesculptCameraCaption(cam: WavesculptCamera): string {
  const eye = wavesculptEye(cam);
  const f = (v: number): string => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(2);
  return `x ${f(cam.pos_x)}  z ${f(cam.pos_z)}  ·  eye ${f(eye[0])}, ${f(eye[2])}`;
}
