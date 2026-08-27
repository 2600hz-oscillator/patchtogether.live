// e2e/tests/tv-librarian-face.spec.ts
//
// THE TV LIBRARIAN FACE, driven for real on the DEFAULT shell — and specifically
// the seams no other gate can see.
//
// `tvLibrarian-face-model.test.ts` pins the ranking, the cell kind, the
// noUserControl declaration in both directions, the shader's `uGain` read and
// every source-level claim the face makes.
// `face-rack-status-source.test.ts` proves the body declares what it paints.
// `video-face-screen-source.test.ts` proves the body OWNS a screen switch.
// `workflow-shell-faces` photographs the plate.
//
// None of them can see:
//
//  1. ⚠ THAT THE MODULE CAN BE TUNED AT ALL UNDER THE SHELL. This is the whole
//     practical argument for the promotion and it is a RENDER fact, not a
//     resolver one. tvLibrarian left `DOM_SOURCE_LANE_TYPES` when its stream
//     became node-owned (LEG-02 P3, #2209), so unlike camera or loopback there
//     is no `<HeadlessSourceHost>` keeping an off-screen card around: with the
//     face declared and no body mounted there would be no country picker and no
//     channel roster on ANY surface. So this file asserts the legacy card is
//     absent AND that a station can still be chosen.
//  2. THAT THE DELETED READOUT SURVIVED THE MOVE. The resting-text ruling took
//     the NOW PLAYING label off both surfaces and sent it to the picture's
//     accessible name. A source gate cannot tell whether it survived, and a unit
//     test proves the STRING exists but not that anything renders it. Here the
//     DOM is asked for both halves: nothing paints the station name outside a
//     control, and the accessible name carries it.
//  3. THAT SCREEN OFF IS NOT A MUTE. The switch reclaims the preview's space;
//     it must never stop the tuner. Only a driven page can show the stream state
//     surviving the collapse.
//
// ⚠ EVERY famelack request and every `.m3u8` is route-fulfilled — this suite
// NEVER contacts a live third-party stream (flaky, and legally cleaner). The
// stub manifest has no playable media on purpose, so hls.js resolves to
// `unavailable`, which is the graceful path a dead stream must take.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

const META = {
  US: { country: 'United States', capital: 'Washington', hasChannels: true, channelCount: 2 },
  FR: { country: 'France', capital: 'Paris', hasChannels: true, channelCount: 1 },
};

const US_CHANNELS = [
  {
    nanoid: 'usa1', name: 'Mock News USA',
    stream_urls: ['https://mock.example/usa-news/playlist.m3u8'], youtube_urls: [],
    languages: ['eng'], country: 'us', isGeoBlocked: false,
  },
  {
    nanoid: 'usa2', name: 'Mock Sports USA',
    stream_urls: ['https://mock.example/usa-sports/playlist.m3u8'], youtube_urls: [],
    languages: ['eng', 'spa'], country: 'us', isGeoBlocked: true,
  },
];

/**
 * ⚠ A ONE-CHANNEL COUNTRY, AND IT IS THE FIXTURE THAT MAKES THE TUNE LEGS
 * DETERMINISTIC. The stub manifest below has no playable media on purpose, so
 * hls.js resolves it to `unavailable` — and the module then does exactly what its
 * docs promise: it AUTO-SKIPS to the next channel rather than hanging. With the
 * two-channel US roster, "click the first row and assert the station name" is
 * therefore a race against the module's own recovery, and the slower the runner
 * the more reliably the skip wins. It passed locally three times over and lost on
 * CI, which is the shape this repo keeps re-learning: the product was right and
 * the assertion was.
 *
 * So the roster-SHAPE claims (a count, a geo badge) use the two-channel country,
 * and every claim about WHICH STATION IS TUNED uses this one, where a skip has
 * nowhere else to land.
 */
const FR_CHANNELS = [
  {
    nanoid: 'fra1', name: 'Mock Solo France',
    stream_urls: ['https://mock.example/fr-solo/playlist.m3u8'], youtube_urls: [],
    languages: ['fra'], country: 'fr', isGeoBlocked: false,
  },
];

const STUB_M3U8 = '#EXTM3U\n#EXT-X-ENDLIST\n';

