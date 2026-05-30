// packages/web/src/lib/ui/module-categories.ts
//
// Classification map for the nested "Add module" palette. The palette
// renders a 2-level hierarchy:
//
//   Top                    Sub                Items
//   --------------------- ------------------ ------------------------
//   Audio modules         VCOs               ANALOGVCO, WAVETABLEVCO …
//                         Utility            ADSR, VCA, CARTESIAN …
//                         Effects            REVERB, CHARLOTTESECHOS …
//                         Mixing             MIXER, MIXMSTRS …
//                         End of chain       AUDIOOUT
//   Video modules         Sources            LINES, CAMERA, SHAPES …
//                         Processors         CHROMA, LUMA, COLORIZER …
//                         Utilities          V-MIXER, OUTPUT …
//   Hybrid                — (flat)           SCOPE, viz-VCOs, STICKY …
//
// First-cut classifications are colocated here as a single
// `Record<moduleType, {top, sub}>`. The user is expected to iterate on
// these on dev; the categories live in one place so they're easy to
// nudge.
//
// Any registered module not present in this map falls into a top-level
// "Uncategorized" bucket so newly-added modules from parallel agents
// (BLADES, STAGES, etc.) never silently fall out of the palette. The
// unit test next door asserts every *known* type is classified — new
// modules will surface as Uncategorized in the UI, and the test will
// nudge contributors to file them properly.

export type TopCategory =
  | 'Audio modules'
  | 'Video modules'
  | 'Ports'
  | 'MIDI'
  | 'Hybrid'
  | 'Uncategorized';

export interface CategoryEntry {
  top: TopCategory;
  /** Sub-category label. For 'Hybrid', sub is unused (flat list); we
   *  set it to 'Hybrid' for the schema's shape uniformity.
   *
   *  Special rendering rule (ModulePalette): when a sub's name matches
   *  the top's name (e.g. Ports/Ports, Hybrid/Hybrid) those items
   *  render flat directly under the top-level row — no sub-header
   *  indirection. This lets a top-level group like Ports show
   *  high-profile entries (helm, hydrogen, cloudseed) at the top
   *  level alongside a labelled Mutable subfolder for the rest. */
  sub: string;
}

/** Canonical sub-category order per top category (drives menu order). */
export const SUB_ORDER: Record<TopCategory, readonly string[]> = {
  'Audio modules': ['VCOs', 'Utility', 'Effects', 'Mixing', 'End of chain'],
  'Video modules': ['Sources', 'Processors', 'Utilities'],
  // Ports = "ports of external software / hardware synths". `Ports`
  // (matching the top name) renders flat at the top level —
  // hydrogen, helm, cloudseed are headline ports the user wants one
  // click away. `Mutable` is the MI archetype-port sublist.
  Ports: ['Ports', 'Mutable'],
  MIDI: ['MIDI'],
  Hybrid: ['Hybrid'],
  Uncategorized: ['Uncategorized'],
};

/** Top-level rendering order. */
export const TOP_ORDER: readonly TopCategory[] = [
  'Audio modules',
  'Video modules',
  'Ports',
  'MIDI',
  'Hybrid',
  'Uncategorized',
];

