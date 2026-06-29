// e2e/tests/blood-keyboard.spec.ts
//
// REAL-BROWSER keyboard-chain coverage for BLOOD — the verification that was
// missing (prior fixes proved the engine receives DIRECT input + that it
// renders, but never the front-end capture→forward chain in a real browser).
//
// Established here:
//   • a FOCUSED BLOOD card forwards keypresses to the engine (pushKeyboardKey) —
//     so clicking the card + arrows/Enter drives the in-game menu (owner-confirmed
//     working). #1 ✅
//   • BLOOD's window-capture no longer CLAIMS keys when the card isn't focused /
//     a text input holds focus (the `.selected`→focus-within fix). #2 (BloodCard
//     part) ✅
//   • CONTROL: the +Add-module palette receives typing with no BLOOD present.
//
// STILL OPEN (the .fixme below): with a BLOOD card RUNNING, the palette search
// receives NO typing even though BLOOD's capture claims nothing (calls:[]) and
// the palette input is focused — i.e. a SECOND cause beyond BloodCard, in the
// running engine (emscripten SDL focus-steal / engine-level key grab). Root
// cause TBD; this test pins the repro so it isn't lost.
//
// Renderer-independent (spies the JS forward + reads input values) → SwiftShader
// safe. Gated on the engine reaching 'ready' + e2e hooks (skips on prod-preview).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

const BLOOD_ID = 'blood-kb';

async function installForwardSpy(page: import('@playwright/test').Page, id: string): Promise<boolean> {
  return page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { read?: (i: string, k: string) => unknown } | null;
      } | null;
      __bloodKbCalls?: string[];
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    const ex = ve?.read?.(nodeId, 'extras') as
      | { pushKeyboardKey?: (code: string, pressed: boolean) => boolean }
      | undefined;
    if (!ex || typeof ex.pushKeyboardKey !== 'function') return false;
    w.__bloodKbCalls = [];
    const orig = ex.pushKeyboardKey.bind(ex);
    ex.pushKeyboardKey = (code: string, pressed: boolean) => {
      if (pressed) w.__bloodKbCalls!.push(code);
      return orig(code, pressed);
    };
    return true;
  }, id);
}

async function spawnBloodReady(page: import('@playwright/test').Page): Promise<boolean> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: BLOOD_ID, type: 'blood', position: { x: 120, y: 80 }, domain: 'video' }],
    [],
  );
  await page.getByTestId('blood-card').waitFor({ state: 'visible', timeout: 10_000 });
  const ready = await page
    .getByTestId('blood-ready')
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  return ready;
}

test('control: +Add-module palette receives typing with NO blood present', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '+ Add module' }).click();
  const inp = page.locator('.module-palette input').first();
  await inp.waitFor({ state: 'visible', timeout: 5_000 });
  await inp.pressSequentially('scope');
  expect(await inp.inputValue()).toBe('scope');
});

test('BLOOD: focused card forwards keys; capture releases when card unfocused', async ({ page }) => {
  const ready = await spawnBloodReady(page);
  test.skip(!ready, 'BLOOD engine did not reach ready (renderer/heap-sensitive on CI)');
  const spied = await installForwardSpy(page, BLOOD_ID);
  test.skip(!spied, 'e2e hooks / runtime extras unavailable (prod-preview)');

  // #1: a focused BLOOD card forwards keypresses to the engine.
  await page.getByTestId('blood-card').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const calls = await page.evaluate(
    () => (globalThis as unknown as { __bloodKbCalls?: string[] }).__bloodKbCalls ?? [],
  );
  expect(calls, 'focused BLOOD card must forward keypresses').toContain('ArrowDown');
  expect(calls).toContain('Enter');

  // #2 (BloodCard part): once a non-card input holds focus, BLOOD claims nothing.
  await page.getByRole('button', { name: '+ Add module' }).click();
  await page.locator('.module-palette input').first().waitFor({ state: 'visible', timeout: 5_000 });
  await page.evaluate(
    () => ((globalThis as unknown as { __bloodKbCalls?: string[] }).__bloodKbCalls = []),
  );
  await page.keyboard.press('KeyS'); // a MAPPED BLOOD key — must NOT be claimed now
  const claimed = await page.evaluate(
    () => (globalThis as unknown as { __bloodKbCalls?: string[] }).__bloodKbCalls ?? [],
  );
  expect(claimed, 'BLOOD must not claim keys while a text input is focused').toEqual([]);
});

// OPEN BUG (owner-reported, repro PINNED): with BLOOD RUNNING, the +Add-module
// palette receives NO typing — even though BloodCard claims nothing (proven in
// the test above: calls:[]) and the palette input is focused. ROOT CAUSE: the
// emscripten SDL build grabs document-wide keydowns and preventDefault()s them
// while the engine runs (blood.js JSEvents). Setting Module.keyboardListening-
// Element off `document` did NOT neutralize it (this SDL build re-binds document
// regardless), so the real fix is build-level (disable SDL keyboard capture —
// input already reaches the engine via bpt_set_key) or stripping the JSEvents
// keyboard registration. Tracked here until then.
test.fixme('BLOOD running: +Add-module palette still receives typing', async ({ page }) => {
  const ready = await spawnBloodReady(page);
  test.skip(!ready, 'engine not ready');
  await page.getByTestId('blood-card').click();
  await page.getByRole('button', { name: '+ Add module' }).click();
  const inp = page.locator('.module-palette input').first();
  await inp.waitFor({ state: 'visible', timeout: 5_000 });
  await inp.pressSequentially('scope');
  expect(await inp.inputValue()).toBe('scope');
});
