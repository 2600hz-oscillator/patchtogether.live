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
//   4. ~~Anything inside the per-scene budget (COMPACT_MAX_DIFF /
//      DOCK_MAX_DIFF).~~ CLOSED 2026-08-25. It used to read: "a sub-tolerance
//      render change is invisible to the gate AND unfixable by
//      `--update-snapshots`; see the A2/#1213 note in CLAUDE.md." Both budgets
//      are now ZERO, as are vrt.config's `threshold` and `maxDiffPixelRatio`,
//      so there is no longer a band of change this gate cannot see — and the
//      `--update-snapshots` half goes with it, since a stale baseline now
//      FAILS and is therefore rewritable. What made that safe is measured, not
//      hoped: every face scene in the roster but three was bit-exact across two
//      cold ubuntu boots (vrt-determinism-probe), and the three were two
//      unpinned simulations, fixed in the same diff.
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

import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffRegion } from './vrt-surface-stats';
import { DOCK_TAB_MIN_BANDS } from '../../packages/web/src/lib/ui/workflow/dock-tabs-model';
import { STRICT_FACES } from '../../packages/web/src/lib/ui/workflow/strict-faces';
import {
  COMPACT_MAX_DIFF,
  DOCK_MAX_DIFF,
  FACES,
  FACES_WITHOUT_SCENES,
  FACE_TIERS,
  faceTiers,
  type FaceTier,
  FOLD_VIEWPORT,
  ROSTERED_FACE_TYPES,
  foldViewportFor,
  LEGACY_FOLD_CLAMP_PX,
  LEGACY_FOLD_PX,
  LEGACY_FOLD_VIEWPORT,
  assertFaceAudioFrozen,
  awaitFaceVideoPainted,
  bootWithFace,
  faceSceneTimeout,
  frameMember,
  freezeFaceAudio,
  freezeFaceVideo,
  lowestBand,
  openDock,
  perturbBand,
  perturbBandFolded,
  readFaceAudio,
  readFoldGeometry,
  refoldDockPane,
  settle,
  unfoldDockPane,
  FREEZE_RACE_FRAMES,
  type BootFaceOptions,
} from './_shell-faces';
import {
  armOneShotResume,
  oneShotResumeFired,
  readAudioClock,
  resumeAudioContext,
} from './vrt-audio-freeze';

test.describe.configure({ mode: 'default' });

/** The per-channel delta (0-255) at which `diffRegion` counts a pixel as
 *  different, for the NEGATIVE CONTROLS in this file only — never for the gate.
 *
 *  ⚠ IT NO LONGER MIRRORS THE GATE. This used to read "26 ≈ Playwright's own
 *  `threshold: 0.1` in vrt.config, so the negative control's pixel counts are
 *  directly comparable to the budget the real gate applies", and as of
 *  2026-08-25 that budget is ZERO on all four knobs. Kept at 26 on purpose: the
 *  controls below exist to prove the capture SEES a deliberate perturbation (an
 *  8 px band shift, a live analyser trace), and a coarse delta makes that claim
 *  about a real visual change rather than about shimmer. The gate's own bar is
 *  proved on every run by the baseline comparisons themselves, which are now
 *  byte-exact — a strictly stronger permanent control than this constant. */
const NC_CHANNEL_DELTA = 26;
/** The negative control's perturbation: shift one band sideways. CSS px. */
const NC_SHIFT_PX = 8;

// ── COMPACT BY DEFAULT — THE WIDTH GATE ────────────────────────────────────
//
// Owner ruling 2026-08-17: *"we do not want useless gray horizontal space on
// cards, ever. prefer compact. screen real estate is expensive!"* Width is
// EARNED and the burden of proof is on the wide face, so the check is
// deny-by-default over the LIVE layout of every face in the roster.
//
// ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE. It reads GEOMETRY, so it cannot
// tell "intentionally roomy" from "accidentally double-wide" — the two are the
// same number. That is exactly why an exemption is a NAME plus the thing
// consuming the width, and why no amount of tuning the ceiling would replace
// them. It also cannot see:
//   * the LANE tile, which is a fixed 192 px pin by design and whose analogous
//     guarantee is `laneBodyPlan`'s no-clip rule, asserted elsewhere;
//   * whether narrowing CLIPPED anything — `hiddenX === 0` above is that leg,
//     and the two must be read together (a face can be perfectly filled
//     because its content is spilling out of the pane);
//   * VERTICAL slack, which is a different question with a different answer.
//
// ⚠ THIS SPEC'S LANE IS NON-BLOCKING (vrt-strict covers CARDS, not dock
// faceplates). The source-level half — `.faceplate-body` may not carry a px
// width floor — is what runs in the required lane; this is the measurement
// that says whether the CSS actually produced the result.

/**
 * The most empty plate a face may carry to the right of its content, CSS px.
 *
 * A POLICY THRESHOLD ON A DERIVED MEASUREMENT, not a population count — and it
 * was CHOSEN FROM THE MEASUREMENT rather than guessed. Swept over the whole
 * roster after the `min-width: 900px` floor came off, the slack collapses to a
 * tight bimodal distribution: **15 px** for a face whose widest band defines
 * the plate, and **32-33 px** for one whose HERO row does (the hero's own
 * `padding: 4px 10px 0` sits inside `.dock-pages`' 10 px, and the extra ~18 px
 * is the hero rail's gutter). Every face in the roster lands on one of those
 * two values or below, except the ones NAMED below.
 *
 * 40 px is the first round number above the upper mode, so a face has to be
 * meaningfully over — not a rounding artefact — to redden.
 */
const FACE_WIDTH_SLACK_MAX_PX = 40;

