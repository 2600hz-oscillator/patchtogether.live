// e2e/tests/midi-learn-note.spec.ts
//
// MIDI assign for GATE INPUTS + card BUTTONS (WORKSTREAM B) — the NOTE analogue
// of midi-learn.spec.ts (which covers the CC knob/fader path).
//
// A gate/trigger INPUT row and a card BUTTON bind to a MIDI NOTE (not a CC):
// "MIDI assign" → inject the next NOTE on any channel → lock to it. NOTE-on →
// gate high / button press; NOTE-off → gate low / release (momentary).
//
// Coverage (behavior-first, definite states — not mere visibility):
//   1. Right-click a HYDROGEN gate INPUT row ("PLAY" transport CV) → "MIDI
//      assign" → inject a NOTE → the binding MATERIALIZES (persisted localStorage
//      record kind:'note', keyed nodeId:portId) + the row shows its bound dot.
//      (HYDROGEN's transport-CV gate declares no paramTarget, so per the decided
//      defaults this is the documented no-op-injection case — the BINDING still
//      materializes; the param-driving chain is proven on the button below.)
//   2. Right-click the HYDROGEN PLAY BUTTON → "MIDI assign" → inject NOTE-on →
//      isPlaying TOGGLES on (a REAL, observable param reaction); inject NOTE-on
//      again → toggles back off. "Forget" drops the binding (notes stop driving).
//
// SIMULATED MIDI: window.__midiTestInjectNote(ch,note,vel) installs an in-memory
// fake MIDIAccess + pushes a NOTE on/off (vel 0 = off) through the same dispatch
// path real hardware uses. Runtime-conscious: pure DOM + injected MIDI, one
// lightweight audio card (HYDROGEN) — no DOOM/video/relay.

import { test, expect } from '@playwright/test';
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

/** The persisted MIDI binding (CC or NOTE) for a key, read from localStorage. */
async function readBinding(page: Page, key: string): Promise<{ kind?: string; note?: number; cc?: number } | undefined> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem('pt.midi-bindings.v1');
    if (!raw) return undefined;
    try {
      const arr = JSON.parse(raw) as Array<{ key: string; kind?: string; note?: number; cc?: number }>;
      return arr.find((b) => b.key === key);
    } catch {
      return undefined;
    }
  }, key);
}

/** Install the simulated MIDI device so beginNoteLearn()'s connect() resolves
 *  against it instead of the real navigator.requestMIDIAccess() (which prompts /
 *  can hang in headless). The NOTE + CC sim devices share one fake MIDIAccess. */
async function installSimMidi(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (globalThis as unknown as {
    __midiTestInstall?: () => boolean;
  }).__midiTestInstall === 'function');
  await page.evaluate(() => {
    (globalThis as unknown as { __midiTestInstall: () => boolean }).__midiTestInstall();
  });
}

/** Inject a NOTE (velocity 0 = note-off) via the dev-only simulated-MIDI hook. */
async function injectNote(page: Page, channel: number, note: number, velocity: number): Promise<void> {
  await page.evaluate(
    ({ channel, note, velocity }) => {
      const w = globalThis as unknown as {
        __midiTestInjectNote?: (c: number, n: number, v: number) => boolean;
      };
      if (typeof w.__midiTestInjectNote !== 'function') {
        throw new Error('__midiTestInjectNote hook not present — DEV build expected');
      }
      w.__midiTestInjectNote(channel, note, velocity);
    },
    { channel, note, velocity },
  );
}

async function bootHydrogen(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));
  await spawnPatch(
    page,
    [{ id: 'hy-1', type: 'hydrogen', position: { x: 120, y: 120 }, domain: 'audio', params: { isPlaying: 0 } }],
    [],
  );
  await expect(page.locator('.svelte-flow__node-hydrogen')).toHaveCount(1);
}

