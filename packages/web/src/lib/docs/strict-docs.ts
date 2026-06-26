// packages/web/src/lib/docs/strict-docs.ts
//
// The RATCHET set for the living-docs system: module types that have been
// PROMOTED to the full documentation bar. For a module in this set the
// module-docs lint enforces COMPLETENESS — every port, every param, and every
// declared control family MUST carry an authored `docs` entry (the
// deny(missing_docs) guarantee at the I/O surface), so adding a new port to a
// strict module fails CI until it is documented.
//
// Modules NOT in this set are checked only for CONSISTENCY (no orphaned doc
// keys) — they degrade gracefully while the ratchet rolls out. Promote a module
// here once its `docs` are authored + verified. The set only grows:
//  - batches of ~5 as background work,
//  - every NEW module ships into it,
//  - any module incidentally touched for a fix is brought up + added (the
//    boy-scout rule — see CLAUDE.md "Living docs: document on touch").
//
// See .myrobots/plans/living-docs-drift-2026-06-24.md.

export const STRICT_DOCS: ReadonlySet<string> = new Set<string>([
  // Pilot wave (2026-06-24): a spread across a synth utility, a modulator, a
  // dynamic-control sequencer, a video mixer, and a stereo effect.
  'adsr',
  'lfo',
  'sequencer',
  'fader',
  'cocoadelay',
  // Batch 1 — foundational modules (2026-06-25): the bread-and-butter audio
  // chain — oscillator, amplifier, mixer, noise source, filter — each now
  // carrying authored co-located docs. (lfo + cocoadelay, the batch's other two
  // members, were already promoted in the pilot above.)
  'analogVco',
  'vca',
  'mixer',
  'noise',
  'filter',
  // Batch 2 (2026-06-25): the synth voices — macro/wavetable/FM oscillators and
  // the MI modal/physical-modeling resonators.
  'macrooscillator',
  'cube',
  'wavecel',
  'dx7',
  'helm',
  'rings',
  'elements',
  'wavetableVco',
  'swolevco',
  // Batch 3 — CV utilities & modulation shapers (2026-06-26): the bread-and-
  // butter CV toolbox — attenuverters, polarizers, slew + switch, sample &
  // hold / quantizer, fixed-gain trim, and the two quad-VCA/mix utilities.
  'polarizer',
  'depolarizer',
  'scaler',
  'attenumix',
  'veils',
  'unityscalemathematik',
  'sampleHold',
  'slewSwitch',
  // Batch 4 — effects (2026-06-26): the wet-FX cluster — the basic reverb &
  // delay, the granular CLOUDS, the SHIMMERSHINE/AQUATANK reverb-resonators,
  // the destructive CHARLOTTE'S ECHOS multi-tap delay, the DESTROY bitcrusher,
  // the WARPS meta-modulator, and the RINGBACK stereo crush.
  'reverb',
  'delay',
  'clouds',
  'charlottesEchos',
  'shimmershine',
  'aquaTank',
  'destroy',
  'warps',
  'ringback',
  // Batch 5 — Moog System 35/55 signal-processing cluster (2026-06-26): the
  // classic Moog filtering & processing chain — the 902 VCA, the 904A low-pass
  // and 904B high-pass transistor-ladder filters, the 904C filter coupler
  // (VC band-pass / notch), the 905 spring reverb, the 907A and 914 fixed
  // filter banks (graphic-EQ-style spectral shapers), and the 923 noise +
  // filter utility. Every one of these is a `card:`-override module (its card
  // name doesn't match the conventional `<type>Card`), so — like cocoadelay —
  // they stay OFF the INTERACTIVE_DOC_MODULES allowlist (the doc route's
  // defLite can't resolve an override card → static face fallback). Documented
  // (STRICT) without being live-card-interactive.
  'moog902',
  'moog904a',
  'moog904b',
  'moog904c',
  'moog905',
  'moog907a',
  'moog914',
  'moog923',
  // Batch 6 — Moog System 55/35 sources & utility cluster (2026-06-26): the
  // IIIc oscillator front-end + the passive console panels — the 921 VCO (the
  // standalone oscillator), the 921A driver + 921B slave (the master/slave
  // oscillator pair), the 903A random-signal/noise source, the 956 ribbon
  // controller (a manual pitch+gate source), the 961 interface (trigger/gate
  // format converter), the 962 sequential switch (gate-advanced selector), and
  // the passive 994 dual multiples + 995 attenuators. The override-card members
  // (903a / 956 / 961 / 962 / 994 / cp3) stay OFF INTERACTIVE_DOC_MODULES (the
  // doc route's defLite can't resolve a `card:` override → static face); the
  // convention-card members (921a / 921b / 921Vco / 995) ARE interactive.
  'moog921Vco',
  'moog921a',
  'moog921b',
  'moog903a',
  'moog956',
  'moog961',
  'moog962',
  'moog994',
  'moog995',
  // Batch 7 — Moog System 35/55 modulation & routing (2026-06-26): the cluster
  // that completes the Moog System rollout — the 911 contour generator (EG), the
  // 911A dual trigger delay, the 912 envelope follower, the 960 sequential
  // controller (3×8 analog step sequencer), the 984 4×4 matrix mixer, the 992 CV
  // panel (4→1 summer with an inverting channel), the 993 trigger & envelope
  // panel, and the CP3 console mixer. The convention-card members (moog911 /
  // moog984 — pure Knob + PatchPanel via MoogPanel) ARE interactive; the
  // override-card members (911a / 912 / 960 / 992 / 993 / cp3) stay STATIC (the
  // doc route's defLite can't resolve a `card:` override → static face fallback).
  'moog911',
  'moog911a',
  'moog912',
  'moog960',
  'moog984',
  'moog992',
  'moog993',
  'moogCp3',
  // Batch 8 — CV/signal utilities & small processors (2026-06-26): a coherent
  // utility cluster — the STEREOVCA (stereo VCA / ring modulator), GATEMAIDEN
  // (the gate↔trigger converter), ILLOGIC (attenuverter + sum/diff + digital
  // logic), ANALOGLOGICMATHS (continuous min/max/diff/sum/product), FOURPLEXER
  // (4×4 discrete signal router), FLIPPER (gate flip-flop / ÷2), plus the SCOPE
  // (2-channel oscilloscope) and two processors, SIDECAR (stereo sidechain
  // ducker) and RESOFILTER (multi-mode resonant filter). The convention-card
  // members (stereovca / gatemaiden / illogic / analogLogicMaths / sidecar /
  // resofilter — pure Fader/Knob + PatchPanel) ARE interactive; the others stay
  // STATIC: fourplexer + flipper carry a `card:` override (defLite can't resolve
  // it → static face), and scope's card runs a 2D-canvas rAF render loop.
  'stereovca',
  'gatemaiden',
  'illogic',
  'analogLogicMaths',
  'fourplexer',
  'flipper',
  'scope',
  'sidecar',
  'resofilter',
  // Batch 9 — synth voices & percussion sources (2026-06-26): a coherent cluster
  // of sound-generating modules — DRUMMERGIRL (one-shot synth drum voice),
  // MEOWBOX (formant cat-vocal voice), TREE.oh.VOX (TB-303 acid-bass voice),
  // CHOWKICK (physical-model resonant kick), PEAKS (dual drum/env/LFO utility),
  // BUGGLES (wogglebug chaotic random source), CALLSINE (spectral additive
  // resynth), and PENTEMELODICA (5-voice poly synth). The convention-card
  // members (drummergirl / meowbox / treeohvox / peaks / buggles / callsine —
  // pure Fader/Knob + PatchPanel, peaks adds two static mode buttons) ARE
  // interactive; the others stay STATIC: chowkick + pentemelodica each run a
  // 2D-canvas render in the card (chowkick's envelope/filter previews via
  // onMount + $effect, pentemelodica's per-voice waveform scopes via $effect),
  // so the engine-less doc sandbox falls back to the static face. PENTEMELODICA
  // is POLY — its POLY input must be fed by a real poly source (MIDI LANE /
  // POLYSEQZ / SEQUENCER chord steps), noted in its prose.
  'drummergirl',
  'meowbox',
  'treeohvox',
  'chowkick',
  'peaks',
  'buggles',
  'callsine',
  'pentemelodica',
  // Batch 10 — sequencers, clocks & pattern generators (2026-06-26): the
  // off-cluster sequencer family — CARTESIAN (4×4 X/Y grid sequencer), DRUMSEQZ
  // (4-track drum/trigger sequencer), KRIA (monome-Kria multi-track grid),
  // MACSEQ (MACROOSCILLATOR model+note sequencer), POLYSEQZ (polyphonic chord
  // sequencer), WRITESEQ (write-in / live-record step sequencer), MARBLES (MI
  // random sampler + clock), GRIDS (MI topographic drum-pattern generator),
  // NUMPAD+ (numpad live-record layered sequencer), and ATLANTIS-CATALYST /
  // SCENECHANGE (8-channel correlated random-walk macro brain). The
  // convention-card members whose cards are pure Knob/Fader/buttons + PatchPanel
  // (a playhead-polling requestAnimationFrame is fine — the sequencer itself
  // does it and is interactive; the engine-less doc sandbox just no-ops the
  // read) are on INTERACTIVE_DOC_MODULES: cartesian / drumseqz / macseq /
  // polyseqz / writeseq / marbles / grids / atlantisCatalyst. Two stay STATIC:
  // KRIA's card touches the WebSerial monome-grid API at init, and NUMPAD+'s
  // card installs a document-level capturing keydown listener to own the Numpad
  // keys — both side effects we keep out of the shared doc sandbox (face
  // fallback). POLYSEQZ and NUMPAD+ are POLY: their poly output must feed a real
  // poly-aware voice (RIOTGIRLS / DX7 / POLYHELM / a module with a poly input),
  // noted in their prose.
  'cartesian',
  'drumseqz',
  'kria',
  'macseq',
  'polyseqz',
  'writeseq',
  'marbles',
  'grids',
  'numpadPlus',
  'atlantisCatalyst',
  // Batch 11 — MIDI, external control & audio I/O (2026-06-26): the cluster that
  // bridges the rack to the outside world — MIDICLOCK (external MIDI transport →
  // clock/run/start/stop), MIDI-CV-BUDDY (mono MIDI keyboard → pitch/gate/vel),
  // MIDI LANE (per-channel instrument bus with CC taps, a by-note gate, and an
  // always-live POLY output), MIDI-OUT-BUDDY (rack CV/gate → MIDI notes out to
  // hardware), JOYSTICK (manual XY → four bipolar CV), GAMEPAD (a game controller's
  // 18 axes/buttons → CV/gate), AUDIO IN (system audio capture → stereo L/R), and
  // AUDIO OUT (the terminal stereo sink with DC-block + limiter). MIDI LANE is the
  // POLY member — its `poly` output must feed a real poly-aware voice (POLYHELM /
  // DX7 / CUBE / a module with a poly input), noted in its prose. ALL eight stay
  // STATIC (off INTERACTIVE_DOC_MODULES): the four MIDI cards run Web-MIDI device
  // pickers, AUDIO IN carries a `card:` override + getUserMedia, AUDIO OUT's card
  // enumerates media devices + polls the engine on mount, GAMEPAD's card runs a
  // ~60 Hz requestAnimationFrame poll of navigator.getGamepads, and JOYSTICK's
  // pad is an XY drag surface with no `control-<paramId>` Knob/Fader to probe —
  // all engine-less-doc-sandbox-unsafe or non-probeable, so the static face is
  // the right fallback for every one of them.
  'midiclock',
  'midiCvBuddy',
  'midiLane',
  'midiOutBuddy',
  'joystick',
  'gamepad',
  'audioIn',
  'audioOut',
  // Batch 12 — modulation, function generators, clocks & live-control utilities
  // (2026-06-26): the MI-style function generators TIDES2 (tidal modulator /
  // poly-slope) and STAGES (6-segment cascadable FG), the rack master clock
  // TIMELORDE, the sheet-music sequencer SCORE and the Ableton-style clip
  // launcher CLIP PLAYER, the ping-able stereo resonant filter QBRT, the
  // audio→video raster mapper RASTERIZE, and the LIVECODE scripting pair
  // (LIVECODE + the CLOCKED runner it spawns). The convention-card members whose
  // cards are pure Knob/Fader + PatchPanel — tides2, stages, qbrt — ARE on
  // INTERACTIVE_DOC_MODULES. The rest stay STATIC: timelorde + rasterize run a
  // 2D-canvas render in the card (the wizard display / the raster framebuffer),
  // score's card is an SVG staff with mouse note-entry + an onMount/$effect
  // render, clipplayer's card runs a playhead-polling render loop and pairs with
  // the WebSerial monome grid, and clockedRunner + livecode mount a CodeMirror
  // editor — all engine-less-doc-sandbox-unwise, so the static face is the right
  // fallback. SCORE declares note/tie/dynamic cell families; CLIP PLAYER declares
  // the lane mono toggles + the launch-grid pads + the piano-roll note cells (a
  // stable indexed data-testid was added to the pads + cells, which had none).
  'tides2',
  'stages',
  'timelorde',
  'score',
  'clipplayer',
  'qbrt',
  'rasterize',
  'clockedRunner',
  'livecode',
  // Batch 13 — heavy synth voices, effects & utilities (near the end of the
  // audio catalog, 2026-06-26): the previously-deferred large-param modules and
  // the remaining substantive voices/processors — CLOUDSEED (Ghost-Note algo
  // reverb, 7 macro + 38 message-port params), FOXY (hybrid realtime-wavetable
  // oscillator), POLYHELM (the polyphonic Helm voice), SYMBIOTE (Marbles
  // alt-firmware Grids+TB-3PO brain), TWOTRACKS (two-reel tape looper), HYPERCUBE
  // (4D-tesseract wavetable oscillator), SYNESTHESIA (dual 4-band audio→CV/video
  // analyser, 48 outputs), WARRENSPECTRUM (8-band ping resonator bank), MIXMSTRS
  // (6-ch stereo mixer, 61 params), and BLUEBOX (DTMF/phreaker dialer). Only the
  // CONVENTION-card pure-Knob/Fader+PatchPanel members go INTERACTIVE: cloudseed
  // + symbiote (verified live by docs-virtual-module.spec.ts). The rest stay
  // STATIC: foxy/twotracks/synesthesia/warrenspectrum run a 2D-canvas render in
  // the card, hypercube renders WebGL (rendersWebGL — its docs are wrapped in
  // docs-hash-ignore markers like sibling cube so authoring stays attest-neutral)
  // and its card adds a file-upload picker, polyhelm mounts a Web-MIDI gear panel,
  // and bluebox has no `control-<paramId>` Knob/Fader to probe (its keys are
  // press-and-hold buttons) — so the static face is the right fallback for each.
  // POLYHELM is POLY: its `poly` input must be fed by a real poly source (MIDI
  // LANE / POLYSEQZ / a chord sequencer), noted in its prose.
  'cloudseed',
  'foxy',
  'polyhelm',
  'symbiote',
  'twotracks',
  'hypercube',
  'synesthesia',
  'warrenspectrum',
  'mixmstrs',
  'bluebox',
  // Batch 14 — FINAL audio batch: the last undocumented AUDIO modules, which
  // completes the audio catalog (2026-06-26). The arcade GAME modules FROGGER /
  // MODTRIS / PONG / SKIFREE (gameplay-as-CV: gate inputs steer the game, gate
  // outputs pulse on its events), the 16-instrument × 16-step drum machine
  // HYDROGEN, the 4-voice drum/synth + FX-rack RIOTGIRLS, the single-sample loop
  // player SAMSLOOP, the scrolling-sonogram video generator SPECTROGRAPH, and the
  // hybrid 4-oscillator 3D video synth WAVESCULPT. Only the CONVENTION-card
  // pure-Knob/Fader+PatchPanel members go INTERACTIVE: riotgirls (pure
  // Knob+PatchPanel) and hydrogen (transport buttons + a step grid + PatchPanel,
  // its currentStep poll no-ops in the engine-less doc sandbox). The rest stay
  // STATIC: the four games + spectrograph run a 2D-canvas rAF render loop,
  // samsloop adds a waveform canvas + file-upload + mic record, and wavesculpt
  // renders WebGL2 (rendersWebGL — its docs + controlFamilies are wrapped in
  // docs-hash-ignore markers like cube/hypercube so authoring stays
  // attest-neutral) plus a per-osc .wav file picker. HYDROGEN declares the 16×16
  // step-pattern grid family (hydrogen-cell); WAVESCULPT declares the per-osc
  // wavetable-source strip family (wavesculpt-osc). (negativity stays
  // undocumented on purpose — it is the e2e "undocumented module" fixture.)
  'frogger',
  'hydrogen',
  'modtris',
  'pong',
  'riotgirls',
  'samsloop',
  'skifree',
  'spectrograph',
  'wavesculpt',
  // Video batch 1 (2026-06-26): classic single-effect video processors.
  'cellshade',
  'chromakey',
  'edges',
  'colorizer',
  'luma',
  'lumakey',
  // Video batch 2 (2026-06-26): single-effect processors + delay.
  'chroma',
  'monoglitch',
  'vdelay',
  'reshaper',
  'tiler',
  'freezeframe',
  // Video batch 3 (2026-06-26): feedback/keyer/mixer/zoom + shape generators.
  'feedback',
  'mapper',
  'videoMixer',
  'inwards',
  'shapes',
  'shapegen',
  // Video batch 4 (2026-06-26): camera source + feedback/datamosh + line/shape gens + OUTPUT sink.
  'cameraInput',
  'backdraft',
  'destructor',
  'outlines',
  'lines',
  'videoOut',
  // Video batch 5 (2026-06-26): routers/mixers + paint source + audio-reactive viz + text + rutt-etra.
  '4plexvid',
  'quadralogical',
  'painter',
  'peakstate',
  'textmarquee',
  'ruttetra',
  // Video batch 6 (2026-06-26): plasma/ramp/spirograph generators + fractals + scoreboard.
  'acidwarp',
  'shapedramps',
  'spirographs',
  'mandelbulb',
  'mandleblot',
  'scoreboard',
  // Video batch 7 (2026-06-26): NTSC/composite destroyers + media players (tv/video/varispeed/picture).
  'b3ntb0x',
  'bentbox',
  'tvLibrarian',
  'videobox',
  'videovarispeed',
  'picturebox',
  // Video batch 8 (2026-06-26): media sources (archive.org / peertube) + recorder + games (gibribbon/nibbles/qbert).
  'archivist',
  'peertube',
  'recorderbox',
  'gibribbon',
  'nibbles',
  'qbert',
]);
