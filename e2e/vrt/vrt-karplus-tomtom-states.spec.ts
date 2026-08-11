// e2e/vrt/vrt-karplus-tomtom-states.spec.ts
//
// COMPOSITE-STATE VRTs for KARPLUS + TOM DRUM (2026-07-11 coverage audit).
//
// The per-card sweep (vrt.spec.ts) locks each card at its DEFAULT state
// only; these scenes lock the cards at sonically/visually DISTINCT
// non-default control states — the voice "presets" the sonic-dynamism audit
// proved out at the DSP tier — so a Fader regression (value readout, curve
// mapping, extreme positions), a params→card wiring break, or a state-CSS
// regression (the TOM DRUM STRIKE pad's held styling) is caught as pixels.
// Same category as the QUADRALOGICAL per-effect scenes
// (vrt-quadralogical.spec.ts): one spec file, N deterministic baselines.
//
// Both cards are pure-DOM chrome (fader bands + the PatchPanel drill-down —
// NO canvas/animation), so the frames are deterministic; the AudioContext is
// suspended before capture (the spawn-strike ring of the held TOM pad has no
// on-card visualization, but suspending is the house belt-and-braces), and
// the height-stability settle loop guards the ±1 px text-raster flake
// (memory: vrt-flake-1px-layout-rounding).
//
// Informational lane (`task vrt`).
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.
//
// Output: e2e/vrt/__screenshots__/vrt-karplus-tomtom-states.spec.ts/<id>.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

test.describe.configure({ mode: 'default' });

interface StateScene {
  id: string;
  moduleType: 'karplus' | 'tomtom';
  blurb: string;
  params: Record<string, number>;
  /**
   * A `data-testid` to hold DOWN (pointerdown, no release) before the capture.
   *
   * ⚠ ADDED 2026-08-02, AND THE REASON IS THE POINT. `tomtom-strike-held` used
   * to reach the pad's `.held` styling by seeding `params: { strike: 1 }` — a
   * momentary pad's pressed value, persisted. That value is exactly the
   * data-integrity bug that was just fixed: a press is not state, it no longer
   * survives in the Y.Doc, and the pad's lit state is now LOCAL to the surface
   * holding the finger ($lib/audio/momentary-params). Seeding the param
   * therefore stopped lighting the pad, and **the scene silently became a
   * duplicate of the default card**.
   *
   * ⚠⚠ AND THE GATE DID NOT NOTICE. Measured: the change moved 859 px in an
   * 84×60 box — the whole pad — against a `maxDiffPixelRatio: 0.01` budget of
   * 4163 px on this 790×527 capture. 21 % of budget, so the assertion passed
   * AND `--update-snapshots` refused to rewrite the baseline (Playwright only
   * rewrites on FAILURE). That is the A2/#1213 sub-tolerance staleness trap,
   * reproduced exactly; the baseline had to be `git rm`-ed to re-capture.
   *
   * Pressing the real pad is also STRONGER than what it replaced: it proves
   * the press PATH lights the pad, where the old form only proved a stored
   * number did.
   */
  hold?: string;
}