/**
 * Faces whose empty width is EARNED, each naming what consumes it.
 *
 * ⚠ ANCHORED TO THE ROSTER: an entry naming a face that is no longer in `FACES`
 * is RED (the anchor test at the bottom of this file), so a deleted or renamed
 * face cannot leave a permission behind for whatever takes its name.
 *
 * An exemption you cannot write a concrete reason for is an offender, not an
 * exemption — "it looks roomier" is not a thing that consumes width.
 *
 * ── ⚠ IT IS EMPTY, AND THE THREE ENTRIES IT HELD WERE ALL MIS-ATTRIBUTED ────
 *
 * `unityscalemathematik`, `vca` and `wavetableVco` each carried an entry
 * blaming the HERO READOUT STRIP, exempt "only because its fix is the owner's
 * pending global removal of the strip". Measured on the live layout by removing
 * each element and re-reading the pane, that cause is DISPROVEN by its own
 * removal — hiding the strip moves the pane on NONE of them:
 *
 *   face                    content  body  plate   without BAR   without STRIP
 *   moog914 (was passing)      765    780    780        —              780
 *   moog911                    270    303    352       303             352
 *   vca                        247    280    337       280             337
 *   wavetableVco               250    283    319       283             319
 *   unityscalemathematik       280    313    373       313             373
 *
 * What actually made those panes wide is the dock TITLE BAR, which sits OUTSIDE
 * `.faceplate-scroll` — so `contentW` cannot see it while `plateW` is set by
 * it, and the old `plateW - contentW` charged the chrome's width to the face.
 * Every one of the four is a NARROW face whose bar out-measures its faceplate;
 * `moog914`, whose body drives its own pane, was never affected.
 *
 * Against the corrected subject (`bodyW - contentW`, the face's own box against
 * the face's own ink) all three land on **33 px** — the same "the hero row
 * defines the plate" mode the threshold note above documents as normal, and
 * comfortably inside the ceiling. So the debt is PAID rather than re-described:
 * the entries are DELETED, not narrowed, and the pending strip removal that was
 * supposed to fix them would in fact have left all three red.
 */
