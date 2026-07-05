// packages/web/src/lib/audio/engine.test.ts
//
// Phase 2d — engine singleton / max-instance enforcement.
//
// The AudioEngine.addNode maxInstances guard used to count existing instances
// of a module type with a NODE-ID-PREFIX heuristic (`id.startsWith(`${type}-`)`).
// That matched the palette's `${type}-...` spawn convention but silently
// MISCOUNTED any node spawned with a custom/renamed id — such a node was not
// counted, so a maxInstances:1 ("singleton") module could be exceeded.
//
// The guard now counts EXACTLY over the engine's own `nodeTypes` map
// (nodeId → type), which addNode already maintains. These tests pin:
//   (a) a maxInstances:1 type spawned twice → the lex-LARGER id loses (skipped),
//   (b) when the lex-SMALLER id arrives second, it EVICTS the larger,
//   (c) a node with a custom (non-type-prefixed) id is still counted by type —
//       the exact case the old prefix heuristic got wrong.
//
// Uses the real AudioEngine + a couple of fake module defs (mirrors
// engine-removeNode-leak.test.ts).

import { describe, it, expect } from 'vitest';
import { AudioEngine } from './engine';
import type { AudioModuleDef } from './module-registry';
import { registerModule, getModuleDef } from './module-registry';
import type { ModuleNode } from '$lib/graph/types';

// ---- Minimal fake AudioContext (factories below don't actually create nodes) ----

function makeFakeAudioContext(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain() {
      return {
        connect() {},
        disconnect() {},
        gain: { value: 1, setValueAtTime() {} },
      };
    },
    createAnalyser() {
      return {
        connect() {},
        disconnect() {},
        fftSize: 32,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData() {},
      };
    },
  } as unknown as AudioContext;
}

// ---- A fake module def whose factory counts how many times it ran ----
//
// We assert against `dispose` / factory call counts to prove eviction tears the
// loser down, and against `eng.nodes` to prove the cap held.

function makeFakeNode(): AudioNode {
  return { connect() {}, disconnect() {} } as unknown as AudioNode;
}

interface SpawnRecorder {
  factoryCalls: string[]; // node ids the factory ran for
  disposed: string[]; // node ids that were disposed
}

/**
 * Register a singleton (maxInstances:1) fake module def whose factory records
 * each materialization + dispose against `rec`. The def has NO params, so the
 * engine's knob-seed loop is a no-op.
 */
function registerSingletonDef(type: string, rec: SpawnRecorder): void {
  if (getModuleDef(type)) return;
  const def: AudioModuleDef = {
    type,
    domain: 'audio',
    label: type,
    category: 'utilities',
    inputs: [],
    outputs: [{ id: 'out', type: 'audio' }],
    params: [],
    maxInstances: 1,
    async factory(_ctx, node) {
      rec.factoryCalls.push(node.id);
      const out = makeFakeNode();
      return {
        domain: 'audio' as const,
        inputs: new Map(),
        outputs: new Map([['out', { node: out, output: 0 }]]),
        setParam() {},
        readParam() {
          return undefined;
        },
        dispose() {
          rec.disposed.push(node.id);
        },
      };
    },
  };
  registerModule(def);
}

function makeNode(id: string, type: string): ModuleNode {
  return { id, type, domain: 'audio', position: { x: 0, y: 0 }, params: {} };
}

function liveIds(eng: AudioEngine): string[] {
  return [...eng.nodes.keys()].sort();
}

describe('AudioEngine maxInstances — exact nodeTypes count (Phase 2d)', () => {
  it('(a) singleton spawned twice: the lex-LARGER id is skipped, not added', async () => {
    const type = 'p2dSingletonA';
    const rec: SpawnRecorder = { factoryCalls: [], disposed: [] };
    registerSingletonDef(type, rec);
    const eng = new AudioEngine(makeFakeAudioContext());

    await eng.addNode(makeNode(`${type}-aaa`, type)); // first instance wins
    await eng.addNode(makeNode(`${type}-zzz`, type)); // lex-larger → loser

    // Only the lex-smaller id survives; the loser never even materialized.
    expect(liveIds(eng)).toEqual([`${type}-aaa`]);
    expect(rec.factoryCalls).toEqual([`${type}-aaa`]);
    expect(rec.disposed).toEqual([]); // nothing evicted; loser skipped pre-factory
  });

  it('(b) lex-SMALLER id arriving second evicts the larger incumbent', async () => {
    const type = 'p2dSingletonB';
    const rec: SpawnRecorder = { factoryCalls: [], disposed: [] };
    registerSingletonDef(type, rec);
    const eng = new AudioEngine(makeFakeAudioContext());

    await eng.addNode(makeNode(`${type}-zzz`, type)); // incumbent (lex-larger)
    await eng.addNode(makeNode(`${type}-aaa`, type)); // winner → evicts zzz

    // The lex-smaller id wins the rackspace; the larger incumbent is gone.
    expect(liveIds(eng)).toEqual([`${type}-aaa`]);
    expect(rec.factoryCalls).toEqual([`${type}-zzz`, `${type}-aaa`]);
    expect(rec.disposed).toEqual([`${type}-zzz`]); // incumbent torn down

    // The eviction kept nodeTypes in sync: a THIRD lex-larger spawn must still
    // see exactly one instance and lose (no stale `zzz` inflating the count,
    // and — pre-fix — no phantom miss either).
    await eng.addNode(makeNode(`${type}-mmm`, type)); // lex-larger than aaa → loser
    expect(liveIds(eng)).toEqual([`${type}-aaa`]);
    expect(rec.disposed).toEqual([`${type}-zzz`]); // nothing new evicted
  });

  it('(c) custom (non-type-prefixed) ids are counted by type — the heuristic bug', async () => {
    // Neither id starts with `${type}-`, so the OLD startsWith heuristic counted
    // ZERO existing instances and would have let BOTH through, breaking the
    // singleton. The exact nodeTypes lookup counts them by type, so the cap holds.
    const type = 'p2dSingletonC';
    const rec: SpawnRecorder = { factoryCalls: [], disposed: [] };
    registerSingletonDef(type, rec);
    const eng = new AudioEngine(makeFakeAudioContext());

    await eng.addNode(makeNode('aaa-custom-anchor', type)); // custom id, no prefix
    await eng.addNode(makeNode('zzz-custom-anchor', type)); // custom id, lex-larger → loser

    expect(liveIds(eng)).toEqual(['aaa-custom-anchor']); // cap of 1 enforced
    expect(rec.factoryCalls).toEqual(['aaa-custom-anchor']); // loser never built
    expect(rec.disposed).toEqual([]);

    // And a lex-smaller custom id arriving later still evicts the incumbent,
    // proving the by-type count drives the tie-break for custom ids too.
    await eng.addNode(makeNode('aaa-aaa-anchor', type)); // lex-smaller → winner
    expect(liveIds(eng)).toEqual(['aaa-aaa-anchor']);
    expect(rec.disposed).toEqual(['aaa-custom-anchor']);
  });
});
