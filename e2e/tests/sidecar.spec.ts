// e2e/tests/sidecar.spec.ts
//
// SIDECAR end-to-end smoke + behavior checks:
//   1. Smoke: VCO → Sidecar → AUDIOOUT — card mounts, no errors.
//   2. SC ducking: VCO1 → Sidecar.audio_l + Sidecar.audio_r;
//      VCO2 → Sidecar.sc_l + Sidecar.sc_r; assert audio_l_out RMS dips
//      while SC fires.
//   3. env_inv_out → STEREOVCA.strength_l on second VCO; assert ducking
//      is applied via cross-patch env CV.
//   4. sc_hpf gate: 50Hz sine into SC + hpf=800Hz + low SC amplitude →
//      no audible ducking on the audio output.
//
// The behavior checks read the SIDECAR's `audio_l_out` via a SCOPE
// snapshot (the canonical pattern in this codebase for assertion-grade
// audio probes — direct AnalyserNode access through the engine).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// ────────────────────────────────────────────────────────────────────────────
// 1. SMOKE — card mounts + audio flows
// ────────────────────────────────────────────────────────────────────────────

test('SIDECAR smoke: VCO → SIDECAR → AUDIOOUT — card mounts, no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
      { id: 'a-sc',  type: 'sidecar',   position: { x: 360, y: 60 }, domain: 'audio',
        params: { threshold: -18, ratio: 4, attack: 10, release: 100, knee: 6, envMag: 1, makeup: 0, sc_hpf: 20 } },
      { id: 'a-out', type: 'audioOut',  position: { x: 760, y: 60 }, domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },          to: { nodeId: 'a-sc',  portId: 'audio_l_in' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'saw' },          to: { nodeId: 'a-sc',  portId: 'audio_r_in' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-sc',  portId: 'audio_l_out' },  to: { nodeId: 'a-out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'a-sc',  portId: 'audio_r_out' },  to: { nodeId: 'a-out', portId: 'R' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-sidecar');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('SIDECAR');

  // Confirm the threshold param round-trips through the AudioParam.
  await page.waitForTimeout(500);
  const readable = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        readParam: (n: { id: string; type: string; domain: string }, p: string) => number | undefined;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const e = w.__engine?.();
    const n = w.__patch.nodes['a-sc'];
    if (!e || !n) return null;
    return e.readParam(n, 'threshold');
  });
  expect(readable).toBeCloseTo(-18, 0);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. SC ducking via external sidechain pair
// ────────────────────────────────────────────────────────────────────────────

test('SIDECAR sc ducking: VCO → audio, NOISE → sc → audio_l_out RMS dips while SC fires', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Use NOISE (which has a `level` param we can mute mid-test) instead of
  // a second VCO. AnalogVco has no level knob — its output amplitude is
  // fixed by the waveform.
  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60  }, domain: 'audio' },
      { id: 'a-n',   type: 'noise',     position: { x: 60,  y: 260 }, domain: 'audio',
        params: { level: 0.7 } },
      { id: 'a-sc',  type: 'sidecar',   position: { x: 360, y: 60  }, domain: 'audio',
        params: { threshold: -24, ratio: 8, attack: 5, release: 50, knee: 0, envMag: 1, makeup: 0, sc_hpf: 20 } },
      { id: 'a-scp', type: 'scope',     position: { x: 760, y: 60  }, domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-sc',  portId: 'audio_l_in' } },
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-sc',  portId: 'audio_r_in' } },
      { id: 'e3', from: { nodeId: 'a-n',   portId: 'white' }, to: { nodeId: 'a-sc',  portId: 'sc_l_in' } },
      { id: 'e4', from: { nodeId: 'a-n',   portId: 'white' }, to: { nodeId: 'a-sc',  portId: 'sc_r_in' } },
      { id: 'e5', from: { nodeId: 'a-sc',  portId: 'audio_l_out' }, to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  await page.waitForTimeout(700);

  // Baseline: NOISE hot → SIDECAR compressing → audio_l_out attenuated.
  const hotSnap = await readScopeSnapshot(page, 'a-scp');
  expect(hotSnap).not.toBeNull();
  const hotRms = summarize(hotSnap!.ch1).rms;

  // Silence NOISE → release → audio_l_out climbs back to unity.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-n'];
      if (n) n.params.level = 0;
    });
  });
  await page.waitForTimeout(400); // > release time (50 ms) + settle

  const openSnap = await readScopeSnapshot(page, 'a-scp');
  expect(openSnap).not.toBeNull();
  const openRms = summarize(openSnap!.ch1).rms;

  // Open RMS should clearly exceed Hot RMS — proves ducking was active.
  // Use a coarse 1.15× ratio so engine-timing variance doesn't flake.
  expect(openRms).toBeGreaterThan(hotRms * 1.15);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Cross-patch ducking via env_inv_out → STEREOVCA.strength
// ────────────────────────────────────────────────────────────────────────────

