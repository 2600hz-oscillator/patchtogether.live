// e2e/tests/workflow-shell.spec.ts
//
// P0.3b — the WORKFLOW-SHELL legacy-fallback bridge, end to end. Proves the
// core day-one guarantee: under the `?shell=1` preview an UN-MIGRATED module
// renders a uniform styled PLACEHOLDER in its lane (cables stay attached), while
// its REAL, unchanged legacy card opens verbatim in the bottom dock full-view
// and is fully OPERABLE there (drive a control → the graph param changes).
//
// And the NO-OP guarantee: with the preview OFF (the default) the module renders
// its real card in the lane EXACTLY as today — the bridge is inert until owner
// sign-off, so nothing else in workflow mode changes.
//
// Runs on /rack?shell=legacy (no DB/relay) — the normal e2e lane, same as
// workflow-dock.spec.ts. Shell state is transient/local (never in the Y.Doc).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  AUDIO_OPERABLE_FIXTURE,
  AUDIO_PLACEHOLDER_FIXTURE,
  CONTRACT_MODULE_TYPES,
  DENIED,
  fixtureProblems,
  fixtureType,
} from './_face-fixtures';
import { BOOT_MS, PLACEHOLDER_PAINT_MS } from '../_helpers/boot-budget';

// Boot and first-paint waits are pure LATENCY BOUNDS, not behavior assertions
// (#1875 — this spec lost two main push runs in one day to flat ones). The
// bounds and the whole argument now live at ONE export site, imported above:
// ../_helpers/boot-budget.ts. They were declared locally here by #1898; the
// #1904 sweep found the same defect at twenty more sites, and a bound that is
// re-typed per spec is a bound that drifts — the reason frame waits have
// exactly one home too.

async function gotoWorkflow(page: Page, opts: { shell: boolean }): Promise<void> {
  await page.goto(opts.shell ? '/rack' : '/rack?shell=legacy');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible', timeout: BOOT_MS });
}

/** Read one node param through the dev __patch global. */
async function readParam(page: Page, nodeId: string, paramId: string): Promise<number | undefined> {
  return page.evaluate(
    ({ nodeId, paramId }) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch?.nodes?.[nodeId]?.params?.[paramId];
    },
    { nodeId, paramId },
  );
}

/** The node's WHOLE param map. The legacy-fallback test drives the docked
 *  card's first fader and asserts *some* param moved — module-agnostic, since
 *  the fixture module is derived (AUDIO_OPERABLE_FIXTURE / AUDIO_PLACEHOLDER_FIXTURE) rather than named,
 *  so no specific param id like delay's 'time' can be assumed. */
async function readParams(page: Page, nodeId: string): Promise<Record<string, number>> {
  return page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
    };
    return { ...(w.__patch?.nodes?.[nodeId]?.params ?? {}) };
  }, nodeId);
}

const NODE = 'v1';

// ── RACKLINE tile-geometry re-spec helpers ──────────────────────────────────
// channel-columns.ts geometry (kept in sync with the pure module).
const COLUMN_W = 765; // 34 * HP_UNIT(22.5)
const SHELL_COLUMN_W = 216; // channel-columns.ts SHELL_COLUMN_W (tight ?shell=1 pitch)
const SHELL_TILE_W = 192; // module-shell-model.ts SHELL_TILE_W / tokens --shell-tile-w
// The ONE fixed lane-slot height at EVERY LOD tier (zoom-reposition fix option
// (c)): module-shell-model.ts SHELL_TILE_H_SLOT / tokens --shell-tile-h. Zoom
// swaps only the CONTENT inside the box, never the box.
const SHELL_TILE_H_SLOT = 180;
// channel-columns.ts vertical geometry: RACK_UNIT 180 → COLUMN_SLOT_H 720 →
// COLUMN_H 4320 → the baseline the lanes bottom-anchor to; the video zone is the
// backdraft-tall (3u = 540px) band directly BELOW it.
const COLUMN_BASELINE_Y = 4320; // COLUMN_TOP_Y(0) + COLUMN_SLOT_H(720) * COLUMN_MAX_SLOTS(6)
const VIDEO_AREA_HEIGHT = 540; // RACK_UNIT(180) * 3
// `?shell=1` LANE HEADROOM rule (channel-columns.ts): the band top derives from
// the FULLEST stack; ≥ half a tile (90) of EMPTY band stays above its top tile,
// and every stack's BOTTOM edge floats half a tile (90) above the baseline so
// the lane-number badge renders fully visible below the bottom tile.
const SHELL_LANE_HEADROOM_Y = 90; // channel-columns.ts SHELL_LANE_HEADROOM_Y
const SHELL_BADGE_CLEARANCE_Y = 90; // channel-columns.ts SHELL_LANE_BADGE_CLEARANCE_Y
/** Flow-space top-left X that CENTERS the uniform 192px tile in column `ch`'s tight
 *  216px band (columnCardX at the shell pitch) — the value the drop must persist. */
const shellColCardX = (ch: number) => (ch - 1) * SHELL_COLUMN_W + (SHELL_COLUMN_W - SHELL_TILE_W) / 2;

/** A flow-space spawn anchor inside channel column `ch`'s painted band. X selects
 *  the column; Y must land in the band `[laneTopY, COLUMN_BASELINE_Y)` — the drop
 *  hit-test is 2-D (laneTargetForFlowPoint), so an anchor above the lanes is free
 *  canvas. Just above the baseline is in-band at every lane height. */
const LANE_ANCHOR_Y = COLUMN_BASELINE_Y - 40;
function colPos(ch: number): { x: number; y: number } {
  return { x: (ch - 1) * COLUMN_W + 60, y: LANE_ANCHOR_Y };
}

/** Wait until the Canvas dev spawn/viewport hooks are registered. */
async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __setSpawnFlowPos?: unknown; __spawnFromPalette?: unknown; __flow?: unknown };
      return typeof w.__setSpawnFlowPos === 'function' && typeof w.__spawnFromPalette === 'function' && !!w.__flow;
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** EVERY mounted lane tile — a migrated `module-shell` OR an un-migrated
 *  `module-shell-placeholder`. This is the population the geometry tests
 *  measure, so it is also the honest readiness signal for "the drop landed". */
function laneTiles(page: Page) {
  return page.locator('[data-testid="module-shell-placeholder"], [data-testid="module-shell"]');
}

/**
 * Run `spawn`, then wait until ONE MORE lane tile is mounted than before.
 *
 * Every drop in this spec used to be followed by a flat `waitForTimeout(250)`
 * — a wall-clock guess for "the spawn reached the DOM", which is a different
 * number of frames on every renderer (7.9 fps measured under
 * `E2E_SWIFTSHADER=1` against ~60 fps locally, before CI's ten-shard
 * contention). The subject was always the tile, so wait on the TILE:
 * `toHaveCount` auto-retries, returns the instant the drop lands, and still
 * fails loudly — naming the module and the lane — if it never does.
 */
async function dropAndSettle(page: Page, spawn: () => Promise<unknown>, what: string): Promise<void> {
  const before = await laneTiles(page).count();
  await spawn();
  await expect(laneTiles(page), `${what}: the palette drop mounted its lane tile`).toHaveCount(
    before + 1,
  );
}

/** Drive the REAL palette-drop path into channel column `ch`. */
async function dropInColumn(page: Page, type: string, ch: number): Promise<void> {
  await dropAndSettle(
    page,
    () =>
      page.evaluate(
        ({ type, pos }) => {
          const w = globalThis as unknown as {
            __setSpawnFlowPos: (p: { x: number; y: number }) => void;
            __spawnFromPalette: (t: string) => void;
          };
          w.__setSpawnFlowPos(pos);
          w.__spawnFromPalette(type);
        },
        { type, pos: colPos(ch) },
      ),
    `${type} → channel ${ch}`,
  );
}

/** UNSCALED layout metrics of every mounted shell/placeholder tile — offsetWidth/
 *  Height are immune to the xyflow viewport zoom transform, so they are the TRUE
 *  tile px + data-shell-tier. */
async function measureTiles(page: Page): Promise<{ node: string | null; tier: string | null; w: number; h: number }[]> {
  return page.evaluate(() => {
    const tiles = Array.from(
      document.querySelectorAll('[data-testid="module-shell-placeholder"], [data-testid="module-shell"]'),
    ) as HTMLElement[];
    return tiles.map((t) => ({
      node: t.getAttribute('data-shell-node'),
      tier: t.getAttribute('data-shell-tier'),
      w: t.offsetWidth,
      h: t.offsetHeight,
    }));
  });
}

