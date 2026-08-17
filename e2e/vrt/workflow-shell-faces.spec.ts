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
// pixels here, and since `fix/vrt-face-audio-freeze` that is a property of the
// SCENE rather than of the roster: `bootWithFace` SUSPENDS THE AUDIOCONTEXT
// before the tile is framed, so each face's glyph tap is an analyser on a
// stopped graph and ScopeScreen's live waveform mode draws the flat centreline
// (VuMeter unlit at level 0; the adsr envelope / lfo wave-morph curves derive
// from the ParamDef defaults). Every knob sits at its default, so the scenes
// are pixel-deterministic without masks (animations killed via the style tag +
// `animations: 'disabled'`). Tight per-scene budgets, the workflow-shell-zoom
// precedent.
//
// ⚠ THIS HEADER USED TO SAY "no audio flows in these scenes", and that sentence
// was the defect. Nothing suspended anything; every face captured off a LIVE
// graph and every one of them passed, because the whole roster is struck or
// silent so its analyser held zeros either way. The first FREE-RUNNING voice
// falsified it — analogVco's tile measured 254 / 154 / 315 px across three
// consecutive captures on one commit and its face was dropped for it
// (strict-faces.ts). The freeze is asserted, at boot AND again at capture time,
// and negative-controlled on every run by the audio-freeze control below.
//
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.
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
//   6. ~~THE LANE.~~ CLOSED 2026-08-12 — and it was the most expensive item on
//      this list, because it silently subsumed all five above it. This note
//      used to read: "it runs in ci.yml's `vrt` job — `continue-on-error: true`
//      … it does NOT block the merge. 'Impossible to miss' here means VISIBLE,
//      not ENFORCED. Promoting these scenes to `vrt-strict` is a required-check
//      change with its own wall-time argument, not this PR's."
//
//      It stayed a follow-up long enough to be demonstrated twice. #1468
//      removed a sidebar block from twelve modules and merged with all twelve
//      dock baselines stale; the required lane was green throughout. Every
//      residual scope declared above is a statement about a gate that COULD NOT
//      FAIL A MERGE, which makes the declarations bookkeeping rather than
//      protection.
//
//      The spec is now in vrt.config's STRICT_MATCH as well as FULL_MATCH, so
//      it runs in the REQUIRED `vrt-strict` job. Measured cost and the
//      time-to-merge argument are in vrt.config.ts beside the list; the short
//      version is +9.56 min on a job that was 6.6 min against a 16.14 min
//      critical path, i.e. ~zero time-to-merge delta.
//
// The band structure additionally has non-pixel gates: `faceplate-platform.
// spec.ts` (the PF-21 row sweep + the annotation/sidebar sweeps) and the pure
// `dock-row-plan` / `module-face-lint` units, which read the whole faceplate.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffRegion } from './vrt-surface-stats';
import { DOCK_TAB_MIN_BANDS } from '../../packages/web/src/lib/ui/workflow/dock-tabs-model';
import { STRICT_FACES } from '../../packages/web/src/lib/ui/workflow/strict-faces';
import {
  COMPACT_MAX_DIFF,
  DOCK_MAX_DIFF,
  FACES,
  FOLD_VIEWPORT,
  foldViewportFor,
  LEGACY_FOLD_CLAMP_PX,
  LEGACY_FOLD_PX,
  LEGACY_FOLD_VIEWPORT,
  assertFaceAudioFrozen,
  bootWithFace,
  frameMember,
  freezeFaceAudio,
  lowestBand,
  openDock,
  perturbBand,
  perturbBandFolded,
  readFaceAudio,
  readFoldGeometry,
  refoldDockPane,
  settle,
  unfoldDockPane,
} from './_shell-faces';
import { readAudioClock, resumeAudioContext } from './vrt-audio-freeze';

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
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      // The compact tile is pinned at the config viewport — the dock scene's
      // taller one would be a baseline move for no reason.
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      const memberId = await bootWithFace(page, type);
      // zoom 0.45 = the LOD 'compact' band [0.30, 0.52) — the design-point tile.
      await frameMember(page, memberId, 0.45, 'compact');

      // ── THE AUDIO GRAPH IS STILL FROZEN AT CAPTURE TIME ─────────────────
      // Asserted here, not merely at boot. The glyph is an AnalyserNode view of
      // this module's own output (shell-glyph-live.ts), so a graph that resumed
      // between boot and capture makes the tile a moving target — which is
      // exactly how a free-running voice was found to be unbaselinable.
      // RE-FREEZE, don't merely detect (#1546). `bootWithFace` suspends and
      // retries, but a resume that lands AFTER its last retry and BEFORE this
      // point turned vrt-strict — a REQUIRED, retries:0 lane — red on an
      // unrelated PR. `freezeFaceAudio` re-applies the suspend (6 attempts,
      // settling 3 real frames each) and ENDS with `assertFaceAudioFrozen`, so
      // this is strictly stronger than the bare assert it replaces: same
      // two-sided check (state AND a pinned currentTime), with the window
      // closed instead of reported.
      await freezeFaceAudio(page, `face-${type}-compact`);
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
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      // PER-SCENE, never the bare constant: a face whose unfolded pane is taller
      // than the shared default needs its own window, and raising the shared one
      // was MEASURED to move every other dock scene's pixels (see
      // `foldViewportFor`). `mixmstrs` is the case that found it.
      await page.setViewportSize(foldViewportFor(type));
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

      // Re-assert AFTER the dock click — this scene is the one that interacts
      // between boot and capture, and `ensureEngine()` resumes a suspended
      // context on every call.
      // Same as the compact capture above — and this one has a dock
      // interaction between boot and capture, which is exactly where
      // `ensureEngine()` resumes the context.
      await freezeFaceAudio(page, `face-${type}-dock`);
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

  // ── THE ROSTER IS DENY-BY-DEFAULT, AND THE BASELINES MUST EXIST ──────────
  //
  // ⚠ PROMOTING THIS SPEC INTO THE REQUIRED LANE FIXES NOTHING FOR A FACE THAT
  // IS NOT IN IT. `FACES` is a hand-maintained array in `_shell-faces.ts` and
  // `STRICT_FACES` is a hand-maintained set in `strict-faces.ts`; they happen
  // to agree today and NOTHING ASSERTED THAT. A face promoted to STRICT_FACES
  // without a `FACES` entry generates no scene, so there is nothing to compare,
  // nothing to be stale, and nothing to go red — a module fully shipped to the
  // dock with zero pixel coverage, in the lane that now gates merges. That is
  // the same shape as the lane hole itself: a gate whose SUBJECT is opt-in.
  //
  // Set equality in BOTH directions, and both directions have teeth:
  //   * in STRICT_FACES, not in FACES → a shipped face with no pixel scene.
  //   * in FACES, not in STRICT_FACES → a scene for a face users cannot reach,
  //     i.e. two baselines nobody is looking at, and an entry that will read as
  //     "covered" in any audit of this file.
  //
  // Plus the baselines themselves: `toHaveScreenshot` WRITES a missing snapshot
  // and fails, which is correct but arrives mid-sweep after a full boot. This
  // says it in the first second of the job, names every missing file at once,
  // and — the part that matters — cannot be satisfied by the run itself. A
  // `git rm`-ed baseline silently recreated by a later plain VRT run (the
  // standing hazard in CLAUDE.md) is an UNTRACKED png; this leg reads the
  // filesystem, so it goes green again only when someone commits it.
  test('every shipped face has a scene, and every scene has its baselines', () => {
    // Widened to Set<string> so `.has()` accepts entries read from
    // STRICT_FACES (ReadonlySet<string>) — the comparison is the point.
    const rostered = new Set<string>(FACES.map((f) => f.type));
    const missingScene = [...STRICT_FACES].filter((t) => !rostered.has(t)).sort();
    const orphanScene = [...rostered].filter((t) => !STRICT_FACES.has(t)).sort();

    expect(
      missingScene,
      `these modules are in STRICT_FACES — they render a curated faceplate to real ` +
        `users — but have NO entry in the FACES roster, so this spec generates no ` +
        `scene for them and no pixel gate covers them at any tier. Add ` +
        `{ type, pages } to FACES in _shell-faces.ts and capture the baselines ` +
        `(\`task vrt:commit\`).`,
    ).toEqual([]);
    expect(
      orphanScene,
      `these have VRT scenes but are not in STRICT_FACES, so they are not shipped ` +
        `as faces. Either promote them or delete the roster entries — a scene for ` +
        `an unreachable face is two baselines nobody reads that still read as ` +
        `coverage.`,
    ).toEqual([]);
    // NON-VACUITY: both lists being empty is also what a failure to load either
    // side looks like. Anchor to the artifacts.
    expect(rostered.size, 'the FACES roster is empty — did the import resolve?').toBeGreaterThan(0);
    expect(STRICT_FACES.size, 'STRICT_FACES is empty — did the import resolve?').toBeGreaterThan(0);

    const missingBaseline: string[] = [];
    for (const { type } of FACES) {
      for (const variant of ['compact', 'dock'] as const) {
        const rel = `./__screenshots__/workflow-shell-faces.spec.ts/face-${type}-${variant}.png`;
        if (!existsSync(fileURLToPath(new URL(rel, import.meta.url)))) {
          missingBaseline.push(`face-${type}-${variant}.png`);
        }
      }
    }
    expect(
      missingBaseline,
      `these baselines are not committed. Playwright would WRITE them and fail ` +
        `mid-sweep, which looks like a capture problem rather than a missing pin; ` +
        `worse, a plain VRT run recreates a deleted one as an UNTRACKED file that ` +
        `no gate reads. Capture with \`task vrt:commit\` and commit the result.`,
    ).toEqual([]);
  });

  // ── THE PERMANENT NEGATIVE CONTROL FOR THE AUDIO FREEZE ───────────────────
  //
  // `bootWithFace` suspends the AudioContext so the analyser-fed face glyphs
  // stop advancing. Every scene above then passes — and would pass identically
  // if the freeze were a no-op, because NO MODULE IN THE ROSTER SOUNDS AT
  // SPAWN. That is precisely the shape of the bug this fix is for: the scene
  // asserted a property of the ROSTER and called it a property of itself.
  //
  // So the control MANUFACTURES the missing condition. It spawns a genuinely
  // free-running voice into lane 1 ahead of a faced processor — a channel
  // column IS the chain, so the face's live-audio glyph is then tracing a real
  // moving waveform — and drives the instrument in both directions:
  //
  //   0  NON-VACUITY   the face's own output must actually be SOUNDING and
  //                    MOVING unfrozen, or every leg below is about silence
  //   1  THE ASSERTION CAN GO RED   assertFaceAudioFrozen must REJECT on a
  //                    running graph (and the clock must be seen advancing)
  //   2  THE PIXELS MOVE   three consecutive captures of the tile differ
  //   3  FROZEN ⇒ STABLE   three consecutive captures are pixel-IDENTICAL
  //   4  FROZEN ⇒ REPRODUCIBLE ACROSS BOOTS   a second, INDEPENDENT boot
  //                    produces a byte-identical tile
  //
  // ⚠ LEG 4 IS NOT A DUPLICATE OF LEG 3, and it is the one that earns its
  // runtime. A suspend pins the analyser wherever its window happened to be, so
  // freezing AFTER the glyph tap has attached is perfectly stable within a run
  // and different every run — which passes leg 3 and can still never match a
  // baseline. MEASURED on this exact pair: freeze inside bootWithFace → 0 px
  // across two boots; freeze after frameMember → 106 px, all of it inside the
  // glyph box. Only leg 4 tells those apart.
  //
  // The source is asserted to still be free-running rather than assumed, so a
  // module change cannot leave the control quietly measuring silence.
  test('face audio freeze negative control: a sounding face is unstable RUNNING, identical FROZEN', async ({
    page,
  }) => {
    // THREE boots (running, then two independent frozen ones) against a config
    // default of 30 s. 6.7 s locally, but the boots are renderer-paced and CI
    // renders on SwiftShader — a budget that fits locally with 4× headroom is
    // the classic way to buy a CI-only timeout. This bounds the failure; it is
    // not a gate on anything.
    test.setTimeout(120_000);
    // A faced PROCESSOR (live-audio glyph on its own output) fed by a
    // free-running VOICE. macrooscillator is one of the two faces this defect
    // blocks; using it as the SOURCE keeps the control honest without giving it
    // a face.
    const NC_AUDIO_FACE = 'filter';
    const NC_SOURCE = 'macrooscillator';
    expect(
      FACES.some((f) => f.type === NC_AUDIO_FACE),
      `${NC_AUDIO_FACE} is still in the FACES roster`,
    ).toBe(true);
    const sel = (id: string): string =>
      `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`;
    const b64 = (b: Buffer): string => b.toString('base64');

    // ── BOOT 1: the graph left RUNNING ────────────────────────────────────
    await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
    const runId = await bootWithFace(page, NC_AUDIO_FACE, {
      freezeAudio: false,
      upstream: NC_SOURCE,
    });
    await frameMember(page, runId, 0.45, 'compact');

    // LEG 0 — ANCHORED TO THE ARTIFACT.
    const live = await readFaceAudio(page, runId);
    expect(
      live.tapped,
      `${NC_AUDIO_FACE}: no analyser could attach to its '${live.portId}' output — the control ` +
        `cannot see the signal it is about to reason about.`,
    ).toBe(true);
    expect(
      live.peak,
      `${NC_AUDIO_FACE} downstream of ${NC_SOURCE}: peak amplitude is ${live.peak} — the chain is ` +
        `SILENT, so "the capture is unstable" below would be measuring nothing. Either the column ` +
        `chain stopped wiring source→processor, or ${NC_SOURCE} stopped free-running. Pick a ` +
        `source that does, or retire this control — do not let it pass on silence.`,
    ).toBeGreaterThan(0.01);
    expect(
      live.moving,
      `${NC_AUDIO_FACE}: the analyser window is not ADVANCING (moving=${live.moving}) even though ` +
        `peak=${live.peak}. A held DC level has no time-domain motion, so the glyph would be ` +
        `stable for a reason that has nothing to do with the freeze.`,
    ).toBeGreaterThan(0.01);

    // LEG 1 — the freeze assertion is capable of failing.
    const running = await readAudioClock(page);
    expect(running.state, 'the control really is driving a RUNNING graph').toBe('running');
    await expect(
      assertFaceAudioFrozen(page, `${NC_AUDIO_FACE} (negative control)`),
      'assertFaceAudioFrozen must REJECT on a running graph — otherwise every green ' +
        'freeze assertion in this file means nothing.',
    ).rejects.toThrow(/not 'suspended'|advanced/);

    // LEG 2 — the pixels genuinely move.
    const r1 = await page.locator(sel(runId)).screenshot({ animations: 'disabled' });
    const r2 = await page.locator(sel(runId)).screenshot({ animations: 'disabled' });
    const r3 = await page.locator(sel(runId)).screenshot({ animations: 'disabled' });
    const rd12 = await diffRegion(page, b64(r1), b64(r2), NC_CHANNEL_DELTA);
    const rd23 = await diffRegion(page, b64(r2), b64(r3), NC_CHANNEL_DELTA);

    // LEG 3 — freeze the SAME page and the tile settles.
    await freezeFaceAudio(page, `${NC_AUDIO_FACE} (negative control)`);
    const f1 = await page.locator(sel(runId)).screenshot({ animations: 'disabled' });
    const f2 = await page.locator(sel(runId)).screenshot({ animations: 'disabled' });
    const f3 = await page.locator(sel(runId)).screenshot({ animations: 'disabled' });
    const fd12 = await diffRegion(page, b64(f1), b64(f2), NC_CHANNEL_DELTA);
    const fd23 = await diffRegion(page, b64(f2), b64(f3), NC_CHANNEL_DELTA);

    // ── BOOT 2 + 3: two INDEPENDENT boots, each frozen by bootWithFace ─────
    const bootFrozen = async (): Promise<Buffer> => {
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      const id = await bootWithFace(page, NC_AUDIO_FACE, { upstream: NC_SOURCE });
      await frameMember(page, id, 0.45, 'compact');
      await assertFaceAudioFrozen(page, `${NC_AUDIO_FACE} (negative control, reboot)`);
      return page.locator(sel(id)).screenshot({ animations: 'disabled' });
    };
    const bootA = await bootFrozen();
    const bootB = await bootFrozen();
    const across = await diffRegion(page, b64(bootA), b64(bootB), NC_CHANNEL_DELTA);

    // eslint-disable-next-line no-console
    console.log(
      `[audio-nc] ${NC_AUDIO_FACE} ← ${NC_SOURCE}  tile=${rd12.width}x${rd12.height} ` +
        `channelDelta=${NC_CHANNEL_DELTA}/255 budget=${COMPACT_MAX_DIFF}px\n` +
        `[audio-nc]   source: port=${live.portId} peak=${live.peak.toFixed(6)} ` +
        `moving=${live.moving.toFixed(6)}\n` +
        `[audio-nc]   RUNNING  d12=${rd12.diffPixels}px d23=${rd23.diffPixels}px ` +
        `box=${JSON.stringify(rd12.box)}\n` +
        `[audio-nc]   FROZEN   d12=${fd12.diffPixels}px d23=${fd23.diffPixels}px\n` +
        `[audio-nc]   FROZEN, TWO INDEPENDENT BOOTS  ${across.diffPixels}px ` +
        `box=${JSON.stringify(across.box)}`,
    );

    expect(
      Math.min(rd12.diffPixels, rd23.diffPixels),
      `${NC_AUDIO_FACE} ← ${NC_SOURCE}: with the graph RUNNING, three consecutive captures of the ` +
        `tile came back identical (${rd12.diffPixels}px / ${rd23.diffPixels}px). This control ` +
        `exists to show the scene CAN be destabilised by live audio; if it cannot, the freeze ` +
        `below is proving nothing.`,
    ).toBeGreaterThan(0);
    expect(
      fd12.diffPixels,
      `${NC_AUDIO_FACE}: FROZEN, captures 1→2 differ by ${fd12.diffPixels}px. toHaveScreenshot ` +
        `needs two consecutive IDENTICAL captures before it will even compare to a baseline.`,
    ).toBe(0);
    expect(fd23.diffPixels, `${NC_AUDIO_FACE}: FROZEN, captures 2→3`).toBe(0);
    expect(
      across.diffPixels,
      `${NC_AUDIO_FACE}: two INDEPENDENT frozen boots differ by ${across.diffPixels}px ` +
        `(box ${JSON.stringify(across.box)}). Within-run stability is not enough — a baseline is ` +
        `a comparison ACROSS boots. This is what a freeze applied AFTER the glyph tap attached ` +
        `looks like: the analyser is pinned at a different phase each boot. Measured at 106px ` +
        `for that ordering, 0px when bootWithFace freezes before frameMember.`,
    ).toBe(0);

    // Leave the page as we found it, so a later fixture reuse can't inherit a
    // suspended graph and pass leg 1 for the wrong reason.
    await resumeAudioContext(page);
  });

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

    await page.setViewportSize(foldViewportFor(NC_FACE));
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
    // Two-sided on purpose: a clamp that came out SHORTER than the old fold
    // would also report 0 px below, and would be a different (easier) claim
    // than the one this leg is making.
    expect(
      blind.height,
      `${NC_FACE}: the re-clamped capture is ${blind.height} px tall, not the ${LEGACY_FOLD_PX} px ` +
        `the old ${LEGACY_FOLD_CLAMP_PX} px clamp produced — this is not a reproduction of the ` +
        `pre-fix capture box, so leg 3 is vacuous.`,
    ).toBeGreaterThanOrEqual(LEGACY_FOLD_PX - 2);
    expect(blind.height, `${NC_FACE}: re-clamped capture height`).toBeLessThanOrEqual(
      LEGACY_FOLD_PX + 2,
    );
    expect(
      blind.diffPixels,
      `${NC_FACE}: under the old ${LEGACY_FOLD_CLAMP_PX} px clamp the SAME perturbation moved ` +
        `${blind.diffPixels} px. It is supposed to move ZERO — that blindness is the whole ` +
        `reason this scene was widened. A non-zero count means the clamp is no longer where ` +
        `the fold was, and this leg no longer documents anything.`,
    ).toBe(0);
  });
});
