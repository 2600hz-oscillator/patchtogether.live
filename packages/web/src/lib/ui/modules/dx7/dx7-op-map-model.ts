// packages/web/src/lib/ui/modules/dx7/dx7-op-map-model.ts
//
// PURE model for the OPERATOR MAP (dx7 PR 6).
//
// The map is the algorithm diagram PLUS per-operator state, so it reuses
// `dx7GlyphGeometry` (PR 4) for the block/edge placement rather than
// re-deriving it. That reuse is the point: the face glyph, the 32-cell picker
// and this map must agree about the SHAPE of an algorithm, and they do
// because there is exactly one function that decides it.
//
// What this module adds on top is the per-operator overlay the plan calls for:
// role, on/off, resolved frequency, and an EG thumbnail — all derived, all
// testable without a browser.

import { dx7AlgorithmLayout } from '$lib/audio/dx7-algorithm-layout';
import { dx7OpRoles, type Dx7OpRoleKind } from '$lib/audio/dx7-op-role';
import { dx7EgCurve } from '$lib/audio/dx7-eg-curve';
import { resolveOpCoarseFine } from '$lib/audio/dx7-voice-edit';
import { dx7GlyphGeometry, type Dx7GlyphEdge, type Dx7GlyphFeedback } from './dx7-glyph-model';

/** Layout units the map draws in — bigger than the glyph's, since each block
 *  now carries a number, a frequency readout and an EG thumbnail. */
export const MAP_COL_PITCH = 46;
export const MAP_ROW_PITCH = 40;
export const MAP_BLOCK_W = 38;
export const MAP_BLOCK_H = 30;

/** One operator tile on the map. */
export interface Dx7MapBlock {
  /** 0..5 (op1 = 0). */
  op: number;
  x: number;
  y: number;
  w: number;
  h: number;
  role: Dx7OpRoleKind;
  /** Row 0 — lands on the carrier rail. */
  carrier: boolean;
  /** `false` → the tile dims; the operator is muted. */
  on: boolean;
  /** `×3.06` or `FIX 220 Hz`, ready to print. */
  freqLabel: string;
  /** Output level byte 0..99. */
  level: number;
  /** Normalised EG thumbnail points, x and y both already in 0..1. */
  egThumb: { x: number; y: number }[];
}

export interface Dx7MapGeometry {
  num: number;
  viewBox: string;
  width: number;
  height: number;
  blocks: Dx7MapBlock[];
  edges: Dx7GlyphEdge[];
  feedback: Dx7GlyphFeedback | undefined;
  /**
   * The CARRIER RAIL — a horizontal line under the bottom row that every
   * carrier drops onto, making the output sum literal.
   *
   * ⚠ This is the DEUTERANOPIA DEFENCE, not decoration. Role is also carried
   * by colour (warm / cool / purple), and colour alone is exactly the cue a
   * red-green colourblind player cannot read. The rail is geometry, so it
   * survives any palette — lead with it, treat colour as reinforcement.
   */
  rail: { y: number; x1: number; x2: number; drops: { op: number; x: number }[] };
}

/** An operator's resolved frequency, as the map prints it. */
export function dx7FreqLabel(op: unknown): string {
  const cf = resolveOpCoarseFine(op as never);
  const o = (op ?? {}) as { fixedMode?: boolean; fixedHz?: number; ratio?: number };
  if (o.fixedMode) {
    const hz = typeof o.fixedHz === 'number' && Number.isFinite(o.fixedHz) ? o.fixedHz : 0;
    // Whole Hz below 100, one decimal above — the DX7's own display habit.
    return `FIX ${hz >= 100 ? Math.round(hz) : hz.toFixed(hz < 10 ? 2 : 1)} Hz`;
  }
  const ratio = typeof o.ratio === 'number' && Number.isFinite(o.ratio) ? o.ratio : 1;
  void cf;
  return `×${ratio.toFixed(2)}`;
}

/**
 * Build the full operator-map geometry for `num`, overlaid with the voice's
 * per-operator state.
 *
 * `opOn` may be short or missing (every rack saved before PR 5 has no `opOn`
 * at all) — a missing entry reads as ON, never as muted. Returns `undefined`
 * only for an unusable algorithm number, so a bad stored value cannot take the
 * panel down.
 */
