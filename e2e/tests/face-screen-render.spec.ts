// e2e/tests/face-screen-render.spec.ts
//
// THE FLEET'S RENDER-LEVEL HOME FOR THE SCREEN ON / OFF SWITCH — the half of the
// 2026-08-18 owner ruling ("'screen on / off' on the card like that is a thing all
// video modules should have moving forward") that no source gate can see.
//
// ⚠ FUTURE FACE PRs EXTEND THE TABLE BELOW. That is the convention: when you
// promote a module whose `fullViewBody` carries a SCREEN switch, add a `SUBJECTS`
// entry in the same diff. This file is not scoped to any batch.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// `video-face-screen-source.test.ts` (#1928) is deny-by-default over every faced
// video module and checks that each `fullViewBody` READS `previewCollapsed`,
// WRITES it through the node-data idiom, and exposes a `<button>`. It says so
// itself: *"It reads SOURCE, not a render. It cannot tell you the button is
// visible, clickable, or wired to anything… The RENDER half is e2e's job."*
//
// That render half had exactly THREE owners — `freezeframe-screen-toggle.spec.ts`,
// `foxy-face-surface.spec.ts` and (for its differently-named toggle)
// `backdraft-preview-toggle.spec.ts` / `video-hide-controls.spec.ts`. Every other
// faced module's switch was proven only at the source. ENUMERATED at authoring
// time by walking every `face.extension` → `fullViewBody` → toggle testid and
// subtracting the ones an existing spec references: **25 uncovered surfaces** — plus 2
// more (`tempest`, `fader`) that landed on main while this file was in review and were
// caught when the branch absorbed it. See their block below: the "future face PRs extend
// this table" convention above is not aspirational, it earned its keep on this file's
// FIRST merge.
//
// ⚠ THE ENUMERATION HAD TO CROSS BOTH DOMAINS, and a video-only scan gets it
// wrong. `foxy` and `rasterize` are `AudioModuleDef`s that carry video surfaces
// and live in `lib/audio/modules/`, so a sweep over `lib/video/modules/` — the
// obvious one to write — misses them silently. `rasterize` is in the table below
// and spawns with `domain: 'audio'` for exactly that reason.
//
// ⚠ DELIBERATELY NOT A REGISTRY SWEEP. The `cv-param-reach` ruling stands — never
// build registry-wide render sweeps; test I/O per module, structurally. So this is
// a FIXED, NAMED list with a per-entry `why`, enumerated once at authoring time.
// It cannot grow silently to cover a module nobody wrote a line for, and a typo'd
// type fails at spawn rather than being skipped.
//
// ── WHAT THIS FILE STILL CANNOT SEE ─────────────────────────────────────────
//
//   * THAT THE MODULE KEEPS RENDERING WHILE THE SCREEN IS OFF. Every subject here
//     is a DOM or LAYOUT fact; none reads a pixel. "OFF stops the blit, never the
//     engine" lives at the SOURCE (each body retains `markWatched` in its collapsed
//     branch) and in each module's `EXTENSION_BODY_ROLES` argument, because no
//     runtime gate here can observe a watch mark. This is the same honest split
//     `freezeframe-screen-toggle.spec.ts` records after its first draft reached for
//     a `window.__videoEngine.hasNode` hook THAT DOES NOT EXIST and passed green
//     while measuring nothing.
//   * THE LEGACY-CARD SURFACE. Where a module's card also has a preview toggle
//     (freezeframe, backdraft), that half stays with its own spec.
//   * WHETHER THE PICTURE IS CORRECT. That is VRT's job — except on `milkdrop`,
//     which is `EXEMPT_FROM_VRT` with a `FACES_WITHOUT_SCENES` entry and therefore
//     has NO dock baseline at all. On that one module this file is the only
//     automated check that its faceplate body mounts and operates.
//
// NO WALL-CLOCK WAITS. Every wait is an auto-retrying `expect` / `expect.poll` on
// the real subject, per CLAUDE.md: state readiness is never a frame count and never
// a timeout. The only wall-clock number is the test BUDGET, from the one export
// site in `boot-budget.ts`, and it BOUNDS the failure rather than gating it.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { waitFrames } from '../_helpers/frames';

interface Subject {
  /** The def's `type` — what `spawnPatch` instantiates. */
  readonly type: string;
  /**
   * The testid prefix this module's body declares.
   *
   * ⚠ NOT DERIVABLE FROM THE TYPE, which is why it is written down rather than
   * computed. `videoMixer`'s body spells its testids `video-mixer-*` (its LABEL is
   * `v-mixer`; its TYPE is `videoMixer` only to avoid clashing with the audio
   * `mixer`), and `4plexvid`'s spells them `fourplexvid-*` because a testid cannot
   * usefully start with a digit. A computed prefix would silently match nothing on
   * those two and pass everywhere else.
   */
  readonly prefix: string;
  /**
   * The testid of the element the SCREEN switch REMOVES, when it is not the
   * default `<prefix>-face-canvas`.
   *
   * ⚠ ONE MODULE NEEDS THIS, AND IT IS THE ONE THAT MOST NEEDS COVERING.
   * `quadralogical`'s faceplate IS its joystick — the body paints a quadrant
   * preview, a diamond, a puck and a mix canvas rather than a single
   * conventionally-named one, so there is no `quadralogical-face-canvas` for the
   * default to find. The element actually inside its `{#if !previewCollapsed}`
   * is `quadralogical-face-quadrants`. Declaring the exception is the honest
   * alternative to either skipping the module or loosening the assertion for
   * everyone.
   */
  readonly canvas?: string;
  /** Which engine the node belongs to. `audio` for the two audio-def outliers. */
  readonly domain: 'audio' | 'video';
  /** What this body paints, and what its SCREEN switch is protecting. Required. */
  readonly why: string;
}

