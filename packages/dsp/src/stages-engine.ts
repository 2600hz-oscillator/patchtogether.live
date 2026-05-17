// packages/dsp/src/stages-engine.ts
//
// Pure-math engine for STAGES (Mutable Instruments Stages archetype, MIT-
// licensed). Imported by both the AudioWorklet wrapper (packages/dsp/src/
// stages.ts) and the host-side module def + tests (packages/web/src/lib/
// audio/modules/stages.ts) so the math is bit-identical across the two
// surfaces. Keep this file FREE of AudioWorkletGlobalScope references
// (no `sampleRate`, no `registerProcessor`, no `AudioWorkletProcessor`)
// — the worklet wrapper passes sample rate explicitly to the constructor.

export const STAGES_NUM_SEGMENTS = 6;
export const STAGES_NUM_LINKS = STAGES_NUM_SEGMENTS - 1; // 5

// Segment types — keep in sync with the module def + card.
export const TYPE_RAMP = 0;
export const TYPE_HOLD = 1;
export const TYPE_STEP = 2;
export const STAGES_NUM_TYPES = 3;

export const TRIG_THRESHOLD = 0.5;

/**
 * Tides-style phase-warp curve from segment_generator.cc::WarpPhase.
 * Maps a linear phase t∈[0,1] through a sigmoid-ish curve controlled by
 * `curve`∈[0,1] (0.5 = linear, <0.5 = log-like fast attack, >0.5 = exp-like
 * slow attack). Faithful to the original C++.
 */
export function warpPhase(t: number, curve: number): number {
  let c = curve - 0.5;
  const flip = c < 0;
  if (flip) {
    t = 1 - t;
    c = -c;
  }
  const a = 128 * c * c;
  let out = (1 + a) * t / (1 + a * t);
  if (flip) out = 1 - out;
  return out;
}

/**
 * Map a TIME knob value [0,1] to a seconds-per-segment value (log scale).
 * Range: 1ms → 10s, log-mapped so the knob's lower half is sub-second.
 */
export function timeKnobToSeconds(knob: number): number {
  const k = Math.max(0, Math.min(1, knob));
  return 0.001 * Math.pow(10000, k);
}

/**
 * Compute the chain group membership for a segments-array given the link
 * bits. Returns an array of length N where entry i is the index of the
 * leader (first segment) of i's chain group. A chain group of one (no
 * adjacent link bits) returns [i] for that segment.
 *
 * Example: links = [false, true, true, false, false]
 *   segments 0       1-2-3 chain        4       5
 *   leaders  [0, 1, 1, 1, 4, 5]
 */
export function computeChainLeaders(links: readonly boolean[]): number[] {
  const leaders = new Array<number>(STAGES_NUM_SEGMENTS);
  let leader = 0;
  for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
    if (i === 0 || !links[i - 1]) leader = i;
    leaders[i] = leader;
  }
  return leaders;
}

/**
 * Per-chain-group state.
 */
export class ChainGroupState {
  leader = 0;
  /** Active segment within the group (absolute index, not relative). */
  active = 0;
  /** Phase within the active segment, 0..1. */
  phase = 0;
  /** Current output value of the chain. */
  value = 0;
  /** Value at start of the active segment — used as RAMP start. */
  prevEnd = 0;
  /** True while a trigger is propagating through the chain. */
  running = false;
  /** Tracks the rising-edge state of this chain's leader gate. */
  lastGate = 0;

  reset(leader: number): void {
    this.leader = leader;
    this.active = leader;
    this.phase = 0;
    this.value = 0;
    this.prevEnd = 0;
    this.running = false;
    this.lastGate = 0;
  }
}

export interface SegmentParams {
  type: number;     // 0=RAMP, 1=HOLD, 2=STEP
  primary: number;  // TIME (RAMP) or LEVEL (HOLD/STEP)
  shape: number;    // SHAPE knob 0..1
}

/**
 * Pure-math STAGES engine. Holds 6 segment params, link bits, chain
 * group state, and per-segment last output.
 */
export class StagesEngine {
  segments: SegmentParams[];
  links: boolean[];
  groups: ChainGroupState[];
  /** Per-segment last output value (what the CV output sees). */
  outValues: Float32Array;
  /** Per-segment gate edge tracking. */
  lastGateLevel: Float32Array;
  /** Global TRIG edge tracking. */
  lastGlobalTrig = 0;
  sr: number;

