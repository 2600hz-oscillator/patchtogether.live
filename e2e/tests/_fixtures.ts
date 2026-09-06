// e2e/tests/_fixtures.ts
//
// Shared Playwright fixtures for the three copy-pasted blocks that used to be
// hand-rolled at the top of most specs (LoC campaign row 3). A SEPARATE file
// from `_helpers.ts` — originally so fixture-only changes could not move the
// collab attest hash (that attest was deleted 2026-08-17), and now simply
// because fixtures and multi-context helpers are different concerns.
//
//   * `errorWatch` — collects page errors + console.error lines for the life
//     of the test and asserts the list is EMPTY at teardown (after the test
//     body finishes). Destructure it in the test signature to arm it:
//
//       test('renders', async ({ page, errorWatch }) => { ... });
//
//     The assert also runs when the body threw first — Playwright reports the
//     original failure and appends the teardown one, so a page error that
//     CAUSED the failure is still visible in the report. Tests that need to
//     assert mid-body (e.g. before an intentionally-noisy phase) can call
//     `errorWatch.assertClean()` themselves; the teardown assert then
//     re-checks the final state.
//
//     NOT auto-armed: specs that expect/filter specific console errors keep
//     hand-rolled collectors, and converting a previously-unwatched spec is a
//     behavior change that needs its own triage (see the LoC report, row 3).
//
//   * `rack` — the standard `goto('/rack?seed=none')` + `networkidle` nav that
//     opens ~90% of specs. Destructure `rack` and the page is already on the
//     rack when the body runs (fixtures resolve before the test body):
//
//       test('spawns', async ({ page, rack, errorWatch }) => { ... });
//
//     Note: `errorWatch` subscribes when set up, and Playwright sets up
//     fixtures in dependency order — both orderings of the destructure work
//     because `rack` depends on nothing and `errorWatch` binds listeners on
//     the page object itself (pre-navigation errors are still caught: the
//     listeners attach before the test body regardless).
//
//   * `loadVoiceDemo(page)` — see the block comment on the function. It
//     REPLACES the retired "Load example… → Sequenced VCO" dropdown option
//     that ~11 specs used purely as "get a known patch onto the canvas".
//
// The third extracted family, `setNodeParams` (Yjs param mutation), already
// lives in `_module-coverage-helpers.ts` — import it from there.

import { test as base, expect, type Page } from '@playwright/test';

// Several specs import `Page` from here alongside `test`/`expect` — keep the
// type re-exported so the fixture module is a one-stop import (#1499).
export type { Page };
import { waitForMounted } from './_helpers';
import { applySetupCredit } from './_setup-credit';

export interface ErrorWatch {
  /** Live list of collected page/console errors (push-ordered). */
  errors: string[];
  /** Assert no errors have been collected so far. */
  assertClean(): void;
}

export const test = base.extend<{
  errorWatch: ErrorWatch;
  rack: void;
}>({
  errorWatch: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const watch: ErrorWatch = {
      errors,
      assertClean: () =>
        expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]),
    };
    await use(watch);
    watch.assertClean();
  },

  // THE rack fixture — most specs reach the canvas only through here.
  //
  // This is the DEFAULT shell — the renderer every user gets: modules render
  // as ModuleShell FACEPLATE tiles (`module-shell` / `face-*` testids). A spec
  // that needs module-INTERNAL control DOM reaches it through the face/surface
  // (or the dock full view), never through a `<type>-card` testid — those do
  // not exist in this lane.
  //
  // Inverted by the S2 fixture flip (LEG-04 / #1515): this fixture used to
  // boot the second, pre-promotion renderer.
  //
  // ⚠ ITS OPT-IN SIBLING `rackLegacy` IS GONE, and it drained to zero rather
  // than being cut short. The escape hatch existed for specs whose subject
  // still read verbatim `*Card.svelte` DOM; the S2 inversion rewrote or folded
  // every one of them except `save-group-and-naming.spec.ts`, which was its
  // LAST consumer — and that spec died with the GROUP! module rather than
  // being rewritten (owner ruling: group and sticky are deleted entirely).
  // So the fixture went with it in the same commit: a fixture nobody boots is
  // an invitation to re-open the lane, not a safety net.
  rack: async ({ page }, use, testInfo) => {
    const t0 = Date.now();
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    // The nav is SETUP, not assertion — see creditSetupBudget (#1648).
    applySetupCredit(testInfo, Date.now() - t0,'rack fixture nav');
    await use();
  },

});

export { expect };

