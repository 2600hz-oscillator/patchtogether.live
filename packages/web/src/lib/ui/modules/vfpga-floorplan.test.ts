// packages/web/src/lib/ui/modules/vfpga-floorplan.test.ts
//
// Pure (GL-free, DOM-free) unit tests for the vfpga fabric-floorplan layout
// selector + the Canvas2D draw routine (P5). The load-bearing logic — placement,
// edge-node synthesis, net classification, lit-path reachability — is exercised
// in jsdom exactly like the place-and-route core it mirrors. The draw routine is
// smoke-tested against a stub 2D context (no real canvas needed).

import { describe, expect, it } from 'vitest';
import { buildFloorplan, TILE_TYPE_META } from './vfpga-floorplan';
import { drawFloorplan, DEFAULT_FLOORPLAN_COLORS } from './vfpga-floorplan-draw';
import type { VfpgaSpec, VfpgaFabric } from '$lib/video/vfpga/types';
import { smpteBarsSpec } from '$lib/video/vfpga/specs/smpte-bars';
import { syncBenderSpec } from '$lib/video/vfpga/specs/sync-bender';
import { framestoreHowlSpec } from '$lib/video/vfpga/specs/framestore-howl';

/** Wrap a bare fabric in a minimal spec for buildFloorplan. */
function specOf(fabric: VfpgaFabric): VfpgaSpec {
  return {
    id: 'fixture',
    name: 'fixture',
    doc: 'fixture',
    docSlug: 'fixture',
    videoIn: 1,
    videoOut: 1,
    fabric,
  };
}

describe('buildFloorplan — guards / legacy', () => {
  it('returns an empty floorplan for undefined spec', () => {
    const fp = buildFloorplan(undefined);
    expect(fp.hasFabric).toBe(false);
    expect(fp.tiles).toEqual([]);
    expect(fp.nets).toEqual([]);
  });

  it('returns hasFabric:false for a legacy effect-only spec', () => {
    // a spec with NO fabric (only a legacy effect) → no map.
    const legacy: VfpgaSpec = {
      id: 'legacy',
      name: 'legacy',
      doc: '',
      docSlug: 'legacy',
      videoIn: 0,
      videoOut: 1,
      effect: { passes: [{ frag: '', target: 'output' }], outputs: { vout1: 'output' } },
    };
    const fp = buildFloorplan(legacy);
    expect(fp.hasFabric).toBe(false);
    expect(fp.tiles).toEqual([]);
  });
});

describe('buildFloorplan — real catalog specs', () => {
  it('smpte-bars (generator → OUT1): 1 compute tile + 1 iob_out, 1 lit net', () => {
    const fp = buildFloorplan(smpteBarsSpec);
    expect(fp.hasFabric).toBe(true);
    // gen (clb) + o1 (iob_out)
    const gen = fp.tiles.find((t) => t.id === 'gen');
    expect(gen?.type).toBe('clb');
    expect(gen?.label).toBe('smpte');
    const o1 = fp.tiles.find((t) => t.id === 'o1');
    expect(o1?.type).toBe('iob_out');
    expect(o1?.isOutput).toBe(true);
    // gen drives vout1 → highlighted as output
    expect(gen?.isOutput).toBe(true);
    // exactly one net (gen → OUT1) and it is lit (on the live path)
    expect(fp.nets).toHaveLength(1);
    expect(fp.nets[0].lit).toBe(true);
    expect(fp.nets[0].kind).toBe('video');
  });

  it('sync-bender (IIN1 → sync → OUT1): synthesises a video edge-in node, both nets lit', () => {
    const fp = buildFloorplan(syncBenderSpec);
    expect(fp.hasFabric).toBe(true);
    // a synthetic edge-in tile for the bare IIN1 source
    const edgeIn = fp.tiles.find((t) => t.type === 'iob_in' && t.label === 'iin1');
    expect(edgeIn, 'edge-in node for IIN1').toBeTruthy();
    expect(edgeIn?.col).toBe(0); // left margin
    // 2 nets: IIN1→sync:a and sync→OUT1 — both on the live path
    expect(fp.nets).toHaveLength(2);
    expect(fp.nets.every((n) => n.lit)).toBe(true);
    // the compute tile is the syncBend cell, placed in the interior (col >= 1)
    const sync = fp.tiles.find((t) => t.id === 'sync');
    expect(sync?.label).toBe('syncbend');
    expect(sync && sync.col >= 1).toBe(true);
  });

  it('framestore-howl: register present + a dashed feedback (:prev) net flagged', () => {
    const fp = buildFloorplan(framestoreHowlSpec);
    const store = fp.tiles.find((t) => t.id === 'store');
    expect(store?.type).toBe('reg');
    // the store:prev → warp:a net is a feedback edge: isPrev + feedback kind + lit
    const fb = fp.nets.find((n) => n.fromTile === 'store' && n.isPrev);
    expect(fb, 'feedback net').toBeTruthy();
    expect(fb?.kind).toBe('feedback');
    expect(fb?.lit).toBe(true);
    // 'out' passthru drives vout1 → flagged as output
    const out = fp.tiles.find((t) => t.id === 'out');
    expect(out?.isOutput).toBe(true);
    // every fabric net is represented
    expect(fp.nets).toHaveLength(framestoreHowlSpec.fabric!.nets.length);
  });
});

