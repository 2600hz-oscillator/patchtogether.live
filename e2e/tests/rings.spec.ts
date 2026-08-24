// e2e/tests/rings.spec.ts
//
// RINGS end-to-end coverage: instantiate the module in a real browser
// AudioContext, drive it with a noise exciter + STRUM gate, and verify
// the resonator produces audio at OUT — no crashes, no NaN/Inf in the
// scope buffer. Mirrors the BUGGLES/SHIMMERSHINE spec patterns
// (poll-scope-for-peak-above-threshold) to stay robust to transport-layer
// jitter under headless CI.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { pollScopePeak, scopePollMsg } from '../_helpers/scope-poll';

test.describe.configure({ mode: 'parallel' });

// The scope poller lives at ONE export site and runs its whole sampling loop
// INSIDE the page. The local copy this replaces did one CDP round trip per
// sample, on the same main thread as the audio graph it was measuring — the
// shape CLAUDE.md names, where a loaded runner starves both and "frozen" and
// "never looked" are indistinguishable from the output.

test('rings: drop module → card mounts with no console errors', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [{ id: 'r', type: 'rings', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-rings');
  await expect(card).toBeVisible();
  await expect(card).toContainText('RINGS');
  // The model-readout testid shows the current model name (MODAL by default).
  await expect(page.getByTestId('rings-model-name')).toHaveText(/MODAL|SYMPATHETIC/);
});

test('rings: NOISE exciter into RINGS produces audio at ODD output (sympathetic strings, looped)', async ({ page, rack }) => {
  // SYMPATHETIC model: pure-noise exciter + low damping + long ring. We
  // route white noise into the RINGS exciter input and tap ODD into a
  // scope to read back; speakers muted (master=0). Just verify the
  // resonator output goes above the silence floor.
  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',  position: { x:  50, y: 100 },
        params: { level: 0.7 } },
      { id: 'r',   type: 'rings',  position: { x: 350, y: 100 },
        params: {
          model: 1,           // SYMPATHETIC
          note: 0,
          structure: 0.5,
          brightness: 0.7,
          damping: 0.1,       // long ring
          position: 0.5,
          level: 0.9,
        } },
      { id: 'scp', type: 'scope',  position: { x: 700, y: 100 },
        params: { timeMs: 200, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 1000, y: 100 },
        params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'white' }, to: { nodeId: 'r',   portId: 'in'  } },
      { id: 'e2', from: { nodeId: 'r',   portId: 'odd'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );
  const stats = await pollScopePeak(page, 'scp', 0.01, 4000);
  expect(stats.peak, scopePollMsg(`rings.odd peak ${stats.peak} (after noise->rings.in)`, stats)).toBeGreaterThan(0.01);
  // Sanity: output is bounded (tanh limiter).
  expect(stats.peak).toBeLessThanOrEqual(1.0);
});

test('rings: STRUM with no external exciter + MODAL produces audio (self-excite)', async ({ page, rack }) => {
  // The bug we're fixing: MODAL used to require an external exciter and was
  // silent on STRUM alone. After the fix, STRUM injects a short noise burst
  // into MODAL so the resonator rings out without any audio input patched.
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'kria', position: { x:  50, y: 100 },
        params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: 'r',   type: 'rings',  position: { x: 350, y: 100 },
        params: {
          model: 0,           // MODAL
          note: 0,
          structure: 0.3,
          brightness: 0.7,
          damping: 0.15,      // long-ish ring so the burst is audible
          position: 0.0,
          level: 0.9,
        } },
      { id: 'scp', type: 'scope',  position: { x: 700, y: 100 },
        params: { timeMs: 200, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 1000, y: 100 },
        params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: 'r',   portId: 'strum' },
        sourceType: 'gate', targetType: 'gate' },
      { id: 'e2', from: { nodeId: 'r',   portId: 'odd'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );

  // Enable every sequencer step so the gate actually fires (default steps
  // are all `on: false`).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { steps?: unknown[] } }> };
    };
    const seq = w.__patch.nodes['seq'];
    if (seq) {
      if (!seq.data) seq.data = {};
      seq.data.steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
    }
  });

  const stats = await pollScopePeak(page, 'scp', 0.001, 6000);
  expect(stats.peak, scopePollMsg(`MODAL self-excite peak ${stats.peak}`, stats)).toBeGreaterThan(0.001);
  expect(stats.peak).toBeLessThanOrEqual(1.0);
});

