// packages/web/src/lib/mobile/first-bleep.ts
//
// FIRST BLEEP — the pocket modular's one-tap starter patch (spec §3 Boot):
//
//   sequencer.pitch → analogVco.pitch      (polyPitchGate → pitch)
//   sequencer.gate  → adsr.gate            (gate)
//   analogVco.saw   → vca.audio            (audio)
//   adsr.env        → vca.cv               (cv)
//   vca.audio       → delay.audio          (audio)
//   delay.audio     → mixmstrs ch1L + ch1R (mono double-patch)
//   mixmstrs.masterL/R → audioOut.L/R
//   + timelorde (the undeletable system clock)
//   sequencer.isPlaying = 1 and a seeded step pattern → SOUND ON FIRST TAP.
//
// The fragment builder is PURE (deterministic ids) so the unit test can run
// validateGraphFragment over it against the REAL registries — a port rename
// fails the unit lane, not the phone. The spawn writes everything in ONE
// LOCAL_ORIGIN transact (single undo entry, one snapshot emit).

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { Edge, ModuleNode } from '$lib/graph/types';
import { matrixEdgeId } from '$lib/ui/matrixmix-grid';
import { defaultSteps } from '$lib/audio/modules/sequencer';
import { ensureMobileEngine } from '$lib/mobile/mobile-host';

/** Deterministic node ids for the template (suffixed at spawn time). */
export interface FirstBleepIds {
  timelorde: string;
  sequencer: string;
  analogVco: string;
  adsr: string;
  vca: string;
  delay: string;
  mixmstrs: string;
  audioOut: string;
}

function makeIds(suffix: () => string): FirstBleepIds {
  return {
    timelorde: `timelorde-${suffix()}`,
    sequencer: `sequencer-${suffix()}`,
    analogVco: `analogVco-${suffix()}`,
    adsr: `adsr-${suffix()}`,
    vca: `vca-${suffix()}`,
    delay: `delay-${suffix()}`,
    mixmstrs: `mixmstrs-${suffix()}`,
    audioOut: `audioOut-${suffix()}`,
  };
}

/** A friendly 16-step minor-pentatonic bleep line (C3 root). Steps hold
 *  {on, midi, chord} — the sequencer card's persisted shape. */
export function seedSteps(): { on: boolean; midi: number | null; chord: 'mono' }[] {
  const steps = defaultSteps() as { on: boolean; midi: number | null; chord: 'mono' }[];
  const C3 = 48;
  const line: Array<[number, number]> = [
    [0, C3],
    [2, C3 + 3],
    [4, C3 + 7],
    [6, C3 + 10],
    [8, C3 + 12],
    [10, C3 + 7],
    [12, C3 + 3],
    [14, C3 - 2],
  ];
  for (const [i, midi] of line) {
    steps[i] = { on: true, midi, chord: 'mono' };
  }
  return steps;
}

const nodePositions: Record<keyof FirstBleepIds, { x: number; y: number }> = {
  timelorde: { x: 40, y: 40 },
  sequencer: { x: 460, y: 40 },
  analogVco: { x: 40, y: 640 },
  adsr: { x: 460, y: 640 },
  vca: { x: 860, y: 640 },
  delay: { x: 1120, y: 640 },
  mixmstrs: { x: 40, y: 1000 },
  audioOut: { x: 820, y: 1000 },
};

