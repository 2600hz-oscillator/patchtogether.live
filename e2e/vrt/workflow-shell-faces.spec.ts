// e2e/vrt/workflow-shell-faces.spec.ts
//
// VRT: the P1 CURATED FACES — the pixel gate for every migrated module under
// `?shell=1`. Batch 1: adsr / cloudseed / kickdrum / lfo / tidyVco / vca.
// Batch 2: dx7 / qbrt / shimmershine / sixstrum / snaredrum / tomtom.
// Batch 3: delay / filter / karplus / mixer / reverb.
// Two PINNED baselines per module:
//
//   face-<type>-compact — the COMPACT LANE TILE (zoom 0.45, LOD 'compact'):
//     the design-point tile — the fit-planned curated knobs (laneBodyPlan:
//     WHOLE cells only — top-2 + the fluid domain-hued glyph for glyph faces,
//     top-3 for glyph-less) inside the uniform RACKLINE frame, exactly as the
//     lane shows it.
//   face-<type>-dock    — the DOCK FULL-VIEW faceplate (view='dock-full',
//     face tier 'dock'): the glyph hero + one labeled SECTION BAND per curated
//     `face.pages` page, ALL controls rendered — and, since
//     `fix/vrt-dock-fold-blindness`, ALL OF THEM IN THE IMAGE (see THE FOLD).
//
// The glyphs are LIVE-BOUND (shell-glyph-live.ts) but render DETERMINISTIC
// pixels here: no audio flows in these scenes, and ScopeScreen's live
// waveform mode draws the SAME flat centerline whether the tap is unattached
// or reading silence (VuMeter unlit at level 0; the adsr envelope / lfo
// wave-morph curves derive from the ParamDef defaults). Every knob sits at
// its default, so the scenes are pixel-deterministic without masks
// (animations killed via the style tag + `animations: 'disabled'`). Tight
// per-scene budgets, the workflow-shell-zoom precedent.
//
// darwin-first: darwin baselines are captured locally (3× stable); the linux
// pairs are EXEMPT_BASELINE_PAIRS-deferred until a vrt-update.yml dispatch
// lands them (vrt-meta's linux-deficit ratchet accounts for the pairs).
//
// ── THE FOLD, AND WHY THIS SCENE USED TO BE BLIND TO HALF OF IT ─────────────
//
// The dock pane is `max-height: min(60vh, 680px)` (Canvas's
// `.dock-fullview-drawer` AND DockFullView's `.dock-faceplate`) around a
// `.faceplate-scroll` overflow container. At the config's pinned 1280×720
// viewport that is 432 px, so the captured element held only the TOP FOLD of
// any taller faceplate and the rest was not in the PNG at all.
//
// MEASURED 2026-08-03 while landing PF-21 (row packing), which re-grouped the
// section bands of THIRTEEN faces: nine dock baselines went red — and
// sixstrum's, dx7's, kickdrum's, snaredrum's and drummergirl's stayed GREEN,
// pixel-identical, while the layout underneath them changed completely. The
// gate was blind to band layout on precisely the faces with the most bands.
//
// MEASURED 2026-08-08 (vrt-fold-probe, CSS px): NINE of the 21 dock baselines
// were truncated — every one committed at exactly 425 px, the clamp's height —
// hiding between 50 px (filter) and 578 px (drummergirl) of faceplate. And
// raising the viewport does NOT fix it: `min()`'s other term is a hard 680 px,
// so drummergirl / kickdrum / tidyVco / sixstrum / dx7 stay folded at ANY window
// height. The full table is in `_shell-faces.ts`.
//
// THE FIX: the dock scene runs at `FOLD_VIEWPORT` and calls `unfoldDockPane`,
// then ASSERTS `hiddenY === hiddenX === 0` before it compares pixels — so
// "the baseline did not move" now means "the faceplate did not change", which
// is the property the scene was always claimed to have. The assertion is the
// load-bearing half: a CSS override that silently stopped applying would look
// exactly like a fix.
//
// ⚠ STATE THE GATE'S SCOPE INSIDE THE GATE. What this scene STILL cannot see,
// each one asserted below rather than left to prose:
//
//   1. A TAB-RAILED face's INACTIVE bands. `dockTabPlan` gives a face with
//      ≥ DOCK_TAB_MIN_BANDS bands a tab rail, and ModuleShell then renders only
//      the active band — the others have no layout box, so no capture at any
//      height contains them. TWO faces today (cloudseed, pentemelodica: 8 bands
//      each). The dock test asserts the railed set is EXACTLY the faces whose
//      declared `pages` reaches the threshold, and that a railed face renders
//      exactly ONE band — so a new railed face is declared loudly and an
//      unrailed face that hides a band is RED. Per-tab captures would close it
//      (measured cost: +14 element captures, +28 PNGs across platforms); that is
//      a follow-up, not this PR.
//   2. The WINDOW. The capture is now the scrollable CONTENT, so this scene no
//      longer says anything about whether the faceplate is readable in a real
//      680 px pane. That question belongs to `dock-tabs-model`'s band threshold;
//      `vrt-fold-probe` prints the per-face remainder for it.
//   3. The `full` LANE tier — the in-lane expanded tile — has NO pixel scene
//      here (only 'compact' and 'dock'), so a control that clips inside a plate
//      row at that tier is invisible to every pixel gate. Structure there is
//      covered by faces-parity + module-face-lint, which read the model, not the
//      render. MEASURED as a candidate 2026-08-08: the dock test already frames
//      that tier, so adding the capture costs no extra boot — 3× repeat came in
//      at 74 s/run vs 76 s/run WITHOUT it, i.e. inside the ±4 s run-to-run noise,
//      zero flakes, and 280 KiB for 21 darwin PNGs (~12 KiB each at 134×180).
//      Deliberately NOT bundled with the fold fix: it is a separate coverage
//      change that adds 42 baselines across platforms, and this PR already moves
//      nine while two other baseline-touching PRs are in flight.
//   4. Anything inside the per-scene budget (COMPACT_MAX_DIFF / DOCK_MAX_DIFF).
//      A sub-tolerance render change is invisible to the gate AND unfixable by
//      `--update-snapshots`; see the A2/#1213 note in CLAUDE.md.
//   5. The capture is `.dock-faceplate`, whose 4 px `padding-bottom` is
//      TRANSPARENT — so the bottom four rows of every dock baseline pin whatever
//      canvas sits behind the drawer, not the faceplate. Measured at 15 px of
//      the 1500 px budget (85 px on cloudseed) when the flow pane's height
//      changes. It is contamination rather than blindness, it costs 1 % of the
//      budget, and removing it means capturing `.faceplate` instead — which
//      moves all 21 baselines again. Recorded, not silently absorbed.
//   6. THE LANE. This spec is in vrt.config's FULL_MATCH, not STRICT_MATCH, so
//      it runs in ci.yml's `vrt` job — `continue-on-error: true`, outside the
//      `ci` umbrella's needs. A moved baseline therefore posts a diff gallery
//      and a PR comment; it does NOT block the merge. "Impossible to miss" here
//      means VISIBLE, not ENFORCED. Promoting these scenes to `vrt-strict` is a
//      required-check change with its own wall-time argument, not this PR's.
//
// The band structure additionally has non-pixel gates: `faceplate-platform.
// spec.ts` (the PF-21 row sweep + the annotation/sidebar sweeps) and the pure
// `dock-row-plan` / `module-face-lint` units, which read the whole faceplate.

