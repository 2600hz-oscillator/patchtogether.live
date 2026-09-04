// e2e/tests/layers-survive-card-collapse.spec.ts
//
// #1589 — collapsing TOYBOX must not drop its video layers, and Export must
// never write a preset it knows is incomplete.
//
// TOYBOX is un-migrated, so under the faceplate shell its card exists ONLY
// inside the dock full-view. Collapsing UNMOUNTS it, and the card's `onDestroy`
// ran `attachLayerVideo(i, null)`, `URL.revokeObjectURL`,
// `pause()/srcObject=null/removeAttribute('src')/load()` and `track.stop()` for
// every layer. Two consequences, and the second is the one that destroys trust:
//
//   1. THE CARD LIED. The layer row still showed the filename (it rides the
//      Y.Doc), so the card looked loaded while rendering nothing.
//   2. EXPORT WAS SILENTLY CORRUPT. `resolveLayerVideos` skips layers with no
//      live url, so the `.toybox.zip` carried ZERO video bytes and the card
//      reported success. The user finds out when the preset opens black.
//
// The elements, urls and camera streams now live in
// $lib/ui/media/node-media-registry, keyed to the NODE and swept from Canvas
// against the live node set.
//
// ── WHY THE NAME HAS NO `toybox-` PREFIX ─────────────────────────────────────
//
// `**/toybox-*.spec.ts` is a WEBGL_HEAVY_GLOB (e2e/webgl-heavy-globs.ts), and
// per that file's own banner, enrolling a spec there DELETES its PR coverage —
// the lane that ran the excluded specs was removed in #839. A regression guard
// that runs nowhere is worse than none, so this spec is named to stay in the
// sharded matrix, exactly as `collapse-keeps-playing.spec.ts` avoids `video-*`
// for the same reason. (Renaming it to `toybox-…` silently un-runs it.)
//
// ── DETERMINISM ──────────────────────────────────────────────────────────────
//
// Every assertion is DOM state, the MEDIA CLOCK, the node's own registry record,
// or the exported zip's BYTES. Never a pixel, never a wall-clock budget standing
// in for progress. "Advanced N seconds of media time" is renderer-independent by
// construction — SwiftShader renders ~7.9 fps against ~60 on a real GPU, so a ms
// budget would be a different assertion on every machine — and the timeouts here
// only BOUND a failure, they are never the gate.
//
// ⚠ The `?shell=legacy` toybox specs keep the real card in the LANE, so the card
// never moves between mounts and this entire bug class is invisible to them.
// This spec goes to plain `/rack` deliberately; do not add a shell param.

import { test, expect, type Page } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';

const FIXTURE = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));
const FIXTURE_BYTES = statSync(FIXTURE).size;

const NODE = 'tb';
const LAYER = 0;
const LAYER_VIDEO = `[data-testid="toybox-layer-video-${LAYER}"]`;

interface MediaRow {
  nodeId: string;
  slot: string;
  adopted: boolean;
  hasUrl: boolean;
  name: string | null;
  hasStream: boolean;
}

/** The NODE's own media record — deliberately NOT read off the card, because
 *  surviving the card's absence is the entire claim under test. */
async function nodeMedia(page: Page, id: string): Promise<MediaRow[]> {
  return page.evaluate(
    (n) => (globalThis as unknown as { __nodeMedia(x: string): MediaRow[] }).__nodeMedia(n),
    id,
  );
}

/** The layer element's live state, sampled IN THE PAGE (never a Playwright poll
 *  loop — that samples the very main thread it measures). */
async function layerState(page: Page) {
  return page.evaluate((sel) => {
    const v = document.querySelector(sel) as HTMLVideoElement | null;
    if (!v) return { present: false, hasSrc: false, paused: true, currentTime: 0, where: 'absent' };
    return {
      present: true,
      hasSrc: !!(v.currentSrc || v.getAttribute('src')),
      paused: v.paused,
      currentTime: v.currentTime,
      where: v.closest('[data-testid="node-media-parking"]')
        ? 'parking'
        : v.closest('[data-testid="dock-full-view"]')
          ? 'dock'
          : 'other',
    };
  }, LAYER_VIDEO);
}

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Plain /rack — the DEFAULT shell. See the header.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await spawnPatch(page, [{ id: NODE, type: 'toybox', domain: 'video' }], [], { mountTimeout: 40_000 });
  return errors;
}

