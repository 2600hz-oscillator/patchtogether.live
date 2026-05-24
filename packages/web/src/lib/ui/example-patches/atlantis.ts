// packages/web/src/lib/ui/example-patches/atlantis.ts
//
// "Visit Atlantis" — generative demo patch inspired by Barry Schrader's
// Atlantis Patch (large self-evolving analog-modular system). Loaded by
// Canvas.svelte's `loadAtlantis()` action wired up to the topbar
// "Visit Atlantis" button.
//
// Architecture (left → right):
//   1. CLOCK + SCENECHANGE + 2× BUGGLES — the modulation/scene brain
//   2. STAGES + UNI + ALM — CV-math fan-out
//   3. SLEWSWITCH — routes BUGGLES through 4 rotating destinations
//   4. SWOLEVCO + MACROOSCILLATOR + RINGS×2 + NOISE — voice bank
//   5. WARRENSPECTRUM — 8-band pingable filter (the metallic chimes)
//   6. AQUATANK — 4-channel Hadamard FDN (cross-coupled feedback)
//   7. VEILS + BLADES + CLOUDS + SHIMMERSHINE + CLOUDSEED — texture stack
//   8. AUDIOOUT
//
// Listener experience on load: SCENECHANGE starts auto-drifting immediately
// (autoMode=1, drift period ~20-30s); BUGGLES bursts hit WARRENSPECTRUM
// ping ports → AQUATANK matrix sprays metallic resonance; SCENECHANGE scene
// changes nudge every voice's character every ~25s; CLOUDS + CLOUDSEED's
// DARK_PLATE (DIVINE INSPIRATION) preset hold the room sound.

