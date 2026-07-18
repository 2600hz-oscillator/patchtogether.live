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
// it never exercised a switch, so the bug shipped. This spec loads ≥2 slots,
// then switches A → B → BACK to A — injecting each switch at the card's
// asset-select param seam (switchToSlot, the exact param the CV bridge writes)
// rather than through an idle clip player whose bridge would clobber it (see the
// spawnPatch note) — and asserts the fix:
//
//   1. frames keep advancing after EACH switch (engine uploadCount climbs),
//   2. the `[videovarispeed] createMediaElementSource failed` warning NEVER
//      fires (the smoking gun of the re-create-on-switch throw),
//   3. play/pause works AFTER a switch (toggle → isPlaying + frames advance/halt),
//   4. switch-BACK-to-A lands on A's PRESERVED virtual playhead, NOT reset to 0.
//      This compares two reads of the SAME engine-internal frame-time clock —
//      slot A's tracked virtual playhead (slotPos) just BEFORE the switch vs the
//      element's currentTime just AFTER — with a mid-clip play window confining
//      both, so it is load-INDEPENDENT (no wall-clock projection to lag under CI
//      SwiftShader). See the assertion block for the geometry.
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

// --- CI SwiftShader timeout scaling ------------------------------------------
// Since #1095 this spec drives a REAL slot switch with actual H.264 decode (it
// was vacuous before). That decode is CPU-heavy under the SwiftShader software
// renderer, and CI runs this spec on the functional sharded matrix with up to
// ~24 parallel SwiftShader browsers co-tenanting the runner, so the page main
// thread is saturated — the render itself COMPLETES, it's just slow. The flat
// 30s Playwright test timeout (and the tight per-poll/per-action ceilings below)
// then aren't enough for page.click / page.evaluate to resolve under that
// contention (the #1095 rewrite tripped the 30s test timeout on two CI runs).
//
// Inflate every timeout under software rendering — CI (no GPU → SwiftShader for
// free; process.env.CI is always set on the functional shards, which do NOT set
// E2E_SWIFTSHADER) OR a local E2E_SWIFTSHADER=1 flake-check — and keep the fast
// ceilings on a real-GPU local dev run. Same CI-only class as the video
// behavioral timeouts: scale, never flat (memory ci-swiftshader-video-e2e-
// timeouts). Mirrors the per-spec `timeoutFor()` idiom (adsr-poly-midilane /
// sixstrum-poly) but the cost driver here is renderer contention, not audio
// capture windows, so it scales by render mode rather than window count.
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const SLOW_FACTOR = SLOW_RENDER ? 3 : 1;
/** Scale a millisecond timeout for the software-renderer / CI-contention path;
 *  a no-op (×1) on a real-GPU local run so interactive dev stays fast. */
const T = (ms: number): number => ms * SLOW_FACTOR;

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
 *  at a deterministic time is brittle; the bridge setParam is the same seam.)
 *
 *  The gate is HELD high across a gate-loop tick before release: the card
 *  edge-detects asset_gate by POLLING it on a 33ms interval (not synchronously),
 *  so a same-tick 1→0 pulse would never be sampled HIGH and the rising edge —
 *  the switch — would be missed. A real clip-player note holds its gate for a
 *  real duration too, so this matches the source chain. */
async function switchToSlot(page: Page, voct: number): Promise<void> {
  const setGate = (level: number, pitch?: number): Promise<void> =>
    page.evaluate(({ id, level, pitch }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { setParam?: (n: string, p: string, v: number) => void } | null;
        } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      if (typeof pitch === 'number') ve?.setParam?.(id, 'asset_pitch', pitch); // pick the slot
      ve?.setParam?.(id, 'asset_gate', level);
    }, { id: VVS_ID, level, pitch });
  await setGate(1, voct); // rising edge → switch (pitch set on the same call)
  await page.waitForTimeout(80); // hold high across ≥2 of the card's 33ms gate polls
  await setGate(0); // release → re-arm for the next switch
}

/** Active <video> currentTime / paused (the element the engine is sampling). */
async function activeVideoState(page: Page): Promise<{ time: number; paused: boolean }> {
  const v = page.locator('[data-testid="videovarispeed-video"]');
  return await v.evaluate((el) => {
    const ve = el as HTMLVideoElement;
    return { time: ve.currentTime, paused: ve.paused };
  });
}

