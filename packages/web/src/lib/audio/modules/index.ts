// packages/web/src/lib/audio/modules/index.ts
//
// Auto-registers all Phase 1 audio modules on first import.

import { registerModule } from '$lib/audio/module-registry';
import { analogVcoDef } from './analog-vco';
import { audioOutDef } from './audio-out';
import { vcaDef } from './vca';
import { mixerDef } from './mixer';
import { adsrDef } from './adsr';
import { filterDef } from './filter';
import { reverbDef } from './reverb';
import { delayDef } from './delay';
import { scopeDef } from './scope';
// RASTERIZE — audio → video raster mapper (crossing-the-streams slice 1).
import { rasterizeDef } from './rasterize';
import { sequencerDef } from './sequencer';
import { wavetableVcoDef } from './wavetable-vco';
import { lfoDef } from './lfo';
import { cartesianDef } from './cartesian';
import { destroyDef } from './destroy';
import { qbrtDef } from './qbrt';
import { drummergirlDef } from './drummergirl';
import { meowboxDef } from './meowbox';
import { mixmstrsDef } from './mixmstrs';
import { timelordeDef } from './timelorde';
import { charlottesEchosDef } from './charlottes-echos';
import { riotgirlsDef, triggerVoice as riotgirlsTriggerVoice } from './riotgirls';
import { scoreDef } from './score';
import { drumseqzDef } from './drumseqz';
import { polyseqzDef } from './polyseqz';
import { gridsDef } from './grids';
import { wavvizDef } from './wavviz';
import { swolevcoDef } from './swolevco';
import { illogicDef } from './illogic';
import { unityscalemathematikDef } from './unityscalemathematik';
import { analogLogicMathsDef } from './analog-logic-maths';
import { dx7Def } from './dx7';
import { noiseDef } from './noise';
import { bugglesDef } from './buggles';
import { wavecelDef } from './wavecel';
import { warrenspectrumDef } from './warrenspectrum';
import { stereovcaDef } from './stereovca';
import { shimmershineDef } from './shimmershine';
import { macrooscillatorDef } from './macrooscillator';
import { samsloopDef } from './samsloop';
import { cloudsDef } from './clouds';
import { macseqDef } from './macseq';
import { ringsDef } from './rings';
import { elementsDef } from './elements';
import { peaksDef } from './peaks';
import { marblesDef } from './marbles';
import { symbioteDef } from './symbiote';
import { warpsDef } from './warps';
import { veilsDef } from './veils';
import { attenumixDef } from './attenumix';
import { bladesDef } from './blades';
import { stagesDef } from './stages';
import { tides2Def } from './tides2';
import { cloudseedDef } from './cloudseed';
import { livecodeDef } from './livecode';
import { clockedRunnerDef } from './clocked-runner';
import { midiCvBuddyDef } from './midi-cv-buddy';
import { midiclockDef } from './midiclock';
import { helmDef } from './helm';
import { hydrogenDef } from './hydrogen';
import { pongDef } from './pong';
import { modtrisDef } from './modtris';
import { froggerDef } from './frogger';
// SM64 — black-box wrapper around the upstream sm64js pure-JS port
// (WTFPL). Bundle committed at static/sm64js/sm64js.bundle.js.
import { sm64Def } from './sm64';
import { joystickDef } from './joystick';
import { gamepadDef } from './gamepad';
import { numpadPlusDef } from './numpad-plus';
import { wavesculptDef } from './wavesculpt';
// ATLANTIS-PATCH support trio (slew limiter / switch, slow-drift macro brain,
// 4-channel feedback matrix). General-purpose modules — the Atlantis demo
// patch uses them together but each is useful on its own.
import { slewSwitchDef } from './slewswitch';
import { atlantisCatalystDef } from './atlantis-catalyst';
import { aquaTankDef } from './aquatank';
// CALLSINE — spectral-analysis additive resynth (Warren's Spectrum port).
import { callsineDef } from './callsine';
import { cocoaDelayDef } from './cocoadelay';
// RESOFILTER — multi-mode filter port from gabrielsoule/resonarium's
// MultiFilter (5 modes: LP / HP / BP / Notch / Allpass), with a card that
// displays the live mode name next to the MODE knob.
import { resofilterDef } from './resofilter';
// TREE.oh.VOX — TB-303 voice slice ported from Robin Schmidt's Open303
// (MIT). The 6 canonical 303 knobs + CV; the full 404 module
// (sequencer + TD-3 UI) is a follow-up task.
import { treeohvoxDef } from './treeohvox';
// FOXY — hybrid SWOLEVCO→RASTERIZE→RUTTETRA(XYZ)→realtime-wavetable→WAVECEL.
import { foxyDef } from './foxy';
// 4PLEXER — 4-in / 4-out discrete signal router with per-output
// gate-advanced selectors.
import { fourplexerDef } from './fourplexer';
// SIDECAR — stereo sidechain compressor (GMR 2012 topology). Stereo audio
// in, dedicated SC pair (HPF-filterable on the detector only),
// CV-modulatable threshold + envMag, env_out + env_inv_out for ducking.
import { sidecarDef } from './sidecar';
import { testHooksEnabled } from '$lib/dev/test-hooks';
import { exposeModuleSpecsForTests } from '$lib/dev/module-specs';

