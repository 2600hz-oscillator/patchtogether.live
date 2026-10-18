// PHASES: the editor and the worklet share this geometry and transport model.
// Vertex coordinates stay normalized when duration, polarity or direction
// changes. An outgoing phase's shape belongs to its LEFT vertex, so deleting
// an interior vertex naturally retains the original left phase's shape.

import { GATE_HI } from '../../../web/src/lib/audio/gate-trigger';

export interface PhasesVertex {
  x: number;
  y: number;
  shape: number;
}

export const PHASES_MAX_PHASES = 24;
export const PHASES_LENGTH_MIN = 0.05;
export const PHASES_LENGTH_MAX = 30;
export const PHASES_LENGTH_DEFAULT = PHASES_LENGTH_MIN;
export const PHASES_DEFAULT_VERTICES: readonly PhasesVertex[] = Object.freeze([
  Object.freeze({ x: 0, y: 0, shape: 0 }),
  Object.freeze({ x: 1, y: 0, shape: 0 }),
]);

// Keeps duplicate vertices from creating a zero-width phase. This is much
// smaller than a faceplate pixel; it does not impose a visible timing grid.
const VERTEX_EPSILON = 1e-7;
// Repeated sample increments can miss an exact boundary by a few ulps.
const POSITION_EPSILON = 1e-12;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, finite(value, 0)));
}

/** Normalize saved/posted data once, outside the per-sample audio loop. */
export function sanitizePhasesVertices(raw: unknown): PhasesVertex[] {
  if (!Array.isArray(raw)) return PHASES_DEFAULT_VERTICES.map((v) => ({ ...v }));

  const sorted: PhasesVertex[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Partial<PhasesVertex>;
    if (typeof v.x !== 'number' || !Number.isFinite(v.x)) continue;
    sorted.push({ x: clamp01(v.x), y: clamp01(finite(v.y, 0)), shape: clamp01(finite(v.shape, 0)) });
  }
  sorted.sort((a, b) => a.x - b.x);

  const vertices: PhasesVertex[] = [];
  for (const v of sorted) {
    if (vertices.length === 0 || v.x - vertices[vertices.length - 1]!.x > VERTEX_EPSILON) {
      vertices.push(v);
    }
  }
  if (vertices.length === 0) return PHASES_DEFAULT_VERTICES.map((v) => ({ ...v }));

  if (vertices[0]!.x > VERTEX_EPSILON) vertices.unshift({ x: 0, y: vertices[0]!.y, shape: 0 });
  else vertices[0]!.x = 0;
  const last = vertices[vertices.length - 1]!;
  if (last.x < 1 - VERTEX_EPSILON) vertices.push({ x: 1, y: last.y, shape: 0 });
  else last.x = 1;

  if (vertices.length > PHASES_MAX_PHASES + 1) {
    vertices.splice(PHASES_MAX_PHASES, vertices.length - PHASES_MAX_PHASES - 1);
  }
  return vertices;
}

/**
 * A bounded, monotone quadratic family: 0 is linear, noon is concave, full
 * turn is convex. The second half crosses linear again at 0.75 as its
 * curvature changes sign. Falling phases use the same progress curve.
 */
export function evaluatePhasesShape(progress: number, shape: number): number {
  const t = clamp01(progress);
  const s = clamp01(shape);
  const curvature = s <= 0.5 ? 2 * s : 3 - 4 * s;
  return t + curvature * t * (1 - t);
}

/** At a vertex, the current phase is the one entered in playback direction. */
export function getPhasesPhaseIndex(
  vertices: readonly PhasesVertex[],
  position: number,
  reverse = false,
): number {
  if (vertices.length < 2) return 0;
  const p = clamp01(position);
  let low = 0;
  let high = vertices.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    const past = reverse ? p > vertices[mid]!.x + POSITION_EPSILON : p >= vertices[mid]!.x - POSITION_EPSILON;
    if (past) low = mid;
    else high = mid;
  }
  return Math.min(vertices.length - 2, low);
}

/** Evaluate canonical vertices; callers normalize edited/saved data first. */
export function evaluatePhasesEnvelope(vertices: readonly PhasesVertex[], position: number): number {
  if (vertices.length === 0) return 0;
  if (vertices.length === 1) return vertices[0]!.y;
  const i = getPhasesPhaseIndex(vertices, position);
  const left = vertices[i]!;
  const right = vertices[i + 1]!;
  const progress = (clamp01(position) - left.x) / (right.x - left.x);
  return left.y + (right.y - left.y) * evaluatePhasesShape(progress, left.shape);
}

/** Insert on the curve at the clicked x; newly added outgoing phases are linear. */
export function insertPhasesVertex(raw: unknown, position: number): PhasesVertex[] {
  const vertices = sanitizePhasesVertices(raw);
  const x = clamp01(position);
  if (vertices.length >= PHASES_MAX_PHASES + 1 || vertices.some((v) => Math.abs(v.x - x) <= VERTEX_EPSILON)) {
    return vertices;
  }
  const i = getPhasesPhaseIndex(vertices, x);
  vertices.splice(i + 1, 0, { x, y: evaluatePhasesEnvelope(vertices, x), shape: 0 });
  return vertices;
}

