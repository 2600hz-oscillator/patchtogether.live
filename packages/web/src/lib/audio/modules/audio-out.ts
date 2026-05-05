// packages/web/src/lib/audio/modules/audio-out.ts
//
// Audio Out — terminal stereo output. Two MONO inputs (L, R), each routed to
// the corresponding channel of a stereo bus. Eurorack convention: every patch
// cable is mono; if you want stereo, you patch both L and R.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export const audioOutDef: AudioModuleDef = {
  type: 'audioOut',
  domain: 'audio',
  label: 'Audio Out',
  category: 'output',
  schemaVersion: 2, // bumped: previously had a single 'audio' input

  inputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  outputs: [],

  params: [
    {
      id: 'master',
      label: 'Master',
      defaultValue: 0.7,
      min: 0,
      max: 1,
      curve: 'linear',
      units: 'gain',
    },
  ],

  /**
   * Migrate a v1 Audio Out node (single 'audio' input) to v2 (L+R). Edges that
   * targeted the old 'audio' port get rewritten to 'L' (mono → left). Callers
   * are expected to handle the edge migration; the data shape itself is
   * unchanged so this is a no-op at the node level.
   */
  migrate(data, _fromVersion) {
    return data;
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const gainL = ctx.createGain();
    const gainR = ctx.createGain();
    const initialMaster = (node.params ?? {}).master ?? 0.7;
    gainL.gain.value = initialMaster;
    gainR.gain.value = initialMaster;

    // Merge mono L + mono R into stereo, then to destination.
    const merger = ctx.createChannelMerger(2);
    gainL.connect(merger, 0, 0);
    gainR.connect(merger, 0, 1);
    merger.connect(ctx.destination);

    // Keep both gain nodes in the active graph even if nothing is patched
    // to either input. (Same trick as the Faust modules' channel mergers —
    // a silent ConstantSource per side ensures the node processes.)
    const silenceL = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceL.start();
    silenceL.connect(gainL);
    const silenceR = ctx.createConstantSource();
    silenceR.offset.value = 0;
    silenceR.start();
    silenceR.connect(gainR);

    return {
      domain: 'audio',
      inputs: new Map([
        ['L', { node: gainL, input: 0 }],
        ['R', { node: gainR, input: 0 }],
      ]),
      outputs: new Map(),
      setParam(paramId, value) {
        if (paramId === 'master') {
          gainL.gain.setValueAtTime(value, ctx.currentTime);
          gainR.gain.setValueAtTime(value, ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'master') return gainL.gain.value;
        return undefined;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        gainL.disconnect();
        gainR.disconnect();
        merger.disconnect();
      },
    };
  },
};
