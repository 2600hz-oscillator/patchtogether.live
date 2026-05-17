// packages/web/src/lib/mike/personality.test.ts
//
// Mike's structured progression — verified by reading the first
// several intents emitted from an empty patch and asserting the order:
//   drumseqz → drumVoice → mixer → (wires) → bass → melody → ...
//
// Existing-rack mode test: spawn into a rack that already has a
// TIMELORDE + sequencer; Mike's first intent adds a tone sequencer
// and the second clocks it from the existing TIMELORDE.

import { describe, expect, it } from 'vitest';
import { MeticulousMike, type PersonalityPatchView } from './personality';
import { SeededRng } from '$lib/carl/rng';
import type { Catalog } from './catalog';

// Synthetic catalog covering exactly the modules Mike's progression needs.
// Mirrors the real registry's port/cable shape — no factories required.
const FAKE_CATALOG: Catalog = [
  {
    type: 'drumseqz',
    category: 'sequencers',
    inputs: [{ id: 'clock', cableType: 'gate' }],
    outputs: [
      { id: 'gate1', cableType: 'gate' },
      { id: 'pitch1', cableType: 'pitch' },
    ],
    params: [{ id: 'step1', min: 0, max: 1, defaultValue: 1 }],
  },
  {
    type: 'drummergirl',
    category: 'voices',
    inputs: [
      { id: 'gate', cableType: 'gate' },
      { id: 'pitch', cableType: 'cv', paramTarget: 'pitch' },
    ],
    outputs: [{ id: 'audio', cableType: 'audio' }],
    params: [{ id: 'tone', min: 0, max: 1, defaultValue: 0.3 }],
  },
  {
    type: 'mixer',
    category: 'utilities',
    inputs: [
      { id: 'in1', cableType: 'audio' },
      { id: 'in2', cableType: 'audio' },
      { id: 'in3', cableType: 'audio' },
      { id: 'in4', cableType: 'audio' },
    ],
    outputs: [{ id: 'audio', cableType: 'audio' }],
    params: [],
  },
  {
    type: 'audioOut',
    category: 'output',
    inputs: [
      { id: 'L', cableType: 'audio' },
      { id: 'R', cableType: 'audio' },
    ],
    outputs: [],
    params: [],
  },
  {
    type: 'polyseqz',
    category: 'sequencers',
    inputs: [{ id: 'clock', cableType: 'gate' }],
    outputs: [
      { id: 'pitch', cableType: 'pitch' },
      { id: 'gate', cableType: 'gate' },
    ],
    params: [{ id: 'step1', min: -36, max: 36, defaultValue: 0 }],
  },
  {
    type: 'sequencer',
    category: 'sequencers',
    inputs: [{ id: 'clock', cableType: 'gate' }],
    outputs: [
      { id: 'pitch', cableType: 'pitch' },
      { id: 'gate', cableType: 'gate' },
    ],
    params: [{ id: 'step1', min: -36, max: 36, defaultValue: 0 }],
  },
  {
    type: 'analogVco',
    category: 'sources',
    inputs: [{ id: 'pitch', cableType: 'pitch' }],
    outputs: [{ id: 'saw', cableType: 'audio' }],
    params: [{ id: 'detune', min: -100, max: 100, defaultValue: 0 }],
  },
  {
    type: 'reverb',
    category: 'effects',
    inputs: [{ id: 'audio', cableType: 'audio' }],
    outputs: [{ id: 'audio', cableType: 'audio' }],
    params: [],
  },
  {
    type: 'timelorde',
    category: 'utilities',
    inputs: [],
    outputs: [
      { id: '1x', cableType: 'gate' },
      { id: '1/2', cableType: 'gate' },
    ],
    params: [],
  },
];

function emptyPatch(): PersonalityPatchView {
  return { nodes: [], edges: [] };
}

describe('MeticulousMike: empty-rack progression', () => {
  it('first action is a drum sequencer', () => {
    const mike = new MeticulousMike(FAKE_CATALOG);
    const rng = new SeededRng(1);
    const out = mike.next(rng, emptyPatch());
    expect(out.intent.kind).toBe('addNode');
    if (out.intent.kind === 'addNode') {
      expect(out.intent.type).toBe('drumseqz');
      expect(out.intent.id.startsWith('mike-')).toBe(true);
    }
  });

  it('progression through the first 4 spawns: drumseqz → drumVoice → mixer → (output already present)', () => {
    const mike = new MeticulousMike(FAKE_CATALOG);
    const rng = new SeededRng(2);
    const view: PersonalityPatchView = emptyPatch();
    const spawnedTypes: string[] = [];
    for (let i = 0; i < 4 && spawnedTypes.length < 3; i++) {
      const out = mike.next(rng, view);
      if (out.intent.kind === 'addNode') {
        spawnedTypes.push(out.intent.type);
        (view.nodes as Array<{ id: string; type: string }>).push({
          id: out.intent.id,
          type: out.intent.type,
        });
      }
    }
    expect(spawnedTypes).toEqual(['drumseqz', 'drummergirl', 'mixer']);
  });

  it('pacing: action min/max sleep stays in 5–15 s for non-sleep intents', () => {
    const mike = new MeticulousMike(FAKE_CATALOG);
    const rng = new SeededRng(3);
    const out = mike.next(rng, emptyPatch());
    if (out.intent.kind !== 'sleep') {
      expect(out.minSleepMs).toBeGreaterThanOrEqual(5000);
      expect(out.maxSleepMs).toBeLessThanOrEqual(15000);
    }
  });
});

