// packages/web/src/lib/ui/modules/cube-face-model.ts
//
// The PURE derivations behind cube's faceplate — every readout the face prints
// and every number in the hero caption, computed the way the DSP computes them
// rather than read back off the nearest knob.
//
// ⚠ THE ONE FACT THIS FILE EXISTS FOR. cube's `slice_y` is a REAL control that
// is INERT IN EXACTLY ONE STATE — the state it spawns in. `rayDepth` integrates
// over a fixed ±√3/2 window CENTRED ON THE RAY ORIGIN, so sliding the plane
// along its own normal moves the window and its contents together and is very
// nearly a no-op; at spawn the plane's normal IS the z axis and `slice_y`
// translates along z. Tilt the plane and Y stops being a normal-translation.
// Measured on the shipped default tables (basic-shapes / pwm-sweep /
// harmonic-sweep), max rmsΔ over the whole of y:
//
//     rx 0.000  ry 0.000   0.11467   ← THE SPAWN STATE
//     rx 0.400  ry 0.000   0.31693
//     rx 0.800  ry 0.000   0.75874   ← 6.6× the spawn figure
//     rx 0.000  ry 1.571   0.51731
//
// A `paramId: 'slice_y'` readout prints `0.50` in every one of those rows. It
// is BLIND to the whole finding by construction. `cubeYLiveText` is not: it
// reads the plane's ORIENTATION and says whether Y is doing anything. That is
// the difference between a readout and a relabelled knob, and it is the reason
// `cube-y-live` is negative-controlled on `slice_rx` (a param the printed value
// must move with) in cube-face-model.test.ts on every run.
//
// PURE — no DOM, no engine, no store. The wave-derived half takes a rendered
// Float32Array so the caller decides where the wave came from (the panel
// renders one through the REAL `sampleSlice`, which is 0.56 ms).

import {
  CUBE_SPREAD_DEPTH,
  FOLD_MAX_DRIVE,
  applyFold,
  crushLevels,
  rotate,
  sampleSlice,
  spreadDepthOffset,
  type Material,
  type SliceParams,
} from '../../../../../dsp/src/lib/cube-dsp';

/** Every param the face's derivations read, resolved through the caller's
 *  reader (which already falls back to the def default for untouched params). */
export interface CubeFaceParams {
  sliceY: number;
  rx: number;
  ry: number;
  rz: number;
  morphFC: number;
  connect: number;
  connectStrength: number;
  crush: number;
  spaceCrush: number;
  spaceDiffuse: number;
  fold: number;
  spread: number;
  wrap: number;
  material: number;
  tune: number;
  fine: number;
  level: number;
  viewZoom: number;
  viewRotX: number;
  viewRotY: number;
}

/** The def's defaults, mirrored ONLY as the reader's last resort. Every caller
 *  passes a reader that resolves the real ParamDef default first. */
const FALLBACK: CubeFaceParams = {
  sliceY: 0.5, rx: 0, ry: 0, rz: 0,
  morphFC: 0, connect: 0, connectStrength: 0,
  crush: 0, spaceCrush: 0, spaceDiffuse: 0,
  fold: 0, spread: 0, wrap: 0, material: 0,
  tune: 0, fine: 0, level: 1,
  viewZoom: 1, viewRotX: 0.6, viewRotY: 0.7,
};

export function cubeFaceParams(read: (id: string) => number | undefined): CubeFaceParams {
  const n = (id: string, fb: number): number => {
    const v = read(id);
    return typeof v === 'number' && Number.isFinite(v) ? v : fb;
  };
  return {
    sliceY: n('slice_y', FALLBACK.sliceY),
    rx: n('slice_rx', FALLBACK.rx),
    ry: n('slice_ry', FALLBACK.ry),
    rz: n('slice_rz', FALLBACK.rz),
    morphFC: n('morph_fc', FALLBACK.morphFC),
    connect: n('connect', FALLBACK.connect),
    connectStrength: n('connect_strength', FALLBACK.connectStrength),
    crush: n('crush', FALLBACK.crush),
    spaceCrush: n('space_crush', FALLBACK.spaceCrush),
    spaceDiffuse: n('space_diffuse', FALLBACK.spaceDiffuse),
    fold: n('fold', FALLBACK.fold),
    spread: n('spread', FALLBACK.spread),
    wrap: n('wrap', FALLBACK.wrap),
    material: n('material', FALLBACK.material),
    tune: n('tune', FALLBACK.tune),
    fine: n('fine', FALLBACK.fine),
    level: n('level', FALLBACK.level),
    viewZoom: n('view_zoom', FALLBACK.viewZoom),
    viewRotX: n('view_rot_x', FALLBACK.viewRotX),
    viewRotY: n('view_rot_y', FALLBACK.viewRotY),
  };
}

