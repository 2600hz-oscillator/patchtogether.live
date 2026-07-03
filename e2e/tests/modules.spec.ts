// e2e/tests/modules.spec.ts
//
// Per-module smoke check: spawn one instance of every registered module,
// assert the card renders with the right handle count, contains the
// module's label substring, and produces no console / page errors.
//
// Iterates the synthesised registry manifest (`e2e/.generated/
// registry-manifest.json`), so adding a new module auto-enrols it here —
// no edits required. Handle count is derived as `inputs.length +
// outputs.length` rather than hand-counted, and the label substring
// comes from the def's `label` field.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { REGISTRY } from './_registry';

// Modules whose card doesn't render under bare spawnPatch (needs
// `data.children`, depends on hardware, etc.) — skipped here with a
// reason and a pointer at the dedicated coverage. Separate from
// io-spec-consistency.SKIP_DEF_VS_UI because the failure mode each
// spec catches is different (handle-count vs def↔UI parity); the
// canonical list of "needs follow-up" modules lives in the
// io-spec spec.
const SKIP_RENDER: Record<string, string> = {
  // Bare spawnPatch({type:'group'}) doesn't render the Svelte Flow
  // node — the group card body lifts chrome from `data.children`
  // which we don't supply. Functional coverage:
  // e2e/tests/grouping-phase1.spec.ts.
  group: 'requires data.children; covered by e2e/tests/grouping-phase1.spec.ts',
  // CADILLAC renders as a roaming overlay sprite, NOT as a SvelteFlow
  // card — Canvas.svelte filters the type out of flowNodes so xyflow
  // doesn't paint a fallback box at the spawn point. There is no
  // `.svelte-flow__node-cadillac` to assert against. Functional coverage:
  // e2e/tests/cadillac.spec.ts (drive + delete + self-destruct).
  cadillac: 'overlay sprite, not a flow card; covered by e2e/tests/cadillac.spec.ts',
  // QBERT fetches a user-provided ROM zip from /roms/qbert/qbert.zip at
  // spawn time. On a clean checkout (no ROM installed) this 404s by
  // design — the card surfaces the "ROM MISSING" overlay. The 404
  // surfaces as a Chromium console error which this strict spec rejects.
  // Dedicated coverage: e2e/tests/qbert-rom-missing.spec.ts (asserts
  // overlay + handle count, filtering the expected 404). The handle
  // count + CV path are also covered by per-module-per-port specs.
  qbert: 'fetches user-provided ROM (404s on clean checkout); covered by e2e/tests/qbert-rom-missing.spec.ts',
  // SNES9X auto-fetches /roms/snes9x/game.sfc at spawn (DOOM-style autoload).
  // On a clean checkout (no user-provided ROM) that 404s by design — the card
  // shows the "LOAD A ROM" dropzone. The 404 surfaces as a Chromium console
  // error that this strict "no console errors" smoke rejects. Under the
  // prebuilt `vite preview` server the static 404 is returned synchronously,
  // so it lands before the assertion every time (under the dev server the
  // async autoload occasionally lost the race → latent flake). Same shape as
  // qbert. Dedicated coverage that tolerates the expected 404: the no-ROM
  // dropzone path in e2e/tests/snes9x.spec.ts (+ snes9x-gameplay-gates.spec.ts
  // when a ROM is installed); handle count + CV/GATE wiring also covered by
  // the per-module-per-port specs.
  snes9x: 'fetches user-provided ROM (404s on clean checkout); covered by e2e/tests/snes9x.spec.ts',
  // GIBRIBBON renders DOOM-WAD sprites; the shareware DOOM1.WAD is gitignored
  // and baked in by the build-web job (SHA-pinned download from an external
  // mirror). On a clean checkout — OR when that single-mirror download misses
  // transiently in CI — the spawn-time fetch 404s, which this strict "no console
  // errors" smoke rejects. Same shape as qbert/snes9x (its siblings were already
  // exempted; gibribbon was overlooked → a latent flake that fired on PR #832's
  // shard 4). Render coverage lives in e2e/tests/gibribbon.spec.ts; the real cure
  // for the flake is hardening the build-web WAD acquisition (task #83).
  gibribbon: 'renders the gitignored DOOM WAD (404s on clean checkout / transient build-web miss); covered by e2e/tests/gibribbon.spec.ts',
};

// WebGL-heavy modules whose FIRST-paint is slow on CI's SwiftShader software
// renderer — markedly slower at 1024×768 (#662, 2.56× the pixels of the old
// 640×480). The generic 5s spawn-readiness wait + 30s default test timeout
// aren't enough to mount + measure them on CI (b3ntb0x's 8×-oversampled NTSC
// chain, mandleblot's per-pixel GPU fractal). We still assert presence +
// handle-count + non-zero box for these (their cheap, structural coverage);
// we only grant a longer budget so the heavy first-paint can complete. Their
// DEEP render behaviour is covered by dedicated heavy-lane specs
// (b3ntb0x.spec.ts; mandleblot-render-smoke.spec.ts — both routed to the
// serialized e2e-video lane via WEBGL_HEAVY_GLOBS in playwright.config.ts).
// Also includes 'twotracks': xyflow keeps the node wrapper visibility:hidden
// until ResizeObserver fires; on CI's production preview bundle TwotracksCard
// (580px wide, complex layout) can take longer than the default 5s.
// And 'mandelbulb': a per-pixel GPU 3D fractal raymarcher (the 3D sibling of
// mandleblot, already heavy here) whose first-paint shader compile on CI's
// SwiftShader software renderer overruns the default 30s test budget — give it
// the same heavy headroom (structural assertions unchanged).
const HEAVY_RENDER = new Set(['b3ntb0x', 'mandleblot', 'mandelbulb', 'twotracks']);
const HEAVY_MOUNT_TIMEOUT = 30_000;
const HEAVY_TEST_TIMEOUT = 90_000;

