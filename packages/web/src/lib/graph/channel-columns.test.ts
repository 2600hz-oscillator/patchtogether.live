// packages/web/src/lib/graph/channel-columns.test.ts
//
// PURE tests for the workflow channel-columns geometry + ordered-membership
// helpers. The membership reconcilers (reconcileColumnOrder / reconcileSendOrder)
// are the COLLAB-CRITICAL heal: a lost concurrent append self-heals at the
// bottom, idempotently, converging across peers.

import { describe, it, expect } from 'vitest';
import {
  COLUMN_COUNT,
  COLUMN_W,
  COLUMN_SLOT_H,
  COLUMN_BASELINE_Y,
  columnXBand,
  sendBoxXBand,
  sendRailXBand,
  columnForFlowX,
  sendBoxForFlowX,
  columnMemberPos,
  sendMemberPos,
  columnBottomFlowPos,
  columnFlushPositions,
  sendFlushPositions,
  COLUMN_PAD_X,
  columnBandCenterX,
  sendBandCenterX,
  columnCardX,
  sendCardX,
  defaultLaneHeightPx,
  computeLaneHeightPx,
  laneTopYForHeight,
  planLanePushUps,
  laneRegionXBand,
  videoAreaBand,
  videoOutSpawnPos,
  videoZoneSlotPos,
  needsDefaultVideoOut,
  rackLacksType,
  VIDEO_ZONE_DEFAULTS,
  VIDEO_ZONE_EXTRA_DEFAULTS,
  VIDEO_ZONE_SLOT_PITCH_X,
  DEFAULT_VIDEO_OUT_ID,
  DEFAULT_RECORDERBOX_ID,
  DEFAULT_SYNESTHESIA_ID,
  videoZoneWiresFor,
  resolveMasterVideoOutId,
  VIDEO_AREA_HEIGHT,
  laneCenterViewport,
  videoAreaViewport,
  sendBoxCenterViewport,
  fitLanesViewport,
  revealMemberViewport,
  laneBandCenterX,
  indexForDropY,
  dedup,
  reconcileColumnOrder,
  reconcileSendOrder,
  insertBottom,
  insertTop,
  removeFrom,
  reorder,
  moveBetween,
  type ColumnNodeView,
} from './channel-columns';
import { RACK_UNIT } from '$lib/ui/rack-grid';

// ---------------- Geometry ----------------

