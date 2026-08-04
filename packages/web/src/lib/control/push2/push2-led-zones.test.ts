// packages/web/src/lib/control/push2/push2-led-zones.test.ts
//
// THE THREE LIT BUTTON ZONES OF THE PUSH 2, per VIEW — the owner's 2026-08-04
// hardware report, made into a gate:
//
//   > "the only problem i still see with Push is the lighting on the special rows
//   >  of keys, the top channel selection row, the top function key row, the
//   >  launch keys on the right. the launch keys are dark except for clip mode,
//   >  where they seem to show the correct colors. the rows at the top of the
//   >  lanes which should just show the channel color, do not, but they do turn
//   >  on and off when hit sometimes. so there's a discrepancy there between how
//   >  they illuminate on push, and on launchpad."
//
// ── WHAT THE BUG ACTUALLY WAS, because it is not what it looks like ────────
//
// NOT a missing paint path. The Push drives the SINGLE-unit render path
// (`setControlSurfacePort(pushSurface, { deployment: 'single' })`), and ALL FIVE
// single-view builders paint the scene column AND `paintPermanentTopRow`. The
// Push was receiving a fully-populated frame in every view the whole time.
//
// The divergence was ENTIRELY in the outbound colour encoder. The Launchpad
// takes true per-LED RGB (`encodeLedRgb`, spec type 3, R/G/B each 0..127), so it
// renders the dim half of the design language correctly. The Push takes a
// PALETTE INDEX, and `pushColorIndex` used to snap to a 10-entry table in which
// nine entries were full brightness and one was black — so nearest-neighbour in
// linear RGB put every dim colour closer to BLACK than to any lit anchor:
//
//   RGB_VIEW_IDLE / RGB_SHIFT_OFF / RGB_SYS_DIM / RGB_SCENE_DIM  → 0
//   a lane hue × 0.30 (every UNSELECTED channel button)          → 0
//   a lane hue × 0.32 (every LOADED-but-not-playing clip pad)    → 0
//
// That is why "clip mode" looked right and nothing else did: the grid view's
// scene column uses full-brightness RGB_SCENE, which survived the collapse.
//
// So these are not three bugs. They are one encoder defect with three visible
// faces, and this file asserts the emitted `Push2LedSpec[]` for each face.
//
// ── THE NEGATIVE CONTROL ──────────────────────────────────────────────────
//
// `legacyPushColorIndex` below is the PRE-FIX quantiser, reproduced verbatim.
// Every zone assertion is paired with a check that the legacy encoder FAILS it,
// so this file cannot silently stop testing anything: if a future refactor makes
// the two agree, the negative-control leg goes red rather than the gate quietly
// passing for both. (Repo standard: "the pre-fix behaviour must fail them".)

import { describe, it, expect } from 'vitest';
import {
  computeSingleGridFrame,
  computeSingleClipFrame,
  computeSingleKeysFrame,
  computeSingleControlFrame,
  computeSingleArrangerFrame,
  hexToRgb127,
  type PermanentTopOpts,
  type SingleView,
} from '$lib/control/launchpad/launchpad-map';
import { SCENE_CCS, CC_UP } from '$lib/control/launchpad/launchpad-sysex';
import {
  clipIndex,
  defaultNoteClip,
  defaultLaneColorHex,
  type ClipPlayerData,
} from '$lib/audio/modules/clip-types';
import { push2FrameToLeds, PUSH_CC_PERMANENT_BASE, PUSH_CC_SCENE_BASE, type Push2LedSpec } from './push2-map';
import { clamp7, pushColorIndex, PUSH_PALETTE_HUES } from './push2-sysex';

