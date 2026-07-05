// packages/web/src/lib/audio/modules/flipper.ts
//
// FLIPPER — a gate flip-flop. Two gate inputs; a gate on EITHER input
// alternately fires the FLIP output, then the FLOP output, then back. The
// toggle logic lives in the worklet (packages/dsp/src/flipper.ts →
// dist/flipper.js). No params.
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/flipper.js?url';

const PROCESSOR_NAME = 'flipper';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const flipperDef: AudioModuleDef = {
  type: 'flipper',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'flipper',
  category: 'utilities',
  card: 'FlipperCard',

  inputs: [
    { id: 'in1', type: 'gate' },
    { id: 'in2', type: 'gate' },
  ],
  outputs: [
    { id: 'flip', type: 'gate' },
    { id: 'flop', type: 'gate' },
  ],
  params: [],

  docs: {
    explanation:
      "A gate flip-flop (a toggle / clock-divider building block). It has two gate inputs and two gate outputs, FLIP and FLOP. A rising edge on EITHER input toggles which output is active: the first edge raises FLIP, the next raises FLOP, the next FLIP again, alternating forever — only one of the two is high at a time. Drive a single clock into one input and FLIP/FLOP each pulse at half the clock rate (a divide-by-two), 180° out of phase with each other — useful for alternating two voices, ping-ponging triggers, or generating a half-tempo gate. Feeding both inputs lets two different sources jointly advance the toggle. There are no controls; the alternation logic lives entirely in the worklet.",
    inputs: {
      in1: "A toggle input: each rising edge flips the active output from FLIP to FLOP or back. Shares the toggle with IN 2 (either input advances the same flip-flop).",
      in2: "A second toggle input: each rising edge advances the same FLIP/FLOP alternation as IN 1, so two sources can drive the toggle together.",
    },
    outputs: {
      flip: "One half of the toggle: goes high on the 1st, 3rd, 5th… incoming edge and low otherwise. Driven from a single clock it is a half-rate gate, opposite to FLOP.",
      flop: "The other half: goes high on the 2nd, 4th, 6th… incoming edge — the inverse phase of FLIP, so exactly one of the two is high at any time.",
    },
    controls: {},
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    void node;
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 2 gate inputs (in1, in2) → 2 gate outputs (flip, flop), 1 channel each.
    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Keep the processor scheduled even when nothing is patched into in1
    // (a silent ConstantSource on input 0 ensures process() keeps running).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in1', { node: workletNode, input: 0 }],
        ['in2', { node: workletNode, input: 1 }],
      ]),
      outputs: new Map([
        ['flip', { node: workletNode, output: 0 }],
        ['flop', { node: workletNode, output: 1 }],
      ]),
      setParam() {
        /* no params */
      },
      readParam() {
        return undefined;
      },
      dispose() {
        try {
          silence.stop();
        } catch {
          /* */
        }
        try {
          silence.disconnect();
        } catch {
          /* */
        }
        try {
          workletNode.disconnect();
        } catch {
          /* */
        }
      },
    };
  },
};