const FACE_WIDTH_EXEMPTIONS: Readonly<Record<string, string>> = {
  // ── moog912 — THE NAME ROW IS WIDER THAN THE MODULE'S TWO CONTROLS ────────
  //
  // MEASURED on this branch (dock full view, CSS px, by walking every
  // descendant of `.faceplate-body`):
  //
  //   .faceplate-body   194   ← the face's own max-content box
  //     .editor         194   = .module-shell 150 + the editor's 22px L/R padding
  //       .module-shell 150
  //         .tile-top   148   ← THE DRIVER: .tile-rule 14 + gap + .tile-name 117
  //         .dock-hero  148   (stretched; its rail asks for 128)
  //         .dock-pages 148   (stretched; its one knob cell asks for 40)
  //   contentW          120   ← the gate's ink measure
  //
  // So the plate is sized by THE MODULE'S OWN NAME ROW, not by empty reserve:
  // every one of the control-bearing children asks for LESS than the name does.
  // The 74 px of slack is the name row's decorative `.tile-rule` plus its gaps
  // (drawn, but not "ink" by this gate's definition) and the editor's right
  // padding. Nothing here can be reclaimed without ellipsising the module's
  // name, which is not a width decision.
  //
  // ⚠ WHY IT APPEARED NOW, AND WHY THAT IS NOT A REGRESSION. moog912 used to
  // carry a two-value hero READOUT STRIP; the strip was the widest thing on the
  // face, so `contentW` cleared the name row and the slack fell under the
  // ceiling. The owner deleted every readout strip (2026-08-19), and what is
  // left is a face with exactly TWO params — one promoted to the hero, one in a
  // band. The face did not get wider; its CONTENT got narrower than its own
  // title. This is the inverse of the tidyVco defect the ceiling was written
  // for: there, a `min-width` floor reserved space nothing drew; here, every
  // pixel is drawn and the widest drawn thing is the name.
  //
  // ⚠ THE REAL QUESTION THIS RAISES IS NOT WIDTH, and it is recorded rather
  // than silently exempted: with its readouts gone moog912 is a TWO-PARAM face,
  // which is at the "NO FACE ON MERIT" line in module-faceplates.md (≤2 params,
  // no families, no derived quantity left to state). Whether it should still be
  // in STRICT_FACES at all is an owner call, not a thing to decide inside a
  // width ceiling — so the face stays and this entry names the cost.
  moog912:
    'the module NAME ROW (.tile-rule + .tile-name = 148 CSS px) is wider than either of its two remaining controls (hero rail 128, band cell 40). Measured driver of .faceplate-body; not reclaimable without ellipsising the module name. See the table above.',
  clockedRunner:
    'the CODE BUFFER (`CODE_BUFFER_FACE_MIN_W` = 336 CSS px) is the plate. MEASURED on this branch, dock full view, CSS px: content 201, face body 402 — so the reported slack is 201 and every pixel of it is the buffer. It is DRAWN edge to edge (a CodeMirror editor with a border and a background) and contributes ZERO to `contentW`, because the ink measure takes BOXES only for `[data-cell-key]`/glyph/canvas/svg/img and RANGES over text nodes, and a freshly spawned runner has an EMPTY document with no text nodes at all — verified by a DOM probe reading bufferChars 0. The 201 px of content is the 168 px DIV selector plus the name row. Remove the floor and `.faceplate-body`\'s max-content collapses onto those, rendering the module\'s only working surface ~200 px wide. Not reclaimable: the buffer IS the module. See the block comment above.',
  livecode:
    'the CODE BUFFER (`CODE_BUFFER_FACE_MIN_W` = 336 CSS px) is the plate, for the reason its child\'s entry above gives in full — and one step further, because the only ranked cell here is a 58 px `action` rather than a 168 px selector. MEASURED on this branch, dock full view, CSS px: content 121, face body 402 — the same 402 px plate as the runner (same buffer, same padding) against 80 px LESS ink, which is exactly the cell-width difference. Remove the floor and the script buffer renders narrower than the module\'s own name row. The buffer is DRAWN edge to edge and invisible to `contentW` (no box for a div tree, no text nodes in an empty document). The output log WOULD be ink, but it does not exist at rest: `node.data.lastRun` is unset until a run happens, which is also what keeps the dock baseline deterministic. Not reclaimable: the buffer IS the module. See the block comment above.',

  // ── JOYSTICK — THE XY PAD IS THE PLATE, AND THE PAD IS NOT "INK" BY THIS
  //    GATE'S DEFINITION — the code-buffer pair's blind spot, third member ────
  //
  // MEASURED by the first CI capture of this scene (run 33569312736, linux,
  // dock full view, CSS px): content 123, face body 286, slack 163. The 123 px
  // of "ink" is the two ranked knob cells; the widest DRAWN thing on the plate
  // is the 220 px pad (+ its 1 px borders and the body's centering flex), and
  // it contributes ZERO to `contentW` because the ink measure takes boxes only
  // for `[data-cell-key]`/glyph/canvas/svg/img and text ranges — and the pad
  // is DELIBERATELY none of those: the two-ordinary-cells fallback (owner
  // decision 2026-08-31) makes the knob cells the parity-credited controls,
  // so the pad must NOT carry the cell contract (`joystick-face-model.test.ts`
  // pins the absence), it mounts no canvas (attest basis is derived from
  // CONTENT), and at rest it holds no text (the x/y decimals are the
  // promotion's named DELETION — the values are on `aria-label`). Every pixel
  // of the reported slack is the module's real instrument, drawn edge to edge.
  joystick:
    'the XY PAD (220 CSS px + borders) is the plate, and it is structurally invisible to `contentW`: no `[data-cell-key]` (the two-ordinary-cells fallback deliberately keeps the pad OUT of the cell contract — a `control-*` anchor here would double-count both axes in faces-parity), no canvas (attest basis is derived from content), and no text at rest (the x/y readout is the promotion\'s named deletion; the value lives on aria-label). MEASURED on the first CI capture: content 123 (the two knob cells), face body 286, slack 163 — every pixel of it the drawn pad. Not reclaimable: the pad IS the module. See the block comment above.',

  // ── THE CODE-BUFFER PAIR — THE PLATE IS THE BUFFER, AND THE BUFFER IS NOT
  //    "INK" BY THIS GATE'S DEFINITION ───────────────────────────────────────
  //
  // These two entries are the moog912 shape with the cause inverted, and both
  // halves of that are worth stating because the ceiling exists to catch the
  // OTHER thing.
  //
  // THE INK MEASURE'S OWN BLIND SPOT. `readFoldGeometry` takes BOXES for
  // `[data-cell-key], .tile-glyph, canvas, svg, img, .hero-vis` and TEXT RANGES
  // over every other node's text children. A CodeMirror buffer is neither: it is
  // a `div` tree of styled spans, and in the capture state it is EMPTY — a scene
  // spawns one node and writes no data, so `node.data.source` / `node.data.text`
  // is absent and there are no text nodes to Range. So the widest DRAWN thing on
  // each of these plates contributes ZERO to `contentW`. This is the same
  // sentence moog912's entry already carries about `.tile-rule` ("drawn, but not
  // 'ink' by this gate's definition"), on a much larger element.
  //
  // WHY THE FLOOR IS NOT RECLAIMABLE. `.faceplate-body` is `width: max-content`,
  // `.dock-ext-body` is `width: 100%` (which contributes nothing to an intrinsic
  // size), and CodeMirror's own `.cm-scroller` is `overflow-x: auto` (so a long
  // line does not push either). Remove `CODE_BUFFER_FACE_MIN_W` and the plate
  // collapses onto the widest thing left: the ~148 px module-name row against a
  // 168 px `selector` on the runner and a 58 px `action` on LIVECODE. That is a
  // code editor rendered about 170 px wide, i.e. the module's entire working
  // surface inside the defect moog912's entry describes.
  //
  // ⚠ SO THIS IS THE INVERSE OF THE tidyVco DEFECT THE CEILING WAS WRITTEN FOR.
  // There, a `min-width` floor RESERVED space nothing drew. Here the floor is
  // occupied edge to edge by the surface the module is operated from — the gate
  // simply cannot see a text buffer, and it says so in its own comment. The
  // number is one constant shared by both bodies
  // ($lib/ui/modules/code-buffer-face.ts), argued from the value both LEGACY
  // CARDS already carried (`MIN_WIDTH: 360` less 24 px of card chrome), and
  // asserted at source in `codebuffer-face-model.test.ts` — so it cannot drift
  // between the two faces or grow quietly.
};

