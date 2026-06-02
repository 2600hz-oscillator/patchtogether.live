// packages/web/src/lib/graph/types.ts
//
// Patch graph data model. Per D8 the patch graph lives in a Yjs doc accessed
// through SyncedStore. Per D18 the type system is registry-based, not closed,
// so future visual modules can register new domains and cable types without
// touching this file's union members.

// ---------------- Domain (D18) ----------------
// Phase 1 ships 'audio'. The video-domain spike (Phase 0 of the visual
// modules MVP) adds 'video' alongside; future domains (e.g. MIDI, OSC)
// follow the same pattern. The `(string & {})` open union preserves
// autocomplete on the well-known set while leaving the door open for
// runtime-registered domains.
type StandardDomain = 'audio' | 'video';
export type Domain = StandardDomain | (string & {});

// ---------------- Cable types (D6, D7, D18) ----------------
// `polyPitchGate` is the Stage-1 polyphony cable (10 audio channels packed
// (p0,g0,p1,g1,...,p4,g4) — 5 voice pairs). See packages/web/src/lib/audio/poly.ts
// and .myrobots/plans/dx7-and-polyphony.md §5 for the architecture.
//
// Video-domain cable types (Phase 0):
//   keys       — single-channel still mono image (no time axis)
//   image      — RGB still image (no time axis)
//   mono-video — single-channel animated video stream
//   video      — RGB animated video stream
// Implicit upcasting `keys → mono-video`, `image → video`, `keys → image`
// is allowed; the upcast is free at the shader layer. See `canConnect`.
type StandardCableType =
  | 'audio'
  | 'pitch'
  | 'gate'
  | 'cv'
  | 'polyPitchGate'
  | 'keys'
  | 'image'
  | 'mono-video'
  | 'video';
export type CableType = StandardCableType | (string & {});

/** True if `type` is one of the four video-domain cable types. */
export function isVideoCableType(type: CableType): boolean {
  return type === 'keys' || type === 'image' || type === 'mono-video' || type === 'video';
}

/** The "CV family" — bipolar audio-rate voltages that all flow through the
 *  same Web Audio routing and are freely interchangeable at the type level.
 *  `cv` is the canonical bipolar control voltage; `pitch` adds the V/oct
 *  semantic; `gate` is a 0/+5V style trigger. The engine handles them
 *  uniformly (CV → AudioParam, with the cv-scale helper applied when the
 *  destination opts in), and real-world patches routinely cross-patch them
 *  — a SEQUENCER.gate firing into an ADSR.attack as a modulator, an LFO
 *  driving AnalogVCO.pitch_cv to wiggle pitch, a Sequencer.pitch into a
 *  filter cutoff for keytracking. canConnect used to reject these at the
 *  UI level (the patch-to cascade hid them as "not compatible") even though
 *  the engine permits them — see canConnect(). */
const CV_FAMILY = new Set<string>(['cv', 'pitch', 'gate']);

/**
 * Returns true if a cable of `srcType` may legally terminate on a port
 * declaring `dstType`. Equal types always pass; explicit upcasts cover:
 *
 *   * Video-domain "free" conversions: keys→mono-video, keys→image,
 *     image→video, mono-video→video.
 *   * CV family (cv ↔ pitch ↔ gate): any direction. They're all bipolar
 *     audio-rate voltages flowing through the same AudioParam plumbing,
 *     and rejecting cross-family patches at the UI level (while the engine
 *     happily routes them at runtime) hid legitimate patches from the
 *     patch-to cascade. See CV_FAMILY above.
 *   * polyPitchGate ↔ cv-family: the engine interposes a splitter
 *     (poly→mono picks channel 0) or merger (mono→poly fills channel 0,
 *     rest silent) via resolveConnection in poly.ts — we mirror that
 *     permissiveness at the type-check level here.
 *   * Audio CV → video param input (frame-rate sample-and-hold; the
 *     bridge is wired in Phase 1, but we permit the connection at the
 *     type level so the eventual bridge doesn't change call-site type
 *     checks).
 *
 * Strictly out: audio → any non-audio port; video → any audio port; gate
 * → audio (a 0/5V gate landing on an audio bus is the kind of click track
 * the limiter shouldn't have to defend against).
 */
export function canConnect(srcType: CableType, dstType: CableType): boolean {
  if (srcType === dstType) return true;

  const upcasts: Record<string, readonly string[]> = {
    keys: ['mono-video', 'image'],
    image: ['video'],
    'mono-video': ['video'],
  };
  const ok = upcasts[srcType as string];
  if (ok && ok.includes(dstType as string)) return true;

  // CV family — cv / pitch / gate all interchange at the type level.
  if (CV_FAMILY.has(srcType as string) && CV_FAMILY.has(dstType as string)) {
    return true;
  }

  // polyPitchGate ↔ cv-family. Splitter / merger interposed by the
  // engine's resolveConnection (poly.ts).
  if (srcType === 'polyPitchGate' && CV_FAMILY.has(dstType as string)) return true;
  if (CV_FAMILY.has(srcType as string) && dstType === 'polyPitchGate') return true;

  // Audio CV → video param input (frame-rate sample-and-hold; deferred
  // bridge in Phase 1). Permit at the type level so the eventual bridge
  // doesn't change call-site type checks.
  if (srcType === 'cv' && isVideoCableType(dstType)) return true;

  return false;
}

