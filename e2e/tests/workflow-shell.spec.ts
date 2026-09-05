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
// Runs on /rack (no DB/relay) — the normal e2e lane, same as
// workflow-dock.spec.ts. Shell state is transient/local (never in the Y.Doc).

import { SHELL_COLUMN_W } from '../../packages/web/src/lib/graph/channel-columns';
import { SHELL_VIDEO_ZONE_TILE_INSET_Y } from '../../packages/web/src/lib/ui/workflow/module-shell-model';
import { test, expect, type Page } from '@playwright/test';
import { LANE_TILES, MAIN_CANVAS, spawnPatch, waitForLaneTier } from './_helpers';
import { REGISTRY } from './_registry';
import {
  AUDIO_DOCK_FIXTURE,
  CONTRACT_MODULE_TYPES,
  DENIED,
  fixtureProblems,
  fixtureType,
} from './_face-fixtures';
import { BOOT_MS, PLACEHOLDER_PAINT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
// Zero-import pure module — see `placeholderSubjectType` for why this is
// imported rather than transcribed.
import { NON_SHELL_LANE_TYPES } from '../../packages/web/src/lib/ui/workflow/legacy-fallback';

// Boot and first-paint waits are pure LATENCY BOUNDS, not behavior assertions
// (#1875 — this spec lost two main push runs in one day to flat ones). The
// bounds and the whole argument now live at ONE export site, imported above:
// ../_helpers/boot-budget.ts. They were declared locally here by #1898; the
// #1904 sweep found the same defect at twenty more sites, and a bound that is
// re-typed per spec is a bound that drifts — the reason frame waits have
// exactly one home too.

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// ⚠ AND THIS IS THE SPEC `boot-budget.ts` ITSELF NAMES as the most-flaked in the
// suite (16 recovered flakes across 31 runs, #1875). #1904 moved its bounds to
// the shared export and left the budget CONTAINING them at the flat default:
// `PLACEHOLDER_PAINT_MS` is 45 000 on CI inside a 30 000 ms budget — 1.50x, a
// tile wait that could not possibly finish. 4 sites (BOOT_MS + PLACEHOLDER_PAINT_MS).
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
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
 *  the fixture module is derived (AUDIO_DOCK_FIXTURE) rather than named,
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
// ⚠ IMPORTED, NEVER RE-TYPED (#2239). This was `const SHELL_COLUMN_W = 216`
// with a comment naming `channel-columns.ts SHELL_COLUMN_W` as its source — a
// literal that cites its own derivation is a literal that goes stale, and this
// one did the moment the pitch became 225. The app rendered the new pitch
// correctly and only the TEST disagreed, which reads as a product regression.
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
 *  band (columnCardX at the shell pitch) — the value the drop must persist. */
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
  // ⚠ SCOPED (LANE_TILES). Unscoped, this counted the PINNED audioOut faceplate
  // in the always-mounted 🎧 topbar panel as a lane tile. The delta below hid
  // that — the constant cancels — but the pins are ensured ASYNCHRONOUSLY, so a
  // `before` read taken before that mount lands is satisfied by the PANEL
  // instead of by the drop, and the geometry read that follows races a tile
  // that has not mounted. `measureTiles` was re-scoped in the same pass; a
  // readiness signal and the measurement it gates must count one population.
  return page.locator(LANE_TILES);
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
/**
 * A module type that renders a lane TILE — DERIVED from the live registry,
 * never named, and RESOLVED AS A VALUE rather than returned-or-thrown.
 *
 * ⚠ WHY IT IS STILL DERIVED NOW THAT EVERY MODULE RENDERS A TILE. The pool is
 * wider than it was, but the two exclusions below are real and the geometry
 * cases genuinely cannot use an arbitrary module — so the subject is still
 * chosen by PROPERTY rather than by name. Naming one was the original defect:
 * `synesthesia` was hard-coded here and took three tests with it when it was
 * faced (#2194), and a name would rot again the next time a module joins an
 * exclusion.
 *
 * ⚠ ONE SUBJECT, SELECTED BY A PROPERTY — deliberately NOT a registry-wide
 * render sweep (the banned shape). Nothing here spawns a scene per module.
 *
 * `NON_SHELL_LANE_TYPES` are excluded because they render their own roaming
 * surface and never a lane tile at all — including them would swap a stale
 * subject for a vacuous one. The second exclusion is narrower and each entry
 * carries its reason: a module whose SPAWN reaches for hardware or a permission
 * prompt would make this geometry test depend on the runner's devices.
 */

/**
 * The derivation's TWO outcomes. It used to have three: a `migration-complete`
 * arm existed because "the filter went blind" and "every eligible subject got
 * faced" produced the same empty list and needed opposite answers. The second
 * of those states cannot occur any more — being faced is no longer a reason to
 * leave the pool — so the arm is deleted rather than left unreachable.
 */
type TileSubject =
  | { kind: 'ok'; type: string; pool: readonly string[]; why: string }
  | { kind: 'no-candidate'; type: null; pool: readonly string[]; why: string };

function deriveTileSubject(): TileSubject {
  /**
   * Renders its own roaming surface in the lane — never a tile.
   *
   * ⚠ IMPORTED, NOT RE-TYPED, AND THAT IS A REPAIR. This used to be a hand
   * copy of `NON_SHELL_LANE_TYPES`, and by the time anyone looked it named TWO
   * modules the live set no longer contains: `launchpadControlLeft` (removed on
   * its own promotion) and `electraControl` (removed on its). Neither drift was
   * detectable here, because the copy is only ever used to EXCLUDE candidates —
   * an over-broad copy silently narrows the subject pool and stays green, which
   * is the blind-gate shape CLAUDE.md names. `legacy-fallback.ts` has zero
   * imports, so it loads in the Playwright runtime directly and the set cannot
   * drift from the rule it names.
   */
  const NON_SHELL = NON_SHELL_LANE_TYPES;
  /** Spawning these reaches for a device or a permission the runner may not
   *  have, which is not something a TILE-GEOMETRY test should depend on. */
  const NEEDS_HARDWARE = new Set([
    'audioIn',        // getUserMedia — a microphone permission prompt
    'es9',            // an Expert Sleepers interface over a local helper
    'gamepad',        // the Gamepad API + a physical pad
    'joystick',       // as gamepad
    'midiCvBuddy',    // WebMIDI + a device roster
    'midiLane',       // as midiCvBuddy
    'midiOutBuddy',   // as midiCvBuddy
    'numpadPlus',     // a HID keypad
    'vstFx',          // a plugin host / user-supplied binary
    'vstInstrument',  // as vstFx
  ]);
  /** Shell-eligible audio modules across the WHOLE population. THE
   *  INSTRUMENT'S NEGATIVE CONTROL: an empty result here means the fitness rule
   *  itself stopped working — `domain`, `NON_SHELL_LANE_TYPES` or the manifest
   *  changed shape — rather than the tree lacking a subject. */
  const eligible = REGISTRY.filter(
    (m) => m.domain === 'audio' && !NON_SHELL.has(m.type) && !NEEDS_HARDWARE.has(m.type),
  ).map((m) => m.type);
  const candidates = REGISTRY.filter(
    (m) => m.domain === 'audio' && !NON_SHELL.has(m.type) && !NEEDS_HARDWARE.has(m.type),
  )
    .map((m) => m.type)
    // Sorted so the pick is DETERMINISTIC across runs and shards — a test that
    // measured a different module each run would be unreproducible.
    .sort();

  // THE INSTRUMENT CHECK, exactly as in `deriveFixture`: a filter that accepts
  // nothing anywhere is broken, and it fails in the direction that looks like
  // "there is simply no subject" — silent and green — so it is checked first.
  if (eligible.length === 0) {
    return {
      kind: 'no-candidate',
      type: null,
      pool: candidates,
      why:
        'the tile-subject filter accepts NOTHING across the whole registry '
        + `(${REGISTRY.length} modules). The filter itself stopped working — \`domain\`, `
        + '`NON_SHELL_LANE_TYPES` or the manifest changed shape. FIX THE FILTER; do not read '
        + '"there is no subject" into it.',
    };
  }
  return {
    kind: 'ok',
    type: candidates[0]!,
    pool: candidates,
    why: `tile subject: ${candidates[0]} — first by name of ${candidates.length} shell-eligible audio modules`,
  };
}

const TILE_SUBJECT = deriveTileSubject();

/**
 * The named reason a case skips when the derived pool cannot supply the
 * subjects it needs — the ONE phrase the skip budget claims, so every one of
 * these degradations is admitted by a single named entry.
 *
 * ⚠ `need` IS PART OF THE STATE, NOT A DETAIL. Two cases below need TWO
 * DISTINCT placeholder types (uniformity is trivially true of a set of one),
 * and a pool of exactly one is neither `ok` for them nor `migration-complete`
 * for the derivation. Measured 2026-09-01: promoting `recorderbox` ALONE — one
 * face PR — emptied the default rack of placeholders and reddened THREE cases
 * in this file, because each of them was quietly borrowing the seeded video
 * zone's tile instead of dropping a subject of its own. Each now drops what it
 * needs and says so when it cannot.
 */
function tilePoolShortfall(need: number): string {
  return (
    `the derived placeholder pool cannot supply ${need} distinct un-promoted subject(s): it holds `
    + `${TILE_SUBJECT.pool.length} (${TILE_SUBJECT.pool.join(', ') || 'none'}). `
    + TILE_SUBJECT.why
  );
}

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
    // ⚠ SCOPED TO THE MAIN CANVAS. A document-wide sweep stopped meaning "the
    // lane tiles" on 2026-08-24: the always-mounted 🎧 topbar panel now holds a
    // PINNED audioOut faceplate, which this counted as a tile and which is a
    // different width — so `new Set(tiles.map(t => t.w)).size` read 2 where the
    // assertion wants 1. The CHILD combinator is the discriminator (see
    // `MAIN_CANVAS` in ./_helpers); `.first()` would not be one.
    const scope = document.querySelector('.flow > .svelte-flow');
    const tiles = Array.from(
      (scope ?? document).querySelectorAll(
        '[data-testid="module-shell"]',
      ),
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
  // ⚠ WAS A BARE `document.querySelectorAll('[data-shell-tier]')` + `.every()`.
  // That stopped meaning "the lane tiles" on 2026-08-24 without this spec
  // changing: promoting `audioOut` put a PINNED faceplate in the always-mounted
  // 🎧 topbar panel, whose tier is permanently `dock`, so `.every()` could never
  // become true and this call sat out its full 10 s timeout. Scoped to the main
  // canvas through the ONE export site — see `waitForLaneTier`.
  await waitForLaneTier(page, expectTier);
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
test('the derived audio dock fixture is healthy', () => {
  expect(fixtureProblems(AUDIO_DOCK_FIXTURE), AUDIO_DOCK_FIXTURE.why).toEqual([]);

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
  for (const [name, f] of [['AUDIO_DOCK', AUDIO_DOCK_FIXTURE]] as const) {
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
    //
    // ⚠ THE SUBJECT IS THE LIVE SET, NOT A NAMED MODULE, AND THAT IS THE THIRD
    // RE-POINT THIS LEG WOULD OTHERWISE HAVE TAKEN. It named `clipplayer`,
    // "a NON_SHELL_LANE_TYPES snowflake", and `clipplayer` was promoted in
    // its own face PR — the LAST module card that set ever held. Nominating another
    // member by hand is what went stale twice; iterating the set cannot,
    // because `rendersPlaceholderTile` reads the same set. The remaining
    // members (`group`, `sticky`, `cadillac`) are organizational chrome and a
    // roaming sprite, none of which any face programme can promote away.
    expect(
      [...NON_SHELL_LANE_TYPES].filter((t) => f.probe(t) === null),
      `${name}: every NON_SHELL_LANE_TYPES member must be REFUSED — laneRenderKind returns ` +
        "'legacy' for each, so none of them renders a placeholder tile to assert on",
    ).toEqual([]);
    expect(
      NON_SHELL_LANE_TYPES.size,
      `${name}: the negative control has a subject at all (an emptied set would make the ` +
        'clause above vacuously green)',
    ).toBeGreaterThan(0);
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
  test('a lane tile + the dock faceplate: full chrome, and a control that really drives the graph', async ({ page }) => {
    // ⚠ THE ONLY PLACE THE DOCK FACEPLATE'S CHROME IS ASSERTED AS A WHOLE.
    // Individual face specs click `faceplate-tab-<id>`; nothing else checks the
    // grip, the badge, the name/sub pair, the window trio or the domain-classed
    // frame. That is why this leg is rewritten rather than deleted — its title
    // named a render branch, but its BODY is about the dock faceplate, which is
    // entirely live.
    //
    // What went with the branch: the lane assertion is `module-shell` rather
    // than a placeholder testid, and the dock half drives the FACEPLATE's own
    // control instead of a verbatim card's `<NeonFader>`.
    const subject = fixtureType(AUDIO_DOCK_FIXTURE);
    await gotoWorkflow(page);
    await spawnPatch(page, [{ id: NODE, type: subject, position: { x: 460, y: 240 } }]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    await expect(laneNode).toHaveCount(1);

    // 1) The lane shows the module's faceplate tile.
    const tile = laneNode.locator('[data-testid="module-shell"]');
    await expect(tile).toBeVisible();
    // Cables stay attached: the node keeps its full invisible handle stack.
    await expect(laneNode.locator('.svelte-flow__handle').first()).toHaveCount(1);

    // 2) Open in dock (the jack-rail "⤢" expand) → the RACKLINE full-view
    //    FACEPLATE opens in the bottom drawer.
    await tile.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    // The spec chrome: grip, title bar (badge + name + mono sub), the window-
    // control trio, the tab-rail seam, and the domain-classed faceplate frame.
    await expect(faceplate.getByTestId('faceplate-grip')).toBeVisible();
    await expect(faceplate.locator('.faceplate-bar .face-badge')).toBeVisible();
    await expect(faceplate.locator('.faceplate-bar .face-name')).toBeVisible();
    await expect(faceplate.locator('.faceplate-bar .face-sub')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-close')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-collapse')).toBeVisible();
    await expect(faceplate.locator('[data-testid="faceplate-tabrail"]')).toBeVisible();

    // The plate carries the module's DERIVED domain class — read from the
    // contract golden, never hard-coded, so this proves the plate carries the
    // RIGHT class for whatever subject the derivation handed it.
    const domainClass = AUDIO_DOCK_FIXTURE.kind === 'ok' ? AUDIO_DOCK_FIXTURE.domainClass : null;
    expect(domainClass, 'the dock fixture must resolve a determinate domain class').not.toBeNull();
    await expect(
      faceplate.locator(`.faceplate.${domainClass}`),
      `${subject}: the dock plate carries its derived domain class (.faceplate.${domainClass})`,
    ).toHaveCount(1);

    // The faceplate hosts NO xyflow handles / node wrappers (PatchPanel self-gates):
    await expect(faceplate.locator('.svelte-flow__handle')).toHaveCount(0);
    await expect(faceplate.locator('.svelte-flow__node')).toHaveCount(0);

    // 3) The lane tile STILL shows (Option #1: lane face + dock faceplate
    //    coexist — the module was never persist-docked / swapped to a stub).
    await expect(tile).toBeVisible();
    await expect(laneNode.locator('[data-testid="dock-stub"]')).toHaveCount(0);

    // 4) Drive a control in the dock → the graph params change (OPERABLE).
    //
    // ⚠ THE CONTROL IS FOUND IN THE DOM, NOT PREDICTED FROM SOURCE. This used
    // to demand the subject's card mount a `<NeonFader>` so it could drag
    // `.fader-wrap .track` by name — a requirement that broke when the
    // component was renamed and again when the components were deleted. Taking
    // the faceplate's FIRST ranked slider proves the real surface is operable,
    // whatever it chose to mount, and cannot go stale against a file it never
    // reads.
    const before = await readParams(page, NODE);
    const control = faceplate.locator('[role="slider"]').first();
    await expect(
      control,
      `${subject}: the dock faceplate must mount at least one ranked control to drive`,
    ).toBeVisible();
    // ⚠ SCROLL IT INTO VIEW BEFORE MEASURING, and this is a REAL FIX rather than
    // defensive noise (#2137). This leg drives raw `page.mouse` at coordinates
    // from `boundingBox()`, which reports where an element IS — including when
    // it is scrolled outside the dock's clipped viewport. The pointer then lands
    // on whatever actually occupies those screen coordinates, the drag commits
    // nothing, and the failure reads as "this surface is not operable" rather
    // than "the test never touched it".
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box, 'a ranked control should be present in the dock faceplate').toBeTruthy();
    if (!box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // The grab lands on the control's MIDPOINT, so there is guaranteed travel in
    // both directions — a fixed drag off a rail-parked control is the
    // false-failure class faces-parity's dragKnob guards against.
    await page.mouse.move(cx, cy - 34, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => JSON.stringify(await readParams(page, NODE)), {
        message: `${subject}: driving the dock faceplate's first control commits a param change`,
      })
      .not.toBe(JSON.stringify(before));

    // 5) ESC closes the full-view faceplate; the lane tile remains.
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(tile).toBeVisible();
  });

  test('placeholder tiles are UNIFORM WIDTH + the FIXED slot height with a consistent badge anchor', async ({ page }) => {
    // The owner "same-size all modules HORIZONTALLY" + "tiles non-uniform / smaller
    // than the mock" fix: under ?shell=1 the tile-swapped defaults render as the
    // SAME uniform RACKLINE tile whatever their LEGACY card measured — identical
    // WIDTH (SHELL_TILE_W) and the ONE fixed slot HEIGHT (SHELL_TILE_H_SLOT —
    // tier-invariant, the zoom-reposition fix), so the baseline number badges
    // cap them flush. (A PROMOTED occupant is out of scope here by construction:
    // it renders `module-shell`, not a placeholder, and its width is covered by
    // the faces suites.)
    //
    // ⚠ THE `data-shell-tier` FIELD THIS USED TO COLLECT WAS NEVER ASSERTED. The
    // prose here claimed the pair spanned "DIFFERENT rack tiers, so different
    // LEGACY widths", and the evaluate returned `tier` — but nothing ever
    // compared it, so the tier spread was narrative, not coverage. Dropped
    // rather than carried over, and the honest floor (≥2 distinct module types)
    // is asserted below instead.
    // ⚠ THE SUBJECTS ARE DERIVED FROM THE RACK, NOT NAMED — and the two names
    // that used to be here (`workflow-recorderbox`, `workflow-synesthesia`) are
    // why. A placeholder is what an UNPROMOTED module renders, so every name in
    // this list was a bet that the module would still be unfaced; promoting
    // `synesthesia` made the locator match nothing and this test failed on a
    // change that had nothing to do with tile geometry. The precondition it
    // depended on WAS the module being unmigrated.
    //
    // Asking the DOM which tiles are placeholders keeps the subject true by
    // construction. It is also STRICTLY STRONGER than the two names: it covers
    // every placeholder the default rack renders rather than a hand-picked pair,
    // so a tile that regressed outside that pair can no longer hide.
    //
    // ⚠ NOT A REGISTRY-WIDE RENDER SWEEP (the banned shape). Nothing is spawned
    // per module and no per-module scene is booted — this reads the ONE page the
    // test already loaded and asserts a geometric invariant over what is on it.
    //
    // ⚠ MINIMUM-POPULATION GUARD, because "uniform" is trivially true of a set
    // of one and vacuously true of a set of none. Two DISTINCT module types is
    // the floor that makes the comparison mean anything, and if promotions ever
    // drain the rack below it this fails LOUDLY — asking for a new subject —
    // rather than passing while measuring nothing.
    // ── THE INSTRUMENT FIRST, THEN THE MIGRATION (the `deriveFixture` order) ─
    // A filter that accepts nothing anywhere reads exactly like a finished
    // migration and fails GREEN, so it reds here — ahead of the skip.
    expect(
      TILE_SUBJECT.kind === 'no-candidate' ? TILE_SUBJECT.why : null,
      'the tile-subject derivation went blind',
    ).toBeNull();
    // An exhausted pool is the DESIGNED end state: with every audio module
    // faced, nothing renders a `module-shell-placeholder` and a test about
    // placeholder geometry has no subject. NAMED skip (#2295) — it used to be a
    // throw from inside this body, i.e. a red for a non-defect.
    //
    // ⚠ THE THRESHOLD IS **TWO**, NOT ONE, AND THAT IS THE FLOOR BELOW SPEAKING.
    // "Uniform" is trivially true of a set of one, so this case needs two
    // DISTINCT placeholder types — and it used to get the second one from the
    // seeded rack, which is a borrowed subject, not a derived one.
    test.skip(TILE_SUBJECT.pool.length < 2, tilePoolShortfall(2));

    await gotoWorkflow(page);
    await waitForHooks(page);
    // ⚠ BOTH SUBJECTS ARE NOW DROPPED, AND THE SEEDED RACK IS NOT COUNTED ON.
    // This used to drop ONE and rely on the default rack for the other, with a
    // note saying promotions had drained it to a single placeholder
    // (`recorderbox`, measured 2026-08-24). That last seeded placeholder is one
    // face PR from gone: measured 2026-09-01, promoting `recorderbox` alone
    // takes the rack to ZERO and this case fails on its own floor
    // ("uniformity needs at least two DISTINCT placeholder module types"),
    // which reads like a tile-geometry regression. Dropping both makes the
    // population this case measures its OWN, and the skip above states the one
    // condition under which it cannot have it.
    for (const t of TILE_SUBJECT.pool.slice(0, 2)) {
      await dropInColumn(page, t, 1);
    }
    const placeholders = page.locator(`${MAIN_CANVAS} [data-testid="module-shell"]`);
    await expect(placeholders.first()).toBeVisible({ timeout: PLACEHOLDER_PAINT_MS });

    const metrics = await page.evaluate((canvasSel) => {
      const tiles = Array.from(
        document.querySelectorAll(`${canvasSel} [data-testid="module-shell"]`),
      ) as HTMLElement[];
      return tiles.map((tile) => {
        const badge = tile.querySelector('.tile-badge') as HTMLElement | null;
        if (!badge) return null;
        // offset* are UNSCALED layout px (immune to the xyflow viewport zoom
        // transform): the TRUE tile W/H + the badge's anchor within the tile.
        return {
          type: tile.getAttribute('data-shell-type'),
          w: tile.offsetWidth,
          h: tile.offsetHeight,
          badgeTop: badge.offsetTop,
        };
      });
    }, MAIN_CANVAS);

    expect(metrics.every((m) => m !== null), 'every placeholder resolved a badge').toBe(true);
    const types = new Set(metrics.map((m) => m!.type));
    expect(
      types.size,
      `uniformity needs at least two DISTINCT placeholder module types to mean anything — the `
        + `default rack rendered ${types.size} ([${[...types].join(', ')}]). If promotions have `
        + `drained it, give this test a new subject; do not relax the floor.`,
    ).toBeGreaterThanOrEqual(2);
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
    // The mixed population below needs ONE un-promoted subject; without it the
    // placeholder half of the claim has nothing to measure. NAMED skip (#2295).
    expect(
      TILE_SUBJECT.kind === 'no-candidate' ? TILE_SUBJECT.why : null,
      'the tile-subject derivation went blind',
    ).toBeNull();
    test.skip(TILE_SUBJECT.pool.length < 1, tilePoolShortfall(1));

    await gotoWorkflow(page);
    await waitForHooks(page);
    // ⚠ THE THIRD MEMBER IS DERIVED, AND IT USED TO BE THE LITERAL `delay`
    // (#2295). The three drops exist to put BOTH lane kinds in ONE column — the
    // uniform-width claim is only interesting across a shell tile and a
    // placeholder tile — and `delay` was named as the placeholder. It was
    // promoted in P1 batch 3, so from then on all three drops were faced and
    // the placeholder assertion below was being satisfied by the SEEDED VIDEO
    // ZONE instead, from a different column: a precondition passing for a
    // reason the test never states. Measured 2026-09-01: promote `recorderbox`
    // — the rack's last seeded placeholder — and this case reds with
    // "Received: 0" on a change that breaks nothing it was written to protect.
    const types = ['tidyVco', 'vca', TILE_SUBJECT.pool[0]!];
    for (const t of types) {
      await dropInColumn(page, t, 1);
    }
    // Tiles mounted: tidyVco/vca render the migrated shell, and the derived
    // third member renders the placeholder — BOTH KINDS, in this column.
    // ⚠ BOTH SCOPED TO THE CANVAS, and the second one had ALREADY GONE BLIND.
    // `page.locator('[data-testid="module-shell"]')` matched the pinned audioOut
    // faceplate in the always-mounted 🎧 topbar panel, so "a migrated tile
    // mounted in the LANE" became true on every page whether or not anything
    // dropped — a precondition that can no longer fail, guarding a measurement
    // that was re-scoped to the canvas in the same pass. It would have gone on
    // certifying the next lane-mount regression in silence.
    await expect(
      page.locator(`${MAIN_CANVAS} [data-testid="module-shell"]`),
    ).not.toHaveCount(0);
    await expect(page.locator(`${MAIN_CANVAS} [data-testid="module-shell"]`)).not.toHaveCount(0);

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

  test('lanes are the TIGHT shell pitch: drops land in the narrowed column + tiles fill the lane with no overlap', async ({ page }) => {
    // The RACKLINE narrowing: under ?shell=1 the app-scale 765px band collapses to
    // the tight shell lane pitch, so the uniform 192px tiles FILL their
    // lanes (24px gutter) instead of floating in huge gutters. Prove (a) a real
    // palette drop lands in the correct NARROWED column via the pitch-aware
    // hit-test, (b) the rendered column pitch is ~SHELL_COLUMN_W, and (c) tiles don't
    // overlap (clean gutter).
    await gotoWorkflow(page);
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
          `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"], .svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`,
        ) as HTMLElement | null;
        out.push({ ch, x, w: el?.offsetWidth ?? 0 });
      }
      return out;
    });
    expect(tiles.length).toBe(3);

    // (b) Consecutive column heads are ~SHELL_COLUMN_W apart — the tight
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
    // Same shape as the case above: the tier/box invariants are asserted across
    // BOTH lane kinds, so one un-promoted subject is a precondition. NAMED skip.
    expect(
      TILE_SUBJECT.kind === 'no-candidate' ? TILE_SUBJECT.why : null,
      'the tile-subject derivation went blind',
    ).toBeNull();
    test.skip(TILE_SUBJECT.pool.length < 1, tilePoolShortfall(1));

    await gotoWorkflow(page);
    await waitForHooks(page);
    // ⚠ THE PLACEHOLDER IS DROPPED, NOT BORROWED (#2295). Both drops here are
    // promoted, so the assertion below was being satisfied by whatever
    // placeholder the SEEDED rack happened to still have — measured
    // 2026-09-01, that is `recorderbox` and nothing else, so its promotion
    // reddens this case with "Received: 0" for a non-defect.
    for (const t of ['tidyVco', 'vca', TILE_SUBJECT.pool[0]!]) {
      await dropInColumn(page, t, 1);
    }
    await expect(page.locator('[data-testid="module-shell"]')).not.toHaveCount(0);

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
  // ⚠ ITS SUBJECT MOVED WHILE IT SLEPT (2026-08-24), AND THAT HALF IS NOW FIXED
  // (#2295). The note here used to say only that `workflow-synesthesia` had been
  // PROMOTED — so it renders `module-shell`, never a `module-shell-placeholder`,
  // and this body's wait would have timed out for a reason with no relation to
  // #1847 — and it left the assertions untouched "per the park's own terms".
  // That is how an already-false assertion sits preserved in amber: the park
  // absorbs it, and whoever un-parks reads the timeout as "still flaky". The
  // SUBJECT is therefore repaired now, ahead of any un-park, and DERIVED rather
  // than re-typed (the live test above is the pattern).
  //
  // ⚠ THE PARK ITSELF STAYS, and the distinction is the whole reason to say so.
  // #1847 is CI nondeterminism — 2 recovered-on-retry observations in the 96 h
  // census to 2026-08-18, six days BEFORE synesthesia was promoted — so the
  // stale subject cannot be its cause and fixing the subject is not a root
  // cause. This file's own rule holds: *"Re-enable only on a root cause; 'it
  // passes now' is not one."* What changed is that an un-park now measures
  // #1847 instead of measuring a dead node id.
  test.fixme('tile header: domain-colour rule ── gap ── FULL long name, type badge on row 2', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    // The owner tile-header redesign: the module NAME no longer shares its row
    // with the type badge (long names truncated as "RECORDE…"/"SYNESTH…"). Row 1
    // is a decorative 2px RULE in the DOMAIN colour (the spine/cable hue) from
    // the tile's LEFT edge, vertically centred on the name text, stopping at a
    // set gap BEFORE the name; the NAME then takes the full remaining width. The
    // faint uppercase type badge moved DOWN to row 2.
    // ⚠ THE SUBJECTS ARE DERIVED, AND THE TWO NAMES THAT USED TO BE HERE ARE
    // WHY (#2295). `['workflow-recorderbox', 'workflow-synesthesia']` was a
    // standing bet that neither module would be faced; `synesthesia` was
    // promoted on 2026-08-24 and the leg has been asserting a placeholder for a
    // faced module ever since, invisible because the park absorbs it.
    //
    // Instrument first, then the migration — the `deriveFixture` order.
    expect(
      TILE_SUBJECT.kind === 'no-candidate' ? TILE_SUBJECT.why : null,
      'the tile-subject derivation went blind',
    ).toBeNull();

    await gotoWorkflow(page);
    await waitForHooks(page);
    // ⚠ THE LONGEST-NAMED CANDIDATE, not the alphabetical pick the sibling test
    // uses, because THE NAME IS THIS TEST'S SUBJECT: the reported bug was a long
    // name truncating to "RECORDE…" when it shared row 1 with the type badge, so
    // the strongest available subject is the longest name the pool still offers.
    // Ties break on the name so the choice is deterministic across shards.
    //
    // ⚠ AND THERE IS DELIBERATELY NO MINIMUM NAME LENGTH. A floor would be a
    // threshold sitting on a population the face programme is draining — the
    // ratchet hazard `_face-fixtures.ts` records for its own deleted
    // `pool.length <= 1` slack floor — and it would red on a promotion rather
    // than on a defect. What the assertions lose as the pool shortens is stated
    // instead: the "renders in FULL / no ellipsis" leg gets weaker the shorter
    // the longest remaining name is, while the rule, gap and badge-row geometry
    // legs are length-independent and keep their full strength.
    const longestNamed = [...TILE_SUBJECT.pool].sort(
      (a, b) => b.length - a.length || a.localeCompare(b),
    )[0]!;
    await dropInColumn(page, longestNamed, 1);

    // The population is read off the RACK — every placeholder tile the default
    // rack seeded plus the one just dropped — so a promotion drops a member
    // automatically instead of leaving a dead node id asserted here.
    const ids = await page.evaluate(
      (canvasSel) =>
        Array.from(
          document.querySelectorAll(`${canvasSel} [data-testid="module-shell"]`),
        )
          .map((tile) => tile.closest('.svelte-flow__node')?.getAttribute('data-id') ?? '')
          .filter((id) => id !== ''),
      MAIN_CANVAS,
    );
    // MINIMUM-POPULATION GUARD: a per-tile loop over an empty list passes while
    // measuring nothing, and this list is derived from the DOM.
    expect(
      ids,
      'no placeholder tile is on the rack, so the header composition is measured on nothing — '
        + `the derived drop (${longestNamed}) did not land`,
    ).not.toEqual([]);
    for (const id of ids) {
      await expect(
        page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`),
      ).toBeVisible({ timeout: PLACEHOLDER_PAINT_MS });
    }
    // The compact tier (the truncation report's tier) — the tile is 192px wide.
    await setZoomTier(page, 0.45, 'compact');

    const metrics = await page.evaluate((nodeIds) => {
      return nodeIds.map((id) => {
        const tile = document.querySelector(
          `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`,
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
          // The module TYPE the tile itself reports, so the expected name is
          // DERIVED from the subject rather than matched against a literal.
          shellType: tile.getAttribute('data-shell-type') ?? '',
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

    expect(metrics.every((m) => m !== null), 'every placeholder resolved its header parts').toBe(true);
    for (const m of metrics) {
      // (b) the FULL name renders — no ellipsis: the auto-namer's own output
      // fits the 192px tile un-truncated.
      //
      // ⚠ THE EXPECTATION IS DERIVED FROM THE TILE'S OWN TYPE, not matched
      // against `/^(RECORDERBOX|SYNESTHESIA)$/`. That alternation was a second
      // copy of the hard-coded subject list and would have gone red on the very
      // promotion the ids above already survive. `nextDefaultName`
      // ($lib/multiplayer/module-naming) gives the FIRST instance of a type the
      // bare uppercased type and every later one a numeric suffix ≥ 2 — never
      // `<TYPE>1` — so this is the auto-namer's contract restated, and a
      // truncated render ("RECORDE…") fails it whatever the module is.
      const expectedName = new RegExp(`^${m!.shellType.toUpperCase().replace(/[^A-Z0-9]/g, '.')}\\d*$`);
      expect(
        m!.nameText,
        `${m!.id}: the FULL auto-name for '${m!.shellType}' is present, un-truncated`,
      ).toMatch(expectedName);
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
});

// ─── P0.3b ?shell=1 bug fixes (video-zone inset · lane-snap · expand button) ──
test.describe('P0.3b workflow-shell ?shell=1 bug fixes', () => {
  const VZONE_IDS = ['workflow-videoOut', 'workflow-recorderbox', 'workflow-synesthesia'];

  /** The video-zone default's LANE TILE under the shell — EITHER KIND.
   *
   *  ⚠ THIS USED TO BE A PER-ID TERNARY AND IT HAD ALREADY BEEN EDITED ONCE FOR
   *  EXACTLY THIS REASON. It first named videoOut's verbatim legacy card
   *  (`video-out-card`), because videoOut was a NON_SHELL video-surface
   *  snowflake; #1821 promoted it and the arm was rewritten to `module-shell`,
   *  leaving `recorderbox`/`synesthesia` on the placeholder arm — and the note
   *  above it said so, in the present tense. Promoting `synesthesia` then broke
   *  the two tests below for the third time in the same spot.
   *
   *  ⚠ SO THE MIGRATION STATUS WAS NEVER THIS SELECTOR'S SUBJECT. Both callers
   *  use it as a READINESS WAIT and nothing else: the measurements are
   *  `flowPos()` (the xyflow internal node, looked up BY ID) and screen bounding
   *  boxes. Neither reads a testid, and neither assertion — "the tile sits below
   *  the video baseline", "zoom is a geometric no-op" — has any opinion about
   *  whether the occupant is a placeholder or a faceplate. Encoding one made a
   *  POSITION test depend on the promotion queue.
   *
   *  Matching either testid is therefore strictly more general than the ternary
   *  and weakens nothing: the wait still proves a tile PAINTED before anything is
   *  measured, and it now proves it for whichever tile the module legitimately
   *  renders. It cannot go stale on the next promotion, or the one after. */
  const vzFaceSelector = (id: string) =>
    `.svelte-flow__node[data-id="${id}"] `
    + ':is([data-testid="module-shell"], [data-testid="module-shell"])';

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
    await gotoWorkflow(page);
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
    await gotoWorkflow(page);
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
    // ⚠ THE SUBJECT IS DERIVED, NOT NAMED, and the requirement is only "a
    // module that renders a lane tile" — this leg clicks a pill and presses
    // ESC. It used to demand an UN-FACED subject so it exercised the
    // placeholder's expand path specifically; there is one expand path now, so
    // the distinction is gone and the leg simply asserts it.
    await gotoWorkflow(page);
    await spawnPatch(page, [
      { id: NODE, type: fixtureType(AUDIO_DOCK_FIXTURE), position: { x: 460, y: 240 } },
    ]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    const tile = laneNode.locator('[data-testid="module-shell"]');
    await expect(tile).toBeVisible();

    const expandBtn = tile.getByTestId('shell-open-dock');
    await expect(expandBtn).toBeVisible();
    // DISCOVERABILITY: the button carries a readable text LABEL (not a bare glyph),
    // so it reads as a clear "expand" action.
    await expect(expandBtn).toContainText('EXPAND');

    // The wired full path still works: click → the RACKLINE .dock-faceplate opens.
    await expandBtn.click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    await expect(faceplate).toHaveClass(/dock-faceplate/);

    // ESC closes it; the lane tile remains.
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(tile).toBeVisible();
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
  // ⚠ WHOEVER UN-PARKS THIS: ITS SUBJECT MOVED WHILE IT SLEPT (2026-08-24).
  // `workflow-synesthesia` is PROMOTED, so it renders `module-shell` and never a
  // `module-shell-placeholder` — this body's wait will time out for a reason
  // unrelated to #1847. ⚠ AND THE REPLACEMENT IS NOT ANY PLACEHOLDER: this test
  // needs a PORT-HEAVY one (the whole point is 8 preview dots overflowing a
  // 192 px rail, and the assertions hard-code `< 8` and a '···'), so a derived
  // pick that lands on a two-port module would go green while measuring nothing.
  // Pick an unpromoted subject BY PORT COUNT and re-derive those numbers.
  // The BODY IS DELIBERATELY UNTOUCHED, per the park's own terms.
  test.fixme('port-heavy rail FITS the tile: EXPAND fully visible, surplus dots collapse into "···" that opens the drill-down', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    await gotoWorkflow(page);
    const tile = page.locator(
      '.svelte-flow__node[data-id="workflow-synesthesia"] [data-testid="module-shell"]',
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
        '.svelte-flow__node[data-id="workflow-synesthesia"] [data-testid="module-shell"]',
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
    await gotoWorkflow(page);
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
      // ⚠ WAS A BARE `document.querySelectorAll('[data-shell-tier]')` + `.every()`.
      // That stopped meaning "the lane tiles" on 2026-08-24 without this spec
      // changing: promoting `audioOut` put a PINNED faceplate in the always-mounted
      // 🎧 topbar panel, whose tier is permanently `dock`, so `.every()` could never
      // become true and this call sat out its full 10 s timeout. Scoped to the main
      // canvas through the ONE export site — see `waitForLaneTier`.
      await waitForLaneTier(page, faceTier);
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
      // The inset is DERIVED (#2239). It was a hardcoded 46..50 window around
      // the old magic 48; it is now one RACK_UNIT, because 48 is not a grid
      // multiple and a tile placed with it could never be locked without
      // moving. Asserting the constant keeps this a statement about the tile
      // being INSIDE the zone rather than about a number.
      expect(row.videoOutTopToVideoTop, `video tile INSIDE the zone @z${row.zoom}`).toBeGreaterThan(0);
      expect(
        Math.abs(row.videoOutTopToVideoTop - SHELL_VIDEO_ZONE_TILE_INSET_Y),
        `video tile inset == SHELL_VIDEO_ZONE_TILE_INSET_Y (${SHELL_VIDEO_ZONE_TILE_INSET_Y}) @z${row.zoom}`,
      ).toBeLessThanOrEqual(2);
      // The lane gutter follows the pitch: (pitch − tile) / 2.
      expect(
        Math.abs(row.memberLeftToBand1Left - (SHELL_COLUMN_W - SHELL_TILE_W) / 2),
        `lane gutter == (pitch − tile)/2 @z${row.zoom}`,
      ).toBeLessThanOrEqual(2);
      expect(Math.abs(row.memberCenterToBadge1Center), `tile centre == badge centre @z${row.zoom}`).toBeLessThanOrEqual(2);
    }
  });

  // BUG 4 counterpart — a low-port tile (vca: 2 in + 2 out) is untouched by
  // the fit: EVERY preview dot renders and no "···" overflow appears.
  test('low-port rail (vca) shows ALL jack dots with no "···" and EXPAND inside the tile', async ({ page }) => {
    // vca is MIGRATED as of P1 batch 1 — the lane tile is the curated
    // ModuleShell, which carries the SAME PatchPanel lane-rail contract the
    // placeholder does (all 4 dots, no overflow, EXPAND inside the tile).
    await gotoWorkflow(page);
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
    await gotoWorkflow(page);
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