/** Read the card's engine-internal PER-SLOT VIRTUAL PLAYHEAD (slotPos[]) + the
 *  active slot — the SAME frame-time (rAF) clock the switch-back jump reads
 *  (selectAssetSlot: `next.currentTime = clamp(slotPos[i])`). Exposed by the
 *  card behind the VITE_E2E_HOOKS gate (__vvsVirtualPlayhead). */
async function readVirtualPlayhead(
  page: Page,
): Promise<{ activeSlot: number; slotPos: number[] } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __vvsVirtualPlayhead?: (
        nodeId: string,
      ) => { activeSlot: number; slotPos: number[] } | null;
    };
    return w.__vvsVirtualPlayhead?.(id) ?? null;
  }, VVS_ID);
}

/** Combined SINGLE-evaluate read of the active slot AND the active element's
 *  currentTime, so the switch-back landing is sampled with minimal drift (one
 *  round-trip, no gap between "is the switch done" and "where did it land"). */
async function readSwitchState(
  page: Page,
): Promise<{ activeSlot: number; time: number }> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __vvsVirtualPlayhead?: (
        nodeId: string,
      ) => { activeSlot: number; slotPos: number[] } | null;
    };
    const vp = w.__vvsVirtualPlayhead?.(id) ?? null;
    const vid = document.querySelector(
      '[data-testid="videovarispeed-video"]',
    ) as HTMLVideoElement | null;
    return { activeSlot: vp?.activeSlot ?? -1, time: vid?.currentTime ?? NaN };
  }, VVS_ID);
}

/** Set the transport play WINDOW (START/END as fractions of duration 0..1)
 *  through the card's REAL slider inputs (the setNodeParam path). Confining the
 *  window to a mid-clip band is what makes the switch-back assertion robust:
 *  every slot's virtual playhead wraps inside [start,end]·dur, so a reset-to-0
 *  lands unambiguously OUTSIDE it (no loop-end↔zero circular-adjacency). */
async function setWindow(page: Page, startFrac: number, endFrac: number): Promise<void> {
  const card = page.locator(`.svelte-flow__node[data-id="${VVS_ID}"]`);
  for (const [testid, val] of [
    ['videovarispeed-start', startFrac],
    ['videovarispeed-end', endFrac],
  ] as const) {
    await card.locator(`[data-testid="${testid}"]`).evaluate((el, v) => {
      const input = el as HTMLInputElement;
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, val);
  }
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
      timeout: T(8000),
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
      'data-has-local-file', 'true', { timeout: T(10000) },
    );
    return;
  }
  // dispatchEvent (not .click): the card repaints from its transport rAF so
  // Playwright's actionability "stable" check never settles (same as perfzip).
  await card.locator('[data-testid="videovarispeed-card"]').dispatchEvent('contextmenu');
  await expect(card.locator('[data-testid="videovarispeed-multi-panel"]')).toBeVisible({ timeout: T(5000) });
  await card.locator(`[data-testid="videovarispeed-slot-input-${slot}"]`).setInputFiles(AV_FIXTURE);
  await expect(card.locator(`[data-testid="videovarispeed-slot-${slot}"]`))
    .toHaveAttribute('data-slot-local', 'true', { timeout: T(10000) });
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
    await expect(overlay).toHaveCount(0, { timeout: T(4000) });
  }
}