/** The `SliceParams` the DSP would run at these knob positions. */
export function cubeSliceParams(p: CubeFaceParams): SliceParams {
  return {
    sliceY: p.sliceY, rx: p.rx, ry: p.ry, rz: p.rz,
    morphFC: p.morphFC, connect: p.connect, connectStrength: p.connectStrength,
    crush: p.crush, spaceCrush: p.spaceCrush, spaceDiffuse: p.spaceDiffuse,
    material: (p.material >= 0.5 ? 'hard' : 'smooth') as Material,
    wrap: p.wrap >= 0.5,
  };
}

// ── THE CUT ────────────────────────────────────────────────────────────────

/** Below this the plane counts as FLAT — Y slides along the plane's own normal
 *  and the ray window slides with it. Not a taste threshold: at 0.5° the
 *  normal's z component is 0.99996, i.e. Y is still a normal-translation to
 *  four decimal places. */
export const CUBE_FLAT_TILT_DEG = 0.5;

/**
 * How far the slicing plane's NORMAL has tilted off +z, in degrees. This is the
 * quantity `slice_y`'s authority depends on — not any one rotation knob.
 *
 * ⚠ ALL THREE ANGLES FEED IT AND ONLY TWO CAN MOVE IT, which is the point.
 * `rotate(0,0,1, 0,0,rz)` is the IDENTITY — a Z rotation cannot move a vector
 * lying on the Z axis — so ROT Z spins the scan line INSIDE the plane and never
 * tilts it. Measured: Y's authority is 0.115 at rz 0, 0.117 at rz 0.8 and 0.132
 * at rz 1.5, against 0.759 once ROT X moves. A readout that watched "did a
 * rotation knob move" would print `live` on the module's #2 control and be
 * wrong; this one reads the geometry, and both directions are permanent legs in
 * cube-face-model.test.ts.
 */
export function cubeCutTiltDeg(p: CubeFaceParams): number {
  const [, , nz] = rotate(0, 0, 1, p.rx, p.ry, p.rz);
  const c = nz < -1 ? -1 : nz > 1 ? 1 : nz;
  // The plane is unoriented: a normal at 170° cuts the same way as one at 10°.
  return (Math.acos(Math.abs(c)) * 180) / Math.PI;
}

export function cubeCutTiltText(p: CubeFaceParams): string {
  const deg = cubeCutTiltDeg(p);
  return deg < CUBE_FLAT_TILT_DEG ? 'flat · z' : `${deg.toFixed(0)}° tilted`;
}

/**
 * Is `slice_y` DOING anything at this plane orientation?
 *
 * ⚠ THE READOUT THE MODULE HAS NEVER HAD. cube's default state hides its own
 * strongest interaction: at spawn Y is a 0.115 control, and one nudge of ROT X
 * makes it a 0.759 one. Nothing on the card said so, and a knob readback cannot
 * — it prints 0.50 either way.
 */
export function cubeYLiveText(p: CubeFaceParams): string {
  return cubeCutTiltDeg(p) < CUBE_FLAT_TILT_DEG ? 'asleep — plane is flat' : 'live';
}

// ── GRAIN ──────────────────────────────────────────────────────────────────

/**
 * How many amplitude levels CRUSH leaves.
 *
 * ⚠ THE FLOOR IS THE INTERESTING PART. `crushLevels` used to bottom out at 2,
 * where every depth rounds to level 0 and the output is a constant −1: a
 * full-scale DC step, `acRms` exactly 0.000000, inaudible, and INVISIBLE to the
 * old all-zero silence guard. That is fixed in the DSP (the floor is 4, and the
 * guard is now `isDegenerateWave`), so this readout prints an honest number all
 * the way to the stop — measured `acRms 0.552771` at `crush = 1`. It is here
 * anyway because the knob's top 0.8 % is a flat detent and a `paramId: 'crush'`
 * readout shows a value still climbing while the sound has stopped changing.
 */
export function cubeCrushLevelsText(p: CubeFaceParams): string {
  return `${crushLevels(p.crush)}`;
}

