// e2e/tests/clip-prob-default.spec.ts
//
// CLIP-DEFAULT PROBABILITY end-to-end (the clip-level sibling of the per-note
// prob feature). Two real-chain proofs:
//
//  1) GESTURE (@launchpad): on a SIMULATED single-unit Launchpad, SHIFT + a Grid
//     clip pad opens the CLIP-DEFAULT PROB page; a level tap writes the clip's
//     `defaultProb` into the REAL node.data through the REAL sim + store, and the
//     card's note cells recolour SOURCE-AWARE (orange for a defaulted note,
//     purple for a per-note override) — the real DOM render, not a unit stub.
//
//  2) PLAYBACK (@clipplayer, poly REAL-source-chain discipline): a clip whose
//     `defaultProb` gates its notes drives the REAL TIMELORDE-locked clock →
//     clipplayer.pitch1/gate1 → VCO → VCA → SCOPE. A clip default of 0 makes a
//     launched clip SILENT (the default gates every note); adding a per-note
//     `prob:1` override makes it AUDIBLE again (the override BEATS the default at
//     playback). Deterministic edges (0 / 1) — no RNG flake; the seeded mid-prob
//     statistical band is pinned by the unit permutation table.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const CC_VIEW_GRID = 92; // permanent top row: the GRID button
const CC_SHIFT_TOP = 98;

type Page = import('@playwright/test').Page;

async function ccSingle(page: Page, cc: number, v: number) {
  await page.evaluate(({ cc, v }) => {
    (globalThis as unknown as { __launchpadSingleSim?: { cc: (cc: number, v: number) => void } })
      .__launchpadSingleSim?.cc(cc, v);
  }, { cc, v });
}
async function ccTapSingle(page: Page, cc: number) {
  await ccSingle(page, cc, 127);
  await ccSingle(page, cc, 0);
}
/** Press+release the grid pad at 1-indexed ROW-MAJOR ordinal k (upper-left = 1). */
async function tapPadOrdinal(page: Page, k: number) {
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
async function singleState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    () => (globalThis as unknown as { __launchpadSingleSim?: { state: () => Record<string, unknown> } })
      .__launchpadSingleSim!.state(),
  );
}
async function clipDefaultProb(page: Page, nodeId: string, idx: number) {
  return page.evaluate(({ id, i }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { clips?: Record<string, { defaultProb?: number }> } }> };
    };
    return w.__patch.nodes[id]?.data?.clips?.[String(i)]?.defaultProb ?? null;
  }, { id: nodeId, i: idx });
}
async function lanePlayingSlot(page: Page, lane: number) {
  return page.evaluate((l) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { playing?: unknown[] } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.playing?.[l] ?? null;
  }, lane);
}
async function setTransport(page: Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-cd-test'] = {
          id: 'tl-cd-test', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
          params: { running: run, bpm: 220 }, data: {},
        } as never;
      } else {
        for (const n of tls) { if (!n.params) n.params = {}; n.params.running = run; n.params.bpm = 220; }
      }
    });
  }, running);
}

async function installSingle(page: Page, nodeId: string) {
  const installed = await page.evaluate(async (id) => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    if (!w.__launchpadTestInstallSingle) return false;
    return await w.__launchpadTestInstallSingle(id);
  }, nodeId);
  expect(installed, 'single-unit Launchpad install hook present (VITE_E2E_HOOKS)').toBe(true);
}

async function buildChain(page: Page, prefix: string) {
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

/** Seed clip 0 (lane 0 slot 0) with the given steps + optional clip default. */
async function seedClip(
  page: Page,
  nodeId: string,
  steps: Array<{ step: number; midi: number; velocity?: number; lengthSteps?: number; prob?: number }>,
  defaultProb?: number,
) {
  await page.evaluate(({ id, steps, defaultProb }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n.data) n.data = {};
      const clip: Record<string, unknown> = {
        kind: 'note', lengthSteps: 4, root: 48, loop: true, scale: 'major', steps,
      };
      if (defaultProb !== undefined) clip.defaultProb = defaultProb;
      n.data.clips = { '0': clip };
      (n.data as { sv?: number }).sv = 2;
    });
  }, { id: nodeId, steps, defaultProb });
}

