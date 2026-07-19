// e2e/tests/unsaved-guard.spec.ts
//
// Persistence-hardening P2: the "Saving… / All changes saved" indicator +
// the strict beforeunload guard on /r/[id].
//
// We seed a real rackspace and proxy the relay WebSocket through a Node-side
// gate so we can DETERMINISTICALLY hold an edit un-synced (no timing race on
// the transient "Saving…" state):
//   - initial sync proxies both ways        → "All changes saved", guard OK
//   - drop page→server, make an edit         → "Saving…" (held), predicate true
//   - stop dropping + force a reconnect      → replay ACKs → "All changes saved"
//
// The native beforeunload dialog is brittle to assert in Playwright, so we
// assert the handler is REGISTERED and drive its live predicate via the
// __rackUnsavedGuard test hook (dev/e2e only) rather than the browser chrome.
//
// Lane gate + graceful skip: same as rack-restoring-status.spec.ts — /r/[id]
// needs a Neon-HTTP-capable Postgres.

import { test, expect, type WebSocketRoute } from '@playwright/test';
import { seedRackspace } from './_helpers';

interface UnsavedGuardHook {
  registered: boolean;
  shouldPrompt: () => boolean;
}

test.skip(
  !!process.env.CI && !process.env.COLLAB_JOB,
  'requires COLLAB_JOB=1 — neon() HTTP client cannot reach localhost Postgres in shard runners',
);

test.describe('@unsaved-guard', () => {
  test.setTimeout(90_000);

  test('indicator flips saving→saved on sync, and the strict unload guard tracks unsynced state', async ({
    page,
  }) => {
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

    // Proxy the relay through a gate. `dropPageToServer` lets us withhold the
    // client's updates from the relay to hold the "Saving…" state; the latest
    // routed socket is captured so we can force a reconnect (which replays the
    // withheld update — see reconnect-replay.test.ts).
    let dropPageToServer = false;
    let lastWs: WebSocketRoute | null = null;
    await page.routeWebSocket(/localhost:1235/, (ws: WebSocketRoute) => {
      lastWs = ws;
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        if (!dropPageToServer) server.send(message);
      });
      server.onMessage((message) => ws.send(message));
    });

    await page.goto(seeded.url);
    await expect(page.locator('.svelte-flow__pane')).toBeVisible({ timeout: 20_000 });

    // The beforeunload guard registers on mount + exposes its live predicate.
    await page.waitForFunction(
      () => (window as unknown as { __rackUnsavedGuard?: UnsavedGuardHook }).__rackUnsavedGuard?.registered === true,
      undefined,
      { timeout: 20_000 },
    );

    const indicator = page.getByTestId('rack-save-indicator');

    // Initial sync settles → "All changes saved"; a synced user is never nagged.
    await expect(indicator).toBeVisible({ timeout: 30_000 });
    await expect(indicator).toContainText('All changes saved', { timeout: 30_000 });
    expect(
      await page.evaluate(
        () => (window as unknown as { __rackUnsavedGuard: UnsavedGuardHook }).__rackUnsavedGuard.shouldPrompt(),
      ),
    ).toBe(false);

    // Withhold the next update, then edit → the update never reaches the relay,
    // so it stays un-ACKed and the indicator holds "Saving…".
    dropPageToServer = true;
    await page.waitForFunction(
      () => typeof (window as unknown as { __ydoc?: { transact?: unknown } }).__ydoc?.transact === 'function',
      undefined,
      { timeout: 10_000 },
    );
    await page.evaluate(() => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['guard-edit'] = {
          id: 'guard-edit',
          type: 'analogVco',
          domain: 'audio',
          position: { x: 160, y: 160 },
          params: {},
        };
      });
    });

    await expect(indicator).toContainText('Saving…', { timeout: 15_000 });
    await expect(indicator).toHaveAttribute('data-save-status', 'saving');
    // Strict predicate: an unsynced user WOULD be prompted on unload.
    expect(
      await page.evaluate(
        () => (window as unknown as { __rackUnsavedGuard: UnsavedGuardHook }).__rackUnsavedGuard.shouldPrompt(),
      ),
    ).toBe(true);

    // Stop dropping + force a reconnect → the withheld update replays and is
    // ACKed → the indicator returns to "All changes saved".
    dropPageToServer = false;
    await lastWs!.close();

    await expect(indicator).toContainText('All changes saved', { timeout: 30_000 });
    expect(
      await page.evaluate(
        () => (window as unknown as { __rackUnsavedGuard: UnsavedGuardHook }).__rackUnsavedGuard.shouldPrompt(),
      ),
    ).toBe(false);
  });
});