export function dx7MapGeometry(
  num: number,
  operators: readonly unknown[] | undefined,
  opOn: readonly boolean[] | undefined,
): Dx7MapGeometry | undefined {
  const layout = dx7AlgorithmLayout(num);
  if (!layout) return undefined;

  // Reuse the glyph's placement, rescaled to the map's larger pitch.
  const glyph = dx7GlyphGeometry(layout);
  const sx = MAP_COL_PITCH / 14;
  const sy = MAP_ROW_PITCH / 14;

  const roles = dx7OpRoles(num) ?? [];
  const roleOf = (op: number): Dx7OpRoleKind =>
    roles.find((r) => r.op === op)?.role ?? 'modulator';

  const blocks: Dx7MapBlock[] = glyph.blocks.map((b) => {
    const opData = operators?.[b.op];
    const o = (opData ?? {}) as { l?: number[]; r?: number[]; level?: number };
    // ⚠ OUTPUT LEVEL is `op.level`, NOT `l[3]`. `l[3]` is EG LEVEL 4 — the
    // idle/release level, which is 0 for virtually every real voice. Reading
    // it as the output level scales every thumbnail to zero and the whole map
    // draws six flat lines. (Did exactly that; the level-scaling test caught
    // it because both the loud and quiet fixtures collapsed to peak 0.)
    const level = clampByte(o.level ?? 99);
    const curve = dx7EgCurve(o.r ?? [], o.l ?? [], level);
    const maxX = curve.points.length ? Math.max(...curve.points.map((p) => p.x), 1e-6) : 1;
    return {
      op: b.op,
      x: b.x * sx,
      y: b.y * sy,
      w: MAP_BLOCK_W,
      h: MAP_BLOCK_H,
      role: roleOf(b.op),
      carrier: b.carrier,
      // A SHORT/absent `opOn` means "not muted" — see the doc comment.
      on: opOn?.[b.op] ?? true,
      freqLabel: dx7FreqLabel(opData),
      level,
      egThumb: curve.points.map((p) => ({ x: p.x / maxX, y: p.y })),
    };
  });

  const width = glyph.width * sx;
  const height = glyph.height * sy + 10; // room under the bottom row for the rail

  const edges: Dx7GlyphEdge[] = glyph.edges.map((e) => ({
    from: e.from,
    to: e.to,
    x1: e.x1 * sx,
    y1: e.y1 * sy,
    x2: e.x2 * sx,
    y2: e.y2 * sy,
  }));

  const carriers = blocks.filter((b) => b.carrier);
  const railY = Math.max(...blocks.map((b) => b.y + b.h)) + 6;
  const rail = {
    y: railY,
    x1: Math.min(...carriers.map((b) => b.x)) - 4,
    x2: Math.max(...carriers.map((b) => b.x + b.w)) + 4,
    drops: carriers.map((b) => ({ op: b.op, x: b.x + b.w / 2 })),
  };

  return {
    num,
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    blocks,
    edges,
    feedback: glyph.feedback
      ? { ...glyph.feedback, d: scalePath(glyph.feedback.d, sx, sy) }
      : undefined,
    rail,
  };
}

const clampByte = (v: number) => Math.max(0, Math.min(99, Math.round(Number(v) || 0)));

/** Scale the feedback path's coordinates. The glyph emits only `M/q/H/V` with
 *  plain numbers, so a token-wise scale is exact — no path parser needed. */
function scalePath(d: string, sx: number, sy: number): string {
  const out: string[] = [];
  const tokens = d.split(/\s+/);
  let cmd = '';
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      out.push(t);
      i++;
      continue;
    }
    if (cmd === 'H') {
      out.push(String(Number(t) * sx));
      i++;
    } else if (cmd === 'V') {
      out.push(String(Number(t) * sy));
      i++;
    } else {
      // M and q take (x, y) pairs.
      out.push(String(Number(t) * sx));
      if (i + 1 < tokens.length) out.push(String(Number(tokens[i + 1]) * sy));
      i += 2;
    }
  }
  return out.join(' ');
}