// ---------------- Module types (D5) ----------------
type StandardModuleType =
  | 'audioOut'
  | 'analogVco'
  | 'wavetableVco'
  | 'adsr'
  | 'filter'
  | 'vca'
  | 'mixer'
  | 'sequencer'
  | 'reverb'
  | 'scope'
  // RASTERIZE — explicit audio→video raster mapper (crossing-the-streams
  // slice 1). audio in → mono-video out; each frame paints a fixed run of
  // audio samples as voltage-per-pixel in raster order, scan cursor drifts
  // + wraps through the 640×480 frame. Faithful raster (NOT a scope trace)
  // — a steady tone paints drifting horizontal bands. Fully untamed.
  | 'rasterize'
  | 'lfo'
  | 'cartesian'
  | 'destroy'
  | 'qbrt'
  | 'drummergirl'
  | 'meowbox'
  | 'mixmstrs'
  | 'timelorde'
  | 'charlottesEchos'
  | 'riotgirls'
  | 'score'
  | 'drumseqz'
  | 'polyseqz'
  // GRIDS — Mutable Instruments topographic drum pattern generator
  // (BD/SD/HH triggers + accent from a 5x5 interpolated drum map; euclidean mode).
  | 'grids'
  // WAVVIZ — wavetable VCO with built-in wavefolder + waveform-video output.
  | 'wavviz'
  // SWOLEVCO — Buchla 259-style complex VCO (primary + modulator + cross-mod
  // + symmetry morph + wavefolder + scope video out).
  | 'swolevco'
  // Video-domain modules (Phase 0 spike):
  | 'lines'
  | 'videoOut'
  // SHAPES — geometry source (circle / square / triangle, optional tile,
  // CV-controllable rotate + zoom). Sibling to LINES.
  | 'shapes'
  // MONOGLITCH — luma → vertical-scanline displacement OUTPUT. Originally
  // shipped as "RUTTETRA" (PR-99) but renamed once the actual Rutt/Etra
  // raster-coord-remap model landed under that name.
  | 'monoglitch'
  // RESHAPER — fragment-shader raster-scan-coordinate REMAP (formerly
  // RUTTETRA). X/Y are mono-video coordinate fields, Z is the source
  // video. Pair with SHAPEDRAMPS for shaped/folded/radial coord remaps.
  | 'reshaper'
  // RUTTETRA — AUTHENTIC forward-scatter Rutt-Etra scope (real line
  // geometry, port of p10entrancer XYZ). One Z video input; internal
  // shaped ramps bow each scanline by luma → 3D heightmap. (This type id
  // formerly belonged to the coord-remap, now RESHAPER — see migration in
  // graph/persistence.ts.)
  | 'ruttetra'
  // SHAPEDRAMPS — sync-locked ramp generator. Stable linear h_lin/v_lin
  // outputs (clean raster passthrough) plus shaped h_out/v_out outputs
  // (morphable for RESHAPER's raster-coord remap).
  | 'shapedramps'
  // Video-domain modules (Phase 1 — .myrobots/plans/video-modules-mvp.md):
  | 'inwards'
  | 'picturebox'
  | 'destructor'
  | 'chroma'
  | 'luma'
  // CHROMAKEY — proper 2-input chroma-key compositor (fg + bg + key
  // color). Replaces the old single-input CHROMA which conflated
  // "key-mask extraction" with the user-facing concept of a keyer.
  | 'chromakey'
  // LUMAKEY — 2-input luma-key compositor (fg + bg + luma threshold).
  // Sibling to CHROMAKEY; replaces the old single-input LUMA's
  // mask-extraction shape.
  | 'lumakey'
  | 'colorizer'
  | 'feedback'
  | 'videoMixer'
  // CAMERA — webcam input (local-only). Spec: .myrobots/plans/module-camera-input.md.
  | 'cameraInput'
  // ILLOGIC — combined attenuverter / math / logic utility (audio domain).
  | 'illogic'
  // UNITYSCALEMATHEMATIK — three independent CV-shaping channels (1 unity
  // attenuvert + 2 attenuvert-with-linear/expo-curve sections), all bipolar.
  | 'unityscalemathematik'
  // ANALOGLOGICMATHS — analog-logic mixer (MIN/MAX/DIFF/SUM/PRODUCT) inspired
  // by Mystic Instruments ANA. Two continuous inputs feed bipolar
  // attenuverters, then five simultaneous algebraic outs. Continuous-signal
  // analog logic — NOT the digital boolean logic of ILLOGIC.
  | 'analogLogicMaths'
  // DX7 — pure-TypeScript 6-op FM synth with bundled factory-inspired patches.
  | 'dx7'
  // NOISE — basic noise source with white / pink / brown outputs.
  | 'noise'
  // BUGGLES — chaotic random voltage source (wogglebug-style).
  | 'buggles'
  // VDELAY — video delay + feedback echo (ring buffer of FBO textures).
  | 'vdelay'
  // FREEZEFRAME — video sample & hold + per-channel posterize. video_in +
  // gate_in; 5 video outs (combined + isolated r/g/b/luma). Unpatched gate
  // = live passthrough; patched gate captures-while-high, freezes-on-low.
  | 'freezeframe'
  // BACKDRAFT — video feedback generator. Crossfades two inputs (MIX) and
  // composites with a delayed + colour-processed copy of its own previous
  // output (1-frame-lag feedback ring); LIGHTEN/DARKEN key masks modulate
  // the feedback effect per-pixel.
  | 'backdraft'
  // BENTBOX — CRT display output simulating an NTSC composite signal bent
  // through an Archer-Video-Enhancer-style "AVEmod" feedback circuit. 12
  // CV-controllable bending knobs (timing/chroma/feedback/CRT).
  | 'bentbox'
  // ACIDWARP — 320×240 plasma video source with scene cycler. NTSC 4:3
  // output — pairs naturally with BENTBOX downstream.
  | 'acidwarp'
  // MANDLEBLOT — Mandelbrot fractal generator. WebGL2 fragment shader,
  // log-mapped zoom 1×..1e6×, rotation, RGB-cycling hue (mu + time +
  // log(zoom) so colours shift as you zoom). Two outputs: mono escape-
  // time field + colour palette pass.
  | 'mandleblot'
  // WAVECEL — stereo wavetable VCO with morph + spread + wavefolder. Loads
  // E352 Cloud Terrarium-format WAV wavetables; Card UI provides a 3D
  // wavetable visualization mode alongside the standard scope view.
  | 'wavecel'
  // FOXY — hybrid audio-visual module. Internal chain: mini SWOLEVCO →
  // RASTERIZE → 256×256 downsample → simplified RUTTETRA ("XYZ" window) →
  // realtime XYZ→wavetable → internal WAVECEL VCO. Exposes WAVECEL's full
  // param/IO surface plus the source + XYZ window controls.
  | 'foxy'
  // WARRENSPECTRUM — stereo 8-band filterbank with vactrol-style ping
  // excitation + acidwarp video visualizer. Audio domain with a
  // cross-domain `viz_out` mono-video bridge for the EQ-curve+waveform+
  // ping-flash visualization.
  | 'warrenspectrum'
  // SYNESTHESIA — 4-band audio-analysis module (2 independent copies); per-band
  // gain + VU meter + slow/fast envelope-follower CV + gate outputs.
  | 'synesthesia'
  // STEREOVCA — stereo VCA + ring modulator. Same per-channel multiply
  // behaves as VCA gain (slow strength) or ring mod (audio-rate strength);
  // INDEPENDENT normalling on the audio and strength halves.
  | 'stereovca'
  // SHIMMERSHINE — lush stereo shimmer reverb. Schroeder tank
  // (4 combs + 2 allpasses per channel) with a pitch-shifted (+12 semis)
  // feedback loop using a granular-fade dual-head pitch shifter.
  | 'shimmershine'
  // MACROOSCILLATOR — Plaits-style macro oscillator (Mutable Instruments
  // archetype). First slice ships two synthesis models behind the three
  // canonical macros (HARMONICS / TIMBRE / MORPH): virtual analog (VA) and
  // waveshape. Pure-TS clean-room implementation; not a port of Plaits' C++
  // (see PR #27 for the closed emscripten attempt + .myrobots note).
  | 'macrooscillator'
  // CLOUDS — granular texture processor (Mutable Instruments Clouds
  // archetype, Émilie Gillet, 2014, MIT-licensed). Pure-TypeScript port
  // of the GRANULAR mode: 2-second stereo ring buffer + overlap-added
  // grain cloud (up to 24 grains) + latched FREEZE + V/oct grain-pitch
  // tracking. 6 macros (Position / Size / Pitch / Density / Texture /
  // Blend). v1 ships GRANULAR mode only; STRETCH / LOOPING-DELAY /
  // SPECTRAL deferred.
  | 'clouds'
  // MACSEQ — 16-step sequencer with per-step MACROOSCILLATOR voice picker.
  | 'macseq'
  // RINGS — modal / sympathetic-string resonator (Mutable Instruments
  // Rings archetype; faithful algorithm port of Émilie Gillet eurorack/rings/
  // DSP, MIT-licensed). v1 ships two resonator models:
  // (0) MODAL — 24 parallel stiffness-stretched RBJ bandpasses;
  // (1) SYMPATHETIC — 2 parallel Karplus-Strong delay lines.
  // Polyphony 1 only; STRING + REVERB deferred to follow-up PRs.
  | 'rings'
  // ELEMENTS — modal / physical-modeling voice (Mutable Instruments Elements
  // archetype, Émilie Gillet, 2014, MIT-licensed). EXCITER (BOW/BLOW/STRIKE) →
  // modal SVF resonator + tube + stereo pickup. Stereo main/aux out. SPACE
  // reverb tail is a simplified FDN-lite; STRING resonator model deferred.
  | 'elements'
  // PEAKS — dual-channel multi-mode utility (Mutable Instruments Peaks
  // archetype, Émilie Gillet, 2013, MIT-licensed). Each channel runs one
  // of five modes (KICK / SNARE / HIHAT / ENV / LFO) with two mode-
  // dependent knobs, a gate input, and CV-routed knob inputs. v1 ships
  // five modes; multistage envelope / tap-LFO / BPF mode deferred.
  | 'peaks'
  // MARBLES — random sampler / Bernoulli-gate + quantized-CV generator
  // (Mutable Instruments archetype, Émilie Gillet, MIT-licensed). T-section
  // (t1/t2) runs COIN/CLUSTERS/DRUMS/INDEP/3-STATE/MARKOV gate models with
  // déjà-vu Markov locking + jitter; X-section (x1/x2/x3) draws random
  // voltages shaped by SPREAD/BIAS/STEPS through a weighted-scale quantizer
  // with its own déjà-vu loop. clk is the master clock.
  | 'marbles'
  // SYMBIOTE — Marbles core running the always-on "Symbiote" alt-firmware:
  // T-section = Grids drum engine (BD/SD/HH on t1/t2/t3, Drums 2D-map or
  // Euclidean sub-mode), X-section = TB-3PO acid sequencer (x1 clock, x2
  // 1V/oct pitch, x3 gate, y accent). Grids PatternGenerator + drum-maps are
  // GPLv3 (Émilie Gillet); TB-3PO from the O&C Hemisphere applet. No hardware
  // T-MODEL long-press / déjà-vu sub-mode toggle — all controls are params.
  | 'symbiote'
  // WARPS — meta-modulator / signal masher (Mutable Instruments Warps
  // archetype, Émilie Gillet, 2014, MIT-licensed). Clean-room TypeScript
  // port. v1 ships 4 Xmod algorithms (XFADE / RING-MOD / XOR / COMPARE)
  // with an internal carrier oscillator (sine / triangle / saw / square)
  // so the module is usable with a single input or no inputs at all.
  // FOLD / ANALOG-RING / FREQUENCY-SHIFTER / DOPPLER / VOCODER deferred
  // to follow-up.
  | 'warps'
  // VEILS — quad VCA + soft-clip summing mix (Mutable Instruments Veils
  // archetype). 4 independent VCAs each with audio in, CV in, gain knob,
  // per-channel response toggle (linear / exponential), and a direct out;
  // plus a tanh-soft-clipped sum mix out. Gain knobs span [0, 2] so
  // knob+CV can push past unity into warm overdrive.
  | 'veils'
  // ATTENUMIX — the simple 4-channel attenuating mixer. Per-channel
  // attenuator (knob 0..1) + CV-summed input + post-attenuator direct out
  // + master knob (0..2) → tanh-soft-clipped mix output. Same topology as
  // VEILS but capped attenuators (no per-channel boost), no response
  // toggle, simpler labeling — this is the "I just want a mixer" mixer.
  | 'attenumix'
  // BLADES — dual state-variable VCF + COLOR overdrive + mix bus
  // (Mutable Instruments Blades archetype, analog hardware → from-spec
  // TS implementation). Two independent SVF cores each with LP/BP/HP
  // mode + V/oct CV + cutoff CV + resonance CV; global COLOR knob
  // tanh-soft-clips the input pre-filter for the signature grit; mix
  // bus toggles PARALLEL (sum) vs SERIAL (filter1 → filter2).
  | 'blades'
  // STAGES — 6-segment cascadable function generator (Mutable Instruments
  // Stages archetype, Émilie Gillet, 2017, MIT-licensed). Clean-room TS
  // port: 6 segments, each with a TYPE select (RAMP / HOLD / STEP), a
  // primary knob (TIME for RAMP; LEVEL for HOLD/STEP), and a SHAPE knob
  // (phase warp for RAMP; portamento for HOLD/STEP). Adjacent segments
  // can be LINKed via 5 boundary bits to form multi-stage envelopes (AHD,
  // AHDSR, longer arbitrary shapes). Each segment has its own GATE input
  // and CV output; a global TRIG input re-fires every chain's leader.
  // v1 ships TYPE + LINK + GATE + TRIG; Outliner / chord-mode / looping
  // LFO mode deferred to follow-up.
  | 'stages'
  // CLOUDSEED — exact algorithm port of Ghost Note Audio CloudSeed reverb
  // (MIT-licensed). Stereo input → cross-mix → per-channel: optional pre-EQ
  // HP/LP → modulated pre-delay → multitap early field → AllpassDiffuser
  // (up to 12 stages) → 12 parallel late-field DelayLine voices each with
  // optional in-loop AllpassDiffuser + LowShelf + HighShelf + LP. Exposes
  // 7 macro AudioParams (DRY/EARLY/LATE/INPUT_MIX/LOW_CUT/HIGH_CUT/CROSS_SEED)
  // + 38 message-port params (toggles, integer counts, seeds, modulation
  // knobs). Bundled v1 preset bank: DIVINE INSPIRATION (DarkPlate from
  // the C++ Programs.h verbatim), SHORT ROOM, BRIGHT HALL, INFINITE PAD.
  | 'cloudseed'
  // MIDI-CV-BUDDY — hardware MIDI controller → pitch + gate + velocity CV.
  // Main-thread Web MIDI handler writing into three ConstantSourceNode
  // outputs. Monophonic with user-selectable voice priority (LAST / LOW /
  // HIGH), retrigger toggle, channel filter, and a device picker.
  | 'midiCvBuddy'
  // MIDI-OUT-BUDDY (label "MIDI CV BUDDY OUT") — output complement of
  // MIDI-CV-BUDDY. gate/pitch/velocity CV inputs → MIDI NoteOn/NoteOff sent
  // to a selected external MIDI OUTPUT device + channel. Main-thread Web MIDI
  // bridge (no worklet); terminal sink with no audio outputs.
  | 'midiOutBuddy'
  // MIDICLOCK — hardware MIDI transport bridge. CLOCK (gate) at user-
  // selected subdivision (default quarter-note → TIMELORDE-compatible),
  // RUN (cv, 0/1), MIDISTART + MIDISTOP (one-shot gates). System Real-
  // Time messages only — channel-voice handling is MIDI-CV-BUDDY's job.
  | 'midiclock'
  // HELM — polyphonic subtractive synth (algorithm port of Matt Tytel's
  // Helm GPL-3.0). 2 morphing oscillators + sub + noise → SVF filter →
  // 3 ADSR envelopes → 2 mono LFOs → 16-step step sequencer; polyphonic
  // MIDI input via gear-icon settings menu (device picker + per-channel
  // rx multi-select). Stereo output.
  | 'helm'
  // HYDROGEN — port of the Hydrogen drum machine. First pass ships the
  // bundled TR-808 emulation kit (16 instruments × 16-step pattern grid,
  // single-layer samples). Sample assets live in /drumkits/tr808/.
  | 'hydrogen'
  // STICKY — paper-style sticky note (domain 'meta'). No ports, no engine
  // binding; just an editable, resizable, Yjs-synced text card. Lives in
  // the palette's "meta" category.
  | 'sticky'
  // GROUP — collapses N modules into a single card (domain 'meta'). No
  // engine binding; ports are dynamic from data.exposedPorts, projected
  // through to the underlying child ports by group-projection.ts so the
  // engine never sees groups. Module-grouping Phase 1 feature.
  | 'group'
  // LIVECODE — JS-runtime live-coding module. CodeMirror editor with
  // port-aware autocomplete + diagnostics; runtime is a `new Function`
  // sandbox exposing spawn/patch/set/read/clock.*/clocked(). No audio
  // I/O — the card mutates the patch graph directly. See
  // /docs/modules/livecode.
  | 'livecode'
  // CLOCKED runner — a self-contained mini-LIVECODE spawned by
  // LIVECODE's clocked(division, fn) call. Owns one subscription; its
  // body re-fires on every division boundary derived from TIMELORDE
  // bpm. Deleting the runner cancels the subscription. No audio I/O.
  | 'clockedRunner'
  // PONG — interactive game module (research prototype). CV paddles in,
  // gate scores out. Single-user in this slice; multi-user wiring
  // documented in docs/design/game-modules.md.
  | 'pong'
  // MODTRIS — Tetris-clone game module (research prototype). 5 gate inputs
  // (rotate L/R, drop, move L/R), 2 gate outputs (line_cleared, overfill).
  // Single-user in this slice; multi-user via 30 Hz awareness snapshot is
  // a follow-up per docs/design/game-modules.md §2.
  | 'modtris'
  // FROGGER — clean-room port of Adrian Eyre's Frogger (MIT-licensed). All
  // 5 inputs are CV gates (up/down/left/right + start). The start_gate
  // auto-fires once on module spawn so the user sees a running game by
  // default (the upstream React app's pre-game InfoBoard is bypassed via
  // this synthesized first-tick pulse — "boot" = module spawn). 3 gate
  // outputs (home_gate, dead_gate, level_gate) fire one 5 ms pulse per
  // event. vizPassthrough: true — the on-card canvas can be portaled into
  // a containing GroupCard for cross-domain video out. Single-user; multi-
  // user follows the same per-docs/design/game-modules.md path as MODTRIS.
  | 'frogger'
  // SM64 — Super Mario 64 (sm64js pure-JS port, WTFPL). Single-instance
  // (maxInstances:1) per rack. CV stick (X/Y bipolar −1..+1 → ±64) +
  // 9 gates (A/B/Z/R/C-up/C-down/C-left/C-right/Start). On first spawn
  // without a ROM in IDB the card shows an upload dropzone — once the
  // user supplies a US .z64, the bundle extracts assets into IDB and
  // future spawns boot straight to a running game. No outputs;
  // vizPassthrough on the canvas covers cross-domain video output.
  | 'sm64'
  // SKIFREE — the classic SkiFree (ski downhill, dodge trees/rocks, get
  // chased + eaten by the yeti). skifree.js engine (MIT). Single-instance.
  // x/y CV synthesize the mouse cursor the skier steers toward; gate fires
  // a rising edge on crash / eaten-by-yeti; out is the game canvas (video).
  // Native mouse steering when x/y unpatched + card focused (CV overrides).
  | 'skifree'
  // JOYSTICK — manual XY pad. Outputs x, y, nx (= -x), ny (= -y) as CV.
  // No inputs in v1 (future: MIDI-mappable). Mirrors how an LFO emits
  // multiple inverted/quadrature outputs from a single source of motion.
  | 'joystick'
  // GAMEPAD — connected USB/Bluetooth HID controller (Xbox / PS /
  // generic) as CV (stick axes + triggers) and gate (face / bumper /
  // dpad / menu buttons). Polls navigator.getGamepads() at rAF rate.
  | 'gamepad'
  // NUMPAD+ — numpad-driven 4-layer × 16-step sequencer with live
  // play, REC ARM (one-pass record on next play-from-start) and
  // OVERDUB (always-recording). Captures Numpad* keys globally.
  | 'numpadPlus'
  // WAVESCULPT — hybrid 4-oscillator video synth. Four "wall-mounted"
  // virtual oscillators emit 3D wave ribbons inside a unit box; a user-
  // controlled camera (XY joystick + height + zoom) renders a view of
  // the scene. Audio output is the distance-attenuated sum of all four
  // voices (stereo). Final video pass: BENTBOX-style CRT.
  | 'wavesculpt'
  // ATLANTIS-PATCH support trio. Each is general-purpose; together they
  // make Schrader-style self-evolving "ecosystem" patches tractable.
  // SLEWSWITCH — quad slew limiter + 4→1 sequential CV switch.
  | 'slewSwitch'
  // SAMPLE & HOLD — rising-edge sample & hold + scale quantizer. When gate_in
  // is unpatched it becomes a pure continuous quantizer (SKIFREE-style
  // unpatched-input detection at the graph level).
  | 'sampleHold'
  // ATLANTISCATALYST — 8 correlated random-walk CV outputs + scene pulse
  // / scene index, with HYDROGEN-style transport CV for explicit jumps.
  | 'atlantisCatalyst'
  // AQUATANK — 4-channel Hadamard FDN feedback matrix; the metallic /
  // aquatic resonance engine the demo patch hangs off of.
  | 'aquaTank'
  // DOOM — single-instance interactive video module. WASM-backed
  // doomgeneric (GPLv2, vendored at packages/web/native/doomgeneric)
  // runs on whichever rack-mate spawned the card; spectators receive
  // framebuffers via Yjs awareness at ~10 Hz. 7 cv-typed gate inputs
  // (w/a/s/d/space/ctrl/alt) edge-detect into the engine's key queue;
  // stereo audio outputs route via the video→audio bridge (silent
  // until the slice-8 audio path lands). maxInstances: 1.
  | 'doom'
  // CALLSINE — spectral-analysis additive resynthesizer (algorithm port of
  // Warren's Spectrum / CallSine, MIT-licensed). audio in → STFT → tracked
  // sinusoidal peaks → additive bank (up to 64 oscillators). v1 ships two
  // voice models (SINES, SAW); scaffolded for 12+ follow-up models. Gate
  // input toggles FREEZE (latches the current spectrum).
  | 'callsine'
  // COCOA DELAY — port of Tilde Murray's Cocoa Delay (GPL-3.0). Stereo
  // tape-style delay with LFO + DRIFT delay-time modulation, bipolar
  // feedback + stereo offset + pan (static/ping-pong/circular), dry-env
  // DUCKING, in-loop multi-mode FILTER (LP+HP), and stateful DRIVE
  // saturation. Tempo-sync locks the time to a measured clock pulse
  // (TIMELORDE system clock or external MIDI clock) at a musical division.
  | 'cocoadelay'
  // RESOFILTER — multi-mode filter, port of gabrielsoule/resonarium's
  // MultiFilter (Source/dsp/MultiFilter.{h,cpp}). 5 modes drawn from the
  // upstream MultiFilter::Type enum: LP / HP / BP / Notch / Allpass.
  // Card displays the long-form mode name next to the MODE knob.
  | 'resofilter'
  // CUBE — 3D wavetable-navigator oscillator. Builds a 3D scalar field from
  // three e352 wavetables (FLOOR/WALL/CEILING) + reads an arbitrary planar
  // slice through it as the played waveform (surface-height scan). V/oct,
  // stereo ±5% spread, SMOOTH/HARD material, 3D-bitcrush CRUSH, mirror WRAP.
  | 'cube'
  // MOOG 921 VCO — first module of the Moog System 55/35 clone initiative
  // (Moog → SYS55, shared by SYS35). Voltage-controlled oscillator: ONE core
  // presenting four simultaneous waveform jacks (sine / triangle / sawtooth /
  // rectangular with variable pulse width), 1V/oct + linear-FM inputs, and a
  // hard/soft/off sync switch. Own-code polyBLEP DSP (permissive, no copyleft).
  | 'moog921Vco'
  // MOOG CP3 — console mixer slice of the Moog System 55/35 clone (Moog →
  // SYS55, shared by SYS35). 4×1 summing mixer with a (+) and a (−) phase-
  // inverted output, an attenuated 4th external input, a 1→3 MULTIPLE, and
  // ±12V/−6V trunk-reference jacks. Own-code DSP forked from the repo `mixer`.
  | 'moogCp3'
  // MOOG 904A VCF — Moog System 55/35 clone, slice 2 (Moog → SYS55, shared by
  // SYS35). Voltage-controlled transistor-ladder LOW-PASS filter, 24 dB/oct:
  // FIXED CONTROL VOLTAGE (cutoff) + RANGE switch (cutoff in 2-octave steps) +
  // summing 1V/oct CONTROL INPUTS + REGENERATION (variable Q / internal
  // feedback that self-oscillates into a clean sine VC generator near max).
  // Own-code clean-room TPT/Zavalishin zero-delay-feedback ladder + Huovilainen
  // tanh TECHNIQUE (shared lib moog-ladder-dsp; reused by 904B/904C). No
  // LGPL/CC-BY-SA copyleft.
  | 'moog904a'
  // MOOG 911 ENVELOPE GENERATOR — Moog System 55/35 clone (Moog → SYS55,
  // shared by SYS35). A three-time-constant CONTOUR generator (NOT a literal
  // ADSR): T1 attack → peak, T2 initial decay → Esus sustain level, hold
  // while gated, T3 final decay on release (trigger-close forces T3). Own-
  // code DSP (permissive). env + inverted env_inv CV outputs.
  | 'moog911'
  // MOOG 902 VCA — Moog System 55/35 clone, slice 3 (Moog → SYS55, shared by
  // SYS35). Differential voltage-controlled amplifier: a manual GAIN pot
  // ("fixed control voltage"), summing CONTROL INPUTS (cv + fcv), and a
  // LINEAR / EXPONENTIAL response switch. Gain is ×2 (+6 dB) at pot-max OR
  // CV=6 V, topping out at the ×3 ceiling near a control sum of ~7.5 V. Two
  // complementary outputs (audio + audio_inv, the phase-inverted differential
  // − twin). Own-code gain law forked from the repo's `vca` (no copyleft).
  | 'moog902'
  // TREE.oh.VOX — TB-303-style bassline voice (Open303 voice slice port,
  // MIT → AGPL). 6 knobs (TUNE / CUTOFF / RESONANCE / ENVELOPE / DECAY /
  // ACCENT) + pitch / gate / accent_in inputs + per-knob CV. The full
  // 404 module (sequencer + TD-3 UI) is queued as a follow-up.
  | 'treeohvox'
  // 4PLEXER — 4-in / 4-out discrete signal router. Each output has its own
  // selector (which of in1..in4 it carries) + its own gate input that
  // advances that selector on each rising edge (1→2→3→4→1). Audio + cv both
  // route identically through the shared Web Audio substrate.
  | 'fourplexer'
  // SIDECAR — stereo sidechain compressor. Stereo audio in, dedicated SC
  // pair (HPF-filterable on the detector path only), CV-modulatable
  // threshold + envMag, and two CV-shaped env outs (env_out + env_inv_out)
  // for cross-patch ducking. env_out has NO hard clamp — at envMag>1 the
  // output overshoots 1.0 (documented contract for downstream modules).
  | 'sidecar'
  // CHOWKICK — synth-kick voice. Hand-port of ChowKick by Jatin Chowdhury
  // / chowdsp (BSD-3-Clause). Gate-triggered single-voice kick: pulse
  // shaper (width/amp/decay/sustain) + noise burst (4 types) → 2nd-order
  // resonant peaking filter (freq/Q/damping + tight/bounce tanh
  // saturation) + tone LPF + level. 17 CV-able knobs/toggles + 1V/oct
  // pitch CV.
  | 'chowkick'
  // BLUEBOX — 12-key DTMF dialer with phreaker buttons. Digits 0-9 emit
  // the Bell-System dual-tone pair; BLUEBOX emits a single 2600 Hz
  // supervisory sine; REDBOX emits 1700+2200 Hz simultaneously. 12 audio-
  // rate gate inputs (one per button) + 12 momentary AudioParams (one per
  // button) — either source ≥0.5 holds the key down.
  | 'bluebox'
  // SCOREBOARD — 4-digit neon 7-segment counter widget (video domain).
  // SCORE gate input → counter += 1 on rising edge; RESET gate → 0.
  // Counter wraps at 10000. One colour-wheel knob for the lit-segment hue.
  | 'scoreboard'
  // QBERT — Q*Bert (Gottlieb 1982) arcade emulator (video domain). User
  // provides qbert.zip via `task setup:qbert`; gitignored. CV-only control
  // (coin / start gates + bipolar joystick CV → 4-way diagonal); per-event
  // gate outputs (move / die / level); mono audio output.
  | 'qbert';