/**
 * Open the dock full-view — the owner's "expand" — and wait for the real
 * console.
 *
 * ⚠ RE-SUBJECTED 2026-09-02, WHEN TOYBOX WAS PROMOTED. This waited for
 * `toybox-card`, and after promotion there is no card ANYWHERE: toybox is in
 * none of DOM_SOURCE_LANE_TYPES / CARD_PRODUCER_LANE_TYPES /
 * HEADLESS_MOUNT_LANE_TYPES, so there is not even a `<HeadlessSourceHost>` copy
 * — the dock mounts `toybox-face-body` instead. It FAILED on CI rather than
 * going quietly green, which is the gate working; every other testid this file
 * drives (`toybox-video-input`, `toybox-preset-export`, `toybox-video-filename`,
 * `toybox-video-relink`, the preset notice and error) is CONSOLE markup that
 * both surfaces render unchanged, because the promotion MOVED the console
 * rather than copying it.
 *
 * ⚠ AND THE SUBJECT IS NOW STRICTLY STRONGER. The #1589 class is "the media
 * dies when the mount goes away"; before promotion the mount was a card that
 * `?shell=legacy` also renders in the lane, and now the dock full view is the
 * ONLY mount there is. A collapse is the whole of it.
 */
async function expand(page: Page): Promise<void> {
  await page.evaluate(
    (n) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(n),
    NODE,
  );
  await expect(page.getByTestId('toybox-face-body')).toBeVisible({ timeout: 40_000 });
}

/** The PRESET store lives on the face's third tab. The layer band (and so the
 *  video picker) is persistent, so only preset work needs this. */
async function presetsTab(page: Page): Promise<void> {
  await page.getByTestId('toybox-face-tab-presets').click();
  await expect(page.getByTestId('toybox-preset-section')).toBeVisible({ timeout: 20_000 });
}

/** Seed layer `LAYER` as a local-file VIDEO layer, optionally with a filename
 *  already on the Y.Doc but no bytes (the state a reload / saved preset / a
 *  rack-mate's write leaves behind). Writes the live Y.Doc exactly as the
 *  existing toybox specs do. */
async function seedVideoLayer(page: Page, opts: { name?: string } = {}): Promise<void> {
  await page.evaluate(
    ({ node, name }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[node];
        if (!n) return;
        if (!n.data) n.data = {};
        const layer: Record<string, unknown> = {
          kind: 'video',
          contentId: null,
          params: {},
          videoSource: 'file',
        };
        if (name) layer.videoMeta = { name };
        (n.data as Record<string, unknown>).layers = [
          layer,
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
      });
    },
    { node: NODE, name: opts.name ?? '' },
  );
}

/** Load the fixture into the active layer through the REAL file input and wait
 *  until the node's element is genuinely playing it. */
async function loadFixture(page: Page): Promise<void> {
  // The <input type=file> is display:none inside its label — setInputFiles works
  // on a hidden input, so wait for ATTACHED, not VISIBLE.
  await expect(page.locator('[data-testid="toybox-video-input"]')).toHaveCount(1, { timeout: 30_000 });
  await page.locator('[data-testid="toybox-video-input"]').setInputFiles(FIXTURE);
  await page.waitForFunction(
    (sel) => {
      const v = document.querySelector(sel) as HTMLVideoElement | null;
      return !!v && !!(v.currentSrc || v.getAttribute('src')) && !v.paused && v.currentTime > 0.05;
    },
    LAYER_VIDEO,
    { timeout: 40_000 },
  );
}

interface ExportedZip {
  videos: { layer: number; name: string; path: string }[];
  byteLengths: number[];
}

/** Click EXPORT, capture the download, and read the zip back. Returns the
 *  manifest's video entries and the ACTUAL byte length stored for each — the
 *  only reading of "the export worked" that a zero-video zip cannot pass. */
