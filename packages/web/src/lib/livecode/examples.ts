// packages/web/src/lib/livecode/examples.ts
//
// Ready-to-run LIVECODE scripts surfaced by the "Load example" picker on
// the LIVECODE card (LivecodeCard.svelte) and rendered on the docs page.
//
// Each example is a COMPLETE, runnable script — clicking it replaces the
// editor buffer; pressing Run builds the patch. They double as living
// documentation of the API surface, so they're kept honest by
// examples.test.ts (every example must parse + run without error against
// the real runtime, and the flagship must actually produce changing,
// quantized notes).
//
// Keep the set small + curated: a "hello world", a basic melodic voice,
// the flagship live-requantizer, a transport demo, and a sidechain.

export interface LivecodeExample {
  /** Stable id — used as the <option> value + test selector. */
  id: string;
  /** Short menu label. */
  label: string;
  /** One-line description (menu title attr + docs caption). */
  description: string;
  /** The full script. Loaded verbatim into the editor. */
  code: string;
}

// ── The OWNER'S FLAGSHIP example ────────────────────────────────────
// "A sequenced VCO, changing notes in real time, using a clocked loop to
//  change the quantization of a sequenced melody."
//
// A fixed melodic SHAPE (expressed as scale DEGREES, not fixed notes)
// drives a VCO through an ADSR-shaped VCA. A clocked('1') loop rotates
// the SCALE every 4 beats and re-quantizes the shape to the new scale,
// so the same contour plays MAJOR → MINOR → PENTATONIC → WHOLE-TONE —
// the notes change live while always staying in key.
//
// NOTE on the clocked() body: clocked() snapshots the callback as TEXT
// and re-runs it each tick in a fresh scope, so the body can ONLY use the
// LIVECODE API (set / setData / read / state / log / Math / …) plus what
// it declares inside itself — never an outer-scope variable. The scale
// tables therefore live INSIDE the callback on purpose.
const FLAGSHIP_CODE = `// Sequenced VCO whose melody is RE-QUANTIZED live by a clocked loop.
// The same 8-note contour rotates through major → minor → pentatonic →
// whole-tone every 4 beats: the notes change in real time but always
// stay in the current scale.

const seq = spawn('sequencer', 'seq');
const vco = spawn('analogVco', 'vco');
const env = spawn('adsr',      'env');
const amp = spawn('vca',       'amp');
const out = spawn('audioOut',  'out');

patch('seq.pitch', 'vco.pitch');   // step note  -> oscillator pitch
patch('seq.gate',  'env.gate');    // step gate  -> envelope
patch('vco.sine',  'amp.audio');   // oscillator -> VCA
patch('env.env',   'amp.cv');      // envelope shapes the VCA
patch('amp.audio', 'out.L');
patch('amp.audio', 'out.R');

set('env', 'attack',  0.004);
set('env', 'decay',   0.16);
set('env', 'sustain', 0.25);
set('env', 'release', 0.12);
set('amp', 'base', 0);
set('amp', 'cvAmount', 1);
set('out', 'master', 0.4);

set('seq', 'bpm',       120);
set('seq', 'length',    8);
set('seq', 'isPlaying', 1);

// Immediate C-major melody so there's sound the moment you hit Run.
// (midi: 48 = C3.) The clocked loop below re-quantizes from here.
setData('seq', 'steps', [48, 52, 55, 52, 57, 55, 52, 48].map(function (m) {
  return { on: true, midi: m };
}));

// Re-quantize to the next scale every 4 beats. SELF-CONTAINED body:
// declares its own tables; persists the beat counter via state.*.
clocked('1', () => {
  const SCALES = {
    major:      [0, 2, 4, 5, 7, 9, 11],
    minor:      [0, 2, 3, 5, 7, 8, 10],
    pentatonic: [0, 3, 5, 7, 10],
    wholetone:  [0, 2, 4, 6, 8, 10],
  };
  const ORDER = ['major', 'minor', 'pentatonic', 'wholetone'];
  const SHAPE = [0, 2, 4, 2, 5, 4, 2, 0]; // scale-degree contour
  const ROOT  = 48;                        // C3 (MIDI)

  // Beat counter survives across ticks via the per-runner state store.
  const beat = (state.get('beat') ?? 0) + 1;
  state.set('beat', beat);

  // Switch scale every 4 beats; only re-quantize when it actually changes.
  const scaleName = ORDER[Math.floor((beat - 1) / 4) % ORDER.length];
  if (scaleName === state.get('scale')) return;
  state.set('scale', scaleName);

  // Map each contour degree through the current scale -> MIDI note.
  const scale = SCALES[scaleName];
  const steps = SHAPE.map((deg) => {
    const oct = Math.floor(deg / scale.length);
    const idx = ((deg % scale.length) + scale.length) % scale.length;
    return { on: true, midi: ROOT + oct * 12 + scale[idx] };
  });
  setData('seq', 'steps', steps);
  log('re-quantized -> ' + scaleName + ' (beat ' + beat + ')');
});`;

