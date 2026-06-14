// packages/web/src/lib/ui/modules/vfpga-floorplan.ts
//
// FABRIC FLOORPLAN — the pure, GL-FREE layout selector (vfpga P5). It lowers a
// loaded `VfpgaSpec`'s placed FABRIC (tiles[] + nets[] + grid, the place-and-
// route INPUT/placement map — design §1.4) into a flat, render-ready floorplan
// MODEL the card draws as a 2D diagram: the tile grid (typed, labelled, placed)
// + the routing nets (wires) with a per-net "lit" (carries signal) flag.
//
// This is a READ-ONLY derivation of the existing placed fabric — it changes
// NOTHING in the engine render path or any spec output. It lives in `lib/ui`
// (NOT `lib/video`) and only IMPORTS the vfpga TYPES, so it is OUTSIDE the
// webgl-attest hash basis (which sweeps `lib/video/**` + WebGL `lib/ui/modules`
// cards; a Canvas2D card/helper is not a WebGL render path).
//
// Pure data → data (no DOM, no GL, no Y.Doc), unit-tested in jsdom exactly like
// the place-and-route core. The card's <VfpgaFloorplan> component renders this
// model onto a Canvas2D surface (render-local; no per-frame Y.Doc writes).

import {
  VFPGA_IOB_IIN,
  VFPGA_IOB_CIN,
  VFPGA_IOB_GIN,
  VFPGA_IOB_OUT,
  type VfpgaFabric,
  type VfpgaNet,
  type VfpgaSpec,
  type VfpgaTile,
  type VfpgaTileType,
} from '$lib/video/vfpga/types';

/** A net's signal CLASS — drives its wire colour in the diagram. Derived from
 *  the net's resolved source/destination (matches the cable palette). */
export type FloorplanNetKind = 'video' | 'cv' | 'gate' | 'feedback';

/** One PLACED tile in the floorplan — a tile with a resolved (row, col) grid
 *  cell, a short display label, and its silicon type (for colour). IOB edge
 *  tiles (in/out) are included so a net's host-edge endpoint has a node to
 *  anchor on. */
export interface FloorplanTile {
  id: string;
  type: VfpgaTileType;
  /** Short lowercase label shown inside the tile (the cell op, or the IOB port). */
  label: string;
  /** Resolved grid cell (0-based). Auto-placed when the tile omits `pos`. */
  row: number;
  col: number;
  /** True for the tile whose FBO a video OUTPUT samples (highlighted). */
  isOutput: boolean;
}

/** One routed net in the floorplan — a wire from a source tile to a destination
 *  tile (both resolved to placed-tile ids), with a signal class and a "lit"
 *  flag (carries signal in the current config). */
export interface FloorplanNet {
  /** Source placed-tile id (an iob-in synthetic tile, a compute tile, or a
   *  register read). */
  fromTile: string;
  /** Destination placed-tile id (a compute tile or an iob-out synthetic tile). */
  toTile: string;
  /** Signal class (wire colour). */
  kind: FloorplanNetKind;
  /** True if this net carries signal — i.e. lies on a path from a fabric input/
   *  generator to a video output (the "lit routing net" the plan calls out). A
   *  `:prev` feedback edge is always lit (it is the clocked recirculation). */
  lit: boolean;
  /** True for a clocked previous-frame (`<reg>:prev`) read — drawn dashed. */
  isPrev: boolean;
}

/** The full floorplan model the card draws. `tiles` are placed onto a
 *  `rows × cols` grid; `nets` connect them. Empty when the spec has no fabric
 *  (a legacy `effect`-only spec, e.g. smpte-bars' legacy ref) — the card shows a
 *  "no fabric map" note in that case. */
export interface VfpgaFloorplan {
  rows: number;
  cols: number;
  tiles: FloorplanTile[];
  nets: FloorplanNet[];
  /** True when the source spec actually carries a `fabric` (vs legacy effect). */
  hasFabric: boolean;
}

/** Synthetic tile-id prefix for a host-edge IOB-in port that a net SOURCES but
 *  the fabric did not declare as its own `iob_in` tile (most specs reference
 *  IIN1/CIN1/… directly in `net.from` without a tile). We synthesise an edge
 *  node so the wire has something to attach to in the diagram. */
