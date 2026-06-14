// e2e/tests/tv-librarian.spec.ts
//
// TV LIBRARIAN — NETWORK-MOCKED flow. We NEVER hit live famelack/streams in CI
// (flaky + legally cleaner): every famelack request is route-fulfilled with
// fixture JSON, and the HLS .m3u8 is fulfilled with a tiny stub. This drives
// the REAL source chain — runtime dataset fetch → parse → country list →
// channel list → select → hls.js attach → card reaction — without a live
// decoder (a real H.264 frame can't be asserted on CI's SwiftShader / no-OS-
// encoder; the deterministic-frame path is covered by the validated Phase-0
// spike + the pure-core unit tests).
import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

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
  {
    // youtube-only → filtered out of the playable list (must NOT appear).
    nanoid: 'usa3', name: 'Mock Tube USA',
    stream_urls: [], youtube_urls: ['https://youtube.com/embed/x'],
    languages: ['eng'], country: 'us', isGeoBlocked: false,
  },
];

// A trivially-empty HLS manifest. hls.js will fail to find playable media →
// the card's fatal-error path marks the stream "unavailable" (which is exactly
// what we want to assert: a dead/unsupported stream NEVER hangs the card).
const STUB_M3U8 = '#EXTM3U\n#EXT-X-ENDLIST\n';

async function installMocks(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/famelack-data/**/countries_metadata.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META) }),
  );
  await page.route('**/famelack-data/**/countries/us.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(US_CHANNELS) }),
  );
  await page.route('**/famelack-data/**/countries/fr.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  // Any .m3u8 → the stub manifest (no live stream contacted).
  await page.route('**/*.m3u8', (route) =>
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: STUB_M3U8 }),
  );
}

test.describe('TV LIBRARIAN — network-mocked source chain', () => {
  test('country list → channel list → select → card reacts; geo marked; youtube-only filtered @video', async ({ page }) => {
    await installMocks(page);
    await page.goto('/');
    await spawnPatch(page, [{ id: 'tv1', type: 'tvLibrarian', domain: 'video' }]);

    const card = page.getByTestId('tv-librarian-card');
    await expect(card).toBeVisible();

    // Switch to the deterministic country LIST view (the map needs pixel clicks).
    await page.getByTestId('tv-view-list').click();
    const select = page.getByTestId('tv-country-select');
    await expect(select).toBeVisible();
    // Countries populated from the mocked metadata (sorted by name).
    await expect(select.locator('option[value="US"]')).toHaveCount(1);
    await expect(select.locator('option[value="FR"]')).toHaveCount(1);

    // Pick the US → its channels load from the mocked country file.
    await select.selectOption('US');
    const channels = page.getByTestId('tv-channel');
    // 2 playable (usa1, usa2); the youtube-only usa3 is filtered out.
    await expect(channels).toHaveCount(2);
    await expect(page.getByText('Mock News USA')).toBeVisible();
    await expect(page.getByText('Mock Sports USA')).toBeVisible();
    await expect(page.getByText('Mock Tube USA')).toHaveCount(0);
    // The geo-blocked channel is MARKED (legal posture: honored + visible).
    await expect(card.locator('.chan .badge.geo')).toHaveCount(1);

    // Select a channel → it persists to now-playing + the stream attaches (to
    // the stub manifest). Because the stub has no playable media, the card
    // resolves to "unavailable" (never hangs) — that's the graceful path.
    await page.getByTestId('tv-channel').first().click();
    await expect(page.getByTestId('tv-now-playing')).toContainText('Mock News USA');

    // The disclaimer + attribution are present (legal mitigation requirement).
    await expect(page.getByTestId('tv-disclaimer')).toBeVisible();
    await expect(card.getByText('Famelack')).toBeVisible();

    // No live network was contacted: the page never resolved a real famelack
    // host (all routes were fulfilled). Card stays responsive (no hang): within
    // the timeout it reaches a terminal stream state, never stuck on "tuning".
    await expect(card).toHaveAttribute('data-stream-state', /unavailable|playing/, { timeout: 15000 });
  });

  test('selecting persists channel to node.data (syncs to rack-mates) @video', async ({ page }) => {
    await installMocks(page);
    await page.goto('/');
    await spawnPatch(page, [{ id: 'tv2', type: 'tvLibrarian', domain: 'video' }]);

    await page.getByTestId('tv-view-list').click();
    await page.getByTestId('tv-country-select').selectOption('US');
    await page.getByTestId('tv-channel').first().click();

    // node.data carries the selected channel (name + url) so peers tune too.
    const persisted = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { channel?: { name?: string; streamUrl?: string }; countryCode?: string } }> } };
      return w.__patch.nodes['tv2']?.data ?? null;
    });
    expect(persisted?.countryCode).toBe('US');
    expect(persisted?.channel?.name).toBe('Mock News USA');
    expect(persisted?.channel?.streamUrl).toContain('.m3u8');
  });
});
