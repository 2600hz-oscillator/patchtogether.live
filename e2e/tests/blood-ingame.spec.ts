// e2e/tests/blood-ingame.spec.ts
//
// REAL-BROWSER reproduction of the BLOOD "no game content / black screen once a
// game starts" bug (#965). The existing blood-keyboard spec proves keys reach the
// engine; the committed node harness only validates the MENU renders. NEITHER
// drives into an actual level + reads the in-game framebuffer — which is exactly
// the gap (the agent's "E1M1 100% non-black" came from an uncommitted run).
//
// This boots BLOOD in a real browser (the video pipeline ticks the surface →
// runFrame each frame), confirms the MENU renders + animates, then injects the
// menu key sequence to START A NEW GAME and reads the in-game framebuffer via the
// runtime (extras.getRuntime().getFramebuffer()). The discriminator for the bug:
//   • engine ALIVE  → framebuffer stays non-black AND keeps CHANGING (animating).
//   • engine ABORTED (the bug: seqSpawn(12032) → ThrowError → abort) → the
//     framebuffer FREEZES (runFrame throws, last frame stuck) or goes black.
//
// Diagnostic-first: logs a framebuffer timeline as the menu is driven, so the
// exact menu navigation can be tuned. SwiftShader-independent (reads the engine's
// own software framebuffer, not the GL canvas).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

const BLOOD_ID = 'blood-ig';
const SC_ENTER = 0x1c;
const SC_DOWN = 0xd0;
const SC_SPACE = 0x39;

