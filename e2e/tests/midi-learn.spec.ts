// e2e/tests/midi-learn.spec.ts
//
// MIDI Learn — first-class right-click → learn → CC-drives-param flow.
//
// Exercises the full UX with a SIMULATED MIDI device (no hardware, no Web
// MIDI permission prompt): the dev-only `window.__midiTestInject(ch,cc,val)`
// hook installs an in-memory fake MIDIAccess and pushes Control-Change
// messages through the same dispatch path real hardware uses.
//
// Coverage (ONE focused spec — the static audit test covers breadth across
// every module; this proves the runtime path on representative modules):
//   1. Plain right-click on a Knob (WAVECEL · Morph) opens the control menu.
//   2. "MIDI Learn" → inject CC → knob binds + the param jumps to the CC value.
//   3. The on-screen knob renders its bound-state badge ("CC n").
//   4. Further CCs track the param (knob follows the controller).
//   5. "Forget MIDI" removes the binding (badge gone, CCs no longer drive it).
//   6. A Fader (CALLSINE · Level) learns + tracks the same way.
//
// Runtime-conscious: pure DOM + injected MIDI. No extra WASM, relay, or audio
// graph beyond the one card each test already spawns.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

/** Read a node param from the live patch graph. */
async function readParam(page: Page, nodeId: string, paramId: string): Promise<number | undefined> {
  return page.evaluate(
    ({ nodeId, paramId }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch?.nodes?.[nodeId]?.params?.[paramId];
    },
    { nodeId, paramId },
  );
}

/** Install the simulated MIDI device so beginLearn()'s connect() resolves
 *  against it (instead of the real navigator.requestMIDIAccess). */
async function installSimMidi(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (globalThis as unknown as {
    __midiTestInstall?: () => boolean;
  }).__midiTestInstall === 'function');
  await page.evaluate(() => {
    (globalThis as unknown as { __midiTestInstall: () => boolean }).__midiTestInstall();
  });
}

/** Inject a Control-Change via the dev-only simulated-MIDI hook. */
async function injectCc(page: Page, channel: number, cc: number, value: number): Promise<void> {
  await page.evaluate(
    ({ channel, cc, value }) => {
      const w = globalThis as unknown as {
        __midiTestInject?: (c: number, cc: number, v: number) => boolean;
      };
      if (typeof w.__midiTestInject !== 'function') {
        throw new Error('__midiTestInject hook not present — DEV build expected');
      }
      w.__midiTestInject(channel, cc, value);
    },
    { channel, cc, value },
  );
}

test('MIDI Learn: right-click a knob → learn → CC drives the param + badge shows + tracks', async ({ page, rack, errorWatch }) => {
  // Isolate from any persisted bindings on this dev origin.
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));

  await spawnPatch(
    page,
    [{ id: 'm-wc', type: 'wavecel', position: { x: 120, y: 120 }, domain: 'audio', params: { morph: 0 } }],
    [],
  );

  const card = page.locator('.svelte-flow__node-wavecel');
  await expect(card).toHaveCount(1);
  await installSimMidi(page);

  // The Morph knob — Knob.svelte renders role="slider" aria-label="Morph".
  const morphKnob = card.locator('[role="slider"][aria-label="Morph"]');
  await expect(morphKnob).toHaveCount(1);

  // 1. PLAIN right-click (no Shift) opens the control context menu.
  await morphKnob.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-testid="ctx-midi-learn"]')).toBeVisible();

  // 2. Enter learn mode, then inject a CC — param jumps to the scaled value.
  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await expect(menu).toBeHidden();
  // morph range is [0,1]; CC 64/127 ≈ 0.504.
  await injectCc(page, 0, 21, 64);
  await expect.poll(() => readParam(page, 'm-wc', 'morph')).toBeCloseTo(64 / 127, 2);

  // 3. The knob renders its bound-state badge.
  await expect(card.locator('.midi-badge')).toContainText('CC 21');

  // 4. Further CCs track the param.
  await injectCc(page, 0, 21, 127);
  await expect.poll(() => readParam(page, 'm-wc', 'morph')).toBeCloseTo(1, 2);
  await injectCc(page, 0, 21, 0);
  await expect.poll(() => readParam(page, 'm-wc', 'morph')).toBeCloseTo(0, 2);

  // A CC on a DIFFERENT number must NOT move the bound param.
  await injectCc(page, 0, 99, 127);
  await page.waitForTimeout(50);
  expect(await readParam(page, 'm-wc', 'morph')).toBeCloseTo(0, 2);

  // 5. Forget the binding — right-click → "Forget …". Badge disappears and
  //    subsequent CCs no longer drive the param.
  await morphKnob.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-forget"]').click();
  await expect(card.locator('.midi-badge')).toHaveCount(0);

  await injectCc(page, 0, 21, 127);
  await page.waitForTimeout(50);
  expect(await readParam(page, 'm-wc', 'morph')).toBeCloseTo(0, 2);

});

