// e2e/tests/mike-rackspace.spec.ts
//
// @collab tests for Meticulous Mike. Mirror of Carl's E2E suite, with
// added mutual-exclusion assertions: spawning Mike disables Carl's spawn
// (and vice-versa); 86ing the active bot re-enables the other's spawn.
//
// Run only these tests:
//   flox activate -- task e2e -- --grep "@collab mike"

import { test, expect } from '@playwright/test';
import {
  openCarlContexts as openContexts,
} from './carl-rackspace.helpers';
import type { Page } from '@playwright/test';

interface MikeSessionView {
  ownerUserId: string | null;
  ownerDisplayName: string;
  spawnedAt: number;
  seed: number;
  active?: boolean;
}

interface BotSessionView {
  kind: 'carl' | 'mike';
  ownerUserId: string | null;
  ownerDisplayName: string;
  spawnedAt: number;
  seed: number;
  active: boolean;
}

interface MikeLeaderInfoView {
  leaderClientId: number | null;
  isLocalLeader: boolean;
  candidates: number[];
}

async function mikeAttemptSpawn(page: Page, ownerUserId: string, displayName: string): Promise<boolean> {
  return await page.evaluate(
    ({ id, name }) => {
      const w = window as unknown as {
        __mikeAttemptSpawn: (id: string, name: string, seed?: number) => boolean;
      };
      return w.__mikeAttemptSpawn(id, name);
    },
    { id: ownerUserId, name: displayName },
  );
}

async function carlAttemptSpawn(page: Page, ownerUserId: string, displayName: string): Promise<boolean> {
  return await page.evaluate(
    ({ id, name }) => {
      const w = window as unknown as {
        __carlAttemptSpawn: (id: string, name: string, seed?: number) => boolean;
      };
      return w.__carlAttemptSpawn(id, name);
    },
    { id: ownerUserId, name: displayName },
  );
}

async function readMikeSession(page: Page): Promise<MikeSessionView | null> {
  return await page.evaluate(() => {
    const w = window as unknown as { __mikeReadSession: () => MikeSessionView | null };
    return w.__mikeReadSession();
  });
}

async function readBotSession(page: Page): Promise<BotSessionView | null> {
  return await page.evaluate(() => {
    const w = window as unknown as { __readBotSession: () => BotSessionView | null };
    return w.__readBotSession();
  });
}

async function mikeClearSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __mikeClearSession: () => void };
    w.__mikeClearSession();
  });
}

async function mikeStartLoop(
  page: Page,
  opts?: { seed?: number; baseTickMs?: number; maxTickMs?: number },
): Promise<boolean> {
  return await page.evaluate((o) => {
    const w = window as unknown as {
      __mikeStartLoop: (o?: { seed?: number; baseTickMs?: number; maxTickMs?: number }) => boolean;
    };
    return w.__mikeStartLoop(o);
  }, opts ?? {});
}

async function mikeStopLoop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __mikeStopLoop: () => void };
    w.__mikeStopLoop();
  });
}

async function mikeEvictPatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __mikeEvictPatch: () => void };
    w.__mikeEvictPatch();
  });
}

async function countMikeNodes(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { id: string } | undefined> };
    };
    return Object.values(w.__patch.nodes).filter(
      (n) => n && n.id.startsWith('mike-'),
    ).length;
  });
}

async function publishMikeCandidacy(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const w = window as unknown as { __mikePublishCandidacy?: () => boolean };
    return w.__mikePublishCandidacy ? w.__mikePublishCandidacy() : false;
  });
}

async function readMikeLeader(page: Page): Promise<MikeLeaderInfoView | null> {
  return await page.evaluate(() => {
    const w = window as unknown as { __mikeReadLeader?: () => MikeLeaderInfoView };
    return w.__mikeReadLeader ? w.__mikeReadLeader() : null;
  });
}

