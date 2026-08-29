// patch-panel-labels.ts
//
// Helpers that convert a module's port list into the panel's
// verbose-labeled, grouped row list. Two responsibilities:
//
//  1. Turn a port id into the verbose UI label. Default: upper-case the id,
//     drop the redundant `_in`/`_out` direction suffix (every surface that
//     prints a label already shows direction structurally — see
//     DIRECTION_SUFFIX) and read remaining underscores as spaces. A small
//     abbreviation table expands hardware-conventional shorthand like
//     'sus' → 'SUSTAIN', 'rv_size' → 'REVERB SIZE'. Cards may pass an explicit
//     `label` — or the def may declare `PortDef.label` — to override entirely.
//
//  2. Bucket ports by cable type for the auto-grouping panel layout
//     (Gates → Pitches → CV → Audio → Poly).
//
// The verbose-label rule:
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
  // A port called `ping` is the TRIGGER that excites a resonator (qbrt's
  // only consumer); the DECAY TIME is a separate `pingDecay` port, which
  // camelCase-splits to 'PING DECAY' on its own. Mapping the bare stem to
  // 'PING DECAY' printed the same label on both jacks and named the trigger
  // after the knob.
  ping: 'PING',
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

/**
 * A trailing DIRECTION suffix on a port id (`trigger_in`, `audio_out`).
 *
 * It is REDUNDANT on every surface that prints a jack label: each one already
 * states the direction structurally — the drill-down splits INPUTS from
 * OUTPUTS, the rear card has an `in` column and an `out` column plus a `←`/`→`
 * glyph per hole, and the back panel heads its two columns `in` / `out`. So
 * `TRIGGER IN` next to a `←` says it twice and spends label width doing it.
 *
 * COLLISION POLICY (deliberate, stated because it is the obvious objection):
 * stripping makes some pairs read the same — SAMPLE-HOLD declares `cv_in` AND
 * `cv_out`, so both become `CV`. That is CORRECT here: the two are the same
 * signal, named once, and they are never ambiguous IN PLACE because the
 * surfaces above separate them by RAIL POSITION and GLYPH before a single
 * character of label is drawn. A label only has to disambiguate WITHIN its own
 * rail — and no module declares two same-stem ports on the SAME side.
 * (Anything that ever does should author an explicit `PortDef.label`.)
 */
const DIRECTION_SUFFIX = /_(?:in|out)$/;

function expandStem(stem: string): string {
  // Strip the redundant direction suffix FIRST — but never down to nothing
  // (a port literally called `_in` keeps its stem rather than losing its name).
  const stripped = stem.replace(DIRECTION_SUFFIX, '');
  const base = stripped.length > 0 ? stripped : stem;

  const lower = base.toLowerCase();
  if (ABBREV_TO_VERBOSE[lower]) return ABBREV_TO_VERBOSE[lower];
  // wavePos -> WAVE POS style: split on lower→upper, then upper-case. Remaining
  // UNDERSCORES become spaces: they are id syntax, not part of the word, and
  // the lane drill-down (which calls resolveVerboseLabel raw, unlike the rear
  // card's tidyLabel) was printing `YIQ_Y` / `AUDIO_L` at the user.
  const split = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_+/g, ' ');
  return split.trim().toUpperCase();
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
 * THE hover/aria text naming what a patched jack is connected to.
 *
 * `← a, b` for an input, `→ a, b` for an output. Returns undefined for
 * an unpatched jack (no remotes), which every caller renders as "no title".
 *
 * ARROW ONLY — no FROM/TO word (owner, #2264: "we don't need to see the
 * 'from'"). The glyph alone carries the direction, the same way the rear
 * card's chips and hole glyphs already do, and the label width it frees goes
 * to the remote names — which are now the user's own renames when set.
 *
 * ⚠ BOTH DIRECTIONS JOIN THE FULL LIST. The input side used to print
 * `remotes[0]` and silently drop the rest, on the premise — stated in its own
 * docstring — that "an INPUT takes one cable". That is true of a MONO input and
 * FALSE of a COLLAPSED STEREO JACK, which is one jack over two ports, each
 * taking its own cable. The owner's ES-9 rack is exactly that case: `RET1` is
 * fed by `es9.in14` on its L leg and `es9.in13` on its R, so the jack read
 * `← FROM es-9.IN14` and the second source was invisible — while the matching
 * `SEND 1` output correctly read `→ TO es-9.OUT3, es-9.OUT4`. The asymmetry was
 * the bug; the arrow is now the ONLY thing that differs between the two.
 *
 * ONE implementation, called by every surface. `PatchPanel.patchTitle` and
 * `RearCard.holeTitle` each had their own copy of the truncating line, so the
 * single premise above produced the same defect in two places — which is the
 * reason this lives here rather than being fixed twice.
 *
 * The caller supplies `remotes` already unioned across a collapsed pair's legs
 * (L leg first, then R), so the order is deterministic and reads L-to-R.
 */
export function remoteEndpointsTitle(
  direction: 'input' | 'output',
  remotes: readonly string[],
): string | undefined {
  if (remotes.length === 0) return undefined;
  return `${direction === 'input' ? '←' : '→'} ${remotes.join(', ')}`;
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
