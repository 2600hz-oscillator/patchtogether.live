// packages/web/src/lib/audio/modules/moog994.ts
//
// MOOG 994 DUAL MULTIPLES — Moog System 55 clone (.myrobots/MOOG/). The 994
// is the console's passive MULTIPLE panel: two INDEPENDENT 1→3 fan-out
// busses. Patch a signal into a group's input jack and it appears, unaltered,
// on that group's three output jacks. Two such busses (A + B) per panel.
//
// Categorized under Ports → moogafakkin (the shared SYS55/SYS35 bucket, like the
// CP3 / 921A / 902).
//
// PASSIVE / PURE WEB AUDIO: no DSP worklet, no Faust. A multiple is literally
// a solder junction — every output jack is the SAME node as the input. We
// model each group as a single unity GainNode (gain = 1); the input port
// feeds it, and all three of the group's output ports expose that same gain
// node's single output (Web Audio fans one output to many connections for
// free). No level control, no summing — copy in → copy out.
//
// Inputs:
//   a_in / b_in (audio): the two group inputs. Typed `audio` = the permissive
//     default cable; a multiple is signal-agnostic and happily fans out audio
//     OR cv (a cv cable connects to an `audio` jack fine — it's the same
//     Web Audio signal), so we don't constrain it to one domain.
//
// Outputs:
//   a1 / a2 / a3 (audio): the A group's three fanned-out copies of a_in.
//   b1 / b2 / b3 (audio): the B group's three fanned-out copies of b_in.
//
// Params: none. A passive multiple has no controls.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export const moog994Def: AudioModuleDef = {
  type: 'moog994',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog994Card',
  domain: 'audio',
  label: '994 mult',
  category: 'utilities',

  inputs: [
    { id: 'a_in', type: 'audio' },
    { id: 'b_in', type: 'audio' },
  ],
  outputs: [
    { id: 'a1', type: 'audio' },
    { id: 'a2', type: 'audio' },
    { id: 'a3', type: 'audio' },
    { id: 'b1', type: 'audio' },
    { id: 'b2', type: 'audio' },
    { id: 'b3', type: 'audio' },
  ],
  // Passive multiple — no controls.
  params: [],

  docs: {
    explanation:
      "A clean-room recreation of the Moog 994 Dual Multiples — the console's passive splitter panel. It is two completely independent 1-to-3 fan-outs (group A and group B): patch a signal into a group's input and an exact, unaltered copy appears on each of that group's three output jacks. No level control, no mixing, no summing — it is literally a solder junction (a 'mult'), so it is perfect for sending one oscillator/CV to three destinations or distributing a clock. Each group is signal-agnostic (audio OR CV route identically), and the two groups never interact. Mental model: two passive 3-way splitters in one module.",
    inputs: {
      a_in: "Group A input — whatever you patch here (audio or CV) is copied unaltered to a1, a2, and a3.",
      b_in: "Group B input — copied unaltered to b1, b2, and b3, completely independent of group A.",
    },
    outputs: {
      a1: "Group A copy 1 — an exact duplicate of a_in.",
      a2: "Group A copy 2 — an exact duplicate of a_in.",
      a3: "Group A copy 3 — an exact duplicate of a_in.",
      b1: "Group B copy 1 — an exact duplicate of b_in.",
      b2: "Group B copy 2 — an exact duplicate of b_in.",
      b3: "Group B copy 3 — an exact duplicate of b_in.",
    },
    controls: {},
  },

  async factory(ctx): Promise<AudioDomainNodeHandle> {
    // One unity GainNode per group. The input jack feeds it; its single
    // output is exposed by all three of the group's output jacks (Web Audio
    // fans one output to many edges natively — that IS the multiple).
    const aGain = ctx.createGain();
    aGain.gain.value = 1;
    const bGain = ctx.createGain();
    bGain.gain.value = 1;

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['a_in', { node: aGain, input: 0 }],
        ['b_in', { node: bGain, input: 0 }],
      ]),
      outputs: new Map([
        ['a1', { node: aGain, output: 0 }],
        ['a2', { node: aGain, output: 0 }],
        ['a3', { node: aGain, output: 0 }],
        ['b1', { node: bGain, output: 0 }],
        ['b2', { node: bGain, output: 0 }],
        ['b3', { node: bGain, output: 0 }],
      ]),
      // No params — no-op setParam / undefined readParam to satisfy the handle.
      setParam() {
        /* passive multiple — nothing to set */
      },
      readParam() {
        return undefined;
      },
      dispose() {
        try { aGain.disconnect(); } catch { /* */ }
        try { bGain.disconnect(); } catch { /* */ }
      },
    };
  },
};