test.describe('VRT: P1 curated faces (?shell=1) — compact lane tile + dock full-view', () => {
  for (const { type, pages, videoFaceWhy, singletonAdoptWhy, simPin, tabbedOptIn } of FACES as readonly {
    type: string;
    pages: number;
    videoFaceWhy?: string;
    singletonAdoptWhy?: string;
    simPin?: BootFaceOptions['simPin'];
    tabbedOptIn?: true;
  }[]) {
    // ONE opts object for BOTH tiers, deliberately. The compact tile and the
    // dock faceplate are two captures of the SAME module, so a determinism
    // declaration that reached only one of them would leave the other
    // non-deterministic — the "isolation mechanism only half the entry points
    // honour" shape. Building it once here makes that structural rather than a
    // thing each call site has to remember.
    const bootOpts: BootFaceOptions = {
      ...(videoFaceWhy ? { videoFaceWhy } : {}),
      ...(singletonAdoptWhy ? { singletonAdoptWhy } : {}),
      ...(simPin ? { simPin } : {}),
    };
    // WHICH TIERS THIS FACE CAPTURES — `['compact', 'dock']` unless the roster
    // entry says otherwise. Read through `faceTiers` rather than tested inline,
    // because the baseline-existence check below and `vrt-meta.test.ts` ask the
    // same question and a second copy of the subtraction is how the two drift.
    //
    // ⚠ A REMOVED TIER IS NOT REGISTERED AT ALL — not registered-and-skipped.
    // `test.skip` would leave the scene in the shard plan, in the `list`
    // reporter output and in every "did this lane run what it planned" check as
    // a thing that exists, which is the green-and-blind shape. `faceTiers` says
    // the scene does not exist; this makes that true of the runner too.
    const tiers = faceTiers(type);
    // ⚠ THE BODY IS TYPED EXPLICITLY, not as `Parameters<typeof test>[1]`.
    // `test` is OVERLOADED, so that index resolves to the LAST overload's second
    // parameter — `TestDetails`, an options bag — and every scene body below
    // would have been checked against it, which silently makes `page` an `any`.
    const tierTest = (
      tier: FaceTier,
      title: string,
      body: (args: { page: Page }) => Promise<void>,
    ): void => {
      if (tiers.includes(tier)) test(title, body);
    };
    tierTest('compact', `face-${type}-compact: the compact lane tile matches baseline`, async ({ page }) => {
      // PER-SCENE, never the config's flat cap — the `foldViewportFor` shape
      // applied to TIME instead of height (#1949). Returns the shared 90 s
      // unless the roster entry declares a measured `sceneWeight`. This is a
      // BOUND: it moves no assertion, and convergence is still gated at
      // `expect.timeout` (30 s), which is where a scene that never settles
      // fails. See the note on `faceSceneTimeout`.
      test.setTimeout(faceSceneTimeout(type, 'compact'));
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      // The compact tile is pinned at the config viewport — the dock scene's
      // taller one would be a baseline move for no reason.
      await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
      const memberId = await bootWithFace(page, type, bootOpts);
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
      // ── AND THE VIDEO SURFACE, for a scene that declares one ────────────
      // An AudioContext suspend says nothing about a rAF-driven picture; see
      // freezeFaceVideo. Opt-in per scene, with the reason on the roster entry.
      //
      // ⚠ PAINTED FIRST, THEN FROZEN, AND THE ORDER IS THE FIX. Freezing an
      // unpainted well yields a picture that is perfectly still and completely
      // blank, which `freezeFaceVideo` accepts — see `awaitFaceVideoPainted`
      // for the measurement, and for the shard-speed dependence it produced on
      // `face-videovarispeed-compact`. This is the tier the lane thumbnail is
      // IN, so it is the tier the wait actually bites on.
      if (videoFaceWhy) {
        await awaitFaceVideoPainted(
          page,
          memberId,
          `.svelte-flow__node[data-id="${memberId}"]`,
          `face-${type}-compact`,
        );
        await freezeFaceVideo(page, memberId, `face-${type}-compact`);
      }
      const tile = page.locator(`.svelte-flow__node[data-id="${memberId}"] [data-testid="module-shell"]`);
      await expect(tile).toHaveScreenshot(`face-${type}-compact.png`, {
        maxDiffPixels: COMPACT_MAX_DIFF,
      });

      expect(
        errors.filter((e) => !/getUserMedia|audio/i.test(e)),
        `pageerrors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });

    tierTest('dock', `face-${type}-dock: the dock full-view faceplate matches baseline`, async ({ page }) => {
      // PER-SCENE — see the compact scene above. The dock scene is the more
      // expensive of the two for every face measured (it mounts the whole
      // faceplate, and for a video face the `fullViewBody` extension too), so
      // `sceneWeight` carries the two durations separately rather than one
      // number scaled by a guess.
      test.setTimeout(faceSceneTimeout(type, 'dock'));
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      // PER-SCENE, never the bare constant: a face whose unfolded pane is taller
      // than the shared default needs its own window, and raising the shared one
      // was MEASURED to move every other dock scene's pixels (see
      // `foldViewportFor`). `mixmstrs` is the case that found it.
      await page.setViewportSize(foldViewportFor(type));
      const memberId = await bootWithFace(page, type, bootOpts);
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

      // ── COMPACT BY DEFAULT: THE PLATE IS ITS CONTENT ────────────────────
      //
      // Owner ruling 2026-08-17: *"we do not want useless gray horizontal
      // space on cards, ever. prefer compact. screen real estate is
      // expensive!"*, prompted by *"tidyvco is fully twice as wide as it needs
      // to be"*. DENY-BY-DEFAULT: a face that does not fill its plate is RED
      // unless NAMED below with the thing consuming the width.
      //
      // ⚠ MEASURED, NEVER LISTED. The offenders are derived from the live
      // layout on every run, so a face that lands double-wide next month is
      // caught without anyone maintaining a roster of the ones that are wrong
      // today. Units: CSS px, and the same CSS px the PNG is in (see
      // `readFoldGeometry`'s units note) — this pane is not inside xyflow's
      // zoom transform.
      // ⚠ THE SUBJECT IS THE FACE'S OWN BOX, NOT THE PANE. `.faceplate-body` is
      // `width: max-content`, so it is what the face ASKED FOR; the pane is
      // `max(that, the dock title bar)` and the bar lives outside the element
      // `contentW` walks. Measuring against the pane charged the chrome's width
      // to the faceplate and produced three mis-attributed exemptions — see the
      // measurement table on FACE_WIDTH_EXEMPTIONS. Units: CSS px.
      const slack = g.bodyW - g.contentW;
      const widthWhy = FACE_WIDTH_EXEMPTIONS[type];
      expect(
        widthWhy ? -1 : slack,
        `face-${type}-dock: ${slack} CSS px of EMPTY PLATE to the right of the content ` +
          `(content ${g.contentW}, face body ${g.bodyW}; the pane around it is ${g.plateW}, ` +
          `which the dock TITLE BAR may legitimately set and which is NOT this assertion's ` +
          `subject), against a ${FACE_WIDTH_SLACK_MAX_PX} px ceiling. Either the face is ` +
          `reserving width nothing draws in — the tidyVco defect, whose cause was a ` +
          `\`min-width\` floor on \`.faceplate-body\` — or the width is EARNED, in which case ` +
          `add a FACE_WIDTH_EXEMPTIONS entry naming the thing that consumes it. "It looks ` +
          `roomier" is not a thing that consumes it.`,
      ).toBeLessThanOrEqual(FACE_WIDTH_SLACK_MAX_PX);

      // The pane never CLIPS the face — stated because the subject moved off it.
      // (`hiddenX` above is the scroll-overflow half; this is the box half.)
      expect(
        g.plateW,
        `face-${type}-dock: the pane (${g.plateW}) is narrower than the faceplate it holds ` +
          `(${g.bodyW}) — the face is being squeezed, not merely surrounded.`,
      ).toBeGreaterThanOrEqual(g.bodyW);

      // ── RESIDUAL SCOPE #1, ASSERTED: the tab rail ───────────────────────
      // A railed face renders ONE band; every other face renders all of them.
      // Derived from the SAME answer DockFullView and ModuleShell branch on, so
      // a new railed face auto-enrols and cannot drift.
      //
      // ⚠ THE THRESHOLD IS NO LONGER THE WHOLE QUESTION. This read
      // `pages >= DOCK_TAB_MIN_BANDS` until `face.tabbed` landed — an
      // owner-instruction-only opt-in that rails a face BELOW the threshold
      // (spirographs: 3 bands, railed by declaration). A threshold-only
      // derivation here would call that face unrailed and fail on the rail it
      // was asked for, which is the same two-answer split this whole file warns
      // about, one layer out. Both routes, joined.
      //
      // ⚠ THE OPT-IN IS A ROSTER FLAG, NOT A LIVE DEF READ, AND THAT IS A
      // RUNTIME CONSTRAINT RATHER THAN A CHOICE. Importing the module registry
      // here pulls in `import.meta.glob`, which does not exist in Playwright's
      // runtime (measured: "TypeError: (intermediate value).glob is not a
      // function"). So the flag is declared beside `pages` — and, exactly like
      // `pages`, it is a copy that could drift. `shell-faces-roster.test.ts`
      // is what stops it: it runs in the UNIT lane, where the live defs ARE
      // importable, and joins the two in BOTH directions.
      const optedIn = tabbedOptIn === true;
      const railed = pages >= DOCK_TAB_MIN_BANDS || optedIn;
      expect(
        g.tabs > 0,
        `face-${type}-dock: ${pages} declared bands vs DOCK_TAB_MIN_BANDS=${DOCK_TAB_MIN_BANDS} ` +
          `(opt-in: ${optedIn}) says railed=${railed}, but the faceplate rendered ${g.tabs} ` +
          `tab chips.`,
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
      // The dock faceplate is where a fullViewBody extension paints, so this is
      // the scene the video freeze actually exists for.
      //
      // ⚠ THE FIRST-PAINT WAIT RUNS HERE TOO, AND ON MOST DOCK SCENES IT IS A
      // REPORTED NO-OP. The dock capture root usually holds the face's OWN
      // `fullViewBody` canvas rather than a `video-tile-thumb` (the dock hero
      // does not paint the shell glyph when the face brought its own picture,
      // PF-20). It is called anyway rather than compact-only, because the dock
      // hero DOES paint the shell glyph for a video face that brought no body,
      // and that well is inside this capture. See `awaitFaceVideoPainted`'s
      // scope note for what the no-op case leaves open.
      if (videoFaceWhy) {
        await awaitFaceVideoPainted(
          page,
          memberId,
          '[data-testid="dock-full-view"]',
          `face-${type}-dock`,
        );
        await freezeFaceVideo(page, memberId, `face-${type}-dock`);
      }
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
  test('ANCHOR: every width exemption still names a face in the roster', () => {
    // A permission that outlives its subject is worse than no permission: it
    // silently covers whatever takes the name next. Anchored to the ARTIFACT
    // (`FACES`), never to a count.
    const rostered = new Set<string>(FACES.map((f) => f.type));
    const dead = Object.keys(FACE_WIDTH_EXEMPTIONS).filter((t) => !rostered.has(t));
    expect(
      dead,
      'a FACE_WIDTH_EXEMPTIONS entry names a face that is no longer in the roster — delete it.',
    ).toEqual([]);

    const thin = Object.entries(FACE_WIDTH_EXEMPTIONS)
      .filter(([, why]) => why.trim().length < 40)
      .map(([t]) => t);
    expect(
      thin,
      'a width exemption without a concrete reason is a suppression. Name the thing that ' +
        'consumes the width (a live picture, a scope trace, a video preview, an XY pad, a ' +
        'control that only appears in one mode).',
    ).toEqual([]);
  });

  test('face width negative control: the corrected subject still catches a body FLOOR', async ({
    page,
  }) => {
    // ⚠ THE PERMANENT NEGATIVE CONTROL FOR A CORRECTED INSTRUMENT. The width
    // assertion's subject moved from the PANE to `.faceplate-body`, which made
    // four faces stop reporting slack they never had — and a measurement that
    // stops failing is exactly the shape that "goes green and blind" (CLAUDE.md:
    // a gate whose precondition is the defect). So this leg re-creates the
    // FOUNDING defect on a live face and asserts the corrected number sees it.
    //
    // The defect is the real one, verbatim: `.dock-faceplate .faceplate-body`
    // carried `min-width: 900px`, which became the faceplate's width because
    // everything above it shrink-wraps. Injected here rather than described.
    //
    // BOTH DIRECTIONS, on the SAME face in the SAME boot: clean must pass and
    // floored must fail, so "the instrument cannot move" and "the face is fine"
    // stay distinguishable. Derived from the roster (FACES[0]) rather than
    // naming a module, so it cannot outlive its subject.
    const subject = FACES[0]!;
    test.setTimeout(60_000);
    await page.setViewportSize(foldViewportFor(subject.type));
    const memberId = await bootWithFace(page, subject.type);
    await frameMember(page, memberId, 0.7, 'full');
    await openDock(page, memberId, subject.pages);
    await unfoldDockPane(page);

    const clean = await readFoldGeometry(page);
    expect(
      clean.bodyW - clean.contentW,
      `${subject.type}: the control face must be clean BEFORE the floor is injected, or the ` +
        `failing half below proves nothing (content ${clean.contentW}, body ${clean.bodyW})`,
    ).toBeLessThanOrEqual(FACE_WIDTH_SLACK_MAX_PX);

    const FLOOR_PX = 900;
    await page.evaluate((px) => {
      const style = document.createElement('style');
      style.id = 'aa-face-width-negative-control';
      style.textContent = `.dock-faceplate .faceplate-body { min-width: ${px}px; }`;
      document.head.appendChild(style);
    }, FLOOR_PX);
    const floored = await readFoldGeometry(page);
    await page.evaluate(() =>
      document.getElementById('aa-face-width-negative-control')?.remove(),
    );

    expect(
      floored.bodyW,
      `the injected ${FLOOR_PX}px floor must actually reach the faceplate — if it does not, ` +
        `this control is testing nothing (body ${floored.bodyW})`,
    ).toBeGreaterThanOrEqual(FLOOR_PX);
    expect(
      floored.bodyW - floored.contentW,
      `${subject.type}: with the tidyVco floor re-injected the corrected measurement MUST ` +
        `exceed the ${FACE_WIDTH_SLACK_MAX_PX} px ceiling (content ${floored.contentW}, body ` +
        `${floored.bodyW}). If it does not, the width gate has gone green and blind.`,
    ).toBeGreaterThan(FACE_WIDTH_SLACK_MAX_PX);

    // …and the face is back to clean once the floor is gone, so the injection
    // cannot leak into any scene that follows.
    const after = await readFoldGeometry(page);
    expect(after.bodyW).toBe(clean.bodyW);
  });

  test('every shipped face has a scene, and every scene has its baselines', () => {
    // Widened to Set<string> so `.has()` accepts entries read from
    // STRICT_FACES (ReadonlySet<string>) — the comparison is the point.
    const rostered = new Set<string>(FACES.map((f) => f.type));
    // ⚠ ONE SOURCE FOR "ACCOUNTED FOR" — a captured scene OR a named
    // `FACES_WITHOUT_SCENES` exemption. Read from `ROSTERED_FACE_TYPES` rather
    // than re-derived here, because `vrt-meta.test.ts` asserts the SAME
    // relationship and the first version of this exemption taught only THIS
    // gate about it, leaving that one red on a correctly exempted face. Two
    // gates computing one subtraction is the drift machine.
    const missingScene = [...STRICT_FACES]
      .filter((t) => !ROSTERED_FACE_TYPES.has(t))
      .sort();
    const orphanScene = [...rostered].filter((t) => !STRICT_FACES.has(t)).sort();

    expect(
      missingScene,
      `these modules are in STRICT_FACES — they render a curated faceplate to real ` +
        `users — but have NO entry in the FACES roster, so this spec generates no ` +
        `scene for them and no pixel gate covers them at any tier. Add ` +
        `{ type, pages } to FACES in _shell-faces.ts and capture the baselines ` +
        `(\`task vrt:commit\`). If the module's RENDERER genuinely cannot be ` +
        `baselined, add a NAMED entry to FACES_WITHOUT_SCENES with the ` +
        `measurement in its \`why\` — "it animates" is not sufficient, since ` +
        `mirrorpool/outlines/warrensvisions/freezeframe all animate and are all ` +
        `captured via simPin or a freeze param.`,
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

    // ⚠ PER DECLARED TIER, not per (face x 2). A face that captures one tier is
    // not missing the other — it does not HAVE the other — and the same
    // `faceTiers` call that decides whether the scene is registered above
    // decides what must exist on disk here, so the two cannot disagree.
    const missingBaseline: string[] = [];
    for (const { type } of FACES) {
      for (const variant of faceTiers(type)) {
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

    // ⚠ AND THE OTHER DIRECTION, because removing a tier moves the failure mode
    // rather than deleting it: a PNG left behind for a tier no longer captured
    // is a file NOTHING compares, sitting in the snapshot directory looking
    // exactly like coverage. Anchored to the artifact, which is the rule this
    // repo applies to every ledger.
    const orphanBaseline: string[] = [];
    for (const { type } of FACES) {
      const captured = faceTiers(type);
      for (const variant of FACE_TIERS) {
        if (captured.includes(variant)) continue;
        const rel = `./__screenshots__/workflow-shell-faces.spec.ts/face-${type}-${variant}.png`;
        if (existsSync(fileURLToPath(new URL(rel, import.meta.url)))) {
          orphanBaseline.push(`face-${type}-${variant}.png`);
        }
      }
    }
    expect(
      orphanBaseline,
      `a baseline is committed for a tier the roster no longer captures, so no ` +
        `test compares it and nothing can make it fail. Either delete the PNG, or ` +
        `— if the scene became capturable again — drop the \`scenes\` narrowing ` +
        `from the roster entry so the test is generated for it.`,
    ).toEqual([]);
  });

  // ── THE UNBASELINABLE-FACE EXEMPTION, ANCHORED FOUR WAYS ─────────────────
  //
  // ⚠ STATE THE GATE'S SCOPE INSIDE THE GATE. What an exempt face COSTS is that
  // its PIXELS ARE NEVER COMPARED — not at the compact tier, not at the dock
  // tier, on any platform. A layout regression on one of these faces is
  // invisible to every VRT lane and reaches a human's eyes first. This block
  // cannot change that; what it can do is make sure the permission is still
  // earned, and that the non-pixel gates it leans on actually exist.
  //
  // The four anchors, each of which is a DIFFERENT way for the claim to expire:
  //   1. the module is still FACED          — else it needs no exemption at all
  //   2. it is still ABSENT from FACES      — else it HAS scenes; contradiction
  //   3. no baseline exists on disk         — else it was captured after all
  //   4. its def declares no freeze seam    — else somebody built determinism
  //
  // Anchored to the ARTIFACTS (STRICT_FACES, FACES, the filesystem, the live
  // def), never to a count, so nothing here goes stale silently.
  test('ANCHOR: every unbaselinable-face exemption is still earned', () => {
    const rostered = new Set<string>(FACES.map((f) => f.type));

    // 1 — still faced.
    const notFaced = FACES_WITHOUT_SCENES
      .filter((e) => !STRICT_FACES.has(e.type))
      .map((e) => e.type);
    expect(
      notFaced,
      'an exemption names a module that is NOT in STRICT_FACES. An unpromoted module needs no ' +
        'scene and therefore no exemption — delete the entry, or it silently pre-approves ' +
        'whatever takes that name next.',
    ).toEqual([]);

    // 2 — still absent from the roster.
    const alsoRostered = FACES_WITHOUT_SCENES
      .filter((e) => rostered.has(e.type))
      .map((e) => e.type);
    expect(
      alsoRostered,
      'an exemption names a module that ALSO has a FACES entry. It cannot both have scenes and ' +
        'be exempt from having them — one of the two is wrong.',
    ).toEqual([]);

    // 3 — nothing was captured behind the exemption's back. ⚠ THE ARTIFACT LEG:
    // if a baseline exists on disk, the claim "this cannot be captured" is
    // false no matter how good the argument reads.
    const capturedAnyway: string[] = [];
    for (const e of FACES_WITHOUT_SCENES) {
      for (const variant of e.scenes) {
        const rel = `./__screenshots__/workflow-shell-faces.spec.ts/face-${e.type}-${variant}.png`;
        if (existsSync(fileURLToPath(new URL(rel, import.meta.url)))) {
          capturedAnyway.push(`face-${e.type}-${variant}.png`);
        }
      }
    }
    expect(
      capturedAnyway,
      'a baseline EXISTS for a face declared unbaselinable. Either someone made the renderer ' +
        'deterministic — in which case delete the exemption and add the FACES entry — or a ' +
        'local run wrote an untracked PNG that should not have been committed.',
    ).toEqual([]);

    // 4 — no determinism seam appeared on the def. If one has, the exemption's
    // central claim (that simPin/freeze cannot reach this renderer) is due a
    // re-argument rather than an automatic renewal.
    //
    // ⚠ READ FROM SOURCE, NOT FROM THE REGISTRY. The video module index is
    // registered through `import.meta.glob`, a Vite feature the Playwright
    // runner does not provide — importing it here throws
    // "(intermediate value).glob is not a function" and the whole spec collects
    // zero tests, which reads as "no tests found" rather than as a broken gate.
    // The def's SOURCE is what can be read in this runtime, and it is the same
    // technique `face-monitor-source.test.ts` uses to resolve cards.
    //
    // ⚠ AND THE LEG'S OWN PREMISE NEEDED CORRECTING (#2111). It read a `freeze`
    // param as PROOF of a determinism seam, which held for every def that had
    // one until `acidwarp` — whose `freeze` is a real, documented USER CONTROL
    // that halts only the scene cycler while the palette keeps rotating, so
    // writing it does not stop the picture at all. Under the blanket rule that
    // module could never hold an exemption however true its argument was.
    //
    // So the claim became SAYABLE (`freezeIsNotASeam`) and is now checked in
    // BOTH directions. Deny-by-default is intact: `freeze` with no declaration
    // is still red, exactly as before.
    const declaresFreeze = (type: string): boolean => {
      const src = fileURLToPath(
        new URL(`../../packages/web/src/lib/video/modules/${type}.ts`, import.meta.url),
      );
      if (!existsSync(src)) return false;
      return /\bid:\s*'freeze'/.test(readFileSync(src, 'utf8'));
    };
    const gainedSeam = FACES_WITHOUT_SCENES
      .filter((e) => declaresFreeze(e.type) && !e.freezeIsNotASeam)
      .map((e) => e.type);
    expect(
      gainedSeam,
      "an exempt module's def declares a `freeze` param — normally a determinism seam, and the " +
        'mechanism the exemption says cannot reach this renderer. Either capture the face, or ' +
        'declare `freezeIsNotASeam` saying what that param actually does and citing the read ' +
        'site. Silently keeping the exemption is the one option this refuses.',
    ).toEqual([]);

    // The INVERSE, so the declaration cannot outlive the thing it describes: a
    // face claiming its `freeze` is not a seam, on a def that no longer has one.
    const staleNotASeam = FACES_WITHOUT_SCENES
      .filter((e) => e.freezeIsNotASeam && !declaresFreeze(e.type))
      .map((e) => e.type);
    expect(
      staleNotASeam,
      'a `freezeIsNotASeam` declaration names a def with NO `freeze` param. The argument it ' +
        'makes is about a param that no longer exists — delete it, or it silently pre-approves ' +
        'the next `freeze` to appear on that def, which is exactly the seam this leg watches for.',
    ).toEqual([]);

    // …and the declaration has to be an ARGUMENT, on the same bar as `why`.
    const thinNotASeam = FACES_WITHOUT_SCENES
      .filter((e) => e.freezeIsNotASeam && e.freezeIsNotASeam.trim().length < 120)
      .map((e) => e.type);
    expect(
      thinNotASeam,
      '`freezeIsNotASeam` must say what the param DOES and where it is read, not assert that it ' +
        'is harmless. "It is not a seam" with no mechanism is a suppression.',
    ).toEqual([]);

    // The argument itself, and the coverage it promises.
    const thin = FACES_WITHOUT_SCENES
      .filter((e) => e.why.trim().length < 200)
      .map((e) => e.type);
    expect(
      thin,
      'an unbaselinable-face exemption needs the MEASUREMENT in its `why`, not a label — the bar ' +
        'is evidence that simPin and freeze cannot reach the renderer, since several animated ' +
        'faces are captured with exactly those.',
    ).toEqual([]);

    const emptyCoverage = FACES_WITHOUT_SCENES
      .filter((e) => e.coveredBy.length === 0 || e.scenes.length === 0)
      .map((e) => e.type);
    expect(
      emptyCoverage,
      'an exemption must name the gates that DO cover the face (and the scenes it is exempt ' +
        'from). VRT is not covering it; something has to be.',
    ).toEqual([]);

    // ⚠ AND THE COVERAGE CLAIM IS ANCHORED TO THE FILESYSTEM. A `coveredBy`
    // naming a spec that has since been deleted or renamed is the exemption
    // quietly becoming uncovered while still reading as covered — the exact
    // shape of a stale claim this repo keeps meeting.
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const missingCoverage: string[] = [];
    for (const e of FACES_WITHOUT_SCENES) {
      for (const rel of e.coveredBy) {
        if (!existsSync(`${repoRoot}${rel}`)) missingCoverage.push(`${e.type}: ${rel}`);
      }
    }
    expect(
      missingCoverage,
      'a `coveredBy` entry names a file that does not exist. The exemption is leaning on ' +
        'coverage that is gone.',
    ).toEqual([]);

    // NON-VACUITY: this whole block is green over an empty list too. If it
    // empties, that is a real event — a face became capturable, or was
    // un-promoted — and this line is what makes it visible rather than silently
    // permissive.
    //
    // ⚠ THE POPULATION IS NOT NAMED HERE ANY MORE, DELIBERATELY. This comment
    // used to read "today the list has exactly one member and it is milkdrop
    // (#2083)", which was already false when acidwarp joined in #2111 and is
    // false again now — a hand-typed count in prose beside a list that grows is
    // the stale-ledger shape this repo keeps meeting. The list itself is the
    // enumeration; every member carries its own measured argument.
    expect(
      FACES_WITHOUT_SCENES.length > 0,
      'FACES_WITHOUT_SCENES is empty — if that is intentional (every face is now baselined), ' +
        'delete this control along with the mechanism rather than leaving a gate over nothing.',
    ).toBe(true);
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
  test('face audio freeze RECOVERY control: a one-shot resume inside the VERIFY window is absorbed', async ({
    page,
  }) => {
    // ⚠ THE POSITIVE CONTROL FOR #1931, and the leg the negative control below
    // structurally cannot provide. That one proves the freeze assertion can
    // REJECT a running graph. This one proves the freeze LOOP can SURVIVE a
    // resume — a different claim, and the one that was false: the loop read
    // back 'suspended', then called an assertion that re-reads the clock, and a
    // resume landing between those two reads threw out of the loop with five of
    // six attempts unused. One losing face aborts the entire capture (#1810).
    //
    // The window is aimed at, not hoped for: the resume is armed to fire
    // FREEZE_RACE_FRAMES + 1 frames out, i.e. one frame AFTER the settle the
    // loop waits before reading state — so it lands while the clock check is in
    // flight. Derived from the harness constant, so it cannot drift from the
    // code it targets.
    //
    // ⚠ AND IT IS ANCHORED TO THE ARTIFACT: a control whose injection silently
    // failed to arm would pass while proving nothing, so the resume must be
    // observed to have REACHED the context before any conclusion is drawn.
    test.setTimeout(90_000);
    const subject = FACES[0]!;
    await page.setViewportSize(LEGACY_FOLD_VIEWPORT);
    const memberId = await bootWithFace(page, subject.type);
    await frameMember(page, memberId, 0.45, 'compact');

    const clean = await readAudioClock(page);
    expect(
      clean.state,
      `${subject.type}: the graph must be SUSPENDED before the resume is injected, or ` +
        `"the loop recovered" below is measuring a context that was never frozen.`,
    ).toBe('suspended');

    await armOneShotResume(page, FREEZE_RACE_FRAMES + 1);

    // THE CLAIM: this call must RECOVER rather than throw. Before the fix it
    // threw `assertFaceAudioFrozen`'s "not 'suspended', at CAPTURE time" —
    // under bootWithFace's label, which is how the abort read as a capture-time
    // failure when it was a boot-time one.
    await freezeFaceAudio(page, `${subject.type} (recovery control)`);

    expect(
      await oneShotResumeFired(page),
      `the injected resume never reached the AudioContext, so this control did not exercise ` +
        `the race at all — it would pass identically against the unfixed loop.`,
    ).toBe(true);

    const after = await readAudioClock(page);
    expect(
      after.state,
      `${subject.type}: the freeze loop returned but the graph is '${after.state}' — recovering ` +
        `must mean SUSPENDED, not merely "stopped throwing".`,
    ).toBe('suspended');
    await assertFaceAudioFrozen(page, `${subject.type} (recovery control, effect)`);
  });

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
    //
    // ⚠ THE ATTACH IS POLLED, NOT SAMPLED ONCE (#2114). This read used to fire
    // immediately after `bootWithFace` + `frameMember`, and analyser attach is
    // ASYNCHRONOUS READINESS — so a single sample races it. On vrt-strict shard
    // 5/8 it lost that race and the control died on its own precondition
    // ("no analyser could attach"), before either of the two assertions it
    // exists to make had run. The shard was at 64 % of budget, so this was
    // never a capacity problem; it is the documented state-readiness pattern
    // being missing.
    //
    // ⚠ THIS CANNOT WEAKEN THE GATE, which is the property that makes polling
    // the right answer rather than a bigger budget. If the analyser never
    // attaches, the poll still fails with the same message and the same
    // meaning; all that changes is that "sampled before ready" becomes "waited
    // for ready, then asserted". The peak / moving legs below are untouched and
    // still read the SAME reading this loop settles on.
    //
    // ⚠ AND IT IS A READINESS BOOLEAN, NOT AN ACCUMULATOR — which is why an
    // `expect.poll` is legitimate here and is NOT the "Playwright-side poll
    // starves its own subject" defect. That rule is about sampling a
    // page-side quantity that ADVANCES (a frame counter), where each
    // round-trip competes with the thing being measured. `tapped` latches once
    // and stops changing, so re-reading it neither perturbs nor races anything.
    let live = await readFaceAudio(page, runId);
    await expect
      .poll(
        async () => {
          live = await readFaceAudio(page, runId);
          return live.tapped;
        },
        {
          message:
            `${NC_AUDIO_FACE}: no analyser could attach to its '${live.portId}' output — the ` +
            `control cannot see the signal it is about to reason about. Polled to let the ` +
            `attach settle; still false, so this is a real wiring failure rather than a race.`,
          timeout: 15_000,
        },
      )
      .toBe(true);
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
