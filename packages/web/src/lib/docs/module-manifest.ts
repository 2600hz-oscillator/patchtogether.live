// packages/web/src/lib/docs/module-manifest.ts
//
// Build-time module catalog. Reads packages/web/src/lib/audio/modules/*.ts
// and returns a structured manifest for the in-app docs site
// (/docs/modules and /docs/modules/[id]).
//
// Why a regex parser, not the TS compiler API or a runtime import:
//   1. The audio module factories import .wasm / worklet ?url assets that
//      only Vite can resolve — importing them from a +page.server.ts loader
//      would break SSR / prerender.
//   2. The module-def shape is enforced by AudioModuleDef + the
//      (intentionally simple) literal-init pattern the codebase uses, so a
//      handful of well-tested regexes are easier to reason about than a
//      partial AST walk.
//
// The parser is tolerant of registry additions: any export matching
// `export const <name>Def: AudioModuleDef = { ... };` is picked up. It's
// also tolerant of two computed-shape modules (mixmstrs uses helper
// functions to build inputs / params); for those we fall back to a
// hardcoded extractor. If all else fails we emit a placeholder card and
// surface the failure.

// Module sources are inlined at build time via Vite's `?raw` query.
// This is intentional: a runtime `fs.readdirSync` would chase the on-disk
// path of the *built* server bundle (.svelte-kit/output/server/chunks/...)
// rather than the source tree, breaking prerender. With `import.meta.glob`,
// Vite walks the registry, embeds each module file's source text, and
// resolves all paths at build time.
const MODULE_SOURCES = import.meta.glob('../audio/modules/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface ManifestPort {
  id: string;
  type: string;
  paramTarget?: string;
  note?: string;
}

export interface ManifestParam {
  id: string;
  label: string;
  defaultValue: number | null;
  min: number | null;
  max: number | null;
  curve: string;
  units?: string;
}

export interface ManifestModule {
  file: string;
  sourceUrl: string;
  type: string;
  label: string;
  category: string;
  description: string;
  schemaVersion?: number;
  maxInstances?: number;
  inputs: ManifestPort[];
  outputs: ManifestPort[];
  params: ManifestParam[];
}

export interface Manifest {
  generatedAt: string;
  moduleCount: number;
  categories: string[];
  modules: ManifestModule[];
  warnings: string[];
}

const SRC_BASE =
  'https://github.com/2600hz-oscillator/patchtogether.live/blob/main/packages/web/src/lib/audio/modules';

const DESCRIPTIONS: Record<string, string> = {
  analogVco: 'Analog-style oscillator with saw / square / triangle / sine outputs and FM input.',
  wavetableVco:
    'Wavetable oscillator that morphs saw -> square -> triangle -> sine across a 16-frame table.',
  audioOut:
    'Terminal stereo output. Two mono inputs (L, R) routed to the host AudioContext destination.',
  vca: 'Voltage-controlled amplifier. Multiplies the audio input by base + (cv * cvAmount).',
  mixer: 'Four-channel mono summing mixer with master gain.',
  adsr: 'Gate-triggered attack-decay-sustain-release envelope. Outputs CV.',
  filter:
    'Multi-mode resonant filter (low / band / high). CV inputs sum into cutoff and resonance.',
  reverb: 'Algorithmic reverb. Size / damp / mix.',
  scope:
    '2-channel passthrough oscilloscope. Inputs flow unchanged to outputs while an AnalyserNode samples for display.',
  sequencer: '32-step sequencer with internal BPM clock or external clock input.',
  lfo: 'Clockable LFO with four phase outputs (0deg / 90deg / 180deg / 270deg).',
  cartesian: '4x4 grid sequencer. Steps via clock; X/Y CV inputs scrub freely across the grid.',
  destroy: 'Bitcrusher + decimator distortion.',
  qbrt: 'Stereo state-variable filter with vactrol-style ping input.',
  drummergirl: 'Gate-triggered drum voice (kick / snare / hat morph).',
  meowbox:
    'Gate-triggered cat-vocal synth voice (formant bank + harmonic + noise excitation).',
  mixmstrs:
    'Singleton 4xstereo mixer with EQ, compressor, two stereo aux sends/returns. 37 params.',
  timelorde: 'Singleton master clock. Internal or external BPM, twelve clock-divider outputs.',
  charlottesEchos: 'Destructive multi-head stereo delay. Pitch-shifted feedback with decay.',
  riotgirls:
    '4-voice drum machine. 3x DRUMMERGIRL + 1x Wavetable VCO/ADSR/VCA, per-voice equal-power pan, master QBRT filter, stereo out.',
  score: 'Sheet-music sequencer. 8-bar treble-clef staff, click to place notes. Outputs pitch / gate / env (ADSR x dynamic) / clock.',
};