let registered = false;

export function registerAudioModules(): void {
  if (registered) return;
  registered = true;
  registerModule(analogVcoDef);
  registerModule(audioOutDef);
  registerModule(vcaDef);
  registerModule(mixerDef);
  registerModule(adsrDef);
  registerModule(filterDef);
  registerModule(reverbDef);
  registerModule(delayDef);
  registerModule(scopeDef);
  // RASTERIZE — explicit audio→video raster mapper. Faithful per-frame
  // raster (NOT a scope trace); a steady tone paints drifting horizontal
  // bands. See .myrobots/plans/audio-video-crossing.md.
  registerModule(rasterizeDef);
  registerModule(sequencerDef);
  registerModule(wavetableVcoDef);
  registerModule(lfoDef);
  registerModule(cartesianDef);
  registerModule(destroyDef);
  registerModule(qbrtDef);
  registerModule(drummergirlDef);
  registerModule(meowboxDef);
  registerModule(mixmstrsDef);
  registerModule(timelordeDef);
  registerModule(charlottesEchosDef);
  registerModule(riotgirlsDef);
  registerModule(scoreDef);
  registerModule(drumseqzDef);
  registerModule(polyseqzDef);
  registerModule(wavvizDef);
  registerModule(swolevcoDef);
  registerModule(illogicDef);
  registerModule(unityscalemathematikDef);
  registerModule(analogLogicMathsDef);
  registerModule(dx7Def);
  registerModule(noiseDef);
  registerModule(bugglesDef);
  registerModule(wavecelDef);
  registerModule(warrenspectrumDef);
  registerModule(stereovcaDef);
  registerModule(shimmershineDef);
  registerModule(macrooscillatorDef);
  registerModule(samsloopDef);
  registerModule(cloudsDef);
  registerModule(macseqDef);
  registerModule(ringsDef);
  registerModule(elementsDef);
  registerModule(peaksDef);
  registerModule(marblesDef);
  registerModule(symbioteDef);
  registerModule(warpsDef);
  registerModule(veilsDef);
  registerModule(attenumixDef);
  registerModule(bladesDef);
  registerModule(stagesDef);
  registerModule(tides2Def);
  registerModule(cloudseedDef);
  registerModule(livecodeDef);
  registerModule(clockedRunnerDef);
  registerModule(midiCvBuddyDef);
  registerModule(midiclockDef);
  registerModule(helmDef);
  registerModule(hydrogenDef);
  registerModule(pongDef);
  registerModule(modtrisDef);
  registerModule(froggerDef);
  // SM64 — single-instance Super Mario 64 game module. CV-stick + 9
  // gate inputs map 1:1 to the N64 controller (minus L / D-pad / C-stick).
  registerModule(sm64Def);
  // JOYSTICK — manual XY pad emitting x/y + inverted nx/ny CV outputs.
  registerModule(joystickDef);
  // GAMEPAD — USB/Bluetooth game controller (Xbox / PS / generic HID)
  // as CV (sticks + triggers) + gate (buttons + dpad).
  registerModule(gamepadDef);
  // NUMPAD+ — numpad-driven 4-layer step sequencer with live play +
  // REC ARM + OVERDUB. Captures Numpad* keys globally.
  registerModule(numpadPlusDef);
  // WAVESCULPT — 4-oscillator hybrid synth: stereo audio output + 3D
  // ribbon video render with embedded BENTBOX-style CRT post-process.
  registerModule(wavesculptDef);
  // SLEWSWITCH — quad slew limiter + 4→1 sequential CV switch.
  registerModule(slewSwitchDef);
  // ATLANTISCATALYST — 8-output slow-drift macro brain + scene transport.
  registerModule(atlantisCatalystDef);
  // AQUATANK — 4-channel Hadamard FDN feedback matrix (metallic resonance).
  registerModule(aquaTankDef);
  // CALLSINE — spectral-analysis additive resynth. audio in → STFT →
  // tracked partials → additive bank. MIT (Warren's Spectrum port).
  registerModule(callsineDef);
  // COCOA DELAY — Tilde Murray's Cocoa Delay (GPL-3.0). Tape-style stereo
  // delay with LFO/DRIFT time modulation, ducking, in-loop filter + drive,
  // and clock-locked tempo sync. CHARLOTTE'S ECHOS is built from 4 of these.
  registerModule(cocoaDelayDef);
  // RESOFILTER — multi-mode filter (port of gabrielsoule/resonarium's
  // MultiFilter; LP / HP / BP / Notch / Allpass with named-mode card label).
  registerModule(resofilterDef);
  // TREE.oh.VOX — TB-303 voice slice (Open303 port). 6 knobs: TUNE,
  // CUTOFF, RESONANCE, ENVELOPE, DECAY, ACCENT + pitch/gate/accent_in
  // + per-knob CV. Full 404 module (sequencer + TD-3 UI) is queued.
  registerModule(treeohvoxDef);
  // GRIDS — Mutable Instruments topographic drum pattern generator.
  // BD/SD/HH triggers + accent from a 5x5 interpolated drum map; euclidean mode.
  registerModule(gridsDef);
  // FOXY — hybrid audio-visual module: a mini SWOLEVCO patched into an
  // internal RASTERIZE, downsampled to 256×256 + run through a simplified
  // CPU RUTTETRA ("XYZ" window), whose field is converted in realtime into
  // an animated wavetable fed to an internal WAVECEL VCO. Exposes WAVECEL's
  // full param/IO surface plus the source + XYZ controls.
  registerModule(foxyDef);
  // 4PLEXER — 4-in / 4-out discrete signal router; per-output selector +
  // per-output gate that advances the selector on each rising edge.
  registerModule(fourplexerDef);
  // SIDECAR — stereo sidechain compressor (Giannoulis-Massberg-Reiss 2012).
  // env_out + env_inv_out expose the reduction envelope for cross-patch
  // ducking; env_out has NO hard clamp (envMag>1 → overshoot allowed).
  registerModule(sidecarDef);

  if (testHooksEnabled() && typeof window !== 'undefined') {
    // Per-instance trigger so Playwright can drive a specific RIOTGIRLS by
    // node id without spawning a Sequencer. Returns true if the voice was
    // triggered, false if no instance / voice found.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__riotgirlsTriggerVoice = (nodeId: string, voiceIdx: number) =>
      riotgirlsTriggerVoice(nodeId, voiceIdx);
  }
  exposeModuleSpecsForTests();
}

registerAudioModules();
