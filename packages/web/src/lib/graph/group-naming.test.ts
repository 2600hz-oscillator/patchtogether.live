// packages/web/src/lib/graph/group-naming.test.ts
//
// Unit tests for default group-name assignment + legacy migration.

import { describe, it, expect } from 'vitest';
import {
  readGroupLabel,
  isDefaultOrMissingLabel,
  nextGroupName,
  nextGroupNameForNewGroup,
  planDefaultGroupNames,
  LEGACY_GROUP_PLACEHOLDER,
} from './group-naming';
import type { ModuleNode } from './types';

function group(id: string, label?: string): ModuleNode {
  const data: Record<string, unknown> = { childIds: [], exposedPorts: [] };
  if (label !== undefined) data.label = label;
  return {
    id,
    type: 'group',
    domain: 'meta',
    position: { x: 0, y: 0 },
    params: {},
    data,
  };
}

function nonGroup(id: string): ModuleNode {
  return {
    id,
    type: 'lfo',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
  };
}

describe('readGroupLabel', () => {
  it('returns trimmed label string when present', () => {
    expect(readGroupLabel(group('g1', '  Pad chain  '))).toBe('Pad chain');
  });
  it('returns undefined when label missing', () => {
    expect(readGroupLabel(group('g1'))).toBeUndefined();
  });
  it('returns undefined for blank label', () => {
    expect(readGroupLabel(group('g1', '   '))).toBeUndefined();
  });
});

describe('isDefaultOrMissingLabel', () => {
  it('treats missing label as default', () => {
    expect(isDefaultOrMissingLabel(group('g1'))).toBe(true);
  });
  it('treats the legacy "GROUP!" placeholder as default', () => {
    expect(isDefaultOrMissingLabel(group('g1', LEGACY_GROUP_PLACEHOLDER))).toBe(true);
  });
  it('respects a user-chosen name', () => {
    expect(isDefaultOrMissingLabel(group('g1', 'Pad chain'))).toBe(false);
  });
});

describe('nextGroupName', () => {
  it('returns GROUP1 when nothing is taken', () => {
    expect(nextGroupName([])).toBe('GROUP1');
  });
  it('skips already-taken numeric slots', () => {
    expect(nextGroupName(['GROUP1', 'GROUP2'])).toBe('GROUP3');
  });
  it('fills the lowest available slot', () => {
    expect(nextGroupName(['GROUP1', 'GROUP3'])).toBe('GROUP2');
  });
  it('ignores non-matching names', () => {
    expect(nextGroupName(['Pad chain', 'My Drums'])).toBe('GROUP1');
  });
  it('ignores non-matching names while still skipping GROUP<N> ones', () => {
    expect(nextGroupName(['Pad chain', 'GROUP1', 'My Drums'])).toBe('GROUP2');
  });
});

describe('planDefaultGroupNames', () => {
  it('assigns names to every legacy/missing group in id order', () => {
    const nodes = {
      'group-c': group('group-c'),
      'group-a': group('group-a', LEGACY_GROUP_PLACEHOLDER),
      'group-b': group('group-b'),
    };
    const plan = planDefaultGroupNames(nodes);
    expect(plan).toEqual([
      { groupId: 'group-a', name: 'GROUP1' },
      { groupId: 'group-b', name: 'GROUP2' },
      { groupId: 'group-c', name: 'GROUP3' },
    ]);
  });

  it('preserves user-chosen names and skips them in the numeric search', () => {
    const nodes = {
      'group-a': group('group-a', 'Pad chain'),
      'group-b': group('group-b'),
    };
    const plan = planDefaultGroupNames(nodes);
    expect(plan).toEqual([{ groupId: 'group-b', name: 'GROUP1' }]);
  });

  it('does not collide with an already-set GROUP<N> name', () => {
    const nodes = {
      'group-a': group('group-a', 'GROUP1'),
      'group-b': group('group-b'),
    };
    const plan = planDefaultGroupNames(nodes);
    expect(plan).toEqual([{ groupId: 'group-b', name: 'GROUP2' }]);
  });

  it('returns an empty plan when every group already has a real name', () => {
    const nodes = {
      'group-a': group('group-a', 'Pad chain'),
      'group-b': group('group-b', 'My Drums'),
    };
    expect(planDefaultGroupNames(nodes)).toEqual([]);
  });

  it('ignores non-group nodes', () => {
    const nodes = {
      'lfo-1': nonGroup('lfo-1'),
      'group-a': group('group-a'),
    };
    expect(planDefaultGroupNames(nodes)).toEqual([
      { groupId: 'group-a', name: 'GROUP1' },
    ]);
  });

  it('is deterministic across peers (id sort)', () => {
    // Insertion order shouldn't matter — two peers may iterate the doc
    // in different orders but the id sort makes the assignments identical.
    const a = {
      'group-z': group('group-z'),
      'group-a': group('group-a'),
    };
    const b = {
      'group-a': group('group-a'),
      'group-z': group('group-z'),
    };
    expect(planDefaultGroupNames(a)).toEqual(planDefaultGroupNames(b));
  });
});

describe('nextGroupNameForNewGroup', () => {
  it('returns GROUP1 when no groups exist', () => {
    expect(nextGroupNameForNewGroup({})).toBe('GROUP1');
  });
  it('skips groups by their current label', () => {
    const nodes = {
      'group-a': group('group-a', 'GROUP1'),
      'group-b': group('group-b', 'Pad chain'),
    };
    expect(nextGroupNameForNewGroup(nodes)).toBe('GROUP2');
  });
  it('treats legacy placeholders as nameless', () => {
    const nodes = {
      'group-a': group('group-a', LEGACY_GROUP_PLACEHOLDER),
    };
    // Legacy placeholder shouldn't consume the GROUP1 slot — that slot
    // belongs to whichever group ends up holding it after migration.
    expect(nextGroupNameForNewGroup(nodes)).toBe('GROUP1');
  });
});
