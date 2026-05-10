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
    'Singleton 4xstereo mixer with EQ, per-channel compressor (single-dial macro + power-user thresh/ratio), two stereo aux sends/returns. 41 params.',
  timelorde: 'Singleton master clock. Internal or external BPM, twelve clock-divider outputs.',
  charlottesEchos: 'Destructive multi-head stereo delay. Pitch-shifted feedback with decay.',
  riotgirls:
    '4-voice drum machine. 3x DRUMMERGIRL + 1x Wavetable VCO/ADSR/VCA, per-voice equal-power pan, master QBRT filter, stereo out.',
  score: 'Sheet-music sequencer. 8-bar treble-clef staff, click to place notes. Outputs pitch / gate / env (ADSR x dynamic) / clock.',
  drumseqz:
    '4-channel x 16-step drum sequencer with per-track Euclidean fills + quantized CV. Sister module to RIOTGIRLS.',
  polyseqz:
    'Polyphonic chord sequencer. 32-step grid; each step holds a root note + chord quality (maj/min/maj7/min7/dom7/sus2/sus4/dim/aug) + inversion (0/1/2) + voicing (closed/open/spread). Outputs the full 5-voice chord on a polyPitchGate cable. HUMANIZE knob adds per-voice timing offsets (linear/uniform at low values, chaotic clusters at high values) for a human-pianist feel. Tested as the chord source for DX7-style polyphonic synth voices.',
  vizvco:
    'Analog VCO sister of analogVco with a built-in West-Coast wavefolder + a mono-video scope output. Saw / square / triangle / sine outs feed a sin(x*(1+fold)) wave-shaper; the scope tap drives the shared waveform-video renderer.',
  wavviz:
    'Wavetable VCO sister of wavetableVco with a built-in West-Coast wavefolder + a mono-video scope output. Same morphing wavetable as wavetableVco; post-fold signal feeds both audio and scope-video out.',
  cameraInput:
    'Webcam input (LOCAL ONLY). Live <video> -> WebGL2 texture; gain / mirror / on params. The captured stream is local to your browser tab and is NOT sent to other rack-mates — collaborators see a presence badge ("user X has CAMERA active") via Y-awareness, not the video itself. Multiplayer streaming (WebRTC + SFU) is deferred to a future phase. Spec: .myrobots/plans/module-camera-input.md.',
  illogic:
    'Combined attenuverter / math / logic utility. 4 cv inputs feed bipolar attenuverters (-1..+1); post-attenuverter outputs sum into `sum` and `diff`. Inputs in1+in2 are also gate-thresholded (>= 0.5) and combined into AND/NAND/OR; in1 alone drives a NOT.',
  unityscalemathematik:
    'Bipolar CV-shaping utility with three independent channels: a UNITY scaler (input * atten) plus two attenuvert sections (A, B) whose curve knob morphs the response from linear (k=1) to steep exponential (k=3) via y = sign(x) * |x|^k * atten. Sign is preserved across the curve morph so the transform stays bipolar. CV inputs on every atten/curve knob — useful for envelope shaping, LFO sculpting, or driving any modulation through a tunable response curve.',
  dx7:
    'Pure-TypeScript 6-operator DX7-style FM synthesizer. 32 algorithms, 5-voice polyphony via the polyPitchGate cable, bundled bank of factory-inspired patches (E.PIANO 1, BASS 1, HARMONICA, STRINGS 1, MARIMBA, etc.), and a .syx file picker for loading custom 32-voice cartridge dumps (in-memory only). NOT a Plaits-backed implementation — see .myrobots/plans/dx7-and-polyphony.md for the design rationale.',
  noise:
    'Basic noise source. Three independent audio outputs — WHITE (full-spectrum), PINK (1/f, -3 dB/oct via Voss-McCartney), BROWN (1/f², -6 dB/oct via leaky-integrated white). All outputs share a single LEVEL knob. No CV inputs.',
  buggles:
    'Chaotic random voltage source — clean-room functional implementation of the Buchla / Make Noise wogglebug archetype. Internal "woggle clock" emits triggers at the RATE knob; outputs include SMOOTH (slewed random), STEPPED (sample-and-held), CLOCK (woggle gate), BURST (probabilistic clusters of 3-7 triggers), and RING (smooth × sub-osc ring-mod, the signature dirty texture). CV inputs modulate rate + chaos; EXT CLK replaces the internal scheduler when patched. The "Wogglebug" name is Make Noise\'s trademark — BUGGLES is our name; no proprietary schematic is copied.',
  stereovca:
    'Stereo VCA + ring modulator. Per-channel multiply: out_l = in_l * (strength_l + offset) * level; out_r = in_r * (strength_r + offset) * level. The same math behaves as VCA gain control when strength is slow (CV / LFO / envelope) and as ring modulation when strength is audio-rate — no mode toggle, the perceptual difference emerges from signal content. INDEPENDENT normalling: if in_r is unpatched it copies in_l (mono → stereo); if strength_r is unpatched it copies strength_l (one strength drives both VCAs). The two halves normal independently, so true-stereo audio + mono strength works, as does mono audio + per-side strength. Strength inputs declare cable type `audio` so audio-rate sources patch natively; LFOs / ADSRs reach them via the cv → audio upcast in graph/types.ts:canConnect.',
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
  'vca.audio': 'Audio input (gets multiplied) / main audio output.',
  'vca.cv': 'Modulation CV (gain control).',
  'vca.audio_inv':
    'Sign-inverted audio output: -out (phase-flipped audio). Useful for stereo widening, side-chain feedback prevention, and mid/side processing. Different operation from ADSR.env_inv (which is 1 - env on a unipolar envelope).',
  'mixer.in1': 'Channel 1 input.',
  'mixer.in2': 'Channel 2 input.',
  'mixer.in3': 'Channel 3 input.',
  'mixer.in4': 'Channel 4 input.',
  'adsr.gate': 'Triggers attack -> decay -> sustain on rising edge; release on falling.',
  'adsr.env': 'Envelope CV out (0..1).',
  'adsr.env_inv':
    'Inverted envelope CV out: 1 - env (unipolar 0..1 flip). When env=0 (rest), env_inv=1; when env=peak=1, env_inv=0. Useful for ducking, reverse-modulation, and "sidechain"-style envelopes. Different operation from VCA.audio_inv (which is a sign flip on bipolar audio).',
  'filter.audio': 'Audio in.',
  'filter.cutoff': 'CV -> cutoff freq.',
  'filter.res': 'CV -> resonance.',
  'reverb.audio': 'Pre-reverb mono in / wet+dry mix out.',
  'scope.ch1': 'Channel 1 in.',
  'scope.ch2': 'Channel 2 in.',
  'scope.ch1_out': 'Channel 1 passthrough.',
  'scope.ch2_out': 'Channel 2 passthrough.',
  'scope.out':
    'Mono-video output: pixel-equivalent of the on-card 2D scope render — both channels, scale/offset, range, XY/split mode, timeMs window. Driven by the cross-domain video bridge calling SCOPE.drawFrame() each video frame, so every scope control affects what downstream video modules see.',
  'scope.timeMs':
    'CV -> time window (ms across canvas width). Mirrors the Time fader 1:1 — the bridge re-reads the same params record so the on-card and video-out renders converge.',
  'scope.ch1Scale': 'CV -> ch1 vertical scale.',
  'scope.ch1Offset': 'CV -> ch1 vertical offset.',
  'scope.ch1Range':
    'CV -> ch1 range (≥0.5 switches to CV ±5 fullscale; <0.5 keeps audio ±1).',
  'scope.ch2Scale': 'CV -> ch2 vertical scale.',
  'scope.ch2Offset': 'CV -> ch2 vertical offset.',
  'scope.ch2Range': 'CV -> ch2 range (≥0.5 = CV ±5, <0.5 = audio ±1).',
  'scope.mode':
    'CV -> XY mode toggle. Any signal ≥ 0.5 flips to XY (ch1 horizontal, ch2 vertical); below 0.5 = split (two stacked traces).',
  'vizvco.pitch': 'V/oct pitch input.',
  'vizvco.fm': 'Audio-rate FM input.',
  'vizvco.foldAmount': 'CV -> wavefolder fold amount.',
  'vizvco.saw': 'Sawtooth output (post-wavefolder).',
  'vizvco.square': 'Square output (post-wavefolder).',
  'vizvco.triangle': 'Triangle output (post-wavefolder).',
  'vizvco.sine': 'Sine output (post-wavefolder).',
  'vizvco.scope':
    'Mono-video output: oscilloscope trace of the post-fold mixed waveform (RGB grayscale).',
  'wavviz.pitch': 'V/oct pitch input.',
  'wavviz.fm': 'Audio-rate FM input.',
  'wavviz.wavePos': 'CV -> wavetable scan position.',
  'wavviz.foldAmount': 'CV -> wavefolder fold amount.',
  'wavviz.audio': 'Post-fold mixed wavetable output.',
  'wavviz.scope':
    'Mono-video output: oscilloscope trace of the post-fold waveform (RGB grayscale).',
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
  'drumseqz.clock': 'External clock (rising edges advance the step pointer).',
  'drumseqz.gate1': 'Track 1 gate out.',
  'drumseqz.gate2': 'Track 2 gate out.',
  'drumseqz.gate3': 'Track 3 gate out.',
  'drumseqz.gate4': 'Track 4 gate out.',
  'drumseqz.pitch1': 'Track 1 V/oct pitch out (track root + per-step override).',
  'drumseqz.pitch2': 'Track 2 V/oct pitch out.',
  'drumseqz.pitch3': 'Track 3 V/oct pitch out.',
  'drumseqz.pitch4': 'Track 4 V/oct pitch out.',
  // POLYSEQZ — polyphonic chord sequencer (5-voice polyPitchGate output).
  'polyseqz.clock':       'CLOCK port. Input direction: external clock (rising edges advance the step pointer). Output direction: per-step clock pulse on every advance.',
  'polyseqz.reset_cv':    'Rising edge on this gate resets stepIndex to 0 next tick.',
  'polyseqz.play_cv':     'CV → isPlaying. Above 0.5 starts the sequencer; below 0.5 stops.',
  'polyseqz.humanize_cv': 'CV → humanize amount (0..1). Sums on top of the knob value, clamped to [0, 1].',
  'polyseqz.poly':        'polyPitchGate output: 5-voice chord (root + 3rd + 5th + (7th or octave) + (octave or 5th doubling)) per step.',
  'polyseqz.gate':        'Mono gate out: high while ANY voice is gated. Useful for ADSR/scope-trigger without unwrapping the poly cable.',
  // ILLOGIC ports — combined attenuverter / math / logic utility.
  'illogic.in1': 'Input 1 (cv/audio). Feeds att1 attenuverter AND the AND/NAND/OR/NOT logic block (gate-thresholded at 0.5).',
  'illogic.in2': 'Input 2 (cv/audio). Feeds att2 attenuverter AND the AND/NAND/OR logic block (gate-thresholded at 0.5).',
  'illogic.in3': 'Input 3 (cv/audio). Feeds att3 attenuverter only (no logic tap).',
  'illogic.in4': 'Input 4 (cv/audio). Feeds att4 attenuverter only (no logic tap).',
  'illogic.att1': 'in1 × bipolar attenuverter (-1..0..+1). Negative values invert sign.',
  'illogic.att2': 'in2 × bipolar attenuverter (-1..0..+1).',
  'illogic.att3': 'in3 × bipolar attenuverter (-1..0..+1).',
  'illogic.att4': 'in4 × bipolar attenuverter (-1..0..+1).',
  'illogic.sum':  'Post-attenuverter sum of all 4 channels: att1 + att2 + att3 + att4.',
  'illogic.diff': 'Post-attenuverter difference: (att1 + att2) - (att3 + att4).',
  'illogic.and':  'Logic AND of in1 & in2 as gates (threshold = 0.5). High when BOTH inputs >= 0.5.',
  'illogic.nand': 'Logic NAND of in1 & in2 as gates. NOT (in1 AND in2).',
  'illogic.or':   'Logic OR of in1 & in2 as gates. High when EITHER input >= 0.5.',
  'illogic.not':  'Logic NOT of in1 alone (single-input). High when in1 < 0.5.',
  // UNITYSCALEMATHEMATIK ports.
  'unityscalemathematik.u_in':       'UNITY section signal input (cv, bipolar -1..+1).',
  'unityscalemathematik.u_atten_cv': 'CV -> UNITY attenuvert knob (linear scale).',
  'unityscalemathematik.a_in':       'A section signal input (cv, bipolar).',
  'unityscalemathematik.a_atten_cv': 'CV -> A attenuvert knob (linear scale).',
  'unityscalemathematik.a_curve_cv': 'CV -> A curve morph (linear scale, 0=linear, 1=steep expo).',
  'unityscalemathematik.b_in':       'B section signal input (cv, bipolar).',
  'unityscalemathematik.b_atten_cv': 'CV -> B attenuvert knob (linear scale).',
  'unityscalemathematik.b_curve_cv': 'CV -> B curve morph (linear scale).',
  'unityscalemathematik.u_out':      'UNITY output: u_in * unityAtten (bipolar).',
  'unityscalemathematik.a_out':      'A output: sign(a_in) * |a_in|^k * aAtten with k = 1 + 2*aCurve.',
  'unityscalemathematik.b_out':      'B output: sign(b_in) * |b_in|^k * bAtten with k = 1 + 2*bCurve.',
  'dx7.poly':
    'Polyphonic pitch+gate input (10 channels = 5 lanes of pitch+gate). Drive from a SEQUENCER / CARTESIAN poly output for chord playback; each lane allocates one DX7 voice. Round-robin allocation with steal-oldest when all 5 voices busy.',
  'dx7.pitch_cv': 'Mono V/oct pitch input (legacy / single-voice fallback — drives lane 0 if no poly cable is patched).',
  'dx7.gate':     'Mono gate input (legacy / single-voice fallback — drives lane 0).',
  'dx7.out':      'Mono audio output (sum of all active voice carriers).',
  // NOISE — basic noise source.
  'noise.white': 'White noise output (audio-rate). Flat spectrum, Math.random()-driven; std-dev ≈ 0.577 × LEVEL.',
  'noise.pink':  'Pink noise output (audio-rate). 1/f spectrum (-3 dB/oct) via Voss-McCartney. Sounds "warmer" than white.',
  'noise.brown': 'Brown noise output (audio-rate). 1/f² spectrum (-6 dB/oct) via leaky-integrated white. Sounds like distant ocean / rumble.',
  // BUGGLES — chaotic random voltage source.
  'buggles.clock_cv':       'CV → woggle rate. Sums onto the RATE knob value (clamped to 0..1, then log-mapped to 0.1..50 Hz).',
  'buggles.chaos_cv':       'CV → chaos amount. Sums onto the CHAOS knob (clamped to 0..1).',
  'buggles.external_clock': 'Gate input. When patched and pulsing, replaces the internal woggle scheduler — every rising edge advances state.',
  'buggles.smooth':         'Slowly-shifting random voltage (-1..+1). The STEPPED value, slewed via linearRampToValueAtTime; SMOOTH knob controls slew duration.',
  'buggles.stepped':        'Sample-and-held random voltage (-1..+1). Updates instantly on each woggle event. CHAOS knob controls correlation between successive steps (0=walk, 1=independent).',
  'buggles.clock':          '5ms gate pulse fired on each woggle event. Use as a chaotic clock for sequencers / drum triggers.',
  'buggles.burst':          'Cluster of 3-7 closely-spaced 4ms gate pulses, fired at probability BURST per woggle event. Probabilistic chaos — sometimes silent, sometimes a buzz of triggers.',
  'buggles.ring':           'Audio-rate ring-modulation output: SMOOTH voltage × sine sub-oscillator (rate/4 Hz). The wogglebug\'s signature complex-random texture.',
  // STEREOVCA — stereo VCA + ring modulator.
  'stereovca.in_l':       'Left audio input. Multiplied by (strength_l + offset) * level.',
  'stereovca.in_r':       'Right audio input. Multiplied by (strength_r + offset) * level. Normalled to in_l when unpatched (mono → stereo).',
  'stereovca.strength_l': 'Left strength / ring carrier. Cable type `audio` so any signal — LFO/ADSR (slow → tremolo), oscillator (audio-rate → ring mod) — patches without thinking about cable types.',
  'stereovca.strength_r': 'Right strength / ring carrier. Normalled to strength_l when unpatched (one strength drives both VCAs).',
  'stereovca.out_l':      'Left output: in_l * (strength_l + offset) * level.',
  'stereovca.out_r':      'Right output: in_r * (strength_r + offset) * level.',
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
  // Inline expansion of well-known shared port-array spreads. Keeps the
  // regex parser simple but lets sequencer-style modules declare the 6
  // shared transport CV inputs via `...TRANSPORT_CV_PORT_DEFS`.
  if (/\.\.\.TRANSPORT_CV_PORT_DEFS\b/.test(body)) {
    out.push(
      { id: 'play_cv',   type: 'gate' },
      { id: 'reset_cv',  type: 'gate' },
      { id: 'queue1_cv', type: 'gate' },
      { id: 'queue2_cv', type: 'gate' },
      { id: 'queue3_cv', type: 'gate' },
      { id: 'queue4_cv', type: 'gate' },
    );
  }
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
      // Per-channel comp macro knob (single-dial wrapper around
      // thresh/ratio/compEnable, added in feat/audio-fidelity-...).
      params.push({ id: `comp${ch}`, label: `${ch}Cm`, defaultValue: 0, min: 0, max: 1, curve: 'linear' });
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
      // -draw.ts: shared 2D-canvas draw helpers (e.g. scope-draw.ts that
      // both ScopeCard.svelte and the cross-domain video bridge use).
      // Not a ModuleDef.
      if (file.endsWith('-draw.ts')) return false;
      // Shared transport helpers (PR feat/sequencer-transport-quicksave) —
      // SAVE/LOAD/QUEUE plumbing used by Sequencer / DRUMSEQZ / SCORE.
      // Not a ModuleDef.
      if (file === 'transport-helpers.ts') return false;
      if (file === 'transport-cv.ts') return false;
      if (file === 'transport-card.ts') return false;
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
