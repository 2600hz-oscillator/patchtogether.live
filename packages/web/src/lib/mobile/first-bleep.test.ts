// FIRST BLEEP template — the contract test (spec §3 + §7).
//
// Runs the shared validateGraphFragment over the template against the REAL
// module registries, so a port rename (sequencer.gate, vca.cv, mixmstrs.ch1L,
// …) or a cable-type change fails the unit lane instead of shipping a silent
// starter patch to the phone. This is the exact validator the reconciler
// write paths use — if it passes here, the engine can materialize the patch.

import { describe, expect, it } from 'vitest';
import { validateGraphFragment } from '$lib/graph/validate-edge';
import { resolveAnyDef } from '$lib/mobile/mobile-host';
import {
  emptyRackFragment,
  firstBleepFragment,
  seedSteps,
} from './first-bleep';

describe('FIRST BLEEP template', () => {
  it('every node type is registered and EVERY edge validates against the live defs', () => {
    const fragment = firstBleepFragment();
    const result = validateGraphFragment(fragment, resolveAnyDef);
    expect(result.droppedNodes).toEqual([]);
    expect(result.droppedEdges).toEqual([]);
    expect(result.validEdges).toHaveLength(fragment.edges.length);
  });

  it('wires the full audible chain: seq → vco → vca(env) → delay → mix ch1 L+R → audioOut L/R', () => {
    const fragment = firstBleepFragment();
    const byTarget = new Map(
      fragment.edges.map((e) => [`${e.target.nodeId.split('-')[0]}.${e.target.portId}`, e]),
    );
    // The mono double-patch: delay feeds BOTH sides of mixmstrs ch1.
    expect(byTarget.get('mixmstrs.ch1L')?.source.portId).toBe('audio');
    expect(byTarget.get('mixmstrs.ch1R')?.source.portId).toBe('audio');
    // Master reaches the terminal output on both sides.
    expect(byTarget.get('audioOut.L')?.source.portId).toBe('masterL');
    expect(byTarget.get('audioOut.R')?.source.portId).toBe('masterR');
    // The envelope drives the VCA cv input (not the audio input).
    expect(byTarget.get('vca.cv')?.source.portId).toBe('env');
  });

  it('is audible on first tap: sequencer isPlaying=1 with at least 4 lit seeded steps', () => {
    const fragment = firstBleepFragment();
    const seq = fragment.nodes.find((n) => n.type === 'sequencer')!;
    expect(seq.params.isPlaying).toBe(1);
    const steps = (seq.data as { steps: { on: boolean; midi: number | null }[] }).steps;
    const lit = steps.filter((s) => s.on);
    expect(lit.length).toBeGreaterThanOrEqual(4);
    // Every lit step carries a real midi note (a null-midi lit step is a rest).
    for (const s of lit) expect(typeof s.midi).toBe('number');
  });

  it('seedSteps returns the full 128-slot array (the card widens on read)', () => {
    expect(seedSteps()).toHaveLength(128);
  });

  it('EMPTY RACK: timelorde + mixmstrs + audioOut with master pre-wired, all valid', () => {
    const fragment = emptyRackFragment();
    const result = validateGraphFragment(fragment, resolveAnyDef);
    expect(result.droppedNodes).toEqual([]);
    expect(result.droppedEdges).toEqual([]);
    expect(fragment.edges).toHaveLength(2);
  });
});