/**
 * Every faced module with a SCREEN switch that had NO render-level leg when this
 * file was written. Enumerated, not filtered — see the header.
 *
 * NOT HERE, and each for a stated reason:
 *   * `freezeframe`, `foxy`, `backdraft` — already have their own render specs.
 *   * `videoOut` — carries no SCREEN switch at all, and is the one NAMED exemption
 *     in `video-face-screen-source.test.ts`: it IS the screen, so collapsing it
 *     would remove the module's whole reason to exist.
 *   * `cvBuddy` — its `fullViewBody` is the roster's only `status-primitive`: no
 *     canvas, no preview, nothing to switch off.
 */
const SUBJECTS: readonly Subject[] = [
  // ── the four this file was opened for (batch 22 · group 4) ────────────────
  { type: 'mapper', prefix: 'mapper', domain: 'video', why: 'the luminance-gated keyer\'s live MATTE preview — on a ONE-PARAM face this canvas IS the merit argument, so a body that fails to mount takes the whole justification with it.' },
  { type: 'destructor', prefix: 'destructor', domain: 'video', why: 'the glitch stack\'s preview: four DEGRADATION AMOUNTS whose only description is a look, so the picture is what makes the faders legible.' },
  { type: 'luma', prefix: 'luma', domain: 'video', why: 'the tone grade\'s preview. The module ships a BIT-EXACT IDENTITY at its defaults, so the frame is the only thing distinguishing graded from untouched.' },
  { type: 'videoMixer', prefix: 'video-mixer', domain: 'video', why: 'the 4-channel composite — four faders that SUM have no per-channel observable. Also the module whose testid prefix does NOT match its type, which is why prefixes are declared here rather than computed.' },

  // ── batch 22 · group 1 — landed in #2098 with no render leg ───────────────
  { type: 'edges', prefix: 'edges', domain: 'video', why: 'the Sobel outline filter\'s preview. Stateless and chainable mid-graph (its mono-video out is what colorizer consumes).' },
  { type: 'colorizer', prefix: 'colorizer', domain: 'video', why: 'the mono-to-colour tinter\'s preview. Sits mid-chain by construction (mono-video in, video out).' },
  { type: 'inwards', prefix: 'inwards', domain: 'video', why: 'the concentric-ring generator\'s preview. A SOURCE with no video input, so a lapsed watch mark would mute the generator every downstream node samples.' },
  { type: 'vdelay', prefix: 'vdelay', domain: 'video', why: 'the video delay line\'s preview. The ACCUMULATOR case — a 32-slot frame ring advanced by every draw — so SCREEN OFF retaining the mark is load-bearing on the PICTURE, not just the output.' },

  // ── batch 22 · group 2a — landed in #2099 with no render leg ──────────────
  { type: 'lumakey', prefix: 'lumakey', domain: 'video', why: 'the luminance-key compositor\'s preview. ⚠ NOT `luma` above: that is the single-input TONE PROCESSOR, this is the two-input COMPOSITOR, and luma.ts carries a header about earlier versions conflating them.' },
  { type: 'shapegen', prefix: 'shapegen', domain: 'video', why: 'the generative 3-D shape synthesiser\'s preview. A GENERATOR whose `out` is the reason to patch it.' },

  // ── MONITOR-MODE modules — the body carries a SECOND switch (#2009/#2053) ──
  //
  // These four mount `hideControls` on their legacy cards and their faced bodies
  // carry a MONITOR toggle beside the SCREEN one. Worth covering precisely
  // because two switches on one surface is where a mis-wired `aria-pressed` or a
  // shared handler would hide: this file drives the SCREEN one specifically.
  { type: 'ruttetra', prefix: 'ruttetra', domain: 'video', why: 'the Rutt/Etra scan processor\'s raster preview — plus a MONITOR toggle and a corner resize on the same surface, so the SCREEN switch has neighbours to be confused with.' },
  { type: 'monoglitch', prefix: 'monoglitch', domain: 'video', why: 'the luma-driven scanline glitch\'s preview; the second MONITOR-mode adopter (#2081).' },
  { type: 'reshaper', prefix: 'reshaper', domain: 'video', why: 'the coordinate-remapper\'s preview; the third MONITOR-mode adopter (#2086). Its SCREEN switch is an ADDITION its card never had.' },
  { type: 'milkdrop', prefix: 'milkdrop', domain: 'video', why: '⚠ THE HIGHEST-VALUE ENTRY IN THIS TABLE: milkdrop is EXEMPT_FROM_VRT and carries a FACES_WITHOUT_SCENES entry, so NO dock baseline exists for it anywhere. This is the ONLY automated check that its faceplate body mounts and operates at all.' },

  // ── the earlier video faces ───────────────────────────────────────────────
  { type: '4plexvid', prefix: 'fourplexvid', domain: 'video', why: 'the four-input switcher\'s output preview. Its prefix is `fourplexvid` because a testid cannot usefully start with a digit — the second entry proving prefixes must be declared.' },
  { type: 'b3ntb0x', prefix: 'b3ntb0x', domain: 'video', why: 'the feedback-bender\'s preview; an animated-video class module whose per-frame churn is exactly what the render freeze below exists for.' },
  { type: 'bentbox', prefix: 'bentbox', domain: 'video', why: 'the pixel-bender\'s preview; argues its watch mark from ACCUMULATED state that empties if the node stops being pulled.' },
  { type: 'colourofmagic', prefix: 'colourofmagic', domain: 'video', why: 'the multi-colorspace processor\'s preview (#2015 — OFF stops the preview copy, never the engine).' },
  { type: 'grainsOfVision', prefix: 'grainsOfVision', domain: 'video', why: 'the video-granulator\'s preview — the #1928 case itself: the toggle a promotion would otherwise have deleted with the card.' },
  { type: 'mandelbulb', prefix: 'mandelbulb', domain: 'video', why: 'the raymarched fractal\'s preview; the heaviest renderer in the table, which is why its cost is measured rather than assumed.' },
  { type: 'mirrorpool', prefix: 'mirrorpool', domain: 'video', why: 'the kaleidoscopic reflector\'s preview; its ping-pong height field is the case where pinning a clock is NOT sufficient for determinism.' },
  { type: 'outlines', prefix: 'outlines', domain: 'video', why: 'the edge-detector\'s preview; the module whose hard-coded `mapped` output MAPPER generalises.' },
  { type: 'spirographs', prefix: 'spirographs', domain: 'video', why: 'the harmonograph\'s plot canvas — the module whose right-hand TEXT column the 2026-08-19 ruling deleted, leaving the picture as the surface.' },
  { type: 'warrensvisions', prefix: 'warrensvisions', domain: 'video', why: 'the shader-visions preview canvas.' },

  // ── batch 22 · group 2b — landed on main WHILE THIS FILE WAS IN REVIEW ────
  //
  // ⚠ ADDED BY A MERGE, NOT BY THIS FILE'S AUTHOR, and that is the convention in
  // this file's header working on its very first encounter. G2b (#2100) merged
  // `tempest` + `fader` after this table was enumerated, so absorbing main into
  // the G4 branch brought two faced video modules with SCREEN switches and no
  // render leg. Leaving them out would have shipped a file whose own header
  // claims to cover "every faced module with a SCREEN switch that had no
  // render-level leg" while two already fell outside it.
  //
  // Verified before adding rather than assumed: both declare
  // `<type>-face-screen-toggle` + `<type>-face-canvas`, and both use the same
  // `{#if !previewCollapsed}` REMOVES mechanism as the other 25, so the
  // `toHaveCount(0)` leg is correct for them too.
  { type: 'tempest', prefix: 'tempest', domain: 'video', why: 'the geometry well\'s preview. One of the two G2b faces that cost an attest for their `options` rosters — its named SHAPE selector is resolved from the def, so the picture is where you confirm the selection did something.' },
  { type: 'fader', prefix: 'fader', domain: 'video', why: 'the A/B transition mixer\'s main OUT preview. ⚠ The strongest watch-mark case in the roster: it has TWO outputs — `out` and the `send` feeding an external FX loop — so a lapsed mark stalls an output the switch does not even show.' },

  // ── THE CONSOLIDATION ROWS — batch-22 G3, scoreboard, and the two the ─────
  // ── absorb brought in without them ────────────────────────────────────────
  //
  // ⚠ THIS BLOCK IS WHY THE CONSOLIDATION WAS WORTH DOING. This file exists only
  // on the G4 branch, so G3, scoreboard, cellshade and quadralogical could not
  // add their own rows even in principle — their PRs had no table to extend. One
  // combined PR is the only place the gap closes, and it closes for seven modules
  // at once.
  //
  // Verified per module before writing, not assumed: `type == prefix ==
  // extension id` for all seven except where noted, every body uses the same
  // `{#if !previewCollapsed}` REMOVES mechanism, and each declares
  // `<type>-face-screen-toggle`.
  { type: 'posterbox', prefix: 'posterbox', domain: 'video', why: 'the palette-crush processor\'s live preview and its SCREEN switch (batch-22 G3).' },
  { type: 'tiler', prefix: 'tiler', domain: 'video', why: 'the kaleidoscopic tiler\'s live preview and its SCREEN switch (batch-22 G3).' },
  { type: 'sourcery', prefix: 'sourcery', domain: 'video', why: 'the source-router\'s live preview and its SCREEN switch (batch-22 G3).' },
  { type: 'onetonine', prefix: 'onetonine', domain: 'video', why: 'the 1-to-9 splitter\'s live preview and its SCREEN switch (batch-22 G3) — the module whose declared-vs-rendered `showGrid` mismatch is #2090.' },
  { type: 'cellshade', prefix: 'cellshade', domain: 'video', why: 'the cel-shader\'s live preview and its SCREEN switch (batch-21). Arrived on main mid-flight and had no row until this consolidation.' },
  { type: 'scoreboard', prefix: 'scoreboard', domain: 'video', why: '⚠ the module the batch-22 derivation predicted would NOT fit this table — "its canvas is SELF-DRAWN, not a video-out blit, so OFF stops the blit has no blit to stop". Its lane resolved that: the body calls `blitOutputForPreview` and `markWatched` like every sibling, so it takes an ordinary row. Verified against the body, not inherited from the prediction.' },
  {
    type: 'quadralogical',
    prefix: 'quadralogical',
    domain: 'video',
    // ⚠ THE ONE THAT NEEDS THE OVERRIDE, AND THE ONE THAT MOST NEEDS THE ROW.
    canvas: 'quadralogical-face-quadrants',
    why:
      '⚠ THE HIGHEST-VALUE ROW IN THIS FILE AS OF THIS PR. quadralogical\'s own render spec has '
      + 'exactly TWO tests and BOTH are `test.fixme` FLAKE-PARKED on main (#1847, under-budgeted '
      + 'on hot shards), and no other spec in the tree references `quadralogical-face-screen-toggle`. '
      + 'So its SCREEN switch has ZERO live render coverage without this row — the parked legs are '
      + 'not a reduced signal, they are no signal. Its faceplate IS its joystick, so the element '
      + 'inside `{#if !previewCollapsed}` is `quadralogical-face-quadrants` rather than a '
      + 'conventionally-named canvas, which is what the `canvas` override exists for.',
  },

  // ── batch-23a — PAYING A DEBT THIS PR'S PREDECESSOR DECLARED ──────────────
  //
  // ⚠ #2124 (peakstate + lines) MERGED WITHOUT ROWS HERE, AND SAID SO IN ITS OWN
  // BODY. Not an omission: this file lives only on the consolidation branch, so
  // #2124 could not have added them without basing itself on an unmerged PR and
  // dragging that whole diff into its review. Its body recorded the debt, named
  // the reason, and named the place it would be paid — this absorb. That is the
  // difference between a gap and a deferral: one is discovered later by someone
  // else, the other arrives with an address.
  //
  // ⚠ AND THE PRECEDENT FOR PAYING IT PROMPTLY IS TWENTY LINES UP. `quadralogical`
  // reached main with its two render legs PARKED and no row here, which left its
  // SCREEN switch at zero live coverage while everyone believed it covered. The
  // same slip on these two would have been invisible for the same reason.
  //
  // Verified before writing, not assumed: `type == prefix == extension id` for
  // both, both bodies use the standard `{#if !previewCollapsed}` REMOVES
  // mechanism, and both declare the conventional `<type>-face-canvas` — so
  // neither needs the `canvas` override quadralogical does.
  { type: 'peakstate', prefix: 'peakstate', domain: 'video', why: 'the kaleidoscope pen-trace\'s live mandala and its SCREEN switch. ⚠ The ACCUMULATOR case: the picture IS a pen ring of trace history whose advance is unconditional by design, so a lapsed watch mark freezes the mandala mid-figure for all THREE outputs, which share one ring. Its body also swaps the card\'s ungated 30 Hz `read(\'previewCanvas\')` poll for the fleet `blitOutputForPreview` — same surface, but gated and legible to the port seam.' },
  { type: 'lines', prefix: 'lines', domain: 'video', why: 'the procedural grating\'s live preview and its SCREEN switch — an ADDITION, since LinesCard never drew a preview. ⚠ NOT stateless despite having no accumulator: its shader reads a time term and the pattern auto-scrolls at rest, so a lapsed mark freezes a MOVING picture every downstream consumer is sampling.' },

  // ── batch 23b ─────────────────────────────────────────────────────────────
  { type: 'shapes', prefix: 'shapes', domain: 'video', why: 'the SDF primitive generator\'s live stamp preview and its SCREEN switch. ⚠ NOT `shapegen`, which has its own row above — different module, adjacent name. A SOURCE with no input, so a lapsed watch mark would mute the origin of the whole chain rather than stall a preview.' },

  // ── cut A · batch 2 ───────────────────────────────────────────────────────
  //
  // ⚠ ONLY ONE ROW FOR A TWO-FACE BATCH, and the absence is the interesting
  // half. `dockscope` also gains a `fullViewBody` in this diff and is
  // deliberately NOT here: it declares `outputs: []`, so its trace is not a
  // monitor OF the module, it IS the module, and it ships with NO SCREEN
  // SWITCH — `videoOut`'s exemption argument on an audio def the video gate
  // never reaches. A row here would assert a toggle that does not exist, which
  // is why the omission is written down instead of left to be noticed.
  { type: 'shapedramps', prefix: 'shapedramps', domain: 'video', why: 'the parametric ramp generator\'s live output preview and its SCREEN switch — an ADDITION, since ShapedrampsCard mounts no canvas at all. ⚠ The widest-tap watch-mark case in this file: SIX outputs, four of them pure functions of vUv with no input, and the preview shows only `h_out` — so five of the six are invisible on the very surface whose switch would mute them. Its two identity ramps are invariant to every knob and CV, so if they went dark nothing on the plate would move to say why.' },
  // ── the CROSS-DOMAIN INPUT case ───────────────────────────────────────────
  //
  // ⚠ THE MIRROR OF `rasterize` BELOW, and worth the adjacency. That one is an
  // AUDIO def carrying a video surface; this is a VIDEO def whose only INPUTS
  // are audio-typed (`audio_l` / `audio_r` — the cross-domain audio→video
  // bridge). It spawns with `domain: 'video'`, so a domain-derived enumeration
  // finds it correctly and no special-casing is needed — which is exactly the
  // fact worth pinning here, because the audio inputs make it LOOK like the
  // outlier it is not.
  { type: 'graphicEq', prefix: 'graphicEq', domain: 'video', why: 'the spectrum meters\' preview, and the last of the five #2009 MONITOR cards — so its body carries a MONITOR toggle and a corner resize BESIDE the SCREEN switch, which is the two-switches-on-one-surface case a mis-wired `aria-pressed` or a shared handler would hide in. ⚠ AND IT IS THE ACCUMULATOR CASE AMONG THEM: per-band peak-hold caps advanced once per draw plus `smoothingTimeConstant = 0.7` on both analysers, so SCREEN OFF retaining the watch mark is load-bearing on what the meters MEAN, not just on the output — a lapsed mark returns a frame asserting peaks from whenever it expired.' },
  // ── batch 24 — CUT A, batch 1: the four plain video faces ─────────────────
  //
  // Added in the SAME diff as the promotions, which is this file's stated
  // convention and the thing #2124 could not do and had to defer. Verified
  // before writing rather than assumed, on all four: `type == prefix ==
  // extension id`, each body uses the standard `{#if !previewCollapsed}` REMOVES
  // mechanism, and each declares the conventional `<type>-face-canvas` — so none
  // of them needs the `canvas` override `quadralogical` does.
  { type: 'chroma', prefix: 'chroma', domain: 'video', why: 'the single-input colour grade\'s preview and its SCREEN switch — an ADDITION, since ChromaCard draws no preview at all. ⚠ NOT `chromakey` below: this is the GRADE, that is the COMPOSITOR, and chroma.ts carries a header about earlier versions conflating exactly these two. Holds no history of any kind, so its watch-mark argument is purely about the PULL: it sits mid-chain on one video input, and a lapsed mark idles the chain behind it.' },
  { type: 'chromakey', prefix: 'chromakey', domain: 'video', why: 'the two-input compositor\'s preview and its SCREEN switch — also an ADDITION. ⚠ The sharpest PULL case in this batch: it is the pull root for TWO upstream chains (`fg` and `bg`), so a lapsed watch mark idles both branches of the composite rather than one. Its key colour ships as pure green, so the resting picture is the composite of two absent inputs.' },
  { type: 'feedback', prefix: 'feedback', domain: 'video', why: '⚠ THE ACCUMULATOR CASE OF THIS BATCH, and the row worth having for it. FEEDBACK re-samples its OWN previous output from a ping-pong framebuffer, so the pull is not how the picture stays fresh — it is how the TRAIL EXISTS. A lapsed watch mark decays the accumulated image out of the patch and turns a control labelled SCREEN into a history eraser. Its card already drew this preview; the face adds the toggle it never had.' },
  { type: 'mandleblot', prefix: 'mandleblot', domain: 'video', why: 'the Mandelbrot explorer\'s preview and its SCREEN switch. ⚠ NOT stateless despite holding no accumulator: `uTime * 0.1 * uColorCycle` cycles the palette and `color_cycle` ships at 1, so a lapsed mark freezes a MOVING picture that is also the ORIGIN of its chain — the module\'s only input is a CV. The heaviest renderer of the four, which is why its cost is measured rather than assumed.' },

  // ── the ONE-SHOT INGEST pair (#2154) ──────────────────────────────────────
  //
  // Added in the SAME diff as the promotion, per this file's convention.
  // Verified before writing: `type == prefix == extension id`, the body uses the
  // standard `{#if !previewCollapsed}` REMOVES mechanism, and it declares the
  // conventional `<type>-face-canvas` — so no `canvas` override is needed.
  { type: 'frametable', prefix: 'frametable', domain: 'video', why: '⚠ THE DEEPEST ACCUMULATOR IN THIS FILE, and the row earns its place on that alone: a SIXTY-LAYER GPU ring advanced once per draw, where `vdelay` (32 slots) and `feedback` (one ping-pong tap) are the nearest cases. A lapsed watch mark does not decay a trail or stall a preview — it punches a PERMANENT HOLE in a history the player scans BACK through with MORPH, and the def says so itself: `pullExempt` exists because "a gap from a paused-while-unwatched period would be a visible seam the instant you MORPH back through it". So SCREEN OFF retaining the mark is load-bearing on the module\'s SUBJECT, not merely on its output. Its card already drew this preview at 176x92; what the face adds is the toggle it never had.' },
  // ── the AUDIO-def outlier ─────────────────────────────────────────────────
  { type: 'rasterize', prefix: 'rasterize', domain: 'audio', why: '⚠ an AudioModuleDef that carries a VIDEO surface, so it lives in lib/audio/modules and a video-only enumeration misses it entirely. Spawns with domain: audio. It is the reason this file\'s derivation crosses both domains.' },
] as const;

