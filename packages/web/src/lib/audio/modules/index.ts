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