export type ModuleType = StandardModuleType | (string & {});

// ---------------- Port + parameter schemas ----------------

/**
 * CV-input scaling hint (see .myrobots/plans/cv-range-standard.md).
 *
 * Project convention: the `cv` cable type carries a bipolar -1..+1
 * "modulation" signal where ±1 should sweep the target param through its
 * full natural range, centered on the user-set knob position. Without
 * scaling, an LFO of ±1 summed into an AudioParam whose natural range is
 * (e.g.) 0.001..10s touches only ~10% of the slider's motion — far short
 * of the user's expectation that an LFO drives a slider through its full
 * range of motion.
 *
 * Setting `cvScale` on an input PortDef tells `AudioEngine.addEdge` to
 * interpose a scaling node (GainNode for `linear`, WaveShaperNode for
 * `log`/`discrete`) between the source and the target AudioParam, so the
 * incoming -1..+1 maps to the param's full natural span.
 *
 * Modes:
 *   - `linear`: effective = clamp( knob + cv * depth * (max-min)/2, min, max )
 *     Used for params where additive modulation is the natural musical
 *     metaphor — volume, pan, mix amount, EQ band gain, etc.
 *   - `log`: effective = clamp( knob * pow(max/min, cv * depth / 2), min, max )
 *     Used for params whose perceptual range is logarithmic — frequency in
 *     Hz, time in seconds. ±1 cv = ±half the param's full octave span.
 *   - `discrete`: integer bucketing — `floor((cv+1)/2 * (max-min+1))`
 *     mapped to [min, max]. Used for mode toggles, range selectors.
 *   - `passthrough`: no scaling (Web Audio sums the source directly into
 *     the AudioParam, the legacy behavior). Use when the destination DSP
 *     already implements its own CV scaling (e.g. filter.dsp's ±5oct map).
 *
 * `depth` is reserved for a future per-param "modulation depth" knob;
 * default 1.0 = full sweep.
 */