/** The representative module for the PERSISTENCE leg — see that test's comment. */
const PERSISTENCE_SUBJECT = 'videoMixer';

/**
 * ⚠ FREEZE THE PER-FRAME GL DRAW — the lever `freezeframe-screen-toggle.spec.ts`
 * pulls, for the reason it records. Each of these bodies runs a rAF loop calling
 * `blitOutputForPreview` + `drawPreviewDownscaled` EVERY frame for the life of the
 * test. On CI's two-core runner under SwiftShader that saturates the main thread,
 * and anything resolving on that same thread gets starved past the budget — a
 * wall-clock bump would only buy a slower failure. It matters more here than in a
 * single-module spec: this table includes a raymarcher and a butterchurn visualiser.
 *
 * It costs these tests NOTHING, and that is worth stating rather than assuming:
 * every subject below is a DOM or LAYOUT fact. None reads a pixel.
 */
async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

/** Bring the node into the viewport. The lane band sits far down in flow space, so
 *  without this the tile is off-screen and every click times out — and it also ARMS
 *  the video visibility gate that decides whether the node renders at all.
 *  (The `freezeframe-screen-toggle` / `backdraft-preview-toggle` pattern.) */
async function centerOnNode(page: Page, nodeId: string, zoom = 0.9): Promise<void> {
  await page.evaluate(
    ({ nodeId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => {
            internals?: { positionAbsolute?: { x: number; y: number } };
            position?: { x: number; y: number };
            measured?: { width?: number; height?: number };
          } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const n = w.__flow.getInternalNode(nodeId);
      if (!n) return;
      const x = n.internals?.positionAbsolute?.x ?? n.position?.x ?? 0;
      const y = n.internals?.positionAbsolute?.y ?? n.position?.y ?? 0;
      const cx = x + (n.measured?.width ?? 192) / 2;
      const cy = y + (n.measured?.height ?? 180) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      // Upper QUARTER, not the centre: the dock full view opens over the lower
      // half of the pane and would cover a centred tile.
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 4 - cy * zoom, zoom }, { duration: 0 });
    },
    { nodeId, zoom },
  );
  await waitFrames(page, 4);
}

