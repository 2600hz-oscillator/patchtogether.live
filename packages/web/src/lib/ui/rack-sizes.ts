// packages/web/src/lib/ui/rack-sizes.ts
//
// Bulk Phase-1 rack classification for EXISTING modules.
//
// Each registered module type is mapped to a rack `size` tier ('1u' | '3u') and
// an `hp` width (in 1u = 180px square tiles). A module is `hp` tiles wide ×
// (1u | 3u) tall, snapping to the uniform 3u-slot grid (see
// `.myrobots/plans/module-sizing-rack-format.md` +
// `.myrobots/plans/module-sizing-DECISIONS-2026-06-13.md`).
//
// size heuristic (per the plan §5.1 + the user's LOCKED overrides):
//   3u = has a screen / canvas / viz (ALL video-domain modules, scope-likes,
//        games, toybox/doom, 3D viz, wavesculpt/synesthesia/recorderbox),
//        sequencers, full synth voices, control surfaces + group, big mixers.
//   1u = simple utilities (VCAs, attenuators, mults, lfo, adsr, filters,
//        delays, reverbs, the moog utility modules, midi buddies, audioIn/Out,
//        small mixers).
// The user's explicit per-module overrides (DECISIONS §2) are applied VERBATIM
// and noted inline below.
//
// hp = max(1, round(cardWidthPx / 180)) from each card's component-local CSS
// width (the `--rack-unit` square = 180px). Big modules keep a unique hp.
//
// PRECEDENCE: a module def that declares `size`/`hp` on the def itself OVERRIDES
// this map (see Canvas.svelte rackSizeByType + rack-sizing.test.ts). This map is
// the bulk fallback for existing modules that haven't moved their declaration
// onto the def yet. New modules should declare size/hp on the def.

import type { RackSize } from '$lib/graph/types';