test('SIDECAR env_inv_out → STEREOVCA.strength_l ducks a second VCO', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Patch: NOISE (mutable level) → SIDECAR (self-detect, hot);
  // SIDECAR.env_inv_out → STEREOVCA.strength_l/_r;
  // VCO → STEREOVCA.in_l/_r → SCOPE.
  //
  // NOISE hot → SIDECAR compressing → env_out near 1 → env_inv_out near 0
  // → STEREOVCA gain → 0 → SCOPE sees silence.
  // NOISE silent → env_out near 0 → env_inv_out near 1 → STEREOVCA at
  // unity gain → SCOPE sees the VCO waveform.
  await spawnPatch(
    page,
    [
      { id: 'a-n',   type: 'noise',     position: { x: 60,  y: 60  }, domain: 'audio',
        params: { level: 0.7 } },
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 260 }, domain: 'audio' },
      { id: 'a-sc',  type: 'sidecar',   position: { x: 360, y: 60  }, domain: 'audio',
        params: { threshold: -18, ratio: 8, attack: 5, release: 50, knee: 0, envMag: 1, makeup: 0, sc_hpf: 20 } },
      { id: 'a-vca', type: 'stereovca', position: { x: 660, y: 260 }, domain: 'audio',
        params: { level: 1.0, offset: 0 } },
      { id: 'a-scp', type: 'scope',     position: { x: 960, y: 260 }, domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-n',   portId: 'white' },         to: { nodeId: 'a-sc',  portId: 'audio_l_in' } },
      { id: 'e2', from: { nodeId: 'a-n',   portId: 'white' },         to: { nodeId: 'a-sc',  portId: 'audio_r_in' } },
      { id: 'e3', from: { nodeId: 'a-vco', portId: 'saw' },           to: { nodeId: 'a-vca', portId: 'in_l' } },
      { id: 'e4', from: { nodeId: 'a-vco', portId: 'saw' },           to: { nodeId: 'a-vca', portId: 'in_r' } },
      { id: 'e5', from: { nodeId: 'a-sc',  portId: 'env_inv_out' },   to: { nodeId: 'a-vca', portId: 'strength_l' } },
      { id: 'e6', from: { nodeId: 'a-sc',  portId: 'env_inv_out' },   to: { nodeId: 'a-vca', portId: 'strength_r' } },
      { id: 'e7', from: { nodeId: 'a-vca', portId: 'out_l' },         to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  await page.waitForTimeout(800);

  // Hot SC (NOISE loud) → ducking active → STEREOVCA out attenuated.
  const duckedSnap = await readScopeSnapshot(page, 'a-scp');
  expect(duckedSnap).not.toBeNull();
  const duckedRms = summarize(duckedSnap!.ch1).rms;

  // Silence NOISE → no compression → env_inv_out → 1 → unity gain.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-n'];
      if (n) n.params.level = 0;
    });
  });
  await page.waitForTimeout(400);

  const openSnap = await readScopeSnapshot(page, 'a-scp');
  expect(openSnap).not.toBeNull();
  const openRms = summarize(openSnap!.ch1).rms;

  // openRms should be SIGNIFICANTLY greater than duckedRms. Pin a 1.5x
  // ratio (real-world separation is much larger; 1.5x is a flake-safe
  // floor).
  expect(openRms).toBeGreaterThan(duckedRms * 1.5);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. sc_hpf gate: low-frequency SC + high HPF cutoff → no ducking
// ────────────────────────────────────────────────────────────────────────────

test('SIDECAR sc_hpf gate: 50Hz into SC with hpf=800Hz → no ducking on audio_l_out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // We measure the same patch twice: first with sc_hpf=20 (off → 50 Hz
  // SC drives heavy ducking), then with sc_hpf=800 (HPF removes the 50
  // Hz SC content → no ducking). Compare audio_l_out RMS in each state.
  await spawnPatch(
    page,
    [
      { id: 'a-vco1', type: 'analogVco', position: { x: 60,  y: 60  }, domain: 'audio',
        params: { freq: 1000, level: 0.3 } },
      { id: 'a-vco2', type: 'analogVco', position: { x: 60,  y: 260 }, domain: 'audio',
        params: { freq: 50, level: 1.0 } },
      { id: 'a-sc',   type: 'sidecar',   position: { x: 360, y: 60  }, domain: 'audio',
        // Start with HPF OFF; switch to 800 mid-test.
        params: { threshold: -18, ratio: 8, attack: 5, release: 50, knee: 0, envMag: 1, makeup: 0, sc_hpf: 20 } },
      { id: 'a-scp',  type: 'scope',     position: { x: 760, y: 60  }, domain: 'audio' },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco1', portId: 'sine' }, to: { nodeId: 'a-sc',  portId: 'audio_l_in' } },
      { id: 'e2', from: { nodeId: 'a-vco1', portId: 'sine' }, to: { nodeId: 'a-sc',  portId: 'audio_r_in' } },
      { id: 'e3', from: { nodeId: 'a-vco2', portId: 'sine' }, to: { nodeId: 'a-sc',  portId: 'sc_l_in' } },
      { id: 'e4', from: { nodeId: 'a-vco2', portId: 'sine' }, to: { nodeId: 'a-sc',  portId: 'sc_r_in' } },
      { id: 'e5', from: { nodeId: 'a-sc',   portId: 'audio_l_out' }, to: { nodeId: 'a-scp', portId: 'ch1' } },
    ],
  );

  await page.waitForTimeout(800);

  // Baseline: HPF off → ducking active.
  const duckedSnap = await readScopeSnapshot(page, 'a-scp');
  expect(duckedSnap).not.toBeNull();
  const duckedRms = summarize(duckedSnap!.ch1).rms;

  // Now flip sc_hpf to 800 → 50 Hz SC content rolled off → no ducking.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-sc'];
      if (n) n.params.sc_hpf = 800;
    });
  });
  await page.waitForTimeout(500); // > release time + smoother + settle

  const openSnap = await readScopeSnapshot(page, 'a-scp');
  expect(openSnap).not.toBeNull();
  const openRms = summarize(openSnap!.ch1).rms;

  // With HPF=800, audio_l_out should be CLEARLY louder than with HPF=20.
  // The 50 Hz SC at amp 1.0 attenuated by 800 Hz HPF reaches detector
  // well below threshold → no compression → audio out passes unity.
  expect(openRms).toBeGreaterThan(duckedRms * 1.2);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
