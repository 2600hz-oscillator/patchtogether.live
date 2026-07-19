// e2e/tests/rack-restoring-status.spec.ts
//
// Persistence-hardening P1: the non-blocking "Restoring… / Offline" banner on
// /r/[id]. We seed a real rackspace, block the relay WebSocket so the provider
// can NEVER sync, and assert:
//   - the "Offline — working from your local copy" banner appears after the
//     ~4s grace (fresh first visit → no local seed, relay down → offline);
//   - the canvas stays fully interactive underneath (banner is pointer-events
//     none, and a real edit mounts a node);
//   - unblocking the relay lets the provider sync and the banner clears.
//
// Lane gate (mirrors audio-gate.spec.ts): /r/[id] needs a Neon-HTTP-capable
// Postgres — seedRackspace uses the neon() HTTP tag, which CI shard runners'
// localhost Postgres cannot serve. So it's skipped on the functional shards
// and runs in the COLLAB_JOB / local neon-proxy lane. When seeding is
// unavailable (no DB in this environment) the test skips gracefully rather
// than reds — the same posture as a capability gate.

import { test, expect, type WebSocketRoute } from '@playwright/test';
import { seedRackspace, spawnPatch } from './_helpers';

test.skip(
  !!process.env.CI && !process.env.COLLAB_JOB,
  'requires COLLAB_JOB=1 — neon() HTTP client cannot reach localhost Postgres in shard runners',
);

test.describe('@rack-status', () => {
  // Generous ceiling: the offline timeout (4s) + a provider reconnect/sync
  // after unblocking can run to ~20s under the collab lane's contended relay.
  test.setTimeout(90_000);

  test('offline banner shows when the relay is down, canvas stays live, and it clears on sync', async ({
    page,
  }) => {
    // Gate the /r/[id] flow on a reachable seed endpoint (Neon-HTTP DB).
    let seeded: Awaited<ReturnType<typeof seedRackspace>>;
    try {
      seeded = await seedRackspace(page);
    } catch (e) {
      test.skip(
        true,
        `rackspace seed unavailable (no Neon-HTTP DB in this env): ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    // Block the relay WebSocket BEFORE navigating. A Node-side flag lets us
    // later unblock and prove the banner clears. `allow=false` → refuse every
    // connection (client keeps retrying, never syncs). `allow=true` →
    // transparent proxy to the real relay (connectToServer + no message
    // handlers = auto-forward both ways).
    let allow = false;
    await page.routeWebSocket(/localhost:1235/, (ws: WebSocketRoute) => {
      if (allow) ws.connectToServer();
      else void ws.close();
    });

    await page.goto(seeded.url);

    // Canvas renders even with the relay down.
    await expect(page.locator('.svelte-flow__pane')).toBeVisible({ timeout: 20_000 });

    // After the ~4s offline timeout — no local seed (fresh first visit) and no
    // relay sync — the offline banner appears.
    const banner = page.getByTestId('rack-status-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toHaveAttribute('data-status', 'offline');
    await expect(banner).toContainText('Offline — working from your local copy');

    // NON-BLOCKING: the banner never intercepts pointer input …
    const pointerEvents = await banner.evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pointerEvents).toBe('none');

    // … and the canvas is genuinely live — a real edit mounts a node while
    // still offline (spawnPatch drives the true add path + waits for the DOM).
    await spawnPatch(page, [
      { id: 'offline-edit', type: 'analogVco', position: { x: 140, y: 140 } },
    ]);
    await expect(
      page.locator('.svelte-flow__node[data-id="offline-edit"]'),
    ).toBeVisible({ timeout: 10_000 });

    // Unblock the relay → the provider reconnects, syncs, and the connectivity
    // banner clears (displayStatus → ready).
    allow = true;
    await expect(banner).toBeHidden({ timeout: 30_000 });
  });
});
