// e2e/vrt/vrt-geom-probe.spec.ts
//
// MEASUREMENT TOOL, not a gate. `VRT_PROBE=1` only (see vrt.config.ts), so it
// costs CI nothing.
//
// WHY IT EXISTS: `vrt-toybox.spec.ts/darwin/combine-editor.png` is the ONE
// baseline of the 116 re-pinned in 1e2ce3c2 whose PIXEL GEOMETRY moved
// (284x119 -> 284x134). Decoding its whole history shows the height has been
// oscillating for months across commits that never touched the editor:
//
//     284x138 -> 185 -> 150 -> 150 -> 121 -> 119 -> 148 -> 119 -> 148 -> 119
//             -> 134 -> 119 -> 134
//
// A design change does not oscillate. This probe prints the numbers that
// explain it: the element's own layout box, the wrap's box, the viewport, and
// therefore how much of the element the capture can physically contain.
//
//   VRT_PROBE=1 npx playwright test --config=vrt/vrt.config.ts vrt-geom-probe

import { test, expect } from '@playwright/test';
import {
  spawnPatch,
  ensureCombineOpen,
  type SpawnNode,
  type SpawnEdge,
} from '../tests/_helpers';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

test('combine-editor capture geometry', async ({ page }) => {
  test.setTimeout(90_000);
  await pinVrtFonts(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  // Start the trace BEFORE the card is even waited for, so the mount transient
  // that persistResize samples is visible.
  const birth = page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const out: string[] = [];
        const t0 = performance.now();
        let last = '';
        const tick = (): void => {
          const w = document.querySelector('[data-testid="toybox-graph-wrap"]') as HTMLElement | null;
          const g = globalThis as unknown as {
            __patch?: { nodes: Record<string, { data?: { combineView?: { h?: number } } }> };
          };
          const persisted = g.__patch?.nodes?.['tb']?.data?.combineView?.h ?? 'unset';
          const line = w
            ? `style=${w.style.height} rect=${Math.round(w.getBoundingClientRect().height)} persisted=${persisted}`
            : `no-wrap persisted=${persisted}`;
          if (line !== last) {
            out.push(`${Math.round(performance.now() - t0)}ms ${line}`);
            last = line;
          }
          if (performance.now() - t0 > 2500) return resolve(out);
          setTimeout(tick, 16);
        };
        tick();
      }),
  );
  const card = page.locator('.svelte-flow__node-toybox').first();
  await card.waitFor({ state: 'visible', timeout: 15_000 });
  // eslint-disable-next-line no-console
  console.log('[geom] BIRTH trace:\n  ' + (await birth).join('\n  '));
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(0px, 0px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  // Trace from BEFORE the editor is opened, so the mount transient is visible.
  const early = page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const out: string[] = [];
        const t0 = performance.now();
        let last = '';
        const tick = (): void => {
          const w = document.querySelector('[data-testid="toybox-graph-wrap"]') as HTMLElement | null;
          const p = w?.parentElement ?? null;
          if (w && p) {
            const wr = w.getBoundingClientRect();
            const pr = p.getBoundingClientRect();
            const cs = getComputedStyle(w);
            const line =
              `style=${w.style.height} rect=${Math.round(wr.height)} ` +
              `box=${cs.boxSizing} minH=${cs.minHeight} flexShrink=${cs.flexShrink} ` +
              `parent=${p.className.split(' ')[0]}/${Math.round(pr.height)} ` +
              `parentDisplay=${getComputedStyle(p).display} ` +
              `scrollH=${w.scrollHeight} clientH=${w.clientHeight}`;
            if (line !== last) {
              out.push(`${Math.round(performance.now() - t0)}ms ${line}`);
              last = line;
            }
          }
          if (performance.now() - t0 > 3000) return resolve(out);
          setTimeout(tick, 25);
        };
        tick();
      }),
  );

  await ensureCombineOpen(page);
  const svg = page.locator('[data-testid="toybox-graph-svg"]');
  await svg.waitFor({ state: 'visible', timeout: 10_000 });
  // eslint-disable-next-line no-console
  console.log('[geom] MOUNT trace:\n  ' + (await early).join('\n  '));

  // THE SETTLE TRACE. `.graph-wrap` carries an inline `height:${combineViewH}px`
  // fed by node.data.combineView.h, AND a ResizeObserver (persistResize) that
  // writes the OBSERVED height back into that same field after a 200 ms
  // debounce. Layout -> state -> layout is a loop, and the capture can land on
  // either side of the debounce. Sample it so that is visible rather than
  // inferred.
  const trace = await page.evaluate(
    () =>
      new Promise<Array<{ t: number; styleH: string; rectH: number }>>((resolve) => {
        const out: Array<{ t: number; styleH: string; rectH: number }> = [];
        const t0 = performance.now();
        const tick = (): void => {
          const w = document.querySelector('[data-testid="toybox-graph-wrap"]') as HTMLElement;
          if (w) {
            out.push({
              t: Math.round(performance.now() - t0),
              styleH: w.style.height,
              rectH: Math.round(w.getBoundingClientRect().height * 100) / 100,
            });
          }
          if (performance.now() - t0 > 2000) return resolve(out);
          setTimeout(tick, 50);
        };
        tick();
      }),
  );
  const compact = trace
    .filter((r, i) => i === 0 || r.styleH !== trace[i - 1]!.styleH || r.rectH !== trace[i - 1]!.rectH)
    .map((r) => `${r.t}ms style=${r.styleH} rect=${r.rectH}`);
  // eslint-disable-next-line no-console
  console.log('[geom] wrap settle trace (changes only):\n  ' + compact.join('\n  '));

  await expect(page.locator('[data-testid="toybox-graph-svg"] .gnode-label').first())
    .toHaveText('L1', { timeout: 10_000 });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

  // CAN THE HEIGHT BE PINNED? Write an explicit combineView.h and watch whether
  // it STICKS (a deterministic capture box) or is overwritten by persistResize
  // (layout-derived, therefore not pinnable from the scene).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      (n.data as { combineView?: { h: number } }).combineView = { h: 200 };
    });
  });
  const pinned = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const out: string[] = [];
        const t0 = performance.now();
        let last = '';
        const tick = (): void => {
          const w = document.querySelector('[data-testid="toybox-graph-wrap"]') as HTMLElement | null;
          if (w) {
            const line = `style=${w.style.height} rect=${Math.round(w.getBoundingClientRect().height)}`;
            if (line !== last) {
              out.push(`${Math.round(performance.now() - t0)}ms ${line}`);
              last = line;
            }
          }
          if (performance.now() - t0 > 1500) return resolve(out);
          setTimeout(tick, 25);
        };
        tick();
      }),
  );
  // eslint-disable-next-line no-console
  console.log('[geom] PIN-TO-200 trace:\n  ' + pinned.join('\n  '));

  const m = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="toybox-graph-svg"]') as SVGElement;
    const w = document.querySelector('[data-testid="toybox-graph-wrap"]') as HTMLElement;
    const c = document.querySelector('.svelte-flow__node-toybox') as HTMLElement;
    const sr = s.getBoundingClientRect();
    const wr = w.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    return {
      svg: { x: sr.x, y: sr.y, w: sr.width, h: sr.height, bottom: sr.bottom },
      wrap: {
        y: wr.y, h: wr.height, bottom: wr.bottom,
        styleH: (w as HTMLElement).style.height,
        scrollH: w.scrollHeight, clientH: w.clientHeight,
        scrollW: w.scrollWidth, clientW: w.clientWidth,
      },
      card: { y: cr.y, h: cr.height, bottom: cr.bottom },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      clippedH: Math.max(0, Math.min(sr.bottom, window.innerHeight) - Math.max(sr.y, 0)),
    };
  });
  // eslint-disable-next-line no-console
  console.log('[geom] ' + JSON.stringify(m, null, 2));
  const shot = await svg.screenshot();
  const dim = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
    return { w: img.naturalWidth, h: img.naturalHeight };
  }, shot.toString('base64'));
  // eslint-disable-next-line no-console
  console.log(`[geom] CAPTURED ${dim.w}x${dim.h}  (svg layout ${m.svg.w}x${m.svg.h}, ` +
    `viewport-clipped h=${m.clippedH})`);
});

