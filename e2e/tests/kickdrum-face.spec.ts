// e2e/tests/kickdrum-face.spec.ts
//
// KICK DRUM's CURATED FACE, driven for real under `?shell=1`. Two claims that
// only a browser can settle, and neither is "the DOM re-labelled itself":
//
//   1. THE AUDITION MAKES SOUND. `kickdrum-strike` is a family cell with no
//      backing ParamDef, so every def-reading gate (contract-lock,
//      module-face-lint, module-docs-lint) is structurally blind to whether it
//      does anything at all — a dead button passes all three. This clicks the
//      real cell and listens at a SCOPE tap on the module's own output.
//      The test carries its OWN negative control: it first proves the tap
//      reads SILENCE with nothing patched into trigger_in, then strikes. A
//      silent-before / loud-after pair fails on a dead button AND on a tap
//      that was never measuring this module.
//   2. THE HARD SWITCH CHANGES THE GRAPH. faces-parity proves the cell is
//      operable; this proves the operation reaches `__patch` — the durable,
//      shared, undoable state — rather than only the pixel.
//
// AUDIO-AVAILABILITY: audio-only, no WebGL and no renderer tolerance needed.
// The silence baseline runs FIRST, so an environment where the audio graph
// genuinely never ran fails the LOUD assert loudly rather than passing a
// vacuous one. Waits are wall-clock on purpose: an AudioContext advances on
// its own audio thread at a fixed sample rate, not on rAF, so seconds here are
// a renderer-independent quantity (unlike a frame budget).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

/** Max-hold the scope tap for `windowMs`, optionally firing `onTick` between
 *  polls (so a strike can land INSIDE the observed window). */
async function maxHold(
  page: Page,
  scopeId: string,
  windowMs: number,
  onTick?: (i: number) => Promise<void>,
): Promise<{ peak: number; rms: number; polls: number }> {
  const deadline = Date.now() + windowMs;
  let peak = 0;
  let rms = 0;
  let polls = 0;
  let i = 0;
  while (Date.now() < deadline) {
    if (onTick) await onTick(i);
    const snap = await readScopeSnapshot(page, scopeId);
    if (snap) {
      const s = summarize(snap.ch1);
      if (s.peak > peak) peak = s.peak;
      if (s.rms > rms) rms = s.rms;
      polls++;
    }
    i++;
    await page.waitForTimeout(60);
  }
  return { peak, rms, polls };
}

test('kickdrum face: the dock STRIKE cell auditions an UNPATCHED kick, and HARD writes the graph', async ({ page }) => {
  await page.goto('/rack?mode=workflow&shell=1');
  // ⚠ 30 s, not the 5 s default, and it is a FAILURE BOUND rather than the
  // gate: the FIRST navigation to /rack on a cold dev server compiles the whole
  // route graph on demand, which measured >5 s here on a fresh worktree and
  // failed this line once before any of the real assertions ran. Nothing about
  // the claims below depends on how long the boot took.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  // NOTHING is patched into trigger_in — that is the whole point. The only
  // wire is the module's own output into a scope tap.
  await spawnPatch(
    page,
    [
      { id: 'kd',  type: 'kickdrum', position: { x: 360, y: 60 },  domain: 'audio', params: { level: 0 } },
      { id: 'scp', type: 'scope',    position: { x: 820, y: 320 }, domain: 'audio', params: { timeMs: 200 } },
    ],
    [{ id: 'e1', from: { nodeId: 'kd', portId: 'audio_l' }, to: { nodeId: 'scp', portId: 'ch1' } }],
  );

  const shell = page.locator('.svelte-flow__node[data-id="kd"] [data-testid="module-shell"]');
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();

  // ── NEGATIVE CONTROL, in-test: an unpatched, un-struck kick is SILENT. If
  // this window were already loud the "loud after" assert below would prove
  // nothing about the button. ──
  const before = await maxHold(page, 'scp', 900);
  expect(before.polls, 'the SCOPE tap was polled during the silence window').toBeGreaterThan(3);
  expect(before.peak, 'an unpatched kick makes no sound until it is struck').toBeLessThan(0.01);

  // ── The real cell, clicked. Four strikes across the window so the analyser
  // cannot land entirely in a decay trough (the max-hold discipline for
  // percussive voices). ──
  const strike = faceplate.getByTestId('shell-cell-kickdrum-strike');
  await expect(strike, 'the audition cell is a real enabled button').toBeEnabled();
  const after = await maxHold(page, 'scp', 1800, async (i) => {
    if (i % 5 === 0) await strike.click();
  });
  expect(after.polls).toBeGreaterThan(3);
  expect(after.peak, 'STRIKE fires a real hit at the module output').toBeGreaterThan(0.05);
  expect(after.rms).toBeGreaterThan(0.001);

  // ── The HARD switch is a real GRAPH write, not a pixel. ──
  const hardBefore = await page.evaluate(
    () => (globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } })
      .__patch.nodes['kd']!.params['hard'] ?? 0,
  );
  expect(hardBefore, 'HARD rests OFF (the shipping clean-warm default)').toBe(0);

  await faceplate.locator('[data-testid="control-hard"]').click();
  await expect
    .poll(
      () => page.evaluate(
        () => (globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } })
          .__patch.nodes['kd']!.params['hard'],
      ),
      { message: 'flipping HARD commits to the shared patch graph' },
    )
    .toBe(1);
});
