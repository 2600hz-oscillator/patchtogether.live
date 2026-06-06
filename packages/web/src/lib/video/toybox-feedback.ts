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

// ---------------- TUNNEL (mode 0) — pure reference geometry ----------------
//
// The TUNNEL feedback mode is a true recursive Droste / video-feedback tunnel (a
// camera pointed at its own monitor): each frame re-displays the PREVIOUS frame
// scaled a touch LARGER about the centre + spun, so prior content recedes INWARD
// to a vanishing point, and the live SOURCE enters ONLY at the new outer ring the
// zoom vacates — there is ZERO flat full-frame source in the interior.
//
// The GLSL that ships this (FEEDBACK_FRAG_SRC, `uMode == 0`) is the executable
// truth; these PURE functions mirror its per-pixel decision EXACTLY so the
// behaviour ("interior = recursive feedback, source only in the ring") is
// deterministically unit-testable without a GL context (SwiftShader pixel deltas
// are documented-flaky — see toybox-feedback.spec.ts). Keep the two in lock-step.

/** Where a TUNNEL output pixel reads its previous-frame tap, and whether that tap
 *  falls in the new OUTER RING (outside the previous frame). Mirrors the GLSL:
 *    d    = rot(uRotate) · (uv − 0.5)
 *    zoom = 1 / max(uZoom, 1e-3)                 // .5..1 → 2..1, always ≥ 1
 *    fuv  = 0.5 + d · zoom                        // sample further from centre
 *    ring = fuv outside [0,1]²                    // the band the zoom vacated
 *  `ring === true`  → this pixel shows the live source (the only place it enters).
 *  `ring === false` → this pixel shows the recursive feedback tap at `fuv`. */
export function tunnelTap(
  uv: readonly [number, number],
  uZoom: number,
  uRotate: number,
): { fuv: [number, number]; ring: boolean } {
  const dx0 = uv[0] - 0.5;
  const dy0 = uv[1] - 0.5;
  const s = Math.sin(uRotate);
  const c = Math.cos(uRotate);
  // mat2(c,-s,s,c) * vec2 in GLSL column-major: x' = c*x - s*y, y' = s*x + c*y.
  const dx = c * dx0 - s * dy0;
  const dy = s * dx0 + c * dy0;
  const zoom = 1 / Math.max(uZoom, 1e-3);
  const fx = 0.5 + dx * zoom;
  const fy = 0.5 + dy * zoom;
  const ring = fx < 0 || fx > 1 || fy < 0 || fy > 1;
  return { fuv: [fx, fy], ring };
}

/**
 * A small pure CPU simulation of the TUNNEL recursion on an RGB grid — exactly
 * what the GLSL ping-pong does over `frames` iterations, with BILINEAR sampling +
 * edge-clamp (matching the shader's `texture()` filtering, so recursive content
 * diffuses inward toward the vanishing point exactly as it does on the GPU).
 * Used by the unit test to prove: at the converged state, the frame INTERIOR is
 * NOT dominated by the flat source colour — the source only ever entered via the
 * thin outer ring and the interior is owned by the (decayed) recursive feedback.
 *
 * PURE: identical inputs → identical output. `src` is the flat full-frame source
 * colour; the buffer starts black.
 */
export function simulateTunnel(
  size: number,
  src: readonly [number, number, number],
  uZoom: number,
  uRotate: number,
  uDecay: number,
  frames: number,
): Float32Array {
  const n = size * size * 3;
  let prev = new Float32Array(n); // starts black
  let next = new Float32Array(n);
  const at = (buf: Float32Array, ix: number, iy: number): [number, number, number] => {
    const cx = Math.min(size - 1, Math.max(0, ix));
    const cy = Math.min(size - 1, Math.max(0, iy));
    const i = (cy * size + cx) * 3;
    return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
  };
  const sample = (buf: Float32Array, fx: number, fy: number): [number, number, number] => {
    // bilinear + clamp-to-edge (matches the shader's texture()/clamp() on the tap)
    const px = fx * (size - 1);
    const py = fy * (size - 1);
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const tx = px - x0, ty = py - y0;
    const c00 = at(buf, x0, y0), c10 = at(buf, x0 + 1, y0);
    const c01 = at(buf, x0, y0 + 1), c11 = at(buf, x0 + 1, y0 + 1);
    const out: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const a = c00[k]! * (1 - tx) + c10[k]! * tx;
      const b = c01[k]! * (1 - tx) + c11[k]! * tx;
      out[k] = a * (1 - ty) + b * ty;
    }
    return out;
  };
  for (let f = 0; f < frames; f++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const uv: [number, number] = [(x + 0.5) / size, (y + 0.5) / size];
        const { fuv, ring } = tunnelTap(uv, uZoom, uRotate);
        const o = (y * size + x) * 3;
        if (ring) {
          next[o] = src[0];
          next[o + 1] = src[1];
          next[o + 2] = src[2];
        } else {
          const t = sample(prev, fuv[0], fuv[1]);
          next[o] = t[0] * uDecay;
          next[o + 1] = t[1] * uDecay;
          next[o + 2] = t[2] * uDecay;
        }
      }
    }
    const tmp = prev;
    prev = next;
    next = tmp;
  }
  return prev;
}