const EDGE_PREFIX = 'edge:';

const ALL_IOB_IN = [...VFPGA_IOB_IIN, ...VFPGA_IOB_CIN, ...VFPGA_IOB_GIN] as readonly string[];

/** The kind (wire colour) of a fabric IOB-in host port. */
function iobInKind(port: string): FloorplanNetKind {
  if ((VFPGA_IOB_CIN as readonly string[]).includes(port)) return 'cv';
  if ((VFPGA_IOB_GIN as readonly string[]).includes(port)) return 'gate';
  return 'video'; // IIN
}

/** Parse `net.from` into the placed-tile id it anchors on + whether it is a
 *  clocked `:prev` read. */
function fromTileId(from: string): { tile: string; isPrev: boolean; edgePort?: string } {
  if (ALL_IOB_IN.includes(from)) return { tile: EDGE_PREFIX + from, isPrev: false, edgePort: from };
  if (from.endsWith(':prev')) return { tile: from.slice(0, -':prev'.length), isPrev: true };
  return { tile: from, isPrev: false };
}

/** Parse `net.to` into the placed-tile id it anchors on. A bare OUT port that
 *  has an explicit `iob_out` tile resolves to THAT tile's id; a bare OUT port
 *  with no tile gets a synthetic edge node. `outTileFor` maps OUT1/OUT2 → the
 *  iob_out tile id when one exists. */
function toTileId(to: string, outTileFor: (port: string) => string | undefined): { tile: string; edgePort?: string } {
  if ((VFPGA_IOB_OUT as readonly string[]).includes(to)) {
    const tileId = outTileFor(to);
    return tileId ? { tile: tileId, edgePort: to } : { tile: EDGE_PREFIX + to, edgePort: to };
  }
  const colon = to.indexOf(':');
  return { tile: colon < 0 ? to : to.slice(0, colon) };
}

/** A short lowercase label for a placed tile (the cell op, the IOB port, or a
 *  type fallback). Lowercase per the repo label convention. */
function tileLabel(t: VfpgaTile): string {
  const op = t.config.op;
  if (t.type === 'iob_in' || t.type === 'iob_out') return (op ?? t.type).toLowerCase();
  if (op) return op.toLowerCase();
  return t.type;
}

/** Auto-place tiles lacking an explicit `pos` into the grid: fill row-major
 *  into the first free cell (skipping cells already taken by an explicit pos).
 *  Deterministic (fabric tile order). Synthetic edge nodes are placed in the
 *  margins (handled by the caller's column extension). */
function placeTiles(fabric: VfpgaFabric): Map<string, { row: number; col: number }> {
  const placed = new Map<string, { row: number; col: number }>();
  const taken = new Set<string>();
  const key = (r: number, c: number) => `${r},${c}`;
  const cols = Math.max(1, fabric.grid.cols);

  // First pass: honour explicit positions.
  for (const t of fabric.tiles) {
    if (t.type === 'iob_in' || t.type === 'iob_out') continue; // edge tiles placed in margins
    if (t.pos) {
      placed.set(t.id, { row: t.pos.row, col: t.pos.col });
      taken.add(key(t.pos.row, t.pos.col));
    }
  }
  // Second pass: auto-place the rest row-major into free cells.
  let cursor = 0;
  const nextFree = (): { row: number; col: number } => {
    for (;;) {
      const row = Math.floor(cursor / cols);
      const col = cursor % cols;
      cursor++;
      if (!taken.has(key(row, col))) {
        taken.add(key(row, col));
        return { row, col };
      }
    }
  };
  for (const t of fabric.tiles) {
    if (t.type === 'iob_in' || t.type === 'iob_out') continue;
    if (!placed.has(t.id)) placed.set(t.id, nextFree());
  }
  return placed;
}

/** Build the read-only floorplan model for a loaded spec. Pure: no DOM/GL/store.
 *  An `undefined` spec or a legacy `effect`-only spec yields an empty floorplan
 *  with `hasFabric:false` (the card shows a "no fabric map" note). */
