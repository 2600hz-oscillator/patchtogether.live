// e2e/tests/videovarispeed-switch.spec.ts
//
// VIDEOVARISPEED 7-slot SWITCH-PATH regression guard (the multi-slot stall).
//
// THE BUG (owner report): load N videos → after a brief time only the first
// frame shows + play/pause go dead. Root cause: the engine's single shared
// audio keep-alive was torn down + re-created on every slot switch, colliding
// with two Chromium behaviours — createMediaElementSource is once-per-element-
// permanent (a 2nd call throws InvalidStateError) and a hidden, non-audio-pulled
// <video> decode-throttles to ~1 fps. So after ONE slot cycle every switched-
// away slot froze on frame 0 and a later re-select threw + never recovered.
//
// The pre-fix output spec (videovarispeed-output.spec.ts) is SINGLE-slot only —
// it never exercised a switch, so the bug shipped. This spec drives the REAL
// source chain (clip player → asset_pitch/asset_gate → videovarispeed), loads
// ≥2 slots, then switches A → B → BACK to A and asserts the fix:
//
//   1. frames keep advancing after EACH switch (engine uploadCount climbs),
//   2. the `[videovarispeed] createMediaElementSource failed` warning NEVER
//      fires (the smoking gun of the re-create-on-switch throw),
//   3. play/pause works AFTER a switch (toggle → isPlaying + frames advance/halt),
//   4. switch-BACK-to-A lands near A's projected LIVE time, NOT 0 (the virtual
//      playhead, not currentTime=0).
//
// CAPABILITY GATE: CI runs the SwiftShader software renderer + has no OS H.264
// encoder, so a flat downstream-PIXEL/brightness assert that passes on a real
// GPU goes red on CI (the capability-dependent-e2e standard). This spec is
// therefore RENDERER-INDEPENDENT BY CONSTRUCTION — the frame-advance proof uses
// the engine's uploadCount hook (a texImage2D counter; works on SwiftShader, no
// pixel sampling) and the rest assert DOM / engine-hook / <video> state. No
// canvas pixels are ever read, so it runs in the PARALLEL sharded matrix, NOT
// the serialized real-GPU heavy lane (see e2e/webgl-heavy-globs.ts
// WEBGL_HEAVY_EXCLUDE — same classification as videovarispeed-perfzip).
//
// The optional decode-brightness check is intentionally OMITTED: uploadCount
// already proves the decode→upload path is live after every switch on any
// renderer, and a brightness read would (a) need a real-GPU capability gate and
// (b) drag the spec onto the heavy lane for no extra coverage.
//
// Fixture: the small committed av-clip.webm (has an audio track so the audio
// keep-alive path is real).

import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const AV_FIXTURE = fileURLToPath(new URL('../fixtures/av-clip.webm', import.meta.url));

const VVS_ID = 'sw-vvs';
const CLIP_ID = 'sw-clip';
const OUT_ID = 'sw-out';

// V/oct for the asset-selector slots (0V = C4 = MIDI 60; slot i = ASSET_SLOT_NOTES[i]).
// slot 0 = C3 (MIDI 48) → (48-60)/12 = -1.0 ; slot 1 = D3 (MIDI 50) → -0.8333.
const SLOT0_VOCT = (48 - 60) / 12;
const SLOT1_VOCT = (50 - 60) / 12;

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

/** Read an engine `read(node, key)` value for the VVS video node. */
async function readEngine(page: Page, key: string): Promise<unknown> {
  return await page.evaluate(({ id, key }) => {
    const w = globalThis as unknown as {
      __engine?: () => { read?: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
    };
    const eng = w.__engine?.();
    return eng?.read?.({ id, type: 'videovarispeed', domain: 'video' }, key);
  }, { id: VVS_ID, key });
}

async function uploadCount(page: Page): Promise<number> {
  const v = await readEngine(page, 'uploadCount');
  return typeof v === 'number' ? v : -1;
}

/** Fire the asset selector through the REAL CV-bridge entry point: set the raw
 *  asset_pitch V/oct, then pulse asset_gate 1→0 — exactly the path a clip
 *  player's note+gate takes through the cross-domain bridge into the card's
 *  edge-detector. (Programming a clip-player grid to emit a deterministic note
 *  at a deterministic time is brittle; the bridge setParam is the same seam.) */
async function switchToSlot(page: Page, voct: number): Promise<void> {
  await page.evaluate(({ id, voct }) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { setParam?: (n: string, p: string, v: number) => void } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    ve?.setParam?.(id, 'asset_pitch', voct); // pick the slot
    ve?.setParam?.(id, 'asset_gate', 1);     // rising edge → switch
    ve?.setParam?.(id, 'asset_gate', 0);     // release → re-arm
  }, { id: VVS_ID, voct });
}

