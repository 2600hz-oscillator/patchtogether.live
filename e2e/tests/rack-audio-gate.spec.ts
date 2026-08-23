// e2e/tests/rack-audio-gate.spec.ts
//
// THE /rack AUDIO GATE (#1826) — the default route booted NO engine and showed
// NO prompt: without a gesture the AudioContext cannot start (autoplay
// policy), and unlike /r/[id] nothing on /rack said so. The fix mounts the
// same AudioGate overlay /r/[id] uses — SUPPRESSED under webdriver so the
// /rack e2e fixture population (which boots this route and clicks
// immediately) is untouched, with `window.__ptRackAudioGate = true` as the
// opt-in this spec uses to exercise the real-user path.
//
// Two legs, and the SECOND is the one protecting everyone else:
//  1. Opted in: the overlay is visible at boot, one click resumes+boots the
//     engine (ctx.state === 'running', the recorderbox pattern), and the
//     overlay REMOVES itself (toHaveCount(0) — `{#if}`, not visibility).
//  2. NEGATIVE CONTROL for the suppression: a plain webdriver boot renders NO
//     overlay — the guarantee that no existing /rack spec inherited a
//     click-interceptor from this fix.
//
// What this spec cannot see, stated per the blind-gates rule: it proves the
// overlay's own click boots the engine; whether sound reaches the OUTPUT of a
// patch is the audio suites' subject, not this file's.

import { test, expect } from '@playwright/test';

test.describe('/rack audio gate (#1826)', () => {
  test('opted in: overlay shows at boot, one click boots the engine, overlay removes itself', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ptRackAudioGate?: boolean }).__ptRackAudioGate = true;
    });
    await page.goto('/rack');

    const gate = page.locator('[data-testid="audio-gate"]');
    await expect(gate).toBeVisible();

    await gate.click();

    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __engine?: () => { getDomain?: (d: string) => { ctx?: AudioContext } } | null;
        };
        const ctx = w.__engine?.()?.getDomain?.('audio')?.ctx;
        return ctx?.state === 'running';
      },
      undefined,
      { timeout: 15_000 },
    );

    await expect(gate).toHaveCount(0);
  });

  test('NEGATIVE CONTROL: a plain webdriver boot renders NO overlay — existing /rack specs inherit nothing', async ({
    page,
  }) => {
    await page.goto('/rack');
    // The canvas is up (the route booted normally)…
    await expect(page.locator('.svelte-flow').first()).toBeVisible();
    // …and the gate never mounted: {#if} on the webdriver signal, so there is
    // no node to intercept the first click of any fixture spec.
    await expect(page.locator('[data-testid="audio-gate"]')).toHaveCount(0);
  });
});
