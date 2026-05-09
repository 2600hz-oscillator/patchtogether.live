// patch-panel-labels.ts
//
// Helpers that convert a module's port list into the panel's
// verbose-labeled, grouped row list. Two responsibilities:
//
//  1. Turn a port id into the verbose UI label. Default: upper-case the id.
//     A small abbreviation table expands hardware-conventional shorthand
//     like 'sus' → 'SUSTAIN', 'rv_size' → 'REVERB SIZE'. Cards may pass an
//     explicit `label` to override entirely.
//
//  2. Bucket ports by cable type for the auto-grouping panel layout
//     (Gates → Pitches → CV → Audio → Poly).
//
// The verbose-label rule from .myrobots/plans/ui-patch-panel-refactor.md:
// full word default, with hardware-convention abbreviations like FM, PW,
// L, R left as-is.

export interface PortDescriptor {
  id: string;
  /** When set, used verbatim (after uppercasing). Otherwise derived from id. */
  label?: string;
  /** Cable color; defaults to 'audio' if not specified. */
  cable?: string;
}

export interface GroupedPorts {
  cable: string;
  /** Group header — "Gates", "Pitches", "CV", "Audio", "Poly". */
  label: string;
  ports: PortDescriptor[];
}

// Abbreviations -> verbose. Keys are the lowercased id stem (after
// stripping voice prefixes like 'v1_'). Hardware-convention forms like
// FM/PW/L/R/HZ get a passthrough so they're not over-expanded.
//
// Adding a new entry: prefer the most musical / least-jargon form. If a
// hardware abbrev is genuinely standard (FM, PW, CV), leave it.
const ABBREV_TO_VERBOSE: Record<string, string> = {
  // ADSR
  atk: 'ATTACK',
  attack: 'ATTACK',
  dcy: 'DECAY',
  decay: 'DECAY',
  sus: 'SUSTAIN',
  sustain: 'SUSTAIN',
  rel: 'RELEASE',
  release: 'RELEASE',
  // Filter
  cut: 'CUTOFF',
  cutoff: 'CUTOFF',
  res: 'RESONANCE',
  resonance: 'RESONANCE',
  // Gate / trigger / pitch
  gate: 'GATE',
  trg: 'TRIGGER',
  trig: 'TRIGGER',
  trigger: 'TRIGGER',
  pit: 'PITCH',
  pitch: 'PITCH',
  // VCA / utility
  vol: 'VOLUME',
  volume: 'VOLUME',
  pan: 'PAN',
  tone: 'TONE',
  ton: 'TONE',
  shape: 'SHAPE',
  shp: 'SHAPE',
  size: 'SIZE',
  siz: 'SIZE',
  damp: 'DAMP',
  dmp: 'DAMP',
  mix: 'MIX',
  wet: 'WET',
  dry: 'DRY',
  send: 'SEND',
  ret: 'RETURN',
  bits: 'BITS',
  bit: 'BITS',
  dec: 'DECIMATE',
  decimate: 'DECIMATE',
  rate: 'RATE',
  clk: 'CLOCK',
  clock: 'CLOCK',
  ping: 'PING DECAY',
  png: 'PING DECAY',
  mod: 'MODE',
  mode: 'MODE',
  thresh: 'THRESHOLD',
  ratio: 'RATIO',
  low: 'LOW',
  mid: 'MID',
  high: 'HIGH',
  hgh: 'HIGH',
  master: 'MASTER',
  // Stereo + special outputs
  out: 'OUT',
  audio: 'AUDIO',
  env: 'ENVELOPE',
  saw: 'SAW',
  sqr: 'SQUARE',
  square: 'SQUARE',
  tri: 'TRIANGLE',
  triangle: 'TRIANGLE',
  sin: 'SINE',
  sine: 'SINE',
  fine: 'FINE',
  tune: 'TUNE',
  tun: 'TUNE',
  fm: 'FM',
  pw: 'PW',
  pwm: 'PWM',
  cv: 'CV',
};

