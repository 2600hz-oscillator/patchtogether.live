// e2e/tests/karplus-face.spec.ts
//
// KARPLUS's CURATED FACE, driven for real under `?shell=1`. Two claims that
// only a browser can settle, and neither is "the DOM re-labelled itself":
//
//   1. THE PLUCK MAKES SOUND. `karplus-strike` is a family cell with no backing
//      ParamDef, so every def-reading gate (contract-lock, module-face-lint,
//      module-docs-lint) is structurally blind to whether it does anything at
//      all, and faces-parity's `action` branch only asserts the button is
//      enabled and clicks it — a DEAD onFire passes the whole face green. This
//      clicks the real cell and listens at a SCOPE tap on the module's own
//      output. karplus is the module where that matters most: it has no
//      exciter and no envelope generator, so an unpatched, unplucked karplus
//      is not quiet, it is MUTE.
//   2. THE AUDITION IS NOT A GRAPH WRITE. The reason a one-shot is a shell
//      `action` and not a `strike` ParamDef is that it must leave `__patch`
//      untouched — nothing persisted, nothing shared with the rackspace,
//      nothing on the undo stack. That is asserted here against the REAL
//      graph, because it is exactly the property a future "just make it a
//      param" refactor would quietly destroy.
//
// NEGATIVE CONTROL, in-test and permanent: the silence window runs FIRST and
// asserts the tap reads ~0 with nothing patched into trigger_in. A silent-
// before / loud-after PAIR fails on a dead button AND on a tap that was never
// measuring this module — either half alone proves neither.
//
// AUDIO-AVAILABILITY: audio-only, no WebGL and no renderer tolerance needed.
//
// ⚠ THE OBSERVATION WINDOW IS A **POLL COUNT**, NOT A WALL-CLOCK BUDGET — the
// CLAUDE.md frame-count rule applied to the instrument that is actually
// renderer-dependent here. The AUDIO is genuinely wall-clock (an AudioContext
// advances on its own thread at a fixed sample rate) but the POLLS are not:
// each is a `page.evaluate` round-trip on the main thread, so "n polls after
// 900 ms" is a different assertion on every machine. `?shell=1` mounts the
// video-zone defaults, software-rasterized on CI, on that same thread — so the
// render loop is paused outright (installRenderSmokeHooks) and the loop counts
// POLLS with a wall-clock cap that BOUNDS THE FAILURE rather than gating it.
// This is the kickdrum-face.spec.ts recipe; nothing here involves a rendered
// frame.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// CI + a local `E2E_SWIFTSHADER=1` flake-check rasterize on the software
// renderer with 4 workers on a 4-vCPU runner. Only FAILURE BOUNDS scale — no
// window or assertion below moves.
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** Polls per observation window. The QUANTITY THE TEST IS ABOUT: each poll is
 *  one `readScopeSnapshot` over the scope's ~200 ms ring, so 8 polls cover the
 *  audible head of a 2 s karplus decay on any machine. */
const POLLS_PER_WINDOW = 8;
/** Wall-clock cap per window — a bound on the failure, never the gate. */
const WINDOW_CAP_MS = SLOW_RENDER ? 20_000 : 6_000;

/** Max-hold the scope tap over exactly `POLLS_PER_WINDOW` polls (or until the
 *  cap), optionally firing `onTick` before each poll so a pluck lands INSIDE
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

/** The whole persisted state of a node — params AND data — as one string. */
async function graphSnapshot(page: Page, nodeId: string): Promise<string> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: unknown; data?: unknown }> };
    };
    const n = w.__patch.nodes[id]!;
    return JSON.stringify({ params: n.params ?? {}, data: n.data ?? {} });
  }, nodeId);
}