async function installMocks(page: Page): Promise<void> {
  await page.route('**/famelack-data/**/countries_metadata.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META) }),
  );
  await page.route('**/famelack-data/**/countries/us.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(US_CHANNELS) }),
  );
  await page.route('**/famelack-data/**/countries/fr.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FR_CHANNELS) }),
  );
  await page.route('**/*.m3u8', (route) =>
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: STUB_M3U8 }),
  );
}

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open this node's dock faceplate, scoped by `data-shell-node` so a later swap
 *  of the dock's occupant cannot leave a stale locator on someone else's plate. */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  // ⚠ AUTO-RETRYING RATHER THAN ONE CLICK PLUS A WAIT. Re-opening a pane that
  // was just closed is the case that needed this: the tile button is present
  // and hit-testable while the drawer is still tearing down, so a single click
  // can land on nothing and the failure reads as "the face never mounted". The
  // click is idempotent — the pane is already open or it is not — so retrying
  // it until the dock shell appears is renderer-independent, and there is no
  // wall-clock budget standing in for a state the DOM can be asked about.
  await expect(async () => {
    if (await dockShell.count() === 0) {
      await shell.getByTestId('shell-open-dock').click();
    }
    await expect(dockShell).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: SLOW_RENDER ? 30_000 : 15_000 });
  return dockShell;
}

