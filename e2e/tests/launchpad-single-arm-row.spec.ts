// e2e/tests/launchpad-single-arm-row.spec.ts
//
// SINGLE-UNIT two-handed ARM ROW — cross-view-combo proof (PR #892). ONE
// Launchpad, clip-view top-row arm strip (CCs 91..97): arm-NEW -> tap empty ->
// edit (place a note) -> arm-COPY -> tap the new clip -> arm-PASTE -> tap a
// second slot -> LAUNCH the pasted clip -> it PLAYS (audible RMS through the
// REAL TIMELORDE->clipplayer->VCO->VCA->SCOPE chain). Same decode/dispatch path
// as hardware (installSimulatedLaunchpadSingle + the CC-98 view flip). The
// real-source-chain proof per CLAUDE.md: a pasted/new clip actually plays.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const CC_ARM_NEW = 91;
const CC_ARM_COPY = 92;
const CC_ARM_PASTE = 93;

async function setTransport(page: import('@playwright/test').Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-arm-test'] = {
          id: 'tl-arm-test', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
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

async function clipStepCount(page: import('@playwright/test').Page, slotIdx: number) {
  return page.evaluate((idx) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { clips?: Record<string, { steps?: unknown[] }> } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    const c = cp?.data?.clips?.[String(idx)];
    return Array.isArray(c?.steps) ? c!.steps!.length : -1;
  }, slotIdx);
}

async function lane0Playing(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { playing?: unknown[] } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.playing?.[0] ?? null;
  });
}