async function exportAndRead(page: Page): Promise<ExportedZip> {
  await presetsTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 40_000 }),
    page.locator('[data-testid="toybox-preset-export"]').first().dispatchEvent('click'),
  ]);
  const path = await download.path();
  expect(path, 'the browser produced no downloaded file').toBeTruthy();
  const entries = unzipSync(new Uint8Array(readFileSync(path!)));
  const manifest = JSON.parse(strFromU8(entries['preset.json']!)) as {
    videos: { layer: number; name: string; path: string }[];
  };
  return {
    videos: manifest.videos ?? [],
    byteLengths: (manifest.videos ?? []).map((v) => entries[v.path]?.length ?? 0),
  };
}

// ⚠ THE PER-TEST BUDGET IS DERIVED, NOT FLAT — the 2026-09-04 shard-7 lesson
// (run 33831771627: both attempts of two tests died of "Test timeout of
// 180000ms exceeded" mid-prefix with NO step assertion failing, on a shard
// whose population was byte-identical to a green main run hours earlier).
//
// Every wait in this file is an observable-state condition carrying its own
// cap, so a genuinely hung step dies AT THAT STEP with a named assertion. The
// per-test budget exists only to bound the whole run — and a bound must cover
// the SUM of the step caps it contains. The flat 180 s did not: boot alone is
// entitled to goto(30 s) + spawnPatch's up-to-3 mount attempts at this file's
// 40 s cap, expand() is a COLD toybox face boot inside the dock (40 s), the
// fixture decode is 30 s + 40 s under SwiftShader — on one slow runner the
// prefix legitimately consumed the whole budget and the test was killed while
// every individual step was still inside its own cap. A budget smaller than
// its own steps' bounds is not a tighter test; it is a coin flip on runner
// speed, and it burned 4 × 180 s of shard wall time to report nothing.
const GOTO_CAP_MS = 30_000; // boot(): workflow-topbar visible
const SPAWN_WORST_MS = 3 * 40_000; // boot(): spawnPatch retries the mount up to 3× at our 40 s cap
const EXPAND_CAP_MS = 40_000; // expand(): toybox-face-body — a cold dock face boot
const FIXTURE_CAP_MS = 30_000 + 40_000; // loadFixture(): input attached + decoded-to-playing
// The longest single test additionally chains tab/lamp/error/notice waits
// (6 × 20 s), two 30 s attribute/registry waits and two 40 s export/download
// waits — summed generously rather than per-test, because a budget that must
// be re-balanced every time a wait is added is how it drifted under again.
const CHAIN_CAPS_MS = 6 * 20_000 + 2 * 30_000 + 2 * 40_000;
const TEST_BUDGET_MS =
  GOTO_CAP_MS + SPAWN_WORST_MS + EXPAND_CAP_MS + FIXTURE_CAP_MS + CHAIN_CAPS_MS + 30_000;