// ---------------------------------------------------------------------------
// The PRE-FIX quantiser, reproduced verbatim from git history — the negative
// control. A flat nearest-anchor search over a table that is all-bright + black.
// ---------------------------------------------------------------------------
const LEGACY_ANCHORS: readonly { i: number; rgb: readonly [number, number, number] }[] = [
  { i: 0, rgb: [0, 0, 0] },
  { i: 127, rgb: [127, 0, 0] },
  { i: 126, rgb: [0, 127, 0] },
  { i: 125, rgb: [0, 0, 127] },
  { i: 122, rgb: [127, 127, 127] },
  { i: 8, rgb: [127, 80, 0] },
  { i: 13, rgb: [127, 127, 0] },
  { i: 37, rgb: [0, 127, 127] },
  { i: 49, rgb: [80, 0, 127] },
  { i: 1, rgb: [40, 40, 40] },
];
function legacyPushColorIndex(r: number, g: number, b: number): number {
  const rr = clamp7(r), gg = clamp7(g), bb = clamp7(b);
  let best = LEGACY_ANCHORS[0];
  let bestD = Infinity;
  for (const a of LEGACY_ANCHORS) {
    const dr = rr - a.rgb[0], dg = gg - a.rgb[1], db = bb - a.rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = a; }
  }
  return best.i;
}

// ---------------------------------------------------------------------------
// Frame fixtures — one per SINGLE view, the five the Push can actually be in.
// ---------------------------------------------------------------------------
const mkTop = (view: SingleView, partial: Partial<PermanentTopOpts> = {}): PermanentTopOpts => ({
  view,
  keysActive: false,
  transportRunning: false,
  shift: { held: false },
  canUndo: false,
  canRedo: false,
  ...partial,
});

/** A clip player with content in lane 0 / scene 0, and lane 0 playing it. */
const DATA = {
  clips: { [clipIndex(0, 0)]: defaultNoteClip() },
  playing: [0, null, null, null, null, null, null, null],
} as unknown as ClipPlayerData;

/** The five single-mode views, each as a live LaunchpadFrame. These are the
 *  EXACT builders `launchpad-control`'s render loop calls for the Push. */
const VIEWS = {
  grid: () => computeSingleGridFrame(DATA, { top: mkTop('grid'), blinkOn: true }),
  clip: () => computeSingleClipFrame(defaultNoteClip(), { top: mkTop('clip'), blinkOn: true }),
  keys: () =>
    computeSingleKeysFrame({
      top: mkTop('clip', { keysActive: true }),
      keyboardRoot: 48,
      selectedScale: undefined,
      arpOn: false,
      arpDir: 'up',
      arpDivIndex: 0,
      arpRangeIndex: 0,
      arpLatch: false,
      blinkOn: true,
    }),
  control: () => computeSingleControlFrame({ top: mkTop('control'), blinkOn: true, data: DATA }),
  arranger: () => computeSingleArrangerFrame({ top: mkTop('arranger') }),
} as const;
type ViewName = keyof typeof VIEWS;
const VIEW_NAMES = Object.keys(VIEWS) as ViewName[];

/** Re-encode a frame's buttons with an arbitrary quantiser, so the legacy
 *  encoder can be run over the SAME frames as the real one. Mirrors
 *  `push2FrameToLeds`'s button branches (pads are not this file's subject). */
function buttonsWith(
  frame: ReturnType<typeof computeSingleGridFrame>,
  quant: (r: number, g: number, b: number) => number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [index, [r, g, b]] of frame.leds) {
    const sceneI = SCENE_CCS.indexOf(index as (typeof SCENE_CCS)[number]);
    if (sceneI >= 0) {
      out.set(PUSH_CC_SCENE_BASE + (SCENE_CCS.length - 1 - sceneI), r + g + b === 0 ? 0 : quant(r, g, b));
      continue;
    }
    if (index >= CC_UP && index <= CC_UP + 7) {
      out.set(PUSH_CC_PERMANENT_BASE + (index - CC_UP), r + g + b === 0 ? 0 : quant(r, g, b));
    }
  }
  return out;
}

/** The REAL emitted specs, indexed by CC — this is the artifact under test. */
function realButtons(frame: ReturnType<typeof computeSingleGridFrame>): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of push2FrameToLeds(frame) as Push2LedSpec[]) {
    if (s.kind === 'button') out.set(s.cc, s.value);
  }
  return out;
}

