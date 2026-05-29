// e2e/vrt/vrt-composite-scenes.ts
//
// Composite-state VRT scenes — a NEW category alongside the per-card scenes
// in vrt-scenes.ts.
//
// What's different from the per-card VRT in vrt.spec.ts:
//   * Two (or more) module cards in the same scene, wired with a patch cord.
//   * The screenshot captures BOTH cards at once (so a reviewer SEES the
//     upstream module driving the downstream module, side-by-side).
//   * The downstream module's state is the regression-locked observable —
//     the upstream module's job is to put the downstream into a known state.
//
// First composite: NIBBLES.length_cv → SCOPE.ch1, swept across 5 levels
// (CV min / 25% / 50% / 75% / max). Uses the deterministic
// `__nibblesForceLength` hook in nibbles.ts to pin the emitted CV without
// depending on the live game state. SCOPE's ch1 trace shifts visibly between
// the 5 snapshots (CV mode draws a horizontal line whose Y position is the
// DC value of the incoming CV); the side-by-side framing makes the cause
// (NIBBLES + the patch cord) explicit.
//
// History: an earlier draft of this scene used QBRT as the downstream
// consumer instead of SCOPE — but QBRT's visible state (cutoff slider
// position) reflects the user-dialed slider, NOT the CV-modulated
// underlying AudioParam, so the 5 QBRT snapshots looked identical and the
// VRT was effectively asserting nothing. SCOPE is the right consumer: its
// trace literally IS the incoming CV (drawn against time), so a sweep of
// the CV produces a sweep of the trace's Y position — a real visible
// regression gate.
//
// The infra here unlocks any future module pair where a signal-flow change
// visibly affects a downstream control / display — see PR body Phase-2
// notes. Scope discipline: this PR adds the NIBBLES→SCOPE sweep ONLY; no
// other composite scenes are queued here.