/** Active <video> currentTime / paused (the element the engine is sampling). */
async function activeVideoState(page: Page): Promise<{ time: number; paused: boolean }> {
  const v = page.locator('[data-testid="videovarispeed-video"]');
  return await v.evaluate((el) => {
    const ve = el as HTMLVideoElement;
    return { time: ve.currentTime, paused: ve.paused };
  });
}

/** Assert the decode→upload path is LIVE after a switch: uploadCount climbs over
 *  a window. Renderer-independent (a texImage2D counter, not pixels) so it holds
 *  on CI's SwiftShader. THIS is the hard frame-advance proof — a frozen slot
 *  (the bug) leaves uploadCount flat. */
async function assertFramesAdvance(page: Page, label: string): Promise<void> {
  const start = await uploadCount(page);
  expect(start, `${label}: uploadCount readable`).toBeGreaterThanOrEqual(0);
  await expect
    .poll(async () => (await uploadCount(page)) - start, {
      timeout: 8000,
      message: `${label}: engine frame uploads must climb after the switch (was ${start})`,
    })
    .toBeGreaterThanOrEqual(2);
}

/** Load `file` into VVS slot `slot` via the REAL card pickers. Slot 0 = main
 *  picker; slots 1..6 = the "Load multiple…" panel. */
async function loadSlot(page: Page, slot: number): Promise<void> {
  const card = page.locator(`.svelte-flow__node[data-id="${VVS_ID}"]`);
  if (slot === 0) {
    await card.locator('[data-testid="videovarispeed-file-input"]').setInputFiles(AV_FIXTURE);
    await expect(card.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-has-local-file', 'true', { timeout: 10000 },
    );
    return;
  }
  // dispatchEvent (not .click): the card repaints from its transport rAF so
  // Playwright's actionability "stable" check never settles (same as perfzip).
  await card.locator('[data-testid="videovarispeed-card"]').dispatchEvent('contextmenu');
  await expect(card.locator('[data-testid="videovarispeed-multi-panel"]')).toBeVisible({ timeout: 5000 });
  await card.locator(`[data-testid="videovarispeed-slot-input-${slot}"]`).setInputFiles(AV_FIXTURE);
  await expect(card.locator(`[data-testid="videovarispeed-slot-${slot}"]`))
    .toHaveAttribute('data-slot-local', 'true', { timeout: 10000 });
  // Close the panel so it doesn't overlay the transport controls.
  await card.locator('[data-testid="videovarispeed-multi-close"]').dispatchEvent('click');
  // The synthetic contextmenu that opened the panel ALSO pops the global
  // selection context-menu backdrop (onCardContextMenu preventDefaults but does
  // NOT stopPropagation, so the event bubbles to the pane). That full-screen
  // .ctx-overlay lingers after multi-close and intercepts later transport
  // clicks — dismiss it (it closes on click, onclick={onclose}).
  const overlay = page.locator('.ctx-overlay');
  if ((await overlay.count()) > 0) {
    await overlay.first().click();
    await expect(overlay).toHaveCount(0, { timeout: 4000 });
  }
}

