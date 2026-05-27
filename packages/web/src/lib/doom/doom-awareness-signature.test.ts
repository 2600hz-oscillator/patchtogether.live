// packages/web/src/lib/doom/doom-awareness-signature.test.ts
//
// The storm-throttle invariant that fixes the DOOM multiplayer active-play
// hang: a per-tic ticcmd (or relay / signaling / gamestart / key / cursor)
// awareness update must NOT change the election signature, so the expensive
// recompute is skipped — while a real membership / ownership / host-claim /
// join-request / displayName change MUST change it.

import { describe, it, expect } from 'vitest';
import {
  electionAwarenessSignature,
  hostClaimField,
  joinReqField,
  type AwarenessStates,
} from './doom-awareness-signature';

const MID = 'doom-1';

/** Build an awareness states map from per-client partial records. */
function states(
  ...entries: Array<[number, Record<string, unknown> | undefined]>
): AwarenessStates {
  return new Map(entries);
}

function client(opts: {
  uid?: string;
  isRackOwner?: boolean;
  displayName?: string;
  hostClaim?: string;
  joinReq?: string;
  ticcmd?: unknown;
  relay?: unknown;
  signal?: unknown;
  key?: unknown;
  cursor?: unknown;
}): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (opts.uid !== undefined || opts.isRackOwner !== undefined || opts.displayName !== undefined) {
    s.user = {
      ...(opts.uid !== undefined ? { id: opts.uid } : {}),
      ...(opts.isRackOwner !== undefined ? { isRackOwner: opts.isRackOwner } : {}),
      ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
    };
  }
  if (opts.hostClaim !== undefined) s[hostClaimField(MID)] = opts.hostClaim;
  if (opts.joinReq !== undefined) s[joinReqField(MID)] = opts.joinReq;
  // High-frequency fields the signature MUST ignore:
  if (opts.ticcmd !== undefined) s[`doom-net:${MID}:ticcmd`] = opts.ticcmd;
  if (opts.relay !== undefined) s[`doom-net:${MID}:to:0`] = opts.relay;
  if (opts.signal !== undefined) s[`doom-net:${MID}:signal`] = opts.signal;
  if (opts.key !== undefined) s[`doom:${MID}:key`] = opts.key;
  if (opts.cursor !== undefined) s.cursor = opts.cursor;
  return s;
}

describe('electionAwarenessSignature', () => {
  it('is STABLE across a per-tic ticcmd change (the storm-throttle invariant)', () => {
    const a = states([1, client({ uid: 'alice', isRackOwner: true, ticcmd: { seq: 1, forwardmove: 0 } })]);
    const b = states([1, client({ uid: 'alice', isRackOwner: true, ticcmd: { seq: 999, forwardmove: 50 } })]);
    expect(electionAwarenessSignature(a, MID)).toBe(electionAwarenessSignature(b, MID));
  });

  it('ignores relay / signaling / key / cursor churn', () => {
    const base = states([1, client({ uid: 'alice', isRackOwner: true })]);
    const noisy = states([
      1,
      client({
        uid: 'alice',
        isRackOwner: true,
        relay: { seq: 7, bytesB64: 'AAAA' },
        signal: { kind: 'ice', seq: 3 },
        key: { doomKey: 30, pressed: true, ts: Date.now() },
        cursor: { x: 123, y: 456 },
      }),
    ]);
    expect(electionAwarenessSignature(base, MID)).toBe(electionAwarenessSignature(noisy, MID));
  });

  it('CHANGES when a new member joins', () => {
    const before = states([1, client({ uid: 'alice', isRackOwner: true })]);
    const after = states(
      [1, client({ uid: 'alice', isRackOwner: true })],
      [2, client({ uid: 'bob', isRackOwner: false })],
    );
    expect(electionAwarenessSignature(before, MID)).not.toBe(electionAwarenessSignature(after, MID));
  });

  it('CHANGES when a member leaves', () => {
    const before = states(
      [1, client({ uid: 'alice', isRackOwner: true })],
      [2, client({ uid: 'bob' })],
    );
    const after = states([1, client({ uid: 'alice', isRackOwner: true })]);
    expect(electionAwarenessSignature(before, MID)).not.toBe(electionAwarenessSignature(after, MID));
  });

  it('CHANGES when ownership flips', () => {
    const before = states([1, client({ uid: 'alice', isRackOwner: false })]);
    const after = states([1, client({ uid: 'alice', isRackOwner: true })]);
    expect(electionAwarenessSignature(before, MID)).not.toBe(electionAwarenessSignature(after, MID));
  });

  it('CHANGES when the host-claim field changes', () => {
    const before = states([1, client({ uid: 'alice', hostClaim: 'alice' })]);
    const after = states([1, client({ uid: 'alice', hostClaim: 'bob' })]);
    expect(electionAwarenessSignature(before, MID)).not.toBe(electionAwarenessSignature(after, MID));
  });

  it('CHANGES when a join-request appears', () => {
    const before = states([2, client({ uid: 'bob' })]);
    const after = states([2, client({ uid: 'bob', joinReq: 'bob' })]);
    expect(electionAwarenessSignature(before, MID)).not.toBe(electionAwarenessSignature(after, MID));
  });

  it('CHANGES when a displayName arrives (identity refresh)', () => {
    const before = states([2, client({ uid: 'bob' })]);
    const after = states([2, client({ uid: 'bob', displayName: 'Bob the Slayer' })]);
    expect(electionAwarenessSignature(before, MID)).not.toBe(electionAwarenessSignature(after, MID));
  });

  it('is order-independent over client iteration (deterministic across peers)', () => {
    const order1 = states(
      [1, client({ uid: 'alice', isRackOwner: true })],
      [2, client({ uid: 'bob' })],
    );
    const order2 = states(
      [2, client({ uid: 'bob' })],
      [1, client({ uid: 'alice', isRackOwner: true })],
    );
    expect(electionAwarenessSignature(order1, MID)).toBe(electionAwarenessSignature(order2, MID));
  });

  it('namespaces by moduleId — another DOOM card\'s fields do not leak', () => {
    // A host-claim for a DIFFERENT module must not change THIS module's sig.
    const s = client({ uid: 'alice' });
    s['doom:other-module:host'] = 'alice';
    s['doom:other-module:join-req'] = 'alice';
    const withOther = states([1, s]);
    const without = states([1, client({ uid: 'alice' })]);
    expect(electionAwarenessSignature(withOther, MID)).toBe(electionAwarenessSignature(without, MID));
  });

  it('skips phantom clients with no user id and none of our fields', () => {
    const a = states([1, client({ uid: 'alice', isRackOwner: true })]);
    const b = states(
      [1, client({ uid: 'alice', isRackOwner: true })],
      [99, { somethingUnrelated: true }],
    );
    expect(electionAwarenessSignature(a, MID)).toBe(electionAwarenessSignature(b, MID));
  });

  it('tolerates undefined / empty states', () => {
    expect(electionAwarenessSignature(states(), MID)).toBe('');
    expect(electionAwarenessSignature(states([1, undefined]), MID)).toBe('');
  });
});