/** SPREAD's real depth offset, as a percentage of the march window.
 *  ⚠ IMPORTS `CUBE_SPREAD_DEPTH` — the def's own prose said ±5 % in five places
 *  while the constant has always been 0.18, so re-typing the number here is
 *  precisely how that got to five places. */
export function cubeSpreadDepthText(p: CubeFaceParams): string {
  return `±${(spreadDepthOffset(p.spread, 1) * 100).toFixed(1)} %`;
}

/** The wavefolder's gain, `1 + fold · FOLD_MAX_DRIVE`. */
export function cubeFoldDriveText(p: CubeFaceParams): string {
  const k = p.fold < 0 ? 0 : p.fold > 1 ? 1 : p.fold;
  return `${(1 + k * FOLD_MAX_DRIVE).toFixed(1)}×`;
}

// ── PITCH ──────────────────────────────────────────────────────────────────

export const CUBE_C4_HZ = 261.626;
const NYQUIST_HZ = 24000;

/** The fundamental the KNOBS ask for. */
export function cubeKnobHz(p: CubeFaceParams): number {
  const hz = CUBE_C4_HZ * Math.pow(2, p.tune / 12 + p.fine / 1200);
  return hz < 1 ? 1 : hz > NYQUIST_HZ ? NYQUIST_HZ : hz;
}

/**
 * ⚠ LABELLED "knobs" ON THE FACE, DELIBERATELY. This is structurally blind to
 * the V/oct input, which is a PORT and not a param — a `valueId` readout is a
 * pure function of params and can never see a cable. Printing it unqualified
 * would be the kick-drum-TAIL trap: a number that moves when you turn the knob,
 * reads correct, and is wrong the moment the module is played.
 */
