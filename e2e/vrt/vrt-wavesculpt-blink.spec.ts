// e2e/vrt/vrt-wavesculpt-blink.spec.ts
//
// Per-mode VRT baselines for WAVESCULPT's BLINK render modes. The main
// vrt.spec.ts captures one baseline per module type (the default
// wavesculpt scene = mode 0 + the ALPHA-rotate regression lock from #361).
// The BLINK modes are different RENDER PATHS of the same card, so they each
// need their own baseline:
//
//   * ribbons              — blink_mode 0 (the wavetable ribbons; default)
//   * scopes-trial         — blink_mode 1 (thin oscilloscope LINES from the
//                            4 floor corners; the SCOPE waveform shape)
//   * reality-based        — blink_mode 2 (the SAME scope shape as REAL 3D
//                            neon TUBES — swept ring geometry)
//   * scopes-trial-wiggle  — blink_mode 1 with WIGGLE>0, to lock that the
//                            pitch-driven 3D rotation visibly tilts the
//                            traces (captured at the freeze hook's fixed
//                            phase so it's deterministic)
//
// Determinism: the same render-freeze hook #361 added
// (globalThis.__wavesculptVrtFreeze) pins uTime / wave-phase / CRT field-
// parity / WIGGLE phase, and we suspend the AudioContext after a settle so
// the per-osc scope analysers freeze on their last buffer. The four
// oscillators are driven audible (joystick x=1 → gate1, normalled to the
// other three) so the scope traces have real signal in modes 1/2.

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

interface BlinkCase {
  name: string;
  blinkMode: number;
  wiggle: number;
  // Optional extra param overrides (CHROMA colours, gate-electricity demo).
  params?: Record<string, number>;
  // Which wavesculpt gate input the joystick drives. Defaults to 'gate1'
  // (normals to ALL four voices → all audible). Set to a HIGHER voice (e.g.
  // 'gate2') to leave the voices BEFORE it SILENT: gate-normalling walks the
  // signal DOWNWARD, so voice 1 — first in the walk with an unpatched gate —
  // sources itself = no gate = silent. Used by the silent-osc regression case.
  gatePort?: string;
  // When true, patch the SHAPES source into ALL SIX video walls at full
  // opacity so the camera (inside the box) is fully enclosed by an opaque
  // textured room. This is the LINES-VS-WALLS regression guard: before the
  // backdrop-dim fix the bright scope traces were drowned by the saturated
  // walls and read as INVISIBLE (the "scopestrial" / "reality based"
  // community patches went blank). The baseline MUST show the energy traces
  // still punching through the wall backdrop.
  enclosingWalls?: boolean;
}

// Custom (non-default) CHROMA colours for the RED/GRN/BLU oscillators —
// deliberately swapped/odd hues so the baseline visibly differs from the
// default r/g/b: RED osc → cyan, GRN osc → magenta, BLU osc → amber. Packed
// 0xRRGGBB integers (the param encoding).
const CUSTOM_COLORS = {
  red_color: 0x00e5ff, // cyan
  grn_color: 0xff2bd1, // magenta
  blu_color: 0xffb300, // amber
};

const CASES: BlinkCase[] = [
  { name: 'ribbons', blinkMode: 0, wiggle: 0 },
  { name: 'scopes-trial', blinkMode: 1, wiggle: 0 },
  { name: 'reality-based', blinkMode: 2, wiggle: 0 },
  { name: 'scopes-trial-wiggle', blinkMode: 1, wiggle: 1 },
  // CHROMA: per-osc custom base colours in the SCOPES-TRIAL mode (neon
  // lines clearly carry the picked hue). EYEBALL: traces are cyan / magenta
  // / amber, NOT the default hot-pink / cyan / purple neon.
  { name: 'custom-colors', blinkMode: 1, wiggle: 0, params: CUSTOM_COLORS },
  // GATE ELECTRICITY: ribbon mode with the voices gated hard. EYEBALL:
  // bright travelling electric-blue arcs + crackle visibly electrify the
  // ribbons (vs the near-invisible bolt before this work). bloom dialled
  // down here so the discrete arcs read as arcs rather than being smeared
  // into a bloom haze (the electricity is in the ribbon shader, not bloom).
  { name: 'gate-electricity', blinkMode: 0, wiggle: 0, params: { bloom: 0.1 } },
  // SILENT-OSC regression (BUG 1): REALITY-BASED-COMMUNITY tubes with the
  // joystick gating gate2 ONLY. Gate-normalling walks DOWN to voices 2/3/4,
  // leaving voice 1 (RED) SILENT (unpatched, head of the walk → self-source →
  // no gate). EYEBALL: exactly THREE colored tubes — NO static straight
  // diagonal ray from the RED (−X−Z) floor corner. Before the fix the silent
  // RED osc drew a flat mid-line trace = a non-animated straight tube. With
  // the uActive amp-gate it now contributes ZERO coverage → nothing.
  { name: 'reality-silent-osc', blinkMode: 2, wiggle: 0, gatePort: 'gate2' },
  // LINES-VS-WALLS regression guard (#531 video-walls broke this): SCOPES
  // TRIAL with ALL SIX walls opaque (camera fully enclosed in a textured
  // room). EYEBALL: the bright scope traces are STILL clearly visible
  // punching through the (backdrop-dimmed) wall grid — NOT a blank room. This
  // is the exact failure mode the "scopestrial" / "reality based" community
  // patches hit; the WALL_BACKDROP_DIM fix in WavesculptCard restores it.
  { name: 'scopes-enclosing-walls', blinkMode: 1, wiggle: 0, enclosingWalls: true },
];

