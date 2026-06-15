// packages/web/src/lib/ui/rack-sizes.ts
//
// Rack classification for every registered card-bearing module.
//
// Each module type maps to a rack `size` tier ('1u' | '3u') and an `hp` width
// (in 1u = 180px square tiles). A module is `hp` tiles wide × (1u | 3u) tall,
// snapping to the uniform 3u-slot grid.
//
// ── These values are MEASURED, not estimated ──
// The inline `HxWpx` comment on each line is the card's NATURAL rendered size
// (offsetHeight×offsetWidth, the SvelteFlow zoom-independent layout box) captured
// by the measurement probe (.myrobots/plans/rack-measure.probe.ts.txt).
//   size = '1u' if natural height ≤ 180px (the --rack-unit tile), else '3u'
//   hp   = round(natural width / 180), min 1
// [LOCKED] = a user-decided tier override applied verbatim regardless of the
//   measurement (DECISIONS §2 + the 2026-06-13 preview pass; scope→3u w/ bigger
//   screen, drummergirl→1u, charlottesEchos→1u). Cards whose content exceeds
//   their tier are compacted per-card (see rack-sizing-CAMPAIGN-2026-06-13.md).
//
// PRECEDENCE: a def that declares `size`/`hp` OVERRIDES this map (see
// Canvas.svelte rackSizeByType + rack-sizing.test.ts). This map is the bulk
// fallback; new modules should declare size/hp on the def.

import type { RackSize } from '$lib/graph/types';

