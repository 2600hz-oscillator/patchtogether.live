// packages/web/src/lib/graph/control-surface.test.ts
//
// Pure model + helper coverage for the CONTROL SURFACE (the side-effecting
// ydoc mutators are exercised by the e2e spec against a real patch). We pin:
//   - listControlSurfaces enumerates type==='controlSurface' with names
//   - binding add/remove is deduped + order-preserving (pointers, not copies)
//   - groupBindingsByModule buckets by source module in first-seen order
//   - screen add/remove dedupe
//   - pruneDangling drops bindings/screens whose source is gone
//   - the meta def shape

import { describe, it, expect } from 'vitest';
import {
  CONTROL_SURFACE_TYPE,
  surfaceName,
  listControlSurfaces,
  hasBinding,
  hasScreen,
  withBindingAdded,
  withBindingRemoved,
  withScreenAdded,
  withScreenRemoved,
  groupBindingsByModule,
  pruneDangling,
  bindingKey,
  type ControlSurfaceData,
} from './control-surface';
import { controlSurfaceDef } from '$lib/meta/modules/control-surface';
import type { ModuleNode } from '$lib/graph/types';

function node(type: string, data?: unknown): ModuleNode {
  return { id: 'x', type, domain: 'meta', position: { x: 0, y: 0 }, params: {}, data } as unknown as ModuleNode;
}

describe('surfaceName', () => {
  it('uses data.name, falling back to a stable default', () => {
    expect(surfaceName(node(CONTROL_SURFACE_TYPE, { name: 'Drum Control' }))).toBe('Drum Control');
    expect(surfaceName(node(CONTROL_SURFACE_TYPE, {}))).toBe('Control Surface');
    expect(surfaceName(node(CONTROL_SURFACE_TYPE, { name: '   ' }))).toBe('Control Surface');
    expect(surfaceName(undefined)).toBe('Control Surface');
  });
});

describe('listControlSurfaces', () => {
  it('returns every control-surface node (id + name), id-sorted, ignoring others', () => {
    const nodes: Record<string, ModuleNode | undefined> = {
      's2': { ...node(CONTROL_SURFACE_TYPE, { name: 'Bass' }), id: 's2' } as ModuleNode,
      's1': { ...node(CONTROL_SURFACE_TYPE, { name: 'Drums' }), id: 's1' } as ModuleNode,
      'vco': { ...node('analogVco'), id: 'vco' } as ModuleNode,
      'gone': undefined,
    };
    expect(listControlSurfaces(nodes)).toEqual([
      { id: 's1', name: 'Drums' },
      { id: 's2', name: 'Bass' },
    ]);
  });
});

describe('binding add/remove (pointers, deduped)', () => {
  it('adds a binding and is idempotent (no duplicate pointers)', () => {
    let data: ControlSurfaceData = {};
    data = { bindings: withBindingAdded(data, 'vco1', 'tune') };
    expect(data.bindings).toEqual([{ moduleId: 'vco1', paramId: 'tune' }]);
    // adding the SAME pointer again is a no-op (same control everywhere)
    data = { bindings: withBindingAdded(data, 'vco1', 'tune') };
    expect(data.bindings).toEqual([{ moduleId: 'vco1', paramId: 'tune' }]);
    expect(hasBinding(data, 'vco1', 'tune')).toBe(true);
    expect(hasBinding(data, 'vco1', 'width')).toBe(false);
  });

  it('preserves insertion order across modules + params', () => {
    let b = withBindingAdded({}, 'a', 'p1');
    b = withBindingAdded({ bindings: b }, 'b', 'q1');
    b = withBindingAdded({ bindings: b }, 'a', 'p2');
    expect(b).toEqual([
      { moduleId: 'a', paramId: 'p1' },
      { moduleId: 'b', paramId: 'q1' },
      { moduleId: 'a', paramId: 'p2' },
    ]);
  });

  it('removes exactly the targeted pointer', () => {
    const data: ControlSurfaceData = {
      bindings: [
        { moduleId: 'a', paramId: 'p1' },
        { moduleId: 'a', paramId: 'p2' },
        { moduleId: 'b', paramId: 'q1' },
      ],
    };
    expect(withBindingRemoved(data, 'a', 'p1')).toEqual([
      { moduleId: 'a', paramId: 'p2' },
      { moduleId: 'b', paramId: 'q1' },
    ]);
  });

  it('bindingKey is moduleId:paramId (shared MIDI key with the source)', () => {
    expect(bindingKey('vco1', 'tune')).toBe('vco1:tune');
  });
});

describe('screen add/remove (deduped)', () => {
  it('adds + dedupes + removes a scope screen', () => {
    let s = withScreenAdded({}, 'scope1');
    s = withScreenAdded({ screens: s }, 'scope1');
    expect(s).toEqual([{ moduleId: 'scope1' }]);
    expect(hasScreen({ screens: s }, 'scope1')).toBe(true);
    expect(withScreenRemoved({ screens: s }, 'scope1')).toEqual([]);
  });
});

describe('groupBindingsByModule', () => {
  it('buckets by source module in first-seen order', () => {
    const groups = groupBindingsByModule([
      { moduleId: 'a', paramId: 'p1' },
      { moduleId: 'b', paramId: 'q1' },
      { moduleId: 'a', paramId: 'p2' },
      { moduleId: 'b', paramId: 'q2' },
    ]);
    expect(groups).toEqual([
      { moduleId: 'a', bindings: [{ moduleId: 'a', paramId: 'p1' }, { moduleId: 'a', paramId: 'p2' }] },
      { moduleId: 'b', bindings: [{ moduleId: 'b', paramId: 'q1' }, { moduleId: 'b', paramId: 'q2' }] },
    ]);
  });
  it('handles empty', () => {
    expect(groupBindingsByModule([])).toEqual([]);
  });
});

describe('pruneDangling', () => {
  it('drops bindings + screens whose source module is gone', () => {
    const data: ControlSurfaceData = {
      bindings: [
        { moduleId: 'alive', paramId: 'p' },
        { moduleId: 'dead', paramId: 'q' },
      ],
      screens: [{ moduleId: 'alive' }, { moduleId: 'dead' }],
    };
    const nodes: Record<string, ModuleNode | undefined> = {
      alive: { ...node('analogVco'), id: 'alive' } as ModuleNode,
    };
    const cleaned = pruneDangling(data, nodes);
    expect(cleaned.bindings).toEqual([{ moduleId: 'alive', paramId: 'p' }]);
    expect(cleaned.screens).toEqual([{ moduleId: 'alive' }]);
  });
});

describe('controlSurfaceDef: meta def shape', () => {
  it('is a meta module with no ports/params and the right card + palette', () => {
    expect(controlSurfaceDef.type).toBe('controlSurface');
    expect(controlSurfaceDef.domain).toBe('meta');
    expect(controlSurfaceDef.label).toBe('CONTROL SURFACE');
    expect(controlSurfaceDef.card).toBe('ControlSurfaceCard');
    expect(controlSurfaceDef.inputs).toEqual([]);
    expect(controlSurfaceDef.outputs).toEqual([]);
    expect(controlSurfaceDef.params).toEqual([]);
    expect(controlSurfaceDef.palette).toEqual({ top: 'Hybrid', sub: 'Hybrid' });
  });
});