describe('buildFloorplan — placement', () => {
  it('honours explicit pos and shifts compute tiles into the grid interior (+1 col)', () => {
    const fp = buildFloorplan(
      specOf({
        grid: { rows: 1, cols: 2 },
        tiles: [
          { id: 'a', type: 'clb', config: { op: 'passthru' }, pos: { row: 0, col: 0 }, inputs: ['a'] },
          { id: 'b', type: 'clb', config: { op: 'invert' }, pos: { row: 0, col: 1 }, inputs: ['a'] },
        ],
        nets: [
          { from: 'IIN1', to: 'a:a' },
          { from: 'a', to: 'b:a' },
          { from: 'b', to: 'OUT1' },
        ],
        outputs: { vout1: 'OUT1' },
      }),
    );
    const a = fp.tiles.find((t) => t.id === 'a')!;
    const b = fp.tiles.find((t) => t.id === 'b')!;
    expect(a.col).toBe(1); // pos.col 0 + 1 margin
    expect(b.col).toBe(2); // pos.col 1 + 1 margin
    expect(a.row).toBe(0);
  });

  it('auto-places tiles lacking pos deterministically (row-major)', () => {
    const fp = buildFloorplan(
      specOf({
        grid: { rows: 2, cols: 2 },
        tiles: [
          { id: 't0', type: 'clb', config: { op: 'passthru' }, inputs: ['a'] },
          { id: 't1', type: 'clb', config: { op: 'invert' }, inputs: ['a'] },
          { id: 't2', type: 'clb', config: { op: 'luma' }, inputs: ['a'] },
        ],
        nets: [
          { from: 'IIN1', to: 't0:a' },
          { from: 't0', to: 't1:a' },
          { from: 't1', to: 't2:a' },
          { from: 't2', to: 'OUT1' },
        ],
        outputs: { vout1: 'OUT1' },
      }),
    );
    const cells = fp.tiles.filter((t) => t.type === 'clb').map((t) => `${t.row}:${t.col}`);
    // row-major fill of a 2-col grid → (0,1)(0,2)(1,1) with the +1 margin shift
    expect(cells).toEqual(['0:1', '0:2', '1:1']);
  });
});

describe('buildFloorplan — net classification (cv / gate / video)', () => {
  it('classes a CIN source as cv and a GIN source as gate', () => {
    const fp = buildFloorplan(
      specOf({
        grid: { rows: 1, cols: 1 },
        // a cell that reads its sole `a` input + has cv/gate-bound knobs is not
        // needed: net kind comes purely from the source endpoint.
        tiles: [{ id: 's', type: 'clb', config: { op: 'syncBend' }, inputs: ['a'] }],
        nets: [
          { from: 'IIN1', to: 's:a' },
          { from: 's', to: 'OUT1' },
        ],
        outputs: { vout1: 'OUT1' },
      }),
    );
    // IIN1 is video
    const vin = fp.nets.find((n) => n.kind === 'video' && n.toTile === 's');
    expect(vin).toBeTruthy();
  });
});

