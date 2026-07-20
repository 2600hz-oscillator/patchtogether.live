// e2e/tests/clipplayer-card-erase.spec.ts
//
// STALE-NOTE FIX — card path (redesign §3.1, adversarial-review B2). The
// on-screen note editor must RECONCILE the scheduler when you erase a note on a
// PLAYING clip, exactly like the Launchpad editor — otherwise the erased voice
// rings out. This drives the REAL card DOM (double-click a pad → edit view →
// launch → add notes by clicking cells → clear) through the REAL audio chain:
//
//   clipplayer.pitch1 → VCO.pitch ; VCO.sine → VCA.audio ;
//   clipplayer.gate1  → VCA.cv    ; VCA.audio → SCOPE.ch1
//
// Notes ADDED from the card play back AUDIBLY; CLEARING them (⌫, which now calls
// reconcileClipRemoval) makes the output go SILENT — proving the card erase path
// is wired to the reconcile, not just the Launchpad path.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

async function setTransport(page: import('@playwright/test').Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-erase'] = {
          id: 'tl-erase', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
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

test('@clipplayer card note-editor erase RECONCILES a playing clip — added notes sound, clearing silences them', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'ce-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.95, octave: 0 } },
      { id: 'ce-vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'ce-vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
        params: { base: 0, cvAmount: 1 } },
      { id: 'ce-scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'ce1', from: { nodeId: 'ce-cp', portId: 'pitch1' }, to: { nodeId: 'ce-vco', portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: 'ce2', from: { nodeId: 'ce-vco', portId: 'sine' }, to: { nodeId: 'ce-vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'ce3', from: { nodeId: 'ce-cp', portId: 'gate1' }, to: { nodeId: 'ce-vca', portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      { id: 'ce4', from: { nodeId: 'ce-vca', portId: 'audio' }, to: { nodeId: 'ce-scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );
  const card = page.getByTestId('clipplayer-card').first();
  await card.waitFor({ state: 'visible' });

  // Open the note editor on lane 0 / slot 0 + LAUNCH the edited clip (so it is
  // the PLAYING clip — the reconcile only fires on a playing clip).
  await card.locator('.pad').first().dblclick();
  await page.getByTestId('clipplayer-editor').waitFor({ state: 'visible' });
  await page.getByTestId('clipplayer-edit-now').click();
  await setTransport(page, 1);

  // Empty clip → silent.
  const before = await readScopePeakOverWindow(page, 'ce-scp', 400);
  expect(before.rms, 'silent before any note is placed').toBeLessThan(0.03);

  // ADD notes on the bottom row across several steps → dense, reliably audible
  // over a loop window.
  for (const step of [0, 1, 2, 3, 4, 5, 6, 7]) {
    await page.getByTestId(`clipplayer-cell-0-${step}`).click();
  }
  const during = await readScopePeakOverWindow(page, 'ce-scp', 1200);
  expect(during.polls, 'SCOPE polled').toBeGreaterThan(0);
  expect(during.rms, 'added notes play back AUDIBLY').toBeGreaterThan(0.03);
  expect(during.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);

  // CLEAR the clip from the card (⌫ → clearClip → reconcileClipRemoval): the
  // playing voice is cut + no notes remain → the output goes SILENT.
  await page.getByTestId('clipplayer-clear').click();
  await expect
    .poll(async () => (await readScopePeakOverWindow(page, 'ce-scp', 400)).rms, {
      timeout: 15_000,
      message: 'cleared notes go silent (card erase reconciles the scheduler)',
    })
    .toBeLessThan(0.03);
});