export const FLAGSHIP_EXAMPLE_ID = 'requantize-sequence';

export const LIVECODE_EXAMPLES: readonly LivecodeExample[] = [
  {
    id: 'hello-tone',
    label: 'Hello tone',
    description: 'Spawn a VCO + Audio Out and route a steady tone — the simplest possible patch.',
    code: `// Simplest patch: one oscillator into the speakers.
const vco = spawn('analogVco', 'vco');
const out = spawn('audioOut',  'out');
patch('vco.sine', 'out.L');
patch('vco.sine', 'out.R');
set('vco', 'tune', 0);   // A440 reference
set('out', 'master', 0.4);`,
  },
  {
    id: 'melodic-voice',
    label: 'Melodic voice',
    description: 'Sequencer → ADSR → VCA → VCO → Audio Out: a complete plucked melodic voice.',
    code: `// A complete melodic voice: an 8-step sequence plucks a VCO through
// an ADSR-shaped VCA.
const seq = spawn('sequencer', 'seq');
const vco = spawn('analogVco', 'vco');
const env = spawn('adsr',      'env');
const amp = spawn('vca',       'amp');
const out = spawn('audioOut',  'out');

patch('seq.pitch', 'vco.pitch');
patch('seq.gate',  'env.gate');
patch('vco.sine',  'amp.audio');
patch('env.env',   'amp.cv');
patch('amp.audio', 'out.L');
patch('amp.audio', 'out.R');

set('env', 'attack', 0.005); set('env', 'decay', 0.12);
set('env', 'sustain', 0.3);  set('env', 'release', 0.15);
set('amp', 'base', 0);       set('amp', 'cvAmount', 1);
set('out', 'master', 0.4);

set('seq', 'bpm', 140); set('seq', 'length', 8); set('seq', 'isPlaying', 1);

// A simple C-major arpeggio (midi: 60 = C4).
setData('seq', 'steps', [60, 64, 67, 72, 67, 64, 60, 55].map(function (m) {
  return { on: true, midi: m };
}));`,
  },
  {
    id: FLAGSHIP_EXAMPLE_ID,
    label: 'Re-quantizing sequence ★',
    description:
      'A sequenced VCO whose melody is re-quantized in real time — a clocked loop rotates the scale (major → minor → pentatonic → whole-tone) every 4 beats.',
    code: FLAGSHIP_CODE,
  },
  {
    id: 'clock-transport',
    label: 'Clock transport',
    description: 'Drive the master TIMELORDE clock from script: set BPM, stop + start the outputs.',
    code: `// Master clock control. TIMELORDE is always running so clocked()
// callbacks keep firing; clock.stop()/start() only gate the outputs.
clock.bpm(128);   // set the master tempo
clock.stop();     // mute clock outputs (callbacks keep firing)
clock.start();    // unmute
log('bpm is now ' + clock.bpm());`,
  },
  {
    id: 'sidechain-duck',
    label: 'Sidechain ducker',
    description: "VCO through a VCA, ducked by an inverted ADSR (env_inv) fired by a DRUMSEQZ kick track.",
    code: `// Classic sidechain: a drum sequencer's kick track fires an ADSR whose
// INVERTED envelope (env_inv, on every ADSR) ducks the VCA in time with
// the beat.
spawn('analogVco', 'lead');
spawn('vca',       'duck');
spawn('adsr',      'ducker');
spawn('drumseqz',  'drums');
spawn('audioOut',  'mainout');

patch('lead.sine',      'duck.audio');
patch('ducker.env_inv', 'duck.cv');     // inverted env idles at 1 = open
patch('drums.gate1',    'ducker.gate'); // kick track (1) fires the ducker
patch('duck.audio',     'mainout.L');
patch('duck.audio',     'mainout.R');

set('ducker', 'attack', 0.005); set('ducker', 'decay', 0.18);
set('ducker', 'sustain', 0);    set('ducker', 'release', 0.05);
set('duck', 'base', 0);         set('duck', 'cvAmount', 1);
set('drums', 'bpm', 120);       set('drums', 'isPlaying', 1);
set('drums', 'trk1_euclid', 4); // four-on-the-floor kick on track 1`,
  },
];

/** Look up an example by id (used by the card's load handler). */
export function getExampleById(id: string): LivecodeExample | undefined {
  return LIVECODE_EXAMPLES.find((e) => e.id === id);
}
