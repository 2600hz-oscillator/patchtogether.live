// packages/web/src/lib/video/toybox-history.ts
//
// TOYBOX FRAME-HISTORY ops — the PURE model for the STATEFUL batch op nodes that
// keep frame history (FRAMEDELAY / CHANNELDESYNC / FLOWSMEAR / DREAMMELT /
// DATAMOSH). Like FEEDBACK these run their OWN program against a per-node buffer,
// but instead of a single 1-deep ping-pong some of them read a DELAYED tap out
// of an N-frame ring (framedelay/channeldesync). This file owns ONLY the
// param→uniform clamp math + the reset-token decision (reused from the feedback
// model's pattern). The shader (HISTORY_FRAG_SRC) + the ring buffer + the
// reconcile/dispose lifecycle live in modules/toybox.ts; the data model
// (kind/op unions, OP_PARAMS, inPortsFor, opHistoryDepth) lives in
// toybox-combine-graph.ts. Unit-tested in toybox-history.test.ts.
//
// NOTE: the GLSL itself can only be exercised in e2e/VRT (jsdom can't render);
// the clamp math here is the deterministically unit-testable part — identical
// inputs → identical uniforms, every value clamped to its OP_PARAMS range so a
// CV write and a manual knob land identically (the same discipline as
// feedbackUniforms).

import { MAX_HISTORY_FRAMES, type ToyboxOpKind } from './toybox-combine-graph';

function clamp(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return n < min ? min : n > max ? max : n;
}

/** Round + clamp a frame-delay param to a valid ring tap (0..MAX_HISTORY_FRAMES-1). */
export function clampDelay(v: unknown, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
  return n < 0 ? 0 : n >= MAX_HISTORY_FRAMES ? MAX_HISTORY_FRAMES - 1 : n;
}

/** The clamped uniform set each history op's program reads, derived from a node's
 *  raw params. Only the fields relevant to the op's kind are meaningful; the rest
 *  carry harmless defaults (the shader branches on the op index). */
export interface HistoryUniforms {
  // shared shader op selector (mirrors OP_SHADER_INDEX ordering of HISTORY_OP_KINDS)
  op: number;
  // framedelay
  delay: number;
  mix: number;
  // channeldesync
  rDelay: number;
  gDelay: number;
  bDelay: number;
  offsetMag: number;
  // flowsmear
  flowStrength: number;
  noiseScale: number;
  persistence: number;
  // dreammelt
  meltAmount: number;
  dripSpeed: number;
  threshold: number;
  // datamosh
  flowScale: number;
  holdGate: number;
  decay: number;
}

/** The shader's `uOp` index per history op kind (the HISTORY_FRAG_SRC switch). */
export const HISTORY_OP_INDEX: Record<string, number> = {
  framedelay: 0,
  channeldesync: 1,
  flowsmear: 2,
  dreammelt: 3,
  datamosh: 4,
};

/**
 * Map a history op node's raw `params` to the clamped uniform set the shader
 * reads. PURE: defaults fill missing keys, every value clamped to its OP_PARAMS
 * range, delays rounded to valid ring taps. Identical inputs → identical output.
 */
export function historyUniforms(
  kind: ToyboxOpKind | string,
  params: Record<string, number> | undefined | null,
): HistoryUniforms {
  const p = params && typeof params === 'object' ? params : {};
  return {
    op: HISTORY_OP_INDEX[kind] ?? 0,
    // Defaults MUST match OP_PARAMS (toybox-combine-graph.ts) so a node with no
    // explicit params renders the same as a freshly-added one. The M2d "visible
    // out of the box" defaults (framedelay mix<1, stronger datamosh) live here too.
    delay: clampDelay(p.delay, 12),
    mix: clamp(p.mix, 0, 1, 0.7),
    rDelay: clampDelay(p.rDelay, 0),
    gDelay: clampDelay(p.gDelay, 6),
    bDelay: clampDelay(p.bDelay, 12),
    offsetMag: clamp(p.offsetMag, 0, 1, 0.05),
    flowStrength: clamp(p.flowStrength, 0, 1, 0.5),
    noiseScale: clamp(p.noiseScale, 0.5, 8, 3),
    persistence: clamp(p.persistence, 0, 1, 0.85),
    meltAmount: clamp(p.meltAmount, 0, 1, 0.5),
    dripSpeed: clamp(p.dripSpeed, 0, 1, 0.3),
    threshold: clamp(p.threshold, 0, 1, 0.5),
    flowScale: clamp(p.flowScale, 0, 1, 0.8),
    holdGate: clamp(p.holdGate, 0, 1, 0.3),
    decay: clamp(p.decay, 0, 1, 0.95),
  };
}

/**
 * The pure decision behind a "Reset history" action: the card bumps a
 * monotonically-increasing `_reset` token in the node's params; the engine keeps
 * the last token it saw per buffer and clears the ring on the frame the token
 * changes. Identical contract to feedbackResetState (shared so a generic "Reset
 * history" menu item can drive any stateful op). Absent / NaN → token 0.
 */
export function historyResetState(
  prevToken: number,
  params: Record<string, number> | undefined | null,
): { clear: boolean; token: number } {
  const raw = params && typeof params === 'object' ? (params as Record<string, unknown>)._reset : undefined;
  const token = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return { clear: token !== prevToken, token };
}
