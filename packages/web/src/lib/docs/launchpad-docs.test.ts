// LaunchpadDocs — SSR render smoke test for the tabbed doc restructure.
//
// Renders the component server-side (svelte/server) and asserts the owner's
// tab IA + record vocabulary hold in the DEFAULT render (top tab "1 Launchpad"
// → Grid Mode), and that the grid-only copy/paste stance holds in EVERY tab
// panel (panels are {#if}-gated, so each combination is rendered via the
// initial-tab props). Pure unit — no browser.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import LaunchpadDocs from './LaunchpadDocs.svelte';
import {
  colTopCc,
  paintPermanentTopRow,
  computeSingleGridFrame,
  repeatPadOrdinal,
} from '$lib/control/launchpad/launchpad-map';
import { emptyFrame } from '$lib/control/launchpad/launchpad-device.svelte';
import { padNote, SCENE_CCS } from '$lib/control/launchpad/launchpad-sysex';

const html = (props: Record<string, string> = {}) =>
  render(LaunchpadDocs as never, { props } as never).body;

// Every tab combination (mirrors SINGLE_TABS / PAIR_TABS in the component).
const SINGLE_TAB_IDS = ['grid', 'clip', 'arranger', 'control', 'walkthrough'] as const;
const PAIR_TAB_IDS = ['matrix', 'deck', 'editor', 'keys'] as const;
const everyPanel = (): { name: string; out: string }[] => [
  ...SINGLE_TAB_IDS.map((id) => ({
    name: `single/${id}`,
    out: html({ initialTopTab: 'single', initialSingleTab: id }),
  })),
  ...PAIR_TAB_IDS.map((id) => ({
    name: `pair/${id}`,
    out: html({ initialTopTab: 'pair', initialPairTab: id }),
  })),
];