test('MIDI assign: a gate INPUT row binds a NOTE (binding materializes + bound state)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ADSR has a top-level (auto-grouped) `gate` input — its row is directly
  // hittable once the patch panel opens (no nested sections to expand).
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));
  await spawnPatch(
    page,
    [{ id: 'ad-1', type: 'adsr', position: { x: 120, y: 120 }, domain: 'audio', params: {} }],
    [],
  );
  const card = page.locator('.svelte-flow__node-adsr');
  await expect(card).toHaveCount(1);
  await installSimMidi(page);

  // Open the patch panel + drill into INPUT. Under the patch-menu redesign the
  // port ROWS live in the PORTALED chrome (appended to <body>, keyed by
  // data-patch-panel-chrome=nodeId) — NOT inline in the card — and are reached
  // by clicking the INPUT nav pivot (overlay-replace). The gate-assignable
  // right-click affordance was re-applied onto those overlay rows.
  await card.locator('[data-testid="patch-trigger"]').first().click();
  const chrome = page.locator('[data-patch-panel-chrome="ad-1"]');
  await expect(chrome).toHaveAttribute('aria-hidden', 'false');
  await chrome.locator('[data-testid="patch-panel-nav"][data-nav="inputs"]').click();
  // The gate row is the .gate-assignable <li> whose port row carries the gate
  // port id. ADSR's `gate` input auto-groups to a top-level row.
  const gateRow = chrome
    .locator('li.panel-row.gate-assignable')
    .filter({ has: page.locator('[data-testid="patch-panel-port-row"][data-port-id="gate"]') });
  await expect(gateRow).toHaveCount(1);

  // Right-click the gate row's label (the visible target) → control menu.
  await gateRow.locator('[data-testid="port-row-label"]').click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await expect(menu).toBeHidden();

  // Inject a NOTE — the binding for ad-1:gate materializes as kind:'note'.
  await injectNote(page, 0, 48, 100);
  await expect
    .poll(() => readBinding(page, 'ad-1:gate'))
    .toMatchObject({ kind: 'note', note: 48 });

  // The row reflects its bound state (definite DOM state attribute).
  await expect(gateRow).toHaveAttribute('data-gate-midi-bound', 'true');

  // A NOTE on a DIFFERENT note must NOT bind / re-capture (binding stays note 48).
  await injectNote(page, 0, 50, 100);
  await page.waitForTimeout(30);
  await expect.poll(() => readBinding(page, 'ad-1:gate')).toMatchObject({ kind: 'note', note: 48 });

  // NOTE-off must not error (the momentary release path is wired even for a
  // paramTarget-less gate, where driving the engine is a documented no-op).
  await injectNote(page, 0, 48, 0);
  await page.waitForTimeout(30);

  expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
});

test('MIDI assign: a card BUTTON (HYDROGEN PLAY) binds a NOTE that TOGGLES the param', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await bootHydrogen(page);
  const card = page.locator('.svelte-flow__node-hydrogen');
  await installSimMidi(page);

  // The PLAY button is wrapped by MidiAssignButton; the inner button carries
  // data-testid="hydrogen-play". Right-click the wrapper (the button surface).
  const playBtn = card.locator('[data-testid="hydrogen-play"]');
  await expect(playBtn).toHaveCount(1);
  expect(await readParam(page, 'hy-1', 'isPlaying')).toBe(0);

  await playBtn.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await expect(menu).toBeHidden();

  // Inject NOTE-on → the bound toggle fires once → isPlaying flips to 1.
  await injectNote(page, 0, 60, 110);
  await expect.poll(() => readParam(page, 'hy-1', 'isPlaying')).toBe(1);
  // The button shows its bound badge.
  await expect(card.locator('[data-testid="hydrogen-play"]').locator('xpath=ancestor::*[contains(@class,"midi-assign-button")]').locator('.midi-badge')).toContainText('NOTE 60');

  // A NOTE-off does NOT re-toggle (toggle fires on the press edge only).
  await injectNote(page, 0, 60, 0);
  await page.waitForTimeout(30);
  expect(await readParam(page, 'hy-1', 'isPlaying')).toBe(1);

  // A second NOTE-on toggles back off.
  await injectNote(page, 0, 60, 110);
  await expect.poll(() => readParam(page, 'hy-1', 'isPlaying')).toBe(0);

  // A NOTE on a DIFFERENT note must NOT toggle.
  await injectNote(page, 0, 61, 110);
  await page.waitForTimeout(40);
  expect(await readParam(page, 'hy-1', 'isPlaying')).toBe(0);

  // Forget the binding → subsequent NOTE-ons no longer drive the toggle.
  await playBtn.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-forget"]').click();
  await expect(menu).toBeHidden();
  await injectNote(page, 0, 60, 110);
  await page.waitForTimeout(40);
  expect(await readParam(page, 'hy-1', 'isPlaying')).toBe(0);

  expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
});
