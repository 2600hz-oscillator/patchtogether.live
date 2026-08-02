// e2e/vrt/workflow-rear-card.spec.ts
//
// VRT: the REAR CARD — the dock full-view's TAB flip side (rear-card-spec.md).
// PINNED scenes bracket the range and pin the curation shapes:
//
//   rear-tidyVco — the BUSIEST prototype (27 in + 2 out): voice band + the
//     five face-page bands (oscillator curated, EG clusters, audio-rate `~`
//     ticks) + the inverted OUTPUTS rail with the stereo-pair tie. The lane
//     auto-wire seats real plugs (endpoint chips) deterministically.
//   rear-vca — the SIMPLEST (2 in + 2 out): the curated signal → gain-stage
//     split and a 2-hole rail; pins the frame/hatch/footer at minimum density.
//
// P1 batch 2 adds the two rears the batch's most complex module pair needs —
// the axes tidyVco/vca do NOT already cover:
//
//   rear-dx7 — the batch's most complex FACE (4 pages, 10 ranked controls, a
//     preset selector + a file-input family) has the SIMPLEST possible rear:
//     3 note-source inputs and 1 output, ZERO per-param CV. It is the only
//     pinned scene where the whole field is ONE curated band with an inline
//     CLUSTER inside it (the mono PITCH CV + GATE legacy pair split out of
//     the poly bus) — a shape derivation cannot produce, on a card with no
//     CV bands at all to dilute it.
//   rear-sixstrum — the batch's genuinely busiest FIELD (22 in + 1 out): a
//     curated leading band with TWO sub-header clusters of six (the strum
//     triggers, the mute gates), seven derived per-param CV bands, and 14
//     audio-rate `~` ticks — by far the widest tick set on any pinned scene.
//
// Deterministic by construction: the rear card renders NO live glyphs and NO
// knobs — labels, recessed holes, domain rings and seated plugs only; the
// only animation (the carry pulse) never runs here (nothing is carried), and
// the boot style tag kills transitions anyway. Element-capture of the
// faceplate, workflow-shell-faces budgets.
//
// PLATFORM PARITY (2026-08-02): all four scenes are now pinned on BOTH
// platforms — 4 darwin / 4 linux, no EXEMPT_BASELINE_PAIRS entry left for this
// spec. rear-dx7 and rear-sixstrum were the batch-2 darwin-first leftovers;
// their linux baselines came from a `vrt-update.yml -f platform=linux`
// dispatch. The `test.skip` on the shared Set stays as the seam a future
// darwin-first scene would use, but it selects NOTHING today: a scene captured
// on darwin and skipped on linux is never diffed on the platform CI gates on.

import { test, expect, type Page } from '@playwright/test';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';
test.describe.configure({ mode: 'default' });

/** The two bracket scenes. `holes` = declared inputs + outputs (the rear
 *  renders exactly one hole per port — asserted before the pixel pin). */
const SCENES = [
  { type: 'tidyVco', holes: 29 },
  { type: 'vca', holes: 4 },
  // P1 batch 2
  { type: 'dx7', holes: 4 },
  { type: 'sixstrum', holes: 23 },
] as const;

/** Full-width faceplate element capture (workflow-shell-faces budget). */
const REAR_MAX_DIFF = 1500;

async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos?: unknown;
        __spawnFromPalette?: unknown;
        __openDockFullView?: unknown;
      };
      return (
        typeof w.__setSpawnFlowPos === 'function' &&
        typeof w.__spawnFromPalette === 'function' &&
        typeof w.__openDockFullView === 'function'
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Boot `?shell=1`, spawn `type` into lane 1 via the REAL palette-drop path
 *  (the lane auto-wire seats deterministic plugs on the rear), and return the
 *  member's node id — the workflow-shell-faces boot recipe. */
async function bootWithMember(page: Page, type: string): Promise<string> {
  await pinVrtFonts(page);
  await page.goto('/rack?mode=workflow&shell=1');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await waitForHooks(page);

  await page.evaluate((t) => {
    const w = globalThis as unknown as {
      __setSpawnFlowPos: (p: { x: number; y: number }) => void;
      __spawnFromPalette: (t: string) => void;
    };
    w.__setSpawnFlowPos({ x: 30, y: 40 });
    w.__spawnFromPalette(t);
  }, type);
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch?.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? []).length === 1;
  });
  const memberId = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
    };
    return (w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [])[0] ?? '';
  });
  expect(memberId, `${type}: the lane-1 member spawned`).not.toBe('');

  await page.addStyleTag({
    content:
      '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution,.minimap-toggle{display:none !important;}' +
      '*,*::before,*::after{animation:none !important;transition:none !important;}',
  });
  return memberId;
}

test.describe('VRT: rear card — the dock full-view TAB flip side', () => {
  for (const { type, holes } of SCENES) {
    test(`rear-${type}: the flip-side jack field matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/rear-${type}`),
        `rear-${type} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      const memberId = await bootWithMember(page, type);

      // Open the dock full-view (the same dockStore call the EXPAND pill
      // makes) and flip it with the bare-Tab rack-flip shortcut.
      await page.evaluate(
        (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
        memberId,
      );
      const faceplate = page.getByTestId('dock-full-view');
      await expect(faceplate).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(faceplate).toHaveAttribute('data-flipped', 'true');

      // Structural gate before the pixel pin: the field is up, one hole per
      // declared port, the control face is gone.
      const rear = faceplate.getByTestId('rear-card');
      await expect(rear).toBeVisible();
      await expect(rear.locator('[data-testid="back-jack"]')).toHaveCount(holes);
      await expect(faceplate.getByTestId('faceplate-editor')).toBeHidden();
      // The lane auto-wire seats the member's plugs — deterministic chips.
      await expect(rear.locator('[data-testid="back-jack"][data-patched="true"]').first()).toBeVisible();

      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
      await expect(faceplate).toHaveScreenshot(`rear-${type}.png`, {
        maxDiffPixels: REAR_MAX_DIFF,
      });

      expect(
        errors.filter((e) => !/getUserMedia|audio/i.test(e)),
        `pageerrors: ${errors.join(' | ')}`,
      ).toEqual([]);
    });
  }
});
