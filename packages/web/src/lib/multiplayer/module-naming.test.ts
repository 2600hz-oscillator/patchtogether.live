// Unit tests for the auto-naming + uniqueness helpers.

import { describe, it, expect } from 'vitest';
import type { ModuleNode } from '$lib/graph/types';
import {
  nextDefaultName,
  validateRename,
  findNodeByName,
  migrateAssignNames,
  readName,
  resolveDisplayName,
} from './module-naming';

function n(id: string, type: string, name?: string): ModuleNode {
  return {
    id,
    type,
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: name ? { name } : undefined,
  };
}

describe('module-naming.nextDefaultName', () => {
  it('returns <TYPE>1 when no instances exist', () => {
    expect(nextDefaultName({}, 'analogVco')).toBe('ANALOGVCO1');
  });

  it('continues the sequence for existing instances', () => {
    const nodes = {
      a: n('a', 'analogVco', 'ANALOGVCO1'),
      b: n('b', 'analogVco', 'ANALOGVCO2'),
    };
    expect(nextDefaultName(nodes, 'analogVco')).toBe('ANALOGVCO3');
  });

  it('does NOT fill gaps (retired numbers stay retired)', () => {
    // ANALOGVCO2 was deleted; the new spawn must NOT reuse 2 because a
    // stale DSL script could silently retarget the wrong instance.
    const nodes = {
      a: n('a', 'analogVco', 'ANALOGVCO1'),
      c: n('c', 'analogVco', 'ANALOGVCO3'),
    };
    expect(nextDefaultName(nodes, 'analogVco')).toBe('ANALOGVCO4');
  });

  it('ignores names that do not match the prefix pattern', () => {
    const nodes = {
      a: n('a', 'analogVco', 'MYBASS'),
      b: n('b', 'analogVco', 'KICKVCO'),
    };
    expect(nextDefaultName(nodes, 'analogVco')).toBe('ANALOGVCO1');
  });

  it('handles types with mixed case correctly', () => {
    const nodes = {
      a: n('a', 'wavetableVco', 'WAVETABLEVCO5'),
    };
    expect(nextDefaultName(nodes, 'wavetableVco')).toBe('WAVETABLEVCO6');
  });
});

describe('module-naming.validateRename', () => {
  const nodes = {
    a: n('a', 'analogVco', 'ANALOGVCO1'),
    b: n('b', 'analogVco', 'BASS'),
  };

  it('accepts a fresh, valid name', () => {
    const r = validateRename(nodes, 'a', 'LEAD');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('LEAD');
  });

  it('trims surrounding whitespace', () => {
    const r = validateRename(nodes, 'a', '  LEAD  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('LEAD');
  });

  it('rejects empty', () => {
    const r = validateRename(nodes, 'a', '   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  it('rejects internal whitespace', () => {
    const r = validateRename(nodes, 'a', 'MY VCO');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/space/i);
  });

  it('rejects names that start with a digit', () => {
    const r = validateRename(nodes, 'a', '123VCO');
    expect(r.ok).toBe(false);
  });

  it('rejects punctuation', () => {
    const r = validateRename(nodes, 'a', 'MY-VCO');
    expect(r.ok).toBe(false);
  });

  it('rejects too-long names', () => {
    const r = validateRename(nodes, 'a', 'A'.repeat(33));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceed/);
  });

  it('rejects a name that another node already owns', () => {
    const r = validateRename(nodes, 'a', 'BASS');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already in use/);
  });

  it('uniqueness is case-insensitive', () => {
    const r = validateRename(nodes, 'a', 'bass');
    expect(r.ok).toBe(false);
  });

  it('accepts a no-op rename to the same node\'s current name', () => {
    const r = validateRename(nodes, 'a', 'ANALOGVCO1');
    expect(r.ok).toBe(true);
  });
});