test.describe('#1589 — TOYBOX layer media belongs to the NODE', () => {
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 6 recovered-on-retry observation(s) across 3 SHA(s) / 3 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: #1589 — collapsing TOYBOX must not drop its video layers, and Export must never write a preset it knows is incomplete; the card's onDestroy tearing down every layer is the live failure mode.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('a video layer survives the tray being dismissed, and Export still carries its exact bytes', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 6 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    test.setTimeout(TEST_BUDGET_MS);
    const errors = await boot(page);

    await expand(page);
    await seedVideoLayer(page);
    await loadFixture(page);

    // The element is NODE-owned: it lives in the registry's parking host, not in
    // the card's subtree. That is what makes the card's unmount survivable, so
    // assert it rather than inferring it.
    const loaded = await layerState(page);
    expect(loaded.where, `layer element must be node-owned (parked), not card-owned: ${JSON.stringify(loaded)}`)
      .toBe('parking');
    expect(await nodeMedia(page, NODE)).toContainEqual(
      expect.objectContaining({ slot: `layer-video-${LAYER}`, hasUrl: true, name: 'lobby-clip.webm' }),
    );

    // ── POSITIVE CONTROL, run BEFORE the act under test ──────────────────────
    // Export while everything is mounted and healthy. If this leg ever stops
    // producing bytes, the post-collapse leg below proves nothing — "the zip is
    // empty because the fix failed" and "the zip is empty because export is
    // broken for an unrelated reason" are indistinguishable from one sample.
    const control = await exportAndRead(page);
    expect(control.videos.map((v) => v.layer), `control export carried no video: ${JSON.stringify(control)}`)
      .toEqual([LAYER]);
    expect(control.videos[0]!.name).toBe('lobby-clip.webm');
    expect(control.byteLengths[0], 'control export must carry the WHOLE fixture').toBe(FIXTURE_BYTES);

    // ── THE ACT UNDER TEST: collapse. This unmounts the card. ────────────────
    await page.getByTestId('faceplate-collapse').click();
    await expect(page.getByTestId('toybox-face-body')).toHaveCount(0, { timeout: 20_000 });

    // SAMPLE THE SETTLED STATE, NOT THE TRANSITION. The first CI failures of this
    // spec read `currentTime: 0` at `where: "parking"` AFTER a waitForFunction had
    // already seen the clock past its target — i.e. the clock went BACKWARDS
    // between the wait and the read. The wait was sampling the pre-parking
    // element/state; the collapse→parking hand-off then reset it, and the settled
    // read got 0. On a fast machine parking completes before the wait's first
    // sample, so the race is invisible locally (3x green under SwiftShader at
    // workers=1) and fires under CI's 4-worker load. So: require the element to
    // BE PARKED first, take the baseline from the PARKED element, and only then
    // require the clock to advance. This pins every sample to the artifact the
    // engine actually consumes, and it still reds if a parked layer's clock is
    // dead — which is the property under test.
    await expect
      .poll(async () => (await layerState(page)).where, {
        timeout: 20_000,
        message: 'the layer video must land in the node-media parking lot after collapse',
      })
      .toBe('parking');
    const parked = await layerState(page);
    expect(parked.hasSrc, `parked element lost its src: ${JSON.stringify(parked)}`).toBe(true);

    // The parked element's MEDIA CLOCK advances — "present" alone is the
    // half-fix (#1531's projector that is open and dead).
    //
    // ⚠ MEASURE PLAYBACK, NEVER COMPARE TWO READINGS OF THIS CLOCK (#1612).
    // The fixture LOOPS at ~4.004 s, so `currentTime` is CYCLIC — it
    // legitimately goes backwards every 4 seconds. The previous shape here
    // (`waitForFunction(currentTime > tBefore + 0.4)` followed by a settled
    // re-read compared to tBefore) failed on CI shard 1 with `got 2.994` vs
    // `tBefore 3.016`: the wait saw 3.42+, the video wrapped, and the re-read
    // landed early in the NEXT loop. And when tBefore lands past ~3.6 s the
    // wait's target exceeds the fixture's duration entirely — an UNREACHABLE
    // gate that burns its whole 40 s bound. Same bug class collapse-keeps-
    // playing had (fixed in add1bdea): a cyclic clock is not a number line.
    //
    // So: accumulate PLAYED media-time IN THE PAGE (rAF-sampled, wrap-aware),
    // and gate on the accumulation. The wall-clock budget only bounds the
    // failure; the samples/elapsed are reported so "frozen clock" and "never
    // looked" stay distinguishable (blind-gates rule 5).
    const ADVANCE_S = 0.4;
    const played = await page.evaluate(
      async ({ sel, need, budgetMs }) => {
        const v = document.querySelector(sel) as HTMLVideoElement | null;
        if (!v) return { ok: false, reason: 'no element', played: 0, samples: 0, elapsedMs: 0 };
        let acc = 0;
        let prev = v.currentTime;
        let samples = 1;
        const t0 = performance.now();
        while (performance.now() - t0 < budgetMs) {
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const cur = v.currentTime;
          const d = cur - prev;
          if (d > 0) acc += d;
          // A large negative jump is the LOOP WRAP: credit the tail of the old
          // lap plus the head of the new one. (Small negative jitter is
          // ignored rather than credited.)
          else if (d < -0.5 && Number.isFinite(v.duration)) acc += Math.max(0, v.duration - prev) + cur;
          if (cur !== prev) samples += 1;
          prev = cur;
          const parked = !!v.closest('[data-testid="node-media-parking"]');
          if (acc >= need && parked && !v.paused) {
            return { ok: true, played: acc, samples, elapsedMs: performance.now() - t0, paused: v.paused, parked };
          }
        }
        return {
          ok: false,
          played: acc,
          samples,
          elapsedMs: performance.now() - t0,
          paused: v.paused,
          parked: !!v.closest('[data-testid="node-media-parking"]'),
          currentTime: v.currentTime,
        };
      },
      { sel: LAYER_VIDEO, need: ADVANCE_S, budgetMs: 40_000 },
    );
    expect(
      played.ok,
      `the PARKED layer must PLAY ≥${ADVANCE_S}s of media time (units: media seconds, wrap-aware accumulation — ` +
        `NOT a currentTime comparison; the fixture loops at ~4s) while the card is gone. Got ${JSON.stringify(played)}`,
    ).toBe(true);

    // ── PERMANENT INSTRUMENT LEG: force a WRAP crossing every run. ──────────
    // The accumulator's wrap-credit branch is the part #1612 existed for, and a
    // natural run only crosses the loop boundary when the collapse happens to
    // land late in the ~4 s lap (~10% of runs) — so without this leg the branch
    // under test is mostly UNTESTED and a regression rides green CI until it
    // meets an unlucky baseline. Seat the still-parked element just before the
    // loop point; requiring ≥0.4 s of played time from there MUST cross the
    // wrap, so a wrap-blind accumulator (or the old two-readings comparison)
    // fails HERE, deterministically, not on shard 1 once a week.
    await page.evaluate((sel) => {
      const v = document.querySelector(sel) as HTMLVideoElement | null;
      if (v && Number.isFinite(v.duration)) v.currentTime = Math.max(0, v.duration - 0.15);
    }, LAYER_VIDEO);
    const wrapped = await page.evaluate(
      async ({ sel, need, budgetMs }) => {
        const v = document.querySelector(sel) as HTMLVideoElement | null;
        if (!v) return { ok: false, reason: 'no element', played: 0, samples: 0, elapsedMs: 0, wraps: 0 };
        let acc = 0;
        let prev = v.currentTime;
        let samples = 1;
        let wraps = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < budgetMs) {
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const cur = v.currentTime;
          const d = cur - prev;
          if (d > 0) acc += d;
          else if (d < -0.5 && Number.isFinite(v.duration)) {
            acc += Math.max(0, v.duration - prev) + cur;
            wraps += 1;
          }
          if (cur !== prev) samples += 1;
          prev = cur;
          if (acc >= need && wraps > 0) {
            return { ok: true, played: acc, wraps, samples, elapsedMs: performance.now() - t0 };
          }
        }
        return { ok: false, played: acc, wraps, samples, elapsedMs: performance.now() - t0, currentTime: v.currentTime };
      },
      { sel: LAYER_VIDEO, need: ADVANCE_S, budgetMs: 20_000 },
    );
    expect(
      wrapped.ok && wrapped.wraps > 0,
      `wrap-crossing playback must accumulate ≥${ADVANCE_S}s THROUGH the loop boundary (wraps>0 required — ` +
        `this leg is the permanent instrument control for #1612). Got ${JSON.stringify(wrapped)}`,
    ).toBe(true);

    // The NODE still owns the bytes. This is the record Export reads.
    expect(
      await nodeMedia(page, NODE),
      'the collapse revoked the node-owned object url — this is the #1589 regression',
    ).toContainEqual(expect.objectContaining({ slot: `layer-video-${LAYER}`, hasUrl: true }));

    // ── RE-EXPAND: the card must not LIE about its state ────────────────────
    await expand(page);
    await expect(page.getByTestId('toybox-video-filename')).toHaveAttribute('data-has-local-file', 'true', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('toybox-video-relink')).toHaveCount(0);

    // ...and Export STILL writes the video, with no re-pick. Byte-for-byte the
    // same as the pre-collapse control: the bytes were never touched.
    const after = await exportAndRead(page);
    expect(after.videos.map((v) => v.layer), `post-collapse export carried no video: ${JSON.stringify(after)}`)
      .toEqual([LAYER]);
    expect(
      after.byteLengths[0],
      `post-collapse export must carry the same ${FIXTURE_BYTES} bytes as the control (${control.byteLengths[0]})`,
    ).toBe(FIXTURE_BYTES);
    await expect(page.getByTestId('toybox-preset-notice')).toContainText('+1 video', { timeout: 20_000 });

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('Export REFUSES, loudly, when a layer\'s bytes are not loaded in this session', async ({ page }) => {
    test.setTimeout(TEST_BUDGET_MS);
    // Independent of the lifetime fix: a reload, a localStorage preset (which
    // cannot hold video) and a rack-mate's synced layer all leave a FILENAME
    // with no bytes. Writing a zero-video zip and reporting success is the part
    // that destroys trust, so it must fail instead — and say which layer.
    const errors = await boot(page);
    await expand(page);
    await seedVideoLayer(page, { name: 'ghost.webm' });

    // The console admits it: name shown, bytes absent, and it says so.
    await expect(page.getByTestId('toybox-video-filename')).toHaveAttribute('data-has-local-file', 'false', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('toybox-video-relink')).toBeVisible({ timeout: 20_000 });

    // The preset store is the face's third tab; the layer band above is
    // persistent, which is why the two assertions before this one need no tab.
    await presetsTab(page);
    await page.locator('[data-testid="toybox-preset-export"]').first().dispatchEvent('click');

    const err = page.getByTestId('toybox-preset-error');
    await expect(err).toContainText('Export cancelled', { timeout: 20_000 });
    await expect(err).toContainText('ghost.webm');
    await expect(err, 'the refusal must name the layer the way the console labels it').toContainText('layer 1');
    // No success notice — the two must never both appear.
    await expect(page.getByTestId('toybox-preset-notice')).toHaveCount(0);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('NEGATIVE CONTROL: deleting the node DOES revoke the url and destroy the element', async ({ page }) => {
    test.setTimeout(TEST_BUDGET_MS);
    // Without this leg the test above would pass just as happily if the registry
    // simply never released anything — a leak, not a fix. This proves the sweep
    // still tears down, so "survives collapse" is a real discrimination.
    await boot(page);
    await expand(page);
    await seedVideoLayer(page);
    await loadFixture(page);

    // Capture the live blob url BEFORE the delete so revocation is provable
    // rather than inferred from an absence.
    const url = await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLVideoElement).currentSrc || (document.querySelector(sel) as HTMLVideoElement).getAttribute('src')!,
      LAYER_VIDEO,
    );
    expect(url, 'expected a blob: url on the layer element').toMatch(/^blob:/);
    // The url resolves NOW — the positive half of the revocation probe. Without
    // it, a fetch that fails after the delete proves nothing (it might never
    // have resolved).
    expect(
      await page.evaluate(async (u) => {
        try { return (await fetch(u)).ok; } catch { return false; }
      }, url),
      'the blob url must resolve BEFORE the delete, or the probe below is vacuous',
    ).toBe(true);

    // Remove the node from the graph — the ONE event that must tear this down.
    // `__patch` is the live store, so Canvas's sweep sees it exactly as it sees
    // a menu delete, a lasso delete, undo, Clear or a peer's CRDT delete.
    await page.evaluate((n) => {
      const g = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
      delete g.__patch.nodes[n];
    }, NODE);

    await expect.poll(async () => (await nodeMedia(page, NODE)).length, { timeout: 30_000 }).toBe(0);
    await expect(page.locator(LAYER_VIDEO)).toHaveCount(0, { timeout: 20_000 });
    expect(
      await page.evaluate(async (u) => {
        try { return (await fetch(u)).ok; } catch { return false; }
      }, url),
      'the object url outlived the node — it was never revoked (a leak)',
    ).toBe(false);
  });
});
