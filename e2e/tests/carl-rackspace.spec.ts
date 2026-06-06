// e2e/tests/carl-rackspace.spec.ts
//
// @collab tests for Rackspace Carl — approach B (Leader-Elected).
//
// Covers:
//   (a) Spawn writes a session record (active=true) visible to peers
//   (b) Only one Carl can be active at a time (exclusivity)
//   (c) Any participant can 86 — eviction clears session + carl-* nodes
//   (d) Leader election: lowest awareness clientId among candidates wins
//   (e) Leader migration: when current leader withdraws, the next-lowest
//       takes over.
//
// Run only these tests:
//   flox activate -- task e2e -- --grep "@collab carl"

import { test, expect } from '@playwright/test';
import {
  openCarlContexts,
  attemptSpawn,
  readSession,
  clearSession,
  startLoop,
  stopLoop,
  evictPatch,
  countCarlNodes,
  publishCandidacy,
  withdrawCandidacy,
  readLeader,
} from './carl-rackspace.helpers';

test.describe('@collab carl leader-elected', () => {
  test('spawn writes an active session record visible to all peers within 2s', async ({
    browser,
  }) => {
    const s = await openCarlContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      expect(await readSession(a)).toBeNull();
      expect(await readSession(b)).toBeNull();
      const ok = await attemptSpawn(a, 'user-a', 'Alice');
      expect(ok).toBe(true);
      await expect
        .poll(async () => (await readSession(b))?.ownerUserId, { timeout: 2000 })
        .toBe('user-a');
      const seen = await readSession(b);
      expect(seen?.ownerDisplayName).toBe('Alice');
      expect(seen?.active).toBe(true);
    } finally {
      await s.close();
    }
  });

  test('exclusivity: a second spawn while a session is active is refused', async ({
    browser,
  }) => {
    const s = await openCarlContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      await attemptSpawn(a, 'user-a', 'Alice');
      await expect
        .poll(async () => (await readSession(b))?.ownerUserId, { timeout: 2000 })
        .toBe('user-a');
      const okB = await attemptSpawn(b, 'user-b', 'Bob');
      expect(okB).toBe(false);
      expect((await readSession(b))?.ownerUserId).toBe('user-a');
    } finally {
      await s.close();
    }
  });

  test('any participant can 86 — eviction propagates', async ({ browser }) => {
    const s = await openCarlContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      await attemptSpawn(a, 'user-a', 'Alice');
      await startLoop(a, { seed: 7, baseTickMs: 50 });
      await expect
        .poll(() => countCarlNodes(a), { timeout: 4000 })
        .toBeGreaterThan(0);
      await stopLoop(a);
      // B (not the spawner) does the eviction. Approach B's UX rule:
      // anyone in the rack can 86.
      await clearSession(b);
      await evictPatch(b);
      // A sees the session cleared.
      await expect
        .poll(async () => await readSession(a), { timeout: 2000 })
        .toBeNull();
    } finally {
      await s.close();
    }
  });

  test('leader election: lowest clientID among candidates wins', async ({
    browser,
  }) => {
    const s = await openCarlContexts(browser, 3);
    try {
      const [a, b, c] = s.pages;
      // Read all clientIDs.
      const ids = await Promise.all(
        s.pages.map((p) =>
          p.evaluate(() => {
            const w = window as unknown as { __getLocalClientId: () => number };
            return w.__getLocalClientId();
          }),
        ),
      );
      // All three publish candidacy.
      await Promise.all([publishCandidacy(a), publishCandidacy(b), publishCandidacy(c)]);
      // Each page agrees on the leader within 1s.
      await expect
        .poll(async () => (await readLeader(a))?.leaderClientId, { timeout: 1500 })
        .toBe(Math.min(...ids));
      await expect
        .poll(async () => (await readLeader(b))?.leaderClientId, { timeout: 1500 })
        .toBe(Math.min(...ids));
      await expect
        .poll(async () => (await readLeader(c))?.leaderClientId, { timeout: 1500 })
        .toBe(Math.min(...ids));
    } finally {
      await s.close();
    }
  });

  test('leader migration: withdrawing the current leader passes leadership to next', async ({
    browser,
  }) => {
    const s = await openCarlContexts(browser, 3);
    try {
      const ids = await Promise.all(
        s.pages.map((p) =>
          p.evaluate(() => {
            const w = window as unknown as { __getLocalClientId: () => number };
            return w.__getLocalClientId();
          }),
        ),
      );
      const sorted = [...ids].sort((a, b) => a - b);
      const lowestIdx = ids.indexOf(sorted[0]!);
      const secondIdx = ids.indexOf(sorted[1]!);
      // All three publish; the lowest is leader.
      await Promise.all(s.pages.map((p) => publishCandidacy(p)));
      await expect
        .poll(async () => (await readLeader(s.pages[secondIdx]!))?.leaderClientId, {
          timeout: 1500,
        })
        .toBe(sorted[0]);
      // The current leader withdraws — leadership migrates to second.
      await withdrawCandidacy(s.pages[lowestIdx]!);
      await expect
        .poll(async () => (await readLeader(s.pages[secondIdx]!))?.leaderClientId, {
          timeout: 2000,
        })
        .toBe(sorted[1]);
    } finally {
      await s.close();
    }
  });

  test('tick loop in the leader tab grows the patch (peers observe new nodes)', async ({
    browser,
  }) => {
    const s = await openCarlContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      await attemptSpawn(a, 'user-a', 'Alice');
      await startLoop(a, { seed: 13, baseTickMs: 50 });
      await expect
        .poll(() => countCarlNodes(b), { timeout: 5000 })
        .toBeGreaterThan(0);
      await stopLoop(a);
    } finally {
      await s.close();
    }
  });
});
