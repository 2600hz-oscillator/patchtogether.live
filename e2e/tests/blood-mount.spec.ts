// e2e/tests/blood-mount.spec.ts
//
// LIVE smoke coverage that the BLOOD video module spawns + its card mounts
// cleanly, that its idle GL surface (the "no signal" shader) paints without a
// page error, and that it boots OUT-OF-BOX from the BUNDLED 1997 shareware data.
//
// CI-SAFE SCOPE (capability-dependent-e2e lesson): the engine blood.js +
// blood.wasm AND the 1997 Blood SHAREWARE data (BLOOD.RFF/GUI.RFF/SOUNDS.RFF/
// SHARE000.ART/*.DAT) are now BOTH committed under static/blood/ (the shareware
// is LFS-tracked + un-ignored), so the card fetches them and tries to boot with
// no picker. But CI runs the SwiftShader software renderer (no real GPU) and the
// Build-engine boot path is renderer/heap-sensitive, so we do NOT assert a
// decoded game frame here. We assert only the renderer-INDEPENDENT invariants:
//   - the card mounts (ownerOnly + maxInstances:1, lone-host rack),
//   - the GL surface compiles + draws the idle shader (no pageerror),
//   - boot reaches a DEFINITE terminal state (running OR an engine error) — and
//     crucially NOT the "data missing" prompt, because the shareware is bundled,
//   - no uncaught page error from spawn / shader / boot.
// The REAL rendered-frame proof lives in the local/owner harness
// (packages/web/native/nblood/blood-frame-harness.mjs), which boots the engine
// from the same bundled shareware and asserts a valid framebuffer on a machine
// with a real renderer.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// BOUNDS, not assertions (boot-budget.ts): this spec rode the DEFAULT 30 s
// test timeout with a flat 20 s poll, and a COLD Build-WASM boot (LFS-served
// shareware fetch + wasm compile + heap-sensitive Build init) does not fit
// that on a 2-core SwiftShader VM. Measured on #1967: when two new specs
// re-packed the shard plan, this spec retry-recovered on THREE consecutive
// runs (attempt 1 cut at 30 s, warm attempt 2 green in seconds; 3/3 green
// locally in ~4 s) — the runner lottery boot-budget.ts documents, so it takes
// the shared bounds like every other boot-heavy spec. No assertion changed.
test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