export const RACK_SIZE_DEFAULTS: Record<string, { size: RackSize; hp: number }> = {
  // ── audio domain ──
  adsr: { size: '1u', hp: 2 }, // 154×240px  [LOCKED]
  analogLogicMaths: { size: '1u', hp: 2 }, // 154×220px
  analogVco: { size: '3u', hp: 2 }, // 225×240px  [LOCKED]
  aquaTank: { size: '2u', hp: 2 }, // 273×320px
  atlantisCatalyst: { size: '2u', hp: 2 }, // 261×360px
  attenumix: { size: '1u', hp: 2 }, // 158×300px
  audioIn: { size: '2u', hp: 1 }, // 241×200px
  audioOut: { size: '1u', hp: 1 }, // 200×180px  [LOCKED]
  bluebox: { size: '2u', hp: 2 }, // 360×280px
  buggles: { size: '1u', hp: 2 }, // 156×280px
  callsine: { size: '1u', hp: 2 }, // 196×340px
  cartesian: { size: '4u', hp: 2 }, // 563×360px
  charlottesEchos: { size: '1u', hp: 2 }, // 109×320px  [LOCKED]
  chowkick: { size: '5u', hp: 3 }, // 839×540px
  clouds: { size: '2u', hp: 2 }, // 201×340px
  cloudseed: { size: '3u', hp: 4 }, // 427×680px
  cocoadelay: { size: '2u', hp: 4 }, // 283×620px
  cube: { size: '3u', hp: 4 }, // 540×720px — 2-col (viewport+sources left, controls right)
  delay: { size: '1u', hp: 1 }, // 152×200px
  depolarizer: { size: '1u', hp: 1 }, // 160×150px (tiny 1-in/1-out bipolar→unipolar CV util)
  destroy: { size: '1u', hp: 2 }, // 152×220px
  drummergirl: { size: '1u', hp: 2 }, // 152×320px  [LOCKED]
  drumseqz: { size: '4u', hp: 5 }, // 604×820px
  dx7: { size: '2u', hp: 2 }, // 326×320px
  elements: { size: '2u', hp: 3 }, // 298×460px
  filter: { size: '1u', hp: 1 }, // 180×200px  [LOCKED]
  flipper: { size: '1u', hp: 1 }, // 90×176px
  fourplexer: { size: '1u', hp: 2 }, // 158×320px
  foxy: { size: '4u', hp: 4 }, // 575×720px
  // NOTE: user-resizable cards (clockedRunner, livecode, wavesculpt, b3ntb0x,
  // bentbox, monoglitch, reshaper, ruttetra, toybox, videobox, videoOut,
  // archivist) are intentionally ABSENT from this map — they are sized by their
  // own corner-resize (snapped to whole-u via card-resize.ts), not a fixed
  // tier, so the rack CSS must NOT clamp them. They live in rack-sizing.test.ts
  // DYNAMIC_SIZED. Their DEFAULT/MIN constants are rounded to 180-multiples so
  // they still land on-grid out of the box. (backdraft was promoted to a FIXED
  // 3u/hp4 tier in #767 and now lives in this map, not the resizable set.)
  frogger: { size: '2u', hp: 2 }, // 380×260px
  gamepad: { size: '2u', hp: 2 }, // 267×280px
  gatemaiden: { size: '1u', hp: 1 }, // 199×200px
  grids: { size: '3u', hp: 2 }, // 463×320px
  helm: { size: '3u', hp: 4 }, // 536×720px
  hydrogen: { size: '4u', hp: 4 }, // 687×660px
  hypercube: { size: '3u', hp: 4 }, // 540×720px — 2-col (viewport left, controls right)
  illogic: { size: '1u', hp: 2 }, // 154×240px
  joystick: { size: '2u', hp: 2 }, // 234×220px
  lfo: { size: '1u', hp: 2 }, // 180×360px — Rate/Shape faders + Depth knob in one row
  macrooscillator: { size: '1u', hp: 2 }, // 187×320px
  macseq: { size: '2u', hp: 5 }, // 282×880px
  marbles: { size: '1u', hp: 3 }, // 199×420px
  meowbox: { size: '1u', hp: 2 }, // 127×240px
  midiclock: { size: '1u', hp: 1 }, // 136×200px
  midiCvBuddy: { size: '1u', hp: 2 }, // 136×220px
  midiLane: { size: '3u', hp: 2 }, // 149×230px  [LOCKED]
  midiOutBuddy: { size: '1u', hp: 2 }, // 136×220px
  mixer: { size: '1u', hp: 2 }, // 150×260px  [LOCKED]
  mixmstrs: { size: '4u', hp: 4 }, // 661×720px
  modtris: { size: '3u', hp: 2 }, // 424×260px
  moog902: { size: '1u', hp: 2 }, // 152×236px
  moog903a: { size: '1u', hp: 1 }, // 124×180px
  moog904a: { size: '1u', hp: 2 }, // 152×236px
  moog904b: { size: '1u', hp: 2 }, // 152×236px
  moog904c: { size: '1u', hp: 2 }, // 124×220px
  moog905: { size: '1u', hp: 2 }, // 124×220px
  moog907a: { size: '4u', hp: 1 }, // 655×200px
  moog911: { size: '1u', hp: 2 }, // 187×232px
  moog911a: { size: '1u', hp: 1 }, // 137×200px
  moog912: { size: '1u', hp: 1 }, // 124×200px
  moog914: { size: '5u', hp: 1 }, // 891×200px
  moog921a: { size: '1u', hp: 2 }, // 152×236px
  moog921b: { size: '2u', hp: 2 }, // 214×252px
  moog921Vco: { size: '2u', hp: 2 }, // 214×252px
  moog923: { size: '1u', hp: 2 }, // 124×220px
  moog956: { size: '1u', hp: 2 }, // 174×240px
  moog960: { size: '3u', hp: 3 }, // 385×520px
  moog961: { size: '1u', hp: 2 }, // 124×220px
  moog962: { size: '1u', hp: 1 }, // 124×200px
  moog984: { size: '2u', hp: 2 }, // 313×300px
  moog992: { size: '1u', hp: 2 }, // 124×220px
  moog993: { size: '1u', hp: 2 }, // 124×220px
  moog994: { size: '1u', hp: 1 }, // 61×180px
  moog995: { size: '1u', hp: 1 }, // 124×200px
  moogCp3: { size: '1u', hp: 2 }, // 187×264px
  negativity: { size: '1u', hp: 1 }, // 160×150px (tiny 1-in/1-out CV inverter, no knob)
  noise: { size: '1u', hp: 1 }, // 154×160px
  numpadPlus: { size: '4u', hp: 4 }, // 714×722px
  peaks: { size: '3u', hp: 2 }, // 197×320px  [LOCKED]
  pentemelodica: { size: '3u', hp: 7 }, // 462×1180px
  polarizer: { size: '1u', hp: 1 }, // 160×150px (tiny 1-in/1-out unipolar→bipolar CV util)
  polyhelm: { size: '3u', hp: 4 }, // 536×720px
  polyseqz: { size: '2u', hp: 3 }, // 321×540px
  pong: { size: '2u', hp: 2 }, // 304×240px
  qbrt: { size: '1u', hp: 2 }, // 152×280px
  rasterize: { size: '2u', hp: 2 }, // 330×320px
  resofilter: { size: '1u', hp: 2 }, // 156×340px  [LOCKED]
  reverb: { size: '1u', hp: 1 }, // 152×200px
  ringback: { size: '1u', hp: 2 }, // 123×240px
  rings: { size: '1u', hp: 2 }, // 199×360px
  riotgirls: { size: '5u', hp: 6 }, // 849×1100px
  sampleHold: { size: '1u', hp: 2 }, // 149×260px
  samsloop: { size: '3u', hp: 2 }, // 420×360px
  scaler: { size: '1u', hp: 1 }, // 160×150px (tiny 1-in/1-out 1-knob multiplier)
  scope: { size: '3u', hp: 2 }, // 500×320px  [LOCKED]
  score: { size: '4u', hp: 4 }, // 597×720px
  sequencer: { size: '3u', hp: 3 }, // 307×540px  [LOCKED]
  shimmershine: { size: '1u', hp: 2 }, // 152×280px
  sidecar: { size: '2u', hp: 2 }, // 299×380px
  skifree: { size: '3u', hp: 2 }, // 420×360px
  slewSwitch: { size: '2u', hp: 2 }, // 273×320px
  stages: { size: '2u', hp: 3 }, // 302×460px
  stereovca: { size: '1u', hp: 1 }, // 156×180px
  swolevco: { size: '2u', hp: 2 }, // 262×360px
  symbiote: { size: '1u', hp: 3 }, // 199×440px
  synesthesia: { size: '3u', hp: 2 }, // 540×360 — was 3hp, trimmed empty right margin
  tides2: { size: '2u', hp: 2 }, // 221×380px
  timelorde: { size: '3u', hp: 2 }, // 152×280px  [LOCKED]
  treeohvox: { size: '2u', hp: 2 }, // 240×340px
  twotracks: { size: '3u', hp: 4 }, // 406×580px
  unityscalemathematik: { size: '3u', hp: 2 }, // 446×240px
  vca: { size: '1u', hp: 1 }, // 156×160px
  veils: { size: '1u', hp: 2 }, // 179×280px
  warps: { size: '1u', hp: 2 }, // 187×320px
  warrenspectrum: { size: '3u', hp: 3 }, // 481×440px
  wavecel: { size: '3u', hp: 2 }, // 398×320px
  wavetableVco: { size: '1u', hp: 2 }, // 152×240px
  writeseq: { size: '2u', hp: 5 }, // 261×880px

  // ── meta domain ──
  electraControl: { size: '3u', hp: 2 }, // 519×360px

  // ── video domain ──
  '4plexvid': { size: '3u', hp: 2 }, // 463×280px
  acidwarp: { size: '3u', hp: 2 }, // 407×380px
  backdraft: { size: '3u', hp: 4 }, // 720px wide — 2-col (preview left, controls right)  [LOCKED]
  cameraInput: { size: '3u', hp: 2 }, // 370×280px  [LOCKED]
  cellshade: { size: '2u', hp: 2 }, // 369×220px
  chroma: { size: '2u', hp: 2 }, // 360×260px
  chromakey: { size: '3u', hp: 2 }, // 389×260px
  colorizer: { size: '2u', hp: 2 }, // 270×240px
  destructor: { size: '1u', hp: 2 }, // 180×360px — 4 knobs in one row
  doom: { size: '2u', hp: 2 }, // 377×360px
  edges: { size: '1u', hp: 2 }, // 180×360px — 2 faders one row beside handles
  feedback: { size: '3u', hp: 2 }, // 411×320px
  freezeframe: { size: '3u', hp: 2 }, // ~470×260px — enlarged preview fills the body
  gibribbon: { size: '3u', hp: 5 }, // 398×836px
  inwards: { size: '2u', hp: 2 }, // 280×220px
  lines: { size: '2u', hp: 2 }, // 361×220px
  luma: { size: '2u', hp: 2 }, // 275×220px
  lumakey: { size: '2u', hp: 2 }, // 287×220px
  mandelbulb: { size: '2u', hp: 2 }, // 362×280px
  mandleblot: { size: '2u', hp: 2 }, // 360×280px
  mapper: { size: '2u', hp: 1 }, // 250×200px
  nibbles: { size: '2u', hp: 2 }, // 367×380px
  outlines: { size: '3u', hp: 2 }, // 420×260px
  peakstate: { size: '2u', hp: 2 }, // 329×240px
  picturebox: { size: '2u', hp: 2 }, // 240×220px
  qbert: { size: '2u', hp: 2 }, // 326×340px
  quadralogical: { size: '3u', hp: 4 }, // 540×720px — 2-col (joystick left, preview+edges right)
  recorderbox: { size: '2u', hp: 2 }, // 296×248px
  scoreboard: { size: '1u', hp: 2 }, // 240×260px  [LOCKED]
  shapedramps: { size: '4u', hp: 2 }, // 641×240px
  shapegen: { size: '2u', hp: 2 }, // 304×300px
  shapes: { size: '2u', hp: 2 }, // 320×220px
  snes9x: { size: '2u', hp: 3 }, // 380×442px
  vdelay: { size: '3u', hp: 2 }, // 431×220px
  vfpgaRunner: { size: '3u', hp: 3 }, // 467×420px
  videoMixer: { size: '1u', hp: 2 }, // 180×280px — 4 channel faders in one row  [LOCKED]
  videovarispeed: { size: '3u', hp: 2 }, // 452×320px
};