export function buildFloorplan(spec: VfpgaSpec | undefined): VfpgaFloorplan {
  const fabric = spec?.fabric;
  if (!fabric) {
    return { rows: 0, cols: 0, tiles: [], nets: [], hasFabric: false };
  }

  const placed = placeTiles(fabric);
  const computeById = new Map(fabric.tiles.map((t) => [t.id, t] as const));

  // Which OUT ports have an explicit iob_out tile (vs a bare OUT1 net target).
  const outTileByPort = new Map<string, VfpgaTile>();
  for (const t of fabric.tiles) {
    if (t.type === 'iob_out') outTileByPort.set(t.config.op ?? '', t);
  }
  const outTileFor = (port: string): string | undefined => outTileByPort.get(port)?.id;

  // ── Collect the placed tiles (compute + IOB) and synthetic edge nodes. ──
  // Edge nodes (host-edge IOB-in ports referenced bare, bare OUT targets) get
  // placed in the left/right margins so a wire has an anchor. We extend the grid
  // by one column on each side for them.
  const tiles: FloorplanTile[] = [];
  const tileRow = new Map<string, number>(); // for edge-node vertical placement

  // Resolve which tile drives each vout (for the isOutput highlight).
  const outputTileIds = new Set<string>();
  const resolveVoutTile = (ref: string | undefined): string | null => {
    if (!ref) return null;
    const t = computeById.get(ref);
    if (t && t.type === 'iob_out') {
      // follow the OUT net to its driving compute tile
      const port = t.config.op ?? '';
      const net = fabric.nets.find((n) => n.to === port);
      if (net) return fromTileId(net.from).tile;
      return t.id;
    }
    if ((VFPGA_IOB_OUT as readonly string[]).includes(ref)) {
      const net = fabric.nets.find((n) => n.to === ref);
      return net ? fromTileId(net.from).tile : null;
    }
    return t ? t.id : null;
  };
  const v1 = resolveVoutTile(fabric.outputs.vout1);
  const v2 = resolveVoutTile(fabric.outputs.vout2);
  if (v1) outputTileIds.add(v1);
  if (v2) outputTileIds.add(v2);

  // Compute tiles (placed in the grid interior, shifted +1 col for the margin).
  for (const t of fabric.tiles) {
    if (t.type === 'iob_in' || t.type === 'iob_out') continue;
    const p = placed.get(t.id)!;
    tiles.push({
      id: t.id,
      type: t.type,
      label: tileLabel(t),
      row: p.row,
      col: p.col + 1, // +1: reserve col 0 for the left margin (inputs)
      isOutput: outputTileIds.has(t.id),
    });
    tileRow.set(t.id, p.row);
  }

  // ── Nets → wires; gather the edge nodes they reference. ──
  const nets: FloorplanNet[] = [];
  const edgeNodes = new Map<string, { port: string; kind: FloorplanNetKind; side: 'in' | 'out' }>();

  // Build a forward reachability set from inputs/generators to outputs so we can
  // flag "lit" nets (on a live signal path). A net is lit if its destination is
  // reachable to an output OR it is a feedback (:prev) edge.
  // Forward graph: src tile → [dst tiles].
  const fwd = new Map<string, Set<string>>();
  const addFwd = (a: string, b: string) => {
    if (!fwd.has(a)) fwd.set(a, new Set());
    fwd.get(a)!.add(b);
  };

  // OUT-driving tiles (sinks) — a net reaching one of these is on the live path.
  const outDriverTiles = new Set<string>();

  for (const net of fabric.nets) {
    const f = fromTileId(net.from);
    const to = toTileId(net.to, outTileFor);
    // record synthetic edge-in node
    if (f.edgePort) {
      edgeNodes.set(f.tile, { port: f.edgePort, kind: iobInKind(f.edgePort), side: 'in' });
    }
    // record synthetic edge-out node (bare OUT target)
    if (to.edgePort && to.tile.startsWith(EDGE_PREFIX)) {
      edgeNodes.set(to.tile, { port: to.edgePort, kind: 'video', side: 'out' });
    }
    if (to.edgePort) outDriverTiles.add(f.tile);
    addFwd(f.tile, to.tile);
  }

  // forward-reachability to any out driver (incl. through iob_out tiles).
  const reachesOut = new Set<string>(outDriverTiles);
  // also: a tile that drives an iob_out tile reaches out.
  for (const t of outTileByPort.values()) reachesOut.add(t.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [src, dsts] of fwd) {
      if (reachesOut.has(src)) continue;
      for (const d of dsts) {
        if (reachesOut.has(d)) {
          reachesOut.add(src);
          changed = true;
          break;
        }
      }
    }
  }

  // place the edge nodes in the margins.
  for (const [nodeId, info] of edgeNodes) {
    // vertical position: align to a connected tile's row when possible.
    let row = 0;
    const net = fabric.nets.find((n) =>
      info.side === 'in' ? fromTileId(n.from).tile === nodeId : toTileId(n.to, outTileFor).tile === nodeId,
    );
    if (net) {
      const other =
        info.side === 'in'
          ? toTileId(net.to, outTileFor).tile
          : fromTileId(net.from).tile;
      row = tileRow.get(other) ?? 0;
    }
    tiles.push({
      id: nodeId,
      type: info.side === 'in' ? 'iob_in' : 'iob_out',
      label: info.port.toLowerCase(),
      row,
      col: info.side === 'in' ? 0 : Math.max(1, fabric.grid.cols) + 1,
      isOutput: false,
    });
  }

  // explicit iob_out tiles: place them in the right margin.
  for (const t of outTileByPort.values()) {
    const net = fabric.nets.find((n) => fromTileId(n.from).tile === t.id || toTileId(n.to, outTileFor).tile === t.id);
    let row = 0;
    if (net) {
      const driver = fabric.nets.find((n) => n.to === (t.config.op ?? ''));
      if (driver) row = tileRow.get(fromTileId(driver.from).tile) ?? 0;
    }
    tiles.push({
      id: t.id,
      type: 'iob_out',
      label: (t.config.op ?? 'out').toLowerCase(),
      row,
      col: Math.max(1, fabric.grid.cols) + 1,
      isOutput: true,
    });
  }

  // ── Emit the floorplan nets. ──
  const netKind = (net: VfpgaNet, f: ReturnType<typeof fromTileId>): FloorplanNetKind => {
    if (f.isPrev) return 'feedback';
    if (f.edgePort) return iobInKind(f.edgePort);
    return 'video';
  };
  const litFor = (net: VfpgaNet, f: ReturnType<typeof fromTileId>, toTile: string): boolean => {
    if (f.isPrev) return true; // clocked recirculation is always live
    // lit if its destination is on a path to an output.
    if (reachesOut.has(toTile)) return true;
    return outDriverTiles.has(f.tile) && toTile.startsWith(EDGE_PREFIX);
  };

  for (const net of fabric.nets) {
    const f = fromTileId(net.from);
    const to = toTileId(net.to, outTileFor);
    nets.push({
      fromTile: f.tile,
      toTile: to.tile,
      kind: netKind(net, f),
      lit: litFor(net, f, to.tile),
      isPrev: f.isPrev,
    });
  }

  // grid extents: +2 cols for the left/right margins.
  const maxCol = tiles.reduce((m, t) => Math.max(m, t.col), 0);
  const maxRow = tiles.reduce((m, t) => Math.max(m, t.row), 0);

  return {
    rows: Math.max(fabric.grid.rows, maxRow + 1),
    cols: Math.max(fabric.grid.cols + 2, maxCol + 1),
    tiles,
    nets,
    hasFabric: true,
  };
}

/** A human display name + accent colour key for a tile type (the card's legend
 *  + tile fill). Generic, palette-aligned; kept here so the model + the renderer
 *  share one source. */
export const TILE_TYPE_META: Record<VfpgaTileType, { label: string; color: string }> = {
  clb: { label: 'clb', color: '#6ea8fe' },
  dsp: { label: 'dsp', color: '#f7b955' },
  bram: { label: 'bram', color: '#a78bfa' },
  reg: { label: 'reg', color: '#34d399' },
  lut16: { label: 'lut16', color: '#f472b6' },
  iob_in: { label: 'in', color: '#7a8699' },
  iob_out: { label: 'out', color: '#7a8699' },
};
