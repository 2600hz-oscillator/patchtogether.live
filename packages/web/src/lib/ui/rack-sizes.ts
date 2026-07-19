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
  attenumix: { size: '1u', hp: 2 }, // 158×300px
  audioIn: { size: '2u', hp: 1 }, // 241×200px
  audioOut: { size: '1u', hp: 1 }, // 200×180px  [LOCKED]
  bluebox: { size: '2u', hp: 2 }, // 360×280px
  buggles: { size: '1u', hp: 2 }, // 156×280px
  callsine: { size: '1u', hp: 2 }, // 196×340px
  cartesian: { size: '4u', hp: 2 }, // 563×360px
  charlottesEchos: { size: '1u', hp: 2 }, // 109×320px  [LOCKED]
  clipplayer: { size: '3u', hp: 2 }, // 8×8 launch grid + piano-roll note editor + transport
  clouds: { size: '2u', hp: 2 }, // 201×340px
  cloudseed: { size: '3u', hp: 4 }, // 427×680px
  colourofmagic: { size: '3u', hp: 5 }, // ~840px — 5 block columns (RGB/YDbDr/HSV·HSL/YIQ/YCbCr) + preview
  cofefve: { size: '2u', hp: 4 }, // 283×620px
  cube: { size: '3u', hp: 4 }, // 540×720px — 2-col (viewport+sources left, controls right)
  delay: { size: '1u', hp: 1 }, // 152×200px
  depolarizer: { size: '1u', hp: 1 }, // 160×150px (tiny 1-in/1-out bipolar→unipolar CV util)
  destroy: { size: '1u', hp: 2 }, // 152×220px
  drummergirl: { size: '1u', hp: 2 }, // 152×320px  [LOCKED]
  drumseqz: { size: '4u', hp: 5 }, // 604×820px
  dx7: { size: '2u', hp: 2 }, // 326×320px
  featurecv: { size: '2u', hp: 2 }, // ~260 wide — 3 feature meters + ONSET led + 6 knobs/toggle over a 5-port PatchPanel (≈ spectrograph)
  fader: { size: '2u', hp: 2 }, // ~360 wide — 2 long faders + 2 transition dropdowns (A/B + dry/wet) over a 5-port PatchPanel
  filter: { size: '1u', hp: 1 }, // 180×200px  [LOCKED]
  flipper: { size: '1u', hp: 1 }, // 90×176px
  fourplexer: { size: '1u', hp: 2 }, // 158×320px
  foxy: { size: '4u', hp: 4 }, // 575×720px
  // NOTE: user-resizable cards (clockedRunner, livecode, wavesculpt, b3ntb0x,
  // bentbox, monoglitch, reshaper, ruttetra, toybox, videobox, videoOut,
  // backdraft, archivist) are intentionally ABSENT from this map — they are
  // sized by their own corner-resize (snapped to whole-u via card-resize.ts),
  // not a fixed tier, so the rack CSS must NOT clamp them. They live in
  // rack-sizing.test.ts DYNAMIC_SIZED. Their DEFAULT/MIN constants are rounded
  // to 180-multiples so they still land on-grid out of the box. (backdraft was
  // briefly a FIXED 3u/hp4 tier in #767, then re-made corner-resizable when it
  // gained full output capabilities — resize + full-frame/fullscreen/present —
  // so a fixed tier would now CAP its resize.)
  frogger: { size: '2u', hp: 2 }, // 380×260px
  gamepad: { size: '2u', hp: 2 }, // 267×280px
  gatemaiden: { size: '1u', hp: 1 }, // 199×200px
  grainsOfVision: { size: '3u', hp: 4 }, // 720×540px — 2-col: OUT preview left, GRAIN/FEEDBACK/REVERB/COMP single-row fader sections right (widened 2hp→4hp so ~19 controls fit; was 2hp/3u where the 967px fader stack overflowed the 540px tier)
  graphicEq: { size: '2u', hp: 2 }, // 360×360px — Winamp-style VU-meter video output
  hypercube: { size: '3u', hp: 4 }, // 540×720px — 2-col (viewport left, controls right)
  illogic: { size: '1u', hp: 2 }, // 154×240px
  joystick: { size: '2u', hp: 2 }, // 234×220px
  karplus: { size: '2u', hp: 2 }, // ~310×450px — STRING/EXCITER fader bands + PLUCK button
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
  ninelives: { size: '2u', hp: 2 }, // 292×240px — Rate/Waveform faders + 9-out PatchPanel + reset
  noise: { size: '1u', hp: 1 }, // 154×160px
  numpadPlus: { size: '4u', hp: 4 }, // 714×722px
  pentemelodica: { size: '3u', hp: 7 }, // 462×1180px
  polarizer: { size: '1u', hp: 1 }, // 160×150px (tiny 1-in/1-out unipolar→bipolar CV util)
  polyseqz: { size: '2u', hp: 3 }, // 321×540px
  pong: { size: '2u', hp: 2 }, // 304×240px
  qbrt: { size: '1u', hp: 2 }, // 152×280px
  rasterize: { size: '2u', hp: 2 }, // 330×320px
  resofilter: { size: '1u', hp: 2 }, // 156×340px  [LOCKED]
  reverb: { size: '1u', hp: 1 }, // 152×200px
  ringback: { size: '1u', hp: 2 }, // 123×240px
  rings: { size: '1u', hp: 2 }, // 199×360px
  sampleHold: { size: '1u', hp: 2 }, // 149×260px
  samsloop: { size: '3u', hp: 2 }, // 420×360px
  scaler: { size: '1u', hp: 1 }, // 160×150px (tiny 1-in/1-out 1-knob multiplier)
  scope: { size: '3u', hp: 2 }, // 500×320px  [LOCKED]
  score: { size: '4u', hp: 4 }, // 597×720px
  sequencer: { size: '3u', hp: 3 }, // 307×540px  [LOCKED]
  shimmershine: { size: '1u', hp: 2 }, // 152×280px
  sidecar: { size: '2u', hp: 2 }, // 299×380px
  sixstrum: { size: '2u', hp: 4 }, // 620×~380px — 4 fader bands + per-string rear PatchPanel
  skifree: { size: '3u', hp: 2 }, // 420×360px
  slewSwitch: { size: '2u', hp: 2 }, // 273×320px
  stereovca: { size: '1u', hp: 1 }, // 156×180px
  swolevco: { size: '2u', hp: 2 }, // 262×360px
  synesthesia: { size: '3u', hp: 2 }, // 540×360 — was 3hp, trimmed empty right margin
  tempest: { size: '2u', hp: 2 }, // 320×360px — vector-well preview + RIM knob + SHAPE
  textmarquee: { size: '3u', hp: 2 }, // 280×~450px — rich-text editor + preview + 4 knobs
  timelorde: { size: '3u', hp: 2 }, // 152×280px  [LOCKED]
  treeohvox: { size: '2u', hp: 2 }, // 240×340px
  twotracks: { size: '3u', hp: 4 }, // 406×580px
  unityscalemathematik: { size: '3u', hp: 2 }, // 446×240px
  vca: { size: '1u', hp: 1 }, // 156×160px
  warrenspectrum: { size: '3u', hp: 3 }, // 481×440px
  wavecel: { size: '3u', hp: 2 }, // 398×320px
  wavetableVco: { size: '1u', hp: 2 }, // 152×240px
  writeseq: { size: '2u', hp: 5 }, // 261×880px

  // ── meta domain ──
  electraControl: { size: '3u', hp: 2 }, // 519×360px
  launchpadControlLeft: { size: '1u', hp: 2 }, // 169×340px — consolidated launchpad control (pair) card (compact wide 1u)

  // ── video domain ──
  '4plexvid': { size: '3u', hp: 2 }, // 463×280px
  acidwarp: { size: '3u', hp: 2 }, // 407×380px
  cameraInput: { size: '3u', hp: 2 }, // 370×280px  [LOCKED]
  cellshade: { size: '3u', hp: 2 }, // 369×~490px — rebuild added the SOFT/SMOOTH/INK fader row (2u overflowed the INK row)
  chroma: { size: '2u', hp: 2 }, // 360×260px
  chromakey: { size: '3u', hp: 2 }, // 389×260px
  colorizer: { size: '2u', hp: 2 }, // 270×240px
  destructor: { size: '1u', hp: 2 }, // 180×360px — 4 knobs in one row
  blood: { size: '2u', hp: 2 }, // BLOOD — DOOM-class Build-engine game (matches doom)
  doom: { size: '2u', hp: 2 }, // 377×360px
  edges: { size: '1u', hp: 2 }, // 180×360px — 2 faders one row beside handles
  feedback: { size: '3u', hp: 2 }, // 411×320px
  frametable: { size: '3u', hp: 2 }, // ~288×~490px — mode selector + 176×132 preview + CHAOS/LIVE + FREEZE/SAVE + MORPH/SPREAD + (SMOOTH: 2 X-Y pads + shape knobs / CHAOS: shimmer+shape / MORPH: none)
  freezeframe: { size: '3u', hp: 2 }, // ~470×260px — enlarged preview fills the body
  gibribbon: { size: '3u', hp: 5 }, // 398×836px
  inwards: { size: '2u', hp: 2 }, // 280×220px
  lines: { size: '2u', hp: 2 }, // 361×220px
  loopback: { size: '3u', hp: 2 }, // 280×320px — viewport-capture source (≈ cameraInput)
  luma: { size: '2u', hp: 2 }, // 275×220px
  lumakey: { size: '2u', hp: 2 }, // 287×220px
  mandelbulb: { size: '2u', hp: 2 }, // 362×280px
  mirrorpool: { size: '3u', hp: 2 }, // 250×~500px — 160×120 preview + 2 camera X-Y pads + 7-fader grid (≈ cellshade)
  mandleblot: { size: '2u', hp: 2 }, // 360×280px
  mapper: { size: '2u', hp: 1 }, // 250×200px
  mappy: { size: '3u', hp: 2 }, // ~380×300px — 320×180 (16:9) composite preview + GRID toggle + surface legend
  nibbles: { size: '2u', hp: 2 }, // 367×380px
  onetonine: { size: '3u', hp: 3 }, // ~360×440px — 300×169 (16:9) monitor preview + GRID toggle + IN/OUT1..OUT9 (10-port panel)
  outToLaunch: { size: '3u', hp: 2 }, // 300×~440px — 234px 9×9 monitor preview + MONITOR banner + BRIGHT/GAMMA knobs + Launchpad device picker
  outlines: { size: '3u', hp: 2 }, // 420×260px
  painter: { size: '3u', hp: 3 }, // 540×540 — MS-Paint card: 9-tool toolbar + flex-filled 4:3 paint canvas (fills the tier; faceplate letterbox margin, no overflow) + 28-swatch palette
  peakstate: { size: '2u', hp: 2 }, // 329×240px
  picturebox: { size: '2u', hp: 2 }, // 240×220px
  posterbox: { size: '2u', hp: 2 }, // 220×~520px card body — 160×120 preview + 3 faders (mirrors cellshade)
  quadralogical: { size: '3u', hp: 4 }, // 540×720px — 2-col (joystick left, preview+edges right)
  recorderbox: { size: '2u', hp: 2 }, // 296×248px
  spectrograph: { size: '2u', hp: 2 }, // 320×220px — sonogram preview + gain (≈ cellshade/recorderbox)
  scoreboard: { size: '1u', hp: 2 }, // 240×260px  [LOCKED]
  shapedramps: { size: '4u', hp: 2 }, // 641×240px
  lushgarden: { size: '2u', hp: 2 }, // 300×322px — preview + 3 knobs (mirrors shapegen)
  shapegen: { size: '2u', hp: 2 }, // 304×300px
  shapes: { size: '2u', hp: 2 }, // 320×220px
  sourcery: { size: '2u', hp: 2 }, // 300×304px — 2 video ins + preview + 4 knobs (mirrors shapegen)
  spirographs: { size: '3u', hp: 2 }, // 260×~360px — 160×120 preview + count/selector + colorwheel + per-spiro fader bank
  tiler: { size: '2u', hp: 2 }, // 200×200px — 160×120 preview + one TILE fader (mirrors cellshade)
  vdelay: { size: '3u', hp: 2 }, // 431×220px
  vfpgaRunner: { size: '3u', hp: 3 }, // 467×420px
  videoMixer: { size: '1u', hp: 2 }, // 180×280px — 4 channel faders in one row  [LOCKED]
  videovarispeed: { size: '3u', hp: 2 }, // 452×320px
};