describe('module-naming.findNodeByName', () => {
  const nodes = {
    a: n('a', 'analogVco', 'BASS'),
    b: n('b', 'analogVco', 'LEAD'),
  };

  it('finds a node by exact name', () => {
    expect(findNodeByName(nodes, 'BASS')?.id).toBe('a');
  });

  it('finds case-insensitively', () => {
    expect(findNodeByName(nodes, 'bass')?.id).toBe('a');
    expect(findNodeByName(nodes, 'Lead')?.id).toBe('b');
  });

  it('returns undefined when no match', () => {
    expect(findNodeByName(nodes, 'nope')).toBeUndefined();
  });
});

describe('module-naming.migrateAssignNames', () => {
  it('assigns names to every unnamed node', () => {
    const nodes: Record<string, ModuleNode> = {
      a: n('a', 'analogVco'),
      b: n('b', 'analogVco'),
      c: n('c', 'audioOut'),
    };
    const count = migrateAssignNames(nodes);
    expect(count).toBe(3);
    expect(readName(nodes.a)).toBe('ANALOGVCO1');
    expect(readName(nodes.b)).toBe('ANALOGVCO2');
    expect(readName(nodes.c)).toBe('AUDIOOUT1');
  });

  it('leaves already-named nodes alone (idempotent)', () => {
    const nodes: Record<string, ModuleNode> = {
      a: n('a', 'analogVco', 'BASS'),
      b: n('b', 'analogVco'),
    };
    migrateAssignNames(nodes);
    expect(readName(nodes.a)).toBe('BASS');
    expect(readName(nodes.b)).toBe('ANALOGVCO1');
    // Second pass changes nothing.
    const count2 = migrateAssignNames(nodes);
    expect(count2).toBe(0);
  });

  it('orders by node id so two clients converge on the same names', () => {
    const nodes: Record<string, ModuleNode> = {
      'analogVco-zzz': n('analogVco-zzz', 'analogVco'),
      'analogVco-aaa': n('analogVco-aaa', 'analogVco'),
    };
    migrateAssignNames(nodes);
    expect(readName(nodes['analogVco-aaa'])).toBe('ANALOGVCO1');
    expect(readName(nodes['analogVco-zzz'])).toBe('ANALOGVCO2');
  });
});

// resolveDisplayName backs the in-card title bar (ModuleTitle.svelte /
// ModuleNameLabel.svelte) — the precedence here is the one the user sees
// after the per-card floating-overhead label was dropped.
describe('module-naming.resolveDisplayName', () => {
  it('returns node.data.name when set', () => {
    const node = n('a', 'analogVco', 'BASS');
    const nodes = { a: node };
    expect(resolveDisplayName(node, nodes, 'Analog VCO')).toBe('BASS');
  });

  it('falls back to defaultLabel when node.data.name is empty', () => {
    const node = n('a', 'analogVco'); // no .data.name
    const nodes = { a: node };
    expect(resolveDisplayName(node, nodes, 'Analog VCO')).toBe('Analog VCO');
  });

  it('falls back to the computed default when both name and defaultLabel are missing', () => {
    const node = n('a', 'analogVco');
    const nodes = { a: node };
    expect(resolveDisplayName(node, nodes)).toBe('ANALOGVCO1');
  });

  it('preserves a legitimate empty-edit-to-default round-trip', () => {
    // The card spec: "Empty input → clears `data.label`/`data.name` (falls
    // back to the default)". Once data.name is cleared, resolveDisplayName
    // returns the defaultLabel string the card supplied.
    const node = n('a', 'analogVco');
    delete node.data;
    expect(resolveDisplayName(node, { a: node }, 'WAVESCULPT')).toBe('WAVESCULPT');
  });

  it('does not consult defaultLabel when name is set, even if name is unusual', () => {
    const node = n('a', 'analogVco', 'lowercase_name_ok');
    expect(resolveDisplayName(node, { a: node }, 'IGNORED')).toBe('lowercase_name_ok');
  });
});