import { test, expect } from '@playwright/test';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';
import { diffRegion } from './vrt-surface-stats';
import { DOCK_TAB_MIN_BANDS } from '../../packages/web/src/lib/ui/workflow/dock-tabs-model';
import {
  COMPACT_MAX_DIFF,
  DOCK_MAX_DIFF,
  FACES,
  FOLD_VIEWPORT,
  LEGACY_FOLD_CLAMP_PX,
  LEGACY_FOLD_PX,
  LEGACY_FOLD_VIEWPORT,
  bootWithFace,
  frameMember,
  lowestBand,
  openDock,
  perturbBand,
  perturbBandFolded,
  readFoldGeometry,
  refoldDockPane,
  settle,
  unfoldDockPane,
} from './_shell-faces';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';
test.describe.configure({ mode: 'default' });

/** The per-channel delta (0-255) at which `diffRegion` counts a pixel as
 *  different. 26 ≈ Playwright's own `threshold: 0.1` in vrt.config, so the
 *  negative control's pixel counts are directly comparable to the budget the
 *  real gate applies. */
const NC_CHANNEL_DELTA = 26;
/** The negative control's perturbation: shift one band sideways. CSS px. */
const NC_SHIFT_PX = 8;

test.describe('VRT: P1 curated faces (?shell=1) — compact lane tile + dock full-view', () => {
  for (const { type, pages } of FACES) {
    test(`face-${type}-compact: the compact lane tile matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/face-${type}-compact`),
        `face-${type}-compact on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      // The compact tile is pinned at the config viewport — the dock scene's
      // taller one would be a baseline move for no reason.
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      const memberId = await bootWithFace(page, type);
      // zoom 0.45 = the LOD 'compact' band [0.30, 0.52) — the design-point tile.
      await frameMember(page, memberId, 0.45, 'compact');

      const tile = page.locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`);
      await expect(tile).toHaveScreenshot(`face-${type}-compact.png`, {
        maxDiffPixels: COMPACT_MAX_DIFF,
      });

      expect(
        errors.filter((e) => !/getUserMedia|audio/i.test(e)),
        `pageerrors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });

    test(`face-${type}-dock: the dock full-view faceplate matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/face-${type}-dock`),
        `face-${type}-dock on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.setViewportSize(FOLD_VIEWPORT);
      const memberId = await bootWithFace(page, type);
      // Frame at the 'full' tier so the jack-rail EXPAND affordance is
      // comfortably clickable, then open the dock full-view.
      await frameMember(page, memberId, 0.7, 'full');
      const faceplate = await openDock(page, memberId, pages);
      await unfoldDockPane(page);

      // ── THE CAPTURE BOX CONTAINS THE WHOLE FACEPLATE ────────────────────
      // Asserted, not assumed: this is what makes "the baseline did not move"
      // mean "the faceplate did not change". Units: CSS px (the dock drawer is
      // a sibling of xyflow's zoom transform, not inside it, so these ARE the
      // PNG's pixels at DPR 1).
      const g = await readFoldGeometry(page);
      expect(
        g.hiddenY,
        `face-${type}-dock: ${g.hiddenY} CSS px of faceplate below the capture box ` +
          `(content ${g.scrollH}, shown ${g.clientH}). The dock pane's ` +
          `max-height clamp is still applying — a below-fold change would be invisible.`,
      ).toBe(0);
      expect(
        g.hiddenX,
        `face-${type}-dock: ${g.hiddenX} CSS px of faceplate right of the capture box ` +
          `(content ${g.scrollW}, shown ${g.clientW}).`,
      ).toBe(0);
      // The pane grows UPWARD from `bottom: 0` in a non-scrolling container, so
      // a pane taller than the window is unreachable rather than merely
      // cropped. Fail with the number to raise instead of a mystery capture.
      expect(
        g.topY,
        `face-${type}-dock: the unfolded pane starts at y=${g.topY} in a ${g.viewportH} px ` +
          `viewport — it has grown off the top of the window. Raise FOLD_VIEWPORT.height ` +
          `in _shell-faces.ts (pane is ${g.captureH} CSS px tall).`,
      ).toBeGreaterThanOrEqual(0);

      // ── RESIDUAL SCOPE #1, ASSERTED: the tab rail ───────────────────────
      // A railed face renders ONE band; every other face renders all of them.
      // Derived from the SAME threshold DockFullView and ModuleShell branch on,
      // so a new railed face auto-enrols and cannot drift.
      const railed = pages >= DOCK_TAB_MIN_BANDS;
      expect(
        g.tabs > 0,
        `face-${type}-dock: ${pages} declared bands vs DOCK_TAB_MIN_BANDS=${DOCK_TAB_MIN_BANDS} ` +
          `says railed=${railed}, but the faceplate rendered ${g.tabs} tab chips.`,
      ).toBe(railed);
      expect(
        g.renderedBands,
        railed
          ? `face-${type}-dock: a TAB-RAILED face shows one band at a time; ${g.renderedBands} ` +
            `of ${g.bands.length} have a layout box. The other ${g.bands.length - g.renderedBands} ` +
            `are NOT in this capture at any pane height — the scene's stated residual scope.`
          : `face-${type}-dock: ${g.renderedBands} of ${g.bands.length} bands have a layout box. ` +
            `An unrailed face must render every band, or the capture is silently partial.`,
      ).toBe(railed ? 1 : g.bands.length);

      await settle(page);
      await expect(faceplate).toHaveScreenshot(`face-${type}-dock.png`, {
        maxDiffPixels: DOCK_MAX_DIFF,
      });

      expect(
        errors.filter((e) => !/getUserMedia|audio/i.test(e)),
        `pageerrors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });
  }

  // ── THE PERMANENT NEGATIVE CONTROL ────────────────────────────────────────
  //
  // A gate that cannot demonstrate it sees the thing it exists to see IS the
  // defect. So this runs on EVERY VRT run rather than once at authoring time,
  // and it moves the instrument in BOTH directions on one page:
  //
  //   UNPERTURBED  captured twice → must be pixel-identical   (green stays green)
  //   PERTURBED    one band below the old fold shifted 8 px   (the gate reddens
  //                → must differ by MORE than DOCK_MAX_DIFF,   by its own budget)
  //                with the differing pixels BELOW the old fold
  //   THE SAME PERTURBATION UNDER THE OLD 425 px CLAMP → must be pixel-IDENTICAL,
  //                which is the pre-fix blindness, permanently on the record.
  //
  // sixstrum is the subject because it is one of the five faces the PF-21 report
  // named as staying green through a whole-layout change. The test asserts it
  // still qualifies (its lowest band must start below LEGACY_FOLD_PX) instead of
  // trusting that, so a face redesign cannot leave the control poking at pixels
  // the old capture could already see — the way an opt-in guard rots.
  test('dock fold negative control: the capture sees below the old fold, and the old one did not', async ({
    page,
  }) => {
    const NC_FACE = 'sixstrum';
    const entry = FACES.find((f) => f.type === NC_FACE);
    expect(entry, `${NC_FACE} is still in the FACES roster`).toBeDefined();

    await page.setViewportSize(FOLD_VIEWPORT);
    const memberId = await bootWithFace(page, NC_FACE);
    await frameMember(page, memberId, 0.7, 'full');
    const faceplate = await openDock(page, memberId, entry!.pages);
    await unfoldDockPane(page);

    const g = await readFoldGeometry(page);
    const band = lowestBand(g);
    expect(g.hiddenY, `${NC_FACE}: the unfolded pane must contain the whole faceplate`).toBe(0);
    // ANCHORED TO THE ARTIFACT: the perturbed band has to be somewhere the OLD
    // capture box could not reach, or the control proves nothing.
    expect(
      band.top,
      `${NC_FACE}: the lowest band '${band.id}' starts at y=${band.top} CSS px, which the ` +
        `old ${LEGACY_FOLD_PX} px capture could already see. This control is vacuous — ` +
        `perturb a band that is genuinely below the fold, or retire it.`,
    ).toBeGreaterThan(LEGACY_FOLD_PX);

    const unperturbed = await faceplate.screenshot({ animations: 'disabled' });
    const unperturbedAgain = await faceplate.screenshot({ animations: 'disabled' });
    await perturbBand(page, band.id, NC_SHIFT_PX);
    const perturbed = await faceplate.screenshot({ animations: 'disabled' });

    await refoldDockPane(page, LEGACY_FOLD_CLAMP_PX);
    const foldedClean = await faceplate.screenshot({ animations: 'disabled' });
    await perturbBandFolded(page, band.id, NC_SHIFT_PX, LEGACY_FOLD_CLAMP_PX);
    const foldedPerturbed = await faceplate.screenshot({ animations: 'disabled' });

    const b64 = (b: Buffer): string => b.toString('base64');
    const stable = await diffRegion(page, b64(unperturbed), b64(unperturbedAgain), NC_CHANNEL_DELTA);
    const sees = await diffRegion(page, b64(unperturbed), b64(perturbed), NC_CHANNEL_DELTA);
    const blind = await diffRegion(page, b64(foldedClean), b64(foldedPerturbed), NC_CHANNEL_DELTA);

    // eslint-disable-next-line no-console
    console.log(
      `[fold-nc] ${NC_FACE} band='${band.id}' @${band.top}+${band.h} shift=${NC_SHIFT_PX}px ` +
        `channelDelta=${NC_CHANNEL_DELTA}/255 budget=${DOCK_MAX_DIFF}px\n` +
        `[fold-nc]   unfolded ${sees.width}x${sees.height}: stable=${stable.diffPixels}px ` +
        `perturbed=${sees.diffPixels}px box=${JSON.stringify(sees.box)}\n` +
        `[fold-nc]   folded@${LEGACY_FOLD_CLAMP_PX} ${blind.width}x${blind.height}: ` +
        `perturbed=${blind.diffPixels}px box=${JSON.stringify(blind.box)}`,
    );

    // LEG 1 — an unperturbed capture is stable, so a non-zero count below means
    // the perturbation and nothing else.
    expect(
      stable.diffPixels,
      `${NC_FACE}: two unperturbed captures differ by ${stable.diffPixels} px — the scene is ` +
        `not deterministic, so neither leg below proves anything.`,
    ).toBe(0);

    // LEG 2 — the gate SEES a below-fold change, by more than its own budget.
    expect(
      sees.diffPixels,
      `${NC_FACE}: shifting band '${band.id}' (y=${band.top}, below the old ${LEGACY_FOLD_PX} px ` +
        `fold) by ${NC_SHIFT_PX} px moved only ${sees.diffPixels} px, which is inside the ` +
        `${DOCK_MAX_DIFF} px budget. The capture is not actually seeing that band.`,
    ).toBeGreaterThan(DOCK_MAX_DIFF);
    expect(
      sees.box?.y0 ?? -1,
      `${NC_FACE}: the differing pixels start at y=${sees.box?.y0} but the perturbed band is at ` +
        `y=${band.top}. Something ABOVE the fold moved — the control is measuring the wrong thing.`,
    ).toBeGreaterThanOrEqual(band.top - 2);

    // LEG 3 — the PRE-FIX capture box could not see it. This is the defect,
    // kept executable so nobody has to take the report on faith, and so a
    // regression that re-clamps the pane fails HERE with the reason.
    expect(
      blind.height,
      `${NC_FACE}: the re-clamped capture is ${blind.height} px tall, not ~${LEGACY_FOLD_PX} — ` +
        `the fold override did not take, so leg 3 is vacuous.`,
    ).toBeLessThanOrEqual(LEGACY_FOLD_PX + 2);
    expect(
      blind.diffPixels,
      `${NC_FACE}: under the old ${LEGACY_FOLD_CLAMP_PX} px clamp the SAME perturbation moved ` +
        `${blind.diffPixels} px. It is supposed to move ZERO — that blindness is the whole ` +
        `reason this scene was widened. A non-zero count means the clamp is no longer where ` +
        `the fold was, and this leg no longer documents anything.`,
    ).toBe(0);
  });
});