/** The node id for a subject inside a shared batch rack — unique per module so one
 *  rack can hold a whole batch. */
function nodeId(type: string): string {
  return `sut-${type}`;
}

/**
 * Boot the DEFAULT shell (what actually ships) ONCE and spawn a whole BATCH of
 * subjects into one rack. ⚠ NOT `?shell=legacy`: that is precisely the surface
 * promotion does NOT change, and testing it is the #1934 mistake this file must not
 * repeat.
 *
 * ⚠ ONE BOOT PER BATCH, NOT PER MODULE — and the number is MEASURED, not guessed.
 * Every leg used to run its own `goto /rack` + spawn + dock open. Measured locally
 * under `E2E_SWIFTSHADER=1`: one test alone is 11.6 s wall, the full file at 2
 * workers was 51.2 s ⇒ a fixed ~8.6 s and a MARGINAL ~3.0 s per test, nearly all of
 * it page boot. With 27 module legs that is ~81 s of booting to prove 27 DOM facts.
 *
 * That cost is not just this file's problem, which is the real reason it changed:
 * the spec rides the 22 s MEDIAN in `e2e-timings.generated.json` until its first
 * accept, and a 28-test lump costed at 22 s perturbs the whole e2e bin-packing —
 * measured, adding this one file changes the composition of NINE of the TEN shards.
 * Batching amortises the boot without weakening a single assertion: every module
 * still gets its own dock open, its own toggle, and its own named failure.
 */
