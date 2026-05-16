// packages/web/src/lib/multiplayer/samsloop-limits.test.ts
//
// Pure unit tests for the SAMSLOOP cap helpers. The integration with
// Canvas.svelte's spawn handler is covered by e2e/tests/samsloop.spec.ts.

import { describe, expect, it } from 'vitest';
import {
  SAMSLOOP_LIMITS,
  SAMSLOOP_LIMIT_MESSAGE,
  countSamsloopsByCreator,
  countSamsloopsTotal,
  samsloopSpawnDecision,
} from './samsloop-limits';

type Node = { type: string; data?: { creatorId?: string } };

function build(nodes: Record<string, Node>): Record<string, Node> {
  return nodes;
}

describe('samsloop-limits — exported constants', () => {
  it('exposes documented per-user (5) and per-rackspace (20) caps', () => {
    // The cap values are load-bearing — they're derived from the bench
    // documented in samsloop-limits.ts. If you change them, update the
    // comment block AND re-run the bench so the math stays honest.
    expect(SAMSLOOP_LIMITS.perUser).toBe(5);
    expect(SAMSLOOP_LIMITS.perRackspace).toBe(20);
  });

  it('per-user cap is floor(perRackspace / 4) per the multiuser constraint', () => {
    expect(SAMSLOOP_LIMITS.perUser).toBe(
      Math.floor(SAMSLOOP_LIMITS.perRackspace / 4),
    );
  });

  it('limit message matches the exact brief-mandated text', () => {
    // Tests assert against this exact string elsewhere; keep in sync.
    expect(SAMSLOOP_LIMIT_MESSAGE).toBe('sorry, SAMSLOOP limit exceeded');
  });
});

describe('samsloop-limits — count helpers', () => {
  it('countSamsloopsTotal counts only samsloop nodes', () => {
    const nodes = build({
      a: { type: 'samsloop', data: { creatorId: 'u1' } },
      b: { type: 'analogVco' },
      c: { type: 'samsloop', data: { creatorId: 'u2' } },
      d: { type: 'picturebox' },
      e: { type: 'samsloop' },
    });
    expect(countSamsloopsTotal(nodes)).toBe(3);
  });

  it('countSamsloopsByCreator only counts attributed nodes', () => {
    const nodes = build({
      a: { type: 'samsloop', data: { creatorId: 'u1' } },
      b: { type: 'samsloop', data: { creatorId: 'u1' } },
      c: { type: 'samsloop', data: { creatorId: 'u2' } },
      d: { type: 'samsloop' }, // legacy / unattributed
      e: { type: 'analogVco', data: { creatorId: 'u1' } }, // wrong type
    });
    expect(countSamsloopsByCreator(nodes, 'u1')).toBe(2);
    expect(countSamsloopsByCreator(nodes, 'u2')).toBe(1);
    expect(countSamsloopsByCreator(nodes, 'u-nobody')).toBe(0);
  });

  it('countSamsloopsByCreator returns 0 on null/undefined userId', () => {
    const nodes = build({
      a: { type: 'samsloop', data: { creatorId: 'u1' } },
    });
    expect(countSamsloopsByCreator(nodes, null)).toBe(0);
    expect(countSamsloopsByCreator(nodes, undefined)).toBe(0);
  });

  it('count helpers tolerate null entries in the node map', () => {
    const nodes: Record<string, Node | undefined> = {
      a: { type: 'samsloop', data: { creatorId: 'u1' } },
      b: undefined,
      c: { type: 'samsloop' },
    };
    expect(countSamsloopsTotal(nodes)).toBe(2);
    expect(countSamsloopsByCreator(nodes, 'u1')).toBe(1);
  });
});

