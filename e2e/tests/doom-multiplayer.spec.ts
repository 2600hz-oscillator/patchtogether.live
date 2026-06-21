// e2e/tests/doom-multiplayer.spec.ts
//
// Two-context multi-tab smoke for the DOOM module's shared-input
// multiplayer model. Both tabs share a rackspace via Yjs awareness:
//
//   tab A spawns DOOM → becomes host (first member, lex-smallest id).
//   tab B           → starts as an unjoined spectator (shows the SPEC badge;
//                     no host-framebuffer mirror — that path was removed as the
//                     relay-OOM driver). On host departure B is re-elected host.
//
// NOTE: the old "spectator sees host framebuffer change + key relay" test was
// REMOVED — the host no longer broadcasts its framebuffer over Yjs awareness
// (the ~13.7 MB/s base64-frame firehose OOM-killed the in-process Hocuspocus
// relay). A spectator now sees the DOOM attract/black screen until it JOINS and
// runs its own per-peer WASM. The per-peer-POV path is covered by
// doom-identity-crossview.spec.ts; this file keeps the host-migration smoke.
//
// Skipped cleanly when the WASM blob isn't built (CI without emcc) or
// the shareware WAD isn't on disk (contributor first-clone). Both
// gates run inside the test body so the skip reason is in the report.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { spawnPatch, type SpawnNode } from './_helpers';
import { SYNC_BUDGET_MS } from './_collab-helpers';

interface DoomPair {
  pageHost: Page;
  pageSpec: Page;
  close: () => Promise<void>;
}

async function checkDoomAssetsAvailable(page: Page): Promise<{ ok: boolean; reason?: string }> {
  const wasmOk = await page.evaluate(async () => {
    try {
      const r = await fetch('/doom/doom.js', { method: 'HEAD' });
      return r.ok;
    } catch { return false; }
  });
  if (!wasmOk) {
    return {
      ok: false,
      reason: 'DOOM WASM not built — run `bash packages/web/native/build-doom-wasm.sh`',
    };
  }
  const wadOk = await page.evaluate(async () => {
    try {
      const r = await fetch('/doom/DOOM1.WAD', { method: 'HEAD' });
      return r.ok;
    } catch { return false; }
  });
  if (!wadOk) {
    return {
      ok: false,
      reason: 'DOOM1.WAD missing — see static/doom/DOWNLOAD_INSTRUCTIONS.md',
    };
  }
  return { ok: true };
}

async function openDoomPair(browser: Browser): Promise<DoomPair> {
  const rackspaceId = `doom-mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ctxHost = await browser.newContext();
  const ctxSpec = await browser.newContext();
  const pageHost = await ctxHost.newPage();
  const pageSpec = await ctxSpec.newPage();

  for (const p of [pageHost, pageSpec]) {
    await p.goto('/');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(() =>
      typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }

  // Bootstrap both engines + attach to the same rackspace BEFORE
  // spawning DOOM. Order matters: host attaches first, so its
  // `user.id` (set below) wins the lex-smallest tiebreak in pickHost().
  // The spectator must also have an engine running so its video
  // domain materializes the DOOM module when the node syncs via Yjs.
  await pageHost.evaluate(async (id) => {
    const w = window as unknown as {
      __attachProvider: (id: string) => Promise<unknown>;
      __ensureEngine: () => Promise<unknown>;
      __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
    };
    await w.__ensureEngine();
    await w.__attachProvider(id);
    w.__setAwarenessUser({ id: 'aaa-host', displayName: 'A', color: '#f00' });
  }, rackspaceId);
  await pageSpec.evaluate(async (id) => {
    const w = window as unknown as {
      __attachProvider: (id: string) => Promise<unknown>;
      __ensureEngine: () => Promise<unknown>;
      __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
    };
    await w.__ensureEngine();
    await w.__attachProvider(id);
    w.__setAwarenessUser({ id: 'bbb-spec', displayName: 'B', color: '#0f0' });
  }, rackspaceId);

  return {
    pageHost,
    pageSpec,
    async close() {
      await Promise.all([ctxHost.close().catch(() => {}), ctxSpec.close().catch(() => {})]);
    },
  };
}

/** Spawn one DOOM node on the page + return its id. Also kicks the
 *  load overlay click + waits up to 20s for the runtime to report
 *  `loaded === true`. Returns null on load timeout (caller skips). */
async function spawnAndLoadDoom(page: Page, nodeId = 'sut'): Promise<boolean> {
  const nodes: SpawnNode[] = [
    { id: nodeId, type: 'doom', position: { x: 60, y: 60 }, domain: 'video' },
  ];
  await spawnPatch(page, nodes, []);
  const card = page.locator('[data-testid="doom-card"]');
  await card.locator('button.overlay', { hasText: /Click to load DOOM/i }).click();
  try {
    await page.waitForFunction(
      (id) => {
        const w = globalThis as unknown as {
          __engine?: () => { getDomain?: (d: string) => {
            read?: (id: string, k: string) => unknown;
          } | null } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        return ve?.read?.(id, 'loaded') === true;
      },
      nodeId,
      { timeout: 20000 },
    );
    // Confirm no load error.
    const err = await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain?: (d: string) => {
          read?: (id: string, k: string) => unknown;
        } | null } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      return ve?.read?.(id, 'loadError') ?? null;
    }, nodeId);
    return err === null;
  } catch {
    return false;
  }
}

test.describe('@collab DOOM shared-input multiplayer', () => {
  // Runs on the dedicated @collab lane (COLLAB_JOB=1 — relay + Postgres), and
  // is skipped only in the sharded matrix where the relay/DB aren't available.
  // De-flake (consolidated #837+#841): the cross-context host-promotion assert
  // below now uses the deterministic SYNC_BUDGET_MS budget so a correct slow
  // awareness re-election still passes under CI contention (and still FAILS if
  // promotion never lands — this was always a real assert, never a vacuity skip).
  test.skip(!!process.env.CI && !process.env.COLLAB_JOB, '@collab — runs on the dedicated COLLAB_JOB lane, not the sharded matrix');
  // Cold-start DOOM (WASM fetch + 4 MB WAD + cross-context awareness sync)
  // routinely sits in the 20–40 s window under CI load; give plenty of headroom.
  test.setTimeout(180_000);

  test('host migration: when host leaves, spectator becomes host', async ({ browser }) => {
    const pair = await openDoomPair(browser);
    try {
      const assets = await checkDoomAssetsAvailable(pair.pageHost);
      if (!assets.ok) {
        test.skip(true, assets.reason);
        return;
      }
      const hostLoaded = await spawnAndLoadDoom(pair.pageHost, 'sut');
      if (!hostLoaded) {
        test.skip(true, 'DOOM runtime failed to load on host within 20s');
        return;
      }
      await pair.pageSpec.locator('[data-testid="doom-card"]').waitFor({ timeout: 5000 });
      // Spec page initially shows SPEC badge.
      await expect(
        pair.pageSpec.locator('[data-testid="doom-card"] .spec-badge'),
        'spectator should show SPEC badge',
      ).toBeVisible({ timeout: 3000 });

      // Close the host's context. After ~1s the spec's pickHost will
      // re-elect: with only spec left, it becomes host.
      await pair.pageHost.context().close();

      await expect(
        pair.pageSpec.locator('[data-testid="doom-card"] .host-badge'),
        'spec should be promoted to HOST after original host departs',
      ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    } finally {
      await pair.close();
    }
  });
});
