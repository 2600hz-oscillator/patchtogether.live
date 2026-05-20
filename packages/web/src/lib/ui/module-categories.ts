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
  | 'Hybrid'
  | 'Uncategorized';

export interface CategoryEntry {
  top: TopCategory;
  /** Sub-category label. For 'Hybrid', sub is unused (flat list); we
   *  set it to 'Hybrid' for the schema's shape uniformity. */
  sub: string;
}

/** Canonical sub-category order per top category (drives menu order). */
export const SUB_ORDER: Record<TopCategory, readonly string[]> = {
  'Audio modules': ['VCOs', 'Utility', 'Effects', 'Mixing', 'End of chain'],
  'Video modules': ['Sources', 'Processors', 'Utilities'],
  Hybrid: ['Hybrid'],
  Uncategorized: ['Uncategorized'],
};

/** Top-level rendering order. */
export const TOP_ORDER: readonly TopCategory[] = [
  'Audio modules',
  'Video modules',
  'Hybrid',
  'Uncategorized',
];

/** First-cut classification map. Keys are ModuleDef.type ids. */
export const MODULE_CATEGORIES: Record<string, CategoryEntry> = {
  // ───────── Audio modules → VCOs (oscillators / audio sources) ─────────
  analogVco: { top: 'Audio modules', sub: 'VCOs' },
  wavetableVco: { top: 'Audio modules', sub: 'VCOs' },
  macrooscillator: { top: 'Audio modules', sub: 'VCOs' },
  dx7: { top: 'Audio modules', sub: 'VCOs' },
  meowbox: { top: 'Audio modules', sub: 'VCOs' },
  buggles: { top: 'Audio modules', sub: 'VCOs' },
  noise: { top: 'Audio modules', sub: 'VCOs' },
  drummergirl: { top: 'Audio modules', sub: 'VCOs' },
  rings: { top: 'Audio modules', sub: 'VCOs' },
  riotgirls: { top: 'Audio modules', sub: 'VCOs' },
  samsloop: { top: 'Audio modules', sub: 'VCOs' },
  // MIDI-CV-BUDDY emits pitch + gate + velocity CV from a hardware MIDI
  // controller — it's not an oscillator itself, but it's a SOURCE that
  // a player drives a synth voice from, so it sits in VCOs alongside
  // the other "first thing in the patch" modules.
  midiCvBuddy: { top: 'Audio modules', sub: 'VCOs' },
  // MIDICLOCK is the transport-only sibling of MIDI-CV-BUDDY — clock/run/
  // start/stop gates from an external MIDI device. Lives next to TIMELORDE
  // in Utility since its primary role is to drive TIMELORDE.clock.
  midiclock: { top: 'Audio modules', sub: 'Utility' },
  // HELM is a complete polyphonic synth voice (osc → filter → env → output)
  // — it lives in the VCOs section alongside DX7 and MACROOSCILLATOR as a
  // "first thing in the patch" sound source.
  helm: { top: 'Audio modules', sub: 'VCOs' },

  // ───────── Audio modules → Utility ─────────
  adsr: { top: 'Audio modules', sub: 'Utility' },
  lfo: { top: 'Audio modules', sub: 'Utility' },
  vca: { top: 'Audio modules', sub: 'Utility' },
  stereovca: { top: 'Audio modules', sub: 'Utility' },
  cartesian: { top: 'Audio modules', sub: 'Utility' },
  qbrt: { top: 'Audio modules', sub: 'Utility' },
  illogic: { top: 'Audio modules', sub: 'Utility' },
  unityscalemathematik: { top: 'Audio modules', sub: 'Utility' },
  analogLogicMaths: { top: 'Audio modules', sub: 'Utility' },
  veils: { top: 'Audio modules', sub: 'Utility' },
  peaks: { top: 'Audio modules', sub: 'Utility' },
  stages: { top: 'Audio modules', sub: 'Utility' },
  timelorde: { top: 'Audio modules', sub: 'Utility' },
  sequencer: { top: 'Audio modules', sub: 'Utility' },
  drumseqz: { top: 'Audio modules', sub: 'Utility' },
  polyseqz: { top: 'Audio modules', sub: 'Utility' },
  macseq: { top: 'Audio modules', sub: 'Utility' },
  score: { top: 'Audio modules', sub: 'Utility' },
  joystick: { top: 'Audio modules', sub: 'Utility' },

  // ───────── Audio modules → Effects ─────────
  filter: { top: 'Audio modules', sub: 'Effects' },
  blades: { top: 'Audio modules', sub: 'Effects' },
  reverb: { top: 'Audio modules', sub: 'Effects' },
  cloudseed: { top: 'Audio modules', sub: 'Effects' },
  charlottesEchos: { top: 'Audio modules', sub: 'Effects' },
  destroy: { top: 'Audio modules', sub: 'Effects' },
  warps: { top: 'Audio modules', sub: 'Effects' },
  shimmershine: { top: 'Audio modules', sub: 'Effects' },
  clouds: { top: 'Audio modules', sub: 'Effects' },

  // ───────── Audio modules → Mixing ─────────
  mixer: { top: 'Audio modules', sub: 'Mixing' },
  mixmstrs: { top: 'Audio modules', sub: 'Mixing' },
  attenumix: { top: 'Audio modules', sub: 'Mixing' },

  // ───────── Audio modules → End of chain ─────────
  audioOut: { top: 'Audio modules', sub: 'End of chain' },

  // ───────── Video modules → Sources ─────────
  cameraInput: { top: 'Video modules', sub: 'Sources' },
  lines: { top: 'Video modules', sub: 'Sources' },
  inwards: { top: 'Video modules', sub: 'Sources' },
  picturebox: { top: 'Video modules', sub: 'Sources' },
  shapes: { top: 'Video modules', sub: 'Sources' },
  shapedramps: { top: 'Video modules', sub: 'Sources' },

  // ───────── Video modules → Processors ─────────
  chroma: { top: 'Video modules', sub: 'Processors' },
  luma: { top: 'Video modules', sub: 'Processors' },
  colorizer: { top: 'Video modules', sub: 'Processors' },
  destructor: { top: 'Video modules', sub: 'Processors' },
  feedback: { top: 'Video modules', sub: 'Processors' },
  vdelay: { top: 'Video modules', sub: 'Processors' },
  monoglitch: { top: 'Video modules', sub: 'Processors' },
  ruttetra: { top: 'Video modules', sub: 'Processors' },

  // ───────── Video modules → Utilities ─────────
  videoMixer: { top: 'Video modules', sub: 'Utilities' },
  videoOut: { top: 'Video modules', sub: 'Utilities' },
  // BENTBOX is a CRT-emulation display — sits with the other outputs even
  // though it also functions as a destructive processor (the bending stage).
  bentbox: { top: 'Video modules', sub: 'Utilities' },

  // ───────── Hybrid (audio + video output, or cross-domain tools) ─────────
  scope: { top: 'Hybrid', sub: 'Hybrid' },
  vizvco: { top: 'Hybrid', sub: 'Hybrid' },
  wavviz: { top: 'Hybrid', sub: 'Hybrid' },
  swolevco: { top: 'Hybrid', sub: 'Hybrid' },
  wavecel: { top: 'Hybrid', sub: 'Hybrid' },
  warrenspectrum: { top: 'Hybrid', sub: 'Hybrid' },
  // PONG — research-prototype game module. CV-in paddles + gate-out scores,
  // visual game state on the card. Sits in Hybrid alongside the other
  // audio-engine-bound modules that also draw rich visuals.
  pong: { top: 'Hybrid', sub: 'Hybrid' },
  // MODTRIS — research-prototype Tetris-clone game module. Gate-in controls
  // + gate-out events. Same bucket as PONG.
  modtris: { top: 'Hybrid', sub: 'Hybrid' },
  // WAVESCULPT — hybrid 4-oscillator synth: stereo audio + 3D ribbon video.
  wavesculpt: { top: 'Hybrid', sub: 'Hybrid' },
  // Meta-domain organizational tools live here — they don't fit
  // cleanly under audio or video and the user can re-bucket on dev.
  sticky: { top: 'Hybrid', sub: 'Hybrid' },
  group: { top: 'Hybrid', sub: 'Hybrid' },
  livecode: { top: 'Hybrid', sub: 'Hybrid' },
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