describe('MeticulousMike: existing-rack mode', () => {
  it('with TIMELORDE + existing sequencer, Mike spawns a tone sequencer and clocks it from TIMELORDE', () => {
    const mike = new MeticulousMike(FAKE_CATALOG);
    const rng = new SeededRng(11);
    const view: PersonalityPatchView = {
      nodes: [
        { id: 'user-lord', type: 'timelorde' },
        { id: 'user-seq', type: 'sequencer' },
        { id: 'user-vco', type: 'analogVco' },
      ],
      edges: [
        {
          id: 'user-e1',
          source: { nodeId: 'user-lord', portId: '1x' },
          target: { nodeId: 'user-seq', portId: 'clock' },
        },
      ],
    };
    const first = mike.next(rng, view);
    expect(first.intent.kind).toBe('addNode');
    if (first.intent.kind === 'addNode') {
      // Tone sequencer (polyseqz comes first in the priority list,
      // and the rack already has a "sequencer" but it's foreign so
      // Mike still wants his own).
      expect(['polyseqz', 'sequencer']).toContain(first.intent.type);
      (view.nodes as Array<{ id: string; type: string }>).push({
        id: first.intent.id,
        type: first.intent.type,
      });
    }
    const second = mike.next(rng, view);
    // Second action: wire TIMELORDE → Mike's new sequencer's clock input.
    expect(second.intent.kind).toBe('addEdge');
    if (second.intent.kind === 'addEdge') {
      expect(second.intent.sourceNodeId).toBe('user-lord');
      expect(second.intent.sourcePortId).toBe('1x');
      expect(second.intent.targetPortId).toBe('clock');
    }
  });
});

describe('MeticulousMike: music-theory programming', () => {
  it('programInKeyStep produces a value within the requested param range AND on-key', () => {
    const mike = new MeticulousMike(FAKE_CATALOG);
    const rng = new SeededRng(99);
    mike.setKey(() => rng.next());
    const key = mike.getKey();
    const intent = mike.programInKeyStep(rng, 'mike-n0-polyseqz', 'step1', -36, 36, 0, false);
    expect(intent.kind).toBe('setParam');
    if (intent.kind === 'setParam') {
      expect(intent.value).toBeGreaterThanOrEqual(-36);
      expect(intent.value).toBeLessThanOrEqual(36);
      // The value is a semitone. Test that it's on-key WITHIN the clamp
      // — note that clamping at extreme ranges can push off-key, so we
      // only assert if the value is in the safe interior.
      if (intent.value > -34 && intent.value < 34) {
        const pc = ((intent.value - key.root) % 12 + 12) % 12;
        // The pc should be one of the scale steps.
        const steps =
          key.scale === 'major'
            ? [0, 2, 4, 5, 7, 9, 11]
            : key.scale === 'minor'
            ? [0, 2, 3, 5, 7, 8, 10]
            : [0, 2, 4, 7, 9];
        expect(steps).toContain(pc);
      }
    }
  });
});

describe('MeticulousMike: ownership', () => {
  it('idPrefix gates which nodes count toward maxOwnedNodes', () => {
    const mike = new MeticulousMike(FAKE_CATALOG, { maxOwnedNodes: 0 });
    const rng = new SeededRng(0);
    const view: PersonalityPatchView = {
      nodes: [{ id: 'user-x', type: 'mixer' }],
      edges: [],
    };
    // With maxOwnedNodes=0 and no owned nodes yet, the next() should
    // return a sleep (we've hit the cap immediately).
    const out = mike.next(rng, view);
    expect(out.intent.kind).toBe('sleep');
  });

  it('emits only mike-prefixed ids', () => {
    const mike = new MeticulousMike(FAKE_CATALOG, { idPrefix: 'mike' });
    const rng = new SeededRng(5);
    const out = mike.next(rng, emptyPatch());
    if (out.intent.kind === 'addNode') {
      expect(out.intent.id.startsWith('mike-')).toBe(true);
    }
  });

  it('throws if the catalog has no spawnable modules', () => {
    expect(() => new MeticulousMike([], {})).toThrow(/no spawnable modules/);
  });
});