const PORT_NOTES: Record<string, string> = {
  'analogVco.pitch': 'V/oct pitch input.',
  'analogVco.fm': 'Audio-rate FM input (depth set by FM param).',
  'analogVco.saw': 'Sawtooth output.',
  'analogVco.square': 'Square output (PW-modulated).',
  'analogVco.triangle': 'Triangle output.',
  'analogVco.sine': 'Sine output.',
  'wavetableVco.pitch': 'V/oct pitch input.',
  'wavetableVco.fm': 'Audio-rate FM input.',
  'wavetableVco.wavePos': 'CV -> wavetable scan position.',
  'wavetableVco.audio': 'Mixed wavetable output.',
  'audioOut.L': 'Mono L -> host destination L.',
  'audioOut.R': 'Mono R -> host destination R.',
  'vca.audio': 'Audio input (gets multiplied).',
  'vca.cv': 'Modulation CV (gain control).',
  'mixer.in1': 'Channel 1 input.',
  'mixer.in2': 'Channel 2 input.',
  'mixer.in3': 'Channel 3 input.',
  'mixer.in4': 'Channel 4 input.',
  'adsr.gate': 'Triggers attack -> decay -> sustain on rising edge; release on falling.',
  'adsr.env': 'Envelope CV out (0..1).',
  'filter.audio': 'Audio in.',
  'filter.cutoff': 'CV -> cutoff freq.',
  'filter.res': 'CV -> resonance.',
  'reverb.audio': 'Pre-reverb mono in / wet+dry mix out.',
  'scope.ch1': 'Channel 1 in.',
  'scope.ch2': 'Channel 2 in.',
  'scope.ch1_out': 'Channel 1 passthrough.',
  'scope.ch2_out': 'Channel 2 passthrough.',
  'sequencer.clock': 'External clock (rising edges advance the step pointer).',
  'sequencer.pitch': 'V/oct pitch out.',
  'sequencer.gate': 'Gate out (high while step is on).',
  'lfo.clock': 'External clock - locks LFO rate to incoming pulses.',
  'lfo.rate': 'CV -> rate AudioParam.',
  'lfo.shape': 'CV -> wave shape.',
  'lfo.phase0': 'LFO at 0deg.',
  'lfo.phase90': 'LFO at 90deg.',
  'lfo.phase180': 'LFO at 180deg.',
  'lfo.phase270': 'LFO at 270deg.',
  'cartesian.clock': 'Step advance (rising edge).',
  'cartesian.x_cv': 'CV scrub on the X axis.',
  'cartesian.y_cv': 'CV scrub on the Y axis.',
  'cartesian.pitch': 'V/oct pitch out.',
  'cartesian.gate': 'Gate out.',
  'destroy.audio': 'Audio in / out.',
  'destroy.decimate': 'CV -> decimation factor.',
  'destroy.bits': 'CV -> bit depth.',
  'destroy.wet': 'CV -> wet/dry mix.',
  'qbrt.L': 'Stereo input L.',
  'qbrt.R': 'Stereo input R.',
  'qbrt.ping': 'Gate -> click excitation.',
  'qbrt.cutoff': 'CV -> cutoff.',
  'qbrt.resonance': 'CV -> resonance.',
  'qbrt.mode': 'CV -> filter mode.',
  'qbrt.pingDecay': 'CV -> ping envelope decay.',
  'drummergirl.gate': 'Trigger.',
  'drummergirl.pitch': 'CV -> pitch.',
  'drummergirl.tone': 'CV -> tone.',
  'drummergirl.shape': 'CV -> shape.',
  'drummergirl.audio': 'Mono drum out.',
  'meowbox.gate': 'Trigger.',
  'meowbox.pitch': 'CV -> pitch.',
  'meowbox.morph': 'CV -> vowel morph.',
  'meowbox.decay': 'CV -> decay.',
  'meowbox.level': 'CV -> output level.',
  'meowbox.L': 'Stereo L out.',
  'meowbox.R': 'Stereo R out.',
  'timelorde.clock':
    'External clock - snaps 1x to incoming rising edges; falls back to internal BPM after ~2 master periods.',
  'timelorde.1x': 'Master tempo gate.',
  'charlottesEchos.L': 'Stereo L in / out.',
  'charlottesEchos.R': 'Stereo R in / out.',
  'charlottesEchos.delay': 'CV -> delay time.',
  'riotgirls.outL': 'Stereo L out.',
  'riotgirls.outR': 'Stereo R out.',
  'score.clock': 'External 16th-rate clock; rising edges advance one slot. Disconnect -> internal BPM.',
  'score.attack': 'CV -> ADSR attack.',
  'score.decay': 'CV -> ADSR decay.',
  'score.sustain': 'CV -> ADSR sustain.',
  'score.release': 'CV -> ADSR release.',
  'score.pitch': 'V/oct pitch out (mono).',
  'score.gate': 'Gate out, held for the notated duration of each note.',
  'score.env': 'Envelope out: ADSR x dynamic (mf=0.55, ff=0.95, etc).',
};