/** Set the viewport ZOOM (keeps pan) and wait for the LOD tier to settle to the
 *  expected string on every tile. Programmatic setViewport publishes the zoom to
 *  the shared LOD store, so the tiles re-key their data-shell-tier + height. */
async function setZoomTier(page: Page, zoom: number, expectTier: string): Promise<void> {
  await page.evaluate((zoom) => {
    const f = (globalThis as any).__flow;
    const vp = f.getViewport();
    f.setViewport({ x: vp.x, y: vp.y, zoom }, { duration: 0 });
  }, zoom);
  await page.waitForFunction(
    (tier) => {
      const tiles = Array.from(document.querySelectorAll('[data-shell-tier]'));
      return tiles.length > 0 && tiles.every((t) => t.getAttribute('data-shell-tier') === tier);
    },
    expectTier,
    { timeout: 10_000 },
  );
}

// ── THE AUDIO FIXTURE IS HEALTHY (#1789, #1864) ─────────────────────────────
//
// The derivation resolving to nothing used to THROW AT IMPORT, which is help
// that arrives too late and in the wrong place: by then every spec importing
// `_face-fixtures.ts` is failing before it runs a line, including the ones with
// a perfectly good fixture of their own. Resolution is now a VALUE, and this is
// where the audio half's value is checked — one named test, in the suite that
// would lose its subject.
//
// `fixtureProblems` carries the checks (pick ∈ pool, `pool ∪ rejections ===
// unpromoted`, and slack), so the audio and video gates cannot drift apart.
test('the derived audio legacy-fallback fixtures are healthy', () => {
  expect(fixtureProblems(AUDIO_PLACEHOLDER_FIXTURE), AUDIO_PLACEHOLDER_FIXTURE.why).toEqual([]);
  expect(fixtureProblems(AUDIO_OPERABLE_FIXTURE), AUDIO_OPERABLE_FIXTURE.why).toEqual([]);

  // ── THE INSTRUMENT'S PERMANENT NEGATIVE CONTROL, BOTH DIRECTIONS (#2137) ──
  //
  // This replaced the `pool.length <= 1` slack floor, which was a population
  // threshold sitting with ZERO slack on the live population (the audio pool
  // held two members; it tripped at one) — CLAUDE.md's named ratchet hazard.
  // What the floor protected ("the next promotion is survivable") became
  // unconditionally true when an emptied pool started degrading to a NAMED SKIP
  // instead of a red fixture defect, so the mechanism is DELETED rather than
  // re-tuned and this control replaces it.
  //
  // ⚠ IT CALLS THE PREDICATE UNDER TEST, NOT A PARAPHRASE OF IT. `probe` is the
  // exact closure `deriveFixture` ran; a re-implementation here could agree with
  // a broken predicate and certify it.
  for (const [name, f] of [
    ['AUDIO_PLACEHOLDER', AUDIO_PLACEHOLDER_FIXTURE],
    ['AUDIO_OPERABLE', AUDIO_OPERABLE_FIXTURE],
  ] as const) {
    // POSITIVE — the predicate still ACCEPTS things. A predicate that accepts
    // nothing anywhere is broken, and it is broken in the direction that LOOKS
    // like a finished migration: this is the leg that catches the `<Fader>` →
    // `<NeonFader>` rename class, which once would have rejected every
    // candidate at once and emptied the pool for a reason that is not the tree.
    expect(
      f.eligible.length,
      `${name}: the fitness predicate accepts NOTHING across the whole audio population — ` +
        'it went blind, and a blind predicate reports the end of the migration',
    ).toBeGreaterThan(0);

    // NEGATIVE — and it still REFUSES things, by name and with a reason. A
    // predicate that accepts everything is equally blind, and it fails green.
    expect(
      f.probe('clipplayer'),
      `${name}: clipplayer is a NON_SHELL_LANE_TYPES snowflake — laneRenderKind returns ` +
        "'legacy' for it, so it renders no placeholder tile and must be refused",
    ).not.toBeNull();
    expect(
      f.probe('__no_such_module__'),
      `${name}: a type the golden has never heard of must be refused, not resolved`,
    ).not.toBeNull();
  }


  // ANCHORED TO THE ARTIFACT: a deny entry naming a module the contract golden
  // does not know is a licence nobody is watching — the module was renamed or
  // deleted and the exclusion silently stopped excluding anything. Checked here
  // for the WHOLE map (both domains share it), so a video entry is anchored too.
  expect(
    Object.keys(DENIED).filter((t) => !CONTRACT_MODULE_TYPES.includes(t)),
    'these DENIED entries name modules that are not in contract-lock.txt (renamed? deleted?)',
  ).toEqual([]);
  // …and every reason is a REASON, not a shrug.
  for (const [type, why] of Object.entries(DENIED)) {
    expect(why.length, `DENIED.${type}: an exclusion without evidence is a guess`).toBeGreaterThan(40);
  }
});