describe('column geometry', () => {
  it('has 8 columns, each 34 HP wide (fits a 4hp / 720px tidyvco+sixstrum card)', () => {
    expect(COLUMN_COUNT).toBe(8);
    expect(COLUMN_W).toBe(765); // 34 × 22.5
    // The widest workflow cards are 4hp = 720px; with the 22.5px left pad the
    // card's right edge (742.5) must clear the column divider (765).
    expect(COLUMN_W).toBeGreaterThanOrEqual(720 + 22.5);
  });

  it('columnXBand is contiguous, non-overlapping, ascending', () => {
    for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
      const [x0, x1] = columnXBand(ch);
      expect(x1 - x0).toBe(COLUMN_W);
      if (ch > 1) expect(x0).toBe(columnXBand(ch - 1)[1]); // butts the previous
    }
  });

  it('columnForFlowX maps X into 1..8, then send, then null', () => {
    expect(columnForFlowX(columnXBand(1)[0])).toBe(1);
    expect(columnForFlowX(columnXBand(1)[0] + 5)).toBe(1);
    expect(columnForFlowX(columnXBand(8)[0] + 5)).toBe(8);
    // Just inside the sends rail.
    expect(columnForFlowX(sendRailXBand()[0] + 5)).toBe('send');
    // Left of the columns, and right of the sends rail → null (free canvas).
    expect(columnForFlowX(-50)).toBeNull();
    expect(columnForFlowX(sendRailXBand()[1] + 50)).toBeNull();
  });

  it('the sends rail sits immediately right of column 8, split into 2 side-by-side boxes', () => {
    expect(sendRailXBand()[0]).toBe(columnXBand(8)[1]);
    // Two boxes, side by side, each one column wide.
    expect(sendBoxXBand(1)[0]).toBe(sendRailXBand()[0]);
    expect(sendBoxXBand(2)[0]).toBe(sendBoxXBand(1)[1]); // box 2 right of box 1
    expect(sendBoxXBand(1)[1] - sendBoxXBand(1)[0]).toBe(COLUMN_W);
  });

  it('sendBoxForFlowX picks the box by X (side-by-side, not top/bottom)', () => {
    expect(sendBoxForFlowX(sendBoxXBand(1)[0] + 10)).toBe(1);
    expect(sendBoxForFlowX(sendBoxXBand(2)[0] + 10)).toBe(2);
  });

  it('columnMemberPos is BOTTOM-ANCHORED: the tail sits above the baseline, source above it', () => {
    // A 3-member column: index 0 (source) is highest, index 2 (tail) is lowest,
    // just above the baseline. y increases with index (downward).
    const p0 = columnMemberPos(3, 0, 3);
    const p1 = columnMemberPos(3, 1, 3);
    const p2 = columnMemberPos(3, 2, 3);
    expect(p1.y).toBeGreaterThan(p0.y);
    expect(p2.y).toBeGreaterThan(p1.y);
    // The tail sits one slot above the baseline.
    expect(p2.y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H);
    // Same column → same X; a later column → larger X.
    expect(p1.x).toBe(p0.x);
    expect(columnMemberPos(4, 0, 3).x).toBeGreaterThan(p0.x);
  });

  it('adding a member keeps the TAIL pinned to the bottom (existing members shift UP)', () => {
    // Single member: sits just above baseline.
    expect(columnMemberPos(2, 0, 1).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H);
    // After a 2nd member is added, the NEW one is the tail (bottom), the old one
    // shifts up one slot.
    expect(columnMemberPos(2, 1, 2).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H); // new tail, same bottom slot
    expect(columnMemberPos(2, 0, 2).y).toBe(COLUMN_BASELINE_Y - 2 * COLUMN_SLOT_H); // old one moved up
    // The tail slot is stable regardless of column depth.
    expect(columnMemberPos(2, 4, 5).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H);
  });

  it('columnBottomFlowPos(ch, count) is the new bottom slot (snap to bottom)', () => {
    expect(columnBottomFlowPos(2, 0).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H); // empty → first at bottom
    expect(columnBottomFlowPos(2, 3).y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H); // always the bottom slot
  });

  it('sendMemberPos is bottom-anchored inside its own side-by-side box', () => {
    const s1 = sendMemberPos(1, 0, 1);
    const s2 = sendMemberPos(2, 0, 1);
    expect(s1.y).toBe(COLUMN_BASELINE_Y - COLUMN_SLOT_H);
    expect(s2.x).toBeGreaterThan(s1.x); // box 2 is to the right of box 1
  });

  // ---- FLUSH bottom-up stacking (owner: no gaps; FIRST-added card at the very
  //      bottom, each later card stacks flush ON TOP — array index 0 = bottom) --
  describe('columnFlushPositions — flush, first-added at bottom, no gaps', () => {
    it('a single member sits at the VERY bottom (its bottom edge on the baseline)', () => {
      const [x0] = columnXBand(3);
      const h = 540; // a 3u card
      const [p] = columnFlushPositions(3, [h]);
      expect(p!.x).toBe(x0 + COLUMN_PAD_X);
      // bottom edge = top + height == baseline (no gap below).
      expect(p!.y + h).toBe(COLUMN_BASELINE_Y);
    });

    it('array INDEX 0 (first-added) is anchored at the BOTTOM; later indices stack up, ZERO gaps', () => {
      const heights = [720, 360, 540]; // add order: tidyvco(4u) first, sixstrum(2u), cloudseed(3u)
      const pos = columnFlushPositions(2, heights);
      // The FIRST-added card (index 0) is flush to the baseline.
      expect(pos[0]!.y + heights[0]!).toBe(COLUMN_BASELINE_Y);
      // Each later card's bottom edge == the previous card's top edge (touching).
      expect(pos[1]!.y + heights[1]!).toBe(pos[0]!.y);
      expect(pos[2]!.y + heights[2]!).toBe(pos[1]!.y);
      // All same X (column left pad).
      expect(pos[0]!.x).toBe(pos[1]!.x);
      expect(pos[1]!.x).toBe(pos[2]!.x);
      // Grows UPWARD: a LATER index (newer, higher in the stack) has a smaller y.
      expect(pos[1]!.y).toBeLessThan(pos[0]!.y);
      expect(pos[2]!.y).toBeLessThan(pos[1]!.y);
    });

    it('adding a member keeps the FIRST-added anchored at the bottom + stacks the new one on TOP', () => {
      const before = columnFlushPositions(1, [360, 540]); // 2 cards (index 0 = bottom)
      const after = columnFlushPositions(1, [360, 540, 720]); // APPEND a 720 on top
      // The two original cards keep their positions (bottom-anchored, unchanged).
      expect(after[0]!.y).toBe(before[0]!.y);
      expect(after[1]!.y).toBe(before[1]!.y);
      // The new (last) card is the top-most — a smaller y than every existing one.
      expect(after[2]!.y).toBeLessThan(after[1]!.y);
    });

    it('after adding 3 members the FIRST one is still at the bottom (bottom edge == baseline)', () => {
      const heights = [540, 360, 720]; // add order 1st, 2nd, 3rd
      const pos = columnFlushPositions(4, heights);
      expect(pos[0]!.y + heights[0]!).toBe(COLUMN_BASELINE_Y); // first-added pinned at bottom
      // and it is the lowest card on screen (largest y).
      expect(pos[0]!.y).toBeGreaterThan(pos[1]!.y);
      expect(pos[1]!.y).toBeGreaterThan(pos[2]!.y);
    });

    it('sendFlushPositions stacks flush in its own side-by-side box (first at bottom)', () => {
      const s1 = sendFlushPositions(1, [200]);
      const s2 = sendFlushPositions(2, [200]);
      expect(s1[0]!.y + 200).toBe(COLUMN_BASELINE_Y);
      expect(s2[0]!.x).toBeGreaterThan(s1[0]!.x);
      // Two tenants: index 0 (first) at the bottom, index 1 (newer) stacked on top.
      const two = sendFlushPositions(1, [200, 300]);
      expect(two[0]!.y + 200).toBe(COLUMN_BASELINE_Y);
      expect(two[1]!.y + 300).toBe(two[0]!.y);
      expect(two[1]!.y).toBeLessThan(two[0]!.y);
    });
  });

  // ---- OFFSET FIX: card center == band center == channel-number center ----
  describe('band-centering (card center aligns to the channel number + guide band)', () => {
    it('columnCardX centers a card of ANY width so its center == columnBandCenterX', () => {
      for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
        const center = columnBandCenterX(ch);
        for (const w of [360, 540, 720, 200]) {
          const x = columnCardX(ch, w);
          expect(x + w / 2).toBeCloseTo(center, 6); // card center == band center
        }
      }
    });

    it('band center is the midpoint of the guide-line pair (columnXBand)', () => {
      for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
        const [x0, x1] = columnXBand(ch);
        expect(columnBandCenterX(ch)).toBe((x0 + x1) / 2);
      }
    });

    it('columnFlushPositions with WIDTHS centers each member (card-center == band-center per column)', () => {
      const ch = 5;
      const heights = [720, 540, 360];
      const widths = [720, 540, 200]; // three different-hp cards in one column
      const pos = columnFlushPositions(ch, heights, widths);
      const center = columnBandCenterX(ch);
      pos.forEach((p, i) => {
        expect(p.x + widths[i]! / 2).toBeCloseTo(center, 6);
      });
    });

    it('a 4hp/720px card in the 765px band still lands at the historical 22.5px pad (back-compat)', () => {
      const [x0] = columnXBand(3);
      // columnCardX(720) == x0 + (765-720)/2 == x0 + 22.5 == x0 + COLUMN_PAD_X.
      expect(columnCardX(3, 720)).toBe(x0 + COLUMN_PAD_X);
    });

    it('WITHOUT widths, columnFlushPositions keeps the legacy left-pad x (unchanged callers)', () => {
      const [x0] = columnXBand(2);
      const [p] = columnFlushPositions(2, [540]);
      expect(p!.x).toBe(x0 + COLUMN_PAD_X);
    });

    it('sendCardX centers in its own box (center == sendBandCenterX)', () => {
      for (let slot = 1; slot <= 2; slot++) {
        const center = sendBandCenterX(slot);
        expect(sendCardX(slot, 360) + 180).toBeCloseTo(center, 6);
      }
      // sendFlushPositions with widths centers too.
      const sp = sendFlushPositions(1, [300], [300]);
      expect(sp[0]!.x + 150).toBeCloseTo(sendBandCenterX(1), 6);
    });
  });

  // ---- LANE HEIGHT: default + uniform grow-up ----
  describe('lane height (default ~2× tidyvco, grows to the tallest stack)', () => {
    it('defaultLaneHeightPx is 2× the reference card height', () => {
      expect(defaultLaneHeightPx(540)).toBe(1080); // 2× a 3u tidyvco
    });

    it('computeLaneHeightPx returns the default when every stack fits under it', () => {
      expect(computeLaneHeightPx([540, 720, 0, 360], 1080)).toBe(1080);
    });

    it('computeLaneHeightPx grows to the TALLEST stack when one exceeds the default', () => {
      expect(computeLaneHeightPx([540, 1800, 360], 1080)).toBe(1800); // uniform max
    });

    it('laneTopYForHeight grows UPWARD (taller lane → smaller top Y), baseline pinned', () => {
      const shortTop = laneTopYForHeight(1080);
      const tallTop = laneTopYForHeight(1800);
      expect(shortTop).toBe(COLUMN_BASELINE_Y - 1080);
      expect(tallTop).toBeLessThan(shortTop); // grew up
      expect(COLUMN_BASELINE_Y).toBeGreaterThan(tallTop); // baseline stays below the top
    });
  });

  // ---- GROW-UP PUSH: canvas modules clear the grown lanes (incl. locked) ----
  describe('planLanePushUps (modules over the lanes are lifted to a lockable Y)', () => {
    const laneTop = laneTopYForHeight(1800); // a grown lane
    const overX = laneRegionXBand()[0] + 100; // inside the lane band

    it('lifts a module dipping into the lane region to a grid-snapped Y above it', () => {
      // A 180px module whose bottom (laneTop + 90) dips 90px below the new top.
      const m = { id: 'a', x: overX, y: laneTop - 90, w: 360, h: 180 };
      const [push] = planLanePushUps([m], laneTop);
      expect(push!.id).toBe('a');
      // New Y is grid-aligned (a lockable row) …
      expect(push!.y % RACK_UNIT).toBe(0);
      // … and lifts the module's BOTTOM to at/above the lane top.
      expect(push!.y + m.h).toBeLessThanOrEqual(laneTop);
      // … moving UP (smaller Y than before).
      expect(push!.y).toBeLessThan(m.y);
    });

    it('leaves a module that already clears the lane top untouched (idempotent)', () => {
      const clear = { id: 'b', x: overX, y: laneTop - 180, w: 360, h: 180 }; // bottom == laneTop
      expect(planLanePushUps([clear], laneTop)).toEqual([]);
    });

    it('ignores a module with NO horizontal overlap with the lane band', () => {
      const rightOfLanes = laneRegionXBand()[1] + 500;
      const m = { id: 'c', x: rightOfLanes, y: laneTop - 90, w: 360, h: 180 };
      expect(planLanePushUps([m], laneTop)).toEqual([]);
    });

    it('re-running on the pushed positions yields an empty plan (no write storm)', () => {
      const m = { id: 'a', x: overX, y: laneTop - 90, w: 360, h: 180 };
      const [push] = planLanePushUps([m], laneTop);
      const moved = { ...m, y: push!.y };
      expect(planLanePushUps([moved], laneTop)).toEqual([]);
    });
  });

  // ---- VIDEO AREA + default videoOut ----
  describe('video area (purple zone) + default videoOut', () => {
    it('videoAreaBand sits directly below the baseline, backdraft-tall, over the column band', () => {
      const b = videoAreaBand();
      expect(b.y0).toBe(COLUMN_BASELINE_Y);
      expect(b.y1 - b.y0).toBe(VIDEO_AREA_HEIGHT);
      expect(VIDEO_AREA_HEIGHT).toBe(RACK_UNIT * 3); // backdraft default = 3u/540px
      expect(b.x0).toBe(columnXBand(1)[0]);
      expect(b.x1).toBe(columnXBand(COLUMN_COUNT)[1]); // spans all 8 columns
    });

    it('videoOutSpawnPos is grid-snapped and INSIDE the video area', () => {
      const p = videoOutSpawnPos();
      const b = videoAreaBand();
      const VIDEO_OUT = 360; // videoOut default box
      expect(p.x).toBeGreaterThanOrEqual(b.x0);
      expect(p.x + VIDEO_OUT).toBeLessThanOrEqual(b.x1);
      expect(p.y).toBeGreaterThanOrEqual(b.y0);
      expect(p.y + VIDEO_OUT).toBeLessThanOrEqual(b.y1); // fits within the 540px zone
      expect(p.x % (RACK_UNIT / 8)).toBe(0); // on the HP grid
      expect(p.y % RACK_UNIT).toBe(0); // on the U grid
    });

    it('needsDefaultVideoOut is true only when no videoOut exists yet', () => {
      expect(needsDefaultVideoOut([{ type: 'tidyVco' }, { type: 'mixmstrs' }])).toBe(true);
      expect(needsDefaultVideoOut([{ type: 'tidyVco' }, { type: 'videoOut' }])).toBe(false);
    });

    it('rackLacksType is true only when no node of the type exists', () => {
      expect(rackLacksType([{ type: 'videoOut' }], 'recorderbox')).toBe(true);
      expect(rackLacksType([{ type: 'recorderbox' }], 'recorderbox')).toBe(false);
      expect(rackLacksType([{ type: 'synesthesia' }], 'synesthesia')).toBe(false);
    });
  });

  // ---- VIDEO ZONE default TRIO layout (videoOut + recorderbox + synesthesia) ----
  describe('video-zone default trio: spawn layout (no overlap, grid-snapped, in-zone)', () => {
    it('videoOutSpawnPos is slot 0 (unchanged — the pre-existing videoOut never moves)', () => {
      expect(videoOutSpawnPos()).toEqual(videoZoneSlotPos(0));
    });

    it('the trio lays out left→right at one-column pitch, deterministic ids + roles', () => {
      expect(VIDEO_ZONE_DEFAULTS.map((s) => s.id)).toEqual([
        DEFAULT_VIDEO_OUT_ID, DEFAULT_RECORDERBOX_ID, DEFAULT_SYNESTHESIA_ID,
      ]);
      expect(VIDEO_ZONE_DEFAULTS.map((s) => s.type)).toEqual([
        'videoOut', 'recorderbox', 'synesthesia',
      ]);
      // slots ascend by exactly the pitch
      expect(VIDEO_ZONE_DEFAULTS[1]!.pos.x - VIDEO_ZONE_DEFAULTS[0]!.pos.x).toBe(VIDEO_ZONE_SLOT_PITCH_X);
      expect(VIDEO_ZONE_DEFAULTS[2]!.pos.x - VIDEO_ZONE_DEFAULTS[1]!.pos.x).toBe(VIDEO_ZONE_SLOT_PITCH_X);
      // the EXTRA set (what the new ensure spawns) is exactly the two non-videoOut ones
      expect(VIDEO_ZONE_EXTRA_DEFAULTS.map((s) => s.id)).toEqual([
        DEFAULT_RECORDERBOX_ID, DEFAULT_SYNESTHESIA_ID,
      ]);
    });

    it('all three fit the video zone horizontally, grid-snapped, with NO overlap', () => {
      const b = videoAreaBand();
      let prevRight = -Infinity;
      for (const s of VIDEO_ZONE_DEFAULTS) {
        // grid-snapped (HP grid on x, U grid on y)
        expect(s.pos.x % (RACK_UNIT / 8)).toBe(0);
        expect(s.pos.y % RACK_UNIT).toBe(0);
        // same top edge (the zone's baseline) for all three
        expect(s.pos.y).toBe(b.y0);
        // inside the zone band horizontally
        expect(s.pos.x).toBeGreaterThanOrEqual(b.x0);
        expect(s.pos.x + s.nominalWidth).toBeLessThanOrEqual(b.x1);
        // no overlap with the previous card (left edge clears prior right edge)
        expect(s.pos.x).toBeGreaterThanOrEqual(prevRight);
        prevRight = s.pos.x + s.nominalWidth;
      }
    });
  });

  describe('video-zone default WIRING (master A/V taps) — deterministic edge ids', () => {
    it('resolveMasterVideoOutId prefers workflow-videoOut, then any videoOut, else null', () => {
      expect(resolveMasterVideoOutId([{ id: DEFAULT_VIDEO_OUT_ID, type: 'videoOut' }])).toBe(DEFAULT_VIDEO_OUT_ID);
      expect(resolveMasterVideoOutId([{ id: 'user-vo', type: 'videoOut' }])).toBe('user-vo');
      expect(resolveMasterVideoOutId([{ id: 'x', type: 'scope' }])).toBeNull();
      // workflow-videoOut wins even when a user videoOut is also present
      expect(resolveMasterVideoOutId([
        { id: 'user-vo', type: 'videoOut' },
        { id: DEFAULT_VIDEO_OUT_ID, type: 'videoOut' },
      ])).toBe(DEFAULT_VIDEO_OUT_ID);
    });

    it('recorderbox wires: master VIDEO ← videoOut.out, master AUDIO ← mixmstrs masterL/R', () => {
      const wires = videoZoneWiresFor('recorderbox', DEFAULT_VIDEO_OUT_ID);
      expect(wires).toEqual([
        {
          id: `e-${DEFAULT_VIDEO_OUT_ID}-out-${DEFAULT_RECORDERBOX_ID}-in`,
          source: { nodeId: DEFAULT_VIDEO_OUT_ID, portId: 'out' },
          target: { nodeId: DEFAULT_RECORDERBOX_ID, portId: 'in' },
          sourceType: 'video', targetType: 'video',
        },
        {
          id: `e-pinned-mixmstrs-masterL-${DEFAULT_RECORDERBOX_ID}-audio_l`,
          source: { nodeId: 'pinned-mixmstrs', portId: 'masterL' },
          target: { nodeId: DEFAULT_RECORDERBOX_ID, portId: 'audio_l' },
          sourceType: 'audio', targetType: 'audio',
        },
        {
          id: `e-pinned-mixmstrs-masterR-${DEFAULT_RECORDERBOX_ID}-audio_r`,
          source: { nodeId: 'pinned-mixmstrs', portId: 'masterR' },
          target: { nodeId: DEFAULT_RECORDERBOX_ID, portId: 'audio_r' },
          sourceType: 'audio', targetType: 'audio',
        },
      ]);
    });

    it('recorderbox omits the video wire when no videoOut exists (audio still wired)', () => {
      const wires = videoZoneWiresFor('recorderbox', null);
      expect(wires.map((w) => w.target.portId)).toEqual(['audio_l', 'audio_r']);
    });

    it('synesthesia wires: mixmstrs masterL → A (a_in), masterR → B (b_in)', () => {
      const wires = videoZoneWiresFor('synesthesia', null);
      expect(wires).toEqual([
        {
          id: `e-pinned-mixmstrs-masterL-${DEFAULT_SYNESTHESIA_ID}-a_in`,
          source: { nodeId: 'pinned-mixmstrs', portId: 'masterL' },
          target: { nodeId: DEFAULT_SYNESTHESIA_ID, portId: 'a_in' },
          sourceType: 'audio', targetType: 'audio',
        },
        {
          id: `e-pinned-mixmstrs-masterR-${DEFAULT_SYNESTHESIA_ID}-b_in`,
          source: { nodeId: 'pinned-mixmstrs', portId: 'masterR' },
          target: { nodeId: DEFAULT_SYNESTHESIA_ID, portId: 'b_in' },
          sourceType: 'audio', targetType: 'audio',
        },
      ]);
    });
  });

  it('indexForDropY returns the ORDER-array insert index (centers descend in Y: index 0 = bottom)', () => {
    // Siblings in ORDER-array order: index 0 (first-added) is at the BOTTOM = the
    // LARGEST Y, higher indices are higher up (smaller Y).
    const centers = [500, 300, 100];
    expect(indexForDropY(centers, 999)).toBe(0); // below all → bottom slot (index 0)
    expect(indexForDropY(centers, 400)).toBe(1); // between index 0 and 1
    expect(indexForDropY(centers, 200)).toBe(2); // between index 1 and 2
    expect(indexForDropY(centers, 50)).toBe(3); // above all → top (append)
  });
});