test.describe('@collab mike rackspace', () => {
  test('spawn writes an active Mike record visible to peers within 2s', async ({ browser }) => {
    const s = await openContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      expect(await readMikeSession(a)).toBeNull();
      expect(await readMikeSession(b)).toBeNull();
      const ok = await mikeAttemptSpawn(a, 'user-a', 'Alice');
      expect(ok).toBe(true);
      await expect
        .poll(async () => (await readMikeSession(b))?.ownerUserId, { timeout: 2000 })
        .toBe('user-a');
      const seen = await readMikeSession(b);
      expect(seen?.ownerDisplayName).toBe('Alice');
      expect(seen?.active).toBe(true);
    } finally {
      await s.close();
    }
  });

  test('mutual exclusion: Carl active → Mike spawn refused', async ({ browser }) => {
    const s = await openContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      const carlOk = await carlAttemptSpawn(a, 'user-a', 'Alice');
      expect(carlOk).toBe(true);
      await expect
        .poll(async () => (await readBotSession(b))?.kind, { timeout: 2000 })
        .toBe('carl');
      // Mike on B refuses because Carl already holds the bot lock.
      const mikeOk = await mikeAttemptSpawn(b, 'user-b', 'Bob');
      expect(mikeOk).toBe(false);
      expect((await readBotSession(b))?.kind).toBe('carl');
    } finally {
      await s.close();
    }
  });

  test('mutual exclusion: Mike active → Carl spawn refused', async ({ browser }) => {
    const s = await openContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      const mikeOk = await mikeAttemptSpawn(a, 'user-a', 'Alice');
      expect(mikeOk).toBe(true);
      await expect
        .poll(async () => (await readBotSession(b))?.kind, { timeout: 2000 })
        .toBe('mike');
      const carlOk = await carlAttemptSpawn(b, 'user-b', 'Bob');
      expect(carlOk).toBe(false);
      expect((await readBotSession(b))?.kind).toBe('mike');
    } finally {
      await s.close();
    }
  });

  test('86 Mike re-enables Carl spawn (lock released)', async ({ browser }) => {
    const s = await openContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      await mikeAttemptSpawn(a, 'user-a', 'Alice');
      await expect
        .poll(async () => (await readBotSession(b))?.kind, { timeout: 2000 })
        .toBe('mike');
      // B clears Mike's session — any peer can 86.
      await mikeClearSession(b);
      await expect
        .poll(async () => await readBotSession(a), { timeout: 2000 })
        .toBeNull();
      // Carl spawn now succeeds on A.
      const carlOk = await carlAttemptSpawn(a, 'user-a', 'Alice');
      expect(carlOk).toBe(true);
      await expect
        .poll(async () => (await readBotSession(b))?.kind, { timeout: 2000 })
        .toBe('carl');
    } finally {
      await s.close();
    }
  });

  test('Mike tick loop in the leader tab grows the patch (peers observe new mike-* nodes)', async ({ browser }) => {
    const s = await openContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      await mikeAttemptSpawn(a, 'user-a', 'Alice');
      // Need a leader candidacy + leader status for the loop to engage —
      // but here we drive the loop manually via the dev hook, bypassing
      // the leader election that the UI uses. The patch mutation
      // propagates via the same Yjs path.
      await publishMikeCandidacy(a);
      await mikeStartLoop(a, { seed: 9, baseTickMs: 30, maxTickMs: 80 });
      await expect
        .poll(() => countMikeNodes(b), { timeout: 5000 })
        .toBeGreaterThan(0);
      await mikeStopLoop(a);
    } finally {
      await s.close();
    }
  });

  test('86 Mike clears all mike-* nodes from the patch', async ({ browser }) => {
    const s = await openContexts(browser, 2);
    try {
      const [a, b] = s.pages;
      await mikeAttemptSpawn(a, 'user-a', 'Alice');
      await publishMikeCandidacy(a);
      await mikeStartLoop(a, { seed: 13, baseTickMs: 30, maxTickMs: 80 });
      await expect
        .poll(() => countMikeNodes(a), { timeout: 5000 })
        .toBeGreaterThan(0);
      await mikeStopLoop(a);
      // B (not the spawner) does the eviction.
      await mikeEvictPatch(b);
      await mikeClearSession(b);
      await expect
        .poll(() => countMikeNodes(a), { timeout: 2000 }).toBe(0);
      await expect
        .poll(async () => await readMikeSession(a), { timeout: 2000 })
        .toBeNull();
    } finally {
      await s.close();
    }
  });

  test('Mike leader election: lowest awareness clientID wins', async ({ browser }) => {
    const s = await openContexts(browser, 3);
    try {
      const ids = await Promise.all(
        s.pages.map((p) =>
          p.evaluate(() => {
            const w = window as unknown as { __getLocalClientId: () => number };
            return w.__getLocalClientId();
          }),
        ),
      );
      await Promise.all(s.pages.map((p) => publishMikeCandidacy(p)));
      const expected = Math.min(...ids);
      for (const p of s.pages) {
        await expect
          .poll(async () => (await readMikeLeader(p))?.leaderClientId, { timeout: 1500 })
          .toBe(expected);
      }
    } finally {
      await s.close();
    }
  });
});