test('karplus face: the dock PLUCK cell auditions an UNPATCHED string, and writes NOTHING to the graph', async ({ page }) => {
  // ⚠ SIZED, NOT FLAT (ci-swiftshader-video-e2e-timeouts). A failure bound
  // only — nothing green depends on it.
  test.setTimeout(SLOW_RENDER ? 120_000 : 60_000);

  // PAUSE THE VIDEO ENGINE BEFORE BOOT. `?shell=1` mounts the video-zone
  // defaults; on CI they are software-rasterized on the same main thread this
  // test does its `page.evaluate` round-trips against. This spec asserts
  // nothing about a rendered frame, so the render loop is pure contention.
  await installRenderSmokeHooks(page);
  await page.goto('/rack');
  // 30 s, not the 5 s default, and a FAILURE BOUND rather than the gate: the
  // FIRST navigation to /rack on a cold dev server compiles the whole route
  // graph on demand.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  // NOTHING is patched into trigger_in — that is the whole point. The only
  // wire is the module's own output into a scope tap. `decay` is left at its
  // 2 s default so the ring survives several polls.
  await spawnPatch(
    page,
    [
      { id: 'kp',  type: 'karplus', position: { x: 360, y: 60 },  domain: 'audio', params: { level: 0 } },
      { id: 'scp', type: 'scope',   position: { x: 820, y: 320 }, domain: 'audio', params: { timeMs: 200 } },
    ],
    [{ id: 'e1', from: { nodeId: 'kp', portId: 'out' }, to: { nodeId: 'scp', portId: 'ch1' } }],
  );

  const shell = page.locator('.svelte-flow__node[data-id="kp"] [data-testid="module-shell"]');
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();

  // The face's own shape, asserted where it is actually rendered: TWO bands,
  // and the PLUCK leads the second one (rank 7 in `order`, first in `pages` —
  // the deliberate disagreement).
  await expect(faceplate.locator('[data-face-page]')).toHaveCount(2);

  // ── NEGATIVE CONTROL, in-test: an unpatched, unplucked karplus is SILENT.
  // If this window were already loud, the "loud after" assert below would
  // prove nothing about the button. ──
  const before = await maxHold(page, 'scp');
  expect(
    before.polls,
    `the SCOPE tap was polled ${POLLS_PER_WINDOW}× during the silence window (units: POLLS, not ms)`,
  ).toBe(POLLS_PER_WINDOW);
  expect(
    before.peak,
    'karplus has no exciter: with nothing in trigger_in it is MUTE until it is plucked',
  ).toBeLessThan(0.01);

  const graphBefore = await graphSnapshot(page, 'kp');

  // ── The real cell, clicked. PLUCKS ARE COUNTED, NOT TIMED: one pluck whose
  // decay falls between two polls reads as a dead button, so pluck on the
  // FIRST poll and every third after it, then assert how many actually fired. ──
  const pluck = faceplate.getByTestId('shell-cell-karplus-strike');
  await expect(pluck, 'the audition cell is a real enabled button').toBeEnabled();
  let plucks = 0;
  const after = await maxHold(page, 'scp', async (i) => {
    if (i % 3 === 0) {
      await pluck.click();
      plucks++;
    }
  });
  expect(
    after.polls,
    `the SCOPE tap was polled ${POLLS_PER_WINDOW}× during the pluck window (units: POLLS)`,
  ).toBe(POLLS_PER_WINDOW);
  expect(plucks, 'more than one pluck landed inside the observed window (units: CLICKS)').toBeGreaterThan(1);
  expect(after.peak, 'PLUCK fires a real strike at the module output').toBeGreaterThan(0.03);
  expect(after.rms).toBeGreaterThan(0.001);

  // ── …AND IT IS NOT A GRAPH WRITE. This is the reason the audition is an
  // action cell rather than a `strike` ParamDef: a one-shot has no business
  // persisting into the Y.Doc, being shared with the rackspace, or landing on
  // the undo stack. Several plucks have now fired; the durable state must be
  // byte-identical to before them. ──
  expect(
    await graphSnapshot(page, 'kp'),
    'the audition must leave __patch untouched — no param moved, no data key appeared',
  ).toBe(graphBefore);

  // ── The CONTRAST that keeps the assertion above from being vacuous: a real
  // control on the same faceplate DOES reach `__patch`. Without this, "the
  // graph did not change" would also pass if the dock were wired to nothing
  // at all. ──
  const decay = faceplate.locator('[data-testid="control-decay"]');
  await decay.scrollIntoViewIfNeeded();
  const box = (await decay.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 40, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(
      () => page.evaluate(
        () => (globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } })
          .__patch.nodes['kp']!.params['decay'] ?? 2,
      ),
      { message: 'dragging DECAY on the same faceplate DOES commit to the shared patch graph' },
    )
    .not.toBe(2);
});
