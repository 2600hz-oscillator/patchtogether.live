// packages/web/src/lib/video/toybox-feedback.ts
//
// TOYBOX FEEDBACK node — the PURE model for the first STATEFUL combine node.
//
// Every other combine node (fade/lumakey/chromakey/map) is a STATELESS RGBA8
// blend: out = f(base, top). FEEDBACK is different — it samples its OWN PREVIOUS
// FRAME (a per-node ping-pong float buffer the engine keeps) plus the single
// upstream input, and writes a new frame that becomes next frame's previous.
// That makes it a 1-input node (`in0` only — the "second input" is the internal
// loop) running 12 selectable FEEDBACK MODES (zoom tunnels, trails, blur smoke,
// reaction-diffusion, …). The card edits a discrete `mode` param + the superset
// of per-mode floats; #611 auto-renders the floats as knobs + makes every param
// a CV target, so this file only owns the MODE LIST + the pure param→uniform
// mapping (which the engine's feedback program uploads each frame).
//
// This file is PURE (no Yjs, no GL, no DOM): the mode catalogue + clamp/derive
// math. The shader (FEEDBACK_FRAG_SRC) + ping-pong buffers + reconcile live in
// modules/toybox.ts; the data-model (kind/op unions, OP_PARAMS['feedback'],
// inPortsFor) lives in toybox-combine-graph.ts. Unit-tested in
// toybox-feedback.test.ts.

/** A feedback mode: a stable numeric id (the `uMode` the shader switches on, and
 *  the value stored in the node's `mode` param) + a human label for the card's
 *  <select>. The ORDER is the id order (0..11); never reorder (it is persisted). */
export interface FeedbackModeDef {
  id: number;
  label: string;
}

/**
 * The 12 feedback modes, in id order (id === array index). The id is what the
 * shader's `uMode` switch + the persisted `mode` param carry, so this list is
 * APPEND-ONLY (reordering would silently remap saved patches).
 *
 *  0  TUNNEL   — Droste / infinite zoom tunnel (recursive frames, spiral).
 *  1  GEOMETRIC— scale + rotate + translate the loop each frame (kaleido drift).
 *  2  SLIT     — slit-scan: left half holds the loop, right half shows input.
 *  3  ADDITIVE — prev*decay + input*gain (glowing motion trails).
 *  4  DIFF     — abs(input − prev) (edge / motion ghosts).
 *  5  BLUR     — 4-tap blur of the loop * decay (smoke / diffusion).
 *  6  EDGE     — horizontal gradient of the loop, fed back (growing line webs).
 *  7  COLOR    — hue-rotate the loop (channel cycling).
 *  8  DISPLACE — self-displacement by the loop's RG (liquid / turbulence).
 *  9  REACTION — logistic reaction-diffusion of a blurred channel (cells/spots).
 * 10  LUMAGATE — keep only bright structure (luma-key persistence).
 * 11  VECTOR   — LZX-style flow-field advection driven by the input's RG.
 */
export const FEEDBACK_MODES: readonly FeedbackModeDef[] = [
  { id: 0, label: 'TUNNEL' },
  { id: 1, label: 'GEOMETRIC' },
  { id: 2, label: 'SLIT' },
  { id: 3, label: 'ADDITIVE' },
  { id: 4, label: 'DIFF' },
  { id: 5, label: 'BLUR' },
  { id: 6, label: 'EDGE' },
  { id: 7, label: 'COLOR' },
  { id: 8, label: 'DISPLACE' },
  { id: 9, label: 'REACTION' },
  { id: 10, label: 'LUMAGATE' },
  { id: 11, label: 'VECTOR' },
];

/** Number of feedback modes (the discrete `mode` param range is 0..COUNT-1). */
export const FEEDBACK_MODE_COUNT = FEEDBACK_MODES.length;

/** Clamp + round an arbitrary stored `mode` value to a valid mode id (0..11).
 *  Tolerates floats / out-of-range / NaN from a CV write or a corrupt save. */
export function clampFeedbackMode(mode: unknown): number {
  const m = typeof mode === 'number' && Number.isFinite(mode) ? Math.round(mode) : 0;
  return m < 0 ? 0 : m >= FEEDBACK_MODE_COUNT ? FEEDBACK_MODE_COUNT - 1 : m;
}

/** A mode def by id (clamped), for the card's <select> current-value label. */
export function feedbackModeById(id: number): FeedbackModeDef {
  return FEEDBACK_MODES[clampFeedbackMode(id)]!;
}

function clamp(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return n < min ? min : n > max ? max : n;
}

/**
 * The float uniforms the FEEDBACK program reads, derived (clamped) from a node's
 * raw `params`. Mirrors OP_PARAMS['feedback'] ranges/defaults EXACTLY so a CV
 * write (which is already range-mapped) and a manual knob land identically, and
 * a corrupt/absent param degrades to the schema default. The engine uploads
 * these straight to uZoom/uRotate/… each frame; keeping the clamp here (not in
 * GLSL) means it's unit-testable.
 */
