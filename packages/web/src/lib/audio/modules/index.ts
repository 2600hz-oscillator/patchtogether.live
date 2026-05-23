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
import { peaksDef } from './peaks';
import { warpsDef } from './warps';
import { veilsDef } from './veils';
import { attenumixDef } from './attenumix';
import { bladesDef } from './blades';
import { stagesDef } from './stages';
import { cloudseedDef } from './cloudseed';
import { livecodeDef } from './livecode';
import { clockedRunnerDef } from './clocked-runner';
import { midiCvBuddyDef } from './midi-cv-buddy';
import { midiclockDef } from './midiclock';
import { helmDef } from './helm';
import { hydrogenDef } from './hydrogen';
import { pongDef } from './pong';
import { modtrisDef } from './modtris';
import { joystickDef } from './joystick';
import { gamepadDef } from './gamepad';
import { numpadPlusDef } from './numpad-plus';
import { wavesculptDef } from './wavesculpt';
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
  registerModule(peaksDef);
  registerModule(warpsDef);
  registerModule(veilsDef);
  registerModule(attenumixDef);
  registerModule(bladesDef);
  registerModule(stagesDef);
  registerModule(cloudseedDef);
  registerModule(livecodeDef);
  registerModule(clockedRunnerDef);
  registerModule(midiCvBuddyDef);
  registerModule(midiclockDef);
  registerModule(helmDef);
  registerModule(hydrogenDef);
  registerModule(pongDef);
  registerModule(modtrisDef);
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
