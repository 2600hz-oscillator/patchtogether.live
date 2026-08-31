// e2e/tests/blood-face-screen.spec.ts
//
// THE BLOOD FACE (2026-08-31) — the render legs for a promotion whose failure
// mode is a module that never starts.
//
// ── WHY THIS FILE IS MANDATORY RATHER THAN NICE TO HAVE ────────────────────
//
// blood is in `FACES_WITHOUT_SCENES`, so NO VRT baseline exists for its
// faceplate at either tier and nothing anywhere compares its pixels. Together
// with the `face-screen-render-suite` row this file is the only automated check
// that the body paints at all.
//
// And it carries a second, sharper duty. `extras.ensureLoaded()` is what turns
// a BLOOD node from a dark scanline field into a running Build engine; before
// this promotion it had EXACTLY ONE CALLER IN THE TREE and it was
// `BloodCard.svelte`, which the shipping shell stops mounting the moment blood
// is promoted. blood is in neither half of `HEADLESS_MOUNT_LANE_TYPES`, so
// nothing keeps that card alive off-screen either. A body that mounted a
// beautiful canvas and forgot to boot would satisfy every source gate, every
// registry test, the face lint, the parity sweep and the SCREEN-switch suite —
// and ship a module that is dark forever. The first test below is the check
// that goes red on exactly that, and it is written as a PAIR: the engine must
// be UNBOOTED before the faceplate opens, and BOOTED after.
//
// ⚠ EVERY TEST CARRIES A `pageerror` GUARD. A shared derivation repaired on
// `ModuleShellPlaceholder` can still throw inside `ModuleShell`, and only
// promoting reveals it — a body that throws on mount leaves the dock empty and
// several assertions below would fail with a confusing locator message instead
// of the exception that caused it.
//
// ⚠ NO WALL-CLOCK WAITS DECIDE ANYTHING. Every wait is an auto-retrying
// `expect` / `expect.poll` on the real subject, and the in-page sampler
// (`frameSignatures`) counts FRAMES in ONE evaluate rather than round-tripping
// per sample — two round trips on the same main thread as the subject cannot
// tell "frozen" from "never looked". The only wall-clock numbers are BUDGETS,
// taken from the one export site in `boot-budget.ts`, and they bound a failure
// rather than gating one.

import { test, expect, type Page } from '@playwright/test';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { spawnPatch } from './_helpers';

const BLOOD_ID = 'blood-face';

const NODES = [
  { id: BLOOD_ID, type: 'blood', position: { x: 120, y: 80 }, domain: 'video' as const },
];

/** Are the `__engine` test hooks present? A prod-preview build strips them, and
 *  there is then nothing to read — skip rather than false-fail (the standing
 *  pattern in every other blood spec). */
async function hasHooks(page: Page): Promise<boolean> {
  return page.evaluate(
    () => typeof (globalThis as unknown as { __engine?: unknown }).__engine === 'function',
  );
}

/**
 * The engine's OWN `loaded` latch for this node, read through `read(id,
 * 'loaded')`.
 *
 * ⚠ THIS IS THE DIRECT OBSERVATION, not a proxy for one. `loaded` is set in
 * exactly one place in `blood.ts` — inside `ensureLoaded` — so `true` means that
 * function ran, and nothing else in the app can make it true. Returns null when
 * the node is not in the video domain yet.
 */
async function engineLoaded(page: Page, id: string): Promise<boolean | null> {
  return page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { read?: (i: string, k: string) => unknown } | null;
      } | null;
    };
    try {
      const ve = w.__engine?.()?.getDomain?.('video');
      const v = ve?.read?.(nodeId, 'loaded');
      return typeof v === 'boolean' ? v : null;
    } catch {
      return null;
    }
  }, id);
}

/** Sample the runtime's software framebuffer hash `n` times, `frames` apart, IN
 *  THE PAGE — one evaluate, never a Playwright poll loop (two round-trips on the
 *  same main thread as the subject cannot tell "frozen" from "never looked").
 *  Renderer-independent: it reads the engine's own CPU pixels, not the GL
 *  canvas, so it means the same thing under SwiftShader. */