test.describe('VIDEOVARISPEED 7-slot switch path (multi-slot stall regression)', () => {
  test('A → B → back-to-A keeps decoding + play/pause alive; switch-back lands on live time', async ({ page }) => {
    // Real-H.264-decode work (2 slot loads + 3 switches + 3 frame-advance polls)
    // under ~24-way SwiftShader contention blows the flat 30s test budget. Scale
    // the test-level ceiling too (a ceiling only — a green run finishes far under
    // it, so this adds ~0 CI wall-time; it just survives the contended case).
    test.setTimeout(T(45_000)); // 135s on CI/SwiftShader, 45s on a real-GPU local run
    const errors = await setup(page);
    // Capture ONLY the smoking-gun warning separately so we can assert it never
    // fired regardless of other (benign) console noise.
    const keepAliveWarnings: string[] = [];
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[videovarispeed] createMediaElementSource failed')) keepAliveWarnings.push(t);
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // Patch: VIDEOVARISPEED → VIDEO-OUT, alongside a clip player (the realistic
    // asset-select source) present in the rack. The slot switch is INJECTED at
    // the card's asset-select param seam via switchToSlot (getDomain('video')
    // .setParam on asset_pitch/asset_gate) — the exact param the CV bridge
    // writes into. We deliberately do NOT wire the clip player → asset_pitch/
    // asset_gate: an IDLE clip player's pitch/gate bridge continuously drives
    // those params to 0, which would clobber the injected switch signal every
    // tick (pitch→0 selects slot 0, gate held→0 never edges) — i.e. the switch
    // would never fire. Programming the clip player's grid to emit a
    // deterministic note+gate at a deterministic instant is brittle, so we
    // inject at the same param seam the bridge targets instead.
    await spawnPatch(page,
      [
        { id: CLIP_ID, type: 'clipplayer', position: { x: 40, y: 40 }, domain: 'audio' },
        { id: VVS_ID, type: 'videovarispeed', position: { x: 360, y: 40 }, domain: 'video' },
        { id: OUT_ID, type: 'videoOut', position: { x: 820, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e_vid', from: { nodeId: VVS_ID, portId: 'video' }, to: { nodeId: OUT_ID, portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // Load slot 0 (C) + slot 1 (D) via the real pickers.
    await loadSlot(page, 0);
    await loadSlot(page, 1);

    // Confine the play WINDOW to the mid-clip band [0.5, 0.8]·duration. Every
    // slot's virtual playhead (active AND inactive) is clamped/wrapped inside
    // [startSec, endSec], so (a) a healthy switch-back ALWAYS lands in that band
    // and (b) the Build-B reset (currentTime→0) lands BELOW startSec — a clean,
    // load-independent separation with NO loop-end↔zero circular-adjacency blind
    // spot (the loop wraps endSec→startSec, never near 0). See the assertion.
    await setWindow(page, 0.5, 0.8);

    // Start playback (loop default) + let slot 0 (active) advance into the window
    // before we switch away.
    await page.click('[data-testid="videovarispeed-play-btn"]', { timeout: T(15_000) });
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-is-playing', 'true', { timeout: T(4000) },
    );
    await page.waitForTimeout(1200);

    // --- SWITCH A → B (slot 0 → slot 1) ---
    await switchToSlot(page, SLOT1_VOCT);
    await expect.poll(async () => readEngine(page, 'hasVideoElement'), { timeout: T(4000) }).toBe(true);
    await expect.poll(async () => (await readVirtualPlayhead(page))?.activeSlot, { timeout: T(4000) }).toBe(1);
    await assertFramesAdvance(page, 'after A→B');
    await page.waitForTimeout(600); // let B's playhead + A's VIRTUAL playhead advance

    // Read slot A's tracked VIRTUAL playhead while B is still active — i.e. the
    // free-running inactive-slot value, on the engine's frame-time clock, that
    // the imminent switch-back will jump the element to. Captured BEFORE the
    // switch so it's not yet re-synced to the element's currentTime.
    const beforeVp = await readVirtualPlayhead(page);
    expect(beforeVp, 'virtual-playhead hook readable (VITE_E2E_HOOKS)').not.toBeNull();
    expect(beforeVp!.activeSlot, 'slot B (1) active before switch-back').toBe(1);
    const trackedA = beforeVp!.slotPos[0];

    // --- SWITCH B → BACK to A (slot 1 → slot 0) ---
    // Capture the landing PROMPTLY: sample currentTime on the SAME poll that sees
    // the switch land (activeSlot→0), BEFORE anything slow (the frame-advance
    // check runs after). A healthy switch-back JUMPS the element to A's tracked
    // virtual playhead (selectAssetSlot: `next.currentTime = clamp(slotPos[A])`),
    // which stays inside the play window; the Build-B reset instead sets
    // `next.currentTime = 0` and then plays forward, so it must be read before it
    // drifts up out of the "below the window floor" zone.
    await switchToSlot(page, SLOT0_VOCT);
    let observedA = NaN;
    await expect
      .poll(async () => {
        const s = await readSwitchState(page);
        if (s.activeSlot === 0) observedA = s.time;
        return s.activeSlot;
      }, { timeout: T(4000) })
      .toBe(0);

    const { duration } = await page
      .locator('[data-testid="videovarispeed-video"]')
      .evaluate((el) => ({ duration: (el as HTMLVideoElement).duration }));

    // (4) Switch-BACK to A landed on A's PRESERVED virtual playhead, NOT reset to
    // ~0 (the Build-B regression, whose pre-fix code did `next.currentTime = 0`).
    // We compare TWO reads of the SAME engine-internal frame-time (rAF) clock:
    // `trackedA` (slot A's virtual playhead just BEFORE the switch) and
    // `observedA` (the element's currentTime just AFTER). The WALL clock never
    // enters the comparison, so it CANNOT lag/flake under CI SwiftShader load —
    // the OLD wall-clock projection legitimately ran ahead of the frame-time
    // playhead (circDist 0.34/0.55s, always behind, tripping the old 0.3s floor).
    //
    // The play window is confined to the mid-clip band [0.5, 0.8]·dur, which
    // makes the reset unambiguously separable on a LOOPING clip: the virtual
    // playhead (active AND inactive) is wrapped inside [startSec, endSec], so
    // `trackedA` is ALWAYS in that band (never near 0 or dur — no loop-end↔zero
    // circular-adjacency blind spot). A healthy landing is therefore in the band
    // too, while the reset lands at ~0 — BELOW startSec (the reset bypasses the
    // window clamp) — so the two never overlap.
    const startSec = 0.5 * duration;
    const endSec = 0.8 * duration;

    // Reset guard (primary): a healthy landing is >= startSec (0.5·dur); a reset
    // starts at ~0 and is read before it can drift up past 0.35·dur. The 0.15·dur
    // gap below startSec is pure margin — geometric, not timing-based.
    expect(
      observedA,
      `switch-back landed inside the play window, not reset to ~0 (below the floor): ` +
        `observed=${observedA.toFixed(2)}s window=[${startSec.toFixed(2)},${endSec.toFixed(2)}]s dur=${duration.toFixed(2)}s`,
    ).toBeGreaterThan(0.35 * duration);

    // Preservation (same-clock match): both values are confined to the 0.3·dur
    // band, so a healthy |diff| <= 0.3·dur; tol 0.4·dur sits above the band max
    // and below the reset gap (a reset gives |0 - trackedA| = trackedA >= 0.5·dur).
    const tol = 0.4 * duration;
    const diff = Math.abs(observedA - trackedA);
    expect(
      diff,
      `switch-back preserved A's virtual playhead (same-clock match, not a reset to 0): ` +
        `tracked=${trackedA.toFixed(2)}s observed=${observedA.toFixed(2)}s ` +
        `window=[${startSec.toFixed(2)},${endSec.toFixed(2)}]s dur=${duration.toFixed(2)}s tol=${tol.toFixed(2)}s`,
    ).toBeLessThan(tol);

    // Frames keep advancing after B→A (re-select must NOT throw + freeze). Run
    // this AFTER capturing the landing so it can't add drift to `observedA`.
    await assertFramesAdvance(page, 'after B→A (re-select must NOT throw + freeze)');

    // (3) Play/pause works AFTER the switches: pause halts, play resumes.
    await page.click('[data-testid="videovarispeed-play-btn"]', { timeout: T(15_000) }); // → pause
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-is-playing', 'false', { timeout: T(4000) },
    );
    await expect.poll(async () => (await activeVideoState(page)).paused, { timeout: T(4000) }).toBe(true);

    await page.click('[data-testid="videovarispeed-play-btn"]', { timeout: T(15_000) }); // → play again
    await expect(page.locator('[data-testid="videovarispeed-card"]')).toHaveAttribute(
      'data-is-playing', 'true', { timeout: T(4000) },
    );
    await assertFramesAdvance(page, 'play AFTER a switch resumes frame advance');

    // (2) The keep-alive smoking gun NEVER fired across the whole sequence.
    expect(
      keepAliveWarnings,
      `createMediaElementSource must NEVER fail across switches: ${keepAliveWarnings.join(' | ')}`,
    ).toEqual([]);

    // Every loaded slot kept a persistent keep-alive (none torn down on switch):
    // exactly 2 distinct elements wired across all the A↔B churn.
    await expect.poll(async () => readEngine(page, 'keepAliveCount'), { timeout: T(4000) }).toBe(2);

    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