async function bootBatch(page: Page, batch: readonly Subject[]) {
  await freezeVideoRender(page);
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar'))
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  await spawnPatch(
    page,
    batch.map((s, i) => ({
      id: nodeId(s.type),
      type: s.type,
      // Spread so tiles do not overlap; `centerOnNode` re-frames before each dock
      // open regardless, and only one dock is open at a time.
      position: { x: 400 + (i % 4) * 420, y: 60 + Math.floor(i / 4) * 320 },
      domain: s.domain,
      params: {},
    })),
    [],
  );
}

/** Open ONE subject's dock faceplate inside an already-booted batch rack. */
async function openDockFor(page: Page, type: string) {
  await centerOnNode(page, nodeId(type));
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId(type)}"] [data-testid="module-shell"]`);
  await expect(shell, `the ${type} shell tile`)
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  await expect(page.getByTestId('dock-full-view'), `the ${type} dock full view`)
    // Mount-dependent, so bounded from the ONE export site rather than left on
    // the 5 s default — the same correction the polls below carry.
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
}

/** Close the dock and PROVE it closed — so a module that fails to release the pane
 *  fails HERE, naming itself, rather than corrupting the next module in the batch
 *  with a confusing locator error. This is what keeps a batched test's failures as
 *  legible as the one-test-per-module version's were. */