async function frameSignatures(page: Page, id: string, samples: number, framesApart: number) {
  return page.evaluate(
    async ({ nodeId, samples, framesApart }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
      };
      const ve = w.__engine?.()?.getDomain('video');
      const ex = ve?.read(nodeId, 'extras') as
        | { getRuntime: () => { isInitialized: () => boolean; getFramebuffer: () => ArrayLike<number> | null } | null }
        | undefined;
      const rt = ex?.getRuntime();
      if (!rt || !rt.isInitialized()) return { ok: false as const, hashes: [] as number[], frames: 0 };
      const hash = (): number => {
        const fb = rt.getFramebuffer();
        if (!fb) return -1;
        let h = 0x811c9dc5;
        for (let i = 0; i < fb.length; i += 4) {
          h ^= fb[i]!;
          h = (h * 0x01000193) >>> 0;
        }
        return h >>> 0;
      };
      const hashes: number[] = [];
      let frames = 0;
      for (let s = 0; s < samples; s++) {
        for (let f = 0; f < framesApart; f++) {
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          frames++;
        }
        hashes.push(hash());
      }
      return { ok: true as const, hashes, frames };
    },
    { nodeId: id, samples, framesApart },
  );
}

/** Boot the DEFAULT shell, spawn BLOOD, and return before any dock is opened —
 *  which is the state the first test's negative control needs. */
async function bootRack(page: Page, errors: string[]) {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/rack?shell=1&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, NODES, []);
}