export interface AtlantisNode {
  type: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

export type AtlantisCableType = 'audio' | 'cv' | 'gate' | 'pitch';

export interface AtlantisWire {
  src: string;
  srcPort: string;
  dst: string;
  dstPort: string;
  cable: AtlantisCableType;
}

export const ATLANTIS_NODES: Record<string, AtlantisNode> = {
  // ───────── Clocks + catalyst brain (left column) ─────────
  'at-clock':  { type: 'timelorde',         position: { x: 40,  y: 40  }, params: { bpm: 54, swingAmount: 18 } },
  'at-cat':    { type: 'atlantisCatalyst',  position: { x: 40,  y: 260 }, params: { driftRate: 0.18, chaos: 0.5, coherence: 0.55, sceneDepth: 0.7, autoMode: 1, level: 1 } },
  'at-bug1':   { type: 'buggles',           position: { x: 40,  y: 620 }, params: { rate: 0.25, chaos: 0.4 } },
  'at-bug2':   { type: 'buggles',           position: { x: 40,  y: 860 }, params: { rate: 0.55, chaos: 0.7 } },

  // ───────── CV math fan-out (left-middle) ─────────
  'at-stages': { type: 'stages',            position: { x: 320, y: 760 }, params: { primary0: 0.7, primary1: 0.4, primary2: 0.9, shape0: 0.6, shape1: 0.5, shape2: 0.7 } },
  'at-uni':    { type: 'unityscalemathematik', position: { x: 320, y: 40  }, params: { unityAtten: 0.6, aAtten: 0.7, aCurve: 0.4, bAtten: -0.5, bCurve: 0.6 } },
  'at-alm':    { type: 'analogLogicMaths',  position: { x: 320, y: 260 }, params: { attA: 0.7, attB: 0.6 } },
  'at-slew':   { type: 'slewSwitch',        position: { x: 320, y: 480 }, params: { slew1: 1.2, slew2: 0.6, slew3: 2.0, slew4: 0.3, mode: 0, length: 4, xfadeTime: 0.4 } },

  // ───────── Voices (middle) ─────────
  'at-swole':  { type: 'swolevco',          position: { x: 620, y: 40  }, params: { tune: -12, fine: 0, mod_tune: 7, ratio: 1.51, timbre: 0.35, symmetry: 0.6, fold: 0.3 } },
  'at-macro':  { type: 'macrooscillator',   position: { x: 620, y: 320 }, params: { model: 6, note: -19, harmonics: 0.6, timbre: 0.45, morph: 0.7, level: 0.6 } },
  'at-rings1': { type: 'rings',             position: { x: 620, y: 560 }, params: { model: 1, note: -12, structure: 0.55, brightness: 0.4, damping: 0.85, position: 0.35, level: 0.8 } },
  'at-rings2': { type: 'rings',             position: { x: 620, y: 800 }, params: { model: 0, note: 7,   structure: 0.7,  brightness: 0.55, damping: 0.7,  position: 0.6,  level: 0.7 } },
  'at-noise':  { type: 'noise',             position: { x: 620, y: 1040 }, params: { level: 0.5 } },

  // ───────── Filter bank + tank (middle-right) ─────────
  'at-warren': { type: 'warrenspectrum',    position: { x: 920, y: 40  }, params: { root: 48, q: 18, spread: 0.6, ping_decay: 0.7, master: 0.9 } },
  'at-aqua':   { type: 'aquaTank',          position: { x: 920, y: 520 }, params: { fb1: 0.55, fb2: 0.6, fb3: 0.45, fb4: 0.5, tilt: 0.1, damp: 0.35, crossMix: 0.7, spread: 0.85, outLevel: 0.6 } },
  'at-blades': { type: 'blades',            position: { x: 920, y: 820 }, params: { cutoff1: 240, cutoff2: 1400, res1: 0.55, res2: 0.7, mode1: 1, mode2: 2, color: 0.35, mixMode: 1 } },

  // ───────── VCA strip ─────────
  'at-veils':  { type: 'veils',             position: { x: 920, y: 1080 }, params: { gain1: 0.7, gain2: 0.7, gain3: 0.5, gain4: 0.4 } },

  // ───────── Texture + reverb tail (right column) ─────────
  'at-clouds':    { type: 'clouds',         position: { x: 1240, y: 200 }, params: { position: 0.4, size: 0.65, pitch: -7, density: 0.4, texture: 0.7, blend: 0.6 } },
  'at-shim':      { type: 'shimmershine',   position: { x: 1240, y: 520 }, params: { decay: 0.85, shimmer: 0.55, size: 0.85, damp: 0.5, mix: 0.45 } },
  'at-cloudseed': { type: 'cloudseed',      position: { x: 1240, y: 820 }, params: { preset_index: 0, dry_out: 0.5, late_out: 0.7 } },

  'at-out':    { type: 'audioOut',          position: { x: 1560, y: 540 }, params: { master: 0.5 } },
};

/** All wires for the patch. Source/dest references use AtlantisNode ids. */
export const ATLANTIS_WIRES: readonly AtlantisWire[] = [
  // ───────── Clock distribution ─────────
  { src: 'at-clock', srcPort: '1/8',  dst: 'at-bug1',   dstPort: 'clock_cv',   cable: 'gate' },
  { src: 'at-clock', srcPort: '1/16', dst: 'at-bug2',   dstPort: 'clock_cv',   cable: 'gate' },
  { src: 'at-clock', srcPort: '1/2',  dst: 'at-stages', dstPort: 'trig',       cable: 'gate' },
  { src: 'at-clock', srcPort: '1/4',  dst: 'at-slew',   dstPort: 'step_clock', cable: 'gate' },

  // ───────── SCENECHANGE drift → ecosystem (slow drift through everything) ─────────
  { src: 'at-cat',   srcPort: 'drift1', dst: 'at-warren', dstPort: 'root_cv',     cable: 'cv' },
  { src: 'at-cat',   srcPort: 'drift2', dst: 'at-warren', dstPort: 'spread_cv',   cable: 'cv' },
  { src: 'at-cat',   srcPort: 'drift3', dst: 'at-clouds', dstPort: 'position_cv', cable: 'cv' },
  { src: 'at-cat',   srcPort: 'drift4', dst: 'at-clouds', dstPort: 'density_cv',  cable: 'cv' },
  { src: 'at-cat',   srcPort: 'drift5', dst: 'at-swole',  dstPort: 'timbre',      cable: 'cv' },
  { src: 'at-cat',   srcPort: 'drift6', dst: 'at-aqua',   dstPort: 'tilt_cv',     cable: 'cv' },
  { src: 'at-cat',   srcPort: 'drift7', dst: 'at-shim',   dstPort: 'shimmer_cv',  cable: 'cv' },
  { src: 'at-cat',   srcPort: 'drift8', dst: 'at-blades', dstPort: 'cutoff1_cv',  cable: 'cv' },
  // Scene-pulse → strum RINGS1 → audible cue on every scene change.
  { src: 'at-cat',   srcPort: 'scene_pulse', dst: 'at-rings1', dstPort: 'strum', cable: 'gate' },

  // ───────── BUGGLES → SLEWSWITCH → cross-mod fan-out (routing rotates over time) ─────────
  { src: 'at-bug1',  srcPort: 'stepped', dst: 'at-slew', dstPort: 'in1', cable: 'cv' },
  { src: 'at-bug1',  srcPort: 'smooth',  dst: 'at-slew', dstPort: 'in2', cable: 'cv' },
  { src: 'at-bug2',  srcPort: 'stepped', dst: 'at-slew', dstPort: 'in3', cable: 'cv' },
  { src: 'at-bug2',  srcPort: 'smooth',  dst: 'at-slew', dstPort: 'in4', cable: 'cv' },
  { src: 'at-slew',  srcPort: 'switched', dst: 'at-rings1', dstPort: 'pos_cv',    cable: 'cv' },
  { src: 'at-slew',  srcPort: 'out1',     dst: 'at-rings2', dstPort: 'bright_cv', cable: 'cv' },
  { src: 'at-slew',  srcPort: 'out2',     dst: 'at-swole',  dstPort: 'symmetry',  cable: 'cv' },
  { src: 'at-slew',  srcPort: 'out3',     dst: 'at-macro',  dstPort: 'harm_cv',   cable: 'cv' },
  { src: 'at-slew',  srcPort: 'out4',     dst: 'at-blades', dstPort: 'res1_cv',   cable: 'cv' },
  { src: 'at-slew',  srcPort: 'eoc',      dst: 'at-rings2', dstPort: 'strum',     cable: 'gate' },

  // ───────── BUGGLES bursts → WARRENSPECTRUM pings (metallic chimes — load-bearing) ─────────
  { src: 'at-bug1',  srcPort: 'burst', dst: 'at-warren', dstPort: 'ping3', cable: 'gate' },
  { src: 'at-bug2',  srcPort: 'burst', dst: 'at-warren', dstPort: 'ping6', cable: 'gate' },
  { src: 'at-bug1',  srcPort: 'clock', dst: 'at-warren', dstPort: 'ping1', cable: 'gate' },
  { src: 'at-bug2',  srcPort: 'clock', dst: 'at-warren', dstPort: 'ping8', cable: 'gate' },

  // ───────── STAGES env → UNITYSCALEMATHEMATIK → ALM → modulation taps ─────────
  { src: 'at-stages', srcPort: 'out0', dst: 'at-uni', dstPort: 'a_in', cable: 'cv' },
  { src: 'at-stages', srcPort: 'out2', dst: 'at-uni', dstPort: 'b_in', cable: 'cv' },
  { src: 'at-uni',    srcPort: 'a_out', dst: 'at-alm', dstPort: 'a', cable: 'cv' },
  { src: 'at-uni',    srcPort: 'b_out', dst: 'at-alm', dstPort: 'b', cable: 'cv' },
  { src: 'at-alm',    srcPort: 'product', dst: 'at-aqua',   dstPort: 'fb2_cv',  cable: 'cv' },
  { src: 'at-alm',    srcPort: 'diff',    dst: 'at-clouds', dstPort: 'size_cv', cable: 'cv' },
  { src: 'at-alm',    srcPort: 'max',     dst: 'at-swole',  dstPort: 'fold',    cable: 'cv' },
  { src: 'at-alm',    srcPort: 'min',     dst: 'at-rings1', dstPort: 'damp_cv', cable: 'cv' },

  // ───────── Voices → filter bank ─────────
  { src: 'at-swole',  srcPort: 'out',     dst: 'at-warren', dstPort: 'in_l',     cable: 'audio' },
  { src: 'at-swole',  srcPort: 'mod_out', dst: 'at-warren', dstPort: 'in_r',     cable: 'audio' },
  { src: 'at-macro',  srcPort: 'out',     dst: 'at-warren', dstPort: 'band4_in', cable: 'audio' },
  { src: 'at-noise',  srcPort: 'pink',    dst: 'at-warren', dstPort: 'band7_in', cable: 'audio' },
  { src: 'at-noise',  srcPort: 'brown',   dst: 'at-warren', dstPort: 'band2_in', cable: 'audio' },

  // ───────── Filter bank → AQUATANK (4-channel matrix — the metallic resonance engine) ─────────
  { src: 'at-warren', srcPort: 'band1_out', dst: 'at-aqua', dstPort: 'in1', cable: 'audio' },
  { src: 'at-warren', srcPort: 'band3_out', dst: 'at-aqua', dstPort: 'in2', cable: 'audio' },
  { src: 'at-warren', srcPort: 'band5_out', dst: 'at-aqua', dstPort: 'in3', cable: 'audio' },
  { src: 'at-warren', srcPort: 'band7_out', dst: 'at-aqua', dstPort: 'in4', cable: 'audio' },

  // ───────── AQUATANK out → RINGS for sympathetic resonance (audio-rate cross-mod) ─────────
  { src: 'at-aqua',   srcPort: 'out1', dst: 'at-rings1', dstPort: 'in', cable: 'audio' },
  { src: 'at-aqua',   srcPort: 'out2', dst: 'at-rings2', dstPort: 'in', cable: 'audio' },
  { src: 'at-rings1', srcPort: 'odd',  dst: 'at-veils', dstPort: 'in1', cable: 'audio' },
  { src: 'at-rings1', srcPort: 'even', dst: 'at-veils', dstPort: 'in2', cable: 'audio' },
  { src: 'at-rings2', srcPort: 'odd',  dst: 'at-veils', dstPort: 'in3', cable: 'audio' },
  { src: 'at-rings2', srcPort: 'even', dst: 'at-veils', dstPort: 'in4', cable: 'audio' },
  { src: 'at-veils',  srcPort: 'mix',  dst: 'at-blades', dstPort: 'in1', cable: 'audio' },

  // ───────── Texture + reverb tail ─────────
  { src: 'at-blades', srcPort: 'mix',   dst: 'at-clouds', dstPort: 'in_l', cable: 'audio' },
  { src: 'at-aqua',   srcPort: 'mix_r', dst: 'at-clouds', dstPort: 'in_r', cable: 'audio' },
  { src: 'at-clouds', srcPort: 'out_l', dst: 'at-shim',   dstPort: 'in_l', cable: 'audio' },
  { src: 'at-clouds', srcPort: 'out_r', dst: 'at-shim',   dstPort: 'in_r', cable: 'audio' },
  { src: 'at-aqua',   srcPort: 'mix_l', dst: 'at-cloudseed', dstPort: 'in_l', cable: 'audio' },
  { src: 'at-aqua',   srcPort: 'mix_r', dst: 'at-cloudseed', dstPort: 'in_r', cable: 'audio' },

  // ───────── Master sum into AudioOut ─────────
  { src: 'at-shim',      srcPort: 'out_l', dst: 'at-out', dstPort: 'L', cable: 'audio' },
  { src: 'at-shim',      srcPort: 'out_r', dst: 'at-out', dstPort: 'R', cable: 'audio' },
  { src: 'at-cloudseed', srcPort: 'out_l', dst: 'at-out', dstPort: 'L', cable: 'audio' },
  { src: 'at-cloudseed', srcPort: 'out_r', dst: 'at-out', dstPort: 'R', cable: 'audio' },
];

/** Stable id for the wire entry in the patch graph (mirrors loadExample). */
export function atlantisEdgeId(w: AtlantisWire): string {
  return `e-${w.src}-${w.srcPort}-${w.dst}-${w.dstPort}`;
}
