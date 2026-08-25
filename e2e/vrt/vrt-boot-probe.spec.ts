// e2e/vrt/vrt-boot-probe.spec.ts
//
// WHERE DOES A VRT SCENE'S TIME GO? — the instrument behind any claim that
// this lane is bounded by BOOT rather than by RENDER.
//
// It asserts nothing and is in no lane: `VRT_PROBE=1` swaps the whole suite for
// the probes, and `PROBE_MATCH` in `vrt.config.ts` is the only list that names
// them. So this costs CI nothing and exists to be run by hand.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// `vrt-strict` is timing out on CI (600 s `--global-timeout`, shards 6/8 and
// 7/8 on run 32869571989: `45 passed (10.0m), 1 did not run`, ZERO test
// failures). The lane is 4334 CPU-s over 360 tests at 8 shards = 542 s of fair
// share against a 600 s cap, and every merged face adds ~25 s to the lane.
//
// The proposed fix is to stop paying a page load per scene. Before building
// that, this measures the thing the fix is supposed to remove — because
// "page load is most of a scene" and "page load is a tenth of a scene" need
// completely different responses, and from the lane's total they are
// indistinguishable.
//
// ⚠ VALIDATE THE INSTRUMENT. Three separate things get conflated as "boot", and
// only ONE of them is what a shared page would remove:
//
//   A  CONTEXT   a new BrowserContext + page. Playwright's per-test `page`
//                fixture does this EVERY test, and it drops the HTTP cache and
//                the V8 code cache with it.
//   B  LOAD      `goto('/rack')` + networkidle + fonts + hooks, on a COLD
//                context — what every scene pays today.
//   C  SCENE     everything after the hooks are up: spawn, the channel-column
//                wait, the scene style, the audio freeze, framing, capture.
//
// A shared page removes A and shrinks B (a warm HTTP + code cache). It cannot
// touch C at all. So this prints all three separately, plus the number that
// actually decides the design: what a REPEAT `goto` costs on a page that is
// already warm, since that is the cheap version of "reset the rack" and it is
// far safer than sharing accumulated state across scenes.
//
// Run:
//   flox activate -- task e2e:serve
//   cd e2e && E2E_SKIP_WEBSERVER=1 E2E_BASE_URL=http://localhost:<port> \
//     VRT_PROBE=1 E2E_SWIFTSHADER=1 npx playwright test \
//     --config=vrt/vrt.config.ts vrt/vrt-boot-probe.spec.ts --reporter=list
//
// ⚠ The local number is NOT the CI number, and the config says why in more
// detail: a headless Chromium here is ALREADY on SwiftShader, so the renderer
// matches, but CI is a 2-core runner. Read the RATIOS, and scale with the
// lane's own measured mean rather than assuming.

import { test, expect } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';
import { diffRegion } from './vrt-surface-stats';
import {
  waitForHooks,
  bootWithFace,
  loadFaceRack,
  spawnFace,
  resetFaceRack,
  sampleFaceRackPristine,
  frameMember,
  freezeFaceAudio,
  LEGACY_FOLD_VIEWPORT,
  FACES,
  type FaceRackPristine,
} from './_shell-faces';

/** How many repeats each phase is sampled over. Small: this is a probe, and the
 *  quantity being measured is seconds, not milliseconds. */
const REPS = 5;

/** The scene subjects. Deliberately a plain audio face and nothing exotic —
 *  the question is what the SHARED prefix costs, and the prefix is the same for
 *  every face in the roster. */
const SUBJECT = 'adsr';

const ms = (n: number) => `${n.toFixed(0)} ms`;
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return `n=${s.length} min=${ms(s[0]!)} med=${ms(s[s.length >> 1]!)} max=${ms(s[s.length - 1]!)}`;
};

