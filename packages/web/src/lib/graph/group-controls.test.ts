// packages/web/src/lib/graph/group-controls.test.ts
//
// Module-grouping Phase 4 — exposed-controls discovery + validation tests.
//
// Twofold goal:
//   1. Schema-validate the v1 module-def declarations (sequencers + TIMELORDE)
//      so a typo in `exposableControls` is caught at unit time, not E2E.
//   2. Cover the enumeration bug class flagged in issue #187 (the exposedPorts
//      sibling helper). The discrete-CV case the bug missed for ports is the
//      'button' kind (paramId references a discrete param) for controls; we
//      explicitly assert that buttons + knobs both round-trip through
//      validation when the underlying param is a discrete one.

import { describe, expect, it } from 'vitest';
import type { ModuleNode } from './types';
import type { ExposedControl } from './group-projection';
import type { ExposableControl } from '$lib/audio/module-registry';
import {
  listExposableControls,
  validateExposedControls,
  resolveExposedControls,
  type ControlDefLookup,
} from './group-controls';

import { drumseqzDef } from '$lib/audio/modules/drumseqz';
import { polyseqzDef } from '$lib/audio/modules/polyseqz';
import { macseqDef } from '$lib/audio/modules/macseq';
import { sequencerDef } from '$lib/audio/modules/sequencer';
import { timelordeDef } from '$lib/audio/modules/timelorde';

// ---------- shared fixtures --------------------------------------------------

const defs = {
  drumseqz: drumseqzDef,
  polyseqz: polyseqzDef,
  macseq: macseqDef,
  sequencer: sequencerDef,
  timelorde: timelordeDef,
} as const;

const defLookup: ControlDefLookup = (t) =>
  (defs as Record<string, { exposableControls?: readonly ExposableControl[] }>)[t];

function makeNode(id: string, type: string, data?: Record<string, unknown>): ModuleNode {
  return {
    id,
    type,
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    ...(data ? { data } : {}),
  };
}

// ---------- v1 module-def coverage ------------------------------------------

describe('exposableControls — v1 scope module-def declarations', () => {
  it.each([
    ['sequencer', sequencerDef],
    ['drumseqz', drumseqzDef],
    ['polyseqz', polyseqzDef],
    ['macseq', macseqDef],
  ] as const)('%s declares a single playStop button bound to isPlaying', (_label, def) => {
    expect(def.exposableControls).toBeDefined();
    const ctrls = def.exposableControls ?? [];
    expect(ctrls).toHaveLength(1);
    const c = ctrls[0];
    expect(c.id).toBe('playStop');
    expect(c.kind).toBe('button');
    expect(c.paramId).toBe('isPlaying');
    // The button must reference a real param on this def, otherwise
    // writes from the group bar silently no-op.
    const param = def.params.find((p) => p.id === c.paramId);
    expect(param, `${def.type}.params is missing ${c.paramId}`).toBeDefined();
  });

  it('TIMELORDE exposes every visible knob (bpm, swingAmount, swingSource)', () => {
    const ctrls = timelordeDef.exposableControls ?? [];
    const ids = ctrls.map((c) => c.id).sort();
    expect(ids).toEqual(['bpm', 'swingAmount', 'swingSource']);
    for (const c of ctrls) {
      expect(c.kind).toBe('knob');
      const param = timelordeDef.params.find((p) => p.id === c.paramId);
      expect(param, `timelorde.params is missing ${c.paramId}`).toBeDefined();
    }
  });

  it('every declared exposableControl references a real param on its own def', () => {
    // Generic sweep so a future module that adds the field can't slip past
    // a missing-param typo.
    for (const def of Object.values(defs)) {
      for (const c of def.exposableControls ?? []) {
        const param = def.params.find((p) => p.id === c.paramId);
        expect(
          param,
          `[${def.type}] exposableControls[id=${c.id}] paramId="${c.paramId}" missing`,
        ).toBeDefined();
      }
    }
  });
});

// ---------- listExposableControls -------------------------------------------

describe('listExposableControls', () => {
  it('returns the def list for a known type', () => {
    const got = listExposableControls('drumseqz', defLookup);
    expect(got).toEqual(drumseqzDef.exposableControls);
  });

  it('returns [] for an unknown type', () => {
    const got = listExposableControls('does-not-exist', defLookup);
    expect(got).toEqual([]);
  });

  it('returns [] for a known type whose def has no exposableControls', () => {
    // synthesize a def without the field
    const lookup: ControlDefLookup = () => ({ exposableControls: undefined });
    expect(listExposableControls('whatever', lookup)).toEqual([]);
  });
});

// ---------- validateExposedControls -----------------------------------------