/** Endpoints are permanent. Removing i merges its phases with the LEFT shape. */
export function deletePhasesVertex(raw: unknown, index: number): PhasesVertex[] {
  const vertices = sanitizePhasesVertices(raw);
  if (Number.isInteger(index) && index > 0 && index < vertices.length - 1) vertices.splice(index, 1);
  return vertices;
}

export function phasesLengthFromCv(value: number): number {
  return PHASES_LENGTH_MIN + clamp01(value) * (PHASES_LENGTH_MAX - PHASES_LENGTH_MIN);
}

/** One sample at a time; no allocations occur in step(). */
export class PhasesDSP {
  private vertices_: PhasesVertex[];
  private readonly sampleDuration: number;
  private length = PHASES_LENGTH_DEFAULT;
  private triggerHigh = false;
  private phaseTriggerHigh = false;
  private loopHigh = false;
  private reverseHigh = false;
  private manualTrigger = false;
  private manualPhaseTrigger = false;

  position = 0;
  playing = false;
  loop = false;
  reverse = false;
  polarity = false;
  effectiveLength = PHASES_LENGTH_DEFAULT;
  lengthCvPatched = false;

  constructor(rate: number, vertices: unknown = PHASES_DEFAULT_VERTICES) {
    this.sampleDuration = 1 / Math.max(1, finite(rate, 48000));
    this.vertices_ = sanitizePhasesVertices(vertices);
  }

  get vertices(): readonly PhasesVertex[] { return this.vertices_; }

  setVertices(vertices: unknown): void { this.vertices_ = sanitizePhasesVertices(vertices); }

  setLength(seconds: number): void {
    this.length = Math.max(PHASES_LENGTH_MIN, Math.min(PHASES_LENGTH_MAX, finite(seconds, PHASES_LENGTH_DEFAULT)));
    if (!this.lengthCvPatched) this.effectiveLength = this.length;
  }

  setReverse(enabled: boolean): void { this.reverse = enabled; }
  setPolarity(bipolar: boolean): void { this.polarity = bipolar; }

  setLoop(enabled: boolean): void {
    const wasLooping = this.loop;
    this.loop = enabled;
    if (enabled && !wasLooping && !this.playing) {
      // Enabling Loop is enough to audition a cycling envelope. A completed
      // one-shot enters at the opposite boundary; a stopped interior position
      // (if provided by a host) continues without relocation.
      if (this.reverse ? this.position <= POSITION_EPSILON : this.position >= 1 - POSITION_EPSILON) {
        this.position = this.reverse ? 1 : 0;
      }
      this.playing = true;
    }
  }

  trigger(): void {
    this.position = this.reverse ? 1 : 0;
    this.playing = true;
  }

  triggerPhase(): void {
    const i = getPhasesPhaseIndex(this.vertices_, this.position, this.reverse);
    this.position = this.vertices_[this.reverse ? i + 1 : i]!.x;
    this.playing = true;
  }

  /** Queue manual intent independently of held gate levels, for the next sample. */
  requestTrigger(phaseOnly = false): void {
    if (phaseOnly) this.manualPhaseTrigger = true;
    else this.manualTrigger = true;
  }

  get value(): number {
    const normalized = evaluatePhasesEnvelope(this.vertices_, this.position);
    return this.polarity ? normalized * 2 - 1 : normalized;
  }

  step(trigger = 0, phaseTrigger = 0, loopGate = 0, reverseGate = 0, lengthCv?: number): number {
    const triggerHigh = trigger >= GATE_HI;
    const phaseTriggerHigh = phaseTrigger >= GATE_HI;
    const loopHigh = loopGate >= GATE_HI;
    const reverseHigh = reverseGate >= GATE_HI;

    // Resolve direction and mode before trigger position. A simultaneous
    // reverse edge + full trigger therefore starts at the right boundary.
    if (reverseHigh && !this.reverseHigh) this.setReverse(!this.reverse);
    if (loopHigh && !this.loopHigh) this.setLoop(!this.loop);
    if (this.manualTrigger || (triggerHigh && !this.triggerHigh)) this.trigger();
    else if (this.manualPhaseTrigger || (phaseTriggerHigh && !this.phaseTriggerHigh)) this.triggerPhase();
    this.manualTrigger = false;
    this.manualPhaseTrigger = false;
    this.triggerHigh = triggerHigh;
    this.phaseTriggerHigh = phaseTriggerHigh;
    this.loopHigh = loopHigh;
    this.reverseHigh = reverseHigh;

    this.lengthCvPatched = lengthCv !== undefined;
    this.effectiveLength = this.lengthCvPatched ? phasesLengthFromCv(lengthCv!) : this.length;
    const output = this.value;
    if (!this.playing) return output;

    // Integrate normalized position; changing Length changes only velocity,
    // never reinterprets elapsed time or relocates the playhead.
    const step = this.sampleDuration / this.effectiveLength;
    let next = this.position + (this.reverse ? -step : step);
    if (!this.reverse && next >= 1 - POSITION_EPSILON) {
      if (Math.abs(next - 1) <= POSITION_EPSILON) next = 1;
      this.position = this.loop ? next % 1 : 1;
      if (!this.loop) this.playing = false;
    } else if (this.reverse && next <= POSITION_EPSILON) {
      if (Math.abs(next) <= POSITION_EPSILON) next = 0;
      this.position = this.loop ? 1 - ((-next) % 1) : 0;
      if (!this.loop) this.playing = false;
    } else {
      this.position = next;
    }
    return output;
  }
}
