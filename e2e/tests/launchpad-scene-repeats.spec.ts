// e2e/tests/launchpad-scene-repeats.spec.ts
//
// SCENE REPEATS end-to-end through the REAL chain (the poly/MIDI discipline):
// the owner's 3-button gesture on a (simulated) single-unit Launchpad sets a
// scene's repeat count, the card's read-only flair mirrors it, and after N
// passes of the scene's longest clip the engine AUTO-LAUNCHES the next content
// scene down through the normal launch path — all driven by the real
// TIMELORDE-locked clock with audible RMS at a downstream voice:
//
//   [sim Launchpad: HOLD GRID + HOLD scene button + tap pad k] → sceneRepeats
//   [sim Launchpad: scene button] → launch → clipplayer.pitch1/gate1 → VCO →
//   VCA → SCOPE (audible), then playing[0] flips 0 → 1 on its own (the
//   auto-advance) with no further input.
//
// Also covers the owner-called-out SCROLL-AWARE case: with the scene window
// scrolled, the held scene button edits the CORRECT (position-relative) slot.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const CC_VIEW_GRID = 92; // permanent top row: the GRID button
const CC_SHIFT_TOP = 98;
const SCENE_CCS = [89, 79, 69, 59, 49, 39, 29, 19] as const; // top→bottom
const G_SCROLL_DOWN_CC = SCENE_CCS[7]; // grid-shift palette, bottom = SCR▼

async function setTransport(page: import('@playwright/test').Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-rep-test'] = {
          id: 'tl-rep-test', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
          params: { running: run, bpm: 200 }, data: {},
        } as never;
      } else {
        for (const n of tls) {
          if (!n.params) n.params = {};
          n.params.running = run;
          n.params.bpm = 200;
        }
      }
    });
  }, running);
}

async function lanePlayingSlot(page: import('@playwright/test').Page, lane: number) {
  return page.evaluate((l) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { playing?: unknown[] } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.playing?.[l] ?? null;
  }, lane);
}
async function sceneRepeatsMap(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { sceneRepeats?: Record<string, number> } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.sceneRepeats ?? null;
  });
}
async function sceneLaunchMarker(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { sceneLaunch?: { slot: number; n: number } } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.sceneLaunch ?? null;
  });
}
/** Raw CC edge on the lone device (v=127 press / 0 release) — for HOLDS. */
async function ccSingle(page: import('@playwright/test').Page, cc: number, v: number) {
  await page.evaluate(({ cc, v }) => {
    (globalThis as unknown as { __launchpadSingleSim?: { cc: (cc: number, v: number) => void } })
      .__launchpadSingleSim?.cc(cc, v);
  }, { cc, v });
}
async function ccTapSingle(page: import('@playwright/test').Page, cc: number) {
  await ccSingle(page, cc, 127);
  await ccSingle(page, cc, 0);
}
/** Tap the grid pad at 1-indexed ROW-MAJOR ordinal k (upper-left = 1). */
async function tapPadOrdinal(page: import('@playwright/test').Page, k: number) {
  await page.evaluate((ord) => {
    const s = (globalThis as unknown as {
      __launchpadSingleSim?: { press: (x: number, y: number) => void; release: (x: number, y: number) => void };
    }).__launchpadSingleSim!;
    const x = (ord - 1) % 8;
    const y = 7 - Math.floor((ord - 1) / 8);
    s.press(x, y);
    s.release(x, y);
  }, k);
}
async function singleView(page: import('@playwright/test').Page) {
  return page.evaluate(
    () => (globalThis as unknown as { __launchpadSingleSim?: { state: () => { singleView: string } } })
      .__launchpadSingleSim!.state().singleView,
  );
}
async function sceneOffset(page: import('@playwright/test').Page) {
  return page.evaluate(
    () => (globalThis as unknown as { __launchpadSingleSim?: { state: () => { sceneScrollOffset: number } } })
      .__launchpadSingleSim!.state().sceneScrollOffset,
  );
}