export interface CvScaleHint {
  mode: 'linear' | 'log' | 'discrete' | 'passthrough';
  /** Per-param modulation depth. 1.0 = full natural-range sweep. */
  depth?: number;
}

export interface PortDef {
  id: string;
  type: CableType;
  // Whether the input is an audio-rate node connection or a CV → AudioParam routing.
  // Outputs are always nodes; this hint lives on inputs only.
  paramTarget?: string; // when set, CV connections route to this AudioParam
  /**
   * Optional: scaling hint for `cv`-typed input ports that target a
   * paramTarget. See CvScaleHint for the mapping. When omitted, behavior
   * is `passthrough` — Web Audio sums the source directly into the
   * AudioParam (the legacy behavior). Set explicitly to opt into the
   * "LFO sweeps full range" semantics.
   */
  cvScale?: CvScaleHint;
}

export type KnobCurve = 'linear' | 'log' | 'exp' | 'discrete';

export interface ParamDef {
  id: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  curve: KnobCurve;
  units?: string;
}

export type ParamSchema = Readonly<ParamDef[]>;

// ---------------- Patch graph (D8) ----------------
export interface ModuleNode {
  id: string;
  type: ModuleType;
  domain: Domain; // 'audio' for all Phase 1 modules
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

export interface Edge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: CableType;
  targetType: CableType;
}

export interface PatchGraph {
  nodes: Record<string, ModuleNode>;
  edges: Record<string, Edge>;
}

// ---------------- Module registry shape (D18, D19) ----------------
export interface ModuleDef {
  type: ModuleType;
  domain: Domain;
  /** Human-readable name (palette + UI). */
  label: string;
  /** Palette grouping. */
  category: 'sources' | 'modulation' | 'filters' | 'effects' | 'utilities' | 'output' | string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamSchema;
  /** Bumped when params or data shape changes (D19). */
  schemaVersion: number;
  /** Migrate older saved data forward to the current schemaVersion. */
  migrate?: (data: unknown, fromVersion: number) => unknown;
  /**
   * Module-grouping Phase 3A: when set, this module renders an on-card
   * visualization (typically a <canvas>) that can be portaled into the
   * parent GroupCard. See AudioModuleDef.vizPassthrough for the canonical
   * doc. Mirrored here so callers that read the loose ModuleDef shape
   * (e.g. defLookup helpers in Canvas.svelte) can read the flag without
   * downcasting to a domain-specific def.
   */
  vizPassthrough?: boolean;
}