async function closeDock(page: Page, type: string) {
  await page.keyboard.press('Escape');
  await expect(
    page.getByTestId('dock-full-view'),
    `${type}: the dock must close before the next module in this batch opens`,
  ).toHaveCount(0);
}

/** Boot a rack holding exactly ONE subject and open its dock. */
async function openFaceSolo(page: Page, s: Subject) {
  await bootBatch(page, [s]);
  await openDockFor(page, s.type);
}

/** The SUBJECTS split into batches that share one page boot.
 *
 * ⚠ THE BATCH SIZE IS A COST KNOB, NOT A GROUPING CLAIM. Modules are chunked in
 * declaration order; no batch means anything, and nothing may be asserted about
 * which modules share one. If a module's placement ever starts to matter, that is a
 * bug in the test, not a fact about the batch. */
const BATCH_SIZE = 7;
const BATCHES: Subject[][] = [];
for (let i = 0; i < SUBJECTS.length; i += BATCH_SIZE) {
  BATCHES.push(SUBJECTS.slice(i, i + BATCH_SIZE));
}

/** The persisted flag, read off the LIVE PATCH rather than off the DOM — the DOM is
 *  the thing under test, so reading it back would prove nothing about whether the
 *  state landed anywhere durable. */
async function persistedCollapsed(page: Page, id: string): Promise<unknown> {
  return page.evaluate((nid) => {
    const w = window as unknown as {
      __patch?: { nodes?: Record<string, { data?: Record<string, unknown> }> };
    };
    return w.__patch?.nodes?.[nid]?.data?.previewCollapsed;
  }, id);
}

