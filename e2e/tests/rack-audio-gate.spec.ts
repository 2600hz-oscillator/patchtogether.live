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
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot waits with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget they were running inside. 2 sites, 1.00x, and the
// overlay test declares BOOT_MS + 15 000 = 45 000 ms of tolerance in it.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

test.describe('/rack audio gate (#1826)', () => {
  test('opted in: overlay shows at boot, one click boots the engine, overlay removes itself', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ptRackAudioGate?: boolean }).__ptRackAudioGate = true;
    });
    await page.goto('/rack');

    const gate = page.locator('[data-testid="audio-gate"]');
    // BOUND, not an assertion: the claim is that the overlay is THERE, never
    // that it paints within some interval. This is a BOOT / first-paint
    // subject — the overlay mounts on hydration of a cold route — so it takes
    // BOOT_MS like every other one (#1875). Measured on the merge of #2145:
    // against Playwright's invisible 5000 ms expect default, a cold server
    // put first paint at 5.2 s (pass) and 5.4 s (FAIL) on a fast dev box, so
    // the default sat exactly ON the cost. ⚠ And under `E2E_SWIFTSHADER=1`,
    // the renderer CI actually uses, even the WARM iterations measured
    // 4.5-4.8 s — i.e. the default was ~200 ms from red on every CI run, not
    // only cold ones. The 2-core CI VM is slower still.
    await expect(gate).toBeVisible({ timeout: BOOT_MS });

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
    // The canvas is up (the route booted normally)… same BOOT bound and the
    // same reason: this leg's subject is the cold route coming up at all.
    await expect(page.locator('.svelte-flow').first()).toBeVisible({ timeout: BOOT_MS });
    // …and the gate never mounted: {#if} on the webdriver signal, so there is
    // no node to intercept the first click of any fixture spec.
    await expect(page.locator('[data-testid="audio-gate"]')).toHaveCount(0);
  });
});