test.describe('VIDEOVARISPEED 7-slot switch path (multi-slot stall regression)', () => {
  test('A → B → back-to-A keeps decoding + play/pause alive; switch-back lands on live time', async ({ page }) => {
    const errors = await setup(page);
    // Capture ONLY the smoking-gun warning separately so we can assert it never
    // fired regardless of other (benign) console noise.
    const keepAliveWarnings: string[] = [];
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[videovarispeed] createMediaElementSource failed')) keepAliveWarnings.push(t);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // REAL source chain: clip player → asset_pitch/asset_gate → videovarispeed,
    // VVS video → VIDEO-OUT. The clip-player edges prove the real chain wires;
    // the switch itself is fired through the same CV-bridge seam the clip
    // player's note+gate flows through (switchToSlot).
    await spawnPatch(page,
      [
        { id: CLIP_ID, type: 'clipplayer', position: { x: 40, y: 40 }, domain: 'audio' },
        { id: VVS_ID, type: 'videovarispeed', position: { x: 360, y: 40 }, domain: 'video' },
        { id: OUT_ID, type: 'videoOut', position: { x: 820, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e_pitch', from: { nodeId: CLIP_ID, portId: 'pitch1' }, to: { nodeId: VVS_ID, portId: 'asset_pitch' }, sourceType: 'polyPitchGate', targetType: 'pitch' },
        { id: 'e_gate', from: { nodeId: CLIP_ID, portId: 'gate1' }, to: { nodeId: VVS_ID, portId: 'asset_gate' }, sourceType: 'gate', targetType: 'gate' },
        { id: 'e_vid', from: { nodeId: VVS_ID, portId: 'video' }, to: { nodeId: OUT_ID, portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // Load slot 0 (C) + slot 1 (D) via the real pickers.
    await loadSlot(page, 0);
    await loadSlot(page, 1);

    // Start playback (loop default) + let slot 0 (active) advance a bit so its
    // virtual playhead is well past 0 before we switch away.
    await page.click('[data-testid="videovarispeed-play-btn"]');
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-is-playing', 'true', { timeout: 4000 },
    );
    await page.waitForTimeout(800);
    const aTimeBeforeSwitch = (await activeVideoState(page)).time;

    // --- SWITCH A → B (slot 0 → slot 1) ---
    await switchToSlot(page, SLOT1_VOCT);
    await expect.poll(async () => readEngine(page, 'hasVideoElement'), { timeout: 4000 }).toBe(true);
    await assertFramesAdvance(page, 'after A→B');

    // --- SWITCH B → BACK to A (slot 1 → slot 0) ---
    await page.waitForTimeout(600); // let B's playhead + A's VIRTUAL playhead advance
    await switchToSlot(page, SLOT0_VOCT);
    await assertFramesAdvance(page, 'after B→A (re-select must NOT throw + freeze)');

    // (4) Switch-BACK to A landed near A's PROJECTED live time, NOT 0 (the
    // virtual playhead). A kept advancing virtually while B was active, so it
    // must be at LEAST where it was when we switched away (minus a small seek
    // tolerance) — emphatically not reset to ~0.
    const aTimeAfterReturn = (await activeVideoState(page)).time;
    expect(
      aTimeAfterReturn,
      `switch-back landed on A's live time (~>=${aTimeBeforeSwitch.toFixed(2)}s), not 0 (was ${aTimeAfterReturn.toFixed(2)}s)`,
    ).toBeGreaterThan(Math.max(0.2, aTimeBeforeSwitch - 0.5));

    // (3) Play/pause works AFTER the switches: pause halts, play resumes.
    await page.click('[data-testid="videovarispeed-play-btn"]'); // → pause
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-is-playing', 'false', { timeout: 4000 },
    );
    await expect.poll(async () => (await activeVideoState(page)).paused, { timeout: 4000 }).toBe(true);

    await page.click('[data-testid="videovarispeed-play-btn"]'); // → play again
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-is-playing', 'true', { timeout: 4000 },
    );
    await assertFramesAdvance(page, 'play AFTER a switch resumes frame advance');

    // (2) The keep-alive smoking gun NEVER fired across the whole sequence.
    expect(
      keepAliveWarnings,
      `createMediaElementSource must NEVER fail across switches: ${keepAliveWarnings.join(' | ')}`,
    ).toEqual([]);

    // Every loaded slot kept a persistent keep-alive (none torn down on switch):
    // exactly 2 distinct elements wired across all the A↔B churn.
    await expect.poll(async () => readEngine(page, 'keepAliveCount'), { timeout: 4000 }).toBe(2);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
