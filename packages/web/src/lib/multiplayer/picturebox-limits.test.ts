// packages/web/src/lib/multiplayer/picturebox-limits.test.ts
//
// Pure unit tests for the count helpers + spawn decision logic. The
// integration with Canvas.svelte's spawn handler is covered by the
// e2e/picturebox-limits.spec.ts.

import { describe, expect, it } from 'vitest';
import {
  PICTUREBOX_LIMITS,
  countPictureboxesByCreator,
  countPictureboxesTotal,
  pictureboxSpawnDecision,
  explainSpawnDenial,
} from './picturebox-limits';

type Node = { type: string; data?: { creatorId?: string } };

function build(nodes: Record<string, Node>): Record<string, Node> {
  return nodes;
}

describe('picturebox-limits — count helpers', () => {
  it('countPictureboxesTotal counts only picturebox nodes', () => {
    const nodes = build({
      a: { type: 'picturebox', data: { creatorId: 'u1' } },
      b: { type: 'analogVco' },
      c: { type: 'picturebox', data: { creatorId: 'u2' } },
      d: { type: 'lines' },
      e: { type: 'picturebox' },
    });
    expect(countPictureboxesTotal(nodes)).toBe(3);
  });

  it('countPictureboxesByCreator only counts attributed nodes', () => {
    const nodes = build({
      a: { type: 'picturebox', data: { creatorId: 'u1' } },
      b: { type: 'picturebox', data: { creatorId: 'u1' } },
      c: { type: 'picturebox', data: { creatorId: 'u2' } },
      d: { type: 'picturebox' }, // legacy / unattributed
      e: { type: 'analogVco', data: { creatorId: 'u1' } }, // wrong type
    });
    expect(countPictureboxesByCreator(nodes, 'u1')).toBe(2);
    expect(countPictureboxesByCreator(nodes, 'u2')).toBe(1);
    expect(countPictureboxesByCreator(nodes, 'u-nobody')).toBe(0);
  });

  it('countPictureboxesByCreator returns 0 on null/undefined userId', () => {
    const nodes = build({
      a: { type: 'picturebox', data: { creatorId: 'u1' } },
    });
    expect(countPictureboxesByCreator(nodes, null)).toBe(0);
    expect(countPictureboxesByCreator(nodes, undefined)).toBe(0);
  });

  it('count helpers tolerate null entries in the node map', () => {
    // Mid-delete the syncedstore proxy can briefly expose undefined
    // entries — defensive against that race.
    const nodes: Record<string, Node | undefined> = {
      a: { type: 'picturebox', data: { creatorId: 'u1' } },
      b: undefined,
      c: { type: 'picturebox' },
    };
    expect(countPictureboxesTotal(nodes)).toBe(2);
    expect(countPictureboxesByCreator(nodes, 'u1')).toBe(1);
  });
});

describe('picturebox-limits — spawn decision', () => {
  it('ok when both caps have headroom', () => {
    const nodes = build({
      a: { type: 'picturebox', data: { creatorId: 'u1' } },
    });
    expect(pictureboxSpawnDecision(nodes, 'u1')).toEqual({ ok: true });
    expect(pictureboxSpawnDecision(nodes, 'u2')).toEqual({ ok: true });
  });

  it('denies at per-user cap (2)', () => {
    const nodes = build({
      a: { type: 'picturebox', data: { creatorId: 'u1' } },
      b: { type: 'picturebox', data: { creatorId: 'u1' } },
    });
    const d = pictureboxSpawnDecision(nodes, 'u1');
    expect(d.ok).toBe(false);
    if (d.ok === false) {
      expect(d.reason).toBe('per-user-cap');
      expect(d.cap).toBe(2);
      expect(d.current).toBe(2);
    }
  });

  it('denies at per-workspace cap (8)', () => {
    // Eight unattributed pictureboxes — different user tries to spawn.
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < 8; i++) nodes[`p-${i}`] = { type: 'picturebox' };
    const d = pictureboxSpawnDecision(nodes, 'u-fresh');
    expect(d.ok).toBe(false);
    if (d.ok === false) {
      expect(d.reason).toBe('workspace-cap');
      expect(d.cap).toBe(8);
      expect(d.current).toBe(8);
    }
  });

  it('per-user cap takes precedence over workspace cap', () => {
    // Edge case: u1 has 2 picture boxes and 6 unattributed exist.
    // u1 should hit per-user-cap, not workspace-cap (more actionable).
    const nodes: Record<string, Node> = {
      'u1-a': { type: 'picturebox', data: { creatorId: 'u1' } },
      'u1-b': { type: 'picturebox', data: { creatorId: 'u1' } },
    };
    for (let i = 0; i < 6; i++) nodes[`p-${i}`] = { type: 'picturebox' };
    // Total is 8 — at workspace cap too.
    const d = pictureboxSpawnDecision(nodes, 'u1');
    expect(d.ok).toBe(false);
    if (d.ok === false) {
      expect(d.reason).toBe('per-user-cap');
    }
  });

  it('grandfathered (unattributed) nodes count toward workspace, not per-user', () => {
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < 7; i++) nodes[`legacy-${i}`] = { type: 'picturebox' };
    // u1 has zero attributed nodes — per-user cap not hit, workspace
    // cap has 1 slot left.
    const d = pictureboxSpawnDecision(nodes, 'u1');
    expect(d.ok).toBe(true);
  });
});

describe('picturebox-limits — explainSpawnDenial', () => {
  it('renders user-friendly per-user message', () => {
    const msg = explainSpawnDenial({
      ok: false,
      reason: 'per-user-cap',
      cap: 2,
      current: 2,
    });
    expect(msg).toContain('per user');
    expect(msg).toContain('2/2');
  });

  it('renders user-friendly workspace message', () => {
    const msg = explainSpawnDenial({
      ok: false,
      reason: 'workspace-cap',
      cap: 8,
      current: 8,
    });
    expect(msg).toContain('per rack');
    expect(msg).toContain('8/8');
  });

  it('returns empty string for ok decisions', () => {
    expect(explainSpawnDenial({ ok: true })).toBe('');
  });
});

describe('picturebox-limits — exported constants', () => {
  it('matches the spec (2 per user, 8 per workspace)', () => {
    expect(PICTUREBOX_LIMITS.perUser).toBe(2);
    expect(PICTUREBOX_LIMITS.perWorkspace).toBe(8);
  });
});