test('rings: model button cycles MODAL ↔ SYMPATHETIC and updates label', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'r', type: 'rings', position: { x: 200, y: 200 } }]);

  const modelBtn = page.getByTestId('rings-model-btn');
  const modelName = page.getByTestId('rings-model-name');
  await expect(modelBtn).toBeVisible();
  await expect(modelName).toHaveText('MODAL');

  await modelBtn.click();
  await expect(modelName).toHaveText('SYMPATHETIC');

  await modelBtn.click();
  await expect(modelName).toHaveText('MODAL');
});

test('rings: model switch (MODAL ↔ SYMPATHETIC) — both produce audio', async ({ page, rack }) => {
  // Spawn with MODAL, verify audio; then change model → SYMPATHETIC,
  // verify audio again. Both should be non-silent.
  await spawnPatch(
    page,
    [
      { id: 'n',   type: 'noise',  position: { x:  50, y: 100 },
        params: { level: 0.9 } },
      { id: 'r',   type: 'rings',  position: { x: 350, y: 100 },
        params: {
          model: 0,
          structure: 0.3,
          brightness: 0.7,
          damping: 0.2,
          position: 0.0,
          level: 0.9,
        } },
      { id: 'scp', type: 'scope',  position: { x: 700, y: 100 },
        params: { timeMs: 200, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 1000, y: 100 },
        params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'n',   portId: 'white' }, to: { nodeId: 'r',   portId: 'in'  } },
      { id: 'e2', from: { nodeId: 'r',   portId: 'odd'   }, to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ],
  );
  // MODAL output.
  const modalStats = await pollScopePeak(page, 'scp', 0.001, 3000);
  expect(modalStats.peak, scopePollMsg(`MODAL peak=${modalStats.peak}`, modalStats)).toBeGreaterThan(0.001);

  // Switch model param to SYMPATHETIC via the shared patch store.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
    };
    const node = w.__patch.nodes['r'];
    if (node) {
      node.params.model = 1;
      node.params.damping = 0.1;
    }
  });
  // THE SWITCH ITSELF IS NOW ASSERTED. `peak > 0.01` below is a property BOTH
  // models share, so on its own it cannot fail on a `model` param that never
  // reached the engine — the test would have gone green against a dead
  // selector, measuring MODAL twice. Poll the engine's own value for `model`
  // so the switch is a checked step rather than an assumption.
  //
  // ⚠ SCOPE OF THIS ASSERTION, stated so it is not read as more than it is:
  // AudioEngine.readParam returns its knobValues cache (engine.ts:803), seeded
  // by setParam. So this proves STORE → ENGINE — the link that was entirely
  // unchecked — and NOT engine → worklet AudioParam. Proving the DSP actually
  // renders a different resonator needs a spectral statistic, which the scope
  // exposes no read key for; that half is raised with the owner rather than
  // bodged in here with a threshold nobody has measured.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __engine?: () => {
              readParam: (n: { id: string; type: string; domain: string }, k: string) => number | undefined;
            } | null;
            __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
          };
          const eng = w.__engine?.();
          const node = w.__patch.nodes['r'];
          if (!eng || !node) return null;
          return eng.readParam(node, 'model');
        }),
      { message: 'the engine takes up model = 1 (SYMPATHETIC), so the switch really happened' },
    )
    .toBe(1);

  // pacing: this wait SEPARATES TWO MEASUREMENTS and must survive as timed
  // semantics. RINGS is still ringing from MODAL when `model` flips, and the
  // resonator's decay is a product-side tail (`damping`, set to 0.1 just above).
  // Without this window `pollScopePeak` below can converge on the MODAL TAIL,
  // so the SYMPATHETIC reading would not be SYMPATHETIC's.
  await page.waitForTimeout(300);
  const sympStats = await pollScopePeak(page, 'scp', 0.01, 3000);
  expect(sympStats.peak, scopePollMsg(`SYMPATHETIC peak=${sympStats.peak}`, sympStats)).toBeGreaterThan(0.01);
});
