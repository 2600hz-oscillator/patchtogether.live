// e2e/tests/in-card-title.spec.ts
//
// Covers PR `feat(ui): editable in-card module titles + drop floating
// overhead label`. The owner-spec asserts:
//   1. The user-given instance name sits INSIDE the card's title chrome
//      (not as a floating overhead badge).
//   2. Click → edit; type → blur → name persists on `node.data.name`.
//   3. NO floating/overhead label is rendered for module nodes.
//   4. @collab — rename in A propagates to B via Yjs.
//
// The existing rename-validation flow (uniqueness, escape-cancel) is
// already covered by `livecode.spec.ts: editable name label — rename +
// reject duplicate`. This file focuses on the placement + sync delta the
// new PR introduces.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test('in-card title: user-given name renders inside card.title (no overhead badge)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'sculpt', type: 'wavesculpt', position: { x: 200, y: 200 } },
  ]);

  // Wait for auto-name migration to land.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { name?: string } }> };
    };
    return typeof w.__patch.nodes.sculpt?.data?.name === 'string';
  });

  // The name button must live INSIDE the card's `header.title`. We chain
  // a CSS selector to verify the DOM nesting, not just visibility.
  const titleBar = page.locator('.svelte-flow__node-wavesculpt header.title');
  await expect(titleBar).toBeVisible();
  const nameBtnInsideTitle = titleBar.locator('[data-testid="name-label-button"]');
  await expect(nameBtnInsideTitle).toBeVisible();
  await expect(nameBtnInsideTitle).toHaveText(/WAVESCULPT/);

  // The legacy `.node-name-toolbar` floating overhead badge must not
  // exist anywhere on the page — the spec drops it entirely. We assert
  // count 0 (not just hidden) so a CSS-only suppression that still
  // mounts the toolbar wouldn't quietly pass.
  await expect(page.locator('.node-name-toolbar')).toHaveCount(0);
});

test('in-card title: click → edit → blur commits and persists on data.name', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'vco', type: 'analogVco', position: { x: 200, y: 200 } },
  ]);

  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { name?: string } }> };
    };
    return typeof w.__patch.nodes.vco?.data?.name === 'string';
  });

  const titleBar = page.locator('.svelte-flow__node-analogVco header.title');
  const nameBtn = titleBar.locator('[data-testid="name-label-button"]');
  await expect(nameBtn).toBeVisible();
  await nameBtn.click();

  const input = page.locator('[data-testid="name-label-input"]');
  await expect(input).toBeFocused();
  await input.fill('LEAD');
  // Blur via Tab — exercises the onblur commit path (Enter is the
  // explicit-commit path; both must persist).
  await input.press('Tab');

  // Title bar now shows the renamed value.
  await expect(
    titleBar.locator('[data-testid="name-label-button"]'),
  ).toHaveText('LEAD');

  // Persisted to data.name on the patch graph (round-trips Y.Doc).
  const persisted = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { name?: string } }> };
    };
    return w.__patch.nodes.vco?.data?.name;
  });
  expect(persisted).toBe('LEAD');
});