test.describe('TV LIBRARIAN face — the promotion is what makes it tunable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE, and it is not belt-and-braces:
  // it is how BOTH defects this promotion uncovered were found. A `TypeError`
  // inside a `$derived` does not surface as a thrown assertion — it takes the
  // subtree's render down and everything downstream simply stops updating, so
  // the symptom lands somewhere else entirely (here: a screen toggle whose graph
  // write had landed correctly while its own DOM was frozen). Without this hook
  // the first sitting would have read as "the toggle is broken" and the fix would
  // have gone in the wrong file.
  test.beforeEach(({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a tvLibrarian face test: ${err.message}`);
    });
  });

  test('the shell replaces the card, and the face still tunes a station @video', async ({ page }) => {
    await installMocks(page);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'tvf1', type: 'tvLibrarian', domain: 'video' }]);

    // ⚠ THE PRECONDITION THIS WHOLE FILE RESTS ON. On the default shell the
    // legacy card is not rendered — and for THIS module it is not parked
    // off-screen either, because it left DOM_SOURCE_LANE_TYPES. If this ever
    // starts finding a card, the rest of the file stops proving anything about
    // the face and would go green for the wrong reason.
    await expect(page.getByTestId('tv-librarian-card')).toHaveCount(0);

    const dock = await openDock(page, 'tvf1');
    const body = dock.getByTestId('tv-librarian-face-body');
    await expect(body).toBeVisible();

    // Nothing tuned: the placeholder names this surface's own condition.
    await expect(body.getByTestId('tv-empty')).toBeVisible();
    await expect(body.getByTestId('tv-preview')).toHaveAttribute('aria-label', /nothing tuned/);

    // The deterministic country LIST view (the map needs pixel clicks).
    await body.getByTestId('tv-view-list').click();
    await body.getByTestId('tv-country-select').selectOption('US');

    const channels = body.getByTestId('tv-channel');
    await expect(channels).toHaveCount(2);
    // The geo-blocked entry is MARKED — the legal posture is honoured on the
    // faceplate exactly as it was on the card.
    await expect(body.locator('.chan .badge.geo')).toHaveCount(1);
    // …and so is the attribution the dataset licence requires.
    await expect(body.getByTestId('tv-disclaimer')).toBeVisible();

    // ⚠ NOW SWITCH TO THE ONE-CHANNEL COUNTRY FOR EVERY CLAIM ABOUT *WHICH*
    // STATION IS TUNED — see FR_CHANNELS. The stub manifest is unplayable by
    // design, so the module auto-skips off whatever it just tuned; against a
    // two-row roster that makes "the first row is playing" a race with the
    // module's own documented recovery, and the slower the runner the more
    // reliably the skip wins.
    await body.getByTestId('tv-country-select').selectOption('FR');
    await expect(channels).toHaveCount(1);
    await channels.first().click();

    // ⚠ THE STATION NAME IS ON THE ACCESSIBLE NAME AND NOWHERE ELSE. Both halves
    // are asserted: the value survived the readout's deletion, and no text node
    // outside a control restates it.
    await expect(body.getByTestId('tv-preview')).toHaveAttribute('aria-label', /Mock Solo France/);
    await expect(body.getByTestId('tv-now-playing')).toHaveCount(0);

    // The selected row is the painted answer, and it is highlighted.
    await expect(body.locator('.chan.sel')).toHaveCount(1);
    await expect(body.locator('.chan.sel')).toContainText('Mock Solo France');

    // It reached the graph, so a rack-mate tunes the same station.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: {
              nodes: Record<string, { data?: { channel?: { name?: string }; countryCode?: string } }>;
            };
          };
          const d = w.__patch.nodes['tvf1']?.data;
          return `${d?.countryCode ?? '-'}/${d?.channel?.name ?? '-'}`;
        }),
      )
      .toBe('FR/Mock Solo France');
  });

  test('SCREEN OFF collapses the picture and does NOT stop the tuner @video', async ({ page }) => {
    await installMocks(page);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'tvf2', type: 'tvLibrarian', domain: 'video' }]);

    const dock = await openDock(page, 'tvf2');
    const body = dock.getByTestId('tv-librarian-face-body');
    const preview = body.getByTestId('tv-preview');
    const toggle = body.getByTestId('tv-face-screen-toggle');

    await expect(preview).toHaveAttribute('data-preview-collapsed', 'false');
    await expect(body.getByTestId('tv-face-canvas')).toBeVisible();

    await body.getByTestId('tv-view-list').click();
    // The one-channel country: an unplayable stub makes the module auto-skip, and
    // with a single candidate the skip has nowhere else to land. See FR_CHANNELS.
    await body.getByTestId('tv-country-select').selectOption('FR');
    await body.getByTestId('tv-channel').first().click();
    await expect(preview).toHaveAttribute('aria-label', /Mock Solo France/);

    // ⚠ COLLAPSE FIRST, THEN WATCH THE TUNER FINISH — the order is the test.
    // Asserting "the state did not change across the toggle" would pass just as
    // well on a tuner that had been stopped, because a stopped tuner's state
    // also does not change. Collapsing while the stream is still resolving and
    // THEN requiring it to reach a terminal state proves the screen switch is
    // not a mute: if the collapse had stopped the tuner, this would sit on
    // `loading` for ever.
    await toggle.click();
    await expect(preview).toHaveAttribute('data-preview-collapsed', 'true');
    await expect(body.getByTestId('tv-face-canvas')).toHaveCount(0);

    // pacing: the module's own no-frame give-up, which `tv-librarian.ts` docs
    // as "12s with no frame" before it marks a stream unavailable and skips.
    // This is a PRODUCT-side interval, not a renderer-dependent wait — the
    // number here is a failure BOUND around it, not the gate.
    await expect(body).toHaveAttribute('data-stream-state', /unavailable|playing/, {
      timeout: 25_000,
    });

    // …and the rest of the surface is still operable with the screen off: the
    // roster is there to pick another station with, and the picture still knows
    // which one is playing.
    await expect(body.getByTestId('tv-channel')).toHaveCount(1);
    await expect(preview).toHaveAttribute('aria-label', /Mock Solo France/);

    // It comes back, and it comes back LIVE rather than as a stale frame.
    await toggle.click();
    await expect(preview).toHaveAttribute('data-preview-collapsed', 'false');
    await expect(body.getByTestId('tv-face-canvas')).toBeVisible();
  });

  test('the tuned station survives the dock closing, with NO surface mounted @video', async ({
    page,
  }) => {
    await installMocks(page);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'tvf3', type: 'tvLibrarian', domain: 'video' }]);

    const dock = await openDock(page, 'tvf3');
    const body = dock.getByTestId('tv-librarian-face-body');
    await body.getByTestId('tv-view-list').click();
    // One-channel country again — see FR_CHANNELS.
    await body.getByTestId('tv-country-select').selectOption('FR');
    await body.getByTestId('tv-channel').first().click();
    await expect(body.getByTestId('tv-preview')).toHaveAttribute('aria-label', /Mock Solo France/);

    await page
      .locator('[data-testid="dock-fullview-pane"][data-pane-node="tvf3"]')
      .getByTestId('faceplate-close')
      .click();
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);
    await expect(page.getByTestId('tv-librarian-face-body')).toHaveCount(0);
    await expect(page.getByTestId('tv-librarian-card')).toHaveCount(0);

    // ⚠ NOW NOTHING IS MOUNTED FOR THIS NODE AT ALL, which is the arrangement
    // that used to leave this module DEAD rather than degraded (no attach, no CV
    // poll, no selection effect — #2209). The selection is the NODE's, so it is
    // still there, and re-opening the dock shows the same station rather than
    // the empty state.
    const stillTuned = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { channel?: { name?: string } } }> };
      };
      return w.__patch.nodes['tvf3']?.data?.channel?.name ?? null;
    });
    expect(stillTuned).toBe('Mock Solo France');

    const reopened = await openDock(page, 'tvf3');
    await expect(reopened.getByTestId('tv-preview')).toHaveAttribute(
      'aria-label',
      /Mock Solo France/,
    );
    await expect(reopened.getByTestId('tv-empty')).toHaveCount(0);
  });
});
