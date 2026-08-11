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
// vacuous one.
//
// ⚠ THE OBSERVATION WINDOW IS A **POLL COUNT**, NOT A WALL-CLOCK BUDGET, and
// that is the CLAUDE.md frame-count rule applied to the instrument that is
// actually renderer-dependent here. The AUDIO is genuinely wall-clock — an
// AudioContext advances on its own thread at a fixed sample rate — but the
// POLLS are not: each one is a `page.evaluate` round-trip on the main thread,
// so `polls > 3 after 900 ms` is a different assertion on every machine. This
// spec boots `?shell=1`, which mounts the video-zone defaults (videoOut +
// recorderbox + synesthesia) on CI's SwiftShader software renderer, then does
// ~45 round-trips against that contended thread. Under load the old form could
// collect 2 polls and land ONE strike inside the "four strikes" window.
//
// So: loop until N polls (renderer-independent by construction), with a
// wall-clock cap that BOUNDS THE FAILURE rather than gating it — and pause the
// video engine's rAF loop outright (installRenderSmokeHooks) so the software
// rasterizer is not competing for the thread we are polling on in the first
// place. Nothing about this test's claims involves a rendered frame.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// CI + a local `E2E_SWIFTSHADER=1` flake-check rasterize on the software
// renderer with 4 workers on a 4-vCPU runner (the faces-parity SLOW_RENDER
// idiom). Only FAILURE BOUNDS scale — no window or assertion below moves.
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** Polls per observation window. The QUANTITY THE TEST IS ABOUT: each poll is
 *  one `readScopeSnapshot`, and the scope's ring is ~200 ms, so 8 polls cover
 *  the decay of a kick on any machine. */
const POLLS_PER_WINDOW = 8;
/** Wall-clock cap per window — a bound on the failure, never the gate. At
 *  ~60 ms/poll locally this is never reached; on a loaded runner it turns a
 *  hang into a readable "only k of 8 polls" message. */
const WINDOW_CAP_MS = SLOW_RENDER ? 20_000 : 6_000;

/** Max-hold the scope tap over exactly `POLLS_PER_WINDOW` polls (or until the
 *  cap), optionally firing `onTick` before each poll so a strike lands INSIDE
 *  the observed window. Returns the poll count so the caller can assert the
 *  window was really observed rather than assuming it. */
async function maxHold(
  page: Page,
  scopeId: string,
  onTick?: (i: number) => Promise<void>,
): Promise<{ peak: number; rms: number; polls: number }> {
  const deadline = Date.now() + WINDOW_CAP_MS;
  let peak = 0;
  let rms = 0;
  let polls = 0;
  let i = 0;
  while (polls < POLLS_PER_WINDOW && Date.now() < deadline) {
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
  // ⚠ SIZED, NOT FLAT (ci-swiftshader-video-e2e-timeouts). Playwright's 30 s
  // default was the WHOLE budget for a test whose topbar wait alone is allowed
  // 30 s, and `faces-parity` documents a 13.2 s cold `/rack?shell=legacy&seed=none` compile under
  // SwiftShader on this exact route. A failure bound only — nothing green
  // depends on it.
  test.setTimeout(SLOW_RENDER ? 120_000 : 60_000);

  // PAUSE THE VIDEO ENGINE BEFORE BOOT. `?shell=1` mounts the video-zone
  // defaults; on CI they are software-rasterized on the same main thread this
  // test does ~45 `page.evaluate` round-trips against. This spec asserts
  // nothing about a rendered frame, so the render loop is pure contention —
  // the same reason workflow-channel-columns installs it.
  await installRenderSmokeHooks(page);
  await page.goto('/rack');
  // ⚠ 30 s, not the 5 s default, and it is a FAILURE BOUND rather than the
  // gate: the FIRST navigation to /rack?shell=legacy&seed=none on a cold dev server compiles the whole
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
  const before = await maxHold(page, 'scp');
  expect(
    before.polls,
    `the SCOPE tap was polled ${POLLS_PER_WINDOW}× during the silence window (units: POLLS, not ms)`,
  ).toBe(POLLS_PER_WINDOW);
  expect(before.peak, 'an unpatched kick makes no sound until it is struck').toBeLessThan(0.01);

  // ── The real cell, clicked. STRIKES ARE COUNTED, NOT TIMED: the old form
  // fired on `i % 5 === 0` inside a 1800 ms window, so a loaded runner that
  // managed two iterations landed exactly ONE strike — and one strike whose
  // decay falls between two polls reads as a dead button. Strike on the FIRST
  // poll and every third after it, then assert how many actually fired. ──
  const strike = faceplate.getByTestId('shell-cell-kickdrum-strike');
  await expect(strike, 'the audition cell is a real enabled button').toBeEnabled();
  let strikes = 0;
  const after = await maxHold(page, 'scp', async (i) => {
    if (i % 3 === 0) {
      await strike.click();
      strikes++;
    }
  });
  expect(
    after.polls,
    `the SCOPE tap was polled ${POLLS_PER_WINDOW}× during the strike window (units: POLLS)`,
  ).toBe(POLLS_PER_WINDOW);
  expect(strikes, 'more than one hit landed inside the observed window (units: CLICKS)').toBeGreaterThan(1);
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