// ───────────────────────────────────────────────────────────────────────────
// WARRENSPECTRUM: 526x527 -> 527x527. ONE PIXEL OF WIDTH, AND WHERE IT CAME
// FROM.
//
// The second geometry change in the 116-baseline re-pin, and the one that went
// undocumented because scripts/vrt-geom-audit.sh aborted before reaching it.
// A 1 px width move is exactly the size where "real layout shift" and "capture
// artefact" are indistinguishable from the number alone — and they need
// opposite responses (fix the card vs. accept the re-pin). So measure.
//
// THE HYPOTHESIS THIS TESTS: nothing about the CARD changed. What changed is
// WHERE IT SITS. The re-pin added a VRT_SCENES entry for warrenspectrum, and a
// scene relocates the module — solo spawn puts it at (80, 80); the scene puts a
// source VCO at (60, 60) and the module under test at (520, 60). Playwright's
// element screenshot spans floor(left) .. ceil(right) in device pixels, so a
// card of FRACTIONAL css width captures 526 or 527 px purely as a function of
// its sub-pixel x offset. If the two spawns report the SAME width and a
// DIFFERENT fractional x, the pixel is an artefact of position and the re-pin
// is correct; if the width itself moved, it is a real layout change and the
// card needs looking at.
//
//   VRT_PROBE=1 npx playwright test --config=vrt/vrt.config.ts vrt-geom-probe \
//     --grep warrenspectrum
test('warrenspectrum capture geometry: solo spawn vs scene spawn', async ({ page }) => {
  test.setTimeout(120_000);

  /** Spawn one way, then report the card's layout box + what a capture of it
   *  would actually contain. */
  async function measure(
    label: string,
    nodes: SpawnNode[],
    edges: SpawnEdge[],
  ): Promise<{ x: number; width: number; captured: string }> {
    await pinVrtFonts(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await page.addStyleTag({
      content:
        '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution{display:none !important;}',
    });
    await spawnPatch(page, nodes, edges);
    const card = page.locator('.svelte-flow__node-warrenspectrum').first();
    await card.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(400);

    const geom = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
        // The transform is the other half of the story: a viewport SCALE
        // change would move the width for a completely different reason.
        transform: vp ? getComputedStyle(vp).transform : 'none',
        dpr: window.devicePixelRatio,
      };
    });
    // What the REAL capture path produces — not a prediction of it.
    const shot = await card.screenshot({ animations: 'disabled' });
    const dim = await page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise((r) => {
        img.onload = r;
        img.src = 'data:image/png;base64,' + b64;
      });
      return { w: img.naturalWidth, h: img.naturalHeight };
    }, shot.toString('base64'));

    // eslint-disable-next-line no-console
    console.log(
      `[geom-ws] ${label}\n` +
        `    layout  x=${geom.x} width=${geom.width} right=${geom.right}\n` +
        `            y=${geom.y} height=${geom.height} bottom=${geom.bottom}\n` +
        `    span    floor(left)=${Math.floor(geom.x)} ceil(right)=${Math.ceil(geom.right)} ` +
        `=> ${Math.ceil(geom.right) - Math.floor(geom.x)} device px\n` +
        `    viewport transform=${geom.transform} dpr=${geom.dpr}\n` +
        `    CAPTURED ${dim.w}x${dim.h}`,
    );
    return { x: geom.x, width: geom.width, captured: `${dim.w}x${dim.h}` };
  }

  const solo = await measure(
    'SOLO spawn (the pre-scene layout: one node at 80,80)',
    [{ id: 'vrt-1', type: 'warrenspectrum', position: { x: 80, y: 80 }, domain: 'audio' }],
    [],
  );
  const scened = await measure(
    'SCENE spawn (VRT_SCENES.warrenspectrum: vco at 60,60 + module at 520,60)',
    [
      { id: 'src', type: 'analogVco', position: { x: 60, y: 60 }, domain: 'audio' },
      { id: 'vrt-1', type: 'warrenspectrum', position: { x: 520, y: 60 }, domain: 'audio' },
    ],
    [
      {
        id: 'e_src_ws',
        from: { nodeId: 'src', portId: 'sine' },
        to: { nodeId: 'vrt-1', portId: 'a_in' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // ⚠ COMPARE WITH A TOLERANCE, AND SAY WHAT THE UNITS ARE. The two widths
  // come back as 526 and 526.0000610351562 CSS px. An `===` here reports
  // "MOVED -> real layout change" on a 6e-5 px difference, which is the
  // float error of multiplying a 540 px card by the viewport's 0.974074
  // scale — i.e. the check would manufacture exactly the false finding this
  // probe exists to rule out. A tenth of a CSS pixel is far below anything
  // that can round a capture up or down, and far above the float noise.
  const WIDTH_EPS_CSS_PX = 0.1;
  const resized = Math.abs(solo.width - scened.width) > WIDTH_EPS_CSS_PX;
  const fractional = (v: number): boolean => Math.abs(v - Math.round(v)) > 1e-3;
  // eslint-disable-next-line no-console
  console.log(
    `[geom-ws] VERDICT\n` +
      `    css width  solo=${solo.width}  scene=${scened.width}  ` +
      `delta=${Math.abs(solo.width - scened.width).toExponential(2)} CSS px ` +
      `(tolerance ${WIDTH_EPS_CSS_PX}) -> ` +
      `${resized ? 'RESIZED: a real layout change, do NOT just re-pin' : 'SAME SIZE: the card did not resize'}\n` +
      `    css x      solo=${solo.x} (${fractional(solo.x) ? 'fractional' : 'integral'})  ` +
      `scene=${scened.x} (${fractional(scened.x) ? 'fractional' : 'integral'})\n` +
      `    captured   solo=${solo.captured}  scene=${scened.captured}\n` +
      `    => a capture spans floor(left)..ceil(right) in DEVICE px, so an ` +
      `identically-sized card at a FRACTIONAL x captures one pixel wider than ` +
      `at an integral x. Position, not size.`,
  );
});
