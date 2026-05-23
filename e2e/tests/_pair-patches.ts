// e2e/tests/_pair-patches.ts
//
// Pair-patch generators for the integration test slice. Each generator
// returns a `{ nodes, edges }` patch spec that wires a source module
// into a canonical sink module — the integration.spec.ts loops over
// the generator's output and asserts the sink sees signal.
//
// The catalogue here is intentionally narrow: pair-patches catch a
// different bug class than per-module output-alive (which is covered
// by per-module.spec.ts). The unique value here is cross-module +
// cross-domain composition — the engine's reconciler actually runs,
// CV-scaling layers fire, mono-video → audio bridges resolve, etc.
//
// Add a new generator when you find a routing bug that survives the
// per-module check but breaks in composition. The bar for a new
// generator: it must catch a class of failure that no existing
// generator covers AND have a clear "what does success look like"
// assertion that doesn't depend on knob tuning per module.

import { REGISTRY, type RegistryModule } from './_registry';
import type { SpawnNode, SpawnEdge } from './_helpers';

export interface PairPatch {
  /** Human-readable description used as the Playwright test title. */
  label: string;
  /** Patch nodes to spawn. The sink's id is conventionally 'snk'. */
  nodes: SpawnNode[];
  /** Edges to wire. */
  edges: SpawnEdge[];
  /** Node id to read after settling — usually 'snk' or a SCOPE
   *  inserted in the patch to measure audio. */
  readNodeId: string;
}

/** mono-video → audio bridge. For every registered module that
 *  declares a mono-video output, wire that output to SCOPE.ch1 and
 *  assert SCOPE sees signal. Catches engine bugs where the
 *  mono-video-as-audio decoder fails to publish samples.
 *
 *  SCOPE's own `video_out` is excluded — it'd be circular (scope
 *  reading scope), and the canonical case is "audio-domain module
 *  publishes scope-readable mono-video AND audio at the same
 *  output bank". */
export function monoVideoToScope(): PairPatch[] {
  const out: PairPatch[] = [];
  for (const mod of REGISTRY) {
    const port = mod.outputs.find((p) => p.type === 'mono-video');
    if (!port) continue;
    if (mod.type === 'scope') continue; // circular
    out.push({
      label: `mono-video bridge: ${mod.type}.${port.id} → SCOPE.ch1`,
      nodes: [
        { id: 'src', type: mod.type, position: { x: 60, y: 60 }, domain: mod.domain },
        { id: 'snk', type: 'scope', position: { x: 800, y: 60 }, params: { timeMs: 50 } },
      ],
      edges: [
        {
          id: 'e_src_snk',
          from: { nodeId: 'src', portId: port.id },
          to: { nodeId: 'snk', portId: 'ch1' },
          sourceType: 'mono-video',
          targetType: 'audio',
        },
      ],
      readNodeId: 'snk',
    });
  }
  return out;
}

/** CV-family interchange smoke: an LFO drives an ADSR's CV inputs
 *  (attack, decay, sustain, release) one at a time and a SEQUENCER
 *  drives the ADSR's gate. Then ADSR's env modulates a VCA on an
 *  ANALOG-VCO and we listen at AUDIO-OUT via SCOPE. Pre-fix
 *  (cv-family) the cascade hid these edges; this asserts the engine
 *  actually accepts them end-to-end.
 *
 *  Returns one test per ADSR CV input. */
export function cvIntoAdsr(): PairPatch[] {
  const adsrParams = ['attack', 'decay', 'sustain', 'release'] as const;
  return adsrParams.map((adsrParam) => ({
    label: `cv-family: LFO.phase0 (cv) → ADSR.${adsrParam} (cv) drives audible env`,
    nodes: [
      { id: 'lfo', type: 'lfo',      position: { x: 60, y: 60 } },
      { id: 'seq', type: 'sequencer',position: { x: 60, y: 200 }, params: { bpm: 240, length: 4, isPlaying: 1 } },
      { id: 'adsr',type: 'adsr',     position: { x: 360, y: 120 } },
      { id: 'vco', type: 'analogVco',position: { x: 660, y: 60 }, params: { tune: 0, fine: 0 } },
      { id: 'vca', type: 'vca',      position: { x: 900, y: 60 } },
      { id: 'snk', type: 'scope',    position: { x: 1140, y: 60 }, params: { timeMs: 50 } },
    ],
    edges: [
      { id: 'e_lfo_adsr', from: { nodeId: 'lfo', portId: 'phase0' },  to: { nodeId: 'adsr', portId: adsrParam },
        sourceType: 'cv', targetType: 'cv' },
      { id: 'e_seq_gate', from: { nodeId: 'seq', portId: 'gate' },    to: { nodeId: 'adsr', portId: 'gate' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e_vco_vca',  from: { nodeId: 'vco', portId: 'sine' },    to: { nodeId: 'vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e_env_vca',  from: { nodeId: 'adsr',portId: 'env' },     to: { nodeId: 'vca', portId: 'cv' },
        sourceType: 'cv', targetType: 'cv' },
      { id: 'e_vca_snk',  from: { nodeId: 'vca', portId: 'audio' },   to: { nodeId: 'snk', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
    readNodeId: 'snk',
  }));
}

/** SEQUENCER.gate → ADSR.attack — the canonical cv-family
 *  interchange path the user flagged. gate routed onto a cv-typed
 *  param works at the engine level; this asserts the audible result. */
export function gateIntoCvParam(): PairPatch[] {
  return [
    {
      label: 'cv-family: SEQUENCER.gate (gate) → ADSR.attack (cv) — audible env',
      nodes: [
        { id: 'seq', type: 'sequencer', position: { x: 60, y: 60 }, params: { bpm: 240, length: 4, isPlaying: 1 } },
        { id: 'adsr',type: 'adsr',      position: { x: 360, y: 60 } },
        { id: 'vco', type: 'analogVco', position: { x: 660, y: 60 }, params: { tune: 0, fine: 0 } },
        { id: 'vca', type: 'vca',       position: { x: 900, y: 60 } },
        { id: 'snk', type: 'scope',     position: { x: 1140, y: 60 }, params: { timeMs: 50 } },
      ],
      edges: [
        { id: 'e_seq_attack', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'adsr', portId: 'attack' },
          sourceType: 'gate', targetType: 'cv' },
        { id: 'e_seq_gate',   from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'adsr', portId: 'gate' },
          sourceType: 'gate', targetType: 'gate' },
        { id: 'e_vco_vca',    from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' },
          sourceType: 'audio', targetType: 'audio' },
        { id: 'e_env_vca',    from: { nodeId: 'adsr',portId: 'env' },  to: { nodeId: 'vca', portId: 'cv' },
          sourceType: 'cv', targetType: 'cv' },
        { id: 'e_vca_snk',    from: { nodeId: 'vca', portId: 'audio' },to: { nodeId: 'snk', portId: 'ch1' },
          sourceType: 'audio', targetType: 'audio' },
      ],
      readNodeId: 'snk',
    },
  ];
}

/** Pure helper for callers that want to see every-module-by-port type. */
export function modulesByOutputType(t: string): RegistryModule[] {
  return REGISTRY.filter((m) => m.outputs.some((p) => p.type === t));
}