test('@launchpad single-unit ARM ROW: NEW->edit->COPY->PASTE on one device, the pasted clip launches -> audible RMS', async ({
  page,
}) => {
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
      { id: 'r-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'r-vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'r-vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
        params: { base: 0, cvAmount: 1 } },
      { id: 'r-scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'h1', from: { nodeId: 'r-cp', portId: 'pitch1' }, to: { nodeId: 'r-vco', portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: 'h2', from: { nodeId: 'r-vco', portId: 'sine' }, to: { nodeId: 'r-vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'h3', from: { nodeId: 'r-cp', portId: 'gate1' }, to: { nodeId: 'r-vca', portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      { id: 'h4', from: { nodeId: 'r-vca', portId: 'audio' }, to: { nodeId: 'r-scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    if (!w.__launchpadTestInstallSingle) return false;
    return await w.__launchpadTestInstallSingle('r-cp');
  });
  expect(installed, 'single simulated Launchpad install hook present').toBe(true);

  const drive = (cmd: 'cc' | 'press' | 'release' | 'viewFlip', a = 0, b = 0) =>
    page.evaluate(({ cmd, a, b }) => {
      const sim = (globalThis as unknown as { __launchpadSingleSim?: Record<string, (...n: number[]) => void> })
        .__launchpadSingleSim;
      if (!sim) return;
      if (cmd === 'viewFlip') sim.viewFlip();
      else sim[cmd](a, b);
    }, { cmd, a, b });
  const simState = () =>
    page.evaluate(() =>
      (globalThis as unknown as {
        __launchpadSingleSim?: { state: () => { activeView: string; mode: string; armedAction: string | null } };
      }).__launchpadSingleSim!.state(),
    );

  // (1) Clip view: arm NEW (CC 91) -> tap the TOP-LEFT pad (slot 0, lane 0 = y=7).
  await drive('cc', CC_ARM_NEW, 127);
  await expect.poll(() => simState().then((s) => s.armedAction)).toBe('new');
  await drive('press', 0, 7);
  await expect.poll(() => simState().then((s) => s.mode)).toBe('edit');
  await expect.poll(() => simState().then((s) => s.activeView)).toBe('control');
  await expect.poll(() => clipStepCount(page, 0)).toBe(0);

  // (2) Editor (control view): tap a grid pad (step 0, lowest pitch) to add a note.
  await drive('press', 0, 0);
  await drive('release', 0, 0);
  await expect.poll(() => clipStepCount(page, 0), { timeout: 5000 }).toBeGreaterThan(0);

  // (3) Back to CLIP view; arm COPY (CC 92) -> tap the new clip.
  await drive('viewFlip');
  await expect.poll(() => simState().then((s) => s.activeView)).toBe('clip');
  await drive('cc', CC_ARM_COPY, 127);
  await expect.poll(() => simState().then((s) => s.armedAction)).toBe('copy');
  await drive('press', 0, 7);

  // (4) Arm PASTE (CC 93) -> tap a SECOND slot (slot 1, lane 0 = x=1, y=7).
  await drive('cc', CC_ARM_PASTE, 127);
  await expect.poll(() => simState().then((s) => s.armedAction)).toBe('paste');
  await drive('press', 1, 7);
  await expect.poll(() => clipStepCount(page, 1), { timeout: 5000 }).toBeGreaterThan(0);

  // (5) Silent before launching the pasted clip; transport runs.
  await setTransport(page, 1);
  const before = await readScopePeakOverWindow(page, 'r-scp', 500);
  expect(before.rms, 'silent before the pasted clip launches').toBeLessThan(0.03);

  // (6) LAUNCH the pasted clip (slot 1, lane 0) from the matrix.
  await drive('press', 1, 7);
  await expect.poll(() => lane0Playing(page), { timeout: 5000 }).toBe(1);

  // (7) The pasted clip RUNS -> AUDIBLE structured RMS. The launch is QUANTIZED,
  // so the audio doesn't start until the next quantize boundary — which can be
  // more than one measurement window out at the test tempo. A single-shot read
  // here sometimes samples the pre-boundary silence (flaky ~0.003 vs the 0.03
  // floor), so POLL the RMS window until the clip actually rings (or time out).
  let after = await readScopePeakOverWindow(page, 'r-scp', 600);
  await expect
    .poll(
      async () => {
        after = await readScopePeakOverWindow(page, 'r-scp', 600);
        return after.rms;
      },
      { timeout: 8000, message: 'audible RMS after launching the pasted clip' },
    )
    .toBeGreaterThan(0.03);
  expect(after.polls, 'SCOPE polled').toBeGreaterThan(0);
  expect(after.rms, 'the pasted-clip launch raised the output').toBeGreaterThan(before.rms + 0.02);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// SINGLE-UNIT DOUBLE-TAP -> editor (PR #892). On one device, CLIP view: a single
// tap launches, a DOUBLE-tap of the same clip opens its note editor + flips to
// CONTROL — the one-device analogue of the card's double-click-to-edit. The two
// taps are fired BACK-TO-BACK inside one page.evaluate (gap ~= 0 scheduler ticks)
// so the real-clock window is hit deterministically — no inter-tap round-trip
// latency to flake on. Asserts the editor opened on the right clip.
test('@launchpad single-unit DOUBLE-TAP a clip pad -> opens its note editor (control view)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [{ id: 'd-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio', params: {} }],
    [],
  );
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    if (!w.__launchpadTestInstallSingle) return false;
    return await w.__launchpadTestInstallSingle('d-cp');
  });
  expect(installed, 'single simulated Launchpad install hook present').toBe(true);

  const simState = () =>
    page.evaluate(() =>
      (globalThis as unknown as {
        __launchpadSingleSim?: { state: () => { activeView: string; mode: string; editClipIndex: number } };
      }).__launchpadSingleSim!.state(),
    );

  // Seed an existing clip at the TOP-LEFT pad (slot 0, lane 0 = y=7) so the
  // double-tap edits a LOADED clip (not a create).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
      if (cp) cp.data = { clips: { '0': { kind: 'note', lengthSteps: 16, steps: [] } } };
    });
  });

  // Start in CLIP view.
  await expect.poll(() => simState().then((s) => s.activeView)).toBe('clip');

  // DOUBLE-TAP the top-left pad back-to-back (one round-trip → ~0-tick gap).
  await page.evaluate(() => {
    const sim = (globalThis as unknown as { __launchpadSingleSim?: { press: (x: number, y: number) => void } })
      .__launchpadSingleSim!;
    sim.press(0, 7); // 1st tap → launch
    sim.press(0, 7); // 2nd tap (same clip, no tick between) → open editor
  });

  // The editor opened on clip index 0 + the lone device flipped to CONTROL.
  await expect.poll(() => simState().then((s) => s.mode), { timeout: 5000 }).toBe('edit');
  await expect.poll(() => simState().then((s) => s.activeView)).toBe('control');
  await expect.poll(() => simState().then((s) => s.editClipIndex)).toBe(0);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