export const RACK_SIZE_DEFAULTS: Record<string, { size: RackSize; hp: number }> = {
  // ── Audio · Utility / Mixing / I/O ──────────────────────────────────────
  vca: { size: '1u', hp: 1 }, //                       160px → 1hp
  stereovca: { size: '1u', hp: 1 }, //                 180px → 1hp (the 1u reference)
  noise: { size: '1u', hp: 1 }, //                     160px → 1hp
  attenumix: { size: '1u', hp: 2 }, //                 300px → 2hp
  mixer: { size: '1u', hp: 1 }, // OVERRIDE 1u         260px → 1hp
  videoMixer: { size: '3u', hp: 2 }, //                280px → 2hp (video preview)
  flipper: { size: '1u', hp: 1 }, //                   176px → 1hp
  gatemaiden: { size: '1u', hp: 1 }, //                200px → 1hp (gate↔trigger converter, merged via #758)
  illogic: { size: '1u', hp: 1 }, //                   240px → 1hp
  analogLogicMaths: { size: '1u', hp: 1 }, //          220px → 1hp
  unityscalemathematik: { size: '1u', hp: 1 }, //      240px → 1hp
  veils: { size: '1u', hp: 2 }, //                     280px → 2hp
  fourplexer: { size: '1u', hp: 2 }, //                320px → 2hp
  sampleHold: { size: '1u', hp: 1 }, //                260px → 1hp
  slewSwitch: { size: '1u', hp: 2 }, //                320px → 2hp
  audioIn: { size: '1u', hp: 1 }, //                   200px → 1hp
  audioOut: { size: '1u', hp: 1 }, // OVERRIDE 1u      180px → 1hp
  rasterize: { size: '1u', hp: 2 }, //                 320px → 2hp
  qbrt: { size: '1u', hp: 2 }, //                      280px → 2hp

  // ── Audio · Modulation ──────────────────────────────────────────────────
  lfo: { size: '1u', hp: 1 }, //                       200px → 1hp
  adsr: { size: '1u', hp: 1 }, // OVERRIDE 1u          240px → 1hp
  buggles: { size: '1u', hp: 2 }, //                   280px → 2hp
  atlantisCatalyst: { size: '1u', hp: 2 }, //          360px → 2hp
  peaks: { size: '3u', hp: 2 }, // OVERRIDE 3u         320px → 2hp
  sequencer: { size: '3u', hp: 3 }, // OVERRIDE 3u     540px → 3hp
  polyseqz: { size: '3u', hp: 3 }, //                  540px → 3hp
  drumseqz: { size: '3u', hp: 5 }, //                  820px → 5hp
  macseq: { size: '3u', hp: 5 }, //                    880px → 5hp
  score: { size: '3u', hp: 4 }, //                     720px → 4hp
  writeseq: { size: '3u', hp: 5 }, //                  880px → 5hp
  grids: { size: '3u', hp: 2 }, //                     320px → 2hp
  marbles: { size: '3u', hp: 2 }, //                   420px → 2hp
  tides2: { size: '3u', hp: 2 }, //                    380px → 2hp
  stages: { size: '3u', hp: 3 }, //                    460px → 3hp
  cartesian: { size: '3u', hp: 2 }, //                 360px → 2hp
  timelorde: { size: '3u', hp: 2 }, // OVERRIDE 3u     280px → 2hp

  // ── Audio · Filters / Effects / Processors ──────────────────────────────
  filter: { size: '1u', hp: 1 }, // OVERRIDE 1u        200px → 1hp
  reverb: { size: '1u', hp: 1 }, //                    200px → 1hp
  delay: { size: '1u', hp: 1 }, //                     200px → 1hp
  destroy: { size: '1u', hp: 1 }, //                   220px → 1hp
  cocoadelay: { size: '3u', hp: 3 }, //                620px → 3hp (3u — dense FX, user call)
  ringback: { size: '1u', hp: 1 }, //                  240px → 1hp
  resofilter: { size: '1u', hp: 2 }, // OVERRIDE 1u    340px → 2hp
  clouds: { size: '3u', hp: 2 }, //                    340px → 2hp
  cloudseed: { size: '3u', hp: 4 }, //                 680px → 4hp
  callsine: { size: '1u', hp: 2 }, //                  340px → 2hp (fits 1u, user call)
  charlottesEchos: { size: '3u', hp: 2 }, //           320px → 2hp
  aquaTank: { size: '3u', hp: 2 }, //                  320px → 2hp
  warps: { size: '3u', hp: 2 }, //                     320px → 2hp
  shimmershine: { size: '3u', hp: 2 }, //              280px → 2hp
  sidecar: { size: '3u', hp: 2 }, //                   380px → 2hp
  warrenspectrum: { size: '3u', hp: 2 }, //            440px → 2hp (spectrum viz)
  twotracks: { size: '3u', hp: 3 }, //                 580px → 3hp (dual-reel viz)

  // ── Audio · Sources / Voices ────────────────────────────────────────────
  chowkick: { size: '3u', hp: 3 }, // OVERRIDE 3u      540px → 3hp
  drummergirl: { size: '3u', hp: 2 }, // OVERRIDE 3u   320px → 2hp
  numpadPlus: { size: '3u', hp: 2 }, //                360px (min-width) → 2hp
  riotgirls: { size: '3u', hp: 6 }, //                 1100px → 6hp
  analogVco: { size: '1u', hp: 1 }, // OVERRIDE 1u     240px → 1hp
  wavetableVco: { size: '3u', hp: 1 }, //              240px → 1hp
  swolevco: { size: '3u', hp: 2 }, //                  360px → 2hp
  macrooscillator: { size: '3u', hp: 2 }, //           320px → 2hp
  helm: { size: '3u', hp: 4 }, //                      720px → 4hp
  polyhelm: { size: '3u', hp: 4 }, //                  720px → 4hp
  dx7: { size: '3u', hp: 2 }, //                       320px → 2hp
  elements: { size: '3u', hp: 3 }, //                  460px → 3hp
  rings: { size: '3u', hp: 2 }, //                     360px → 2hp
  symbiote: { size: '3u', hp: 2 }, //                  440px → 2hp
  treeohvox: { size: '3u', hp: 2 }, //                 340px → 2hp
  pentemelodica: { size: '3u', hp: 7 }, //             1180px → 7hp
  meowbox: { size: '3u', hp: 1 }, //                   240px → 1hp
  wavecel: { size: '3u', hp: 2 }, //                   320px → 2hp
  wavesculpt: { size: '3u', hp: 7 }, //                1280px (resizable) → 7hp (WebGL)
  cube: { size: '3u', hp: 2 }, //                      360px → 2hp (3D WebGL)
  hypercube: { size: '3u', hp: 2 }, //                 360px → 2hp (4D WebGL)
  foxy: { size: '3u', hp: 4 }, //                      720px → 4hp
  bluebox: { size: '3u', hp: 2 }, //                   280px → 2hp
  samsloop: { size: '3u', hp: 2 }, //                  360px → 2hp
  vfpgaRunner: { size: '3u', hp: 2 }, //               420px → 2hp
  gibribbon: { size: '3u', hp: 2 }, //                 max-content → 2hp

  // ── Audio · Mixing (big) ────────────────────────────────────────────────
  mixmstrs: { size: '3u', hp: 4 }, //                  720px → 4hp (big mixer + viz)

  // ── Moog System 35/55 clones ────────────────────────────────────────────
  moog902: { size: '1u', hp: 1 }, //                   236px → 1hp (VCA)
  moog903a: { size: '1u', hp: 1 }, //                  180px → 1hp (noise)
  moog904a: { size: '1u', hp: 1 }, //                  236px → 1hp (VCF)
  moog904b: { size: '1u', hp: 1 }, //                  236px → 1hp (VCF)
  moog904c: { size: '1u', hp: 1 }, //                  220px → 1hp (filter coupler)
  moog905: { size: '1u', hp: 1 }, //                   220px → 1hp (reverb)
  moog907a: { size: '1u', hp: 1 }, //                  200px → 1hp (fixed filter bank)
  moog911: { size: '1u', hp: 1 }, //                   232px → 1hp (envelope)
  moog911a: { size: '1u', hp: 1 }, //                  200px → 1hp (dual trigger delay)
  moog912: { size: '1u', hp: 1 }, //                   200px → 1hp (env follower)
  moog914: { size: '1u', hp: 1 }, //                   200px → 1hp (fixed filter bank)
  moog921Vco: { size: '1u', hp: 1 }, //                252px → 1hp (VCO)
  moog921a: { size: '1u', hp: 1 }, //                  236px → 1hp (VCO driver)
  moog921b: { size: '1u', hp: 1 }, //                  252px → 1hp (VCO)
  moog923: { size: '1u', hp: 1 }, //                   220px → 1hp (noise + filters)
  moog956: { size: '3u', hp: 1 }, //                   240px → 1hp (ribbon controller)
  moog960: { size: '3u', hp: 3 }, //                   520px → 3hp (sequential controller)
  moog961: { size: '1u', hp: 1 }, //                   220px → 1hp (interface)
  moog962: { size: '1u', hp: 1 }, //                   200px → 1hp (sequential switch)
  moog984: { size: '1u', hp: 2 }, //                   300px → 2hp (matrix mixer)
  moog992: { size: '1u', hp: 1 }, //                   220px → 1hp (controller)
  moog993: { size: '1u', hp: 1 }, //                   220px → 1hp (controller)
  moog994: { size: '1u', hp: 1 }, //                   180px → 1hp (mults)
  moog995: { size: '1u', hp: 1 }, //                   200px → 1hp (attenuators)
  moogCp3: { size: '1u', hp: 1 }, //                   264px → 1hp (mixer)

  // ── MIDI ────────────────────────────────────────────────────────────────
  midiclock: { size: '1u', hp: 1 }, //                 200px → 1hp
  midiCvBuddy: { size: '1u', hp: 1 }, //               220px → 1hp
  midiOutBuddy: { size: '1u', hp: 1 }, //              220px → 1hp
  midiLane: { size: '3u', hp: 1 }, // OVERRIDE 3u      230px → 1hp
  gamepad: { size: '1u', hp: 2 }, //                   280px (min-width) → 2hp
  joystick: { size: '1u', hp: 1 }, //                  220px → 1hp

  // ── Scope ───────────────────────────────────────────────────────────────
  scope: { size: '1u', hp: 2 }, // OVERRIDE 1u         320px → 2hp

  // ── Video domain (all render a preview canvas → 3u) ──────────────────────
  '4plexvid': { size: '3u', hp: 2 }, //                280px → 2hp
  acidwarp: { size: '3u', hp: 2 }, //                  380px → 2hp
  b3ntb0x: { size: '3u', hp: 3 }, //                   460px (resizable) → 3hp
  backdraft: { size: '3u', hp: 2 }, //                 340px (resizable) → 2hp
  bentbox: { size: '3u', hp: 2 }, //                   420px (resizable) → 2hp
  cameraInput: { size: '3u', hp: 2 }, // OVERRIDE 3u   280px → 2hp
  cellshade: { size: '3u', hp: 1 }, //                 220px → 1hp
  chroma: { size: '3u', hp: 1 }, //                    260px → 1hp
  chromakey: { size: '3u', hp: 1 }, //                 260px → 1hp
  colorizer: { size: '3u', hp: 1 }, //                 240px → 1hp
  destructor: { size: '3u', hp: 1 }, //                260px → 1hp
  doom: { size: '3u', hp: 2 }, //                      360px → 2hp (play screen)
  edges: { size: '3u', hp: 1 }, //                     200px → 1hp
  feedback: { size: '3u', hp: 2 }, //                  320px → 2hp
  freezeframe: { size: '3u', hp: 1 }, //               260px → 1hp
  inwards: { size: '3u', hp: 1 }, //                   220px → 1hp
  lines: { size: '3u', hp: 1 }, //                     220px → 1hp
  luma: { size: '3u', hp: 1 }, //                      220px → 1hp
  lumakey: { size: '3u', hp: 1 }, //                   220px → 1hp
  mandelbulb: { size: '3u', hp: 2 }, //                280px → 2hp (WebGL)
  mandleblot: { size: '3u', hp: 2 }, //                280px → 2hp (WebGL)
  mapper: { size: '3u', hp: 1 }, //                    200px → 1hp
  monoglitch: { size: '3u', hp: 2 }, //                320px (resizable) → 2hp
  nibbles: { size: '3u', hp: 2 }, //                   max-content → 2hp (game)
  outlines: { size: '3u', hp: 1 }, //                  260px → 1hp
  peakstate: { size: '3u', hp: 1 }, //                 240px → 1hp
  picturebox: { size: '3u', hp: 1 }, //                220px → 1hp
  qbert: { size: '3u', hp: 2 }, //                     max-content → 2hp (game)
  quadralogical: { size: '3u', hp: 3 }, //             480px → 3hp (matrix)
  recorderbox: { size: '3u', hp: 1 }, //               248px → 1hp (capture UI)
  reshaper: { size: '3u', hp: 2 }, //                  320px (resizable) → 2hp
  ruttetra: { size: '3u', hp: 2 }, //                  320px (resizable) → 2hp
  scoreboard: { size: '1u', hp: 1 }, // OVERRIDE 1u    260px → 1hp
  shapedramps: { size: '3u', hp: 1 }, //               240px → 1hp
  shapegen: { size: '3u', hp: 2 }, //                  300px → 2hp
  shapes: { size: '3u', hp: 1 }, //                    220px → 1hp
  snes9x: { size: '3u', hp: 2 }, //                    max-content → 2hp (emulator)
  toybox: { size: '3u', hp: 5 }, //                    860px (resizable) → 5hp
  vdelay: { size: '3u', hp: 1 }, //                    220px → 1hp
  videobox: { size: '3u', hp: 2 }, //                  320px (resizable) → 2hp
  videoOut: { size: '3u', hp: 2 }, //                  360px (resizable) → 2hp
  videovarispeed: { size: '3u', hp: 2 }, //            320px → 2hp

  // ── Games / Emulators (audio-domain) ────────────────────────────────────
  pong: { size: '3u', hp: 1 }, //                      240px → 1hp (play screen)
  frogger: { size: '3u', hp: 1 }, //                   260px → 1hp (play screen)
  modtris: { size: '3u', hp: 1 }, //                   260px → 1hp (play screen)
  skifree: { size: '3u', hp: 2 }, //                   360px → 2hp (play screen)
  synesthesia: { size: '3u', hp: 3 }, //               460px → 3hp (viz)

  // ── Audio voices/sequencers with screens (audio-domain) ─────────────────
  hydrogen: { size: '3u', hp: 4 }, //                  660px (min-width) → 4hp
  clockedRunner: { size: '3u', hp: 2 }, //             360px (resizable) → 2hp
  livecode: { size: '3u', hp: 3 }, //                  460px (resizable, code editor) → 3hp

  // ── Meta / containers (controlSurface + group → 3u; sticky free-form) ────
  controlSurface: { size: '3u', hp: 2 }, //            max-content → 2hp (surface)
  electraControl: { size: '3u', hp: 2 }, //            max-content → 2hp (surface)
  sticky: { size: '1u', hp: 1 }, //                    200px (resizable note) → 1hp
};