test.describe('BOOT PROBE — what a VRT scene spends its time on', () => {
  test.setTimeout(600_000);

  test('A/B: a COLD context + first load, sampled', async ({ browser }) => {
    const contextMs: number[] = [];
    const gotoMs: number[] = [];
    const idleMs: number[] = [];
    const fontMs: number[] = [];
    const hookMs: number[] = [];

    for (let i = 0; i < REPS; i++) {
      let t = Date.now();
      // EXACTLY what the per-test `page` fixture does — a fresh context, so a
      // fresh HTTP cache and a fresh V8 code cache.
      const ctx = await browser.newContext({
        viewport: LEGACY_FOLD_VIEWPORT,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      contextMs.push(Date.now() - t);

      await pinVrtFonts(page);
      t = Date.now(); await page.goto('/rack'); gotoMs.push(Date.now() - t);
      t = Date.now(); await page.waitForLoadState('networkidle'); idleMs.push(Date.now() - t);
      t = Date.now(); await awaitVrtFonts(page); fontMs.push(Date.now() - t);
      t = Date.now(); await waitForHooks(page); hookMs.push(Date.now() - t);

      await ctx.close();
    }

    console.log('\n── A: NEW CONTEXT + PAGE (what the per-test fixture pays) ──');
    console.log(`   newContext+newPage   ${stats(contextMs)}`);
    console.log('── B: COLD LOAD ──');
    console.log(`   goto('/rack')        ${stats(gotoMs)}`);
    console.log(`   networkidle          ${stats(idleMs)}`);
    console.log(`   awaitVrtFonts        ${stats(fontMs)}`);
    console.log(`   waitForHooks         ${stats(hookMs)}`);
    const total = contextMs.map((c, i) => c + gotoMs[i]! + idleMs[i]! + fontMs[i]! + hookMs[i]!);
    console.log(`   A+B TOTAL            ${stats(total)}`);
    expect(total.length).toBe(REPS);
  });

  test('B2: a REPEAT load on a WARM page — the cheap reset', async ({ browser }) => {
    // ⚠ THE NUMBER THAT DECIDES THE DESIGN. If a repeat `goto` on an already-warm
    // page is cheap, the lane can keep a genuinely fresh DOCUMENT per scene —
    // no accumulated nodes, no leaked viewport, no shared-state reasoning at all
    // — and still stop paying the cold cost. If it is NOT cheap, the only way to
    // win is to share a booted page across scenes, which is a much larger change
    // to a lane that pins 308 committed baselines.
    const ctx = await browser.newContext({
      viewport: LEGACY_FOLD_VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await pinVrtFonts(page);

    const first: number[] = [];
    const repeat: number[] = [];
    for (let i = 0; i <= REPS; i++) {
      const t = Date.now();
      await page.goto('/rack');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);
      await waitForHooks(page);
      const d = Date.now() - t;
      (i === 0 ? first : repeat).push(d);
    }
    await ctx.close();

    console.log('\n── B2: LOAD on ONE page, first vs repeats ──');
    console.log(`   first load           ${ms(first[0]!)}`);
    console.log(`   repeat loads         ${stats(repeat)}`);
    const saved = first[0]! - repeat.sort((a, b) => a - b)[repeat.length >> 1]!;
    console.log(`   warm-cache saving    ${ms(saved)} per scene`);
    expect(repeat.length).toBe(REPS);
  });

  test('C: the SCENE tail — everything after the hooks are up', async ({ browser }) => {
    // Measured as (whole bootWithFace) - (its own load prefix), both on a COLD
    // context, so neither number is a re-implementation of the other.
    const whole: number[] = [];
    const prefix: number[] = [];

    for (let i = 0; i < REPS; i++) {
      {
        const ctx = await browser.newContext({
          viewport: LEGACY_FOLD_VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce',
        });
        const page = await ctx.newPage();
        const t = Date.now();
        await bootWithFace(page, SUBJECT);
        whole.push(Date.now() - t);
        await ctx.close();
      }
      {
        const ctx = await browser.newContext({
          viewport: LEGACY_FOLD_VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce',
        });
        const page = await ctx.newPage();
        const t = Date.now();
        await pinVrtFonts(page);
        await page.goto('/rack');
        await page.waitForLoadState('networkidle');
        await awaitVrtFonts(page);
        await waitForHooks(page);
        prefix.push(Date.now() - t);
        await ctx.close();
      }
    }

    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
    console.log(`\n── C: bootWithFace('${SUBJECT}') decomposed (cold context each time) ──`);
    console.log(`   whole bootWithFace   ${stats(whole)}`);
    console.log(`   its LOAD prefix      ${stats(prefix)}`);
    console.log(`   => SCENE tail        ${ms(med(whole) - med(prefix))} (spawn + column + style + freeze)`);
    console.log(`   => LOAD is ${((100 * med(prefix)) / med(whole)).toFixed(0)}% of bootWithFace`);
    expect(whole.length).toBe(REPS);
  });
});

// ── D: THE DECISIVE EXPERIMENT ──────────────────────────────────────────────
//
// ⚠ THE ONLY QUESTION THAT MATTERS FOR A LANE THAT PINS 308 COMMITTED PNGs:
// does a scene captured on a SHARED page produce the same pixels as the same
// scene captured on a FRESH one?
//
// ⚠ AND IT IS A SAME-MACHINE COMPARISON ON PURPOSE, which is what makes it
// valid here. A local macOS run cannot be compared against the linux baselines
// (`vrt.config.ts` says so at length — one baseline set, authored by linux CI,
// and font rasterization differs). But this compares MY fresh-boot capture
// against MY shared-page capture, on one machine, in one run. The platform
// cancels; the only variable left is the thing under test.
//
// It runs the roster in THREE ORDERS plus a fresh-boot control, because the
// failure this must rule out is ORDER-DEPENDENCE — a scene that is correct
// alone and wrong after fifty others. `rack-session.ts` measured exactly that
// class in the functional lane: 20 of 24 modules differed between declared,
// reversed and shuffled order, all of it leaked canvas zoom.
const ORDER_SUBJECTS = (process.env.PROBE_FACES ?? 'adsr,vca,filter,lfo,mixer,reverb')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

test.describe('D: shared page vs fresh page — same pixels?', () => {
  test.setTimeout(900_000);

  test('a compact tile is IDENTICAL from a shared page and from a fresh boot, in any order', async ({
    browser,
  }) => {
    // Widened exactly the way the gate widens it — see the `FACES as readonly
    // {…}[]` cast at the top of `workflow-shell-faces.spec.ts`. The roster is a
    // `const` tuple, so its per-entry types are literal unions and the optional
    // `why` fields exist on only some members.
    type RosterEntry = {
      type: string;
      pages: number;
      videoFaceWhy?: string;
      singletonAdoptWhy?: string;
      simPin?: unknown;
    };
    const roster = new Map(
      (FACES as readonly RosterEntry[]).map((f) => [f.type, f] as const),
    );
    for (const t of ORDER_SUBJECTS) {
      expect(roster.has(t), `${t} is not in the FACES roster — this probe would measure nothing`)
        .toBe(true);
    }

    /** One compact scene, from `spawnFace` onward — the SAME calls the gate makes. */
    const captureCompact = async (page: import('@playwright/test').Page, type: string) => {
      const entry = roster.get(type)!;
      const opts = {
        ...(entry.videoFaceWhy ? { videoFaceWhy: entry.videoFaceWhy } : {}),
        ...(entry.singletonAdoptWhy ? { singletonAdoptWhy: entry.singletonAdoptWhy } : {}),
      };
      const memberId = await spawnFace(page, type, opts);
      await frameMember(page, memberId, 0.45, 'compact');
      await freezeFaceAudio(page, `probe-${type}`);
      const tile = page.locator(
        `.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`,
      );
      return (await tile.screenshot()).toString('base64');
    };

    // ── the CONTROL: one fresh context+page per scene, exactly as main does ──
    const fresh = new Map<string, string>();
    const freshMs: number[] = [];
    for (const type of ORDER_SUBJECTS) {
      const ctx = await browser.newContext({
        viewport: LEGACY_FOLD_VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      const t = Date.now();
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      await loadFaceRack(page, {});
      fresh.set(type, await captureCompact(page, type));
      freshMs.push(Date.now() - t);
      await ctx.close();
    }

    // ── the SHARED page, three orders ───────────────────────────────────────
    const orders: Record<string, string[]> = {
      declared: [...ORDER_SUBJECTS],
      reversed: [...ORDER_SUBJECTS].reverse(),
      // Deterministic shuffle: a fixed rotation + swap, so a failure reproduces.
      shuffled: [...ORDER_SUBJECTS].slice(2).concat([...ORDER_SUBJECTS].slice(0, 2)).reverse(),
    };

    const offenders: string[] = [];
    const sharedMs: number[] = [];
    for (const [label, order] of Object.entries(orders)) {
      const ctx = await browser.newContext({
        viewport: LEGACY_FOLD_VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      await loadFaceRack(page, {});
      const pristine: FaceRackPristine = await sampleFaceRackPristine(page);

      for (const type of order) {
        const t = Date.now();
        await resetFaceRack(page, pristine);
        const shot = await captureCompact(page, type);
        sharedMs.push(Date.now() - t);
        const d = await diffRegion(page, fresh.get(type)!, shot, 26);
        if (d.diffPixels > 0) {
          offenders.push(`${label}/${type}: ${d.diffPixels} px differ (${JSON.stringify(d)})`);
        }
      }
      await ctx.close();
    }

    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
    console.log('\n── D: shared page vs fresh boot ──');
    console.log(`   subjects             ${ORDER_SUBJECTS.join(', ')}`);
    console.log(`   fresh-boot scene     ${stats(freshMs)}`);
    console.log(`   shared-page scene    ${stats(sharedMs)}`);
    console.log(`   speed-up             ${(med(freshMs) / med(sharedMs)).toFixed(2)}x  `
      + `(${ms(med(freshMs) - med(sharedMs))} saved per scene)`);
    console.log(`   pixel offenders      ${offenders.length}`);

    expect(
      offenders,
      'a shared-page capture differs from a fresh-boot capture of the SAME scene on the SAME '
        + 'machine — the shared page is not equivalent and this lane pins committed PNGs',
    ).toEqual([]);
  });
});
