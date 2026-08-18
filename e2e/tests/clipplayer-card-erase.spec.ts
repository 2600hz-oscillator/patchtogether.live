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

import { test, expect, creditSetupBudget } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

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

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 2 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: the stale-note class: erasing a note on a PLAYING clip from the card editor must reconcile the scheduler, or the erased voice rings out with nothing on screen to explain it.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('@clipplayer card note-editor erase RECONCILES a playing clip — added notes sound, clearing silences them', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack, errorWatch }) => {
  // ARRANGE — everything up to the CLEAR click is setup, and it is expensive
  // and load-dependent: on run 31833587260 it ran to t=29.6 s of a 30 s budget
  // (eight cell clicks alone cost 13.9 s, 1.0-2.4 s each), so the 15 s silence
  // poll below started with 0.4 s left and the test was reported as "the poll
  // exhausted its budget" when the poll never got a budget at all. The 15 s is
  // a PRODUCT tolerance — how long the scheduler may take to go quiet after an
  // erase — and it must not be a function of how long arranging took (#1648).
  const setupAt = Date.now();
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

  // ── ACT ─────────────────────────────────────────────────────────────────
  // CLEAR the clip from the card (⌫ → clearClip → reconcileClipRemoval): the
  // playing voice is cut + no notes remain → the output goes SILENT.
  //
  // Hand the arrange cost back FIRST, so the tolerance asserted below is the
  // 15 s it says it is rather than `30 s − whatever arranging cost` (#1648).
  creditSetupBudget(setupAt, 'spawnPatch + editor open + 8 cell clicks');
  await page.getByTestId('clipplayer-clear').click();

  // ⚠ The SCOPE analyser ring is ~2048 samples (~43 ms at 48 kHz), so the
  // first observation window necessarily still contains pre-clear audio and
  // can never read silent no matter how correct the product is — the poll
  // needs at least a second iteration BY CONSTRUCTION. That is fine against a
  // 15 s tolerance and fatal against the 0.4 s this test actually had.
  //
  // Keep every window so a red run prints WHY (#1650): `expect.poll` on a bare
  // number reports only the final value, which cannot distinguish "still
  // sounding" from "the sampler was starved" — the exact ambiguity
  // `readScopePeakOverWindow` was rewritten to remove, thrown away at the call
  // site. Recording them also makes the ring-floor above legible in the report:
  // window 1 loud + window 2 silent is the healthy shape, not a near miss.
  const observed: Awaited<ReturnType<typeof readScopePeakOverWindow>>[] = [];
  await expect
    .poll(
      async () => {
        const w = await readScopePeakOverWindow(page, 'ce-scp', 400);
        observed.push(w);
        return w.rms;
      },
      {
        timeout: 15_000,
        message:
          'cleared notes go silent (card erase reconciles the scheduler) — ' +
          'rms max-held over a 400 ms in-page window, floor 0.03',
      },
    )
    .toBeLessThan(0.03);

  const last = observed.at(-1);
  expect(last, 'the silence poll must have taken at least one window').toBeDefined();
  if (last) {
    expect(
      last.polls,
      `the SCOPE was actually sampled while proving silence — ` +
        `${observed.length} window(s), last: ${describeScopeWindow(last)}`,
    ).toBeGreaterThan(0);
  }
});