describe('validateExposedControls', () => {
  it('drops entries pointing at deleted children', () => {
    const raw: ExposedControl[] = [{ childId: 'seq-1', controlId: 'playStop' }];
    const survived = validateExposedControls(raw, { nodes: {}, defLookup });
    expect(survived).toEqual([]);
  });

  it('drops entries pointing at controls the child does NOT expose', () => {
    const nodes = { 'tl-1': makeNode('tl-1', 'timelorde') };
    const raw: ExposedControl[] = [
      { childId: 'tl-1', controlId: 'playStop' }, // TIMELORDE doesn't expose playStop
      { childId: 'tl-1', controlId: 'bpm' },      // legit
    ];
    const survived = validateExposedControls(raw, { nodes, defLookup });
    expect(survived).toEqual([{ childId: 'tl-1', controlId: 'bpm' }]);
  });

  it('passes through all v1 control kinds (button + knob) round-trip', () => {
    // Regression for issue #187 enumeration bug class: discrete-param
    // controls must survive validation just like log/linear ones. The
    // button targets a discrete isPlaying param; the knob targets a
    // discrete swingSource param. Both are valid; neither may be dropped.
    const nodes = {
      'seq-1': makeNode('seq-1', 'drumseqz'),
      'tl-1': makeNode('tl-1', 'timelorde'),
    };
    const raw: ExposedControl[] = [
      { childId: 'seq-1', controlId: 'playStop' },       // button → discrete
      { childId: 'tl-1', controlId: 'swingSource' },     // knob → discrete
      { childId: 'tl-1', controlId: 'bpm' },             // knob → log
      { childId: 'tl-1', controlId: 'swingAmount' },     // knob → linear
    ];
    const survived = validateExposedControls(raw, { nodes, defLookup });
    expect(survived).toEqual(raw); // every entry is kept
  });
});

// ---------- resolveExposedControls ------------------------------------------

describe('resolveExposedControls', () => {
  it('returns [] for a group with no exposedControls', () => {
    const group = { data: { childIds: [], exposedPorts: [] } };
    const got = resolveExposedControls(group, { nodes: {}, defLookup });
    expect(got).toEqual([]);
  });

  it('groups surviving controls by child + preserves saved order', () => {
    const nodes: Record<string, ModuleNode> = {
      'seq-1': makeNode('seq-1', 'drumseqz', { name: 'DRUMSEQZ1' }),
      'tl-1': makeNode('tl-1', 'timelorde'),
    };
    const group = {
      data: {
        childIds: ['seq-1', 'tl-1'],
        exposedPorts: [],
        exposedControls: [
          { childId: 'tl-1', controlId: 'bpm' },
          { childId: 'seq-1', controlId: 'playStop' },
          { childId: 'tl-1', controlId: 'swingAmount' },
        ],
      },
    };
    const got = resolveExposedControls(group, {
      nodes,
      defLookup,
      defLabelLookup: (t) => (t === 'timelorde' ? 'TIMELORDE' : undefined),
    });

    expect(got).toHaveLength(2);
    // First child to appear in exposedControls is tl-1 (entry 0).
    expect(got[0].childId).toBe('tl-1');
    expect(got[0].childLabel).toBe('TIMELORDE'); // from defLabelLookup (data.name missing)
    expect(got[0].controls.map((c) => c.id)).toEqual(['bpm', 'swingAmount']);
    // Second child: seq-1, using its data.name when present.
    expect(got[1].childId).toBe('seq-1');
    expect(got[1].childLabel).toBe('DRUMSEQZ1');
    expect(got[1].controls.map((c) => c.id)).toEqual(['playStop']);
  });

  it('skips a child that has no surviving controls after validation', () => {
    const nodes = { 'seq-1': makeNode('seq-1', 'drumseqz') };
    const group = {
      data: {
        childIds: ['seq-1'],
        exposedPorts: [],
        exposedControls: [
          { childId: 'seq-1', controlId: 'bogus' },  // not on the def
          { childId: 'gone', controlId: 'playStop' }, // child deleted
        ],
      },
    };
    const got = resolveExposedControls(group, { nodes, defLookup });
    expect(got).toEqual([]);
  });

  it('falls back to module type when neither data.name nor defLabelLookup yields a label', () => {
    const nodes = { 'seq-1': makeNode('seq-1', 'drumseqz') };
    const group = {
      data: {
        childIds: ['seq-1'],
        exposedPorts: [],
        exposedControls: [{ childId: 'seq-1', controlId: 'playStop' }],
      },
    };
    const got = resolveExposedControls(group, { nodes, defLookup });
    expect(got).toHaveLength(1);
    expect(got[0].childLabel).toBe('drumseqz');
  });
});
