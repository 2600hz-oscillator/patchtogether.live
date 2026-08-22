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
// subtracting the ones an existing spec references: **25 uncovered surfaces**.
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

/** Spawn one subject on the DEFAULT shell (what actually ships) and open its dock
 *  faceplate. ⚠ NOT `?shell=legacy`: that is precisely the surface promotion does
 *  NOT change, and testing it is the #1934 mistake this file must not repeat. */
async function openFace(page: Page, type: string, domain: 'audio' | 'video') {
  await freezeVideoRender(page);
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar'))
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  await spawnPatch(
    page,
    [{ id: 'sut', type, position: { x: 400, y: 60 }, domain, params: {} }],
    [],
  );
  await centerOnNode(page, 'sut');

  const shell = page.locator('.svelte-flow__node[data-id="sut"] [data-testid="module-shell"]');
  await expect(shell, `the ${type} shell tile`)
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  await expect(page.getByTestId('dock-full-view'), `the ${type} dock full view`).toBeVisible();
}

/** The persisted flag, read off the LIVE PATCH rather than off the DOM — the DOM is
 *  the thing under test, so reading it back would prove nothing about whether the
 *  state landed anywhere durable. */
async function persistedCollapsed(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __patch?: { nodes?: Record<string, { data?: Record<string, unknown> }> };
    };
    return w.__patch?.nodes?.sut?.data?.previewCollapsed;
  });
}

for (const { type, prefix, domain, why } of SUBJECTS) {
  test.describe(`${type}: the SCREEN switch on the FACE`, () => {
    // The SwiftShader budget, from the ONE export site rather than a literal — a
    // flat wall-clock number is a different assertion on every runner, and CI's
    // two-core boxes swing >=2x run-to-run on identical code (#1860/#1906). This
    // BOUNDS the failure; it is not what any test here asserts.
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

    test(`is REACHABLE, collapses the picture, RECLAIMS its space, and comes back — ${why}`, async ({ page }) => {
      await openFace(page, type, domain);

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
      const canvas = face.locator(`[data-testid="${prefix}-face-canvas"]`);

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
      await expect(canvas, 'the picture is showing').toBeVisible();
      await expect
        .poll(async () => (await canvas.boundingBox())?.height ?? 0, {
          message: `${type}: the preview occupies real vertical space when ON (CSS px)`,
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
      await expect(canvas, 'the picture returns').toBeVisible();
      await expect(toggle, 'back ON').toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(async () => (await canvas.boundingBox())?.height ?? 0, {
          message: `${type}: the preview has its space back (CSS px)`,
        })
        .toBeGreaterThan(50);
      // …and it is THIS faceplate's canvas, not a stray sharing the testid — see
      // the scoping note above. Exactly one, so a duplicate mount is RED too.
      await expect(canvas, 'exactly one preview canvas in this faceplate').toHaveCount(1);
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

    await openFace(page, subject!.type, subject!.domain);
    expect(await persistedCollapsed(page), 'nothing written before the first click').toBeFalsy();

    await page.locator(TOGGLE).click();
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'false');
    expect(await persistedCollapsed(page), 'OFF is persisted to the patch').toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);

    const shell = page.locator('.svelte-flow__node[data-id="sut"] [data-testid="module-shell"]');
    await shell.getByTestId('shell-open-dock').click();
    await expect(page.getByTestId('dock-full-view')).toBeVisible();

    await expect(page.locator(TOGGLE), 'still OFF after a remount')
      .toHaveAttribute('aria-pressed', 'false');
    expect(await persistedCollapsed(page), 'and still persisted').toBe(true);
  });
});