test.describe.configure({ mode: 'default' });

test.describe('VRT: WAVESCULPT BLINK render modes', () => {
  for (const c of CASES) {
    test(`blink ${c.name} matches baseline`, async ({ page }) => {
      // Linux baselines deferred — WebGL ribbon/tube AA + CRT post differs
      // sub-thresholdly across GPU drivers; darwin captured here, linux
      // pending a `task vrt:update` run on linux CI (mirrors the main
      // wavesculpt baseline's linux deferral in EXEMPT_BASELINE_PAIRS).
      test.skip(
        VRT_PLATFORM === 'linux',
        `wavesculpt blink ${c.name} on linux: baseline pending (capture on linux CI)`,
      );
      // Per-mode platform exemptions live in EXEMPT_BASELINE_PAIRS so the
      // QUARANTINE entries (e.g. darwin/wavesculpt-blink-scopes-trial,
      // tracked as task #202) take effect here. Root-cause fix is owed on
      // the tracked task — this is a quarantine, not a tolerance.
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/wavesculpt-blink-${c.name}`),
        `wavesculpt-blink-${c.name} on ${VRT_PLATFORM}: quarantined (see EXEMPT_BASELINE_PAIRS)`,
      );

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // SHAPES → alpha_in gives the ALPHA layer real content; joystick x=1
      // → gate1 (normalled to gates 2-4) makes all four voices audible so
      // the scope traces have signal. SCALE=2 + per-osc thickness so the
      // traces are clearly visible; noise off for a clean frozen frame.
      // When enclosingWalls is set, texture the SHAPES source onto all six
      // walls at full opacity (instead of using it as the ALPHA layer) so the
      // camera is wrapped in an opaque room — the lines-vs-walls regression
      // scene. Otherwise SHAPES → alpha_in (the original blink scenes).
      const wallParams: Record<string, number> = {};
      if (c.enclosingWalls) {
        for (let n = 1; n <= 6; n++) {
          wallParams[`wall${n}_alpha`] = 100;
          wallParams[`wall${n}_distort`] = 0;
        }
      }
      const edges = [
        {
          id: 'e_gate',
          from: { nodeId: 'jo', portId: 'x' },
          to: { nodeId: 'vrt-1', portId: c.gatePort ?? 'gate1' },
          sourceType: 'cv',
          targetType: 'gate',
        },
      ];
      if (c.enclosingWalls) {
        for (let n = 1; n <= 6; n++) {
          edges.push({
            id: `e_wall${n}`,
            from: { nodeId: 'src', portId: 'out' },
            to: { nodeId: 'vrt-1', portId: `wall${n}` },
            sourceType: 'video',
            targetType: 'video',
          });
        }
      } else {
        edges.push({
          id: 'e_src_alpha',
          from: { nodeId: 'src', portId: 'out' },
          to: { nodeId: 'vrt-1', portId: 'alpha_in' },
          sourceType: 'video',
          targetType: 'video',
        });
      }

      await spawnPatch(
        page,
        [
          { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video' },
          {
            id: 'vrt-1',
            type: 'wavesculpt',
            position: { x: 480, y: 40 },
            domain: 'audio',
            params: {
              blink_mode: c.blinkMode,
              wiggle: c.wiggle,
              scale: 2,
              rot: 0.3, pos_z: 0.35, zoom: 1.3,
              thickness1: 0.5, thickness2: 0.5, thickness3: 0.6, thickness4: 0.9,
              alpha_brightness: 1.6, noise: 0, bloom: 0.45,
              ...wallParams,
              ...(c.params ?? {}),
            },
          },
          { id: 'jo', type: 'joystick', position: { x: 40, y: 480 }, domain: 'audio' },
        ],
        edges,
      );

      // Drive the joystick to x=1 (gate high) + resume audio so the voices
      // generate signal for the scope analysers.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __engine?: () => { ctx: AudioContext } | null;
        };
        const n = w.__patch.nodes['jo'];
        if (n) n.params.pos_x = 1;
        try { void w.__engine?.()?.ctx.resume(); } catch { /* */ }
      });

      const card = page.locator('.svelte-flow__node-wavesculpt').first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });

      // Let the voices settle so the scope buffers fill with a couple of
      // cycles, then turn on the freeze hook (pins all time-derived inputs
      // incl. the WIGGLE phase) and suspend audio so the analysers freeze.
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        (globalThis as unknown as { __wavesculptVrtFreeze?: boolean }).__wavesculptVrtFreeze = true;
      });
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
        const eng = w.__engine?.();
        if (eng) { try { await eng.ctx.suspend(); } catch { /* */ } }
      });
      // Two rAFs so the frozen frame lands (the card render reads the freeze
      // flag on the next frame; a second frame stabilizes the feedback tex).
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );

      await expect(card).toHaveScreenshot(`wavesculpt-blink-${c.name}.png`, {
        maskColor: '#ff00ff',
      });

      expect(errors, `wavesculpt blink ${c.name}: no console / page errors`).toEqual([]);
    });
  }
});