test('MIDI Learn: a Fader (CALLSINE · Level) learns + tracks via simulated CC', async ({ page, rack, errorWatch }) => {
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));

  await spawnPatch(
    page,
    [{ id: 'm-cs', type: 'callsine', position: { x: 120, y: 120 }, domain: 'audio', params: { level: 0.8 } }],
    [],
  );

  const card = page.locator('.svelte-flow__node-callsine');
  await expect(card).toHaveCount(1);
  await installSimMidi(page);

  // Fader.svelte renders role="slider" aria-label="Level" on the track.
  const levelFader = card.locator('[role="slider"][aria-label="Level"]');
  await expect(levelFader).toHaveCount(1);

  await levelFader.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-learn"]').click();

  // level range [0,1]; CC 32 → 32/127 ≈ 0.252.
  await injectCc(page, 0, 7, 32);
  await expect.poll(() => readParam(page, 'm-cs', 'level')).toBeCloseTo(32 / 127, 2);
  await expect(card.locator('.midi-badge')).toContainText('CC 7');

  // Track upward.
  await injectCc(page, 0, 7, 100);
  await expect.poll(() => readParam(page, 'm-cs', 'level')).toBeCloseTo(100 / 127, 2);

});

test('MIDI Learn: the control menu spawns under the cursor (portalled out of the transformed canvas)', async ({ page, rack, errorWatch }) => {
  // Regression: the menu lives inside a SvelteFlow node, and `.svelte-flow__viewport`
  // always has a CSS `transform` (pan/zoom) → it is the containing block for the
  // menu's `position: fixed`. Without portalling the menu to <body>, its
  // cursor-anchored left/top get interpreted in the transformed/scaled canvas
  // space, so it lands in the wrong spot (and drifts as you pan/zoom). After the
  // portal fix the menu must appear AT the click point regardless of viewport
  // transform.

  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));

  await spawnPatch(
    page,
    [{ id: 'm-wc', type: 'wavecel', position: { x: 160, y: 160 }, domain: 'audio', params: { morph: 0 } }],
    [],
  );
  const card = page.locator('.svelte-flow__node-wavecel');
  await expect(card).toHaveCount(1);

  const morphKnob = card.locator('[role="slider"][aria-label="Morph"]');
  await expect(morphKnob).toHaveCount(1);

  // Right-click the knob (Playwright clicks its centre = the cursor anchor).
  await morphKnob.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();

  // STRUCTURAL GUARANTEE (the actual fix): the menu must be portalled out to
  // <body>, NOT left inside the SvelteFlow node. `.svelte-flow__viewport`
  // always carries a CSS transform (pan/zoom), which would make it the
  // containing block for the menu's `position: fixed` and throw the
  // cursor-anchored placement off (the "weird spot" the user saw — worse the
  // more you pan/zoom). Portalling to <body> removes the transformed ancestor
  // so fixed-positioning resolves against the real viewport.
  const parentIsBody = await menu.evaluate(
    (el) => el.parentElement?.parentElement === document.body,
  );
  expect(parentIsBody, 'menu must be portalled to document.body').toBe(true);

  // POSITION: the menu's top-left sits at the cursor (the knob centre). Even
  // the canvas's resting `translate(...) scale(1)` viewport transform offsets
  // a non-portalled menu by the flow container's on-screen origin (it lives
  // below the top toolbar), so this distinguishes the fix from the bug at
  // rest. Read the knob box AFTER the menu opens (nothing moves on open).
  const kb = await morphKnob.boundingBox();
  const mb = await menu.boundingBox();
  if (!kb || !mb) throw new Error('no box');
  const cursorX = kb.x + kb.width / 2;
  const cursorY = kb.y + kb.height / 2;
  expect(Math.abs(mb.x - cursorX), `menu x ${mb.x} should ≈ knob-centre x ${cursorX}`).toBeLessThanOrEqual(10);
  expect(Math.abs(mb.y - cursorY), `menu y ${mb.y} should ≈ knob-centre y ${cursorY}`).toBeLessThanOrEqual(10);

});