// QUARANTINED (known flake) pending follow-up tasks — these single rows are
// skipped via `test.fixme` so they stop blocking otherwise-green merges, while
// the rest of this registry sweep keeps running for every other module.
// Distinct from SKIP_RENDER above (modules that legitimately can't render under
// bare spawnPatch + have dedicated coverage): a QUARANTINE entry is a module
// that SHOULD render here but currently flakes, and whose un-fixme is owned by
// the referenced task.
const QUARANTINE: Record<string, string> = {
  // task #102 — TOYBOX is WebGL-heavy and times out at the 30s default test
  // timeout on CI's SwiftShader software renderer (ci-swiftshader-video-e2e
  // timeout class; heavy first-paint, passes locally on a real GPU). Skipped
  // until #102 lands SwiftShader-scaled timeouts / WEBGL_HEAVY routing for it
  // and restores this coverage, THEN un-fixme.
  toybox: 'task #102: SwiftShader software-renderer timeout (heavy WebGL); restore coverage then un-fixme',
};

test.describe.configure({ mode: 'parallel' });

for (const mod of REGISTRY) {
  const expectedHandleCount = mod.inputs.length + mod.outputs.length;
  const skipReason = SKIP_RENDER[mod.type];
  if (skipReason) {
    test.fixme(
      `module ${mod.type} renders [SKIPPED: ${skipReason}]`,
      () => { /* see SKIP_RENDER for the alternative coverage */ },
    );
    continue;
  }
  const quarantineReason = QUARANTINE[mod.type];
  if (quarantineReason) {
    test.fixme(
      `module ${mod.type} renders + has ${expectedHandleCount} handles + no console errors`,
      () => { /* QUARANTINED — see QUARANTINE map: ${quarantineReason} */ },
    );
    continue;
  }
  const isHeavy = HEAVY_RENDER.has(mod.type);
  test(`module ${mod.type} renders + has ${expectedHandleCount} handles + no console errors`, async ({
    page,
  }) => {
    // Heavy WebGL cards first-paint slowly on CI SwiftShader at 1024×768 —
    // give them headroom before the (cheap, structural) assertions below.
    if (isHeavy) test.setTimeout(HEAVY_TEST_TIMEOUT);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        {
          id: 'm-1',
          type: mod.type,
          position: { x: 100, y: 100 },
          domain: mod.domain,
        },
      ],
      [],
      isHeavy ? { mountTimeout: HEAVY_MOUNT_TIMEOUT } : undefined,
    );

    const cardClass = `svelte-flow__node-${mod.type}`;
    const card = page.locator(`.${cardClass}`);
    await expect(card, `${mod.type} card visible`).toBeVisible(
      isHeavy ? { timeout: HEAVY_MOUNT_TIMEOUT } : undefined,
    );
    // Title-text assertion: nearly every card now hosts the editable
    // name button (see ModuleNameLabel.svelte). The default auto-assigned
    // name for the first instance is the BARE uppercased type prefix
    // (e.g. "WAVESCULPT"); subsequent instances get "<TYPE>2", "<TYPE>3",
    // ... — see the bare-prefix policy in $lib/multiplayer/module-naming.ts.
    // Use a regex so the test stays valid regardless of how many instances
    // spawned earlier in the same browser context, AND so per-card chrome
    // (punctuation in `mod.label` like "MIDI-CV-BUDDY" or "NUMPAD+") doesn't
    // drift this.
    //
    // A couple of meta-domain cards (sticky, group) intentionally render
    // their own chrome without ModuleTitle (sticky has a static "STICKY"
    // badge + freeform textarea; group has its own rename UX via
    // `data.label`). For those, fall back to the legacy `mod.label`
    // substring check — the same assertion the test made before the
    // in-card-title sweep.
    const nameButton = card.locator('[data-testid="name-label-button"]');
    if (await nameButton.count() > 0) {
      const prefix = mod.type.toUpperCase();
      const namePattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)?$`);
      await expect(nameButton, `${mod.type} name matches /<TYPE>(\\d+)?/`).toHaveText(namePattern);
    } else {
      // Cards without the editable name button (sticky/group) still
      // surface SOME identifying text — the def's label.
      await expect(card, `${mod.type} contains def label`).toContainText(mod.label, {
        ignoreCase: true,
      });
    }

    const handles = card.locator('.svelte-flow__handle');
    await expect(handles, `${mod.type} handle count`).toHaveCount(expectedHandleCount);

    // Card has non-zero rect (catches the silent-DOM-only failure mode).
    const box = await card.boundingBox();
    expect(box, `${mod.type} bounding box`).toBeTruthy();
    expect(box!.width).toBeGreaterThan(50);
    expect(box!.height).toBeGreaterThan(50);

    expect(
      errors,
      `console/page errors during ${mod.type} render: ${errors.join('; ')}`,
    ).toEqual([]);
  });
}