// ---------------- Viewport navigation (workflow keyboard pan) ----------------

describe('viewport navigation (workflow keyboard pan) — keeps zoom, pure translate', () => {
  // screen = flow*zoom + translate; these helpers return {x, y, zoom}. We verify
  // by re-projecting the target flow point through the returned transform.
  const project = (flow: number, t: { pan: number; zoom: number }) => flow * t.zoom + t.pan;

  describe('laneCenterViewport — column centered horizontally, baseline at viewport bottom', () => {
    it('centers the band center-x and drops the baseline to the viewport bottom at zoom 1', () => {
      const vp = { widthPx: 1000, heightPx: 800, zoom: 1 };
      for (let ch = 1; ch <= COLUMN_COUNT; ch++) {
        const t = laneCenterViewport(ch, vp);
        expect(t.zoom).toBe(1); // zoom is kept
        // band center-x maps to the horizontal center of the viewport
        expect(project(columnBandCenterX(ch), { pan: t.x, zoom: t.zoom })).toBeCloseTo(vp.widthPx / 2, 6);
        // baseline maps to the very bottom of the viewport
        expect(project(COLUMN_BASELINE_Y, { pan: t.y, zoom: t.zoom })).toBeCloseTo(vp.heightPx, 6);
      }
    });

    it('holds the framing at a non-unit zoom (zoom is unchanged)', () => {
      const vp = { widthPx: 1280, heightPx: 720, zoom: 0.35 };
      const t = laneCenterViewport(4, vp);
      expect(t.zoom).toBe(0.35);
      expect(project(columnBandCenterX(4), { pan: t.x, zoom: t.zoom })).toBeCloseTo(vp.widthPx / 2, 6);
      expect(project(COLUMN_BASELINE_Y, { pan: t.y, zoom: t.zoom })).toBeCloseTo(vp.heightPx, 6);
    });
  });

  describe('videoAreaViewport — video zone lower-left maps to viewport lower-left', () => {
    it('maps (minX, maxY) of the video area to screen (0, heightPx), keeping zoom', () => {
      const b = videoAreaBand();
      for (const vp of [
        { widthPx: 1000, heightPx: 800, zoom: 1 },
        { widthPx: 1280, heightPx: 720, zoom: 0.5 },
      ]) {
        const t = videoAreaViewport(vp);
        expect(t.zoom).toBe(vp.zoom);
        expect(project(b.x0, { pan: t.x, zoom: t.zoom })).toBeCloseTo(0, 6); // left edge → screen x 0
        expect(project(b.y1, { pan: t.y, zoom: t.zoom })).toBeCloseTo(vp.heightPx, 6); // bottom → screen bottom
      }
    });
  });

  describe('sendBoxCenterViewport — send box centered horizontally, baseline at bottom', () => {
    it('centers the send band center-x and drops the baseline to the viewport bottom', () => {
      const vp = { widthPx: 1280, heightPx: 720, zoom: 0.4 };
      for (const slot of [1, 2]) {
        const t = sendBoxCenterViewport(slot, vp);
        expect(t.zoom).toBe(0.4);
        expect(project(sendBandCenterX(slot), { pan: t.x, zoom: t.zoom })).toBeCloseTo(vp.widthPx / 2, 6);
        expect(project(COLUMN_BASELINE_Y, { pan: t.y, zoom: t.zoom })).toBeCloseTo(vp.heightPx, 6);
      }
    });
  });

  describe('fitLanesViewport — on-load framing centers the whole 8-column band', () => {
    it('centers the band center-x + baseline at the viewport bottom, keeping zoom', () => {
      const vp = { widthPx: 1280, heightPx: 720, zoom: 0.22 };
      const t = fitLanesViewport(vp);
      expect(t.zoom).toBe(0.22);
      expect(project(laneBandCenterX(), { pan: t.x, zoom: t.zoom })).toBeCloseTo(vp.widthPx / 2, 6);
      expect(project(COLUMN_BASELINE_Y, { pan: t.y, zoom: t.zoom })).toBeCloseTo(vp.heightPx, 6);
    });
  });

  describe('revealMemberViewport — guarantees a just-added member is on screen', () => {
    const vp = { widthPx: 1280, heightPx: 720, zoom: 0.5 };
    // With laneCenterViewport the top visible flow-Y = BASELINE - heightPx/zoom.
    const base = laneCenterViewport(3, vp);
    const visibleTopFlowY = COLUMN_BASELINE_Y - vp.heightPx / vp.zoom;

    it('SHORT stack (member top already visible) → returns the base unchanged', () => {
      const memberTopY = visibleTopFlowY + 100; // comfortably in view
      const t = revealMemberViewport(base, memberTopY, 88, vp);
      expect(t).toEqual(base);
    });

    it('TALL stack (member top above the viewport) → re-centers on the member', () => {
      const memberTopY = visibleTopFlowY - 500; // above the visible top → clipped
      const t = revealMemberViewport(base, memberTopY, 180, vp);
      // horizontal framing is preserved (lane still centered), zoom kept
      expect(t.x).toBe(base.x);
      expect(t.zoom).toBe(vp.zoom);
      // the member's CENTER maps to the vertical center of the viewport
      const memberCenterY = memberTopY + 180 / 2;
      expect(project(memberCenterY, { pan: t.y, zoom: t.zoom })).toBeCloseTo(vp.heightPx / 2, 6);
      // …and the member's whole box is now within [0, heightPx]
      expect(project(memberTopY, { pan: t.y, zoom: t.zoom })).toBeGreaterThanOrEqual(0);
      expect(project(memberTopY + 180, { pan: t.y, zoom: t.zoom })).toBeLessThanOrEqual(vp.heightPx);
    });
  });
});