/** First-cut classification map. Keys are ModuleDef.type ids. */
export const MODULE_CATEGORIES: Record<string, CategoryEntry> = {
  // ───────── Audio modules → VCOs (oscillators / audio sources) ─────────
  analogVco: { top: 'Audio modules', sub: 'VCOs' },
  wavetableVco: { top: 'Audio modules', sub: 'VCOs' },
  // macrooscillator + rings → moved to Ports/Mutable.
  dx7: { top: 'Audio modules', sub: 'VCOs' },
  meowbox: { top: 'Audio modules', sub: 'VCOs' },
  buggles: { top: 'Audio modules', sub: 'VCOs' },
  noise: { top: 'Audio modules', sub: 'VCOs' },
  drummergirl: { top: 'Audio modules', sub: 'VCOs' },
  riotgirls: { top: 'Audio modules', sub: 'VCOs' },
  samsloop: { top: 'Audio modules', sub: 'VCOs' },
  // HELM + HYDROGEN moved to Ports (top-level, flat) — see the Ports
  // block below. The MI ports (rings, clouds, peaks, stages, blades,
  // macrooscillator, veils, warps) also moved to Ports/Mutable.

  // ───────── Audio modules → Utility ─────────
  adsr: { top: 'Audio modules', sub: 'Utility' },
  lfo: { top: 'Audio modules', sub: 'Utility' },
  vca: { top: 'Audio modules', sub: 'Utility' },
  stereovca: { top: 'Audio modules', sub: 'Utility' },
  cartesian: { top: 'Audio modules', sub: 'Utility' },
  illogic: { top: 'Audio modules', sub: 'Utility' },
  unityscalemathematik: { top: 'Audio modules', sub: 'Utility' },
  analogLogicMaths: { top: 'Audio modules', sub: 'Utility' },
  // veils, peaks, stages → moved to Ports/Mutable.
  timelorde: { top: 'Audio modules', sub: 'Utility' },
  sequencer: { top: 'Audio modules', sub: 'Utility' },
  drumseqz: { top: 'Audio modules', sub: 'Utility' },
  polyseqz: { top: 'Audio modules', sub: 'Utility' },
  macseq: { top: 'Audio modules', sub: 'Utility' },
  score: { top: 'Audio modules', sub: 'Utility' },
  joystick: { top: 'Audio modules', sub: 'Utility' },
  gamepad:  { top: 'Audio modules', sub: 'Utility' },
  numpadPlus: { top: 'Audio modules', sub: 'Utility' },
  // ATLANTIS-PATCH support trio — see graph/types.ts for the full notes.
  slewSwitch: { top: 'Audio modules', sub: 'Utility' },
  atlantisCatalyst: { top: 'Audio modules', sub: 'Utility' },
  // 4PLEXER — 4-in / 4-out discrete signal router (per-output gate-advanced selector).
  fourplexer: { top: 'Audio modules', sub: 'Utility' },

  // ───────── Audio modules → Effects ─────────
  filter: { top: 'Audio modules', sub: 'Effects' },
  aquaTank: { top: 'Audio modules', sub: 'Effects' },
  reverb: { top: 'Audio modules', sub: 'Effects' },
  delay: { top: 'Audio modules', sub: 'Effects' },
  // cloudseed → moved to Ports/Ports (PR #226).
  charlottesEchos: { top: 'Audio modules', sub: 'Effects' },
  destroy: { top: 'Audio modules', sub: 'Effects' },
  shimmershine: { top: 'Audio modules', sub: 'Effects' },
  qbrt: { top: 'Audio modules', sub: 'Effects' },
  // CALLSINE — spectral-analysis additive resynth (Warren's Spectrum port).
  // Audio-in → audio-out → fundamentally an effect, even though it can
  // also act as a freeze-gated source when patched into its own feedback.
  callsine: { top: 'Audio modules', sub: 'Effects' },
  // SIDECAR — stereo sidechain compressor (GMR 2012; Faust co.compressor_stereo
  // as reference). Effects category — fundamentally a dynamics processor
  // sitting in the audio chain.
  sidecar: { top: 'Audio modules', sub: 'Effects' },
  // blades, warps, clouds → moved to Ports/Mutable.
  // cloudseed → moved to Ports (top-level).

  // ───────── Audio modules → Mixing ─────────
  mixer: { top: 'Audio modules', sub: 'Mixing' },
  mixmstrs: { top: 'Audio modules', sub: 'Mixing' },
  attenumix: { top: 'Audio modules', sub: 'Mixing' },

  // ───────── Audio modules → End of chain ─────────
  audioOut: { top: 'Audio modules', sub: 'End of chain' },

  // ───────── Ports → top-level (helm, hydrogen, cloudseed are the
  //          headline external-software ports — one click in the
  //          picker. Sub matches top name so the palette renders them
  //          flat under the Ports header). ─────────
  helm: { top: 'Ports', sub: 'Ports' },
  hydrogen: { top: 'Ports', sub: 'Ports' },
  cloudseed: { top: 'Ports', sub: 'Ports' },
  // COCOA DELAY — Tilde Murray's Cocoa Delay (GPL-3.0). Headline software
  // delay port — one click in the picker, flat under the Ports header.
  cocoadelay: { top: 'Ports', sub: 'Ports' },
  // RESOFILTER — multi-mode filter (port of gabrielsoule/resonarium MultiFilter).
  resofilter: { top: 'Ports', sub: 'Ports' },
  // TREE.oh.VOX — TB-303 voice slice (port of Robin Schmidt's Open303).
  // Sits under Ports next to the other software-port voices; the full 404
  // module (sequencer + TD-3 UI) is queued as a follow-up.
  treeohvox: { top: 'Ports', sub: 'Ports' },

  // ───────── Ports → Mutable (Émilie Gillet / MI archetype ports). ─────────
  rings: { top: 'Ports', sub: 'Mutable' },
  elements: { top: 'Ports', sub: 'Mutable' },
  clouds: { top: 'Ports', sub: 'Mutable' },
  peaks: { top: 'Ports', sub: 'Mutable' },
  marbles: { top: 'Ports', sub: 'Mutable' },
  symbiote: { top: 'Ports', sub: 'Mutable' },
  stages: { top: 'Ports', sub: 'Mutable' },
  tides2: { top: 'Ports', sub: 'Mutable' },
  blades: { top: 'Ports', sub: 'Mutable' },
  macrooscillator: { top: 'Ports', sub: 'Mutable' },
  veils: { top: 'Ports', sub: 'Mutable' },
  warps: { top: 'Ports', sub: 'Mutable' },
  grids: { top: 'Ports', sub: 'Mutable' },

  // ───────── MIDI (hardware-bridge modules) ─────────
  // MIDI-CV-BUDDY emits pitch + gate + velocity CV from a hardware MIDI
  // controller. MIDICLOCK is the transport-only sibling — clock/run/
  // start/stop gates from an external MIDI device (drives TIMELORDE.clock).
  midiCvBuddy: { top: 'MIDI', sub: 'MIDI' },
  midiclock: { top: 'MIDI', sub: 'MIDI' },

  // ───────── Video modules → Sources ─────────
  cameraInput: { top: 'Video modules', sub: 'Sources' },
  lines: { top: 'Video modules', sub: 'Sources' },
  inwards: { top: 'Video modules', sub: 'Sources' },
  picturebox: { top: 'Video modules', sub: 'Sources' },
  shapes: { top: 'Video modules', sub: 'Sources' },
  shapedramps: { top: 'Video modules', sub: 'Sources' },
  acidwarp: { top: 'Video modules', sub: 'Sources' },
  // MANDLEBLOT — Mandelbrot fractal generator (mono + colour outputs).
  mandleblot: { top: 'Video modules', sub: 'Sources' },
  // PEAKSTATE — animated mandala generator (kaleidoscope mirror-arm pen
  // trace + 3D-tube output). Self-driving video source.
  peakstate: { top: 'Video modules', sub: 'Sources' },
  // DOOM — single-instance interactive video module. Cards are
  // keyboard-driven (focus-within ring) + CV-gate-driven; one host
  // per rack, spectators see the framebuffer over Yjs awareness.
  doom: { top: 'Video modules', sub: 'Sources' },
  // NIBBLES — QBasic Nibbles snake game module. Video source with CV
  // gate outputs (pellet/death/dir_change), length CV, + dual audio.
  nibbles: { top: 'Video modules', sub: 'Sources' },
  // QBERT — Q*Bert (Gottlieb 1982) arcade emulator. CV-only control
  // (coin/start gates + joy_x/joy_y CV) + event-gate outputs
  // (move/die/level) alongside the video + mono audio.
  qbert: { top: 'Video modules', sub: 'Sources' },
  // VIDEOBOX — local-file video player with multiplayer playhead sync.
  videobox: { top: 'Video modules', sub: 'Sources' },
  // VIDEOVARISPEED — local-file player with performant varispeed transport.
  videovarispeed: { top: 'Video modules', sub: 'Sources' },

  // ───────── Video modules → Processors ─────────
  chroma: { top: 'Video modules', sub: 'Processors' },
  luma: { top: 'Video modules', sub: 'Processors' },
  // CHROMAKEY / LUMAKEY — proper 2-input compositors. Sit with the other
  // processors since they sit between sources and OUTPUT in a chain.
  chromakey: { top: 'Video modules', sub: 'Processors' },
  lumakey: { top: 'Video modules', sub: 'Processors' },
  colorizer: { top: 'Video modules', sub: 'Processors' },
  destructor: { top: 'Video modules', sub: 'Processors' },
  feedback: { top: 'Video modules', sub: 'Processors' },
  vdelay: { top: 'Video modules', sub: 'Processors' },
  // BACKDRAFT — video feedback generator (crossfade + delayed self-feedback
  // + LIGHTEN/DARKEN key masks). Sits with the other feedback processors.
  backdraft: { top: 'Video modules', sub: 'Processors' },
  monoglitch: { top: 'Video modules', sub: 'Processors' },
  reshaper: { top: 'Video modules', sub: 'Processors' },
  // SHAPEGEN — 3 video rasters → 3D-shape scene (extracted from FOXY).
  // Categorized under Processors because the inputs drive the shape
  // generation; the output is a rendered scene.
  shapegen: { top: 'Video modules', sub: 'Processors' },
  ruttetra: { top: 'Video modules', sub: 'Processors' },

  // ───────── Video modules → Utilities ─────────
  videoMixer: { top: 'Video modules', sub: 'Utilities' },
  videoOut: { top: 'Video modules', sub: 'Utilities' },
  // 4PLEXVID — 4-in / 4-out discrete video router (the video sibling of the
  // audio 4Plexer). Per-output selector knob + gate-advanced rotation.
  '4plexvid': { top: 'Video modules', sub: 'Utilities' },
  // SCOREBOARD — 4-digit neon 7-segment counter widget. SCORE + RESET gate
  // inputs; one COLOR knob; renders the count as a video signal.
  scoreboard: { top: 'Video modules', sub: 'Utilities' },
  // BENTBOX is a CRT-emulation display — sits with the other outputs even
  // though it also functions as a destructive processor (the bending stage).
  bentbox: { top: 'Video modules', sub: 'Utilities' },

  // ───────── Hybrid (audio + video output, or cross-domain tools) ─────────
  scope: { top: 'Hybrid', sub: 'Hybrid' },
  // RASTERIZE — the explicit audio→video raster mapper (crossing-the-streams
  // slice 1). Audio in, mono-video out; a cross-domain bridge module.
  rasterize: { top: 'Hybrid', sub: 'Hybrid' },
  wavviz: { top: 'Hybrid', sub: 'Hybrid' },
  swolevco: { top: 'Hybrid', sub: 'Hybrid' },
  wavecel: { top: 'Hybrid', sub: 'Hybrid' },
  // FOXY — hybrid audio-visual: SWOLEVCO→RASTERIZE→XYZ→live-wavetable→WAVECEL.
  foxy: { top: 'Hybrid', sub: 'Hybrid' },
  warrenspectrum: { top: 'Hybrid', sub: 'Hybrid' },
  // PONG — research-prototype game module. CV-in paddles + gate-out scores,
  // visual game state on the card. Sits in Hybrid alongside the other
  // audio-engine-bound modules that also draw rich visuals.
  pong: { top: 'Hybrid', sub: 'Hybrid' },
  // MODTRIS — research-prototype Tetris-clone game module. Gate-in controls
  // + gate-out events. Same bucket as PONG.
  modtris: { top: 'Hybrid', sub: 'Hybrid' },
  // FROGGER — research-prototype Frogger port. 5 CV-gate inputs (up/down/
  // left/right + start), 3 gate outputs (home/dead/level). Auto-starts on
  // module-spawn via a synthesized start_gate pulse. Same bucket as PONG /
  // MODTRIS.
  frogger: { top: 'Hybrid', sub: 'Hybrid' },
  // SM64 — sm64js pure-JS Super Mario 64 port (WTFPL). Single-instance
  // (maxInstances:1) per rack. Bucket alongside the other game modules.
  sm64: { top: 'Hybrid', sub: 'Hybrid' },
  // WAVESCULPT — hybrid 4-oscillator synth: stereo audio + 3D ribbon video.
  wavesculpt: { top: 'Hybrid', sub: 'Hybrid' },
  // Meta-domain organizational tools live here — they don't fit
  // cleanly under audio or video and the user can re-bucket on dev.
  sticky: { top: 'Hybrid', sub: 'Hybrid' },
  group: { top: 'Hybrid', sub: 'Hybrid' },
  cadillac: { top: 'Hybrid', sub: 'Hybrid' },
  livecode: { top: 'Hybrid', sub: 'Hybrid' },
  // Clocked runner — spawned programmatically by LIVECODE's clocked()
  // call. Listed alongside LIVECODE so users browsing the palette can
  // also spawn one manually (with an empty body) to be wired up by a
  // parent script later.
  clockedRunner: { top: 'Hybrid', sub: 'Hybrid' },
};

