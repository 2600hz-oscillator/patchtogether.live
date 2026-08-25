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
  openDock,
  unfoldDockPane,
  readFoldGeometry,
  foldViewportFor,
  settle,
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

const ms = (n: number | undefined) => (n === undefined ? 'n/a' : `${n.toFixed(0)} ms`);
// ⚠ EMPTY-SAFE, AND IT COST A WHOLE SWEEP. With `PROBE_TIERS=dock` the compact
// timing array is legitimately empty, `s[0]` is `undefined`, and `.toFixed` threw
// — AFTER every comparison had run and BEFORE the offender list was printed. The
// probe's own summary destroyed the probe's own finding. Hence this, and hence the
// offenders being reported FIRST below: a reporting bug must never be able to eat
// the measurement it is reporting.
const stats = (xs: number[]) => {
  if (xs.length === 0) return 'n=0 (not measured in this run)';
  const s = [...xs].sort((a, b) => a - b);
  return `n=${s.length} min=${ms(s[0])} med=${ms(s[s.length >> 1])} max=${ms(s[s.length - 1])}`;
};

test.describe('BOOT PROBE — what a VRT scene spends its time on', () => {
  test.setTimeout(600_000);

  test('A/B: a COLD context + first load, sampled', async ({ browser }) => {
    const contextMs: number[] = [];
    const gotoMs: number[] = [];
    const idleMs: number[] = [];
    const fontMs: number[] = [];
    const hookMs: number[] = [];
    const reqCounts: (() => { reqs: number; bytes: number })[] = [];

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

      // ⚠ WHAT THE LOAD ACTUALLY IS, counted rather than characterised. This
      // lane targets `localBaseUrl('dev')` — the VITE DEV SERVER — while the e2e
      // lane serves the built bundle (`E2E_USE_PREVIEW=1`). A dev load is one
      // request per unbundled module; a preview load is a handful of chunks. The
      // difference is a real further saving, but it needs `build-web`'s artifact
      // plumbed into the vrt job, so this MEASURES it and changes nothing.
      let reqs = 0;
      let bytes = 0;
      page.on('response', (r) => {
        reqs += 1;
        const len = Number(r.headers()['content-length'] ?? 0);
        if (Number.isFinite(len)) bytes += len;
      });
      reqCounts.push(() => ({ reqs, bytes }));

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
    const counted = reqCounts.map((f) => f());
    console.log('── WHAT THE DEV SERVER SHIPS (quantified, not changed) ──');
    console.log(`   responses per load   ${stats(counted.map((c) => c.reqs))}`);
    console.log(`   content-length sum   ${stats(counted.map((c) => c.bytes / 1e6))} (MB)`);
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
// ⚠ THE SUBJECTS COVER EVERY BOOT BRANCH, not just the common one. `spawnFace`
// has three: the ordinary channel column, `videoFaceWhy` (the video zone, plus a
// video freeze), and `singletonAdoptWhy` (which does not spawn at all — it
// UN-PINS a node the rack already shipped, so it is the branch a reset can get
// wrong by leaving a pinned node displaced). A probe that only exercised the
// common branch would return a clean number and prove nothing about the other
// two.
//
// ⚠ `PROBE_FACES=all` SWEEPS THE WHOLE ROSTER, and that is the mode that
// actually answers the question. A hand-picked sample can only ever find the
// classes someone already suspected — and the one this probe DID find
// (`timelorde`: 41,205 px, deterministic, dock only) was found because a
// suspect was in the sample, which is luck rather than method. The sweep is
// slow (roughly a fresh boot plus a shared scene per face), so it is opt-in;
// `PROBE_ORDERS=1` and `PROBE_TIERS=dock` cut it to the cheapest form that
// still discriminates, since every failure seen so far is a dock failure and
// none has depended on order.
const ORDER_SUBJECTS = (() => {
  const raw = process.env.PROBE_FACES ?? 'adsr';
  if (raw !== 'all') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return (FACES as readonly { type: string; freshPageWhy?: string; simPin?: unknown }[])
    // A face that already DECLARES it cannot share is not a finding, it is the
    // declaration working — exclude it so the sweep's output is only news.
    .filter((f) => !f.freshPageWhy && !f.simPin)
    .map((f) => f.type);
})();

/** Which orders to run. One is enough to find a face that cannot share at all;
 *  three is what proves ORDER-independence for the ones that can. */
const PROBE_ORDERS = Number(process.env.PROBE_ORDERS ?? 3);
/** Which tiers to compare. `dock` alone halves the sweep and is where every
 *  difference measured so far has appeared. */
const PROBE_TIERS = (process.env.PROBE_TIERS ?? 'compact,dock').split(',');

/** ⚠ 1/255, NOT the gate's 26/255. The gate's tolerance exists to absorb GPU
 *  anti-aliasing drift between RUNS; this comparison is two captures in ONE run
 *  on ONE machine, so there is nothing legitimate for a tolerance to absorb and
 *  a threshold here would only hide the thing being measured. Identity is the
 *  claim, so identity is what is asserted. */
const IDENTITY_DELTA = 1;

test.describe('D: shared page vs fresh page — same pixels?', () => {
  // ⚠ A PROBE'S OWN BUDGET IS NOT A FINDING, and confusing the two cost a run:
  // the first version capped at 900 s, the sweep ran past it, and the timeout
  // arrived as `1 failed` with twenty screenshots and NO console output — which
  // reads exactly like "the shared page moved pixels". Sized here so the probe
  // can only ever fail on its subject. (Costs nothing: a cap is not a sleep.)
  test.setTimeout(3_600_000);

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

    const optsFor = (type: string) => {
      const entry = roster.get(type)!;
      return {
        ...(entry.videoFaceWhy ? { videoFaceWhy: entry.videoFaceWhy } : {}),
        ...(entry.singletonAdoptWhy ? { singletonAdoptWhy: entry.singletonAdoptWhy } : {}),
      };
    };

    /** One compact scene, from `spawnFace` onward — the SAME calls the gate makes. */
    const captureCompact = async (page: import('@playwright/test').Page, type: string) => {
      const memberId = await spawnFace(page, type, optsFor(type));
      await frameMember(page, memberId, 0.45, 'compact');
      await freezeFaceAudio(page, `probe-${type}`);
      const tile = page.locator(
        `.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`,
      );
      return (await tile.screenshot()).toString('base64');
    };

    /**
     * One DOCK scene — the tier that carries the geometry assertions.
     *
     * ⚠ THIS IS WHERE LEAKED ZOOM WOULD SHOW, which is why the probe does not
     * stop at the compact tile. `readFoldGeometry`'s `hiddenY` / `hiddenX` /
     * `topY`, the width-slack ceiling and `plateW >= bodyW` are all read in CSS
     * px off a live layout, so every one of them is a number a shared page could
     * move without moving a single pixel of the tile above. Both the PNG and the
     * geometry are compared.
     */
    const captureDock = async (page: import('@playwright/test').Page, type: string) => {
      const entry = roster.get(type)!;
      // ⚠ NOT RESIZED HERE — the caller does it, and WHEN it does is the thing
      // under test. The gate sizes the window BEFORE the navigation, so a fresh
      // scene loads the app already at its dock height; a shared scene has no
      // navigation left to size, so it must resize an app that booted at the
      // compact height. Resizing on both sides would make this comparison
      // invariant to the very difference the shared page introduces — a metric
      // blind to its own subject, which is the failure this repo names first.
      const memberId = await spawnFace(page, type, optsFor(type));
      await frameMember(page, memberId, 0.7, 'full');
      const faceplate = await openDock(page, memberId, entry.pages);
      await unfoldDockPane(page);
      const g = await readFoldGeometry(page);
      await freezeFaceAudio(page, `probe-${type}-dock`);
      await settle(page);
      return {
        png: (await faceplate.screenshot()).toString('base64'),
        // Only the fields the gate ASSERTS on — a probe that compared every
        // field would go red on something no gate reads and teach nothing.
        geom: {
          hiddenY: g.hiddenY, hiddenX: g.hiddenX, topY: g.topY,
          bodyW: g.bodyW, contentW: g.contentW, plateW: g.plateW,
          tabs: g.tabs, renderedBands: g.renderedBands, bands: g.bands.length,
        },
      };
    };

    // ── the CONTROL: one fresh context+page per scene, exactly as main does ──
    const fresh = new Map<string, string>();
    const freshDock = new Map<string, { png: string; geom: Record<string, number> }>();
    const freshMs: number[] = [];
    const freshDockMs: number[] = [];
    for (const type of ORDER_SUBJECTS) {
      if (PROBE_TIERS.includes('compact')) {
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
      if (PROBE_TIERS.includes('dock')) {
        const ctx = await browser.newContext({
          viewport: LEGACY_FOLD_VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce',
        });
        const page = await ctx.newPage();
        const t = Date.now();
        // BEFORE the load — exactly the order `workflow-shell-faces.spec.ts`
        // uses today, so this control is the real thing and not a convenient
        // rearrangement of it.
        await page.setViewportSize(foldViewportFor(type));
        await loadFaceRack(page, {});
        freshDock.set(type, await captureDock(page, type));
        freshDockMs.push(Date.now() - t);
        await ctx.close();
      }
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
    const sharedDockMs: number[] = [];
    for (const [label, order] of Object.entries(orders).slice(0, PROBE_ORDERS)) {
      const ctx = await browser.newContext({
        viewport: LEGACY_FOLD_VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      await loadFaceRack(page, {});
      const pristine: FaceRackPristine = await sampleFaceRackPristine(page);

      for (const type of order) {
        // COMPACT
        if (PROBE_TIERS.includes('compact')) {
          await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
          const t = Date.now();
          await resetFaceRack(page, pristine);
          const shot = await captureCompact(page, type);
          sharedMs.push(Date.now() - t);
          const d = await diffRegion(page, fresh.get(type)!, shot, IDENTITY_DELTA);
          if (d.diffPixels > 0) {
            offenders.push(`${label}/${type}-compact: ${d.diffPixels} px differ ${JSON.stringify(d)}`);
          }
        }
        // DOCK — pixels AND the geometry the gate asserts on.
        if (PROBE_TIERS.includes('dock')) {
          const t = Date.now();
          await resetFaceRack(page, pristine);
          // AFTER the load, because there is no load left — the shared page
          // booted at the compact height. This is the asymmetry being measured.
          await page.setViewportSize(foldViewportFor(type));
          const got = await captureDock(page, type);
          sharedDockMs.push(Date.now() - t);
          const want = freshDock.get(type)!;
          const d = await diffRegion(page, want.png, got.png, IDENTITY_DELTA);
          if (d.diffPixels > 0) {
            offenders.push(`${label}/${type}-dock: ${d.diffPixels} px differ ${JSON.stringify(d)}`);
          }
          if (JSON.stringify(got.geom) !== JSON.stringify(want.geom)) {
            offenders.push(
              `${label}/${type}-dock GEOMETRY: shared ${JSON.stringify(got.geom)} vs `
                + `fresh ${JSON.stringify(want.geom)} — a shared page moved a number the gate `
                + 'ASSERTS on even where it moved no pixel',
            );
          }
        }
      }
      await ctx.close();
    }

    // ⚠ THE FINDING FIRST. The timing summary below is a convenience; the
    // offender list is the measurement, and a crash in the convenience once
    // destroyed it after a 13-minute sweep had already computed it.
    console.log(`\n── D: OFFENDERS (${offenders.length}) at ${IDENTITY_DELTA}/255 ──`);
    console.log(`   subjects (${ORDER_SUBJECTS.length}): ${ORDER_SUBJECTS.join(', ')}`);
    for (const o of offenders) console.log(`   ${o}`);
    if (offenders.length === 0) console.log('   none — every scene captured the same pixels shared as fresh');

    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : NaN);
    const ratio = (a: number, b: number) => (Number.isFinite(a / b) ? `${(a / b).toFixed(2)}x` : 'n/a');
    console.log('\n── D: timings ──');
    console.log(`   compact fresh        ${stats(freshMs)}`);
    console.log(`   compact shared       ${stats(sharedMs)}`);
    console.log(`     speed-up           ${ratio(med(freshMs), med(sharedMs))}`);
    console.log(`   dock fresh           ${stats(freshDockMs)}`);
    console.log(`   dock shared          ${stats(sharedDockMs)}`);
    console.log(`     speed-up           ${ratio(med(freshDockMs), med(sharedDockMs))}`);

    expect(
      offenders,
      'a shared-page capture differs from a fresh-boot capture of the SAME scene on the SAME '
        + 'machine — the shared page is not equivalent and this lane pins committed PNGs',
    ).toEqual([]);
  });

  // ── E: HOW FAR CAN ONE PAGE BE PUSHED? ────────────────────────────────────
  //
  // ⚠ THE SHARED PAGE DEGRADES, AND THIS IS WHAT PRICES THE CEILING.
  // `rack-session.ts` measured ~10 % on `wavesculpt` after ~50 rows and capped
  // reuse at 20 — but that is the FUNCTIONAL lane, where wavesculpt is the only
  // GL-heavy row among DOM ones. Here EVERY scene is GL and every scene
  // screenshots, so the constant is RE-MEASURED rather than ported: carrying a
  // threshold across a change in the population it was measured on is the exact
  // shape this repo keeps getting bitten by.
  //
  // It reports the per-scene cost bucketed by POSITION on the page, and the
  // pixel diff against the fresh control at every position — because the ceiling
  // has to bound whichever comes first, the slowdown or a moved pixel.
  test('E: the per-scene cost and pixel identity as ONE page ages', async ({ browser }) => {
    const laps = Number(process.env.PROBE_LAPS ?? 4);
    const subjects = ORDER_SUBJECTS.slice(0, 6);

    // The fresh control, once per subject.
    const control = new Map<string, string>();
    for (const type of subjects) {
      const ctx = await browser.newContext({
        viewport: LEGACY_FOLD_VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      await loadFaceRack(page, {});
      const memberId = await spawnFace(page, type, {});
      await frameMember(page, memberId, 0.45, 'compact');
      await freezeFaceAudio(page, `age-${type}`);
      control.set(type, (await page
        .locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`)
        .screenshot()).toString('base64'));
      await ctx.close();
    }

    const ctx = await browser.newContext({
      viewport: LEGACY_FOLD_VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
    await loadFaceRack(page, {});
    const pristine = await sampleFaceRackPristine(page);

    const rows: { n: number; type: string; ms: number; diff: number }[] = [];
    let n = 0;
    for (let lap = 0; lap < laps; lap++) {
      for (const type of subjects) {
        n += 1;
        const t = Date.now();
        await resetFaceRack(page, pristine);
        const memberId = await spawnFace(page, type, {});
        await frameMember(page, memberId, 0.45, 'compact');
        await freezeFaceAudio(page, `age-${type}-${n}`);
        const shot = (await page
          .locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`)
          .screenshot()).toString('base64');
        const ms2 = Date.now() - t;
        const d = await diffRegion(page, control.get(type)!, shot, IDENTITY_DELTA);
        rows.push({ n, type, ms: ms2, diff: d.diffPixels });
      }
    }
    await ctx.close();

    const bucket = (lo: number, hi: number) =>
      rows.filter((r) => r.n > lo && r.n <= hi).map((r) => r.ms);
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : NaN);
    console.log(`\n── E: one page, ${rows.length} scenes ──`);
    for (let lo = 0; lo < rows.length; lo += subjects.length) {
      const b = bucket(lo, lo + subjects.length);
      console.log(`   scenes ${String(lo + 1).padStart(2)}-${String(lo + subjects.length).padStart(2)}  med ${ms(med(b))}`);
    }
    const first = med(bucket(0, subjects.length));
    const last = med(bucket(rows.length - subjects.length, rows.length));
    console.log(`   drift first->last    ${((100 * (last - first)) / first).toFixed(1)}%`);
    const moved = rows.filter((r) => r.diff > 0);
    console.log(`   scenes whose pixels moved: ${moved.length}`);
    for (const m of moved.slice(0, 10)) console.log(`     #${m.n} ${m.type}: ${m.diff} px`);

    expect(
      moved.map((m) => `#${m.n} ${m.type}: ${m.diff} px`),
      'a scene late on a shared page captured different pixels from the same scene on a fresh '
        + 'boot — the reuse ceiling must be below this position',
    ).toEqual([]);
  });

  // ── THE CONTROL ON THE CONTROL ────────────────────────────────────────────
  //
  // ⚠ THE TEST ABOVE HAS A BLIND SPOT AND IT IS THE CLASSIC ONE: both of its
  // sides are contexts I built by hand with `browser.newContext({…})`. A shared
  // context does NOT inherit the config's `use` block — Playwright applies
  // viewport / deviceScaleFactor / reducedMotion through the `context` and `page`
  // FIXTURES, not to a context created off the `browser` fixture. So if my option
  // set differs from the config's, BOTH sides of that comparison are equally
  // wrong, the diff is 0, and the metric is invariant to the very dimension under
  // test. `rack-session.ts` calls `browser.newContext()` with no options at all,
  // which is harmless for a functional sweep and would be a silent baseline move
  // here.
  //
  // So this compares the config's OWN `page` fixture against a hand-built
  // context, and it is the leg that would go red if the shared context's options
  // ever drift from `vrt.config.ts`'s `use` block.
  test('CONTROL: a hand-built context captures what the config’s own page fixture does', async ({
    page,
    browser,
  }) => {
    const type = ORDER_SUBJECTS[0]!;
    await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
    await loadFaceRack(page, {});
    const memberId = await spawnFace(page, type, {});
    await frameMember(page, memberId, 0.45, 'compact');
    await freezeFaceAudio(page, `control-${type}`);
    const viaFixture = (await page
      .locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`)
      .screenshot()).toString('base64');

    const ctx = await browser.newContext({
      viewport: LEGACY_FOLD_VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce',
    });
    const p2 = await ctx.newPage();
    await p2.setViewportSize(LEGACY_FOLD_VIEWPORT);
    await loadFaceRack(p2, {});
    const m2 = await spawnFace(p2, type, {});
    await frameMember(p2, m2, 0.45, 'compact');
    await freezeFaceAudio(p2, `control-${type}-manual`);
    const viaManual = (await p2
      .locator(`.svelte-flow__node[data-id="${m2}"] [data-testid="module-shell"]`)
      .screenshot()).toString('base64');
    await ctx.close();

    const d = await diffRegion(page, viaFixture, viaManual, IDENTITY_DELTA);
    console.log(`\n── CONTROL: config page fixture vs hand-built context (${type}) ──`);
    console.log(`   ${d.width}x${d.height}, ${d.diffPixels} px differ at ${IDENTITY_DELTA}/255`);
    expect(
      d.diffPixels,
      'the hand-built context does not render what the config’s `use` block renders — every '
        + 'shared-page measurement is then comparing two equally-wrong captures, and the shared '
        + 'page would move baselines while every probe stayed green',
    ).toBe(0);
  });
});