test.describe('P0.3b workflow-shell legacy-fallback bridge', () => {
  test('un-migrated module → placeholder in lane + legacy card operable in the dock', async ({ page }) => {
    // A still-UN-migrated module, DERIVED from STRICT_FACES rather than named:
    // a hard-coded fixture rots as each P1 wave promotes more modules (vca was
    // consumed by batch 1, delay by batch 3 — both turned this red for a
    // non-bug). See AUDIO_OPERABLE_FIXTURE in _face-fixtures.ts.
    //
    // When every audio module is promoted this case has no subject BY DESIGN —
    // a NAMED skip carrying the reason, never a silent pass (#1864).
    test.skip(AUDIO_OPERABLE_FIXTURE.kind === 'migration-complete', AUDIO_OPERABLE_FIXTURE.why);
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [
      { id: NODE, type: fixtureType(AUDIO_OPERABLE_FIXTURE), position: { x: 460, y: 240 } },
    ]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    await expect(laneNode).toHaveCount(1);

    // 1) The lane shows the UNIFORM PLACEHOLDER — not the legacy vca card.
    const placeholder = laneNode.locator('[data-testid="module-shell-placeholder"]');
    await expect(placeholder).toBeVisible();
    // No legacy controls in the lane (they moved to the dock):
    await expect(laneNode.locator('[data-testid^="control-"]')).toHaveCount(0);
    // Cables stay attached: the node keeps its full invisible handle stack.
    await expect(laneNode.locator('.svelte-flow__handle').first()).toHaveCount(1);

    // 2) Open in dock (the jack-rail "⤢" expand) → the RACKLINE full-view
    //    FACEPLATE opens in the bottom drawer (NOT a generic .dock-card).
    await placeholder.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    // The spec chrome: grip, title bar (badge + name + mono sub), the window-
    // control trio (collapse + close in P0.3b; undock omitted), the tab-rail
    // seam with a single "MODULE" tab, and the domain-classed faceplate frame.
    await expect(faceplate.getByTestId('faceplate-grip')).toBeVisible();
    await expect(faceplate.locator('.faceplate-bar .face-badge')).toBeVisible();
    await expect(faceplate.locator('.faceplate-bar .face-name')).toBeVisible();
    // The mono sub reads "<module label> · lane N" — assert the "lane" descriptor.
    await expect(faceplate.locator('.faceplate-bar .face-sub')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-close')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-collapse')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-tab')).toHaveText('MODULE');
    // The plate carries the module's DERIVED domain class.
    //
    // ⚠ THIS USED TO BE A HARD-CODED `.faceplate.audio` (#2137), and the
    // hard-coding was not cosmetic — it was the whole reason the audio fixture
    // carried a "must be audio-class" predicate that rejected 31 of 38
    // un-promoted candidates and shrank the pool to two. Deriving the class
    // instead makes this leg STRICTER, not looser: it now proves the plate
    // carries the RIGHT class for whatever subject the derivation handed it,
    // rather than proving one class for a subject filtered to have it. The
    // widening immediately changed the answer — today's pick is gate-class, so
    // `.faceplate.audio` would now be simply WRONG.
    const domainClass = AUDIO_OPERABLE_FIXTURE.kind === 'ok' ? AUDIO_OPERABLE_FIXTURE.domainClass : null;
    expect(domainClass, 'the operable fixture must resolve a determinate domain class').not.toBeNull();
    await expect(
      faceplate.locator(`.faceplate.${domainClass}`),
      `${fixtureType(AUDIO_OPERABLE_FIXTURE)}: the dock plate carries its derived domain class (.faceplate.${domainClass})`,
    ).toHaveCount(1);

    // …and the REAL, unchanged legacy card mounts verbatim in .editor at native
    //  scale (carrying the data-dock-card anchor so PickupCable/patch-menu work).
    const dockCard = faceplate.getByTestId('faceplate-editor').locator(`[data-dock-card="${NODE}"]`);
    await expect(dockCard).toBeVisible();
    await expect(dockCard.locator('.mod-card, .card, .moog-panel').first()).toBeVisible();
    // The faceplate hosts NO xyflow handles / node wrappers (PatchPanel self-gates):
    await expect(faceplate.locator('.svelte-flow__handle')).toHaveCount(0);
    await expect(faceplate.locator('.svelte-flow__node')).toHaveCount(0);

    // 3) The lane placeholder STILL shows (Option #1: lane face + dock faceplate
    //    coexist — the module was never persist-docked / swapped to a stub).
    await expect(placeholder).toBeVisible();
    await expect(laneNode.locator('[data-testid="dock-stub"]')).toHaveCount(0);

    // 4) Drive a control in the mounted card → the graph params change
    //    (operable). Module-AGNOSTIC: the fixture is derived, so we diff the
    //    whole param map rather than naming one id.
    const before = await readParams(page, NODE);
    const track = dockCard.locator('.fader-wrap .track').first();
    // ⚠ SCROLL IT INTO VIEW BEFORE MEASURING, and this is a REAL FIX rather than
    // defensive noise (#2137). This leg drives raw `page.mouse` at coordinates
    // from `boundingBox()`, which reports where an element IS — including when
    // it is scrolled outside the dock's clipped viewport. The pointer then lands
    // on whatever actually occupies those screen coordinates, the drag commits
    // nothing, and the failure reads as "this card is not operable" rather than
    // "the test never touched it".
    //
    // It was latent for as long as the fixture happened to resolve SHORT cards.
    // The derivation now offers `modtris`, whose card is a game board with its
    // two faders far below the fold, and the leg failed with an empty param map
    // — the card mounted correctly and both sliders were present in the
    // accessibility tree. That is a defect in the LEG, not evidence against the
    // candidate, so the fix belongs here and not in a `DENIED` entry: denying
    // the module would have hidden a fragility that the next tall card hits
    // again.
    await track.scrollIntoViewIfNeeded();
    const box = await track.boundingBox();
    expect(box, 'a fader track should be present in the docked card').toBeTruthy();
    if (!box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // The grab lands on the track's MIDPOINT, so there is guaranteed travel in
    // both directions — a fixed drag off a rail-parked fader is the
    // false-failure class faces-parity's dragKnob guards against.
    await page.mouse.move(cx, cy - 34, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => JSON.stringify(await readParams(page, NODE)), {
        message: `${fixtureType(AUDIO_OPERABLE_FIXTURE)}: driving the docked card's first fader commits a param change`,
      })
      .not.toBe(JSON.stringify(before));

    // 5) ESC closes the full-view faceplate; the placeholder remains in the lane.
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(placeholder).toBeVisible();
  });

  test('placeholder tiles are UNIFORM WIDTH + the FIXED slot height with a consistent badge anchor', async ({ page }) => {
    // The owner "same-size all modules HORIZONTALLY" + "tiles non-uniform / smaller
    // than the mock" fix: under ?shell=1 the tile-swapped video-zone defaults
    // (recorderbox 2u, synesthesia 3u — DIFFERENT rack tiers, so different
    // LEGACY widths) render as the SAME uniform RACKLINE tile — identical WIDTH
    // (SHELL_TILE_W) and the ONE fixed slot HEIGHT (SHELL_TILE_H_SLOT —
    // tier-invariant, the zoom-reposition fix), so the baseline number badges
    // cap them flush. (videoOut is EXEMPT since the video-visibility fix — a
    // NON_SHELL video-surface snowflake whose real resizable card stays in the
    // lane; covered by workflow-shell-video.spec.ts.)
    await gotoWorkflow(page, { shell: true });
    const ids = ['workflow-recorderbox', 'workflow-synesthesia'];
    for (const id of ids) {
      await expect(
        page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`),
      ).toBeVisible({ timeout: PLACEHOLDER_PAINT_MS });
    }

    const metrics = await page.evaluate((nodeIds) => {
      return nodeIds.map((id) => {
        const tile = document.querySelector(
          `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`,
        ) as HTMLElement | null;
        const badge = tile?.querySelector('.tile-badge') as HTMLElement | null;
        if (!tile || !badge) return null;
        // offset* are UNSCALED layout px (immune to the xyflow viewport zoom
        // transform): the TRUE tile W/H + the badge's anchor within the tile.
        return { w: tile.offsetWidth, h: tile.offsetHeight, tier: tile.getAttribute('data-shell-tier'), badgeTop: badge.offsetTop };
      });
    }, ids);

    expect(metrics.every((m) => m !== null), 'all three placeholders resolved').toBe(true);
    // UNIFORM WIDTH — every tile the SAME SHELL_TILE_W across three rack tiers.
    for (const m of metrics) expect(m!.w).toBe(SHELL_TILE_W);
    // FIXED HEIGHT — every tile the ONE slot height regardless of the LOD tier.
    for (const m of metrics) expect(m!.h).toBe(SHELL_TILE_H_SLOT);
    // The badge sits at an IDENTICAL offset from each tile's top (the anchor no
    // longer floats mid-card because the tiles are uniform).
    const badgeTops = metrics.map((m) => m!.badgeTop);
    expect(Math.max(...badgeTops) - Math.min(...badgeTops)).toBeLessThanOrEqual(1);
  });

  test('column members are UNIFORM width + FLUSH-stacked (no overlap, no gap)', async ({ page }) => {
    // Stack a real source→fx chain in ONE channel column via the REAL palette-drop
    // path, then prove every tile is the SAME width/height AND the stack is flush
    // (each member's flow-space slot is exactly one tile-height above the next —
    // no overlap, no gap), so the reserved slot == the rendered tile at every zoom.
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);
    const types = ['tidyVco', 'vca', 'delay'];
    for (const t of types) {
      await dropInColumn(page, t, 1);
    }
    // Tiles mounted (tidyVco/vca render the migrated shell as of P1 batch 1;
    // delay + the video-zone trio stay placeholders).
    await expect(page.locator('[data-testid="module-shell-placeholder"]')).not.toHaveCount(0);
    await expect(page.locator('[data-testid="module-shell"]')).not.toHaveCount(0);

    // Uniform width + height across every mounted tile.
    const tiles = await measureTiles(page);
    expect(tiles.length).toBeGreaterThanOrEqual(types.length);
    expect(new Set(tiles.map((t) => t.w)).size, 'one uniform width').toBe(1);
    expect(tiles[0].w).toBe(SHELL_TILE_W);
    expect(new Set(tiles.map((t) => t.h)).size, 'one uniform height').toBe(1);

    // FLUSH stacking: the ch1 members' flow-space TOP-Y are exactly one measured
    // tile-height apart (immune to the viewport transform) — no overlap, no gap.
    const stack = await page.evaluate(() => {
      const f = (globalThis as any).__flow;
      const patch = (globalThis as any).__patch;
      const out: { y: number; h: number }[] = [];
      for (const nid of Object.keys(patch.nodes)) {
        if (patch.nodes[nid]?.data?.channel !== 1) continue;
        const inode = f.getInternalNode(nid);
        const y = inode?.internals?.positionAbsolute?.y ?? inode?.position?.y;
        const h = inode?.measured?.height;
        if (typeof y === 'number' && typeof h === 'number') out.push({ y, h });
      }
      return out.sort((a, b) => a.y - b.y);
    });
    expect(stack.length).toBe(types.length);
    for (let i = 1; i < stack.length; i++) {
      const gap = stack[i].y - stack[i - 1].y;
      // gap == the previous tile's height → tiles ABUT: no overlap (gap ≥ h) AND
      // no empty space (gap ≤ h). ±1px for sub-pixel rounding.
      expect(gap).toBeGreaterThanOrEqual(stack[i - 1].h - 1);
      expect(gap).toBeLessThanOrEqual(stack[i - 1].h + 1);
    }
  });

  test('lanes are the TIGHT ~216px shell pitch: drops land in the narrowed column + tiles fill the lane with no overlap', async ({ page }) => {
    // The RACKLINE narrowing: under ?shell=1 the app-scale 765px band collapses to
    // the mock's tight 216px lane pitch, so the uniform 192px tiles FILL their
    // lanes (24px gutter) instead of floating in huge gutters. Prove (a) a real
    // palette drop lands in the correct NARROWED column via the pitch-aware
    // hit-test, (b) the rendered column pitch is ~216px, and (c) tiles don't
    // overlap (clean gutter).
    const SHELL_COLUMN_W = 216;
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);

    // Anchor each spawn INSIDE the narrow band of columns 1..3 (X selects the
    // column at the tight pitch — the same frame the rendered lanes live in).
    const shellColPos = (ch: number) => ({ x: (ch - 1) * SHELL_COLUMN_W + 30, y: LANE_ANCHOR_Y });
    const types = ['tidyVco', 'vca', 'delay'];
    for (let i = 0; i < types.length; i++) {
      await dropAndSettle(
        page,
        () =>
          page.evaluate(
            ({ type, pos }) => {
              const w = globalThis as unknown as {
                __setSpawnFlowPos: (p: { x: number; y: number }) => void;
                __spawnFromPalette: (t: string) => void;
              };
              w.__setSpawnFlowPos(pos);
              w.__spawnFromPalette(type);
            },
            { type: types[i], pos: shellColPos(i + 1) },
          ),
        `${types[i]} → narrowed column ${i + 1}`,
      );
    }

    // (a) Each drop landed in the intended narrowed column: channels 1, 2, 3 each
    //     hold exactly one member (the pitch-aware hit-test resolved the column).
    const counts = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
      };
      const cols = w.__patch.nodes['pinned-mixmstrs']?.data?.columns ?? {};
      return [1, 2, 3].map((ch) => (cols[String(ch)] ?? []).length);
    });
    expect(counts, 'each drop joined its own narrowed column').toEqual([1, 1, 1]);

    // (b)+(c) Read the RENDERED flow-space X + tile width of each column head.
    const tiles = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __flow: { getInternalNode: (id: string) => { internals?: { positionAbsolute?: { x: number } }; position?: { x: number } } | undefined };
        __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
      };
      const cols = w.__patch.nodes['pinned-mixmstrs']?.data?.columns ?? {};
      const out: { ch: number; x: number; w: number }[] = [];
      for (const ch of [1, 2, 3]) {
        const id = (cols[String(ch)] ?? [])[0];
        if (!id) continue;
        const inode = w.__flow.getInternalNode(id);
        const x = inode?.internals?.positionAbsolute?.x ?? inode?.position?.x ?? NaN;
        const el = document.querySelector(
          `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"], .svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`,
        ) as HTMLElement | null;
        out.push({ ch, x, w: el?.offsetWidth ?? 0 });
      }
      return out;
    });
    expect(tiles.length).toBe(3);

    // (b) Consecutive column heads are ~SHELL_COLUMN_W (216px) apart — the tight
    //     pitch (NOT the old 765px). ±1px for sub-pixel rounding.
    for (let i = 1; i < tiles.length; i++) {
      const delta = tiles[i].x - tiles[i - 1].x;
      expect(delta, `column ${tiles[i - 1].ch}→${tiles[i].ch} pitch ≈ ${SHELL_COLUMN_W}`).toBeGreaterThanOrEqual(SHELL_COLUMN_W - 1);
      expect(delta).toBeLessThanOrEqual(SHELL_COLUMN_W + 1);
    }

    // (c) Every tile is the uniform SHELL_TILE_W (fills the lane), and tiles do
    //     NOT overlap: each tile's right edge sits left of the next tile's left
    //     edge (a clean gutter, no collision).
    for (const t of tiles) expect(t.w).toBe(SHELL_TILE_W);
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i - 1].x + tiles[i - 1].w, 'no horizontal overlap between adjacent tiles').toBeLessThanOrEqual(tiles[i].x + 1);
    }
  });

  test('zoom NEVER repositions tiles: fixed slot box at every LOD tier, positions byte-identical', async ({ page }) => {
    // The owner zoom-reposition fix (option (c)): the per-tier box height made
    // flush-stack Y positions cascade-shift at every tier boundary. Now the OUTER
    // slot box keeps ONE FIXED height (SHELL_TILE_H_SLOT) across tiers — only the
    // CONTENT inside the tile swaps (data-shell-tier still promotes mini →
    // compact → full) — so every node's flow position is BYTE-IDENTICAL across
    // zoom levels that cross BOTH tier boundaries (0.30 and 0.52).
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);
    for (const t of ['tidyVco', 'vca']) {
      await dropInColumn(page, t, 1);
    }
    await expect(page.locator('[data-testid="module-shell-placeholder"]')).not.toHaveCount(0);

    /** EVERY patch node's absolute flow-space position, keyed by id — the full
     *  layout, not just the ch1 stack (a cascade-shift anywhere must fail). */
    const snapshotPositions = () =>
      page.evaluate(() => {
        const f = (globalThis as any).__flow;
        const patch = (globalThis as any).__patch;
        const out: Record<string, { x: number; y: number }> = {};
        for (const id of Object.keys(patch.nodes)) {
          const inode = f.getInternalNode(id);
          const x = inode?.internals?.positionAbsolute?.x ?? inode?.position?.x;
          const y = inode?.internals?.positionAbsolute?.y ?? inode?.position?.y;
          if (typeof x === 'number' && typeof y === 'number') out[id] = { x, y };
        }
        return out;
      });

    const positionsByTier: Record<string, Record<string, { x: number; y: number }>> = {};
    for (const [zoom, tier] of [[0.25, 'mini'], [0.45, 'compact'], [0.7, 'full']] as const) {
      await setZoomTier(page, zoom, tier);
      const tiles = await measureTiles(page);
      // The CONTENT tier still promotes as you zoom in…
      expect(tiles.every((t) => t.tier === tier), `${tier}: every tile at the tier`).toBe(true);
      // …but the BOX never changes: uniform SHELL_TILE_W × the ONE fixed slot height.
      expect(new Set(tiles.map((t) => t.w)).size, `${tier}: uniform width`).toBe(1);
      expect(tiles[0].w, `${tier}: SHELL_TILE_W`).toBe(SHELL_TILE_W);
      for (const t of tiles) expect(t.h, `${tier}: fixed slot height`).toBe(SHELL_TILE_H_SLOT);
      positionsByTier[tier] = await snapshotPositions();
    }

    // BYTE-IDENTICAL node positions across all three zooms (both boundaries
    // crossed): zooming must never move a tile.
    expect(positionsByTier.compact, 'compact positions == mini positions').toEqual(positionsByTier.mini);
    expect(positionsByTier.full, 'full positions == mini positions').toEqual(positionsByTier.mini);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 2 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the tile header composition — domain-colour rule, gap, the FULL long name (not truncated) and the type badge on row 2; the identity a user reads a lane by.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('tile header: domain-colour rule ── gap ── FULL long name, type badge on row 2', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    // The owner tile-header redesign: the module NAME no longer shares its row
    // with the type badge (long names truncated as "RECORDE…"/"SYNESTH…"). Row 1
    // is a decorative 2px RULE in the DOMAIN colour (the spine/cable hue) from
    // the tile's LEFT edge, vertically centred on the name text, stopping at a
    // set gap BEFORE the name; the NAME then takes the full remaining width. The
    // faint uppercase type badge moved DOWN to row 2.
    await gotoWorkflow(page, { shell: true });
    const ids = ['workflow-recorderbox', 'workflow-synesthesia'];
    for (const id of ids) {
      await expect(
        page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`),
      ).toBeVisible({ timeout: PLACEHOLDER_PAINT_MS });
    }
    // The compact tier (the truncation report's tier) — the tile is 192px wide.
    await setZoomTier(page, 0.45, 'compact');

    const metrics = await page.evaluate((nodeIds) => {
      return nodeIds.map((id) => {
        const tile = document.querySelector(
          `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`,
        ) as HTMLElement | null;
        const rule = tile?.querySelector('.tile-rule') as HTMLElement | null;
        const name = tile?.querySelector('.tile-name') as HTMLElement | null;
        const badge = tile?.querySelector('.tile-badge') as HTMLElement | null;
        const spine = tile?.querySelector('.rl-spine') as HTMLElement | null;
        if (!tile || !rule || !name || !badge || !spine) return null;
        // offset*/scroll*/client* are UNSCALED layout px (immune to the xyflow
        // zoom transform). offsetParent for all of these is the relative .rl-tile.
        return {
          id,
          tileW: tile.offsetWidth,
          nameText: (name.textContent ?? '').trim(),
          nameScrollW: name.scrollWidth,
          nameClientW: name.clientWidth,
          ruleLeft: rule.offsetLeft,
          ruleW: rule.offsetWidth,
          ruleH: rule.offsetHeight,
          ruleCenterY: rule.offsetTop + rule.offsetHeight / 2,
          nameLeft: name.offsetLeft,
          nameCenterY: name.offsetTop + name.offsetHeight / 2,
          nameTop: name.offsetTop,
          badgeTop: badge.offsetTop,
          ruleBg: getComputedStyle(rule).backgroundColor,
          spineBg: getComputedStyle(spine).backgroundColor,
        };
      });
    }, ids);

    expect(metrics.every((m) => m !== null), 'both long-name placeholders resolved').toBe(true);
    for (const m of metrics) {
      // (b) the FULL long name renders — no ellipsis: the auto-namer's bare
      // prefix (RECORDERBOX / SYNESTHESIA) fits the 192px tile un-truncated.
      expect(m!.nameText, `${m!.id}: the full long name is present`).toMatch(/^(RECORDERBOX|SYNESTHESIA)$/);
      expect(m!.nameScrollW, `${m!.id}: name does not overflow (no …)`).toBeLessThanOrEqual(m!.nameClientW);
      // (c) the decorative rule: 2px thick, DOMAIN colour (== the spine hue),
      // from the tile's LEFT edge, with a clean set gap BEFORE the name.
      expect(m!.ruleH, `${m!.id}: 2px rule`).toBe(2);
      expect(m!.ruleLeft, `${m!.id}: rule starts at the tile's left edge`).toBe(0);
      expect(m!.ruleW, `${m!.id}: rule has real length`).toBeGreaterThan(0);
      expect(m!.ruleBg, `${m!.id}: rule is the DOMAIN colour (spine hue)`).toBe(m!.spineBg);
      const gap = m!.nameLeft - (m!.ruleLeft + m!.ruleW);
      expect(gap, `${m!.id}: set gap between rule and name (~9px)`).toBeGreaterThanOrEqual(6);
      expect(gap, `${m!.id}: set gap between rule and name (~9px)`).toBeLessThanOrEqual(14);
      // …vertically aligned with the middle of the name text (±2px rounding).
      expect(Math.abs(m!.ruleCenterY - m!.nameCenterY), `${m!.id}: rule centred on the name`).toBeLessThanOrEqual(2);
      // The type badge moved DOWN to a second row under the name.
      expect(m!.badgeTop, `${m!.id}: badge sits on a row BELOW the name`).toBeGreaterThan(m!.nameTop + 8);
    }
  });

  test('preview OFF (default) is a strict no-op: the legacy card renders in the lane', async ({ page }) => {
    await gotoWorkflow(page, { shell: false });
    await spawnPatch(page, [{ id: NODE, type: 'vca', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    await expect(laneNode).toHaveCount(1);
    // The REAL card + its controls render in the lane, exactly as today.
    await expect(laneNode.locator('[data-testid="control-base"]')).toBeVisible();
    // …and NO placeholder is emitted.
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
  });
});

// ─── P0.3b ?shell=1 bug fixes (video-zone inset · lane-snap · expand button) ──
test.describe('P0.3b workflow-shell ?shell=1 bug fixes', () => {
  const VZONE_IDS = ['workflow-videoOut', 'workflow-recorderbox', 'workflow-synesthesia'];

  /** The video-zone default's LANE FACE under the shell.
   *
   *  ⚠ videoOut renders a PROMOTED FACE TILE now (#1821). This used to special-
   *  case it to `[data-testid="video-out-card"]` — its verbatim LEGACY card,
   *  because it was a NON_SHELL video-surface snowflake — and the special case
   *  is gone: it is a `module-shell` like any faced module, while
   *  recorderbox/synesthesia are still un-migrated placeholders. */
  const vzFaceSelector = (id: string) =>
    id === 'workflow-videoOut'
      ? `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`
      : `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`;

  /** Drop `type` at the tight SHELL pitch so the pitch-aware hit-test resolves the
   *  intended narrowed column `ch` (the wide COLUMN_W anchor would land elsewhere). */
  async function dropInShellColumn(page: Page, type: string, ch: number): Promise<void> {
    await dropAndSettle(
      page,
      () =>
        page.evaluate(
          ({ type, pos }) => {
            const w = globalThis as unknown as {
              __setSpawnFlowPos: (p: { x: number; y: number }) => void;
              __spawnFromPalette: (t: string) => void;
            };
            w.__setSpawnFlowPos(pos);
            w.__spawnFromPalette(type);
          },
          { type, pos: { x: (ch - 1) * SHELL_COLUMN_W + 30, y: LANE_ANCHOR_Y } },
        ),
      `${type} → shell column ${ch}`,
    );
  }

  /** Flow-space top-left of a node (immune to the xyflow viewport transform). */
  async function flowPos(page: Page, id: string): Promise<{ x: number; y: number; h: number } | null> {
    return page.evaluate((id) => {
      const f = (globalThis as any).__flow;
      const n = f?.getInternalNode(id);
      if (!n) return null;
      const x = n.internals?.positionAbsolute?.x ?? n.position?.x;
      const y = n.internals?.positionAbsolute?.y ?? n.position?.y;
      const h = n.measured?.height ?? 0;
      return typeof x === 'number' && typeof y === 'number' ? { x, y, h } : null;
    }, id);
  }

  // BUG 1 — the video-zone default tiles used to anchor their TOP flush on
  // COLUMN_BASELINE_Y (== the zone's dashed top edge / "VIDEO" label), so the top
  // jack rail straddled the line + collided with the lane-number badges. The shell
  // render override now insets them DOWN, fully inside the darker video area.
  test('video-zone tiles sit INSIDE the video area (below COLUMN_BASELINE_Y)', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    for (const id of VZONE_IDS) {
      await expect(page.locator(vzFaceSelector(id))).toBeVisible({ timeout: 15_000 });
    }
    for (const id of VZONE_IDS) {
      const p = await flowPos(page, id);
      expect(p, `${id} internal node resolved`).not.toBeNull();
      // TOP strictly BELOW the baseline (the dashed video line) — pre-fix it sat
      // exactly ON it (p.y === COLUMN_BASELINE_Y). ±1px sub-pixel tolerance.
      expect(p!.y, `${id} tile top is below the video-zone baseline`).toBeGreaterThan(COLUMN_BASELINE_Y + 1);
      // …and the whole tile stays INSIDE the 540px video area (top well within it).
      expect(p!.y, `${id} tile top is inside the video area`).toBeLessThan(COLUMN_BASELINE_Y + VIDEO_AREA_HEIGHT);
    }
  });

  // BUG 2 — a palette drop into a lane persisted its X at the WIDE 765px slot
  // (columnFlushPositions with no pitch), while the render override used the tight
  // 216px pitch — so for the frame before the override snapped it, the tile landed
  // far right of the lane ("off-lane"). The persisted X now uses the active pitch,
  // so persisted + rendered both equal the tight column centre, flush-stacked.
  test('a lane drop persists + renders at the tight column centre, flush-stacked, no invalid state', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);
    for (const t of ['tidyVco', 'vca']) {
      await dropInShellColumn(page, t, 1);
    }

    // No invalid state: both drops joined channel 1's order (the membership truth).
    const order = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
      };
      return w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [];
    });
    expect(order.length, 'both modules joined channel 1').toBe(2);

    // PERSISTED position (the BUG-2 regression): each member's stored top-left X is
    // the TIGHT column-card X (12px), NOT the wide 765-band value (286.5) it was.
    const persisted = await page.evaluate((ids) => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { position?: { x: number } } | undefined> } };
      return ids.map((id) => w.__patch.nodes[id]?.position?.x ?? NaN);
    }, order);
    for (const x of persisted) expect(Math.abs(x - shellColCardX(1)), `persisted X == tight column-card X (${shellColCardX(1)})`).toBeLessThanOrEqual(1);

    // RENDERED position: same tight X, and the tile CENTRE lands on the column band
    // centre (card-centre == channel-number centre) — the "renders at the column
    // centre" guarantee.
    const bandCenter = (1 - 1) * SHELL_COLUMN_W + SHELL_COLUMN_W / 2; // 108
    const tiles: { x: number; y: number; h: number }[] = [];
    for (const id of order) {
      const p = await flowPos(page, id);
      expect(p, `${id} internal node resolved`).not.toBeNull();
      expect(Math.abs(p!.x - shellColCardX(1)), 'rendered X == tight column-card X').toBeLessThanOrEqual(1);
      expect(Math.abs(p!.x + SHELL_TILE_W / 2 - bandCenter), 'tile centre == column band centre').toBeLessThanOrEqual(1);
      tiles.push(p!);
    }

    // FLUSH stack (no overlap, no gap): the two members' flow-space tops are exactly
    // one measured tile-height apart.
    tiles.sort((a, b) => a.y - b.y);
    const gap = tiles[1].y - tiles[0].y;
    expect(gap).toBeGreaterThanOrEqual(tiles[0].h - 1);
    expect(gap).toBeLessThanOrEqual(tiles[0].h + 1);
  });

  // BUG 3 — the "open full module in the dock" affordance was a tiny faint glyph-
  // only button (undiscoverable). It is now a clear, LABELLED pill; the wired path
  // (onExpand → dockStore.openFullView → the .dock-faceplate full view) is unchanged.
  test('the EXPAND affordance is a labelled button that opens the dock faceplate + ESC closes', async ({ page }) => {
    // A still-UN-migrated module (DERIVED — see AUDIO_PLACEHOLDER_FIXTURE), so
    // this stays the PLACEHOLDER's expand path; the migrated shell's expand is
    // covered by workflow-shell-faces.spec.ts.
    //
    // ⚠ THE **PLACEHOLDER** FIXTURE, NOT THE OPERABLE ONE (#2137). This leg
    // clicks a pill and presses ESC; it never drives a control and never reads
    // the plate's domain class, so requiring its subject's legacy card to mount
    // a fader was a requirement borrowed from a different test. Sharing one
    // fixture meant the strictest leg's predicates silenced this one too.
    test.skip(AUDIO_PLACEHOLDER_FIXTURE.kind === 'migration-complete', AUDIO_PLACEHOLDER_FIXTURE.why);
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [
      { id: NODE, type: fixtureType(AUDIO_PLACEHOLDER_FIXTURE), position: { x: 460, y: 240 } },
    ]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    const placeholder = laneNode.locator('[data-testid="module-shell-placeholder"]');
    await expect(placeholder).toBeVisible();

    const expandBtn = placeholder.getByTestId('shell-open-dock');
    await expect(expandBtn).toBeVisible();
    // DISCOVERABILITY: the button carries a readable text LABEL (not a bare glyph),
    // so it reads as a clear "expand" action.
    await expect(expandBtn).toContainText('EXPAND');

    // The wired full path still works: click → the RACKLINE .dock-faceplate opens.
    await expandBtn.click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    await expect(faceplate).toHaveClass(/dock-faceplate/);

    // ESC closes it; the lane placeholder remains.
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(placeholder).toBeVisible();
  });

  // BUG 4 — port-heavy tiles overflowed the fixed 192px rail: synesthesia's 8
  // preview dots (4 in + 4 out) pushed the labelled EXPAND pill 43px past the
  // tile's right edge (label clipped to "EXPA…") and flex-collapsed the .flow
  // label to 0 width. The rail now FITS the tile at ANY port count with the
  // precedence EXPAND pill > jack dots > flow label: surplus dots collapse
  // into the mock's own "···" overflow treatment, which is part of the same
  // drill-down trigger (the menu lists every port — nothing is lost).
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 2 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: that a port-heavy module's rail FITS its fixed tile — EXPAND stays fully visible and surplus ports collapse into a '···' that opens the drill-down instead of overflowing the tile.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('port-heavy rail FITS the tile: EXPAND fully visible, surplus dots collapse into "···" that opens the drill-down', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    const tile = page.locator(
      '.svelte-flow__node[data-id="workflow-synesthesia"] [data-testid="module-shell-placeholder"]',
    );
    await expect(tile).toBeVisible({ timeout: 15_000 });
    const expand = tile.getByTestId('shell-open-dock');
    await expect(expand).toBeVisible();

    // The fit settles once the ResizeObserver measurements land: the rail's
    // content no longer overflows its box (pre-fix: scrollWidth 215 > 190).
    await page.waitForFunction(() => {
      const r = document.querySelector(
        '.svelte-flow__node[data-id="workflow-synesthesia"] [data-testid="lane-jack-rail"]',
      );
      return !!r && r.scrollWidth <= r.clientWidth;
    });

    // EXPAND pill FULLY inside the tile (screen space): both edges contained.
    const tileBox = await tile.boundingBox();
    const expandBox = await expand.boundingBox();
    expect(tileBox, 'tile bounding box resolved').toBeTruthy();
    expect(expandBox, 'EXPAND bounding box resolved').toBeTruthy();
    expect(expandBox!.x, 'EXPAND left edge inside the tile').toBeGreaterThanOrEqual(tileBox!.x - 0.5);
    expect(
      expandBox!.x + expandBox!.width,
      'EXPAND right edge inside the tile (pre-fix: 43px past it)',
    ).toBeLessThanOrEqual(tileBox!.x + tileBox!.width + 0.5);

    // UNSCALED layout metrics (immune to the xyflow zoom transform).
    const m = await page.evaluate(() => {
      const tile = document.querySelector(
        '.svelte-flow__node[data-id="workflow-synesthesia"] [data-testid="module-shell-placeholder"]',
      ) as HTMLElement;
      const rail = tile.querySelector('[data-testid="lane-jack-rail"]') as HTMLElement;
      const expand = tile.querySelector('[data-testid="shell-open-dock"]') as HTMLElement;
      const flow = rail.querySelector('.flow') as HTMLElement | null;
      // .more's offsetParent is the relative .rl-tile → offsetLeft is tile-relative.
      return {
        tileW: tile.offsetWidth,
        railScrollW: rail.scrollWidth,
        railClientW: rail.clientWidth,
        expandRight: expand.offsetLeft + expand.offsetWidth,
        expandScrollW: expand.scrollWidth,
        expandClientW: expand.clientWidth,
        dots: rail.querySelectorAll('.jk').length,
        hasOverflow: !!rail.querySelector('[data-testid="rail-overflow"]'),
        flowW: flow ? flow.offsetWidth : null,
      };
    });
    expect(m.railScrollW, 'rail content fits — no horizontal overflow/clip').toBeLessThanOrEqual(m.railClientW);
    expect(m.expandRight, 'EXPAND right edge ≤ tile width (unscaled)').toBeLessThanOrEqual(m.tileW);
    expect(m.expandScrollW, 'the EXPAND label itself is not clipped').toBeLessThanOrEqual(m.expandClientW);
    // Only a FITTING SUBSET of synesthesia's 8 preview dots renders; the
    // surplus is collapsed into the "···" affordance.
    expect(m.dots, 'some jack dots still preview').toBeGreaterThan(0);
    expect(m.dots, 'surplus dots were collapsed').toBeLessThan(8);
    expect(m.hasOverflow, 'the "···" overflow affordance renders').toBe(true);
    // The flow label either renders READABLY or is dropped (fit precedence) —
    // never the pre-fix 0-width flex collapse.
    if (m.flowW !== null) expect(m.flowW, 'flow label never a 0-width sliver').toBeGreaterThan(20);

    // The "···" affordance opens the SAME PatchPanel drill-down (it is part
    // of the jacks trigger), so every collapsed port stays reachable.
    await tile.getByTestId('rail-overflow').click();
    await expect(page.getByTestId('patch-panel')).toBeVisible();
  });

  // ZOOM-REPOSITION (owner rejection of the model-only fix) — the earlier test
  // below ("zoom NEVER repositions tiles") asserts xyflow MODEL positions are
  // zoom-invariant, and it PASSED while the USER-VISIBLE geometry still drifted:
  // the ChannelColumnsOverlay projected flow→screen through flowToScreenPosition
  // (WINDOW client coords — container offset included) but its bands are
  // absolutely positioned INSIDE the pane, so the whole lane grid (column lines,
  // number badges, the dashed video-zone band) sat a constant SCREEN offset
  // (the pane's client left/top) away from the tiles. Normalized by zoom that
  // offset is offset/zoom FLOW px — so tiles poked ABOVE the dashed video line
  // at low zoom and sat below it at high zoom, and every tile↔grid pair drifted
  // as the zoom changed. THIS test is the one that catches it: it measures
  // SCREEN bboxes of tiles AND overlay features at zooms crossing every LOD
  // tier boundary (0.30 / 0.52 / 0.95) plus the owner's repro range, normalizes
  // by zoom, and asserts every relative pair is identical within 2 flow px.
  test('zoom is a geometric NO-OP on SCREEN: tiles hold position vs lane lines, badges, the video band, and each other', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);
    for (const id of VZONE_IDS) {
      await expect(page.locator(vzFaceSelector(id))).toBeVisible({ timeout: 15_000 });
    }
    await dropInShellColumn(page, 'vca', 1);
    const memberId = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
      };
      return (w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [])[0] ?? '';
    });
    expect(memberId, 'the ch1 member spawned').not.toBe('');

    // Zooms crossing ALL LOD tier boundaries + the owner's repro range. The
    // expected data-shell-tier is the lane FACE tier (LOD 'dock' → 'full').
    const steps = [
      { zoom: 0.25, faceTier: 'mini' },
      { zoom: 0.45, faceTier: 'compact' },
      { zoom: 0.7, faceTier: 'full' },
      { zoom: 0.98, faceTier: 'full' }, // LOD 'dock' band (≥0.95 + hysteresis)
      { zoom: 1.4, faceTier: 'full' }, // deep dock band — the owner repro point
    ] as const;

    /** Flow-normalized relative offsets of every user-visible pair, measured
     *  from live SCREEN bounding rects (drift anywhere ⇒ the pair moves). */
    const measurePairs = () =>
      page.evaluate((memberId) => {
        const f = (globalThis as any).__flow;
        const vp = f.getViewport();
        const r = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
        const node = (id: string) => r(document.querySelector(`.svelte-flow__node[data-id="${id}"]`));
        const member = node(memberId);
        const videoOut = node('workflow-videoOut');
        const recorderbox = node('workflow-recorderbox');
        const videoArea = r(document.querySelector('[data-testid="video-area"]'));
        const badge1 = r(document.querySelector('[data-testid="channel-column-label-1"]'));
        const band1 = r(document.querySelector('[data-testid="channel-column-label-1"]')?.closest('.wcol-band') ?? null);
        if (!member || !videoOut || !recorderbox || !videoArea || !badge1 || !band1) return null;
        const flow = (screenPx: number) => screenPx / vp.zoom; // deltas: pan/pane offset cancels
        return {
          zoom: vp.zoom,
          // tile ↔ the dashed VIDEO-ZONE band top edge
          memberBottomToVideoTop: flow(videoArea.top - member.bottom),
          videoOutTopToVideoTop: flow(videoOut.top - videoArea.top),
          // tile ↔ its own COLUMN LINE (band 1's left guide line)
          memberLeftToBand1Left: flow(member.left - band1.left),
          // tile ↔ the LANE-NUMBER BADGE anchor (band-centered X)
          memberCenterToBadge1Center: flow(member.left + member.width / 2 - (badge1.left + badge1.width / 2)),
          // tile ↔ tile (the node layer itself)
          memberBottomToVideoOutTop: flow(videoOut.top - member.bottom),
          recorderboxLeftToVideoOutLeft: flow(recorderbox.left - videoOut.left),
        };
      }, memberId);

    const rows: NonNullable<Awaited<ReturnType<typeof measurePairs>>>[] = [];
    for (const { zoom, faceTier } of steps) {
      // Keep the measured rack region (lane 1..3 + the video-zone top) centered
      // so xyflow never culls the nodes at low zoom.
      await page.evaluate((z) => {
        const f = (globalThis as any).__flow;
        const pane = document.querySelector('.svelte-flow') as HTMLElement;
        const pr = pane.getBoundingClientRect();
        const cx = 300;
        const cy = 4200;
        f.setViewport({ x: pr.width / 2 - cx * z, y: pr.height / 2 - cy * z, zoom: z }, { duration: 0 });
      }, zoom);
      await page.waitForFunction(
        (t) => {
          const tiles = Array.from(document.querySelectorAll('[data-shell-tier]'));
          return tiles.length > 0 && tiles.every((el) => el.getAttribute('data-shell-tier') === t);
        },
        faceTier,
        { timeout: 10_000 },
      );
      // Two rAFs so the overlay re-projection + any tier content swap settle.
      await page.evaluate(() => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
      const m = await measurePairs();
      expect(m, `all measured features resolved at zoom ${zoom}`).not.toBeNull();
      rows.push(m!);
    }

    // EVERY pair is IDENTICAL (≤ 2 flow px — subpixel) across every zoom.
    const pairs = [
      'memberBottomToVideoTop',
      'videoOutTopToVideoTop',
      'memberLeftToBand1Left',
      'memberCenterToBadge1Center',
      'memberBottomToVideoOutTop',
      'recorderboxLeftToVideoOutLeft',
    ] as const;
    for (const key of pairs) {
      const values = rows.map((row) => row[key]);
      const spread = Math.max(...values) - Math.min(...values);
      expect(
        spread,
        `${key} must be zoom-invariant (values across zooms: ${values.map((v) => v.toFixed(1)).join(', ')})`,
      ).toBeLessThanOrEqual(2);
    }

    // …and the ABSOLUTE user-visible invariants hold at every zoom (not just
    // "consistent"): the ch1 stack bottom floats EXACTLY the badge clearance
    // (90 flow px — the owner lane-number-badge rule) above the dashed video
    // line, the video tiles sit INSIDE the zone (the +48px inset — pre-fix they
    // poked ABOVE the line at low zoom), and the tile keeps the clean 12px lane
    // gutter. The clearance is CONTENT geometry, so it is zoom-invariant like
    // every other pair here (the band grows with content, never with zoom).
    for (const row of rows) {
      expect(
        Math.abs(row.memberBottomToVideoTop - SHELL_BADGE_CLEARANCE_Y),
        `ch1 stack bottom floats the ${SHELL_BADGE_CLEARANCE_Y}px badge clearance above the video line @z${row.zoom}`,
      ).toBeLessThanOrEqual(2);
      expect(row.videoOutTopToVideoTop, `video tile INSIDE the zone @z${row.zoom}`).toBeGreaterThanOrEqual(46);
      expect(row.videoOutTopToVideoTop, `video tile inset ≈48 @z${row.zoom}`).toBeLessThanOrEqual(50);
      expect(Math.abs(row.memberLeftToBand1Left - 12), `12px lane gutter @z${row.zoom}`).toBeLessThanOrEqual(2);
      expect(Math.abs(row.memberCenterToBadge1Center), `tile centre == badge centre @z${row.zoom}`).toBeLessThanOrEqual(2);
    }
  });

  // BUG 4 counterpart — a low-port tile (vca: 2 in + 2 out) is untouched by
  // the fit: EVERY preview dot renders and no "···" overflow appears.
  test('low-port rail (vca) shows ALL jack dots with no "···" and EXPAND inside the tile', async ({ page }) => {
    // vca is MIGRATED as of P1 batch 1 — the lane tile is the curated
    // ModuleShell, which carries the SAME PatchPanel lane-rail contract the
    // placeholder does (all 4 dots, no overflow, EXPAND inside the tile).
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [{ id: NODE, type: 'vca', position: { x: 460, y: 240 } }]);
    const tile = page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
    await expect(tile).toBeVisible();
    await page.waitForFunction((nodeId) => {
      const r = document.querySelector(
        `.svelte-flow__node[data-id="${nodeId}"] [data-testid="lane-jack-rail"]`,
      );
      return !!r && r.scrollWidth <= r.clientWidth;
    }, NODE);

    const m = await page.evaluate((nodeId) => {
      const tile = document.querySelector(
        `.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`,
      ) as HTMLElement;
      const rail = tile.querySelector('[data-testid="lane-jack-rail"]') as HTMLElement;
      const expand = tile.querySelector('[data-testid="shell-open-dock"]') as HTMLElement;
      return {
        tileW: tile.offsetWidth,
        railScrollW: rail.scrollWidth,
        railClientW: rail.clientWidth,
        expandRight: expand.offsetLeft + expand.offsetWidth,
        dots: rail.querySelectorAll('.jk').length,
        hasOverflow: !!rail.querySelector('[data-testid="rail-overflow"]'),
      };
    }, NODE);
    expect(m.dots, 'ALL 4 vca preview dots render').toBe(4);
    expect(m.hasOverflow, 'no "···" on a low-port tile').toBe(false);
    expect(m.railScrollW, 'rail fits').toBeLessThanOrEqual(m.railClientW);
    expect(m.expandRight, 'EXPAND inside the tile').toBeLessThanOrEqual(m.tileW);
  });
});