test('BLOOD card mounts, idle surface paints, and boots out-of-box from bundled shareware', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');

  const bloodId = 'blood-mount-smoke';
  await spawnPatch(
    page,
    [{ id: bloodId, type: 'blood', position: { x: 120, y: 80 }, domain: 'video' }],
    [],
  );

  // The faceplate mounts (we're the lone host of a single-user rack, so the
  // ownerOnly gate is satisfied). The game screen is `fullViewBody` — dock
  // only — so open the pane; boot state rides `data-blood-status` on the face
  // frame (idle/loading/error/ready).
  await expect(
    page.locator(`.svelte-flow__node[data-id="${bloodId}"] [data-testid="module-shell"]`),
  ).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    bloodId,
  );
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${bloodId}"]`);
  await expect(pane.getByTestId('blood-screen-body')).toBeVisible({ timeout: 60_000 });

  // The body auto-boots from the bundled shareware on mount. It must reach a
  // DEFINITE terminal state — either ready (engine booted), an engine error
  // (e.g. the renderer/heap-sensitive Build init on CI's software renderer),
  // or idle (no engine node yet). What we forbid is a stuck "loading" or a
  // thrown page error.
  await expect
    .poll(
      async () =>
        (await pane.getByTestId('blood-face-frame').getAttribute('data-blood-status')) ?? 'gone',
      // The cold-boot bound (see header): BOOT_MS scales for the CI renderer;
      // the wait exits the instant a terminal state paints.
      { timeout: BOOT_MS * 2 },
    )
    .toMatch(/^(ready|error|idle)$/);

  // Because the shareware data IS bundled + served, the "bundled data couldn't
  // load" prompt must NOT be the outcome. (If it ever shows, the bundle/LFS
  // checkout is broken — which is exactly what we want this assert to catch.)
  const dataMissing = await pane
    .getByTestId('blood-face-data-missing')
    .isVisible()
    .catch(() => false);
  expect(dataMissing, 'bundled shareware should load — the data-missing prompt must not show').toBe(
    false,
  );

  // No uncaught page error from spawning the module, compiling its shader, or
  // the boot attempt — the engine-boot path is handled, not thrown to the page.
  expect(errors, `unexpected page errors:\n${errors.join('\n')}`).toEqual([]);

  // ── RENDER REGRESSION (only when the engine actually booted) ───────────────
  // These read the SOFTWARE-rendered Build framebuffer via the stable bpt_*
  // surface (CPU pixels — renderer-INDEPENDENT, so SwiftShader-safe), gated on
  // the engine reaching 'ready' so CI runners that can't boot the heap/renderer-
  // sensitive engine stay lenient (same contract as the boot-state poll above).
  //   • bug #2 (black scene): the engine loads tiles000.art but the shareware
  //     ships SHARE000.ART; bpt_init aliases it so the main-menu blood-drip
  //     border renders. Missing ART left the top of the screen ~black.
  //   • bug #1 (frozen engine clock): clock_gettime(CLOCK_MONOTONIC_RAW) is
  //     unsupported on emscripten, so totalclock never advanced → the menu was
  //     FROZEN (no cursor pulse / animation, dead game tics). The fix
  //     (CLOCK_MONOTONIC) makes the idle menu animate, so the framebuffer
  //     changes over time with NO input.
  const booted =
    (await pane.getByTestId('blood-face-frame').getAttribute('data-blood-status')) === 'ready';
  // The render probe reads the runtime via the __engine test hook (VITE_E2E_HOOKS,
  // same as the DOOM specs). If hooks are stripped (e.g. a prod-preview run) there
  // is nothing to read — skip rather than false-fail.
  const hooks = await page.evaluate(
    () => typeof (globalThis as unknown as { __engine?: unknown }).__engine === 'function',
  );
  if (booted && hooks) {
    const NODE_ID = bloodId;
    const sample = () =>
      page.evaluate((id) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain?: (d: string) => { read?: (i: string, k: string) => unknown } | null;
          } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        const ex = ve?.read?.(id, 'extras') as
          | { getRuntime?: () => { getFramebuffer?: () => ArrayLike<number> | null; resolution?: () => { width: number; height: number } } | null }
          | undefined;
        const rt = ex?.getRuntime?.();
        const fb = rt?.getFramebuffer?.();
        const res = rt?.resolution?.();
        if (!fb || !res || !res.width || !res.height) return null;
        let hash = 0x811c9dc5;
        let topNonBlack = 0;
        const topRows = Math.floor(res.height * 0.1);
        for (let i = 0; i < fb.length; i += 4) {
          hash ^= fb[i];
          hash = (hash * 0x01000193) >>> 0;
        }
        for (let y = 0; y < topRows; y++)
          for (let x = 0; x < res.width; x++) {
            const i = (y * res.width + x) * 4;
            if (fb[i] | fb[i + 1] | fb[i + 2]) topNonBlack++;
          }
        return { hash: hash >>> 0, topNonBlack, w: res.width, h: res.height };
      }, NODE_ID);

    // Give the menu a moment to settle, then sample.
    await page.waitForTimeout(800);
    const s0 = await sample();
    expect(s0, 'runtime framebuffer is readable once booted').not.toBeNull();
    if (s0) {
      // bug #2: the drip border (top 10% of the screen) must be substantially lit.
      const topMin = Math.floor(s0.w * Math.floor(s0.h * 0.1) * 0.02);
      expect(
        s0.topNonBlack,
        `bug #2 regression: the main-menu blood-drip border is ~black (${s0.topNonBlack}) — ` +
          `game ART (tiles000.art) did not load (SHARE000.ART→TILES000.ART alias broken)`,
      ).toBeGreaterThan(topMin);

      // bug #1: the idle menu must ANIMATE (cursor pulse + drip droplets) — i.e.
      // the framebuffer changes over ~1.5s with no input. A frozen engine clock
      // (the CLOCK_MONOTONIC_RAW bug) leaves it byte-for-byte identical.
      let animated = false;
      for (let i = 0; i < 8 && !animated; i++) {
        await page.waitForTimeout(200);
        const s = await sample();
        if (s && s.hash !== s0.hash) animated = true;
      }
      expect(
        animated,
        'bug #1 regression: the idle menu framebuffer is FROZEN — the engine clock (totalclock) is ' +
          'not advancing (CLOCK_MONOTONIC_RAW unsupported on wasm); the menu cursor/animation is dead',
      ).toBe(true);
    }
  }
});