export function cubeF0Text(p: CubeFaceParams): string {
  const hz = cubeKnobHz(p);
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz.toFixed(1)} Hz`;
}

/**
 * How many harmonics of the knob fundamental fit under Nyquist.
 *
 * cube is a plain wavetable oscillator with NO band-limiting — the 256-sample
 * slice is replayed by a bare phase accumulator — so above a few hundred Hz the
 * upper partials fold back as aliasing. This number is how close the module is
 * to that, and there is no knob for it.
 */
export function cubeHarmonicsText(p: CubeFaceParams): string {
  const n = Math.floor(NYQUIST_HZ / cubeKnobHz(p));
  return n <= 1 ? '1 — at Nyquist' : `${n}`;
}

// ── THE CAMERA (hero) ──────────────────────────────────────────────────────

/** The orbit angles, in degrees, plus the zoom. The hero's drag-to-orbit
 *  witness: a dead drag cannot move this text. */
export function cubeCamText(p: CubeFaceParams): string {
  const d = (r: number) => Math.round((r * 180) / Math.PI);
  return `${d(p.viewRotX)}° · ${d(p.viewRotY)}° · ${p.viewZoom.toFixed(2)}×`;
}

// ── THE WAVE (hero caption) ────────────────────────────────────────────────

export interface CubeWaveStats {
  /** Mean depth as a percentage — how much SOLID the plane cut through. */
  solidPct: number;
  /** The wave's DC offset. */
  dc: number;
  /** Its AC content — the part that is audible. */
  acRms: number;
  /** Distinct sample values: the instrument that SEES `material`. */
  levels: number;
  /** Sign changes of the first difference: the instrument that sees detail. */
  turns: number;
}

export function cubeWaveStats(wave: Float32Array): CubeWaveStats {
  const n = wave.length;
  if (n === 0) return { solidPct: 0, dc: 0, acRms: 0, levels: 0, turns: 0 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += wave[i] ?? 0;
  const dc = sum / n;
  let ac = 0;
  const uniq = new Set<number>();
  for (let i = 0; i < n; i++) {
    const v = wave[i] ?? 0;
    ac += (v - dc) * (v - dc);
    uniq.add(Math.round(v * 1e6));
  }
  let turns = 0;
  let prev = 0;
  for (let i = 1; i < n; i++) {
    const d = (wave[i] ?? 0) - (wave[i - 1] ?? 0);
    const s = d > 1e-9 ? 1 : d < -1e-9 ? -1 : 0;
    if (s !== 0 && prev !== 0 && s !== prev) turns++;
    if (s !== 0) prev = s;
  }
  return {
    solidPct: ((dc + 1) / 2) * 100,
    dc,
    acRms: Math.sqrt(ac / n),
    levels: uniq.size,
    turns,
  };
}

/**
 * The hero caption.
 *
 * ⚠ ALL THREE NUMBERS ARE THINGS NO KNOB ON THIS MODULE SHOWS, and the DC one
 * is a fact about the OUTPUT PORTS. `out[n] = depth·2 − 1` with a spawn mean
 * depth of ~0.26, so the wave sits at −0.472 and |DC| is 1.06× the audio —
 * cube's L and R carry more DC than signal. WRAP is the only control that
 * re-centres it (|DC|/audio 1.06 → 0.07, measured), which is most of the
 * argument for WRAP being in the lane.
 *
 * `levels` is here because RMS is the WRONG INSTRUMENT for MATERIAL: SMOOTH →
 * HARD is rmsΔ 0.040, dead last of thirteen, while the distinct-value count
 * goes 180 → 28. A face that ranked by RMS alone would bury a control that
 * halves the waveform's structure.
 */
export function cubeHeroCaption(s: CubeWaveStats): string {
  const ratio = s.acRms > 1e-9 ? Math.abs(s.dc) / s.acRms : Infinity;
  const dcPart = Number.isFinite(ratio)
    ? `DC ${s.dc.toFixed(3)} (${ratio.toFixed(2)}× the audio)`
    : `DC ${s.dc.toFixed(3)} — NO audio`;
  return `solid ${s.solidPct.toFixed(1)} %   ${dcPart}   ${s.levels} levels · ${s.turns} turns`;
}

/**
 * Render the wave the hero describes — the REAL `sampleSlice` at the live knob
 * positions, folded exactly as `renderAndPostSlice` folds it.
 *
 * ⚠ NOT THE ENGINE SNAPSHOT, and that is a capability rather than a
 * compromise. The factory only posts a snapshot once the worklet has ticked, so
 * a suspended graph (every VRT face capture) has none — the caption would read
 * `—` in exactly the frames a baseline is taken. This runs the same pure
 * function the factory runs, measured at 0.56 ms for the full 256-ray scan.
 */
export function cubeHeroWave(
  p: CubeFaceParams,
  floorFrames: readonly Float32Array[],
  wallFrames: readonly Float32Array[],
  ceilFrames: readonly Float32Array[],
): Float32Array {
  const wave = sampleSlice(floorFrames, wallFrames, ceilFrames, cubeSliceParams(p), 0);
  applyFold(wave, p.fold);
  return wave;
}

/**
 * A signature over EXACTLY the params the hero wave is a function of.
 *
 * ⚠ THIS IS A PERFORMANCE CORRECTNESS FIELD, and the measurement is the reason
 * it exists. `cubeHeroWave` costs 1.421 ms (256 rays × 96 steps, measured), and
 * the panel's `$derived` chain re-runs on every node-version bump — ~60 a
 * second during any drag. Keyed on the node, that is 85 ms/s of main thread,
 * and it is spent on drags that CANNOT change the answer: LEVEL, the ADSR, the
 * pitch knobs, and above all the CAMERA, because this face's own hero affordance
 * is drag-to-orbit writing `view_rot_x/y` at pointer rate. Orbiting the picture
 * would have recomputed the audio wave sixty times a second for nothing.
 *
 * ⚠ IT IS DERIVED FROM `cubeSliceParams`, NOT HAND-LISTED. A hand-listed
 * signature is a second copy of "what the wave reads" that goes stale silently:
 * add a field to `SliceParams`, forget it here, and the caption FREEZES on that
 * field with every gate green. Enumerating the object's own keys means a new
 * field is covered the moment it exists. `fold` is appended because
 * `applyFold` runs after the scan and is not part of `SliceParams`.
 *
 * Both directions are permanent legs in cube-face-model.test.ts: invariant to
 * every param the wave does not read, and moving on every param it does.
 */
export function cubeWaveSignature(p: CubeFaceParams): string {
  const s = cubeSliceParams(p) as unknown as Record<string, unknown>;
  const parts = Object.keys(s)
    .sort()
    .map((k) => `${k}=${String(s[k])}`);
  parts.push(`fold=${p.fold}`);
  return parts.join('|');
}

/** The L/R depth offsets SPREAD commands, for the panel's own annotation. */
export function cubeSpreadOffsets(p: CubeFaceParams): [number, number] {
  return [spreadDepthOffset(p.spread, -1), spreadDepthOffset(p.spread, 1)];
}