/** Build the template as a plain graph fragment. Pure — no store writes. */
export function firstBleepFragment(ids: FirstBleepIds = makeIds(() => 'test')): {
  nodes: ModuleNode[];
  edges: Edge[];
} {
  // spawnSeq drives the RACK chip-strip ordering (signal-flow order here).
  let seq = 0;
  const mk = (key: keyof FirstBleepIds, type: string, extra?: Partial<ModuleNode>): ModuleNode => ({
    id: ids[key],
    type,
    domain: 'audio',
    position: nodePositions[key],
    params: {},
    ...extra,
    data: { name: type.toUpperCase(), spawnSeq: seq++, ...(extra?.data ?? {}) },
  });
  const nodes: ModuleNode[] = [
    mk('timelorde', 'timelorde'),
    mk('sequencer', 'sequencer', {
      params: { isPlaying: 1, bpm: 118 },
      data: { name: 'SEQUENCER', steps: seedSteps() },
    }),
    mk('analogVco', 'analogVco'),
    mk('adsr', 'adsr'),
    mk('vca', 'vca'),
    mk('delay', 'delay', { params: { mix: 0.3, feedback: 0.35 } }),
    mk('mixmstrs', 'mixmstrs'),
    mk('audioOut', 'audioOut'),
  ];

  const edge = (
    from: keyof FirstBleepIds,
    fromPort: string,
    to: keyof FirstBleepIds,
    toPort: string,
    sourceType: Edge['sourceType'],
    targetType: Edge['targetType'],
  ): Edge => {
    const source = { nodeId: ids[from], portId: fromPort };
    const target = { nodeId: ids[to], portId: toPort };
    return { id: matrixEdgeId(source, target), source, target, sourceType, targetType };
  };

  const edges: Edge[] = [
    edge('sequencer', 'pitch', 'analogVco', 'pitch', 'polyPitchGate', 'pitch'),
    edge('sequencer', 'gate', 'adsr', 'gate', 'gate', 'gate'),
    edge('analogVco', 'saw', 'vca', 'audio', 'audio', 'audio'),
    edge('adsr', 'env', 'vca', 'cv', 'cv', 'cv'),
    edge('vca', 'audio', 'delay', 'audio', 'audio', 'audio'),
    // Mono source → stereo pair: double-patch delay.audio to ch1 L AND R.
    edge('delay', 'audio', 'mixmstrs', 'ch1L', 'audio', 'audio'),
    edge('delay', 'audio', 'mixmstrs', 'ch1R', 'audio', 'audio'),
    edge('mixmstrs', 'masterL', 'audioOut', 'L', 'audio', 'audio'),
    edge('mixmstrs', 'masterR', 'audioOut', 'R', 'audio', 'audio'),
  ];

  return { nodes, edges };
}

/** The EMPTY RACK starter: timelorde + mixmstrs + audioOut, master pre-wired
 *  (nothing on mobile is silent-by-default — spec §3). Pure fragment. */
export function emptyRackFragment(idsIn?: { timelorde: string; mixmstrs: string; audioOut: string }): {
  nodes: ModuleNode[];
  edges: Edge[];
} {
  const ids = idsIn ?? {
    timelorde: 'timelorde-test',
    mixmstrs: 'mixmstrs-test',
    audioOut: 'audioOut-test',
  };
  const nodes: ModuleNode[] = [
    {
      id: ids.timelorde,
      type: 'timelorde',
      domain: 'audio',
      position: { x: 40, y: 40 },
      params: {},
      data: { name: 'TIMELORDE' },
    },
    {
      id: ids.mixmstrs,
      type: 'mixmstrs',
      domain: 'audio',
      position: { x: 460, y: 40 },
      params: {},
      data: { name: 'MIXMSTRS' },
    },
    {
      id: ids.audioOut,
      type: 'audioOut',
      domain: 'audio',
      position: { x: 1240, y: 40 },
      params: {},
      data: { name: 'AUDIOOUT' },
    },
  ];
  const e = (fromPort: string, toPort: string): Edge => {
    const source = { nodeId: ids.mixmstrs, portId: fromPort };
    const target = { nodeId: ids.audioOut, portId: toPort };
    return {
      id: matrixEdgeId(source, target),
      source,
      target,
      sourceType: 'audio',
      targetType: 'audio',
    };
  };
  return { nodes, edges: [e('masterL', 'L'), e('masterR', 'R')] };
}

function writeFragment(fragment: { nodes: ModuleNode[]; edges: Edge[] }): void {
  ydoc.transact(() => {
    for (const n of fragment.nodes) patch.nodes[n.id] = n;
    for (const e of fragment.edges) patch.edges[e.id] = e;
  }, LOCAL_ORIGIN);
  void ensureMobileEngine();
}

/** Spawn the FIRST BLEEP template into the live store (one transact). */
export function spawnFirstBleep(): FirstBleepIds {
  const ids = makeIds(() => crypto.randomUUID().slice(0, 8));
  writeFragment(firstBleepFragment(ids));
  return ids;
}

/** Spawn the EMPTY RACK starter into the live store (one transact). */
export function spawnEmptyRack(): { timelorde: string; mixmstrs: string; audioOut: string } {
  const ids = {
    timelorde: `timelorde-${crypto.randomUUID().slice(0, 8)}`,
    mixmstrs: `mixmstrs-${crypto.randomUUID().slice(0, 8)}`,
    audioOut: `audioOut-${crypto.randomUUID().slice(0, 8)}`,
  };
  writeFragment(emptyRackFragment(ids));
  return ids;
}