import type { Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

// NIBBLES_MAX_LENGTH (= 119) lives in
// `packages/web/src/lib/video/modules/nibbles.ts`. We don't import it from
// here because the source file pulls SvelteKit `$lib/...` aliases that
// Playwright's plain TS transform doesn't resolve. If that constant ever
// changes the `nibbles.test.ts` "spirograph-VRT lengths" unit test fails
// first (it pins the resulting CV values explicitly), and the sweep
// lengths below must be recomputed.

/** A composite VRT scene = a setup function that drives the page to a
 *  deterministic two-card state ready for screenshot capture. */
export interface CompositeVrtScene {
  /** Stable id — drives the screenshot filename (`<id>.png`) and the
   *  gallery's clickable entry. Use kebab-case. */
  id: string;
  /** Human label for the gallery (shows under the thumbnail). */
  label: string;
  /** One-line description shown as a blurb in the gallery card. */
  blurb: string;
  /** Set up the rack: spawn modules + patch cables + apply any harness
   *  hooks. The page is already on `/` with the dev globals available. */
  setup: (page: Page) => Promise<void>;
}

// ---- NIBBLES → SCOPE 5-step CV sweep -------------------------------------
//
// Per-spec: pin lengths that map to (length - 59.5) / 59.5 ≈ -1.0 / -0.5 /
// 0.0 / +0.5 / +1.0 (mid = NIBBLES_MAX_LENGTH / 2 = 59.5). The lengths
// below are the closest integer values that hit those CV targets; the unit
// test in packages/web/src/lib/video/modules/nibbles.test.ts pins the
// resulting CV values so the mapping is locked.
//
//   length=1    → CV ≈ -0.983  (CV min — length clamped at floor)
//   length=30   → CV ≈ -0.496  (CV 25%)
//   length=60   → CV ≈ +0.008  (CV 50%)
//   length=89   → CV ≈ +0.496  (CV 75%)
//   length=119  → CV ≈ +1.000  (CV max — NIBBLES_MAX_LENGTH itself)

/** Build a setup function that:
 *  1. Sets `__nibblesForceLength` to a known length BEFORE the modules
 *     spawn (so the CV pins at boot too — no game tick required).
 *  2. Spawns NIBBLES + SCOPE side-by-side. SCOPE.ch1Range = 1 (CV mode,
 *     per PR #418) so the trace scales ±5 V correctly.
 *  3. Patches NIBBLES.length_cv → SCOPE.ch1 (audio input on the audio
 *     domain; the video→audio audio bridge handles cv → audio).
 *  4. Settles a couple of frames so the SCOPE analyser reads a stable
 *     sample of the incoming DC CV.
 */
function setupAt(length: number): (page: Page) => Promise<void> {
  return async (page) => {
    // Pin the NIBBLES RNG seed + force-length BEFORE spawnPatch so:
    //   1. The on-card game render is BYTE-IDENTICAL across all 5 snapshots
    //      (same seed = same snake spawn + same food placement). The only
    //      thing that should differ between the 5 baselines is SCOPE's
    //      ch1 trace Y position (the regression we're locking in — the
    //      CV value drives where the horizontal line is drawn).
    //   2. The forced length pins the length_cv emit value so the CV → SCOPE
    //      ch1 analyser sees a deterministic DC sample.
    // Both hooks are documented in nibbles.ts (`__nibblesVrtSeed` for the
    // game render + `__nibblesForceLength` for the CV path).
    await page.evaluate((len) => {
      const w = globalThis as unknown as {
        __nibblesVrtSeed?: number;
        __nibblesForceLength?: number;
      };
      w.__nibblesVrtSeed = 0xC0DE;
      w.__nibblesForceLength = len;
    }, length);

    await spawnPatch(
      page,
      [
        // NIBBLES (video domain, publishes audio sources for length_cv).
        { id: 'nib', type: 'nibbles', position: { x: 80, y: 80 }, domain: 'video' },
        // SCOPE — placed to the RIGHT of NIBBLES so the screenshot framing
        // shows the patch direction left → right. ch1Range = 1 (CV display
        // mode, per PR #418) so the ±1 CV input renders to a clean
        // horizontal line whose Y position tracks the CV value.
        {
          id: 'sc',
          type: 'scope',
          position: { x: 560, y: 80 },
          domain: 'audio',
          params: { ch1Range: 1 },
        },
      ],
      [
        // length_cv (video, type=cv) → ch1 (audio, type=audio). The
        // cross-domain video→audio audio bridge (engine.ts:
        // addCrossDomainAudioBridge) handles sourceType=cv → audio targets;
        // it .connect()s NIBBLES' ConstantSourceNode straight into SCOPE's
        // ch1 GainNode input + analyser path.
        {
          id: 'e_len_ch1',
          from: { nodeId: 'nib', portId: 'length_cv' },
          to: { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'cv',
          targetType: 'audio',
        },
      ],
    );

    // The patch is established. Let a couple of frames land so the SCOPE
    // analyser fills + the DC sample stabilises before we snap. We
    // also re-pin the hook here as a belt-and-braces — spawnPatch clears the
    // graph then re-creates it, and depending on factory timing the boot-
    // time pickup may have missed (the post-spawn draw covers it but only
    // after at least one rAF lands).
    await page.evaluate((len) => {
      (globalThis as unknown as { __nibblesForceLength?: number }).__nibblesForceLength = len;
    }, length);

    // A few rAFs so the forced-length push lands + the analyser tap has a
    // chance to average a stable sample.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => r())),
      );
    }
    // Plus a short wait so the SCOPE analyser samples catch the new CV.
    await page.waitForTimeout(150);

    // SUSPEND the AudioContext so the game tick (advanced via
    // requestAnimationFrame's frame.time which the engine derives from
    // ac.currentTime) freezes — keeps the on-card NIBBLES render
    // pixel-stable across runs, regardless of wall-clock skew between
    // spawn and screenshot. Mirrors the pattern used by other VRT scenes
    // (RUTTETRA / RASTERIZE / FOXY). The CV value already lives on the
    // ConstantSourceNode's offset; suspending the context doesn't reset
    // it (web audio holds the last scheduled value), so the SCOPE
    // analyser's most-recent buffered samples stay at the pinned target.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
      const eng = w.__engine?.();
      if (!eng) return;
      try { await eng.ctx.suspend(); } catch { /* already suspended / closed */ }
    });
    // One more rAF so the last pre-suspend frame finishes rendering.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => r())),
    );
  };
}

/** All composite VRT scenes. Iterated by `vrt-composite.spec.ts`. */
export const COMPOSITE_VRT_SCENES: CompositeVrtScene[] = [
  {
    id: 'nibbles-cv-min',
    label: 'NIBBLES→SCOPE: CV min (length=1)',
    blurb: 'NIBBLES.length_cv ≈ −0.98 → SCOPE ch1 trace at its lowest Y.',
    setup: setupAt(1),
  },
  {
    id: 'nibbles-cv-25',
    label: 'NIBBLES→SCOPE: CV 25% (length=30)',
    blurb: 'NIBBLES.length_cv ≈ −0.50 → SCOPE ch1 trace 25% above the floor.',
    setup: setupAt(30),
  },
  {
    id: 'nibbles-cv-50',
    label: 'NIBBLES→SCOPE: CV 50% (length=60)',
    blurb: 'NIBBLES.length_cv ≈ +0.01 → SCOPE ch1 trace near zero (centre).',
    setup: setupAt(60),
  },
  {
    id: 'nibbles-cv-75',
    label: 'NIBBLES→SCOPE: CV 75% (length=89)',
    blurb: 'NIBBLES.length_cv ≈ +0.50 → SCOPE ch1 trace 75% above the floor.',
    setup: setupAt(89),
  },
  {
    id: 'nibbles-cv-max',
    label: 'NIBBLES→SCOPE: CV max (length=119)',
    blurb: 'NIBBLES.length_cv = +1.00 → SCOPE ch1 trace at its highest Y.',
    setup: setupAt(119),
  },
];