async function buildChain(page: import('@playwright/test').Page, prefix: string) {
  await spawnPatch(
    page,
    [
      { id: `${prefix}-cp`, type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: `${prefix}-vco`, type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: `${prefix}-vca`, type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
        params: { base: 0, cvAmount: 1 } },
      { id: `${prefix}-scp`, type: 'scope', position: { x: 920, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: `${prefix}1`, from: { nodeId: `${prefix}-cp`, portId: 'pitch1' }, to: { nodeId: `${prefix}-vco`, portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: `${prefix}2`, from: { nodeId: `${prefix}-vco`, portId: 'sine' }, to: { nodeId: `${prefix}-vca`, portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: `${prefix}3`, from: { nodeId: `${prefix}-cp`, portId: 'gate1' }, to: { nodeId: `${prefix}-vca`, portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      { id: `${prefix}4`, from: { nodeId: `${prefix}-vca`, portId: 'audio' }, to: { nodeId: `${prefix}-scp`, portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);
}

/** Seed 4-step note clips at flat indices (stride-64: index = lane*64 + slot). */
async function seedClipsAt(page: import('@playwright/test').Page, nodeId: string, indices: number[]) {
  await page.evaluate(({ id, idxs }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n.data) n.data = {};
      const clips: Record<string, unknown> = {};
      for (const i of idxs) {
        clips[String(i)] = {
          kind: 'note', lengthSteps: 4, root: 48, loop: true, scale: 'major',
          steps: [
            { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
            { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
            { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
            { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
          ],
        };
      }
      n.data.clips = clips;
      (n.data as { sv?: number }).sv = 2;
    });
  }, { id: nodeId, idxs: indices });
}

async function installSingle(page: import('@playwright/test').Page, nodeId: string) {
  const installed = await page.evaluate(async (id) => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    if (!w.__launchpadTestInstallSingle) return false;
    return await w.__launchpadTestInstallSingle(id);
  }, nodeId);
  expect(installed, 'single-unit Launchpad install hook present (VITE_E2E_HOOKS)').toBe(true);
}

test('@launchpad scene repeats: gesture sets ×2, card flair mirrors it, scene 2 AUTO-LAUNCHES after 2 passes — audible through the real chain', async ({ page, rack, errorWatch }) => {
  await buildChain(page, 'rp');
  // Scene 0 (lane 0 slot 0, index 0) + scene 1 (lane 0 slot 1, index 1) — both
  // drive the audible voice via pitch1/gate1.
  await seedClipsAt(page, 'rp-cp', [0, 1]);
  await installSingle(page, 'rp-cp');
  await ccTapSingle(page, CC_VIEW_GRID);
  await expect.poll(() => singleView(page), { timeout: 5000 }).toBe('grid');

  // ── The 3-button gesture: HOLD GRID + HOLD scene 0's button → tap pad 2. ──
  await ccSingle(page, CC_VIEW_GRID, 127); // HOLD GRID
  await ccSingle(page, SCENE_CCS[0], 127); // HOLD the top scene button
  await tapPadOrdinal(page, 2); // pad 2 = 2 repeats
  await ccSingle(page, SCENE_CCS[0], 0); // release scene
  await ccSingle(page, CC_VIEW_GRID, 0); // release GRID
  await expect.poll(() => sceneRepeatsMap(page), { timeout: 5000 }).toEqual({ '0': 2 });
  // The scene press under GRID-hold selected only — nothing launched.
  expect(await lanePlayingSlot(page, 0), 'no accidental launch from the hold').toBeNull();

  // ── UI can't lie: the card flair shows exactly the stored count. ──
  await expect(page.getByTestId('clipplayer-scene-repeat-0')).toHaveText('×2');
  await expect(page.getByTestId('clipplayer-scene-repeat-1')).toHaveCount(0); // infinite = no flair

  // ── Launch scene 0 and let it run: silent → audible → auto-advance. ──
  await setTransport(page, 1);
  const before = await readScopePeakOverWindow(page, 'rp-scp', 400);
  expect(before.rms, 'silent before the scene launch').toBeLessThan(0.03);

  await ccTapSingle(page, SCENE_CCS[0]);
  // Audible right after the launch — the 800 ms window spans scene 0 (and,
  // once the advance lands, scene 1); both drive the SAME lane-0 voice, so
  // either way this proves launch → sound through the real chain.
  const during = await readScopePeakOverWindow(page, 'rp-scp', 800);
  expect(during.rms, 'audible after the scene launch').toBeGreaterThan(0.03);
  expect(during.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);

  // AUTO-ADVANCE — poll the STABLE terminal state only, never the transient
  // intermediate: `playing[0] === 0` is observable for only ~0.3 s at 200 bpm
  // (the advance write deliberately lands one anchor step + the audio
  // lookahead early, and the synced state flips at wrap-PROCESSING time), so
  // a loaded CI runner's first evaluate round-trip lands AFTER the advance —
  // this exact race failed CI twice with Received: 1, i.e. the advance had
  // already succeeded. Timeout scaled by the pass count (2 passes ≈ 0.6 s at
  // 200 bpm) per the CI-SwiftShader standard. The intermediate scene-0 pass
  // timing itself is pinned by the engine unit suite.
  await expect.poll(() => lanePlayingSlot(page, 0), { timeout: 15000 }).toBe(1);
  // Exactly ONE launch (ours, n:1) + ONE auto-advance (n:2), both through the
  // scene-launch seam — a double-fire or a bypassed path would break this.
  expect(await sceneLaunchMarker(page)).toEqual({ slot: 1, n: 2 });
  // Scene 1 is INFINITE → it keeps playing (the last content scene never stops).
  const after = await readScopePeakOverWindow(page, 'rp-scp', 800);
  expect(after.rms, 'still audible on the advanced scene').toBeGreaterThan(0.03);
  // While counting is over, the flair shows the SET count again on scene 0.
  await expect(page.getByTestId('clipplayer-scene-repeat-0')).toHaveText('×2');
});

test('@launchpad scene repeats SCROLL-AWARE: with the window scrolled, the held button edits the CORRECT scene slot', async ({ page, rack, errorWatch }) => {
  await buildChain(page, 'rq');
  // Content in slots 0..7 of lane 0 → the window can scroll (reveals scene 8).
  await seedClipsAt(page, 'rq-cp', [0, 1, 2, 3, 4, 5, 6, 7]);
  await installSingle(page, 'rq-cp');
  await ccTapSingle(page, CC_VIEW_GRID);
  await expect.poll(() => singleView(page), { timeout: 5000 }).toBe('grid');

  // Slide the scene window down one — HOLD shift (momentary) for the scroll
  // palette, then release.
  await ccSingle(page, CC_SHIFT_TOP, 127);
  await ccTapSingle(page, G_SCROLL_DOWN_CC);
  await expect.poll(() => sceneOffset(page), { timeout: 5000 }).toBe(1);
  await ccSingle(page, CC_SHIFT_TOP, 0);

  // HOLD GRID + the TOP scene button now edits scene offset+0 = SLOT 1 (the
  // owner-called-out case): tap pad 3 → sceneRepeats['1'] = 3, NOT '0'.
  await ccSingle(page, CC_VIEW_GRID, 127);
  await ccSingle(page, SCENE_CCS[0], 127);
  await tapPadOrdinal(page, 3);
  await ccSingle(page, SCENE_CCS[0], 0);
  await ccSingle(page, CC_VIEW_GRID, 0);
  await expect.poll(() => sceneRepeatsMap(page), { timeout: 5000 }).toEqual({ '1': 3 });

  // The card flair sits on scene row 1 (and only there).
  await expect(page.getByTestId('clipplayer-scene-repeat-1')).toHaveText('×3');
  await expect(page.getByTestId('clipplayer-scene-repeat-0')).toHaveCount(0);

  // Pad 64 in the same scrolled hold sets it back to INFINITE (key deleted).
  await ccSingle(page, CC_VIEW_GRID, 127);
  await ccSingle(page, SCENE_CCS[0], 127);
  await tapPadOrdinal(page, 64);
  await ccSingle(page, SCENE_CCS[0], 0);
  await ccSingle(page, CC_VIEW_GRID, 0);
  await expect.poll(() => sceneRepeatsMap(page), { timeout: 5000 }).toEqual({});
  await expect(page.getByTestId('clipplayer-scene-repeat-1')).toHaveCount(0);
});
