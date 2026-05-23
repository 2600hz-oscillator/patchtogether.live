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
  wavviz:
    'Wavetable VCO sister of wavetableVco with a built-in West-Coast wavefolder + a mono-video scope output. Same morphing wavetable as wavetableVco; post-fold signal feeds both audio and scope-video out.',
  cameraInput:
    'Webcam input (LOCAL ONLY). Live <video> -> WebGL2 texture; gain / mirror / on params. The captured stream is local to your browser tab and is NOT sent to other rack-mates — collaborators see a presence badge ("user X has CAMERA active") via Y-awareness, not the video itself. Multiplayer streaming (WebRTC + SFU) is deferred to a future phase. Spec: .myrobots/plans/module-camera-input.md.',
  illogic:
    'Combined attenuverter / math / logic utility. 4 cv inputs feed bipolar attenuverters (-1..+1); post-attenuverter outputs sum into `sum` and `diff`. Inputs in1+in2 are also gate-thresholded (>= 0.5) and combined into AND/NAND/OR; in1 alone drives a NOT.',
  unityscalemathematik:
    'Bipolar CV-shaping utility with three independent channels: a UNITY scaler (input * atten) plus two attenuvert sections (A, B) whose curve knob morphs the response from linear (k=1) to steep exponential (k=3) via y = sign(x) * |x|^k * atten. Sign is preserved across the curve morph so the transform stays bipolar. CV inputs on every atten/curve knob — useful for envelope shaping, LFO sculpting, or driving any modulation through a tunable response curve.',
  analogLogicMaths:
    'Analog-logic mixer inspired by Mystic Instruments ANA (hardware-only — this is a from-spec implementation, not a port). Two continuous-signal inputs A and B feed bipolar attenuverters (-1..+1) and the post-attenuverter signals fan out into FIVE simultaneous algebraic outputs: MIN = min(A\',B\'), MAX = max(A\',B\'), DIFF = A\'-B\', SUM = tanh(A\'+B\') (soft-clipped), PRODUCT = tanh(A\'*B\') (soft-clipped, gives ring-mod-ish behavior for audio + smooth blending for CV). MIN/MAX of two waveforms mashes shapes; MAX of two envelopes = "either-trigger fires"; DIFF of two LFOs is anti-correlated motion; PRODUCT of two CVs is smooth blending. Continuous-signal "analog logic" — NOT the digital boolean logic that ILLOGIC ships. Tanh soft-clip on SUM + PRODUCT only (the operations that can leave [-1, +1]); MIN/MAX/DIFF stay bounded naturally.',
  dx7:
    'Pure-TypeScript 6-operator DX7-style FM synthesizer. 32 algorithms, 5-voice polyphony via the polyPitchGate cable, bundled bank of factory-inspired patches (E.PIANO 1, BASS 1, HARMONICA, STRINGS 1, MARIMBA, etc.), and a .syx file picker for loading custom 32-voice cartridge dumps (in-memory only). NOT a Plaits-backed implementation — see .myrobots/plans/dx7-and-polyphony.md for the design rationale.',
  noise:
    'Basic noise source. Three independent audio outputs — WHITE (full-spectrum), PINK (1/f, -3 dB/oct via Voss-McCartney), BROWN (1/f², -6 dB/oct via leaky-integrated white). All outputs share a single LEVEL knob. No CV inputs.',
  buggles:
    'Chaotic random voltage source — clean-room functional implementation of the Buchla / Make Noise wogglebug archetype. Internal "woggle clock" emits triggers at the RATE knob; outputs include SMOOTH (slewed random), STEPPED (sample-and-held), CLOCK (woggle gate), BURST (probabilistic clusters of 3-7 triggers), and RING (smooth × sub-osc ring-mod, the signature dirty texture). CV inputs modulate rate + chaos; EXT CLK replaces the internal scheduler when patched. The "Wogglebug" name is Make Noise\'s trademark — BUGGLES is our name; no proprietary schematic is copied.',
  warrenspectrum:
    'Stereo 8-band filterbank with vactrol-style ping excitation and acidwarp video viz. Eight RBJ bandpass filters at octave-spaced centers (80, 160, 320, 640, 1280, 2560, 5120, 10240 Hz, Q=6). Each band carries its own ping gate input — rising edges distribute excitation across n±2 neighbors via a 1.0 / 0.35 / 0.12 bleed matrix into a vactrol envelope (soft-attack 10-30 ms with ±10% jitter, exponential decay 100-800 ms with ±10% jitter, tanh-saturated). The envelope simultaneously injects a fast broadband click into the bandpass (filter rings at fc) and pumps the band gain. viz_out is a mono-video cross-domain bridge: the on-card EQ-curve + audio-waveform overlay + cycling acidwarp hue palette + per-band ping flashes are also published as a video texture for downstream video modules.',
  stereovca:
    'Stereo VCA + ring modulator. Per-channel multiply: out_l = in_l * (strength_l + offset) * level; out_r = in_r * (strength_r + offset) * level. The same math behaves as VCA gain control when strength is slow (CV / LFO / envelope) and as ring modulation when strength is audio-rate — no mode toggle, the perceptual difference emerges from signal content. INDEPENDENT normalling: if in_r is unpatched it copies in_l (mono → stereo); if strength_r is unpatched it copies strength_l (one strength drives both VCAs). The two halves normal independently, so true-stereo audio + mono strength works, as does mono audio + per-side strength. Audio carriers (in_l/in_r) declare cable type `audio`; strength inputs declare `cv` (raw bipolar carrier consumed in the multiply with no scaling — listed in PASSTHROUGH_BY_DESIGN) so any cv source (LFO, ADSR, sequencer step CV) lands without a cross-type cast.',
  shimmershine:
    'Stereo shimmer reverb. Schroeder-style tank (4 parallel comb filters with damped feedback + 2 series allpasses per channel) feeds a +12-semitone granular-fade pitch shifter; the shifted signal is summed back into the tank input (gain hard-capped at 0.55 to prevent runaway). Decay sets tank tail length, Shimmer the pitch-shifted feedback amount (0 = plain reverb, 1 = strong octave-up halo), Size the comb-feedback scale, Damp the in-loop high-frequency rolloff, Mix dry/wet. More processor-intensive than the plain Reverb module by design.',
  macrooscillator:
    'Plaits-style macro oscillator (Mutable Instruments archetype). Clean-room pure-TypeScript implementation — not a port of Plaits\' C++ source (see PR #27 for the closed emscripten attempt). First-slice scope ships two synthesis models behind the three canonical macros (HARMONICS / TIMBRE / MORPH): (0) virtual analog (VA) — morphing saw→square→triangle PolyBLEP wave + detuned partner (HARMONICS = detune amount) + wavefolder (TIMBRE = fold amount); (1) waveshape — sine through a morphable wavefolder/tanh-waveshaper (TIMBRE = drive, MORPH = wavefolder↔tanh, HARMONICS = sub-octave mix). PITCH input is V/oct; NOTE param is a ±60-semitone offset on top. TRIG resets phase on rising edge for percussive attack alignment. OUT is the level-scaled main output; AUX is a per-model raw tap (unfolded sub-octave triangle in VA, pre-distortion body in waveshape). More models (granular, FM, chord, speech, kick/snare/hat, modal, etc.) land in follow-up PRs.',
  clouds:
    'Granular texture processor (Mutable Instruments Clouds archetype, Émilie Gillet, 2014, MIT-licensed) — 2-second stereo ring buffer + overlap-added grain cloud (up to 24 grains) + latched FREEZE. Six macros (Position / Size / Pitch / Density / Texture / Blend) with V/oct grain-pitch tracking on the pitch input. v1 ships GRANULAR mode only; STRETCH / LOOPING-DELAY / SPECTRAL modes deferred to follow-up.',
  rings:
    'Modal / sympathetic-string resonator (Mutable Instruments Rings archetype). Faithful TypeScript port of the eurorack/rings/ DSP (MIT-licensed). v1 ships two resonator models: (0) MODAL — bank of 24 parallel stiffness-stretched RBJ bandpasses with cosine-weighted Odd/Even pickup taps; (1) SYMPATHETIC — 2 parallel Karplus-Strong delay lines with one-pole damping. STRUCTURE/BRIGHTNESS/DAMPING/POSITION are the canonical Rings knobs; LEVEL is a soft-limited output gain. EXCITER in drives both engines; STRUM rising edge re-ignites a ~10ms noise burst (KS) or impulse (modal). Outputs odd / even — patch both for stereo. Polyphony 1; STRING+REVERB deferred.',
  peaks:
    'Dual-channel multi-mode utility (Mutable Instruments Peaks archetype, Émilie Gillet, 2013, MIT-licensed). Each channel selects one of five modes — KICK (sine carrier + pitch envelope + amp envelope), SNARE (body sine + filtered noise + decay), HIHAT (six-square metallic cluster + bandpass + decay), ENV (attack-decay envelope, CV-output 0..1, re-attacks on gate), LFO (sine/triangle/square, CV-output ±1, phase resets on gate). Two mode-dependent knobs per channel: knob1 = pitch/mix/brightness/attack/rate; knob2 = decay or waveshape. Gate input retriggers the active engine on rising edges. v1 ships five modes; multistage envelope / tap-LFO / BPF mode deferred to follow-up.',
  warps:
    'Meta-modulator / signal masher (Mutable Instruments Warps archetype, Émilie Gillet, 2014, MIT-licensed). Clean-room pure-TypeScript port — four cross-modulation algorithms (0=XFADE equal-power crossfade, 1=RING-MOD digital ring modulation with TIMBRE drive, 2=XOR 16-bit bit-mash crossfaded against a 0.7-sum, 3=COMPARE Warps\' direct/threshold/window comparator suite). An internal carrier oscillator (sine / triangle / saw / square selectable via the SHAPE knob) drives the carrier path when carrier_in is unpatched, so the module is usable as a one-input ring modulator or with no inputs at all. PITCH is V/oct on the internal carrier; NOTE is a ±60-semitone offset. LEVEL 1 / LEVEL 2 scale the carrier and modulator inputs. Output is mono softclipped through x/(1+|x|). FOLD / ANALOG-RING / FREQUENCY-SHIFTER / DOPPLER / VOCODER algorithms deferred to a follow-up PR.',
  veils:
    'Quad VCA + soft-clip summing mix (Mutable Instruments Veils archetype — analog hardware, clean-room from-spec impl). Four independent VCAs, each with audio in, CV in (summed with knob), gain knob spanning [0, 2], and a per-channel response toggle: LIN for CV / control signals, EXP (squared) for audio / smooth fades. Per-channel direct outs are pre-mix, pre-clip. A separate MIX out sums all four channels and applies a tanh soft-clip — gain is NOT clamped at 1.0 per channel, so knob + CV can push above unity for warm overdrive on the mix bus.',
  blades:
    'Dual state-variable filter + COLOR overdrive + mix bus (Mutable Instruments Blades archetype). Blades is analog hardware with no firmware to port; this is a from-spec TypeScript implementation. Each of the two SVF cores has its own cutoff knob (20 Hz – 20 kHz, log fader), resonance knob (0..1, just shy of self-oscillation at the top), V/oct CV input (1 V per octave centered on the cutoff knob), audio-rate cutoff CV (±5 octaves at full deflection), and a mode toggle cycling LP → BP → HP. The global COLOR knob applies a tanh soft-clip pre-stage to each filter input — drive ranges 1× (clean) to 10× (heavily saturated) for the signature Blades grit. The MIX output toggles between PARALLEL (sum of both filters, soft-clipped) and SERIAL (filter1 → filter2 cascade, filter 2 ignores its own IN); the per-filter direct OUTs always track each filter operating on its own audio input independent of the mix routing. v1 ships LP/BP/HP modes; notch + linear-FM cutoff modulation deferred to follow-up.',
  stages:
    '6-segment cascadable function generator (Mutable Instruments Stages archetype, Émilie Gillet, 2017, MIT-licensed). Each segment selects a TYPE — RAMP (phase 0→1 over TIME seconds, shape-warped via the Tides-style curve from the C++ segment_generator), HOLD (constant LEVEL with shape-controlled portamento), or STEP (sample-and-hold of LEVEL on each gate rising edge). Adjacent segments can be LINKed via 5 boundary toggles to form multi-stage envelopes: a single RAMP→HOLD→RAMP chain reproduces an AHD envelope; chaining all 6 segments builds an AHDSR or arbitrary multi-stage curve. The leader segment of each chain group fires on its own GATE input; subsequent linked segments take over in sequence as each completes. A global TRIG input fires every chain group\'s leader at once. Each segment has its own CV output that mirrors its chain\'s current value, so any segment can be tapped. v1 ships TYPE + LINK + GATE + TRIG + per-segment CV inputs for primary + shape; Outliner / chord mode, the all-STEP tap-tempo grid mode, and looping LFO mode (with rate CV) are deferred to follow-up PRs.',
  cloudseed:
    'Exact algorithm port of Ghost Note Audio\'s CloudSeed reverb (MIT-licensed, github.com/GhostNoteAudio/CloudSeedCore). Stereo input cross-mixes then per-channel passes through: optional 1-pole HP + LP pre-EQ → modulated pre-delay → multitap early-reflection field (up to 256 taps, seed-deterministic) → AllpassDiffuser (up to 12 stages) → 12 parallel late-field DelayLine voices, each with optional in-loop AllpassDiffuser + LowShelf + HighShelf + LP, with T60-targeted feedback that produces a precise decay-seconds tail. Cross-seed control divides the L/R seeded delay layouts for stereo decorrelation. 45 parameters total — 7 macros (DRY / EARLY / LATE faders, INPUT MIX, LOW CUT, HIGH CUT, CROSS SEED) are exposed as AudioParams for CV summing; 38 toggle/integer/seed/modulation parameters live on the worklet\'s message port. Bundled v1 preset bank: DIVINE INSPIRATION (DarkPlate from Programs.h verbatim), SHORT ROOM, BRIGHT HALL, INFINITE PAD. Card footer cycles through the preset bank with click-numbered slots, prev/next arrows, and a live DECAY readout that reflects LateLineDecay\'s computed RT60.',
  livecode:
    'JS-runtime live-coding module — CodeMirror editor with port-aware autocomplete and red-underline diagnostics, hit Run, the rack reshapes itself. Exposes spawn / patch / unpatch / set / read / clock.* / clocked() / log. Every clocked() call spawns a CLOCKED runner that owns the subscription. No audio I/O — the card is a side-tool. Full API + examples at /docs/modules/livecode.',
  clockedRunner:
    'Self-contained mini-LIVECODE owning a single clocked() callback. Spawned by the parent LIVECODE card when you invoke clocked(division, fn); deleting the runner cancels the schedule. Body is editable inline; the audio-domain factory re-evaluates it on every division boundary derived from TIMELORDE.bpm.',
  midiCvBuddy:
    'Hardware MIDI controller → pitch + gate + velocity CV. Uses the browser\'s built-in Web MIDI API (no third-party library) and converts incoming note-on / note-off / pitch-bend messages into three ConstantSourceNode outputs: pitch_cv (V/oct, 0V = C4 = MIDI 60, with pitch-bend summed in at the MIDI-standard ±2 semitones), gate (0/1), and velocity_cv (0..1). Monophonic with three voice-priority modes (LAST = newest key wins, the conventional default; LOW = lowest key, classic mono-bass behavior; HIGH = highest), a RETRIG toggle that drops the gate to 0 for one audio block between successive note-ons (so a downstream ADSR re-fires) versus legato (gate stays high through key changes), an ALL/1..16 channel filter, and a device-picker dropdown that hot-plugs when controllers connect/disconnect. The user clicks "Connect MIDI…" once per origin to grant permission; subsequent reloads reuse the grant. End-to-end latency is honest about the Web MIDI main-thread path (~5-10 ms typical on Chrome/macOS); event.timeStamp is mapped to ctx.currentTime + a 2 ms lookahead so scheduling lands at the start of the next audio block rather than mid-block.',
  midiclock:
    'Hardware MIDI transport bridge. Locks to a MIDI device and surfaces the System Real-Time stream as gate/CV: clock (gate) at a user-selectable subdivision — 24=quarter (default, patch directly into TIMELORDE.clock to slave it to the external transport), 12=eighth, 6=sixteenth, 3=32nd, 1=raw 24 PPQN; run (cv, 0/1) tracks transport state; midistart + midistop fire one-shot gates on MIDI Start (0xFA) and Stop (0xFC). Continue (0xFB) raises run without re-firing midistart, so downstream loops resume in place. Channel-voice messages are ignored — pair with MIDI-CV-BUDDY (or HELM) for note/velocity. Same Web MIDI / ConstantSource / 2 ms lookahead plumbing as MIDI-CV-BUDDY.',
  helm:
    'Polyphonic subtractive synth — algorithm port of Matt Tytel\'s Helm (helm_engine.cpp / helm_voice_handler.cpp / helm_oscillators.cpp / helm_lfo.cpp / state_variable_filter.cpp / envelope.cpp / step_generator.cpp, originally GPL-3.0, ported to AGPL-3.0-or-later per the project\'s license relicense). v1 ships: 4-8 voice polyphony (Voices knob); 2 morphing oscillators (saw/square/triangle/sine continuous morph) with per-osc transpose (±24 st), tune (±100 ¢), unison (1..7 voices, detune ±50 ¢ spread), and volume; 1 sub oscillator (-2 oct, selectable wave); white-noise source; state-variable filter (Andy Simper TPT topology, Cytomic formulation) with 12dB / 24dB pole select, LP↔BP↔HP continuous blend, drive, resonance, key-track; three ADSR envelopes (amplitude, filter, mod) with depth knobs for filter-env → cutoff and mod-env → osc1 pitch; two mono LFOs pre-wired (LFO1 → filter cutoff, LFO2 → osc2 pitch); 16-step step sequencer with smoothing + frequency division pre-wired to osc2 transpose; stereo output with adjustable voice-pan spread. Polyphonic MIDI input via the gear-icon settings panel — pick a connected Web MIDI device + select which of channels 1-16 to receive on (multi-select; ALL is the default). Multiple held notes simultaneously trigger multiple voices via a free-slot / steal-oldest allocator. Optional pitch_cv (V/oct) + gate fallback inputs let the module be driven by SCORE / sequencer cables when no MIDI is connected. DEFERRED to follow-up PRs: effects bus (distortion / delay / reverb / stutter / formant / feedback), arpeggiator, poly LFO, mod sources panel (aftertouch / mod wheel / pitch wheel / random), BPM-locked LFO frequencies, and a freeform modulation matrix (v1 hard-wires mod sources to musically sensible defaults — see the helm.ts worklet header for the routing table).',
  hydrogen:
    'Drum machine — first pass of a Hydrogen (https://github.com/hydrogen-music/hydrogen, GPL-2.0+) port. Bundles the stock TR-808 Emulation Kit (ArtemioLabs, GPL) — 16 single-layer instruments (Kick Long/Short, Snare 1/2, Clap, Hat Closed/Open/Pedal, Toms Hi/Mid/Low, Conga, Cymbal, Shaker, Clave, Cowbell) shipped as FLACs under /drumkits/tr808/. Internal 16-step pattern grid drives one-shot sample voices per step; the closed/open/pedal hi-hat triad shares a mute group so a closed-hat triggers chokes the open-hat tail (classic drum-machine behaviour, hard-coded since the source XML doesn\'t model it). Per-instrument vol/pan/A/D/S/R + mute + solo knobs on the PatchPanel section for that instrument; transport row (BPM 30-300, swing 0-0.75, master gain, PLAY) on the card body. Optional clock_in / reset_in gate inputs let TIMELORDE drive the sequencer (rising edges step the pattern; reset zeroes the playhead); per-instrument trig{0..15} gate inputs let other rack modules fire individual drums directly. DEFERRED to follow-up PRs: drumkit picker / .h2drumkit loader (currently the TR-808 kit is the only kit), per-step velocity (v1 cells are binary on/off), pattern pages + song mode, humanize / per-step micro-shift, multi-layer velocity samples, LADSPA-style per-channel FX bus (use SHIMMERSHINE / CHARLOTTES ECHOS / etc. downstream of the stereo out as patch-cable effects instead), polyphonic MIDI input (pair with MIDI-CV-BUDDY → trig{i} per drum until then).',
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
  // ANALOGLOGICMATHS — analog-logic mixer (MIN/MAX/DIFF/SUM/PRODUCT).
  'analogLogicMaths.a':       'Signal input A (cv/audio, bipolar). Multiplied by attA before the math.',
  'analogLogicMaths.b':       'Signal input B (cv/audio, bipolar). Multiplied by attB before the math.',
  'analogLogicMaths.attA_cv': 'CV → Att A attenuverter knob (linear scale, bipolar -1..+1).',
  'analogLogicMaths.attB_cv': 'CV → Att B attenuverter knob (linear scale, bipolar -1..+1).',
  'analogLogicMaths.min':     'Sample-wise MIN(A\', B\') where A\'/B\' are the attenuverted inputs.',
  'analogLogicMaths.max':     'Sample-wise MAX(A\', B\').',
  'analogLogicMaths.diff':    'Sample-wise DIFF: A\' - B\'. Anti-symmetric (DIFF(a,b) = -DIFF(b,a)).',
  'analogLogicMaths.sum':     'Sample-wise SUM with tanh soft-clip: tanh(A\' + B\'). Stays in (-1, +1) for any inputs.',
  'analogLogicMaths.product': 'Sample-wise PRODUCT with tanh soft-clip: tanh(A\' * B\'). Audio × audio = ring mod; CV × CV = smooth blending.',
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
  'stereovca.strength_l': 'Left strength / ring carrier. Cable type `cv` so LFOs / ADSRs / sequencer-step CV land natively. Slow CV gives tremolo; an audio-rate signal patched here gives ring modulation (PASSTHROUGH_BY_DESIGN — the worklet treats strength as a raw bipolar carrier, no cv scaling).',
  'stereovca.strength_r': 'Right strength / ring carrier. Normalled to strength_l when unpatched (one strength drives both VCAs).',
  'stereovca.out_l':      'Left output: in_l * (strength_l + offset) * level.',
  'stereovca.out_r':      'Right output: in_r * (strength_r + offset) * level.',
  // VEILS — quad VCA + soft-clip summing mix.
  'veils.in1':   'Channel 1 audio input. Multiplied by shape(gain1 + cv1).',
  'veils.in2':   'Channel 2 audio input. Multiplied by shape(gain2 + cv2).',
  'veils.in3':   'Channel 3 audio input. Multiplied by shape(gain3 + cv3).',
  'veils.in4':   'Channel 4 audio input. Multiplied by shape(gain4 + cv4).',
  'veils.cv1':   'Channel 1 gain CV. Sums with the gain knob; raw bipolar carrier (PASSTHROUGH_BY_DESIGN — knob range [0,2] already accommodates a ±1V LFO swing at unity-knob).',
  'veils.cv2':   'Channel 2 gain CV. Sums with the gain knob.',
  'veils.cv3':   'Channel 3 gain CV. Sums with the gain knob.',
  'veils.cv4':   'Channel 4 gain CV. Sums with the gain knob.',
  'veils.out1':  'Channel 1 direct out (post-VCA, pre-mix, pre-clip).',
  'veils.out2':  'Channel 2 direct out (post-VCA, pre-mix, pre-clip).',
  'veils.out3':  'Channel 3 direct out (post-VCA, pre-mix, pre-clip).',
  'veils.out4':  'Channel 4 direct out (post-VCA, pre-mix, pre-clip).',
  'veils.mix':   'Soft-clipped mix output: tanh(out1 + out2 + out3 + out4). Gain is not clamped at 1.0 per channel, so summing pushes the mix into warm tanh saturation when knob + CV drive the channels hard.',
  // MACROOSCILLATOR — Plaits-style macro oscillator.
  'macrooscillator.pitch':    'V/oct pitch input (1 unit = 1 octave). Sums with the NOTE param.',
  'macrooscillator.trig':     'Gate input — rising edge resets the oscillator phase accumulators for clean percussive attack alignment.',
  'macrooscillator.model_cv': 'CV → model param (discrete switch: 0=VA, 1=WAVESHAPE).',
  'macrooscillator.note_cv':  'CV → note param (±60-semitone offset on top of pitch V/oct).',
  'macrooscillator.harm_cv':  'CV → HARMONICS macro (0..1). In VA: detune amount of the partner voice; in WAVESHAPE: sub-octave sine mix.',
  'macrooscillator.timb_cv':  'CV → TIMBRE macro (0..1). In VA: wavefolder amount on the summed wave; in WAVESHAPE: waveshaper drive.',
  'macrooscillator.morph_cv': 'CV → MORPH macro (0..1). In VA: saw→square→triangle wave morph; in WAVESHAPE: wavefolder↔tanh waveshaper crossfade.',
  'macrooscillator.level_cv': 'CV → LEVEL (0..1) — final scalar on the OUT port (AUX is unaffected).',
  'macrooscillator.out':      'Main audio output, post-LEVEL.',
  'macrooscillator.aux':      'Auxiliary output — per-model raw tap: unfolded sub-octave triangle (VA) or pre-distortion body sine (WAVESHAPE). Not LEVEL-scaled.',

  // RINGS
  'rings.in':        'Audio exciter — drives the resonator(s).',
  'rings.pitch':     'V/oct pitch input.',
  'rings.strum':     'Gate — rising edge re-ignites burst (KS) or impulse (modal).',
  'rings.model_cv':  'CV → model (discrete: 0=MODAL, 1=SYMPATHETIC).',
  'rings.note_cv':   'CV → note (±60-semitone offset).',
  'rings.str_cv':    'CV → STRUCTURE (0..1).',
  'rings.bright_cv': 'CV → BRIGHTNESS (0..1).',
  'rings.damp_cv':   'CV → DAMPING (0..1). Low = long ring; high = fast decay.',
  'rings.pos_cv':    'CV → POSITION (0..1).',
  'rings.level_cv':  'CV → LEVEL (0..1) — soft-limited output gain.',
  'rings.odd':       'Primary output — odd-indexed mode sum (MODAL) or odd-tap string mix (SYMPATHETIC).',
  'rings.even':      'Secondary output — even-indexed mode sum / even-tap mix.',
  // BLADES — dual SVF + COLOR + mix bus.
  'blades.in1':         'Filter 1 audio input. Routed through the COLOR pre-stage tanh before filter 1.',
  'blades.in2':         'Filter 2 audio input. Routed through the COLOR pre-stage tanh before filter 2. In SERIAL mix mode, in2 still drives out2 — only the mix bus ignores it.',
  'blades.voct1':       '1 V/oct CV input for filter 1 cutoff. Sums in octaves on top of the cutoff knob.',
  'blades.voct2':       '1 V/oct CV input for filter 2 cutoff.',
  'blades.cutoff1_cv':  'Audio-rate cutoff CV for filter 1. ±1 = ±5 octaves around the cutoff knob — matches the simple FILTER module convention.',
  'blades.cutoff2_cv':  'Audio-rate cutoff CV for filter 2.',
  'blades.res1_cv':     'CV → resonance 1 (linear cvScale, sweeps 0..1).',
  'blades.res2_cv':     'CV → resonance 2 (linear cvScale, sweeps 0..1).',
  'blades.color_cv':    'CV → COLOR (linear cvScale, sweeps 0..1) — modulates pre-filter drive.',
  'blades.mix_mode_cv': 'CV → mix mode (discrete cvScale; ≥0.5 = SERIAL, <0.5 = PARALLEL).',
  'blades.out1':        'Filter 1 direct output (LP/BP/HP per mode1).',
  'blades.out2':        'Filter 2 direct output (LP/BP/HP per mode2).',
  'blades.mix':         'Mix bus output. PARALLEL: tanh(out1 + out2). SERIAL: tanh(filter2(filter1(in1))).',
  // WARPS — meta-modulator / signal masher.
  'warps.carrier_in':       'Audio carrier input. When patched, replaces the internal oscillator as the carrier signal feeding the selected Xmod algorithm.',
  'warps.modulator_in':     'Audio modulator input. Multiplied by LEVEL 2 before entering the Xmod algorithm.',
  'warps.pitch':            'V/oct pitch input for the internal carrier oscillator (1 unit = 1 octave on top of C4 = 261.6256 Hz). Sums with the NOTE param.',
  'warps.algorithm_cv':     'CV → ALGORITHM (discrete: 0=XFADE, 1=RING-MOD, 2=XOR, 3=COMPARE).',
  'warps.carrier_shape_cv': 'CV → SHAPE (internal-oscillator waveform: 0..0.25 sine, 0.25..0.5 triangle, 0.5..0.75 saw, 0.75..1 square).',
  'warps.timbre_cv':        'CV → TIMBRE — per-algorithm intensity / mix. XFADE: crossfade position. RING-MOD: drive (0=clean ring, 1=overdriven). XOR: dry/wet between 0.7-sum and the XOR-mash. COMPARE: position through the 4 sub-mode interpolation.',
  'warps.level_1_cv':       'CV → LEVEL 1 (carrier-input gain).',
  'warps.level_2_cv':       'CV → LEVEL 2 (modulator-input gain).',
  'warps.out':              'Mono audio output, post-softlimit (x / (1 + |x|)).',
  // STAGES — 6-segment cascadable function generator.
  'stages.gate0': 'Per-segment gate input — rising edge fires segment 1\'s chain group, IFF segment 1 is its chain\'s leader. (Leader = first segment in any maximal run of LINKed adjacent segments.)',
  'stages.gate1': 'Per-segment gate input for segment 2 — only fires the chain when segment 2 is a chain leader (i.e. not LINKed to segment 1).',
  'stages.gate2': 'Per-segment gate input for segment 3 — same leader-only semantics as gate0/gate1.',
  'stages.gate3': 'Per-segment gate input for segment 4 — same leader-only semantics as gate0/gate1.',
  'stages.gate4': 'Per-segment gate input for segment 5 — same leader-only semantics as gate0/gate1.',
  'stages.gate5': 'Per-segment gate input for segment 6 — same leader-only semantics as gate0/gate1.',
  'stages.trig':  'Global trigger — rising edge fires every chain group\'s leader simultaneously. Useful for "reset all chains" patches.',
  'stages.primary0_cv': 'CV → segment 1 primary knob (TIME for RAMP, LEVEL for HOLD/STEP).',
  'stages.primary1_cv': 'CV → segment 2 primary knob.',
  'stages.primary2_cv': 'CV → segment 3 primary knob.',
  'stages.primary3_cv': 'CV → segment 4 primary knob.',
  'stages.primary4_cv': 'CV → segment 5 primary knob.',
  'stages.primary5_cv': 'CV → segment 6 primary knob.',
  'stages.shape0_cv': 'CV → segment 1 SHAPE knob (phase warp for RAMP, portamento for HOLD/STEP).',
  'stages.shape1_cv': 'CV → segment 2 SHAPE knob.',
  'stages.shape2_cv': 'CV → segment 3 SHAPE knob.',
  'stages.shape3_cv': 'CV → segment 4 SHAPE knob.',
  'stages.shape4_cv': 'CV → segment 5 SHAPE knob.',
  'stages.shape5_cv': 'CV → segment 6 SHAPE knob.',
  'stages.out0': 'CV output for segment 1 — mirrors its chain group\'s current value (so any segment in the chain can be tapped).',
  'stages.out1': 'CV output for segment 2 — mirrors chain value.',
  'stages.out2': 'CV output for segment 3 — mirrors chain value.',
  'stages.out3': 'CV output for segment 4 — mirrors chain value.',
  'stages.out4': 'CV output for segment 5 — mirrors chain value.',
  'stages.out5': 'CV output for segment 6 — mirrors chain value.',
  // MIDI-CV-BUDDY — hardware MIDI controller → pitch + gate + velocity CV.
  'midiCvBuddy.pitch_cv':    'V/oct pitch output (0V = C4 = MIDI 60). Pitch-bend is summed in at the MIDI-standard ±2 semitones each side.',
  'midiCvBuddy.gate':        'Gate output. HIGH while any key is held; with RETRIG on, dips to 0 for one audio block on each new note-on so a downstream ADSR re-fires.',
  'midiCvBuddy.velocity_cv': 'Velocity CV (0..1, raw MIDI velocity / 127). Updated on each note-on; latched between events.',
  // MIDICLOCK — hardware MIDI transport bridge.
  'midiclock.clock':     'Gate. Rising edge every N incoming MIDI clock ticks; N selectable as 24 (quarter, default) / 12 (eighth) / 6 (sixteenth) / 3 (32nd) / 1 (raw 24 PPQN). Patch into TIMELORDE.clock to slave it to the external transport.',
  'midiclock.run':       'CV. 0 while transport is stopped, 1 while running. Latched. MIDI Continue (0xFB) raises this to 1 without re-firing midistart.',
  'midiclock.midistart': 'One-shot gate. Fires on MIDI Start (0xFA). Continue (0xFB) does NOT fire this — it raises run only.',
  'midiclock.midistop':  'One-shot gate. Fires on MIDI Stop (0xFC).',
  'helm.pitch_cv': 'Optional V/oct pitch fallback (used when no MIDI device is connected — triggers a single voice on the lane-0 path). Audio-rate, passthrough.',
  'helm.gate':     'Optional gate fallback. Rising edge → note-on at the current pitch_cv; falling edge → note-off.',
  'helm.midi_in':  'Visual-only port. MIDI flows through the Web MIDI API (gear-icon settings panel), not through a cable. Listed here so the palette/cable visuals show MIDI as a first-class input on the card.',
  'helm.out_l':    'Stereo left audio output. Post-filter, post-amp-env, post-master-volume.',
  'helm.out_r':    'Stereo right audio output. Post-filter, post-amp-env, post-master-volume. Voice-spread alternates which side voices favor.',
  // HYDROGEN — drum machine. 18 ports: clock_in + reset_in + 16 per-instrument
  // trigs + stereo out. Per-instrument trig labels follow the kit-row order
  // (KICK1 / KICK2 / SNR1 / SNR2 / CLAP / HHc / HHo / HHp / TomH / TomM / TomL
  // / CONGA / CYMB / SHAKE / CLAVE / CWBLL — same id-suffix as in the
  // hydrogen-tr808-kit data module).
  'hydrogen.clock_in': 'Optional external clock. When patched, each rising edge advances the pattern by one step (16-step bar at 4/4 → 16 sixteenths per loop). Pairs naturally with TIMELORDE.clock at its 1/16 division.',
  'hydrogen.reset_in': 'Optional reset gate. Rising edge resets the playhead to step 0 at the next tick. Useful for re-syncing to a song-position trigger from MIDICLOCK or a custom transport.',
  'hydrogen.out_l':    'Stereo left audio output. Sum of every voice currently sounding, post-instrument-vol / post-pan / post-master-gain. No DC blocking — chain into AUDIOOUT or AUDIO-OUT for the rack\'s master limiter.',
  'hydrogen.out_r':    'Stereo right audio output. Mirror of out_l on the right channel.',
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
  if (type === 'hydrogen') {
    // HYDROGEN uses `...instrumentInputPorts()` + `...TR808_INSTRUMENTS.flatMap(...)`
    // to expand its 16-instrument port + param list — the literal-array
    // extractor sees the spread and returns nothing. Reproduce the same
    // shape statically so the manifest stays in sync.
    const N = 16;
    const params: ManifestParam[] = [
      { id: 'bpm',       label: 'BPM',  defaultValue: 120, min: 30,  max: 300,  curve: 'linear' },
      { id: 'swing',     label: 'Sw',   defaultValue: 0,   min: 0,   max: 0.75, curve: 'linear' },
      { id: 'gain',      label: 'Gain', defaultValue: 1,   min: 0,   max: 2,    curve: 'linear' },
      { id: 'isPlaying', label: 'Play', defaultValue: 0,   min: 0,   max: 1,    curve: 'discrete' },
      // Phase-3 (multi-kit): 4 kits today (tr808/tr909/fmperc/8bit).
      // Keep max in sync with KIT_COUNT in hydrogen-kit-registry.ts.
      { id: 'kit',       label: 'Kit',  defaultValue: 0,   min: 0,   max: 3,    curve: 'discrete' },
    ];
    for (let i = 0; i < N; i++) {
      params.push({ id: `vol${i}`,  label: `i${i}V`, defaultValue: 1, min: 0,    max: 2,  curve: 'linear' });
      params.push({ id: `pan${i}`,  label: `i${i}P`, defaultValue: 0, min: -1,   max: 1,  curve: 'linear' });
      params.push({ id: `A${i}`,    label: `i${i}A`, defaultValue: 0, min: 0,    max: 2,  curve: 'log' });
      params.push({ id: `D${i}`,    label: `i${i}D`, defaultValue: 0, min: 0,    max: 2,  curve: 'log' });
      params.push({ id: `S${i}`,    label: `i${i}S`, defaultValue: 1, min: 0,    max: 1,  curve: 'linear' });
      params.push({ id: `R${i}`,    label: `i${i}R`, defaultValue: 1, min: 0.01, max: 5,  curve: 'log' });
      params.push({ id: `mute${i}`, label: `i${i}M`, defaultValue: 0, min: 0,    max: 1,  curve: 'discrete' });
      params.push({ id: `solo${i}`, label: `i${i}S`, defaultValue: 0, min: 0,    max: 1,  curve: 'discrete' });
    }
    // Phase-2 (per-voice controls): add pitch/cutoff/Q per instrument.
    for (let i = 0; i < N; i++) {
      params.push({ id: `pitch${i}`,  label: `i${i}Pi`, defaultValue: 0,     min: -24,  max: 24,    curve: 'linear' });
      params.push({ id: `cutoff${i}`, label: `i${i}Cf`, defaultValue: 20000, min: 20,   max: 20000, curve: 'log' });
      params.push({ id: `q${i}`,      label: `i${i}Q`,  defaultValue: 0.7,   min: 0.1,  max: 20,    curve: 'log' });
    }
    const inputs: ManifestPort[] = [
      { id: 'clock_in', type: 'gate' },
      { id: 'reset_in', type: 'gate' },
      // Phase-4 (preset slots): shared transport CV ports.
      { id: 'play_cv',   type: 'gate' },
      { id: 'reset_cv',  type: 'gate' },
      { id: 'queue1_cv', type: 'gate' },
      { id: 'queue2_cv', type: 'gate' },
      { id: 'queue3_cv', type: 'gate' },
      { id: 'queue4_cv', type: 'gate' },
    ];
    for (let i = 0; i < N; i++) inputs.push({ id: `trig${i}`, type: 'gate' });
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
      // iCloud / Dropbox-style sync-conflict siblings ("foo 2.ts", "bar 3.ts")
      // are local-machine artifacts, not real module sources. They have a
      // bare-int marker before the extension; the canonical sources never
      // contain a space. Skipping by `' ' in basename` is safe + simple.
      if (file.includes(' ')) return false;
      // Skip companion / test files — they live next to module sources but
      // aren't module definitions themselves.
      if (file.endsWith('.test.ts')) return false;
      if (file.endsWith('-state.ts')) return false;
      if (file.endsWith('-data.ts')) return false;
      // -draw.ts: shared 2D-canvas draw helpers (e.g. scope-draw.ts that
      // both ScopeCard.svelte and the cross-domain video bridge use).
      // Not a ModuleDef.
      if (file.endsWith('-draw.ts')) return false;
      // -engine.ts: pure-math worklet-engine mirror (e.g. stages-engine.ts).
      // Not a ModuleDef — exported only for the parallel module file's
      // import + the tests / ART scenarios.
      if (file.endsWith('-engine.ts')) return false;
      // Shared transport helpers (PR feat/sequencer-transport-quicksave) —
      // SAVE/LOAD/QUEUE plumbing used by Sequencer / DRUMSEQZ / SCORE.
      // Not a ModuleDef.
      if (file === 'transport-helpers.ts') return false;
      if (file === 'transport-cv.ts') return false;
      if (file === 'transport-card.ts') return false;
      // Shared lookahead-vs-sounding-now playhead helper used by Sequencer /
      // POLYSEQZ / DRUMSEQZ / SCORE / Cartesian. Not a ModuleDef.
      if (file === 'playhead-tracker.ts') return false;
      // Shared per-user-view-state page-nav helpers (DRUMSEQZ / POLYSEQZ /
      // MACSEQ / Sequencer). Not a ModuleDef.
      if (file === 'sequencer-pages.ts') return false;
      // HYDROGEN's supporting files: kit registry, per-kit data tables,
      // synth-utils. The module def lives in hydrogen.ts; everything
      // else with the `hydrogen-` prefix is implementation detail.
      if (file.startsWith('hydrogen-')) return false;
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
