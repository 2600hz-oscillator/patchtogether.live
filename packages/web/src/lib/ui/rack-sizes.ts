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
  adsr: { size: '1u', hp: 1 }, // 161×240px  [LOCKED]
  analogLogicMaths: { size: '1u', hp: 1 }, // 161×220px
  analogVco: { size: '1u', hp: 1 }, // 225×240px  [LOCKED]
  aquaTank: { size: '3u', hp: 2 }, // 273×320px
  atlantisCatalyst: { size: '3u', hp: 2 }, // 261×360px
  attenumix: { size: '1u', hp: 2 }, // 165×300px
  audioIn: { size: '3u', hp: 1 }, // 241×200px
  audioOut: { size: '1u', hp: 1 }, // 200×180px  [LOCKED]
  bluebox: { size: '3u', hp: 2 }, // 360×280px
  buggles: { size: '1u', hp: 2 }, // 163×280px
  callsine: { size: '3u', hp: 2 }, // 203×340px
  cartesian: { size: '3u', hp: 2 }, // 570×360px
  charlottesEchos: { size: '1u', hp: 2 }, // 116×320px  [LOCKED]
  chowkick: { size: '3u', hp: 3 }, // 896×540px  [LOCKED]
  clockedRunner: { size: '3u', hp: 2 }, // 220×360px
  clouds: { size: '3u', hp: 2 }, // 208×340px
  cloudseed: { size: '3u', hp: 4 }, // 434×680px
  cocoadelay: { size: '3u', hp: 3 }, // 290×620px
  cube: { size: '3u', hp: 2 }, // 895×360px
  delay: { size: '1u', hp: 1 }, // 159×200px
  destroy: { size: '1u', hp: 1 }, // 159×220px
  drummergirl: { size: '1u', hp: 2 }, // 159×320px  [LOCKED]
  drumseqz: { size: '3u', hp: 5 }, // 611×820px
  dx7: { size: '3u', hp: 2 }, // 333×320px
  elements: { size: '3u', hp: 3 }, // 305×460px
  filter: { size: '1u', hp: 1 }, // 187×200px  [LOCKED]
  flipper: { size: '1u', hp: 1 }, // 97×176px
  fourplexer: { size: '1u', hp: 2 }, // 158×320px
  foxy: { size: '3u', hp: 4 }, // 582×720px
  frogger: { size: '3u', hp: 1 }, // 380×260px
  gamepad: { size: '3u', hp: 2 }, // 267×280px
  gatemaiden: { size: '3u', hp: 1 }, // 199×200px
  grids: { size: '3u', hp: 2 }, // 500×320px
  helm: { size: '3u', hp: 4 }, // 543×720px
  hydrogen: { size: '3u', hp: 4 }, // 687×660px
  hypercube: { size: '3u', hp: 2 }, // 777×360px
  illogic: { size: '1u', hp: 1 }, // 161×240px
  joystick: { size: '3u', hp: 1 }, // 241×220px
  lfo: { size: '3u', hp: 1 }, // 228×200px
  livecode: { size: '3u', hp: 3 }, // 380×460px
  macrooscillator: { size: '3u', hp: 2 }, // 194×320px
  macseq: { size: '3u', hp: 5 }, // 289×880px
  marbles: { size: '3u', hp: 2 }, // 206×420px
  meowbox: { size: '1u', hp: 1 }, // 134×240px
  midiclock: { size: '1u', hp: 1 }, // 143×200px
  midiCvBuddy: { size: '1u', hp: 1 }, // 143×220px
  midiLane: { size: '3u', hp: 1 }, // 156×230px  [LOCKED]
  midiOutBuddy: { size: '1u', hp: 1 }, // 143×220px
  mixer: { size: '1u', hp: 1 }, // 157×260px  [LOCKED]
  mixmstrs: { size: '3u', hp: 4 }, // 668×720px
  modtris: { size: '3u', hp: 1 }, // 431×260px
  moog902: { size: '1u', hp: 1 }, // 152×236px
  moog903a: { size: '1u', hp: 1 }, // 124×180px
  moog904a: { size: '1u', hp: 1 }, // 152×236px
  moog904b: { size: '1u', hp: 1 }, // 152×236px
  moog904c: { size: '1u', hp: 1 }, // 124×220px
  moog905: { size: '1u', hp: 1 }, // 124×220px
  moog907a: { size: '3u', hp: 1 }, // 655×200px
  moog911: { size: '3u', hp: 1 }, // 187×232px
  moog911a: { size: '1u', hp: 1 }, // 137×200px
  moog912: { size: '1u', hp: 1 }, // 124×200px
  moog914: { size: '3u', hp: 1 }, // 891×200px
  moog921a: { size: '1u', hp: 1 }, // 152×236px
  moog921b: { size: '3u', hp: 1 }, // 214×252px
  moog921Vco: { size: '3u', hp: 1 }, // 214×252px
  moog923: { size: '1u', hp: 1 }, // 124×220px
  moog956: { size: '1u', hp: 1 }, // 174×240px
  moog960: { size: '3u', hp: 3 }, // 385×520px
  moog961: { size: '1u', hp: 1 }, // 124×220px
  moog962: { size: '1u', hp: 1 }, // 124×200px
  moog984: { size: '3u', hp: 2 }, // 313×300px
  moog992: { size: '1u', hp: 1 }, // 124×220px
  moog993: { size: '1u', hp: 1 }, // 124×220px
  moog994: { size: '1u', hp: 1 }, // 61×180px
  moog995: { size: '1u', hp: 1 }, // 124×200px
  moogCp3: { size: '3u', hp: 1 }, // 187×264px
  noise: { size: '1u', hp: 1 }, // 161×160px
  numpadPlus: { size: '3u', hp: 4 }, // 714×722px
  peaks: { size: '3u', hp: 2 }, // 204×320px  [LOCKED]
  pentemelodica: { size: '3u', hp: 7 }, // 462×1180px
  polyhelm: { size: '3u', hp: 4 }, // 543×720px
  polyseqz: { size: '3u', hp: 3 }, // 328×540px
  pong: { size: '3u', hp: 1 }, // 311×240px
  qbrt: { size: '1u', hp: 2 }, // 159×280px
  rasterize: { size: '3u', hp: 2 }, // 330×320px
  resofilter: { size: '1u', hp: 2 }, // 163×340px  [LOCKED]
  reverb: { size: '1u', hp: 1 }, // 159×200px
  ringback: { size: '1u', hp: 1 }, // 130×240px
  rings: { size: '3u', hp: 2 }, // 206×360px
  riotgirls: { size: '3u', hp: 6 }, // 856×1100px
  sampleHold: { size: '1u', hp: 1 }, // 149×260px
  samsloop: { size: '3u', hp: 2 }, // 420×360px
  scope: { size: '3u', hp: 2 }, // 320×320px  [LOCKED]
  score: { size: '3u', hp: 4 }, // 604×720px
  sequencer: { size: '3u', hp: 3 }, // 314×540px  [LOCKED]
  shimmershine: { size: '1u', hp: 2 }, // 159×280px
  sidecar: { size: '3u', hp: 2 }, // 326×380px
  skifree: { size: '3u', hp: 2 }, // 420×360px
  slewSwitch: { size: '3u', hp: 2 }, // 273×320px
  stages: { size: '3u', hp: 3 }, // 309×460px
  stereovca: { size: '1u', hp: 1 }, // 173×180px
  swolevco: { size: '3u', hp: 2 }, // 269×360px
  symbiote: { size: '3u', hp: 2 }, // 206×440px
  synesthesia: { size: '3u', hp: 3 }, // 426×460px
  tides2: { size: '3u', hp: 2 }, // 228×380px
  timelorde: { size: '3u', hp: 2 }, // 156×280px  [LOCKED]
  treeohvox: { size: '3u', hp: 2 }, // 240×340px
  twotracks: { size: '3u', hp: 3 }, // 413×580px
  unityscalemathematik: { size: '3u', hp: 1 }, // 483×240px
  vca: { size: '1u', hp: 1 }, // 173×160px
  veils: { size: '3u', hp: 2 }, // 186×280px
  warps: { size: '3u', hp: 2 }, // 194×320px
  warrenspectrum: { size: '3u', hp: 2 }, // 488×440px
  wavecel: { size: '3u', hp: 2 }, // 405×320px
  wavesculpt: { size: '3u', hp: 7 }, // 880×1280px
  wavetableVco: { size: '1u', hp: 1 }, // 159×240px
  writeseq: { size: '3u', hp: 5 }, // 268×880px

  // ── meta domain ──
  electraControl: { size: '3u', hp: 2 }, // 519×360px

  // ── video domain ──
  '4plexvid': { size: '3u', hp: 2 }, // 463×280px
  acidwarp: { size: '3u', hp: 2 }, // 407×380px
  b3ntb0x: { size: '3u', hp: 3 }, // 540×460px
  backdraft: { size: '3u', hp: 2 }, // 660×340px
  bentbox: { size: '3u', hp: 2 }, // 480×420px
  cameraInput: { size: '3u', hp: 2 }, // 370×280px  [LOCKED]
  cellshade: { size: '3u', hp: 1 }, // 369×220px
  chroma: { size: '3u', hp: 1 }, // 360×260px
  chromakey: { size: '3u', hp: 1 }, // 389×260px
  colorizer: { size: '3u', hp: 1 }, // 270×240px
  destructor: { size: '3u', hp: 1 }, // 240×260px
  doom: { size: '3u', hp: 2 }, // 384×360px
  edges: { size: '3u', hp: 1 }, // 250×200px
  feedback: { size: '3u', hp: 2 }, // 411×320px
  freezeframe: { size: '3u', hp: 1 }, // 609×260px
  gibribbon: { size: '3u', hp: 5 }, // 398×836px
  inwards: { size: '3u', hp: 1 }, // 280×220px
  lines: { size: '3u', hp: 1 }, // 361×220px
  luma: { size: '3u', hp: 1 }, // 275×220px
  lumakey: { size: '3u', hp: 1 }, // 287×220px
  mandelbulb: { size: '3u', hp: 2 }, // 362×280px
  mandleblot: { size: '3u', hp: 2 }, // 360×280px
  mapper: { size: '3u', hp: 1 }, // 250×200px
  monoglitch: { size: '3u', hp: 2 }, // 425×320px
  nibbles: { size: '3u', hp: 2 }, // 367×380px
  outlines: { size: '3u', hp: 1 }, // 420×260px
  peakstate: { size: '3u', hp: 1 }, // 329×240px
  picturebox: { size: '3u', hp: 1 }, // 240×220px
  qbert: { size: '3u', hp: 2 }, // 326×340px
  quadralogical: { size: '3u', hp: 3 }, // 881×480px
  recorderbox: { size: '3u', hp: 1 }, // 296×248px
  reshaper: { size: '3u', hp: 2 }, // 480×320px
  ruttetra: { size: '3u', hp: 2 }, // 480×320px
  scoreboard: { size: '1u', hp: 1 }, // 240×260px  [LOCKED]
  shapedramps: { size: '3u', hp: 1 }, // 641×240px
  shapegen: { size: '3u', hp: 2 }, // 304×300px
  shapes: { size: '3u', hp: 1 }, // 320×220px
  snes9x: { size: '3u', hp: 2 }, // 380×442px
  toybox: { size: '3u', hp: 5 }, // 693×860px
  vdelay: { size: '3u', hp: 1 }, // 431×220px
  vfpgaRunner: { size: '3u', hp: 2 }, // 467×420px
  videobox: { size: '3u', hp: 2 }, // 360×320px
  videoMixer: { size: '3u', hp: 2 }, // 420×280px
  videoOut: { size: '3u', hp: 2 }, // 240×360px
  videovarispeed: { size: '3u', hp: 2 }, // 452×320px
};
