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
//   1. Right-click an ADSR gate INPUT row → "MIDI assign" → inject a NOTE →
//      the binding MATERIALIZES (persisted localStorage record kind:'note',
//      keyed nodeId:portId) + the row shows its bound dot. (ADSR's `gate`
//      input auto-groups to a top-level row and reacts on the injected note;
//      the param-driving chain is proven on the button below.)
//   2. Right-click the LEGACY CARD's SCORE PLAY BUTTON → "MIDI assign" → inject
//      NOTE-on → isPlaying TOGGLES on (a REAL, observable param reaction);
//      inject NOTE-on again → toggles back off. "Forget" drops the binding.
//   3. The SAME binding on the DEFAULT SHELL — see below.
//
// ⚠ LEG 2 DROVE THE PRE-PROMOTION SURFACE, AND AFTER SCORE'S PROMOTION THAT
// MADE IT A TEST OF A COMPATIBILITY SURFACE: the lane decision short-circuited
// before it read the promotion, so it painted the old instrument faced or not.
// It did not go RED on promotion; it went GREEN AND BLIND, which is worse,
// because it would have certified the orphaned-binding defect below as fine. It
// was KEPT at the time (that surface was still real, and a real regression
// class) and RE-TITLED to say what it now proves, and LEG 3 is the one that can
// fail on the bug.
//
// ⚠ WHAT LEG 3 EXISTS FOR — the defect, stated because the affordance itself is
// FINE and that is the trap. `bindingKey` is `${moduleId}:${paramId}`, and the
// card binds under the SYNTHETIC action id `play` (a card button has no backing
// param) while the faceplate's `<Toggle>` binds under the real `isPlaying`. Both
// call the SAME `makeMidiAssignable({kind:'note', controlType:'button'})` factory
// with the same press-edge semantics, so binding a pad and watching the param
// toggle passes on EITHER surface and proves nothing about the migration. Only a
// PRE-EXISTING `<node>:play` record can see it, and bindings persist to
// localStorage with stable node ids, so this is not theoretical.
//
// SIMULATED MIDI: window.__midiTestInjectNote(ch,note,vel) installs an in-memory
// fake MIDIAccess + pushes a NOTE on/off (vel 0 = off) through the same dispatch
// path real hardware uses. Runtime-conscious: pure DOM + injected MIDI, one
// lightweight audio card (DRUMSEQZ) — no DOOM/video/relay.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import type { Page } from '@playwright/test';
import { waitFrames } from '../_helpers/frames';

/**
 * The window a SUSTAINED-NEGATIVE gets: "this note must NOT bind / must NOT
 * toggle". Every such check here is preceded by an assertion that is ALREADY
 * TRUE when the note is injected, so an auto-retrying poll converges instantly
 * and covers nothing — the window itself is the assertion, and it is the only
 * thing giving a would-be re-bind time to happen.
 *
 * FRAMES, not ms, for the usual reason: the 30-40 ms these sites used to spend
 * is ~2 frames on a local GPU and about a QUARTER of one under CI's SwiftShader
 * (7.9 fps measured), so the negative assertion was ~8× weaker on the machine
 * that actually runs it. Four frames is four Svelte flush boundaries on both.
 */
const NO_REBIND_FRAMES = 4;

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

async function bootScore(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));
  await spawnPatch(
    page,
    [{ id: 'ds-1', type: 'score', position: { x: 120, y: 120 }, domain: 'audio', params: { isPlaying: 0 } }],
    [],
  );
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="score"])')).toHaveCount(1);
}

test('MIDI assign: a gate INPUT row binds a NOTE (binding materializes + bound state)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ADSR has a top-level (auto-grouped) `gate` input — its row is directly
  // hittable once the patch panel opens (no nested sections to expand).
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));
  await spawnPatch(
    page,
    [{ id: 'ad-1', type: 'adsr', position: { x: 120, y: 120 }, domain: 'audio', params: {} }],
    [],
  );
  const card = page.locator('.svelte-flow__node:has([data-shell-type="adsr"])');
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
  // ⚠ The poll below is ALREADY TRUE when the note is injected, so it converges
  // instantly and proves nothing on its own — the WINDOW is the assertion. That
  // window has to be renderer-independent: 30 ms was ~2 frames locally and about
  // a QUARTER of one under CI's SwiftShader (7.9 fps measured), i.e. on CI the
  // re-capture had essentially no chance to happen before the check.
  await injectNote(page, 0, 50, 100);
  await waitFrames(page, NO_REBIND_FRAMES);
  await expect.poll(() => readBinding(page, 'ad-1:gate')).toMatchObject({ kind: 'note', note: 48 });

  // NOTE-off must not error (the momentary release path is wired even for a
  // paramTarget-less gate, where driving the engine is a documented no-op).
  await injectNote(page, 0, 48, 0);
  await waitFrames(page, NO_REBIND_FRAMES);

  expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
});

