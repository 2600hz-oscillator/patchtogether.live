// e2e/audio-drift/cross-machine/scenarios.ts
//
// Patch specs reused by the cross-machine drift workflow. These are the same
// patches as in ../audio-drift.spec.ts, extracted here so the runner script
// (run-runner.ts) and the same-machine spec stay in lockstep without one
// depending on the other's test() registrations.
//
// Naming + acceptKind conventions match audio-drift.spec.ts so reports line
// up. If a scenario is added/removed there, add/remove it here too.

import type { PatchSpec } from '../_collab';

export type AcceptKind = 'static' | 'clocked' | 'stochastic';

export interface ScenarioDef {
  name: string;
  description: string;
  patch: PatchSpec;
  acceptKind: AcceptKind;
  warmupMs?: number;
  notes?: string;
}

const COMMON_AUDIO_OUT = (id = 'out'): PatchSpec['nodes'][number] => ({
  id,
  type: 'audioOut',
  params: { master: 0.7 },
});

const seq04Steps = (() => {
  const steps: Array<{ on: boolean; midi: number }> = [
    { on: true, midi: 60 },
    { on: true, midi: 67 },
    { on: true, midi: 72 },
    { on: true, midi: 64 },
  ];
  while (steps.length < 32) steps.push({ on: false, midi: 60 });
  return steps;
})();

const seq05Steps = Array.from({ length: 32 }, (_, i) => ({ on: i % 4 === 0, midi: 60 }));

export const SCENARIOS: ScenarioDef[] = [
  {
    name: '01-static-vco',
    description:
      'AnalogVCO (sine, 220Hz / 0 semi tune) → audioOut. Static patch baseline.',
    acceptKind: 'static',
    patch: {
      nodes: [
        { id: 'vco', type: 'analogVco', params: { tune: 0, fine: 0, fmAmount: 0, pw: 0.5 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
        { id: 'e2', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'R' }, sourceType: 'audio', targetType: 'audio' },
      ],
    },
  },
  {
    name: '02-filtered-vco',
    description:
      'AnalogVCO (saw) → Filter (LP, cutoff 800 Hz, res 0.3) → audioOut.',
    acceptKind: 'static',
    patch: {
      nodes: [
        { id: 'vco', type: 'analogVco', params: { tune: 0, pw: 0.5 } },
        { id: 'flt', type: 'filter', params: { cutoff: 800, resonance: 0.3, mode: 0 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'flt', portId: 'audio' } },
        { id: 'e2', from: { nodeId: 'flt', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e3', from: { nodeId: 'flt', portId: 'audio' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
  },
  {
    name: '03-lfo-modulated',
    description:
      'LFO (rate 2 Hz) → AnalogVCO.fm input → audioOut. Tests LFO clock alignment across machines.',
    acceptKind: 'clocked',
    notes:
      'LFO is a custom AudioWorklet — its phase counter starts when process() first fires. Two contexts on different machines have independent ctx.currentTime origins; absolute phase will differ. We measure whether the rate stays the same.',
    patch: {
      nodes: [
        { id: 'lfo', type: 'lfo', params: { rate: 2, shape: 0 } },
        { id: 'vco', type: 'analogVco', params: { tune: 0, fmAmount: 0.5 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'vco', portId: 'fm' }, sourceType: 'cv', targetType: 'audio' },
        { id: 'e2', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e3', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
  },
  {
    name: '04-sequenced',
    description:
      'Sequencer (120 BPM, 4-step pattern) → VCO → ADSR → VCA → audioOut. The prime drift suspect.',
    acceptKind: 'clocked',
    warmupMs: 1000,
    notes:
      'Sequencer uses setTimeout-based JS scheduling. Each runner has its own scheduler — drift is expected and is the central question this cross-machine test answers.',
    patch: {
      nodes: [
        { id: 'seq', type: 'sequencer', params: { bpm: 120, length: 4, isPlaying: 1, gateLength: 0.5, swing: 0 }, data: { steps: seq04Steps } },
        { id: 'vco', type: 'analogVco', params: { tune: 0 } },
        { id: 'adsr', type: 'adsr', params: { attack: 0.01, decay: 0.1, sustain: 0.4, release: 0.2 } },
        { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
        { id: 'e2', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'adsr', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
        { id: 'e3', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' } },
        { id: 'e4', from: { nodeId: 'adsr', portId: 'env' }, to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
        { id: 'e5', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e6', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
  },
  {
    name: '05-drummergirl',
    description:
      'Sequencer (120 BPM, every 4th step) → DRUMMERGIRL → audioOut. Faust drum + clocked gate.',
    acceptKind: 'clocked',
    warmupMs: 1000,
    patch: {
      nodes: [
        { id: 'seq', type: 'sequencer', params: { bpm: 120, length: 16, isPlaying: 1, gateLength: 0.2 }, data: { steps: seq05Steps } },
        { id: 'dg', type: 'drummergirl', params: { pitch: 0, tone: 0.3, shape: 0.3, volume: 1, decay: 0.15 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'dg', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
        { id: 'e2', from: { nodeId: 'dg', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e3', from: { nodeId: 'dg', portId: 'audio' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
  },
  {
    name: '07-stochastic-echos',
    description:
      "AnalogVCO → CHARLOTTE'S ECHOS → audioOut. Stochastic effects across machines.",
    acceptKind: 'stochastic',
    patch: {
      nodes: [
        { id: 'vco', type: 'analogVco', params: { tune: 0 } },
        { id: 'echos', type: 'charlottesEchos', params: { delay: 0.3, feedback: 0.6, decay: 0.3, pitchUp: 0.05, mix: 0.7 } },
        COMMON_AUDIO_OUT(),
      ],
      edges: [
        { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'echos', portId: 'L' } },
        { id: 'e2', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'echos', portId: 'R' } },
        { id: 'e3', from: { nodeId: 'echos', portId: 'L' }, to: { nodeId: 'out', portId: 'L' } },
        { id: 'e4', from: { nodeId: 'echos', portId: 'R' }, to: { nodeId: 'out', portId: 'R' } },
      ],
    },
  },
];

export function getScenario(name: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.name === name);
}

export function defaultScenarioNames(): string[] {
  return SCENARIOS.map((s) => s.name);
}