/** The Launchpad-side colour at a frame index, or null when unpainted. */
function rgbAt(
  frame: ReturnType<typeof computeSingleGridFrame>,
  index: number,
): readonly [number, number, number] | null {
  return frame.leds.get(index) ?? null;
}

// ---------------------------------------------------------------------------
// ZONE 1 — the SCENE / LAUNCH column (Push CC 36..43).
// ---------------------------------------------------------------------------
describe('ZONE 1 — the scene / launch column (Push CC 36..43)', () => {
  it('every view paints it, and NO lit scene button is extinguished by the encoder', () => {
    // The owner: "the launch keys are dark except for clip mode". The frame was
    // never the problem — assert that first, so a future regression that DOES
    // drop the paint path is distinguishable from an encoder regression.
    for (const name of VIEW_NAMES) {
      const frame = VIEWS[name]();
      const painted = SCENE_CCS.filter((cc) => rgbAt(frame, cc) !== null);
      expect(painted.length, `${name}: the builder must paint all 8 scene LEDs`).toBe(8);

      const btns = realButtons(frame);
      for (let i = 0; i < SCENE_CCS.length; i++) {
        const rgb = rgbAt(frame, SCENE_CCS[i])!;
        const pushCc = PUSH_CC_SCENE_BASE + (SCENE_CCS.length - 1 - i);
        const lit = rgb[0] + rgb[1] + rgb[2] > 0;
        const value = btns.get(pushCc);
        expect(value, `${name}: scene CC ${pushCc} must be emitted`).toBeDefined();
        if (lit) {
          expect(
            value,
            `${name}: scene CC ${pushCc} is lit ${JSON.stringify(rgb)} on the Launchpad but the Push encoder sent 0 (dark)`,
          ).not.toBe(0);
        } else {
          expect(value, `${name}: an unpainted scene must stay dark`).toBe(0);
        }
      }
    }
  });

  it('NEGATIVE CONTROL — the pre-fix encoder blacked scene buttons out in the non-grid views', () => {
    // This is the owner's exact symptom, reproduced. If this ever stops failing,
    // the assertion above has stopped being a test of anything.
    const blackedOut: string[] = [];
    for (const name of VIEW_NAMES) {
      const frame = VIEWS[name]();
      const legacy = buttonsWith(frame, legacyPushColorIndex);
      for (let i = 0; i < SCENE_CCS.length; i++) {
        const rgb = rgbAt(frame, SCENE_CCS[i])!;
        if (rgb[0] + rgb[1] + rgb[2] === 0) continue; // genuinely off — not a defect
        const pushCc = PUSH_CC_SCENE_BASE + (SCENE_CCS.length - 1 - i);
        if (legacy.get(pushCc) === 0) blackedOut.push(`${name}/cc${pushCc}`);
      }
    }
    expect(
      blackedOut.length,
      'the legacy encoder must extinguish at least one lit scene button, else this file proves nothing',
    ).toBeGreaterThan(0);
    // …and the fixed encoder extinguishes none of them.
    for (const name of VIEW_NAMES) {
      const real = realButtons(VIEWS[name]());
      const frame = VIEWS[name]();
      for (let i = 0; i < SCENE_CCS.length; i++) {
        const rgb = rgbAt(frame, SCENE_CCS[i])!;
        if (rgb[0] + rgb[1] + rgb[2] === 0) continue;
        expect(real.get(PUSH_CC_SCENE_BASE + (SCENE_CCS.length - 1 - i))).not.toBe(0);
      }
    }
  });

  it('CONTROL view keeps playing and idle lanes DISTINGUISHABLE (not merely both lit)', () => {
    // "Lit" is not the whole requirement — the column encodes per-lane STOP state
    // (RGB_STOP_ACTIVE vs RGB_STOP_IDLE). A fix that lit everything to one colour
    // would pass the never-dark check and still destroy the information.
    const frame = VIEWS.control();
    const btns = realButtons(frame);
    // Lane L sits at frame row L, i.e. SCENE_CCS index 7-L, i.e. Push CC 36+L.
    // (The two reversals — bottom-origin rows and a top→bottom SCENE_CCS — cancel.)
    const laneCc = (lane: number) => PUSH_CC_SCENE_BASE + lane;
    // DATA has lane 0 playing; lanes 1..7 idle.
    const playing = btns.get(laneCc(0));
    const idle = btns.get(laneCc(1));
    expect(playing, 'a playing lane must be lit').not.toBe(0);
    expect(idle, 'an idle lane must be lit').not.toBe(0);
    expect(playing, 'a playing lane must not look like an idle one').not.toBe(idle);
    // …and every other idle lane agrees with the one we sampled, which is what
    // makes the pair above a real contrast rather than two arbitrary buttons.
    for (let lane = 2; lane < 8; lane++) expect(btns.get(laneCc(lane))).toBe(idle);
  });
});