// ---------------- Array helpers ----------------

const nodesMap = (entries: ColumnNodeView[]): Map<string, ColumnNodeView> =>
  new Map(entries.map((e) => [e.id, e]));

describe('dedup / insert / remove / reorder', () => {
  it('dedup preserves first-occurrence order', () => {
    expect(dedup(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
  it('insertBottom / insertTop are no-ops when present', () => {
    expect(insertBottom(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(insertBottom(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(insertTop(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
    expect(insertTop(['a', 'b'], 'b')).toEqual(['a', 'b']);
  });
  it('removeFrom drops the id', () => {
    expect(removeFrom(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
  it('reorder moves an id to a new index (index vs the removed array)', () => {
    expect(reorder(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']); // to end
    expect(reorder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']); // to top
    expect(reorder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']); // no move
    expect(reorder(['a', 'b', 'c'], 'z', 0)).toEqual(['a', 'b', 'c']); // absent
  });
});

describe('moveBetween', () => {
  it('removes from the source and appends to the destination', () => {
    expect(moveBetween(['a', 'b'], ['x', 'y'], 'a')).toEqual({ from: ['b'], to: ['x', 'y', 'a'] });
  });
});

// ---------------- reconcileColumnOrder — the CRDT heal ----------------

describe('reconcileColumnOrder (membership heal)', () => {
  it('drops ids whose data.channel no longer matches (moved / cleared)', () => {
    const nodes = nodesMap([
      { id: 'a', channel: 1 },
      { id: 'b', channel: 2 }, // moved away
      { id: 'c', channel: 1 },
    ]);
    expect(reconcileColumnOrder(['a', 'b', 'c'], 1, nodes)).toEqual(['a', 'c']);
  });

  it('drops ids that no longer exist', () => {
    const nodes = nodesMap([{ id: 'a', channel: 1 }]);
    expect(reconcileColumnOrder(['a', 'ghost'], 1, nodes)).toEqual(['a']);
  });

  it('ADOPTS a lost concurrent append at the bottom (sorted for cross-peer convergence)', () => {
    // data.channel is truth: x + z belong to ch1 but the order array only has x
    // (z's concurrent push was lost in the last-writer-wins Y.Map value).
    const nodes = nodesMap([
      { id: 'x', channel: 1 },
      { id: 'z', channel: 1 }, // lost append
      { id: 'm', channel: 1 }, // another lost append
    ]);
    // Sorted adoption → deterministic tail on every peer.
    expect(reconcileColumnOrder(['x'], 1, nodes)).toEqual(['x', 'm', 'z']);
  });

  it('is IDEMPOTENT — re-running on its own output is a no-op', () => {
    const nodes = nodesMap([
      { id: 'a', channel: 1 },
      { id: 'b', channel: 1 },
      { id: 'c', channel: 1 },
    ]);
    const once = reconcileColumnOrder(['b', 'a'], 1, nodes);
    const twice = reconcileColumnOrder(once, 1, nodes);
    expect(twice).toEqual(once);
  });

  it('de-dups a doubled id', () => {
    const nodes = nodesMap([{ id: 'a', channel: 1 }, { id: 'b', channel: 1 }]);
    expect(reconcileColumnOrder(['a', 'a', 'b'], 1, nodes)).toEqual(['a', 'b']);
  });

  it('preserves the intended order for existing members (no gratuitous re-sort)', () => {
    const nodes = nodesMap([
      { id: 'a', channel: 1 },
      { id: 'b', channel: 1 },
      { id: 'c', channel: 1 },
    ]);
    // User-authored order b,c,a is preserved (only ADOPTED tail members sort).
    expect(reconcileColumnOrder(['b', 'c', 'a'], 1, nodes)).toEqual(['b', 'c', 'a']);
  });

  it('CONVERGENCE: two peers with divergent orders but same membership truth heal to the SAME array', () => {
    const nodes = nodesMap([
      { id: 'a', channel: 1 },
      { id: 'b', channel: 1 },
      { id: 'c', channel: 1 }, // both peers lost c's append
    ]);
    // Peer A saw [a,b]; peer B saw [b,a]. Different kept orders → NOT guaranteed
    // identical (kept order is user layout), but the ADOPTED member c lands at
    // the same relative place (bottom) on both. The invariant we DO guarantee:
    // membership set is identical + adopted tail is deterministic.
    const healA = reconcileColumnOrder(['a', 'b'], 1, nodes);
    const healB = reconcileColumnOrder(['a', 'b'], 1, nodes);
    expect(healA).toEqual(healB); // same input → identical output (determinism)
    expect(new Set(healA)).toEqual(new Set(['a', 'b', 'c'])); // full membership
    expect(healA[healA.length - 1]).toBe('c'); // adopted at the bottom
  });
});

describe('reconcileSendOrder (send membership heal)', () => {
  it('keeps only sendSlot matches and adopts lost appends at the bottom', () => {
    const nodes = nodesMap([
      { id: 'r', sendSlot: 1 },
      { id: 's', sendSlot: 2 }, // other box
      { id: 't', sendSlot: 1 }, // lost append
    ]);
    expect(reconcileSendOrder(['r'], 1, nodes)).toEqual(['r', 't']);
    expect(reconcileSendOrder(['r', 's'], 2, nodes)).toEqual(['s']);
  });
});