/**
 * Credit measured SETUP wall-time back to the running test's timeout, so the
 * ASSERT phase gets the budget it declares regardless of how long booting the
 * engine and arranging the patch happened to take on a loaded runner (#1648).
 *
 * Call it at the arrange/act boundary, with a timestamp taken at the start of
 * the arrange phase:
 *
 *     const t0 = Date.now();
 *     await spawnPatch(page, [ ... ]);      // engine boot: 0.1 s .. 24.6 s
 *     creditSetupBudget(t0, 'spawnPatch');  // ← the assertions start fresh
 *
 * The mechanism, the two measured CI traces behind it, and the argument for why
 * it is NOT bound-widening (and cannot mask a hang or a slow-setup regression)
 * live on `applySetupCredit` in `./_setup-credit`, next to its negative control.
 *
 * ⚠ DELIBERATELY OPT-IN, and NOT in `_helpers.ts`. The natural home for the
 * systemic version is `spawnPatch` itself — that is where the engine boot
 * happens — and the only thing that stopped it was that `_helpers.ts` sat in
 * the collab-attest basis, so hoisting cost a re-attest. That attest was
 * deleted 2026-08-17, so the hoist is now UNBLOCKED and payable. It is still a
 * follow-up rather than a flake fix.
 */
export function creditSetupBudget(startedAtMs: number, label: string): number {
  return applySetupCredit(test.info(), Date.now() - startedAtMs, label);
}

/** The node ids the voice demo writes. Deliberately NOT exported — no spec
 *  needs them today, and this repo prunes unreferenced exports (see the
 *  `gotoCanvas` note above). Export it when something actually reads it. */
const VOICE_DEMO_NODE_IDS = ['vd-seq', 'vd-vco', 'vd-adsr', 'vd-vca', 'vd-out'] as const;

/**
 * Put the canonical VOICE DEMO on the canvas: KRIA → VCO + ADSR → VCA →
 * Audio Out, pre-loaded with an 8-note C-major motif, auto-playing.
 * (Was SEQUENCER until the deprecated sequencers were deleted 2026-08-24;
 * same 5 nodes / 6 edges / vd-* ids, so every downstream assertion keeps
 * its meaning.)
 *
 * WHY THIS EXISTS. This is byte-for-byte the graph the retired
 * `Canvas.loadExample()` wrote — the "Sequenced VCO" entry in the "Load
 * example…" topbar dropdown. That dropdown was DELETED (owner ruling: "load
 * example goes away completely"), but ~11 specs were only ever using it as a
 * FIXTURE: "give me a small, wired, audible patch so I can test Clear /
 * save-load / the context menu / docs / …". Deleting those specs would have
 * thrown away real coverage of features that have nothing to do with example
 * patches, so the fixture moved HERE and the specs now call this.
 *
 * It is deliberately the SAME 5 nodes / 6 edges with the
 * SAME params, so every downstream assertion (node counts, cable counts, the
 * `vd-*` ids, audible RMS) keeps its original meaning.
 *
 * NOT `spawnPatch()`: that helper cannot write `node.data`, and the motif lives
 * on `vd-seq.data` (KRIA's pattern record). A kria with no trigs is silent,
 * which would have quietly gutted the specs that assert the demo makes noise.
 *
 * Lives in `_fixtures.ts` (NOT `_helpers.ts`) because this is fixture-only
 * churn. (It also used to keep the collab attest hash still; that attest was
 * deleted 2026-08-17.)
 */