  constructor(sr: number) {
    this.sr = sr;
    this.segments = new Array(STAGES_NUM_SEGMENTS);
    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      this.segments[i] = { type: TYPE_RAMP, primary: 0.3, shape: 0.5 };
    }
    this.links = new Array(STAGES_NUM_LINKS).fill(false);
    this.groups = [];
    this.outValues = new Float32Array(STAGES_NUM_SEGMENTS);
    this.lastGateLevel = new Float32Array(STAGES_NUM_SEGMENTS);
    this.rebuildGroups();
  }

  /** Recompute chain group membership from the current links array. */
  rebuildGroups(): void {
    const leaders = computeChainLeaders(this.links);
    const seen = new Set<number>();
    const uniqueLeaders: number[] = [];
    for (const l of leaders) {
      if (!seen.has(l)) {
        seen.add(l);
        uniqueLeaders.push(l);
      }
    }
    const newGroups: ChainGroupState[] = [];
    for (const leader of uniqueLeaders) {
      const existing = this.groups.find((g) => g.leader === leader);
      if (existing) {
        newGroups.push(existing);
      } else {
        const g = new ChainGroupState();
        g.reset(leader);
        newGroups.push(g);
      }
    }
    this.groups = newGroups;
  }

  setSegmentType(i: number, type: number): void {
    if (i < 0 || i >= STAGES_NUM_SEGMENTS) return;
    const t = Math.max(0, Math.min(STAGES_NUM_TYPES - 1, Math.round(type)));
    this.segments[i]!.type = t;
  }

  setSegmentPrimary(i: number, v: number): void {
    if (i < 0 || i >= STAGES_NUM_SEGMENTS) return;
    this.segments[i]!.primary = Math.max(-1, Math.min(1, v));
  }

  setSegmentShape(i: number, v: number): void {
    if (i < 0 || i >= STAGES_NUM_SEGMENTS) return;
    this.segments[i]!.shape = Math.max(0, Math.min(1, v));
  }

  setLink(i: number, v: boolean): void {
    if (i < 0 || i >= STAGES_NUM_LINKS) return;
    if (this.links[i] === v) return;
    this.links[i] = v;
    this.rebuildGroups();
  }

  /** Find the chain group containing segment index `seg`. */
  private groupForSegment(seg: number): ChainGroupState {
    const leaders = computeChainLeaders(this.links);
    const leader = leaders[seg]!;
    return this.groups.find((g) => g.leader === leader) ?? this.groups[0]!;
  }

  /** Find the last segment in the chain group with the given leader. */
  private lastSegmentOfGroup(leader: number): number {
    let last = leader;
    while (last + 1 < STAGES_NUM_SEGMENTS && this.links[last]) last++;
    return last;
  }

  /** Fire (trigger) a chain group as if its leader's gate just rose. */
  trigger(leader: number): void {
    const group = this.groups.find((g) => g.leader === leader);
    if (!group) return;
    group.active = leader;
    group.phase = 0;
    group.prevEnd = group.value;
    group.running = true;
    if (this.segments[leader]!.type === TYPE_STEP) {
      group.value = this.segments[leader]!.primary;
    }
  }

  /**
   * Advance one sample. `gateLevels` is per-segment gate input (length=6),
   * `globalTrig` is the global TRIG input level. Returns the per-segment
   * CV output array (length=6).
   */
  tick(gateLevels: Float32Array | number[], globalTrig: number): Float32Array {
    const globalRising = this.lastGlobalTrig < TRIG_THRESHOLD && globalTrig >= TRIG_THRESHOLD;
    this.lastGlobalTrig = globalTrig;

    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      const lvl = (gateLevels as Float32Array)[i] ?? 0;
      const rising = this.lastGateLevel[i]! < TRIG_THRESHOLD && lvl >= TRIG_THRESHOLD;
      this.lastGateLevel[i] = lvl;
      if (rising) {
        const group = this.groupForSegment(i);
        if (group.leader === i) this.trigger(i);
      }
    }
    if (globalRising) {
      for (const g of this.groups) this.trigger(g.leader);
    }

    for (const group of this.groups) {
      this.advanceGroup(group);
    }

    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      const group = this.groupForSegment(i);
      this.outValues[i] = group.value;
    }
    return this.outValues;
  }

  private advanceGroup(group: ChainGroupState): void {
    const seg = this.segments[group.active]!;
    if (seg.type === TYPE_RAMP) {
      if (!group.running) return;
      const seconds = timeKnobToSeconds(Math.max(0, seg.primary));
      const dPhase = 1 / Math.max(1, seconds * this.sr);
      group.phase += dPhase;
      if (group.phase >= 1) {
        group.phase = 1;
        // Land on end target before advancing — so the final sample
        // reflects the ramp's actual endpoint (avoid value freezing one
        // sample short of target, which throws unit tests).
        const target = this.ramTarget(group);
        const start = group.prevEnd;
        const t = warpPhase(1, seg.shape);
        group.value = start + (target - start) * t;
        this.advanceToNextSegment(group);
        return;
      }
      const target = this.ramTarget(group);
      const start = group.prevEnd;
      const t = warpPhase(group.phase, seg.shape);
      group.value = start + (target - start) * t;
    } else if (seg.type === TYPE_HOLD) {
      const target = seg.primary;
      const portCoef = 1 - Math.exp(-1 / Math.max(1, (0.001 + seg.shape * 0.5) * this.sr));
      group.value += (target - group.value) * portCoef;
      group.prevEnd = target;
    } else if (seg.type === TYPE_STEP) {
      const target = group.value;
      const portCoef = 1 - Math.exp(-1 / Math.max(1, (0.001 + seg.shape * 0.5) * this.sr));
      group.value += (target - group.value) * portCoef;
      if (group.running) {
        this.advanceToNextSegment(group);
      }
    }
  }

  /** RAMP end target: next segment's LEVEL if HOLD/STEP, else 1.0. */
  private ramTarget(group: ChainGroupState): number {
    const lastInGroup = this.lastSegmentOfGroup(group.leader);
    if (group.active >= lastInGroup) return 1.0;
    const next = this.segments[group.active + 1]!;
    if (next.type === TYPE_HOLD || next.type === TYPE_STEP) {
      return next.primary;
    }
    return 1.0;
  }

  /** Hand off to next segment in this chain group, or terminate. */
  private advanceToNextSegment(group: ChainGroupState): void {
    const lastInGroup = this.lastSegmentOfGroup(group.leader);
    if (group.active >= lastInGroup) {
      group.running = false;
      group.phase = 0;
      return;
    }
    group.prevEnd = group.value;
    group.active++;
    group.phase = 0;
    const newSeg = this.segments[group.active]!;
    if (newSeg.type === TYPE_STEP) {
      group.value = newSeg.primary;
    }
  }
}