/** Open BLOOD's dock faceplate and return the dock shell locator. */
async function openBloodDock(page: Page) {
  const shell = page.locator(`.svelte-flow__node[data-id="${BLOOD_ID}"] [data-testid="module-shell"]`);
  await expect(shell, 'the promoted face renders a ModuleShell tile in the lane')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

test.describe('BLOOD face — the screen', () => {
  // The SwiftShader budget, from the ONE export site rather than a literal: a
  // flat wall-clock number is a different assertion on every runner
  // (#1875/#1906). It BOUNDS the failure; it is not what any test here asserts.
  // ⚠ DOUBLED, and the reason is measured rather than cautious: a COLD Build-WASM
  // boot is a 5.9 MB ASYNCIFY fetch plus a full engine init, which the dedicated
  // blood specs already budget at 20-25 s on a 2-core CI VM — see
  // blood-mount.spec.ts's header, which records this exact spec class
  // retry-recovering three runs in a row when it rode the flat 30 s default.
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);

  test('⚠ the FACEPLATE BOOTS THE ENGINE — and nothing else in the shipping shell does', async ({ page }) => {
    const errors: string[] = [];
    await bootRack(page, errors);

    const hooks = await hasHooks(page);
    test.skip(!hooks, 'BLOOD runtime/extras unavailable — the __engine test hooks are stripped (prod-preview build)');

    // ── THE NEGATIVE CONTROL, AND IT IS HALF THE TEST ──────────────────────
    //
    // Without it the positive leg below is satisfied by ANY boot from anywhere,
    // including one that never involved the face — which is precisely the
    // mistake that would let this promotion ship dark. So first: with the module
    // spawned, its lane tile painted and NO dock opened, the engine must be
    // UNBOOTED. That is the shipping shell's whole surface for an unopened
    // module, and it is what proves the boot observed afterwards came from the
    // faceplate body and nowhere else.
    //
    // ⚠ POLLED FOR `false`, NOT READ ONCE, and the difference is the adoption
    // race: `engineLoaded` returns null until the video domain holds the node,
    // and a single read taken a frame too early would fail with "expected false,
    // got null" — a confusing message about a test problem dressed as a product
    // one. Polling waits out the adoption and still fails on `true`, which is
    // the regression this leg is for.
    await expect(page.locator(`.svelte-flow__node[data-id="${BLOOD_ID}"] [data-testid="module-shell"]`))
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect
      .poll(() => engineLoaded(page, BLOOD_ID), {
        message:
          'BLOOD is booted (or unreachable) with NO faceplate open. If it is booted, something ' +
          'else in the shell now boots it and the positive leg below is measuring nothing — ' +
          'rewrite this control rather than deleting it. If it stayed null, the video engine ' +
          'never adopted the node at all.',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(false);

    const dockShell = await openBloodDock(page);
    const body = dockShell.getByTestId('blood-screen-body');
    await expect(body, 'the fullViewBody paints at the dock')
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ── THE POSITIVE LEG ───────────────────────────────────────────────────
    //
    // `loaded` is written in exactly one place in blood.ts — inside
    // `ensureLoaded` — so this is a direct observation that the body called the
    // shared boot seam, not an inference from a status word the body itself
    // renders.
    await expect
      .poll(() => engineLoaded(page, BLOOD_ID), {
        message:
          'the BLOOD faceplate body did NOT boot the engine. `extras.ensureLoaded()` had exactly ' +
          'one caller in the tree before this promotion (BloodCard.svelte), the shipping shell no ' +
          'longer mounts that card, and blood is in neither half of HEADLESS_MOUNT_LANE_TYPES — so ' +
          'if this body does not boot, a promoted BLOOD is dark FOREVER while every def-reading ' +
          'gate stays green. Check the onMount autoBootBlood call in BloodScreenBody.svelte.',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(true);

    // The body also owns the picture the card never had.
    await expect(body.getByTestId('blood-face-canvas')).toBeVisible();
    const box = await body.getByTestId('blood-face-canvas').boundingBox();
    expect(box?.height ?? 0, 'the game viewport has a real box').toBeGreaterThan(50);

    expect(errors, `unexpected page errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('SCREEN OFF unmounts the canvas, persists on node.data, and the ENGINE KEEPS RUNNING', async ({ page }) => {
    const errors: string[] = [];
    await bootRack(page, errors);
    const dockShell = await openBloodDock(page);
    const body = dockShell.getByTestId('blood-screen-body');
    const toggle = body.getByTestId('blood-face-screen-toggle');

    await expect(toggle, 'starts ON').toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText('SCREEN ON');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText('SCREEN OFF');
    await expect(
      body.getByTestId('blood-face-canvas'),
      'SCREEN OFF unmounts the viewport and reclaims its space',
    ).toHaveCount(0);

    // ⚠ THE STATE IS ON `node.data`, NOT IN THE COMPONENT — the owner's stated
    // floor, and the #1531 / #1574 / #1583 class: this body unmounts on dock
    // collapse / LRU eviction, so component `$state` would lose the switch on
    // every remount and would never reach a collaborator.
    await expect
      .poll(
        () =>
          page.evaluate((id) => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
            };
            return w.__patch.nodes[id]?.data?.previewCollapsed ?? null;
          }, BLOOD_ID),
        {
          message: 'SCREEN OFF must persist on node.data.previewCollapsed (the shared key)',
          timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
        },
      )
      .toBe(true);

    // ── THE LEG THIS MODULE NEEDS AND MOST SCREEN SWITCHES DO NOT ──────────
    //
    // On a filter, SCREEN OFF stopping the producer costs a preview. Here
    // `surface.draw` is what calls `runtime.runFrame()`, so a SCREEN switch that
    // stopped the pull would FREEZE THE GAME. Measured while collapsed, against
    // the engine's own CPU framebuffer rather than any canvas: renderer-
    // independent, and the same signal `blood-mount.spec.ts` uses to prove the
    // engine clock advances.
    //
    // ⚠ WHAT THIS LEG DOES **NOT** COVER, MEASURED RATHER THAN GUESSED. It does
    // NOT prove the body's `markWatched` call is what keeps the game running.
    // POSITIVE CONTROL RUN 2026-08-31, local, dev server: deleting that call
    // from the collapsed branch left all three tests in this file GREEN. The
    // reason is structural — `isPullExempt` returns true for any handle with a
    // non-empty `audioSources` map, `PatchEngine.registerDomain` injects the
    // AudioContext into the VideoEngine whenever both domains are registered
    // (which `/rack` always does, and an AudioContext constructs suspended with
    // no user gesture), so blood populates that map at construction and is a
    // pull root whatever this body does.
    //
    // So the assertion below is TRUE and worth having — it is the owner ruling's
    // actual claim, "the module keeps rendering while the screen is off" — and
    // it is NOT a gate on the watch mark. The mark's own justification is in the
    // body, which now says the same thing rather than the stronger claim its
    // first draft made. Do not "strengthen" this comment back: the control was
    // run and this is its result.
    //
    // ⚠ THE TOLERANCE IS GATED ON THE MODULE'S OWN READY STATE, NOT ON WHETHER
    // THE PROBE HAPPENED TO WORK, and the difference is the whole difference
    // between a conditional and a vacuous pass. `if (s.ok)` alone would go green
    // on a probe that could not find the runtime for ANY reason — a renamed
    // extras key, a body that never booted, a typo in this file — and read
    // exactly like the legitimate "SwiftShader could not init the engine" case.
    // So: the engine is either READY, in which case the probe MUST work and the
    // frames MUST advance, or it is not, in which case there is genuinely
    // nothing to observe (the standing tolerance every blood spec carries).
    const hooks = await hasHooks(page);
    if (hooks) {
      await expect
        .poll(() => engineLoaded(page, BLOOD_ID), { timeout: SLOW_BOOT_TEST_TIMEOUT_MS })
        .toBe(true);
      const status = await dockShell.getByTestId('blood-face-frame').getAttribute('data-blood-status');
      if (status === 'ready') {
        const s = await frameSignatures(page, BLOOD_ID, 4, 20);
        expect(
          s.ok,
          'the body reports the engine READY but the framebuffer probe found no initialised ' +
            'runtime. That is not the SwiftShader tolerance — it means this probe is reading the ' +
            'wrong seam, and every run of this leg since has been vacuous.',
        ).toBe(true);
        expect(
          new Set(s.hashes).size,
          `the BLOOD framebuffer did NOT change over ${s.frames} frames with SCREEN OFF. The game ` +
            'is frozen: the collapsed branch of BloodScreenBody must keep calling markWatched, ' +
            'because surface.draw is what runs runtime.runFrame() and blood is only structurally ' +
            'pull-exempt once an AudioContext exists.',
        ).toBeGreaterThan(1);
      }
    }

    // Back ON: the picture returns, and it is LIVE rather than a stale frame —
    // the rAF loop never stopped, so there is nothing to spin up.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.getByTestId('blood-face-canvas'))
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    expect(errors, `unexpected page errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the capture-phase keyboard host routes a game key from the FACEPLATE to the runtime', async ({ page }) => {
    const errors: string[] = [];
    await bootRack(page, errors);

    const hooks = await hasHooks(page);
    test.skip(!hooks, 'BLOOD runtime/extras unavailable — the __engine test hooks are stripped (prod-preview build)');

    const dockShell = await openBloodDock(page);
    const frame = dockShell.getByTestId('blood-face-frame');
    await expect(frame).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // The host only claims once the engine is READY — that is the first clause
    // of `shouldClaimBloodKey`, so waiting for it is part of the subject rather
    // than a settling delay.
    await expect
      .poll(() => engineLoaded(page, BLOOD_ID), { timeout: SLOW_BOOT_TEST_TIMEOUT_MS })
      .toBe(true);
    const ready = await frame.getAttribute('data-blood-status');
    test.skip(ready !== 'ready', 'BLOOD engine did not reach ready (renderer/heap-sensitive on CI)');

    // COUNT THE ROUTED KEYS AT THE SEAM. `extras` is a live object the body
    // re-reads on every event, so wrapping its method observes exactly what the
    // capture listener does — rather than asserting on a scancode the runtime
    // has already consumed and does not expose.
    await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
        __bloodKeys?: string[];
      };
      const ve = w.__engine?.()?.getDomain('video');
      const ex = ve?.read(id, 'extras') as
        | { pushKeyboardKey: (code: string, pressed: boolean) => boolean }
        | undefined;
      if (!ex) return;
      w.__bloodKeys = [];
      const inner = ex.pushKeyboardKey.bind(ex);
      ex.pushKeyboardKey = (code: string, pressed: boolean) => {
        w.__bloodKeys!.push(`${code}:${pressed ? 'down' : 'up'}`);
        return inner(code, pressed);
      };
    }, BLOOD_ID);

    // ⚠ A REAL FOCUS AND A REAL KEY, through the browser. Dispatching a
    // synthetic event would bypass the very thing under test: the listener is
    // registered in the CAPTURE phase on `window` specifically so it runs before
    // xyflow's own document keydown, and only a real key exercises that order.
    await frame.click();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ControlRight');

    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { __bloodKeys?: string[] }).__bloodKeys ?? []), {
        message:
          'no game key reached the runtime from the faceplate. The capture-phase keyboard host is ' +
          'the one affordance of this module that no shipped fullViewBody had a template for, so ' +
          'it is authored code rather than a port — check onMount/window addEventListener(…, true) ' +
          'and the focus-within predicate in BloodScreenBody.svelte.',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toEqual(expect.arrayContaining(['ArrowUp:down', 'ArrowUp:up']));

    // ⚠ THE NEGATIVE HALF: a key aimed at a TEXT FIELD must flow through
    // untouched even while this frame is around. That guard is the load-bearing
    // fix for the owner-reported "can't type in the new-module search box while
    // a BLOOD card is on screen", and it is easy to lose when porting a claim
    // predicate to a new surface.
    const before = await page.evaluate(
      () => ((globalThis as unknown as { __bloodKeys?: string[] }).__bloodKeys ?? []).length,
    );
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'blood-kbd-control';
      document.body.appendChild(input);
      input.focus();
    });
    await page.keyboard.press('ArrowUp');
    expect(
      await page.evaluate(
        () => ((globalThis as unknown as { __bloodKeys?: string[] }).__bloodKeys ?? []).length,
      ),
      'a key typed into a TEXT FIELD was swallowed by the BLOOD keyboard host',
    ).toBe(before);

    expect(errors, `unexpected page errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