describe('samsloop-limits — spawn decision', () => {
  it('ok when both caps have headroom', () => {
    const nodes = build({
      a: { type: 'samsloop', data: { creatorId: 'u1' } },
    });
    expect(samsloopSpawnDecision(nodes, 'u1')).toEqual({ ok: true });
    expect(samsloopSpawnDecision(nodes, 'u2')).toEqual({ ok: true });
  });

  it(`denies at per-user cap (${SAMSLOOP_LIMITS.perUser})`, () => {
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < SAMSLOOP_LIMITS.perUser; i++) {
      nodes[`s-${i}`] = { type: 'samsloop', data: { creatorId: 'u1' } };
    }
    const d = samsloopSpawnDecision(nodes, 'u1');
    expect(d.ok).toBe(false);
    if (d.ok === false) {
      expect(d.reason).toBe('per-user-cap');
      expect(d.cap).toBe(SAMSLOOP_LIMITS.perUser);
      expect(d.current).toBe(SAMSLOOP_LIMITS.perUser);
    }
  });

  it(`denies at rackspace cap (${SAMSLOOP_LIMITS.perRackspace})`, () => {
    // Fill the rackspace with unattributed nodes; a fresh user tries to
    // spawn — per-user cap empty, rackspace cap full.
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < SAMSLOOP_LIMITS.perRackspace; i++) {
      nodes[`s-${i}`] = { type: 'samsloop' };
    }
    const d = samsloopSpawnDecision(nodes, 'u-fresh');
    expect(d.ok).toBe(false);
    if (d.ok === false) {
      expect(d.reason).toBe('rackspace-cap');
      expect(d.cap).toBe(SAMSLOOP_LIMITS.perRackspace);
      expect(d.current).toBe(SAMSLOOP_LIMITS.perRackspace);
    }
  });

  it('per-user cap takes precedence over rackspace cap', () => {
    // Edge case: u1 has exactly perUser samsloops and others fill the
    // remainder of the rackspace. u1 should hit per-user-cap, not the
    // rackspace cap (more actionable).
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < SAMSLOOP_LIMITS.perUser; i++) {
      nodes[`u1-${i}`] = { type: 'samsloop', data: { creatorId: 'u1' } };
    }
    const remaining = SAMSLOOP_LIMITS.perRackspace - SAMSLOOP_LIMITS.perUser;
    for (let i = 0; i < remaining; i++) {
      nodes[`other-${i}`] = { type: 'samsloop', data: { creatorId: 'u2' } };
    }
    const d = samsloopSpawnDecision(nodes, 'u1');
    expect(d.ok).toBe(false);
    if (d.ok === false) {
      expect(d.reason).toBe('per-user-cap');
    }
  });

  it('removing an instance restores capacity (cap-counter invariant)', () => {
    // The spawn decision is computed from the live node map each call,
    // so deleting a node from the map immediately frees a cap slot.
    // The test exercises the integration shape: walk up to the cap,
    // delete one, retry — should be ok again.
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < SAMSLOOP_LIMITS.perUser; i++) {
      nodes[`s-${i}`] = { type: 'samsloop', data: { creatorId: 'u1' } };
    }
    expect(samsloopSpawnDecision(nodes, 'u1').ok).toBe(false);
    delete nodes['s-0'];
    expect(samsloopSpawnDecision(nodes, 'u1')).toEqual({ ok: true });
  });

  it('single-user mode (null userId) only enforces rackspace cap', () => {
    // Solo creator can fill the whole rackspace; the per-user cap is
    // skipped so a single user isn't penalized for collaborator math.
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < SAMSLOOP_LIMITS.perUser + 1; i++) {
      nodes[`s-${i}`] = { type: 'samsloop' };
    }
    // perUser + 1 nodes, all unattributed. null userId skips per-user
    // check, rackspace still has headroom.
    expect(samsloopSpawnDecision(nodes, null)).toEqual({ ok: true });
    // Fill to rackspace cap; null userId still hits the rackspace cap.
    for (let i = SAMSLOOP_LIMITS.perUser + 1; i < SAMSLOOP_LIMITS.perRackspace; i++) {
      nodes[`s-${i}`] = { type: 'samsloop' };
    }
    const d = samsloopSpawnDecision(nodes, null);
    expect(d.ok).toBe(false);
    if (d.ok === false) expect(d.reason).toBe('rackspace-cap');
  });

  it('grandfathered (unattributed) nodes count toward rackspace, not per-user', () => {
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < SAMSLOOP_LIMITS.perRackspace - 1; i++) {
      nodes[`legacy-${i}`] = { type: 'samsloop' };
    }
    // u1 has zero attributed nodes — per-user cap not hit, rackspace
    // cap has 1 slot left.
    const d = samsloopSpawnDecision(nodes, 'u1');
    expect(d.ok).toBe(true);
  });
});