export async function loadVoiceDemo(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown>; __patch?: unknown };
    return typeof w.__ensureEngine === 'function' && !!w.__patch;
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __ensureEngine: () => Promise<unknown>;
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    await w.__ensureEngine();

    // The same 8-note C-major motif the dropdown's "Sequenced VCO" example
    // shipped with, re-expressed in KRIA's lane model (scale DEGREES through
    // major/C, octave lane lifting the high C): C4 G4 C5 G4 E4 C4 F4 G4.
    const track = {
      trig: [...Array.from({ length: 8 }, () => true), ...Array.from({ length: 8 }, () => false)],
      ratchet: Array.from({ length: 16 }, () => 1),
      note: [0, 4, 0, 4, 2, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0],
      octave: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      duration: Array.from({ length: 16 }, () => 0.4),
      probability: Array.from({ length: 16 }, () => 1),
      glide: Array.from({ length: 16 }, () => 0),
      loopStart: 0,
      loopLength: 8,
      timeDivision: 1,
      direction: 'forward',
      muted: false,
    };
    const silentTrack = () => ({ ...track, trig: Array.from({ length: 16 }, () => false) });
    const kriaData = {
      patterns: { '0': { tracks: [track, silentTrack(), silentTrack(), silentTrack()], scale: 'major', root: 48 } },
      active: 0,
      cued: null,
      cueSteps: 0,
    };
    const nodes: Record<
      string,
      { type: string; position: { x: number; y: number }; params: Record<string, number>; data?: Record<string, unknown> }
    > = {
      'vd-seq': {
        type: 'kria',
        position: { x: 40, y: 60 },
        params: { bpm: 180, running: 1 },
        data: kriaData,
      },
      'vd-vco': { type: 'analogVco', position: { x: 900, y: 30 }, params: {} },
      'vd-adsr': {
        type: 'adsr',
        position: { x: 900, y: 320 },
        params: { attack: 0.005, decay: 0.08, sustain: 0.3, release: 0.15 },
      },
      'vd-vca': { type: 'vca', position: { x: 1240, y: 130 }, params: { base: 0, cvAmount: 1 } },
      'vd-out': { type: 'audioOut', position: { x: 1520, y: 130 }, params: { master: 0.4 } },
    };
    const wires: Array<[string, string, string, string, string]> = [
      ['vd-seq', 'pitch1', 'vd-vco', 'pitch', 'pitch'],
      ['vd-seq', 'gate1', 'vd-adsr', 'gate', 'gate'],
      ['vd-vco', 'sine', 'vd-vca', 'audio', 'audio'],
      ['vd-adsr', 'env', 'vd-vca', 'cv', 'cv'],
      ['vd-vca', 'audio', 'vd-out', 'L', 'audio'],
      ['vd-vca', 'audio', 'vd-out', 'R', 'audio'],
    ];

    // ONE transaction: the demo is a single undo step and a single multiplayer
    // broadcast, exactly as loadExample() wrote it.
    w.__ydoc.transact(() => {
      for (const [id, n] of Object.entries(nodes)) {
        if (w.__patch.nodes[id]) continue;
        w.__patch.nodes[id] = {
          id,
          type: n.type,
          domain: 'audio',
          position: n.position,
          params: n.params,
          // No `name`: `spawnPatch` omits it too, so cards fall back to the
          // module label. (loadExample() stamped a `nextDefaultName`, which is
          // not reachable from the page and which no spec asserted on.)
          data: { ...(n.data ?? {}) },
        };
      }
      for (const [src, srcPort, dst, dstPort, type] of wires) {
        const id = `e-${src}-${srcPort}-${dst}-${dstPort}`;
        if (w.__patch.edges[id]) continue;
        w.__patch.edges[id] = {
          id,
          source: { nodeId: src, portId: srcPort },
          target: { nodeId: dst, portId: dstPort },
          sourceType: type,
          targetType: type,
        };
      }
    });
  });
  await waitForMounted(page, [...VOICE_DEMO_NODE_IDS]);
}

// ---------------------------------------------------------------------------
// THE FILE.. MENU — the only route to the actions the deleted topbar carried.
// ---------------------------------------------------------------------------
//
// The old full-width topbar put New rack / Clear / Export Perf / Load Perf /
// Raw JSON / the 5-slot preset strip / Save Set / Load Set / the account link
// on screen as bare buttons. Every one of them now lives behind
// `workflow-file-trigger`, most inside a collapsible SECTION. These helpers are
// the seam so ~a dozen specs don't each re-derive "click File, maybe click a
// section header, then click the row".
//
// Lives here (NOT `_helpers.ts`) because this is test-harness churn, not a
// multi-context helper. (It also used to keep the collab attest hash still;
// that attest was deleted 2026-08-17.)

/** Open the File.. menu (idempotent — a no-op when it is already open). */
export async function openFileMenu(page: Page): Promise<void> {
  const menu = page.getByTestId('workflow-file-menu');
  if (await menu.isVisible().catch(() => false)) return;
  await page.getByTestId('workflow-file-trigger').click();
  await expect(menu).toBeVisible();
}

/**
 * Click a File.. row by testid, opening the menu first.
 *
 * `section` expands a collapsible group before the row is reachable — pass the
 * section's OWN testid (e.g. 'workflow-file-quicksave'). Rows that sit directly
 * in the menu (New rack, Save performance, Save set, Clear) need no section.
 */
export async function fileMenuClick(
  page: Page,
  rowTestId: string,
  section?: string,
): Promise<void> {
  await openFileMenu(page);
  if (section) {
    await page.getByTestId(section).click();
  }
  await page.getByTestId(rowTestId).click();
}