export interface FeedbackUniforms {
  mode: number;
  zoom: number;
  rotate: number;
  scaleP: number;
  tx: number;
  ty: number;
  decay: number;
  gain: number;
  thresh: number;
  hue: number;
  blur: number;
  slitPos: number;
  slitWidth: number;
  flow: number;
}

/**
 * Map a feedback node's raw `params` Record to the clamped uniform set the
 * shader reads. PURE: defaults fill missing keys, every value is clamped to its
 * OP_PARAMS range, and `mode` is rounded to a valid id. Identical inputs →
 * identical output.
 */
export function feedbackUniforms(params: Record<string, number> | undefined | null): FeedbackUniforms {
  const p = params && typeof params === 'object' ? params : {};
  return {
    mode: clampFeedbackMode(p.mode),
    zoom: clamp(p.zoom, 0.5, 1, 0.95),
    rotate: clamp(p.rotate, -Math.PI, Math.PI, 0),
    scaleP: clamp(p.scaleP, 0.5, 1.5, 1),
    tx: clamp(p.tx, -1, 1, 0),
    ty: clamp(p.ty, -1, 1, 0),
    decay: clamp(p.decay, 0, 1.5, 0.9),
    gain: clamp(p.gain, 0, 2, 1),
    thresh: clamp(p.thresh, 0, 1, 0.5),
    hue: clamp(p.hue, 0, 1, 0),
    blur: clamp(p.blur, 0, 4, 1),
    slitPos: clamp(p.slitPos, 0, 1, 0.5),
    slitWidth: clamp(p.slitWidth, 0, 1, 0.1),
    flow: clamp(p.flow, 0, 1, 0),
  };
}

/**
 * The pure decision behind the "Reset feedback" menu action: the card bumps a
 * monotonically-increasing `_reset` token in the node's params; the engine keeps
 * the last token it saw per ping-pong buffer and clears both float textures to
 * black on the frame the token changes. This extracts that diff so it is
 * deterministically unit-testable (the GL clear itself can only be exercised in
 * e2e/VRT, but the *decision* — "did the token change, what is the new token" —
 * is the part that actually carries the reset, and it is pure).
 *
 * `_reset` is read tolerantly: absent / NaN / non-number → treated as token 0
 * (matches a fresh node that has never been reset). Returns whether to arm a
 * clear this frame plus the token to remember.
 */
export function feedbackResetState(
  prevToken: number,
  params: Record<string, number> | undefined | null,
): { clear: boolean; token: number } {
  const raw = params && typeof params === 'object' ? (params as Record<string, unknown>)._reset : undefined;
  const token = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return { clear: token !== prevToken, token };
}

/**
 * Which float params each feedback MODE actually uses, in display order (the
 * `mode` discrete selector is handled separately; these are the knobs). The
 * "Configure feedback" popover renders ONLY the relevant subset for the active
 * mode so it stays focused (the full per-node knob strip still exposes every
 * param when the node is selected). `decay` is the loop's persistence and is
 * relevant to every recursive mode, so it appears for all.
 *
 * Param ids MUST exist in OP_PARAMS['feedback']; the unit test asserts that.
 */
export const FEEDBACK_MODE_PARAMS: Readonly<Record<number, readonly string[]>> = {
  0: ['zoom', 'rotate', 'decay'], // TUNNEL — Droste zoom + spin + persistence
  1: ['scaleP', 'rotate', 'tx', 'ty', 'decay'], // GEOMETRIC — affine drift
  2: ['slitPos', 'slitWidth', 'decay'], // SLIT — slit-scan window
  3: ['decay', 'gain'], // ADDITIVE — glowing trails
  4: ['gain', 'decay'], // DIFF — motion ghosts
  5: ['blur', 'decay'], // BLUR — smoke / diffusion
  6: ['gain', 'decay'], // EDGE — growing line webs
  7: ['hue', 'decay'], // COLOR — channel cycling
  8: ['flow', 'decay'], // DISPLACE — liquid self-displacement
  9: ['gain', 'thresh', 'decay'], // REACTION — reaction-diffusion
  10: ['thresh', 'decay'], // LUMAGATE — bright-structure persistence
  11: ['flow', 'rotate', 'decay'], // VECTOR — LZX flow-field advection
};

/** The relevant float-param ids for a feedback mode (clamped to a valid mode).
 *  Falls back to a sensible core set if a mode is somehow unmapped. */
export function feedbackParamsForMode(mode: unknown): readonly string[] {
  return FEEDBACK_MODE_PARAMS[clampFeedbackMode(mode)] ?? ['decay'];
}
