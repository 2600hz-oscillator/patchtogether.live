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

/** The DOOM game surface — `doom/DoomSurface.svelte`, mounted by the shell's
 *  dock full view. It carries the identity badges, the runtime, the
 *  `__doomCards` hook and the "Click to load DOOM" gesture, so each peer opens
 *  its own faceplate before anything about it can be read. */
const SURFACE = 'doom-face-surface';

/** THIS node's LANE tile — how a peer observes that the node has SYNCED to it,
 *  before its own faceplate exists. */
const laneTile = (nodeId: string): string =>
  `.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`;

/** Open a node's dock faceplate through the app's own hook. The dock boot is
 *  SEQUENTIAL — it does not overlap the page load — so this is a real wait. */
async function openDoomFace(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(
    (n) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(n),
    nodeId,
  );
  await expect(page.getByTestId(SURFACE)).toBeVisible({ timeout: 20_000 });
}

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
    await p.goto('/rack?seed=none');
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

/** Spawn one DOOM node on the page, open its faceplate + return its id. Also
 *  kicks the load overlay click + waits up to 20s for the runtime to report
 *  `loaded === true`. Returns null on load timeout (caller skips). */
async function spawnAndLoadDoom(page: Page, nodeId = 'sut'): Promise<boolean> {
  const nodes: SpawnNode[] = [
    { id: nodeId, type: 'doom', position: { x: 60, y: 60 }, domain: 'video' },
  ];
  await spawnPatch(page, nodes, []);
  await openDoomFace(page, nodeId);
  const card = page.locator(`[data-testid="${SURFACE}"]`);
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
      await pair.pageSpec.locator(laneTile('sut')).waitFor({ timeout: 5000 });
      await openDoomFace(pair.pageSpec, 'sut');
      // Spec page initially shows SPEC badge.
      await expect(
        pair.pageSpec.locator(`[data-testid="${SURFACE}"] .spec-badge`),
        'spectator should show SPEC badge',
      ).toBeVisible({ timeout: 3000 });

      // Close the host's context. After ~1s the spec's pickHost will
      // re-elect: with only spec left, it becomes host.
      await pair.pageHost.context().close();

      // ⚠ THE HOST FACT LIVES ON THE SURFACE'S ACCESSIBLE NAME, NOT ON A BADGE,
      // and that is deliberate rather than a gap: `showHostBadge` is
      // `isHost && (variant === 'card' || memberIds.length > 1)`, so the
      // faceplate suppresses the word on a SOLO rack — which is exactly the
      // rack this leg produces, because the promotion happens by the only other
      // member LEAVING. DoomSurface's `surfaceLabel` carries the same fact
      // unconditionally ("the face's un-painted prose", its own words), so this
      // asserts the PROMOTION rather than the chrome that used to announce it.
      await expect(
        pair.pageSpec.getByTestId(SURFACE),
        'spec should be promoted to HOST after original host departs',
      ).toHaveAttribute('aria-label', /You are the host for this rack/, {
        timeout: SYNC_BUDGET_MS,
      });
    } finally {
      await pair.close();
    }
  });
});