for (const [batchIdx, batch] of BATCHES.entries()) {
  test.describe(`SCREEN switch on the FACE — batch ${batchIdx + 1}/${BATCHES.length}`, () => {
    // The SwiftShader budget, from the ONE export site rather than a literal — a
    // flat wall-clock number is a different assertion on every runner, and CI's
    // two-core boxes swing >=2x run-to-run on identical code (#1860/#1906). This
    // BOUNDS the failure; it is not what any test here asserts.
    //
    // ⚠ SCALED BY BATCH SIZE, because one test now covers several modules. A batch
    // does the SAME per-module work the one-test-per-module version did; only the
    // page boot is shared, so the ceiling has to grow with the module count or it
    // becomes a different assertion than it was.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * batch.length);

    test(`${batch.map((s) => s.type).join(', ')} — each is REACHABLE, collapses the picture, RECLAIMS its space, and comes back`, async ({ page }) => {
      await bootBatch(page, batch);

      for (const { type, prefix, why, canvas: canvasId } of batch) {
        // Every assertion below names its module, so a batched failure is exactly
        // as legible as a per-module one. `why` rides into the step name so the
        // reason this module is covered survives into the trace.
        await test.step(`${type} — ${why}`, async () => {
          await openDockFor(page, type);

      // ⚠ SCOPED TO THE FACEPLATE, NOT TO THE PAGE, and this is the correction the
      // fleet-wide run forced. The first draft ended with
      // `expect(canvas).toHaveAttribute('data-node-id', 'sut')` to prove the
      // returned canvas belongs to the node under test. That attribute is carried
      // by only 16 of the 31 `fullViewBody` components in the tree — it is a habit
      // of the bodies copied from one template, NOT a fleet convention — so the
      // assertion passed on the four modules this file started with and failed on
      // TWELVE others while every other leg on them passed. The product was fine;
      // the assertion was over-specific.
      //
      // Scoping the locators to `dock-full-view` proves the stronger thing anyway,
      // and universally: the picture that came back is the one inside THIS
      // faceplate, not some other surface's canvas that happens to share a testid.
      // (Asserting "the same live ELEMENT" was never available here regardless:
      // every body uses `{#if !previewCollapsed}`, so the canvas is remounted by
      // construction — which is the point of RECLAIMING the space.)
      const face = page.getByTestId('dock-full-view');
      const toggle = face.locator(`[data-testid="${prefix}-face-screen-toggle"]`);
      const canvas = face.locator(`[data-testid="${canvasId ?? `${prefix}-face-canvas`}"]`);

      // ⚠ THE LEG NO SOURCE GATE CAN HAVE. Promotion deletes the card from both
      // default surfaces, so if `face.extension` were dropped or its
      // shell-extension stopped resolving there would be NO screen switch anywhere
      // a player can reach.
      //
      // NEGATIVE-CONTROLLED BY HAND BEFORE MERGE, and the result is recorded here
      // because the control cannot live in the tree: deleting
      // `mixerVideoDef.face.extension` makes this exact assertion fail with
      // "the SCREEN switch is on videoMixer's faceplate at all — element(s) not
      // found", and takes the persistence test below down with it. So this file
      // goes RED on the regression it claims to cover.
      //
      // ⚠ BOUNDED WITH THE BOOT BUDGET, NOT LEFT ON PLAYWRIGHT'S 5 s DEFAULT, and
      // the reason is mechanical rather than cautious: this is the ONE assertion in
      // the file waiting on a LAZY chunk. `loadShellExtension` is a non-eager
      // `import.meta.glob`, so the body arrives via a dynamic import that has not
      // started until the dock mounts. A flat 5 s is a different assertion on every
      // runner (#1875/#1906). This BOUNDS the failure; it is not the gate.
      await expect(toggle, `the SCREEN switch is on ${type}'s faceplate at all`)
        .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

      // Absent => false => ON, so an existing rack opens unchanged.
      await expect(toggle, 'starts ON').toHaveAttribute('aria-pressed', 'true');
      await expect(toggle).toHaveText('SCREEN ON');
      await expect(canvas, 'the picture is showing')
        .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
      await expect
        // ⚠ BOUNDED WITH THE BOOT BUDGET, NOT PLAYWRIGHT'S 5 s POLL DEFAULT —
        // and this file WROTE THAT RULE twenty lines up and then failed to apply
        // it to its own polls. CI run 32611882426 shard 3: this exact line and
        // its twin below produced `Timeout 5000ms exceeded while waiting on the
        // predicate` — one hard failure (batch 2) and one recovered-on-retry
        // flake (batch 1), which is a RED run under the #1847 gate either way.
        //
        // ⚠ THE BUDGET WAS THE GATE, WHICH IS THE THING CLAUDE.md FORBIDS. The
        // `toBeVisible()` immediately above PASSED on both failures, so the
        // canvas was mounted and visible; only its measured box had not reached
        // 50 CSS px yet. On a hot 2-core shard under SwiftShader, laying out and
        // painting a 480x360 canvas in a freshly-mounted dock body can take
        // longer than a flat 5 s — a wall-clock cap must BOUND the failure, never
        // decide it. The assertion is unchanged (still > 50 px on the real
        // subject, still auto-retrying); only the time allowed to settle now
        // comes from the ONE export site instead of a library default that is a
        // different assertion on every runner (#1875/#1906).
        .poll(async () => (await canvas.boundingBox())?.height ?? 0, {
          message: `${type}: the preview occupies real vertical space when ON (CSS px)`,
          timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
        })
        .toBeGreaterThan(50);

      await toggle.click();

      await expect(toggle, 'now OFF').toHaveAttribute('aria-pressed', 'false');
      await expect(toggle).toHaveText('SCREEN OFF');
      // ⚠ RECLAIMED, NOT MERELY INVISIBLE. `visibility: hidden` would keep the box
      // and buy the player nothing, which is the point of the ruling — and the
      // whole reason every body in this table uses `{#if !previewCollapsed}` rather
      // than a CSS class. That uniformity was VERIFIED across all 25 surfaces when
      // this table was enumerated, not assumed from the four that came first.
      await expect(canvas, 'the picture is GONE, not hidden').toHaveCount(0);
      // …and the control that turns it back on did not vanish with the picture.
      await expect(toggle, 'the toggle survives its own OFF state').toBeVisible();

      await toggle.click();
      await expect(canvas, 'the picture returns')
        .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
      await expect(toggle, 'back ON').toHaveAttribute('aria-pressed', 'true');
      await expect
        // Same budget, same reason as the poll above — the two are a pair and
        // must not drift apart.
        .poll(async () => (await canvas.boundingBox())?.height ?? 0, {
          message: `${type}: the preview has its space back (CSS px)`,
          timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
        })
        .toBeGreaterThan(50);
      // …and it is THIS faceplate's canvas, not a stray sharing the testid — see
      // the scoping note above. Exactly one, so a duplicate mount is RED too.
      await expect(canvas, 'exactly one preview canvas in this faceplate').toHaveCount(1);

          // Leave the pane clean for the next module in the batch, and PROVE it.
          await closeDock(page, type);
        });
      }
    });
  });
}