// ===========================================================================
// 1) GESTURE — SHIFT + a Grid clip pad → clip-PROB page → level tap writes
//    node.data.defaultProb; the card recolours source-aware.
// ===========================================================================
test('@launchpad clip-default prob: SHIFT+clip → PROB page → level tap writes defaultProb; card recolours orange/purple', async ({ page, rack, errorWatch }) => {
  await buildChain(page, 'cg');
  // Two notes at the clip ROOT (midi 48 → editor display row 7): step 0 carries a
  // per-note override (0.25 → purple); step 1 takes the clip default (→ orange).
  await seedClip(page, 'cg-cp', [
    { step: 0, midi: 48, velocity: 100, lengthSteps: 1, prob: 0.25 },
    { step: 1, midi: 48, velocity: 100, lengthSteps: 1 },
  ]);
  await installSingle(page, 'cg-cp');
  await ccTapSingle(page, CC_VIEW_GRID);
  await expect.poll(() => singleState(page).then((s) => s.singleView), { timeout: 5000 }).toBe('grid');

  // SHIFT + press the clip (0,0) pad (grid ordinal 1) → open the CLIP-PROB page.
  await ccSingle(page, CC_SHIFT_TOP, 127);
  await tapPadOrdinal(page, 1);
  await expect.poll(() => singleState(page).then((s) => s.clipProbEditActive), { timeout: 5000 }).toBe(true);
  await ccSingle(page, CC_SHIFT_TOP, 0);

  // Tap grid ordinal 20 = 50% → writes defaultProb ≈ 0.5 + auto-returns to grid.
  await tapPadOrdinal(page, 20);
  await expect.poll(() => singleState(page).then((s) => s.clipProbEditActive), { timeout: 5000 }).toBe(false);
  await expect.poll(() => clipDefaultProb(page, 'cg-cp', 0), { timeout: 5000 }).toBeCloseTo(0.5, 5);

  // The card reflects it: open the editor (double-click the pad) and read the
  // note-cell backgrounds — the SOURCE-AWARE recolour renders BOTH a purple cell
  // (the per-note override) and an orange cell (the clip-default note). Scan the
  // rendered cells (robust to the editor's pitch-window scroll).
  await page.getByTestId('clipplayer-pad-0').dblclick();
  await page.getByTestId('clipplayer-editor').waitFor({ state: 'visible' });
  // Chromium serialises the inline hsl() fill to rgb(); classify a note cell by
  // its dominant channel: purple (per-note override) = blue max, orange (clip
  // default) = red max & blue min, white = all channels equal.
  async function cellHues(): Promise<{ purple: number; orange: number; white: number }> {
    return page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('[data-testid^="clipplayer-cell-"]'));
      let purple = 0, orange = 0, white = 0;
      for (const c of cells) {
        const bg = (c as HTMLElement).style.backgroundColor || '';
        const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg);
        if (!m) continue;
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (r === g && g === b) white++;
        else if (b > r && b > g) purple++;
        else if (r > g && r > b) orange++;
      }
      return { purple, orange, white };
    });
  }
  await expect.poll(() => cellHues().then((h) => h.purple), { timeout: 5000 }).toBeGreaterThan(0);
  await expect.poll(() => cellHues().then((h) => h.orange), { timeout: 5000 }).toBeGreaterThan(0);
});

// ===========================================================================
// 2) PLAYBACK — the clip default gates firing through the REAL chain; a per-note
//    override BEATS it. Deterministic 0 / 1 edges (no RNG flake).
// ===========================================================================
test('@clipplayer clip-default prob 0 SILENCES a launched clip through the real chain', async ({ page, rack, errorWatch }) => {
  await buildChain(page, 'cs');
  // 4 notes, clip default 0, NO overrides → every note is diced out → silent.
  await seedClip(page, 'cs-cp', [
    { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
    { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
    { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
    { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
  ], 0);
  await installSingle(page, 'cs-cp');
  await ccTapSingle(page, CC_VIEW_GRID);
  await expect.poll(() => singleState(page).then((s) => s.singleView), { timeout: 5000 }).toBe('grid');

  await setTransport(page, 1);
  await tapPadOrdinal(page, 1); // launch clip (0,0) — no shift
  // It IS playing (so silence proves the DEFAULT gates it, not a missing launch).
  await expect.poll(() => lanePlayingSlot(page, 0), { timeout: 8000 }).toBe(0);

  const s = await readScopePeakOverWindow(page, 'cs-scp', 800);
  expect(s.rms, 'clip default 0 → the launched clip is silent (every note diced out)').toBeLessThan(0.02);
});

test('@clipplayer a per-note prob:1 override BEATS a clip default of 0 — audible through the real chain', async ({ page, rack, errorWatch }) => {
  await buildChain(page, 'co');
  // Clip default 0, but ONE note (step 0) carries a prob:1 override held across
  // the whole loop → that voice ALWAYS fires → audible; the others stay diced out.
  await seedClip(page, 'co-cp', [
    { step: 0, midi: 72, velocity: 127, lengthSteps: 4, prob: 1 },
    { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
    { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
    { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
  ], 0);
  await installSingle(page, 'co-cp');
  await ccTapSingle(page, CC_VIEW_GRID);
  await expect.poll(() => singleState(page).then((s) => s.singleView), { timeout: 5000 }).toBe('grid');

  await setTransport(page, 1);
  await tapPadOrdinal(page, 1); // launch clip (0,0)
  await expect.poll(() => lanePlayingSlot(page, 0), { timeout: 8000 }).toBe(0);

  const s = await readScopePeakOverWindow(page, 'co-scp', 800);
  expect(s.rms, 'the prob:1 override fires despite the clip default 0 → audible').toBeGreaterThan(0.03);
  expect(s.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);
});
