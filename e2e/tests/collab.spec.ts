// e2e/tests/collab.spec.ts
//
// Multi-user collab tests, tagged @collab. Until Phase 4 wires up Hocuspocus +
// WebRTC, every test in this file is `test.skip`'d. The harness in
// _collab-helpers.ts and these test bodies exist so Phase 4 ships with multi-
// user verification on day one — flip `test.skip` to `test` once the provider
// is attached.
//
// To grep for collab tests:  npx playwright test --grep @collab

import { test, expect } from '@playwright/test';
import { openCollab } from './_collab-helpers';

test.describe('@collab', () => {
  test.skip('two contexts on same canvas see each other’s nodes within 200 ms', async ({
    browser,
  }) => {
    const session = await openCollab(browser, 2);
    try {
      const [a, b] = session.pages;

      // A spawns the demo. B should see it via Yjs sync.
      await a.getByRole('button', { name: 'Load example' }).click();
      await expect(b.locator('.svelte-flow__node')).toHaveCount(2, { timeout: 1_000 });
    } finally {
      await session.close();
    }
  });

  test.skip('host renders audio; follower hears it via WebRTC mesh', async ({ browser }) => {
    const session = await openCollab(browser, 2);
    try {
      const [host, follower] = session.pages;

      await host.getByRole('button', { name: 'Load example' }).click();
      await expect(host.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

      // Phase 4 will assert the follower's hidden <audio> element receives
      // a non-empty stream. For now this is just structural scaffolding.
      const followerAudio = follower.locator('audio');
      await expect(followerAudio).toBeAttached({ timeout: 5_000 });
    } finally {
      await session.close();
    }
  });

  test.skip('host disconnect → follower promotes within 3 s', async ({ browser }) => {
    const session = await openCollab(browser, 2);
    try {
      const [host, follower] = session.pages;
      await host.getByRole('button', { name: 'Load example' }).click();
      await host.close();

      // Follower's role indicator should flip from FOLLOWER to HOST.
      await expect(follower.locator('[data-host-indicator="true"]')).toBeVisible({
        timeout: 3_000,
      });
    } finally {
      await session.close();
    }
  });

  test.skip('audience role can see + hear but cannot edit', async ({ browser }) => {
    const session = await openCollab(browser, 2, { canvasId: 'collab-audience-test' });
    try {
      const [performer, audience] = session.pages;
      // Phase 4: audience joins via ?role=audience or invite-list role.
      // Then the topbar action buttons must be hidden / disabled for audience.
      await audience.goto(`/?canvas=${session.canvasId}&role=audience`);
      await expect(audience.getByRole('button', { name: 'Load example' })).toBeDisabled();
      // Performer can still edit:
      await performer.getByRole('button', { name: 'Load example' }).click();
      await expect(audience.locator('.svelte-flow__node')).toHaveCount(2, { timeout: 1_000 });
    } finally {
      await session.close();
    }
  });
});