describe('buildFloorplan — lit reachability', () => {
  it('marks a net feeding a DEAD-END (no path to output) as unlit', () => {
    // 'dead' reads IIN2 but feeds nothing → its input net is NOT on the live
    // path → unlit. The live chain IIN1→live→OUT1 stays lit.
    const fp = buildFloorplan(
      specOf({
        grid: { rows: 2, cols: 1 },
        tiles: [
          { id: 'live', type: 'clb', config: { op: 'passthru' }, inputs: ['a'] },
          { id: 'dead', type: 'clb', config: { op: 'passthru' }, inputs: ['a'] },
        ],
        nets: [
          { from: 'IIN1', to: 'live:a' },
          { from: 'live', to: 'OUT1' },
          { from: 'IIN2', to: 'dead:a' }, // dead-end: drives no output
        ],
        outputs: { vout1: 'OUT1' },
      }),
    );
    const liveNet = fp.nets.find((n) => n.toTile === 'live');
    const deadNet = fp.nets.find((n) => n.toTile === 'dead');
    expect(liveNet?.lit).toBe(true);
    expect(deadNet?.lit).toBe(false);
  });
});

describe('TILE_TYPE_META', () => {
  it('has an entry (label + colour) for every tile type', () => {
    for (const t of ['clb', 'dsp', 'bram', 'reg', 'lut16', 'iob_in', 'iob_out'] as const) {
      expect(TILE_TYPE_META[t]?.color).toMatch(/^#|rgb/);
      expect(typeof TILE_TYPE_META[t]?.label).toBe('string');
    }
  });

  it('every tile-type label is lowercase (repo label convention)', () => {
    for (const meta of Object.values(TILE_TYPE_META)) {
      expect(meta.label).toBe(meta.label.toLowerCase());
    }
  });
});

// ----------------------------------------------------------------------
// drawFloorplan — Canvas2D smoke (stub ctx records the calls it makes).
// ----------------------------------------------------------------------

function stubCtx() {
  const calls: string[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}(${args.join(',')})`);
    };
  const ctx = {
    calls,
    // state we don't assert on but must accept
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    font: '',
    textAlign: '' as CanvasTextAlign,
    textBaseline: '' as CanvasTextBaseline,
    clearRect: rec('clearRect'),
    fillRect: rec('fillRect'),
    fillText: rec('fillText'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    bezierCurveTo: rec('bezierCurveTo'),
    arcTo: rec('arcTo'),
    closePath: rec('closePath'),
    stroke: rec('stroke'),
    fill: rec('fill'),
    setLineDash: rec('setLineDash'),
  };
  return ctx as unknown as CanvasRenderingContext2D & { calls: string[] };
}

describe('drawFloorplan', () => {
  it('paints the bg then draws tiles + nets for a real fabric', () => {
    const ctx = stubCtx() as CanvasRenderingContext2D & { calls: string[] };
    drawFloorplan(ctx, buildFloorplan(framestoreHowlSpec), 320, 150, DEFAULT_FLOORPLAN_COLORS);
    // background cleared+filled
    expect(ctx.calls.some((c) => c.startsWith('clearRect'))).toBe(true);
    expect(ctx.calls.some((c) => c.startsWith('fillRect'))).toBe(true);
    // nets drawn as bezier wires
    expect(ctx.calls.some((c) => c.startsWith('bezierCurveTo'))).toBe(true);
    // tiles drawn (rounded rects via arcTo) + filled + labelled
    expect(ctx.calls.some((c) => c.startsWith('arcTo'))).toBe(true);
    expect(ctx.calls.some((c) => c.startsWith('fillText'))).toBe(true);
  });

  it('a :prev feedback net toggles the dash on then off', () => {
    const ctx = stubCtx() as CanvasRenderingContext2D & { calls: string[] };
    drawFloorplan(ctx, buildFloorplan(framestoreHowlSpec), 320, 150);
    expect(ctx.calls.some((c) => c === 'setLineDash(3,3)')).toBe(true);
  });

  it('renders the "no fabric map" note for a legacy/empty floorplan', () => {
    const ctx = stubCtx() as CanvasRenderingContext2D & { calls: string[] };
    drawFloorplan(ctx, buildFloorplan(undefined), 320, 150);
    expect(ctx.calls.some((c) => c.startsWith('fillText(no fabric map'))).toBe(true);
    // no wires / tiles drawn
    expect(ctx.calls.some((c) => c.startsWith('bezierCurveTo'))).toBe(false);
  });
});