test('blood in-game: drive the menu into a level + read the in-game framebuffer', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: BLOOD_ID, type: 'blood', position: { x: 120, y: 80 }, domain: 'video' },
      { id: 'vout', type: 'videoOut', position: { x: 700, y: 80 }, domain: 'video' },
    ],
    [{ from: BLOOD_ID, fromPort: 'out', to: 'vout', toPort: 'in' }],
  ).catch(() => spawnPatch(page, [{ id: BLOOD_ID, type: 'blood', position: { x: 120, y: 80 }, domain: 'video' }], []));

  await page.getByTestId('blood-card').waitFor({ state: 'visible', timeout: 10_000 });
  const ready = await page.getByTestId('blood-ready').waitFor({ state: 'visible', timeout: 25_000 }).then(() => true).catch(() => false);
  test.skip(!ready, 'BLOOD engine did not reach ready (heap/renderer-sensitive)');

  const result = await page.evaluate(
    async ({ id, SC_ENTER, SC_DOWN, SC_SPACE }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
      };
      const ve = w.__engine?.()?.getDomain('video');
      const ex = ve?.read(id, 'extras') as { getRuntime: () => { isInitialized: () => boolean; resolution: () => { width: number; height: number }; getFramebuffer: () => Uint8ClampedArray | null; setKey: (sc: number, p: boolean) => void } | null } | undefined;
      const rt = ex?.getRuntime();
      if (!rt) return { ok: false, reason: 'no runtime' };

      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const sample = () => {
        if (!rt.isInitialized()) return { alive: false, nonZero: 0, total: 0, hash: 0 };
        const { width, height } = rt.resolution();
        const fb = rt.getFramebuffer();
        if (!fb || fb.length < 4) return { alive: false, nonZero: 0, total: 0, hash: 0 };
        let nonZero = 0, hsh = 0x811c9dc5;
        for (let i = 0; i < fb.length; i += 4) {
          if (fb[i] | fb[i + 1] | fb[i + 2]) nonZero++;
          hsh ^= fb[i]; hsh = (hsh * 0x01000193) >>> 0;
        }
        return { alive: true, nonZero, total: (fb.length / 4) | 0, hash: hsh >>> 0, w: width, h: height };
      };
      const press = async (sc: number) => { rt.setKey(sc, true); await sleep(120); rt.setKey(sc, false); await sleep(650); };

      // --- 1. MENU: sample over ~1.5s (expect non-black + changing hash) ---
      const menu: ReturnType<typeof sample>[] = [];
      for (let i = 0; i < 8; i++) { menu.push(sample()); await sleep(180); }

      // --- 2. Drive the menu to start a new game. Blood NBlood main menu:
      // New Game → (episode) → difficulty → level loads. We press a robust
      // sequence + sample after each, logging the timeline so the nav can be
      // tuned from the output. ---
      const seq = [SC_ENTER, SC_ENTER, SC_ENTER, SC_DOWN, SC_ENTER, SC_ENTER, SC_SPACE, SC_ENTER];
      const timeline: Array<{ key: number; s: ReturnType<typeof sample> }> = [];
      for (const sc of seq) { await press(sc); timeline.push({ key: sc, s: sample() }); }

      // --- 3. POST: after the start attempt, sample over ~3s. Engine ALIVE →
      // hash keeps changing (animating). ABORTED → frozen/black. ---
      await sleep(800);
      const post: ReturnType<typeof sample>[] = [];
      for (let i = 0; i < 12; i++) { post.push(sample()); await sleep(220); }

      // --- 4. MOVEMENT PROBE: forward (SC_UP_ARROW, now bound to Move_Forward by
      // the keydefaults patch) should scroll the whole 3D view → far more
      // frame-to-frame pixel change than standing idle. Measures avg changed
      // pixels/frame idle vs with up-arrow held. ---
      const SC_UP_ARROW = 0xc8;
      const avgFrameDelta = async (n: number): Promise<number> => {
        let prev = rt.getFramebuffer()?.slice() ?? null;
        let total = 0, c = 0;
        for (let i = 0; i < n; i++) {
          await sleep(120);
          const cur = rt.getFramebuffer();
          if (prev && cur && cur.length === prev.length) {
            let d = 0;
            for (let j = 0; j < cur.length; j += 16) if (Math.abs(cur[j] - prev[j]) > 24) d++;
            total += d; c++; prev = cur.slice();
          } else if (cur) { prev = cur.slice(); }
        }
        return c ? total / c : 0;
      };
      const idleDelta = await avgFrameDelta(6);
      rt.setKey(SC_UP_ARROW, true);
      const moveDelta = await avgFrameDelta(6);
      rt.setKey(SC_UP_ARROW, false);

      return { ok: true, menu, timeline, post, idleDelta, moveDelta };
    },
    { id: BLOOD_ID, SC_ENTER, SC_DOWN, SC_SPACE },
  );

  if (!('ok' in result) || !result.ok) {
    // eslint-disable-next-line no-console
    console.log(`[blood-ingame] could not read runtime: ${JSON.stringify(result)}`);
    test.skip(true, 'runtime/extras unavailable');
    return;
  }

  const distinctHashes = (arr: Array<{ hash: number }>) => new Set(arr.map((x) => x.hash)).size;
  const maxNonZero = (arr: Array<{ nonZero: number }>) => Math.max(...arr.map((x) => x.nonZero), 0);
  const menuAnimating = distinctHashes(result.menu) > 1;
  const menuNonZero = maxNonZero(result.menu);
  const postAnimating = distinctHashes(result.post) > 1;
  const postNonZero = maxNonZero(result.post);
  const postAlive = result.post.some((x) => x.alive);
  const res = result.timeline.find((t) => 'w' in t.s) as { s: { w?: number; h?: number } } | undefined;

  // eslint-disable-next-line no-console
  console.log(
    `[blood-ingame] res=${res?.s?.w ?? '?'}x${res?.s?.h ?? '?'} | ` +
      `MENU: nonZero=${menuNonZero} animating=${menuAnimating} (distinctHashes=${distinctHashes(result.menu)}) | ` +
      `timeline=${result.timeline.map((t) => `k${t.key.toString(16)}:${t.s.nonZero}${t.s.alive ? '' : '✗'}`).join(' ')} | ` +
      `POST-START: alive=${postAlive} nonZero=${postNonZero} animating=${postAnimating} (distinctHashes=${distinctHashes(result.post)}) | ` +
      `MOVE(up=fwd): idleDelta=${result.idleDelta.toFixed(0)} upHeldDelta=${result.moveDelta.toFixed(0)}`,
  );

  const total = Math.max(...result.post.map((x) => x.total ?? 0), ...result.menu.map((x) => x.total ?? 0), 1);
  const postFill = postNonZero / total; // fraction of the screen that's non-black in-game

  // Menu sanity: it should render + animate (proves boot is healthy).
  expect(menuNonZero, 'menu did not render (black)').toBeGreaterThan(1000);
  // THE BUG CHECK: after starting a game the engine must stay alive + animating,
  // AND render a FULL 3D view — substantially fuller than the (sparse) menu — so
  // a still-animating MENU (game never started) does NOT pass. A freeze/black
  // here = the seqSpawn abort (the "no game content" bug).
  expect(postAlive, 'engine died after starting a game (aborted)').toBe(true);
  expect(postAnimating, 'framebuffer FROZE after starting a game — engine aborted (the black-screen bug)').toBe(true);
  expect(postFill, `in-game frame only ${(postFill * 100).toFixed(0)}% non-black — game did not reach a level (still at menu or black)`).toBeGreaterThan(0.5);

  // up-arrow → Move_Forward (the keydefaults patch): holding up must scroll the
  // whole 3D view far more than standing idle. Empirically idle≈0, up-held≈34k.
  expect(
    result.moveDelta,
    `up-arrow did not move the player — idle frame-delta ${result.idleDelta.toFixed(0)} vs ` +
      `up-held ${result.moveDelta.toFixed(0)}; the arrows→Move_Forward keydefaults binding is not active`,
  ).toBeGreaterThan(result.idleDelta + 2000);
});