test.describe(`${PERSISTENCE_SUBJECT}: the SCREEN state PERSISTS`, () => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

  test('it survives closing and reopening the dock — node.data, not component state', async ({ page }) => {
    // The owner's STATED FLOOR ("the on/off state persists through tab switches"),
    // proven ONCE rather than 25 times: `previewCollapsed` is read and written
    // identically in every body and the source gate checks that in every one, so a
    // copy of this leg per module would cost 25x the CI time to re-prove one
    // mechanism. videoMixer is the representative because it is the JOIN — the node
    // whose collapsed preview a player is most likely to leave collapsed.
    //
    // ⚠ THIS IS THE LEG A `$state` BOOLEAN WOULD FAIL AND EVERY OTHER ASSERTION IN
    // THIS FILE WOULD PASS. The body unmounts with the dock (the #1531/#1574/#1583
    // card-unmount-kills-node-lifetime-state class), so component-local state is
    // exactly what would look correct until you closed the pane.
    //
    // ONE round trip, not one per tab: the parked backdraft persistence test
    // clicked EVERY tab in a loop, which is n chances to lose one coin flip and is
    // why it recovered-on-retry 21 times (#1847). The invariant is node-keyed, so
    // one close/reopen proves it.
    const subject = SUBJECTS.find((s) => s.type === PERSISTENCE_SUBJECT);
    // ANCHORED: if the representative is ever renamed or dropped from the table,
    // this fails loudly rather than silently testing nothing.
    expect(subject, `${PERSISTENCE_SUBJECT} must be in SUBJECTS`).toBeDefined();
    const TOGGLE = `[data-testid="${subject!.prefix}-face-screen-toggle"]`;

    const id = nodeId(subject!.type);
    await openFaceSolo(page, subject!);
    expect(await persistedCollapsed(page, id), 'nothing written before the first click').toBeFalsy();

    await page.locator(TOGGLE).click();
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false');
    expect(await persistedCollapsed(page, id), 'OFF is persisted to the patch').toBe(true);

    await closeDock(page, subject!.type);

    const shell = page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`);
    await shell.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view'))
      .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    await expect(page.locator(TOGGLE), 'still OFF after a remount')
      .toHaveAttribute('aria-pressed', 'false');
    expect(await persistedCollapsed(page, id), 'and still persisted').toBe(true);
  });
});