// LEG 2 (the LEGACY CARD's SCORE PLAY button binds a NOTE) was DELETED by the
// S2 inversion: its subject was the compatibility surface itself, which leaves
// the product with the card fleet. The note-toggle press-edge semantics, the
// badge, and the forget path live on in the FACE leg below — including the
// orphaned `<node>:play` record migration, which is the half only the face
// leg could ever fail on.

test('MIDI assign: the FACE\'s isPlaying toggle binds a NOTE, and a saved legacy `:play` record still drives it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ── THE SHIPPING SHELL: the surface a user gets.
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');

  // ⚠ SEED A BINDING UNDER THE **OLD** KEY BEFORE THE FACE EVER MOUNTS. This is
  // the state of every player who bound a pad to SCORE's PLAY before promotion:
  // a valid record, under a key the new control does not look up. Written
  // straight into the persisted store and re-read on boot, exactly as a returning
  // user's browser would.
  await page.evaluate(() =>
    window.localStorage.setItem(
      'pt.midi-bindings.v1',
      JSON.stringify([{ kind: 'note', key: 'ds-1:play', channel: 0, note: 60, learnedAt: 1 }]),
    ),
  );
  await page.reload();
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [{ id: 'ds-1', type: 'score', position: { x: 120, y: 120 }, domain: 'audio', params: { isPlaying: 0 } }],
    [],
  );
  await installSimMidi(page);

  // Open the dock face — the promoted surface.
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
  );
  await page.evaluate(() =>
    (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView('ds-1'),
  );
  const pane = page.locator('[data-testid="dock-full-view"][data-fullview-node="ds-1"]');
  await expect(pane).toBeVisible();

  const toggle = pane.locator('[data-testid="control-isPlaying"]');
  await expect(toggle, 'the face renders isPlaying as a real control').toBeVisible();
  expect(await readParam(page, 'ds-1', 'isPlaying')).toBe(0);

  // ── THE MIGRATION, END TO END. The Toggle mounted and ADOPTED the record; the
  // pad the player bound before promotion drives the face with no user action.
  await expect
    .poll(() => readBinding(page, 'ds-1:isPlaying'), {
      message:
        'a saved `<node>:play` record is re-keyed onto `<node>:isPlaying` when the promoted ' +
        'control mounts — without this the pad is dead and the record sits in localStorage ' +
        'under a key nothing reads',
    })
    .toMatchObject({ kind: 'note', note: 60 });
  await expect
    .poll(() => readBinding(page, 'ds-1:play'), {
      message: 'and it is RE-KEYED, not duplicated — one physical pad, one owner',
    })
    .toBeUndefined();

  await injectNote(page, 0, 60, 110);
  await expect
    .poll(() => readParam(page, 'ds-1', 'isPlaying'), {
      message: 'the adopted binding actually DRIVES the face\'s toggle',
    })
    .toBe(1);

  // NOTE-off does not re-toggle (press edge only) — the window IS the assertion,
  // counted in frames for the reason at the head of this file.
  await injectNote(page, 0, 60, 0);
  await waitFrames(page, NO_REBIND_FRAMES);
  expect(await readParam(page, 'ds-1', 'isPlaying')).toBe(1);

  // A second NOTE-on toggles back off.
  await injectNote(page, 0, 60, 110);
  await expect.poll(() => readParam(page, 'ds-1', 'isPlaying')).toBe(0);

  // ── AND THE FORWARD DIRECTION, THROUGH THE SHIPPED AFFORDANCES: FORGET the
  // adopted binding, then LEARN a new one. The alias must be a one-time
  // migration, not a permanent indirection that re-files every future learn
  // under the old id.
  const menu = page.locator('[data-testid="control-context-menu"]');
  await toggle.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-forget"]').click();
  await expect(menu).toBeHidden();
  await expect.poll(() => readBinding(page, 'ds-1:isPlaying')).toBeUndefined();

  await toggle.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await expect(menu).toBeHidden();
  await injectNote(page, 0, 65, 110);
  await expect
    .poll(() => readBinding(page, 'ds-1:isPlaying'), {
      message: 'a fresh learn on the FACE writes the new key directly',
    })
    .toMatchObject({ kind: 'note', note: 65 });
  await expect
    .poll(() => readBinding(page, 'ds-1:play'), {
      message: 'and never back under the legacy id — the alias is a migration, not an indirection',
    })
    .toBeUndefined();

  expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
});
