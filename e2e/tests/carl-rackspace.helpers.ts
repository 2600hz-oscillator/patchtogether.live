// e2e/tests/carl-rackspace.helpers.ts
//
// Shared scaffolding for the Rackspace Carl @collab tests across both
// approach-A (carl/ephemeral) and approach-B (carl/leader-elected)
// branches. Keeps the per-spec file small + ensures the two PRs test
// the same exclusivity behavior — the only differences should be in
// the lifecycle assertions (orphan vs leader-migration).

import type { Browser, BrowserContext, Page } from '@playwright/test';

export interface CarlContexts {
  pages: Page[];
  contexts: BrowserContext[];
  rackspaceId: string;
  close: () => Promise<void>;
}

/**
 * Spin up N browser contexts, navigate each to `/`, await the
 * `__attachProvider` dev hook, and attach all of them to the same
 * fresh rackspace id.
 */
export async function openCarlContexts(
  browser: Browser,
  n: number,
): Promise<CarlContexts> {
  const rackspaceId = `carl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto('/rack');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () =>
        typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider ===
          'function' &&
        typeof (window as unknown as { __carlAttemptSpawn?: unknown }).__carlAttemptSpawn ===
          'function',
    );
    contexts.push(ctx);
    pages.push(p);
  }
  await Promise.all(
    pages.map((p) =>
      p.evaluate(async (id) => {
        const w = window as unknown as {
          __attachProvider: (id: string) => Promise<unknown>;
        };
        await w.__attachProvider(id);
      }, rackspaceId),
    ),
  );
  return {
    pages,
    contexts,
    rackspaceId,
    close: () => Promise.all(contexts.map((c) => c.close())).then(() => {}),
  };
}

/** Attempt a Carl spawn on the given page. Returns true if local write landed. */
export async function attemptSpawn(
  page: Page,
  ownerUserId: string,
  displayName: string,
): Promise<boolean> {
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

export interface CarlSessionView {
  ownerUserId: string | null;
  ownerDisplayName: string;
  spawnedAt: number;
  seed: number;
  /** Present in approach B; absent in approach A. */
  active?: boolean;
}

export async function readSession(page: Page): Promise<CarlSessionView | null> {
  return await page.evaluate(() => {
    const w = window as unknown as { __carlReadSession: () => CarlSessionView | null };
    return w.__carlReadSession();
  });
}

export async function clearSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __carlClearSession: () => void };
    w.__carlClearSession();
  });
}

/** Start Carl's tick loop on the given page (no-op if already running). */
export async function startLoop(
  page: Page,
  opts?: { seed?: number; baseTickMs?: number },
): Promise<boolean> {
  return await page.evaluate((o) => {
    const w = window as unknown as {
      __carlStartLoop: (o?: { seed?: number; baseTickMs?: number }) => boolean;
    };
    return w.__carlStartLoop(o);
  }, opts ?? {});
}

export async function stopLoop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __carlStopLoop: () => void };
    w.__carlStopLoop();
  });
}

/** Wipe all carl-prefixed nodes + edges. */
export async function evictPatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __carlEvictPatch: () => void };
    w.__carlEvictPatch();
  });
}

/** Count Carl-owned (idPrefix='carl') nodes visible on this page. */
export async function countCarlNodes(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { id: string } | undefined> };
    };
    return Object.values(w.__patch.nodes).filter(
      (n) => n && n.id.startsWith('carl-'),
    ).length;
  });
}

// ---------- Approach B-only helpers (leader election) ----------

export interface LeaderInfoView {
  leaderClientId: number | null;
  isLocalLeader: boolean;
  candidates: number[];
}

export async function publishCandidacy(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const w = window as unknown as { __carlPublishCandidacy?: () => boolean };
    return w.__carlPublishCandidacy ? w.__carlPublishCandidacy() : false;
  });
}

export async function withdrawCandidacy(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const w = window as unknown as { __carlWithdrawCandidacy?: () => boolean };
    return w.__carlWithdrawCandidacy ? w.__carlWithdrawCandidacy() : false;
  });
}

export async function readLeader(page: Page): Promise<LeaderInfoView | null> {
  return await page.evaluate(() => {
    const w = window as unknown as { __carlReadLeader?: () => LeaderInfoView };
    return w.__carlReadLeader ? w.__carlReadLeader() : null;
  });
}