/** Look up a module's category, falling back to Uncategorized. */
export function categorize(type: string): CategoryEntry {
  return MODULE_CATEGORIES[type] ?? { top: 'Uncategorized', sub: 'Uncategorized' };
}

/** Minimal def shape the palette grouping helper needs. */
export interface DefLike {
  type: string;
  label: string;
}

export interface GroupedTop<D extends DefLike> {
  top: TopCategory;
  subs: Array<{ name: string; defs: D[] }>;
}

/**
 * Bucket a flat list of defs into nested [top → sub → defs] order,
 * preserving the canonical TOP_ORDER + SUB_ORDER and dropping empty
 * buckets. Unknown sub-categories (defensive) are appended after the
 * canonical ones, sorted alphabetically.
 */
export function groupDefs<D extends DefLike>(defs: readonly D[]): GroupedTop<D>[] {
  const byTop: Record<TopCategory, Record<string, D[]>> = {
    'Audio modules': {},
    'Video modules': {},
    Ports: {},
    MIDI: {},
    Hybrid: {},
    Uncategorized: {},
  };
  for (const def of defs) {
    const { top, sub } = categorize(def.type);
    (byTop[top][sub] ??= []).push(def);
  }

  const out: GroupedTop<D>[] = [];
  for (const top of TOP_ORDER) {
    const subs = byTop[top];
    const subNames = new Set(Object.keys(subs));
    const ordered: Array<{ name: string; defs: D[] }> = [];
    for (const sub of SUB_ORDER[top]) {
      const list = subs[sub];
      if (list && list.length > 0) {
        ordered.push({ name: sub, defs: list });
        subNames.delete(sub);
      }
    }
    for (const sub of [...subNames].sort()) {
      const list = subs[sub];
      if (list && list.length > 0) ordered.push({ name: sub, defs: list });
    }
    if (ordered.length > 0) out.push({ top, subs: ordered });
  }
  return out;
}