test.describe('@collab', () => {
  test('rename in A appears in B inside the in-card title (peer Yjs sync)', async ({
    browser,
  }) => {
    // The full 2-context relay flow (2× goto + attachProvider relay-connect +
    // spawn + rename + peer-sync polls + DOM asserts) is long. Its internal
    // waits alone sum to ~40s of polls, so a 60s test budget left only ~15s for
    // two page loads + relay attach + UI typing under CI contention — too thin:
    // it timed out at 60s on #561's collab run (rename never reached B). 90s
    // gives real headroom over the stacked internal timeouts. (The actual flake
    // root-cause — an unbounded `fill()` hang when the inline editor hadn't
    // opened yet — is fixed below with an explicit editor-visible wait.)
    test.setTimeout(90_000);
    const rackspaceId = `title-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    try {
      for (const p of [pageA, pageB]) {
        await p.goto('/');
        // NB: no waitForLoadState('networkidle') here — with the live
        // Hocuspocus relay WebSocket open, the network never goes idle, so
        // networkidle hangs to the test timeout under CI contention (the
        // root cause of the in-card-title flake: 60s timeout on attempt 1,
        // pass on retry). The waitForFunction below is the real readiness
        // signal (the test-hook provider is installed once the app booted).
        await p.waitForFunction(
          () =>
            typeof (window as unknown as { __attachProvider?: unknown })
              .__attachProvider === 'function',
        );
      }
      await Promise.all(
        [pageA, pageB].map((p) =>
          p.evaluate(async (id) => {
            const w = window as unknown as {
              __attachProvider: (id: string) => Promise<unknown>;
            };
            await w.__attachProvider(id);
          }, rackspaceId),
        ),
      );

      // A spawns a wavesculpt + waits for auto-name to land.
      await pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['ws-sync'] = {
            id: 'ws-sync',
            type: 'wavesculpt',
            domain: 'video',
            position: { x: 250, y: 250 },
            params: {},
          };
        });
      });

      // B must see the spawn + the auto-assigned name.
      await expect
        .poll(
          async () =>
            await pageB.evaluate(() => {
              const w = window as unknown as {
                __patch: {
                  nodes: Record<string, { data?: { name?: string } } | undefined>;
                };
              };
              return w.__patch.nodes['ws-sync']?.data?.name;
            }),
          // Relay propagation under CI contention can exceed 4s.
          { timeout: 12000 },
        )
        .toMatch(/WAVESCULPT/);

      // A renames via the in-card title button.
      const titleA = pageA
        .locator('.svelte-flow__node-wavesculpt header.title')
        .filter({ has: pageA.locator('[data-testid="name-label-button"]') });
      await expect(titleA.first()).toBeVisible({ timeout: 10_000 });
      await titleA.locator('[data-testid="name-label-button"]').first().click();
      const inputA = pageA.locator('[data-testid="name-label-input"]');
      // FLAKE FIX: wait for the inline editor to actually open before filling.
      // Playwright's default actionTimeout is unbounded, so a bare
      // `inputA.fill()` when the click hadn't yet opened the editor (a real
      // race under CI contention) blocks until the *test* timeout — the 60s
      // hang seen on #561 (trace's last action was this click; the rename
      // never committed, so B stayed on the auto-name). A bounded visible-wait
      // turns that into a fast, clear, retryable failure instead of a hang.
      await expect(inputA).toBeVisible({ timeout: 10_000 });
      await inputA.fill('SHARED_LEAD');
      await inputA.press('Enter');

      // Confirm the rename committed in A's OWN card first, so a sync failure
      // below is unambiguously a peer-propagation problem (B) and not a missed
      // local edit (A). Cheap, and it localizes future failures.
      await expect(
        pageA
          .locator('.svelte-flow__node-wavesculpt header.title [data-testid="name-label-button"]')
          .first(),
      ).toHaveText('SHARED_LEAD', { timeout: 10_000 });

      // B's in-card title must update to the new value via Y.Doc sync.
      await expect
        .poll(
          async () =>
            await pageB.evaluate(() => {
              const w = window as unknown as {
                __patch: {
                  nodes: Record<string, { data?: { name?: string } } | undefined>;
                };
              };
              return w.__patch.nodes['ws-sync']?.data?.name;
            }),
          // Relay propagation under CI contention can exceed 4s.
          { timeout: 12000 },
        )
        .toBe('SHARED_LEAD');

      // And the DOM in B reflects it (the in-card title text is the
      // peer-synced value, not a stale snapshot). Generous timeout for the
      // DOM to re-render after the Y.Doc sync lands under contention.
      await expect(
        pageB
          .locator('.svelte-flow__node-wavesculpt header.title [data-testid="name-label-button"]')
          .first(),
      ).toHaveText('SHARED_LEAD', { timeout: 10_000 });

      // Overhead badge stays gone on the peer too.
      await expect(pageB.locator('.node-name-toolbar')).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await Promise.all([ctxA.close(), ctxB.close()]);
    }
  });
});