describe('LaunchpadDocs — tabbed structure', () => {
  it('has the two top-level tabs and the four owner-named single-mode subtabs', () => {
    const out = html();
    expect(out).toContain('1 Launchpad');
    expect(out).toContain('2 Launchpads');
    expect(out).toContain('Grid Mode');
    expect(out).toContain('Clip Mode');
    expect(out).toContain('Arranger Mode (TBD)');
    expect(out).toContain('Control Mode');
  });

  it('uses ARIA tab semantics (tablist / tab / tabpanel)', () => {
    const out = html();
    expect(out).toContain('role="tablist"');
    expect(out).toContain('role="tab"');
    expect(out).toContain('role="tabpanel"');
    expect(out).toContain('aria-selected="true"');
  });

  it('defaults to 1 Launchpad → Grid Mode', () => {
    const out = html();
    // The grid panel renders; other single panels don't.
    expect(out).toContain('id="lp1-panel-grid"');
    expect(out).not.toContain('id="lp1-panel-clip"');
    expect(out).not.toContain('id="lp2-panel-matrix"');
  });

  it('names the two record features CLIP RECORD and ARRANGER RECORD', () => {
    const out = html();
    expect(out).toContain('CLIP RECORD');
    expect(out).toContain('ARRANGER RECORD');
    // Discoverability: the arming surfaces are named in the vocabulary box —
    // per-lane arm (the owner-locked model): HOLD SHIFT + top-row on the
    // hardware, the per-lane ◉ on the card; module-level assignment; CV never
    // recorded. SHIFT is momentary hold-only (no latch, no double-tap).
    expect(out).toContain('arm the');
    expect(out).toContain('HOLD SHIFT');
    expect(out).not.toContain('double-tap SHIFT'); // the retired latch-era gesture
    expect(out).toContain('QUEUE-REC');
    expect(out).toContain('Assign to automation lane');
    expect(out).toContain('CV is never recorded');
  });

  it('shows the automation ARM layer in the top-row diagram data, not prose alone', () => {
    const out = html();
    // The shift-active ARM-MAP diagram + the always-visible armed red-flash
    // state both render in the shared foundation (visible from the default tab).
    expect(out).toContain('ARM MAP');
    expect(out).toContain('RED-FLASHING');
    // Lane 8's arm is HOLD SHIFT + the pad directly below SHFT (no double-tap).
    expect(out).toContain('PAD DIRECTLY BELOW SHFT');
    expect(out).toContain('momentary hold');
    // The dim-red alternation on red-family bases is documented.
    expect(out).toContain('DIM red');
  });

  it('arm-layer diagram fills MATCH paintPermanentTopRow — the firmware paint rules cannot drift', () => {
    // The component's permTop() hand-mirrors paintPermanentTopRow's overlay
    // rules (shift-active col<7 gating, the col-7 shift-LED exception, the
    // armed red phase). This runs the REAL firmware painter on the same two
    // diagram states and asserts the rendered SVG top-row fills are identical,
    // so a paint-rule change in launchpad-map flips this red instead of
    // letting the pictures drift silently.
    const rgbCss = (c: readonly number[]) =>
      `rgb(${Math.round((c[0] / 127) * 255)},${Math.round((c[1] / 127) * 255)},${Math.round((c[2] / 127) * 255)})`;
    const firmwareTopRow = (shiftHeld: boolean, laneArms: boolean[]): string[] => {
      const frame = emptyFrame();
      paintPermanentTopRow(frame, {
        view: 'grid',
        keysActive: false,
        transportRunning: true,
        shift: { held: shiftHeld },
        canUndo: false,
        canRedo: false,
        laneArms,
        blinkOn: true, // the diagrams show the bright/red phase
      });
      return Array.from({ length: 8 }, (_, col) => {
        const led = frame.leds.get(colTopCc(col));
        if (!led) throw new Error(`no LED painted for top col ${col}`);
        return rgbCss(led);
      });
    };
    // The top CC row renders FIRST inside each figure's SVG, one rect per
    // column in order; the dark 8×8 fills are plain hex, so the first 8
    // rgb() fills of the figure ARE the top row, left→right.
    const figureTopFills = (out: string, captionNeedle: string): string[] => {
      const chunk = out.split('<figure').find((c) => c.includes(captionNeedle));
      expect(chunk, `figure captioned “${captionNeedle}”`).toBeDefined();
      return [...chunk!.matchAll(/fill="(rgb\([^"]+\))"/g)].map((m) => m[1]).slice(0, 8);
    };
    const out = html();
    const ARMS_LANE3 = [false, false, true, false, false, false, false, false];
    // Diagram 1: shift held → the ARM MAP (lane 3 armed).
    expect(figureTopFills(out, 'PER-LANE ARM MAP, in EVERY view')).toEqual(
      firmwareTopRow(true, ARMS_LANE3),
    );
    // Diagram 2: shift released → the compass + lane 3's red-flash (red phase).
    expect(figureTopFills(out, 'the compass comes back')).toEqual(
      firmwareTopRow(false, ARMS_LANE3),
    );
  });

  it('SCENE-REPEAT diagram fills MATCH computeSingleGridFrame — the count-view paint cannot drift', () => {
    // The Grid tab's repeat-count figure is GENERATED from the real frame
    // painter for the 16-repeats state; this re-runs the SAME painter fresh
    // and asserts the figure's whole rgb() fill sequence (top row → lit pads
    // bottom-row-first, the SVG render order → the held scene button) matches
    // it byte-for-byte, extending the paintPermanentTopRow drift-guard to the
    // 8×8 (LED truth: pads 1..16 lit orange, all else dark, HOLD button amber).
    const rgbCss = (c: readonly number[]) =>
      `rgb(${Math.round((c[0] / 127) * 255)},${Math.round((c[1] / 127) * 255)},${Math.round((c[2] / 127) * 255)})`;
    const frame = computeSingleGridFrame(undefined, {
      top: {
        view: 'grid',
        keysActive: false,
        transportRunning: true,
        shift: { held: false },
        canUndo: false,
        canRedo: false,
      },
      repeatView: { count: 16, sceneIndex: 0 },
    });
    const expected: string[] = [];
    for (let col = 0; col < 8; col++) expected.push(rgbCss(frame.leds.get(colTopCc(col))!)); // top row
    // The 8×8 renders yy = 0 (bottom) first; unlit pads use a hex OFF fill the
    // rgb() regex skips, so only the LIT pads contribute, in render order.
    const litOrdinals: number[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const led = frame.leds.get(padNote(x, y))!;
        if (led[0] + led[1] + led[2] > 0) {
          expected.push(rgbCss(led));
          litOrdinals.push(repeatPadOrdinal(x, y)!);
        }
      }
    }
    // The firmware truth itself: EXACTLY pads 1..16 lit for count 16.
    expect(litOrdinals.sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    // The held scene button (index 0 = SCENE_CCS[0]) renders after the pads.
    expected.push(rgbCss(frame.leds.get(SCENE_CCS[0])!));
    const out = html();
    const chunk = out.split('<figure').find((c) => c.includes('REPEAT-COUNT view while HOLDING GRID'));
    expect(chunk, 'the repeat-count figure renders in the Grid tab').toBeDefined();
    const fills = [...chunk!.matchAll(/fill="(rgb\([^"]+\))"/g)].map((m) => m[1]);
    expect(fills.slice(0, expected.length)).toEqual(expected);
  });

  it('documents the repeat gesture in the Grid reference table + the walkthrough', () => {
    const grid = html();
    expect(grid).toContain('SCENE REPEATS — HOLD GRID + HOLD a scene button');
    expect(grid).toContain('position-relative');
    const walk = html({ initialTopTab: 'single', initialSingleTab: 'walkthrough' });
    expect(walk).toContain('scene repeats');
    expect(walk).toContain('HOLD GRID');
  });

  it('has no old global/single AUTO pad anywhere (per-lane arm replaced it)', () => {
    for (const { name, out } of everyPanel()) {
      // The retired Control-view AUTO pad must not resurface as a pad label or
      // a documented pad — the arm lives on the permanent top row under SHIFT.
      expect(out, name).not.toContain('>AUTO<');
      expect(out, name).not.toContain('AUTO pad');
    }
  });

  it('documents copy/paste as Grid-only (no editor CPY/PST doc content)', () => {
    const out = html();
    // The Grid tab carries the copy/paste palette…
    expect(out).toContain('ONLY copy/paste');
    // …and the removed editor scene pads are gone from the default panel.
    expect(out).not.toContain('CPY');
    expect(out).not.toContain('PST');
  });

  it('has no CPY/PST in ANY tab panel (incl. the pair note editor where they were removed)', () => {
    for (const { name, out } of everyPanel()) {
      expect(out, name).not.toContain('CPY');
      expect(out, name).not.toContain('PST');
    }
  });

  it('renders each tab combination (the initial-tab props select the panel)', () => {
    for (const id of SINGLE_TAB_IDS) {
      const out = html({ initialTopTab: 'single', initialSingleTab: id });
      expect(out, id).toContain(`id="lp1-panel-${id}"`);
    }
    for (const id of PAIR_TAB_IDS) {
      const out = html({ initialTopTab: 'pair', initialPairTab: id });
      expect(out, id).toContain(`id="lp2-panel-${id}"`);
    }
  });
});