// ---------------------------------------------------------------------------
// ZONE 2 — the TOP FUNCTION row (Push CC 20..27).
// ---------------------------------------------------------------------------
describe('ZONE 2 — the top function row (Push CC 20..27)', () => {
  it('all EIGHT buttons are lit in every view, in the default (nothing armed) state', () => {
    // This is the zone with the worst pre-fix behaviour and the one the owner
    // could most easily have mistaken for "working": transport and the ACTIVE
    // view button were bright, so 2 of 8 lit. The other six — the three view
    // buttons you are not on (RGB_VIEW_IDLE), undo and redo with empty stacks
    // (RGB_SYS_DIM) and SHIFT at rest (RGB_SHIFT_OFF) — were all palette 0.
    for (const name of VIEW_NAMES) {
      const frame = VIEWS[name]();
      const btns = realButtons(frame);
      for (let col = 0; col < 8; col++) {
        const cc = PUSH_CC_PERMANENT_BASE + col;
        const rgb = rgbAt(frame, CC_UP + col);
        expect(rgb, `${name}: top-row col ${col} must be painted`).not.toBeNull();
        expect(
          btns.get(cc),
          `${name}: top-row CC ${cc} is ${JSON.stringify(rgb)} on the Launchpad but dark on the Push`,
        ).not.toBe(0);
      }
    }
  });

  it('the ACTIVE view button stays distinguishable from the three idle ones', () => {
    // RGB_VIEW_ACTIVE vs RGB_VIEW_IDLE are the same hue at two brightnesses, so
    // this is exactly the distinction a hue-only fix would have thrown away.
    const frame = VIEWS.grid();
    const btns = realButtons(frame);
    const active = btns.get(PUSH_CC_PERMANENT_BASE + 1); // CC 92 → grid view button
    const idle = btns.get(PUSH_CC_PERMANENT_BASE + 3); // CC 94 → arranger (not active)
    expect(active).not.toBe(0);
    expect(idle).not.toBe(0);
    expect(active, 'the view you are on must not look like one you are not').not.toBe(idle);
  });

  it('SHIFT held vs at rest are both lit and different', () => {
    const held = realButtons(computeSingleGridFrame(DATA, { top: mkTop('grid', { shift: { held: true } }), blinkOn: true }));
    const rest = realButtons(VIEWS.grid());
    const cc = PUSH_CC_PERMANENT_BASE + 7; // CC 98 = SHIFT
    expect(rest.get(cc), 'SHIFT at rest was palette 0 before the fix').not.toBe(0);
    expect(held.get(cc)).not.toBe(0);
    expect(held.get(cc)).not.toBe(rest.get(cc));
  });

  it('NEGATIVE CONTROL — the pre-fix encoder left six of the eight dark', () => {
    const frame = VIEWS.grid();
    const legacy = buttonsWith(frame, legacyPushColorIndex);
    const dark = [...Array(8).keys()].filter((c) => legacy.get(PUSH_CC_PERMANENT_BASE + c) === 0);
    expect(
      dark.length,
      'the legacy encoder must black out most of the function row, else this gate proves nothing',
    ).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// ZONE 3 — the CHANNEL-SELECT row (Push CC 102..109) is covered end-to-end in
// push2-control.test.ts (it reads the live graph). What belongs HERE is the pure
// colour property that made it fail, swept over all eight lanes.
// ---------------------------------------------------------------------------
describe('ZONE 3 — the channel-select row colours (Push CC 102..109)', () => {
  const CHANNEL_DIM = 0.3; // must track push2-control.svelte.ts

  it('every default lane hue survives BOTH brightnesses and stays distinguishable', () => {
    for (let lane = 0; lane < 8; lane++) {
      const [r, g, b] = hexToRgb127(defaultLaneColorHex(lane));
      const full = pushColorIndex(r, g, b);
      const dim = pushColorIndex(
        Math.round(r * CHANNEL_DIM),
        Math.round(g * CHANNEL_DIM),
        Math.round(b * CHANNEL_DIM),
      );
      expect(full, `lane ${lane} selected must be lit`).not.toBe(0);
      expect(dim, `lane ${lane} unselected must be lit`).not.toBe(0);
      expect(full, `lane ${lane} selected must differ from unselected`).not.toBe(dim);
    }
  });

  it('NEGATIVE CONTROL — the pre-fix encoder extinguished most unselected channels', () => {
    const dark = [...Array(8).keys()].filter((lane) => {
      const [r, g, b] = hexToRgb127(defaultLaneColorHex(lane));
      return legacyPushColorIndex(
        Math.round(r * CHANNEL_DIM),
        Math.round(g * CHANNEL_DIM),
        Math.round(b * CHANNEL_DIM),
      ) === 0;
    });
    expect(
      dark.length,
      'the legacy encoder must black out unselected channel buttons, else this gate proves nothing',
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE FOURTH FACE — the clip PADS. Not in the owner's report, found while
// measuring, and the same defect: a LOADED-but-not-playing clip is painted at
// 32% of its lane hue, which the legacy encoder put on black for 3 of the 8
// default hues. So a clip that exists was invisible until you launched it.
// ---------------------------------------------------------------------------
describe('the clip PADS (same defect, not in the report)', () => {
  it('a loaded-but-not-playing clip stays visible and differs from a playing one', () => {
    for (let lane = 0; lane < 8; lane++) {
      const base = hexToRgb127(defaultLaneColorHex(lane));
      const loaded = base.map((c) => Math.round(c * 0.32)) as unknown as [number, number, number];
      const playing = pushColorIndex(...base);
      const idle = pushColorIndex(...loaded);
      expect(idle, `lane ${lane}: a loaded clip must be visible`).not.toBe(0);
      expect(playing, `lane ${lane}: playing must differ from loaded`).not.toBe(idle);
    }
  });

  it('NEGATIVE CONTROL — the pre-fix encoder made loaded clips invisible on 3 of 8 lanes', () => {
    const invisible = [...Array(8).keys()].filter((lane) => {
      const base = hexToRgb127(defaultLaneColorHex(lane));
      return legacyPushColorIndex(...(base.map((c) => Math.round(c * 0.32)) as [number, number, number])) === 0;
    });
    expect(invisible.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SCOPE, stated inside the gate (repo standard: an unstated scope reads as full
// coverage).
// ---------------------------------------------------------------------------
describe('what this file does NOT cover', () => {
  it('states its own blind spots', () => {
    // 1. It cannot verify what COLOUR a palette index actually shows — there is
    //    no Web-MIDI-in-CI and no copy of the Push 2 default palette in the repo.
    //    Only the BRIGHT entries 0/125/126/127 are research-confirmed; the mid and
    //    dim entries are inferred and carry CONFIRM ON HARDWARE. Everything
    //    asserted here is index-identity (lit / not lit / distinct), which holds
    //    whatever those entries turn out to look like.
    expect(PUSH_PALETTE_HUES.every((h) => h.bright !== h.mid && h.mid !== h.dim && h.bright !== h.dim)).toBe(true);
    // 2. It asserts the SINGLE-unit views only. Pair mode (computeLSessionFrame /
    //    computeRDeckFrame) is a Launchpad-only deployment the Push never enters.
    // 3. Pads are covered only for the lane-hue defect above, not per-view.
    expect(VIEW_NAMES).toEqual(['grid', 'clip', 'keys', 'control', 'arranger']);
  });
});