// Voice-prefix patterns we know about. Examples: 'v1_tone' → 'V1 TONE',
// 'v4_attack' → 'V4 ATTACK', 'ch1_volume' → 'CH1 VOLUME', 'flt_cutoff' →
// 'FILTER CUTOFF', 'rv_size' → 'REVERB SIZE', 'bc_decimate' → 'DESTROY
// DECIMATE'.
const PREFIX_TO_VERBOSE: Array<{ pattern: RegExp; expand: (m: RegExpMatchArray) => string }> = [
  { pattern: /^v(\d+)_(.+)$/, expand: (m) => `V${m[1]} ${expandStem(m[2]!)}` },
  { pattern: /^v(\d+)$/, expand: (m) => `V${m[1]}` },
  { pattern: /^ch(\d+)_(.+)$/, expand: (m) => `CH${m[1]} ${expandStem(m[2]!)}` },
  { pattern: /^ch(\d+)([LR])$/, expand: (m) => `CH${m[1]} ${m[2]}` },
  { pattern: /^ret(\d+)([LR])$/, expand: (m) => `RETURN ${m[1]} ${m[2]}` },
  { pattern: /^ret(\d+)_(.+)$/, expand: (m) => `RETURN ${m[1]} ${expandStem(m[2]!)}` },
  { pattern: /^flt_(.+)$/, expand: (m) => `FILTER ${expandStem(m[1]!)}` },
  { pattern: /^rv_(.+)$/, expand: (m) => `REVERB ${expandStem(m[1]!)}` },
  { pattern: /^bc_(.+)$/, expand: (m) => `DESTROY ${expandStem(m[1]!)}` },
  { pattern: /^send(\d+)([LR])$/, expand: (m) => `SEND ${m[1]} ${m[2]}` },
  { pattern: /^send(\d+)$/, expand: (m) => `SEND ${m[1]}` },
  { pattern: /^master([LR])$/, expand: (m) => `MASTER ${m[1]}` },
  { pattern: /^master_(.+)$/, expand: (m) => `MASTER ${expandStem(m[1]!)}` },
  { pattern: /^out([LR])$/, expand: (m) => `OUT ${m[1]}` },
  { pattern: /^lfo_(.+)$/, expand: (m) => `LFO ${expandStem(m[1]!)}` },
  { pattern: /^returnA$/i, expand: () => 'RETURN A' },
  { pattern: /^returnB$/i, expand: () => 'RETURN B' },
];

function expandStem(stem: string): string {
  const lower = stem.toLowerCase();
  if (ABBREV_TO_VERBOSE[lower]) return ABBREV_TO_VERBOSE[lower];
  // wavePos -> WAVE POSITION style: split on lower→upper, then upper-case.
  const split = stem.replace(/([a-z])([A-Z])/g, '$1 $2');
  return split.toUpperCase();
}

/**
 * Expand a port id (or use a passed override label) into the verbose UI
 * string. Public for the unit test.
 */
export function resolveVerboseLabel(port: PortDescriptor): string {
  if (port.label !== undefined && port.label !== null) {
    return port.label.toUpperCase();
  }
  const id = port.id;
  for (const { pattern, expand } of PREFIX_TO_VERBOSE) {
    const m = id.match(pattern);
    if (m) return expand(m);
  }
  return expandStem(id);
}

/**
 * Group a port list by its cable type, ordered Gates → Pitches → CV →
 * Audio → Poly. Each group emits its own header in the panel. Ports
 * within a group keep their original (declared) order.
 */
export function groupPortsByCableType(
  ports: PortDescriptor[],
  _direction: 'input' | 'output',
): GroupedPorts[] {
  // Stable group order — gates first (they're visually striking) then
  // pitch (which a user often reaches for next), then CVs (the bulk),
  // then audio, then poly. Unknown cable types fall to the end.
  const order = ['gate', 'pitch', 'cv', 'audio', 'polyPitchGate'];
  const labels: Record<string, string> = {
    gate: 'Gates',
    pitch: 'Pitches',
    cv: 'CV',
    audio: 'Audio',
    polyPitchGate: 'Poly',
  };
  const buckets = new Map<string, PortDescriptor[]>();
  for (const p of ports) {
    const cable = p.cable ?? 'audio';
    if (!buckets.has(cable)) buckets.set(cable, []);
    buckets.get(cable)!.push(p);
  }
  const out: GroupedPorts[] = [];
  for (const cable of order) {
    const bucket = buckets.get(cable);
    if (bucket && bucket.length > 0) {
      out.push({ cable, label: labels[cable] ?? cable.toUpperCase(), ports: bucket });
      buckets.delete(cable);
    }
  }
  // Anything left over (custom cable types).
  for (const [cable, bucket] of buckets) {
    out.push({ cable, label: cable.toUpperCase(), ports: bucket });
  }
  return out;
}
