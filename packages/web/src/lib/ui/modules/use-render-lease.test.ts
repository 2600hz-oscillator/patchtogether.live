// Unit tests for the presenting-mode render-lease core (use-render-lease).
//
// The $effect shell is one line and is exercised end-to-end by the pull-eval
// e2e (a presenting backdraft scrolled off-screen must keep drawing); these
// pin the DECISION + acquisition logic with fakes — filename is `.test.ts`
// (not `.svelte.test.ts`) so the svelte loader doesn't compile it as runes,
// importing the runes module's pure export only.

import { describe, it, expect } from 'vitest';
import { acquireLeaseIfPresenting, type LeaseEngineLike } from './use-render-lease.svelte';

function fakeEngine(video: unknown): LeaseEngineLike {
  return {
    getDomain: <T,>(d: string): T => {
      if (d !== 'video') throw new Error('unexpected domain ' + d);
      if (video instanceof Error) throw video;
      return video as T;
    },
  };
}

function fakeVideoEngine() {
  const leases: string[] = [];
  const releases: string[] = [];
  return {
    leases,
    releases,
    acquireRenderLease(nodeId: string): () => void {
      leases.push(nodeId);
      return () => releases.push(nodeId);
    },
  };
}

describe('acquireLeaseIfPresenting', () => {
  it('acquires the lease on the node while presenting, and the return releases it', () => {
    const ve = fakeVideoEngine();
    const release = acquireLeaseIfPresenting({
      engine: () => fakeEngine(ve),
      nodeId: () => 'bd1',
      presenting: () => true,
    });
    expect(ve.leases).toEqual(['bd1']);
    expect(release).toBeTypeOf('function');
    release!();
    expect(ve.releases).toEqual(['bd1']);
  });

  it('NOT presenting → no lease, no engine touch', () => {
    const ve = fakeVideoEngine();
    let engineReads = 0;
    const release = acquireLeaseIfPresenting({
      engine: () => { engineReads++; return fakeEngine(ve); },
      nodeId: () => 'bd1',
      presenting: () => false,
    });
    expect(release).toBeNull();
    expect(ve.leases).toEqual([]);
    // The engine getter IS still read (so the $effect tracks a late boot),
    // but no lease is taken.
    expect(engineReads).toBe(1);
  });

  it('no engine yet (pre-boot) → null, no throw', () => {
    expect(
      acquireLeaseIfPresenting({ engine: () => null, nodeId: () => 'x', presenting: () => true }),
    ).toBeNull();
  });

  it('video domain not registered (getDomain throws) → null, no throw', () => {
    expect(
      acquireLeaseIfPresenting({
        engine: () => fakeEngine(new Error('no video domain')),
        nodeId: () => 'x',
        presenting: () => true,
      }),
    ).toBeNull();
  });

  it('domain object without acquireRenderLease → null (defensive)', () => {
    expect(
      acquireLeaseIfPresenting({
        engine: () => fakeEngine({}),
        nodeId: () => 'x',
        presenting: () => true,
      }),
    ).toBeNull();
  });
});