// ─── LANE HEADROOM + badge clearance (owner rule, `?shell=1` only) ──────────
//
// The lane band GROWS with its contents: the shared band top derives from the
// FULLEST lane's stack, keeping ≥ half a module (90 flow px) of EMPTY band above
// its top tile — pre-fix the band top was FIXED, so a tall flush stack poked
// ABOVE the band edge (the owner's COFEFVE screenshot). And every stack's
// BOTTOM edge floats the badge clearance (90 flow px) above the baseline, so
// the lane-number badge renders fully visible below the bottom tile (pre-fix
// the bottom tile sat ON the baseline, over the badge row).
test.describe('LANE HEADROOM: the band grows with the fullest stack (?shell=1)', () => {
  /** Drop `type` into the tight shell column `ch` via the real palette path. */
  async function dropInShellColumn(page: Page, type: string, ch: number): Promise<void> {
    await page.evaluate(
      ({ type, pos }) => {
        const w = globalThis as unknown as {
          __setSpawnFlowPos: (p: { x: number; y: number }) => void;
          __spawnFromPalette: (t: string) => void;
        };
        w.__setSpawnFlowPos(pos);
        w.__spawnFromPalette(type);
      },
      { type, pos: { x: (ch - 1) * SHELL_COLUMN_W + 30, y: LANE_ANCHOR_Y } },
    );
  }

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 2 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
  // 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
  // LOST WHILE PARKED: the lane stacking geometry — headroom above the top tile, a single shared band top, and badges that are not clipped; the layout invariants that keep a 4-module stack readable.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('4-stack lane: ≥90px headroom above the top tile, ONE shared band top, badges fully visible', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);

    // Lane 1 = the FULLEST lane (4 uniform tiles); lane 2 = a 1-tile lane (its
    // band must FOLLOW lane 1's grown top, and its badge must stay visible too).
    for (const t of ['tidyVco', 'vca', 'delay', 'lfo']) {
      await dropInShellColumn(page, t, 1);
      await page.waitForTimeout(250);
    }
    await dropInShellColumn(page, 'adsr', 2);
    await page.waitForTimeout(250);
    const orders = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
      };
      const cols = w.__patch.nodes['pinned-mixmstrs']?.data?.columns ?? {};
      return { c1: cols['1'] ?? [], c2: cols['2'] ?? [] };
    });
    expect(orders.c1.length, 'lane 1 holds the 4-stack').toBe(4);
    expect(orders.c2.length, 'lane 2 holds one member').toBe(1);

    // A deterministic mid zoom (compact tier): 90 flow px of clearance ≈ 40
    // screen px — comfortably larger than the ~28px screen-fixed badge box.
    await page.evaluate((z) => {
      const f = (globalThis as any).__flow;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      const cx = 300; // mid lane 1..3 at the tight pitch
      const cy = 3900; // the grown band + baseline both in frame
      f.setViewport({ x: r.width / 2 - cx * z, y: r.height / 2 - cy * z, zoom: z }, { duration: 0 });
    }, 0.45);
    await page.evaluate(
      () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))),
    );

    const geo = await page.evaluate(
      ({ c1, c2 }) => {
        const f = (globalThis as any).__flow;
        const vp = f.getViewport();
        const pane = (document.querySelector('.svelte-flow') as HTMLElement).getBoundingClientRect();
        // Window screen px → flow-space Y (the overlay's pane-local projection:
        // screen = pane.top + flow·zoom + translateY).
        const toFlowY = (screenY: number) => (screenY - pane.top - vp.y) / vp.zoom;
        const bandTops = Array.from(document.querySelectorAll('.wcol-band')).map((b) =>
          toFlowY(b.getBoundingClientRect().top),
        );
        const sendTops = Array.from(document.querySelectorAll('.wcol-send')).map((b) =>
          toFlowY(b.getBoundingClientRect().top),
        );
        const nodeRect = (id: string) =>
          document.querySelector(`.svelte-flow__node[data-id="${id}"]`)?.getBoundingClientRect() ?? null;
        const stack1 = c1.map(nodeRect);
        const member2 = nodeRect(c2[0]);
        const badge = (ch: number) =>
          document.querySelector(`[data-testid="channel-column-label-${ch}"]`)?.getBoundingClientRect() ?? null;
        return {
          zoom: vp.zoom as number,
          bandTops,
          sendTops,
          stack1Tops: stack1.map((r) => (r ? toFlowY(r.top) : null)),
          stack1BottomScreen: stack1.length ? Math.max(...stack1.map((r) => (r ? r.bottom : -Infinity))) : null,
          member2TopFlow: member2 ? toFlowY(member2.top) : null,
          member2BottomScreen: member2 ? member2.bottom : null,
          badge1: badge(1) ? { top: badge(1)!.top, height: badge(1)!.height } : null,
          badge2: badge(2) ? { top: badge(2)!.top, height: badge(2)!.height } : null,
        };
      },
      { c1: orders.c1, c2: orders.c2 },
    );

    // (a) The band GREW to the derivation: baseline − (4×180 + 90 + 90) = 3420
    //     (pre-fix: max(360 default, 4×180) → 3600 — the top tile flush with it).
    const expectedTop = COLUMN_BASELINE_Y - (4 * SHELL_TILE_H_SLOT + SHELL_BADGE_CLEARANCE_Y + SHELL_LANE_HEADROOM_Y);
    expect(geo.bandTops.length, 'all 8 lane bands render').toBe(8);
    for (const t of geo.bandTops) expect(Math.abs(t - expectedTop), `band top == ${expectedTop}`).toBeLessThanOrEqual(2);

    // (b) ONE shared top: every lane band (and both send boxes — one rack) agrees.
    const spread = Math.max(...geo.bandTops) - Math.min(...geo.bandTops);
    expect(spread, 'all 8 lanes share one band top').toBeLessThanOrEqual(1);
    for (const t of geo.sendTops) expect(Math.abs(t - expectedTop), 'send boxes share the band top').toBeLessThanOrEqual(2);

    // (c) HEADROOM: the FULLEST lane's top tile sits ≥ ~90 flow px BELOW the
    //     band top (screen-measured, flow-normalized; exactly 90 by derivation).
    const stack1Tops = geo.stack1Tops.filter((t): t is number => t !== null);
    expect(stack1Tops.length, 'all 4 lane-1 tiles measured').toBe(4);
    const topTile = Math.min(...stack1Tops);
    expect(topTile - expectedTop, '≥ ~90px empty band above the top tile').toBeGreaterThanOrEqual(SHELL_LANE_HEADROOM_Y - 2);
    expect(topTile - expectedTop, 'exactly the headroom (the band hugs content + 90)').toBeLessThanOrEqual(SHELL_LANE_HEADROOM_Y + 2);

    // (d) The 1-tile lane keeps its bottom anchor (clearance above the baseline)
    //     — the shared top does NOT re-anchor short stacks.
    expect(
      Math.abs(geo.member2TopFlow! + SHELL_TILE_H_SLOT - (COLUMN_BASELINE_Y - SHELL_BADGE_CLEARANCE_Y)),
      'lane 2 bottom edge == baseline − clearance',
    ).toBeLessThanOrEqual(2);

    // (e) BADGE VISIBLE below the bottom tile for EVERY populated lane: the
    //     bottom tile's bbox bottom sits ABOVE the badge's top (screen space —
    //     the badge is a screen-fixed pill; no occlusion at this zoom).
    for (const [lane, tileBottom, badge] of [
      [1, geo.stack1BottomScreen, geo.badge1],
      [2, geo.member2BottomScreen, geo.badge2],
    ] as const) {
      expect(badge, `lane ${lane} badge rendered`).not.toBeNull();
      expect(tileBottom, `lane ${lane} bottom tile measured`).not.toBeNull();
      expect(
        tileBottom!,
        `lane ${lane}: bottom tile ends ABOVE the badge (badge fully visible)`,
      ).toBeLessThanOrEqual(badge!.top + 0.5);
    }
  });
});
