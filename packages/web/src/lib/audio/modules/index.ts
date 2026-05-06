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
}

registerAudioModules();