const CAT_ORDER = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output'];

function stripComments(src: string): string {
  let out = '';
  let inStr: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < src.length) {
        out += src[++i];
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      if (i < src.length) out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

function sliceBalancedBraces(src: string, startIdx: number): string | null {
  if (src[startIdx] !== '{') return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx + 1, i);
    }
  }
  return null;
}

function extractArray(src: string, key: string): string {
  const re = new RegExp(`\\b${key}:\\s*\\[`);
  const m = re.exec(src);
  if (!m) return '';
  let depth = 0;
  let i = m.index + m[0].length - 1;
  const start = i + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
  }
  return '';
}

function splitTopLevelObjects(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let inStr: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      cur += c;
      if (c === '\\' && i + 1 < body.length) {
        cur += body[++i];
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      cur += c;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      cur += c;
      if (depth === 0) {
        if (cur.trim()) out.push(cur);
        cur = '';
        continue;
      }
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parsePortList(body: string): ManifestPort[] {
  if (!body.trim()) return [];
  const out: ManifestPort[] = [];
  const parts = splitTopLevelObjects(body);
  for (const part of parts) {
    const id = (part.match(/\bid:\s*['"]([^'"]+)['"]/) || [])[1];
    const type = (part.match(/\btype:\s*['"]([^'"]+)['"]/) || [])[1];
    const paramTarget = (part.match(/paramTarget:\s*['"]([^'"]+)['"]/) || [])[1];
    if (id && type) {
      const port: ManifestPort = { id, type };
      if (paramTarget) port.paramTarget = paramTarget;
      out.push(port);
    }
  }
  return out;
}

function parseParamList(body: string): ManifestParam[] {
  if (!body.trim()) return [];
  const out: ManifestParam[] = [];
  const parts = splitTopLevelObjects(body);
  for (const part of parts) {
    const id = (part.match(/\bid:\s*['"]([^'"]+)['"]/) || [])[1];
    const label = (part.match(/\blabel:\s*['"`]([^'"`]+)['"`]/) || [])[1];
    const dv = (part.match(/defaultValue:\s*(-?\d+(?:\.\d+)?)/) || [])[1];
    const min = (part.match(/\bmin:\s*(-?\d+(?:\.\d+)?)/) || [])[1];
    const max = (part.match(/\bmax:\s*(-?\d+(?:\.\d+)?)/) || [])[1];
    const curve = (part.match(/\bcurve:\s*['"]([^'"]+)['"]/) || [])[1];
    const units = (part.match(/\bunits:\s*['"]([^'"]+)['"]/) || [])[1];
    if (id) {
      out.push({
        id,
        label: label || id,
        defaultValue: dv === undefined ? null : Number(dv),
        min: min === undefined ? null : Number(min),
        max: max === undefined ? null : Number(max),
        curve: curve || 'linear',
        ...(units ? { units } : {}),
      });
    }
  }
  return out;
}

function synthesizeFromBuildHelper(
  type: string,
): { inputs: ManifestPort[]; params: ManifestParam[] } | null {
  if (type === 'mixmstrs') {
    const params: ManifestParam[] = [];
    for (const ch of [1, 2, 3, 4]) {
      params.push({ id: `ch${ch}_volume`, label: `${ch}V`, defaultValue: 0.8, min: 0, max: 1, curve: 'linear' });
      params.push({ id: `ch${ch}_low`, label: `${ch}Lo`, defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'dB' });
      params.push({ id: `ch${ch}_mid`, label: `${ch}Md`, defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'dB' });
      params.push({ id: `ch${ch}_high`, label: `${ch}Hi`, defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'dB' });
      params.push({ id: `ch${ch}_thresh`, label: `${ch}Th`, defaultValue: -12, min: -36, max: 0, curve: 'linear', units: 'dB' });
      params.push({ id: `ch${ch}_ratio`, label: `${ch}Rt`, defaultValue: 2, min: 1, max: 10, curve: 'linear' });
      params.push({ id: `ch${ch}_compEnable`, label: `${ch}Cp`, defaultValue: 0, min: 0, max: 1, curve: 'discrete' });
      params.push({ id: `ch${ch}_send1`, label: `${ch}S1`, defaultValue: 0, min: 0, max: 1, curve: 'linear' });
      params.push({ id: `ch${ch}_send2`, label: `${ch}S2`, defaultValue: 0, min: 0, max: 1, curve: 'linear' });
    }
    params.push({ id: 'master_volume', label: 'Master', defaultValue: 0.8, min: 0, max: 1, curve: 'linear' });
    const inputs: ManifestPort[] = [
      { id: 'ch1L', type: 'audio' }, { id: 'ch1R', type: 'audio' },
      { id: 'ch2L', type: 'audio' }, { id: 'ch2R', type: 'audio' },
      { id: 'ch3L', type: 'audio' }, { id: 'ch3R', type: 'audio' },
      { id: 'ch4L', type: 'audio' }, { id: 'ch4R', type: 'audio' },
      { id: 'ret1L', type: 'audio' }, { id: 'ret1R', type: 'audio' },
      { id: 'ret2L', type: 'audio' }, { id: 'ret2R', type: 'audio' },
    ];
    for (const p of params) inputs.push({ id: p.id, type: 'cv', paramTarget: p.id });
    return { inputs, params };
  }
  if (type === 'riotgirls') {
    const params: ManifestParam[] = [];
    for (const v of [1, 2, 3]) {
      params.push({ id: `v${v}_pitch`,  label: `${v}P`, defaultValue: 0,    min: -36,   max: 36,  curve: 'linear', units: 'st' });
      params.push({ id: `v${v}_tone`,   label: `${v}T`, defaultValue: 0.3,  min: 0,     max: 1,   curve: 'linear' });
      params.push({ id: `v${v}_shape`,  label: `${v}S`, defaultValue: 0.3,  min: 0,     max: 1,   curve: 'linear' });
      params.push({ id: `v${v}_volume`, label: `${v}V`, defaultValue: 1.0,  min: 0,     max: 2.0, curve: 'linear' });
      params.push({ id: `v${v}_decay`,  label: `${v}D`, defaultValue: 0.15, min: 0.001, max: 0.5, curve: 'log',    units: 's' });
    }
    params.push({ id: 'v4_tune',     label: '4T',  defaultValue: 0,     min: -36,    max: 36,  curve: 'linear', units: 'st' });
    params.push({ id: 'v4_fine',     label: '4F',  defaultValue: 0,     min: -100,   max: 100, curve: 'linear', units: '¢' });
    params.push({ id: 'v4_wavePos',  label: '4W',  defaultValue: 0,     min: 0,      max: 1,   curve: 'linear' });
    params.push({ id: 'v4_fmAmount', label: '4FM', defaultValue: 0,     min: 0,      max: 1,   curve: 'linear' });
    params.push({ id: 'v4_attack',   label: '4A',  defaultValue: 0.005, min: 0.001,  max: 2.0, curve: 'log',    units: 's' });
    params.push({ id: 'v4_decay',    label: '4D',  defaultValue: 0.1,   min: 0.001,  max: 4.0, curve: 'log',    units: 's' });
    params.push({ id: 'v4_sustain',  label: '4S',  defaultValue: 0.7,   min: 0,      max: 1,   curve: 'linear' });
    params.push({ id: 'v4_release',  label: '4R',  defaultValue: 0.3,   min: 0.001,  max: 8.0, curve: 'log',    units: 's' });
    params.push({ id: 'v4_volume',   label: '4V',  defaultValue: 0.8,   min: 0,      max: 2.0, curve: 'linear' });
    for (const v of [1, 2, 3, 4]) {
      params.push({ id: `v${v}_pan`,   label: `${v}Pn`, defaultValue: 0, min: -1, max: 1, curve: 'linear' });
      params.push({ id: `v${v}_sendA`, label: `${v}sA`, defaultValue: 0, min:  0, max: 1, curve: 'linear' });
      params.push({ id: `v${v}_sendB`, label: `${v}sB`, defaultValue: 0, min:  0, max: 1, curve: 'linear' });
    }
    params.push({ id: 'bc_decimate', label: 'bcDec',  defaultValue: 1,  min: 1, max: 64, curve: 'linear' });
    params.push({ id: 'bc_bits',     label: 'bcBits', defaultValue: 16, min: 1, max: 16, curve: 'linear' });
    params.push({ id: 'bc_wet',      label: 'bcWet',  defaultValue: 1,  min: 0, max: 1,  curve: 'linear' });
    params.push({ id: 'rv_size', label: 'rvSize', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' });
    params.push({ id: 'rv_damp', label: 'rvDamp', defaultValue: 0.3, min: 0, max: 1, curve: 'linear' });
    params.push({ id: 'rv_mix',  label: 'rvMix',  defaultValue: 0.3, min: 0, max: 1, curve: 'linear' });
    params.push({ id: 'flt_cutoff',    label: 'fCut', defaultValue: 18000, min: 20,    max: 20000, curve: 'log',    units: 'Hz' });
    params.push({ id: 'flt_resonance', label: 'fRes', defaultValue: 0.4,   min: 0,     max: 0.99,  curve: 'linear' });
    params.push({ id: 'flt_mode',      label: 'fMod', defaultValue: 0,     min: 0,     max: 1,     curve: 'linear' });
    params.push({ id: 'flt_pingDecay', label: 'fPng', defaultValue: 0.15,  min: 0.005, max: 0.5,   curve: 'log',    units: 's' });
    params.push({ id: 'returnA', label: 'retA', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' });
    params.push({ id: 'returnB', label: 'retB', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' });

    const inputs: ManifestPort[] = [];
    for (let v = 1; v <= 4; v++) inputs.push({ id: `trig${v}`,  type: 'gate' });
    for (let v = 1; v <= 4; v++) inputs.push({ id: `gate${v}`,  type: 'gate' });
    for (let v = 1; v <= 4; v++) inputs.push({ id: `pitch${v}`, type: 'pitch' });
    for (const v of [1, 2, 3]) {
      inputs.push({ id: `v${v}_tone`,   type: 'cv', paramTarget: `v${v}_tone` });
      inputs.push({ id: `v${v}_shape`,  type: 'cv', paramTarget: `v${v}_shape` });
      inputs.push({ id: `v${v}_volume`, type: 'cv', paramTarget: `v${v}_volume` });
      inputs.push({ id: `v${v}_decay`,  type: 'cv', paramTarget: `v${v}_decay` });
    }
    inputs.push({ id: 'v4_fm',      type: 'audio' });
    inputs.push({ id: 'v4_wavePos', type: 'cv', paramTarget: 'v4_wavePos' });
    inputs.push({ id: 'v4_attack',  type: 'cv', paramTarget: 'v4_attack' });
    inputs.push({ id: 'v4_decay',   type: 'cv', paramTarget: 'v4_decay' });
    inputs.push({ id: 'v4_sustain', type: 'cv', paramTarget: 'v4_sustain' });
    inputs.push({ id: 'v4_release', type: 'cv', paramTarget: 'v4_release' });
    inputs.push({ id: 'v4_volume',  type: 'cv', paramTarget: 'v4_volume' });
    for (let v = 1; v <= 4; v++) {
      inputs.push({ id: `v${v}_pan`,   type: 'cv', paramTarget: `v${v}_pan` });
      inputs.push({ id: `v${v}_sendA`, type: 'cv', paramTarget: `v${v}_sendA` });
      inputs.push({ id: `v${v}_sendB`, type: 'cv', paramTarget: `v${v}_sendB` });
    }
    inputs.push({ id: 'bc_decimate', type: 'cv', paramTarget: 'bc_decimate' });
    inputs.push({ id: 'bc_bits',     type: 'cv', paramTarget: 'bc_bits' });
    inputs.push({ id: 'bc_wet',      type: 'cv', paramTarget: 'bc_wet' });
    inputs.push({ id: 'rv_size',     type: 'cv', paramTarget: 'rv_size' });
    inputs.push({ id: 'rv_damp',     type: 'cv', paramTarget: 'rv_damp' });
    inputs.push({ id: 'rv_mix',      type: 'cv', paramTarget: 'rv_mix' });
    inputs.push({ id: 'flt_cutoff',    type: 'cv', paramTarget: 'flt_cutoff' });
    inputs.push({ id: 'flt_resonance', type: 'cv', paramTarget: 'flt_resonance' });
    inputs.push({ id: 'flt_mode',      type: 'cv', paramTarget: 'flt_mode' });
    inputs.push({ id: 'flt_pingDecay', type: 'cv', paramTarget: 'flt_pingDecay' });
    inputs.push({ id: 'returnA', type: 'cv', paramTarget: 'returnA' });
    inputs.push({ id: 'returnB', type: 'cv', paramTarget: 'returnB' });
    return { inputs, params };
  }
  return null;
}

function describePort(moduleType: string, portId: string, port: ManifestPort): string {
  const key = `${moduleType}.${portId}`;
  if (PORT_NOTES[key]) return PORT_NOTES[key];
  switch (port.type) {
    case 'audio':
      return 'Audio signal.';
    case 'pitch':
      return 'V/oct pitch CV.';
    case 'gate':
      return 'Gate signal (rising/falling edge).';
    case 'cv':
      return port.paramTarget ? `CV -> ${port.paramTarget} param.` : 'Control voltage.';
    default:
      return port.type;
  }
}

function describeModule(type: string): string {
  return (
    DESCRIPTIONS[type] ||
    `Audio module (${type}). Add a one-line description in packages/web/src/lib/docs/module-manifest.ts:DESCRIPTIONS.`
  );
}

interface RawModule {
  file: string;
  sourceUrl: string;
  type?: string;
  label?: string;
  category?: string;
  schemaVersion?: number;
  maxInstances?: number;
  inputs: ManifestPort[];
  outputs: ManifestPort[];
  params: ManifestParam[];
}

function readModule(file: string, rawSrc: string): RawModule | null {
  const fullSrc = stripComments(rawSrc);

  // Match either `export const xxxDef: AudioModuleDef = {` OR a non-exported
  // `const xxxDef: AudioModuleDef = {` — the latter case picks up internal
  // base defs (e.g. lfo's `baseDef` that gets spread into a wrapper
  // SyncedModuleDef). Catalog dedupes by `type`, so two matches in one file
  // collapse to one entry.
  const declRe = /(?:export\s+)?const\s+(\w+Def)\s*:\s*(?:AudioModuleDef|SyncedModuleDef)\s*=\s*\{/;
  const declMatch = declRe.exec(fullSrc);
  if (!declMatch) return null;
  const startBrace = declMatch.index + declMatch[0].length - 1;
  const src = sliceBalancedBraces(fullSrc, startBrace);
  if (!src) return null;

  const grabStr = (key: string): string | undefined => {
    const re = new RegExp(`\\b${key}:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`);
    const m = src.match(re);
    return m ? m[2] : undefined;
  };
  const grabNum = (key: string): number | undefined => {
    const re = new RegExp(`\\b${key}:\\s*(\\d+)`);
    const m = src.match(re);
    return m ? Number(m[1]) : undefined;
  };

  const out: RawModule = {
    file,
    sourceUrl: `${SRC_BASE}/${file}`,
    type: grabStr('type'),
    label: grabStr('label'),
    category: grabStr('category'),
    schemaVersion: grabNum('schemaVersion'),
    maxInstances: grabNum('maxInstances'),
    inputs: parsePortList(extractArray(src, 'inputs')),
    outputs: parsePortList(extractArray(src, 'outputs')),
    params: parseParamList(extractArray(src, 'params')),
  };

  // Inputs are computed (e.g. `inputs: INPUTS` or `inputs: buildInputs()`)
  // when the literal-array extractor returns nothing — fall back to the
  // hard-coded synthesizer keyed by module type.
  if (out.inputs.length === 0 && out.type) {
    const synth = synthesizeFromBuildHelper(out.type);
    if (synth) {
      out.inputs = synth.inputs;
      out.params = synth.params;
    }
  }

  return out;
}

/**
 * Build the manifest by parsing every module-def file under
 * packages/web/src/lib/audio/modules/. Sources come from a Vite glob, which
 * inlines them at build time so the function works identically during
 * `vite build` (prerender), `vite dev` (live reload), and `vitest run`.
 *
 * The optional `sources` parameter overrides the inlined glob — used by
 * unit tests that want to feed synthetic registry input.
 */
export function buildModuleManifest(
  sources: Record<string, string> = MODULE_SOURCES,
): Manifest {
  const entries = Object.entries(sources)
    .map(([path, src]) => {
      const file = path.split('/').pop() ?? path;
      return { file, src };
    })
    .filter(({ file }) => {
      if (!file.endsWith('.ts') || file === 'index.ts') return false;
      // Skip companion / test files — they live next to module sources but
      // aren't module definitions themselves.
      if (file.endsWith('.test.ts')) return false;
      if (file.endsWith('-state.ts')) return false;
      if (file.endsWith('-data.ts')) return false;
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file));

  const modules: ManifestModule[] = [];
  const warnings: string[] = [];

  for (const { file, src } of entries) {
    const m = readModule(file, src);
    if (!m) {
      warnings.push(`skipping ${file}: no AudioModuleDef found`);
      continue;
    }
    if (!m.type || !m.label || !m.category) {
      warnings.push(`skipping ${file}: missing required field (type/label/category)`);
      continue;
    }
    const type = m.type;
    modules.push({
      file: m.file,
      sourceUrl: m.sourceUrl,
      type,
      label: m.label,
      category: m.category,
      schemaVersion: m.schemaVersion,
      maxInstances: m.maxInstances,
      description: describeModule(type),
      inputs: m.inputs.map((p) => ({ ...p, note: describePort(type, p.id, p) })),
      outputs: m.outputs.map((p) => ({ ...p, note: describePort(type, p.id, p) })),
      params: m.params,
    });
  }

  modules.sort((a, b) => {
    const ai = CAT_ORDER.indexOf(a.category);
    const bi = CAT_ORDER.indexOf(b.category);
    const aj = ai < 0 ? 999 : ai;
    const bj = bi < 0 ? 999 : bi;
    if (aj !== bj) return aj - bj;
    return a.label.localeCompare(b.label);
  });

  return {
    generatedAt: new Date().toISOString(),
    moduleCount: modules.length,
    categories: [...new Set(modules.map((m) => m.category))],
    modules,
    warnings,
  };
}