const SCENES: StateScene[] = [
  // ── KARPLUS: three corners of the string/exciter space ──
  {
    id: 'karplus-bell-extreme',
    moduleType: 'karplus',
    blurb:
      'BRIGHT + STIFF maxed on a long high string: the detuned-bell corner ' +
      '(Tune 880, Dec 6 s, Brt 1, Stf 1, hard pick). Locks the STRING band ' +
      'faders at their tops + the log Tune/Dec readouts.',
    params: { tune: 880, decay: 6, brightness: 1, stiffness: 1, color: 0.9, burst: 0.5 },
  },
  {
    id: 'karplus-dark-mallet',
    moduleType: 'karplus',
    blurb:
      'Felt-mallet thump: everything at the dark/short floor (Brt 0.05, ' +
      'Col 0, Brst 0.1 tick, Dec 0.4, mid-string Pos 0.5). Locks the ' +
      'fader-bottom extremes incl. the log Burst floor.',
    params: { tune: 110, decay: 0.4, brightness: 0.05, position: 0.5, color: 0, burst: 0.1 },
  },
  {
    id: 'karplus-scrape-bridge',
    moduleType: 'karplus',
    blurb:
      'Scraped-at-the-bridge: Brst 4 (max scrape) + Col 1 against Pos 0.02 ' +
      '(bridge-thin) + Stf 0.5, Lvl +6 dB. A mixed-extremes constellation — ' +
      'distinct from both other scenes on every EXCITER fader.',
    params: { position: 0.02, stiffness: 0.5, color: 1, burst: 4, level: 6 },
  },
  // ── TOM DRUM: the audit's own voicing corners ──
  {
    id: 'tomtom-simmons-zap',
    moduleType: 'tomtom',
    blurb:
      'The SDS-V dive-bomb: Tune 60 floor, Bend 24 st / BTim 300 ms maxed, ' +
      'Dec 1.2 s, Drv 0.8. Locks the MEMBRANE band at its sweep extremes.',
    params: { tune: 60, bend_amt: 24, bend_time: 300, decay: 1200, tone: 0.7, noise: 0.6, drive: 0.8 },
  },
  {
    id: 'tomtom-timbale-tight',
    moduleType: 'tomtom',
    blurb:
      'TUNE high with NOISE/DRIVE up (the audit recipe): Tune 400 timbale, ' +
      'Dec 40 ms floor, Bend 2 st, Nse 0.9, Drv 1. The COLOR band inverted ' +
      'against the zap scene.',
    params: { tune: 400, bend_amt: 2, bend_time: 15, decay: 40, tone: 0.1, noise: 0.9, drive: 1 },
  },
  {
    id: 'tomtom-strike-held',
    moduleType: 'tomtom',
    blurb:
      'The STRIKE pad HELD (a real pointerdown, not a seeded param): the pad ' +
      'renders its orange .held state — the one stateful CSS surface on ' +
      'either card — over otherwise default knobs.',
    params: {},
    hold: 'tomtom-strike',
  },
];

test.describe('VRT: KARPLUS + TOM DRUM composite states', () => {
  for (const scene of SCENES) {
    test(`${scene.id} matches baseline`, async ({ page }) => {

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      // Pin the bundled Inter/JetBrains Mono BEFORE the first navigation and
      // await their decode after load — the app resolves card text through
      // GENERIC stacks (system-ui / ui-monospace) that fontconfig picks
      // nondeterministically, and document.fonts.ready can't see them. Without
      // this the captured text metrics differ run-to-run and platform-to-platform.
      // Full root cause: e2e/vrt/_fonts.ts.
      await pinVrtFonts(page);
      await page.goto('/rack?shell=legacy&seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);

      await spawnPatch(page, [
        {
          id: 'voice',
          type: scene.moduleType,
          position: { x: 80, y: 80 },
          domain: 'audio',
          params: scene.params,
        },
      ]);

      const card = page.locator(`.svelte-flow__node-${scene.moduleType}`).first();
      await card.waitFor({ state: 'visible', timeout: 15_000 });

      // HOLD a momentary pad DOWN for the capture (see StateScene.hold).
      // `dispatchEvent` rather than `mouse.down()` so no release is implied by
      // any later interaction, and so the pointer never has to sit over the
      // element while the settle loop runs.
      if (scene.hold) {
        const pad = page.locator(`[data-testid="${scene.hold}"]`);
        await pad.waitFor({ state: 'visible', timeout: 15_000 });
        await pad.dispatchEvent('pointerdown');
        // NEGATIVE CONTROL, on every run rather than once at authoring time:
        // the pad must ACTUALLY be lit. Without this the scene would silently
        // fall back to capturing an unheld pad the moment the press path
        // changed again — which is precisely how it broke the first time, and
        // the pixel gate could not see it (859 px against a 4163 px budget).
        await expect(pad).toHaveClass(/\bheld\b/);
      }

      // Height-stability settle: text-row raster determinism (the ±1 px
      // layout-rounding flake class — see vrt.spec.ts / the memory note).
      await card.evaluate(
        (el) =>
          new Promise<void>((resolve) => {
            let lastH = -1;
            let stable = 0;
            const tick = () => {
              const h = Math.round(el.getBoundingClientRect().height);
              if (h === lastH) {
                if (++stable >= 3) return resolve();
              } else {
                stable = 0;
                lastH = h;
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );

      // Suspend the AudioContext (belt-and-braces: both cards are pure DOM,
      // but the held STRIKE pad fired a spawn hit — freeze everything).
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
        const eng = w.__engine?.();
        if (eng) {
          try {
            await eng.ctx.suspend();
          } catch {
            /* already suspended */
          }
        }
      });
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

      await expect(card).toHaveScreenshot(`${scene.id}.png`, { maskColor: '#ff00ff' });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        `${scene.id}: no console / page errors`,
      ).toEqual([]);
    });
  }
});
