// LINNSTRUMENT RUNTIME — the module's ONGOING behaviour, in the factory and
// nowhere else, so it runs with NO face mounted (module-surfaces: ongoing
// behaviour belongs in the module factory/runtime; a dock close changes
// nothing here).
//
//   source registry ─▶ RuntimeEvent ─┬─▶ selection reducer (WP-A) ─▶ six CVs
//                                   │                              ─▶ param commits
//                                   │                              ─▶ LED ack
//                                   │                              ─▶ D15 mirroring
//                                   └─▶ mpe-state (keys | pad)  ─▶ two poly buses
//                                                                ─▶ expression lanes
//   scheduler clock ──▶ two arp adapters ─▶ the same two buses
//
// ONE REDUCER FOR EVERY ORIGIN. Hardware edges, the DOM pads, the ranked
// cells and patch hydration all go through `reduceControls`
// (records/ui-specification.md:18 — displayed selection, CV and LEDs cannot
// disagree). The face never writes a CV; it dispatches an intent.
//
// THE WRITE-STORM RULE (cv-modulation-live-store-write-storm). A pointer
// sample lands on the ConstantSources IMMEDIATELY (transient engine writes,
// zero Y.Doc) and reaches `node.params` through per-param `createCcCommit`
// pumps on the shared `getCcBatcher()` — coalesced durable commits, and the
// gesture end FLUSHES so the final value is what persists (joystick #1963
// "1 - persist": hold on release, no snap-back).
//
// WHAT THE PARAMS MEAN AT THIS LAYER. `sel_*` and `pos_*` are the persisted
// half of the reducer state (`persistedSelection`): hydrated on construction,
// written back on every accepted change, and re-applied through `setParam`
// when a knob cell, a MIDI CC, a collaborator or a reload moves them.
// `keys_root` / `pad_root` re-derive each touch's note from its LOCAL cell
// (`keyboardCellToMidi`, D09), so the module's own roots win over whatever
// profile the device layer mapped with — and the SAME roots, with `scale`,
// are published to the source (`publishLinnstrumentLighting`) so the keys /
// pad LEDs are lit from what the runtime plays, never from the device's
// profile (WP-C open item 3c). The arp params feed the two adapters.
//
// ⚠ NO EXPRESSION JACKS (D14 is a graph-wide `polyCv` change the owner has
// not ruled on): per-lane velocity / pressure / timbre / bend are kept here
// ALIGNED to the allocator lanes and exposed through `read(node,'card-api')
// .expression(region)` so a test can assert alignment — the STATE half of
// the package's V15 ("observer control": pressure → level at a jack); its
// audible half stays deferred on D14.
//
// TIMESTAMPS. `RuntimeEvent.time` is read as PERFORMANCE SECONDS
// (`MIDIMessageEvent.timeStamp / 1000` — the device layer's default domain,
// `linnstrumentTimeDomain() === 'performance'`) and projected once through
// `createMidiScheduler` — the shared 25 ms lookahead; a stamp from another
// clock domain re-anchors at now + lookahead (midi-timing.ts
// MAX_TIMESTAMP_LAG_MS), so a synthetic corpus time never schedules into the
// far future. `deps.projectTime` swaps the projection — the integration that
// installs the audio clock on the device layer (`setLinnstrumentAudioClock`)
// passes the identity, since the stamp is then already audio time.
//
// ⚠ Plain `.ts`, no runes. The graph-store reads (targets, TIMELORDE bpm)
// follow cv-buddy.ts, and every seam is injectable so the unit test drives
// the whole runtime with no browser.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { ModuleNode } from '$lib/graph/types';
import { patch as livePatch } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import { createPolySender, POLY_CHANNEL_PAIRS, type PolySender } from '$lib/audio/poly';
import { midiToVOct } from '$lib/audio/note-entry';
import { keyboardCellToMidi } from '$lib/audio/modules/keyboard-map';
import { SCALE_NAMES } from '$lib/audio/modules/clip-types';
import type { ScaleName } from '$lib/mike/music-theory';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createMidiScheduler, type MidiScheduler } from '$lib/audio/midi-timing';
import { createCcCommit, type CcCommit } from '$lib/ui/controls/cc-commit';
import { getCcBatcher } from '$lib/ui/controls/cc-batch-store';
import type { CcBatcher } from '$lib/ui/controls/cc-commit-batch';
import { deliverCcToGraph } from '$lib/midi/graph-param-dispatch';
import {
  activeVoices,
  applyTouch,
  createMpeState,
  panicMpe,
  resetMpe,
  type MpeEvent,
  type MpeState,
  type MpeVoice,
} from '$lib/midi/mpe-state';
import { DEFAULT_LINN_PROFILE } from '$lib/midi/linnstrument/profile';
import {
  createSelectionState,
  intentsFromRuntimeEvent,
  persistedSelection,
  reduceControls,
} from '$lib/midi/linnstrument/selection-reducer';
import {
  getLinnstrumentSource,
  linnstrumentSessionSnapshot,
  publishLinnstrumentLighting,
  publishLinnstrumentSelection,
  subscribeLinnstrumentEvents,
} from '$lib/midi/linnstrument/source-registry';
import {
  SELECTORS,
  type ControlIntent,
  type LinnLighting,
  type LinnProfile,
  type MusicalRegion,
  type ReducerEffect,
  type RuntimeEvent,
  type SelectionState,
  type SelectorId,
  type SessionEvent,
  type SurfaceEvent,
} from '$lib/midi/linnstrument/types';
import { arpDirectionFromIndex, createLinnArp, type ArpExpression, type LinnArpSnapshot, type LinnArpWithSink } from './linnstrument-arp';

// ── Param / port vocabulary (the def spells these as literals; the runtime
//    and the face derive from these so the three cannot drift) ──────────────

export type Axis = 'x' | 'y';
export const LINN_REGIONS: readonly MusicalRegion[] = ['keys', 'pad'];

export const selectorParamId = (s: SelectorId): string => `sel_${s}`;
export const positionParamId = (s: SelectorId, axis: Axis): string => `pos_${s}_${axis}`;
export const cvPortId = (s: SelectorId, axis: Axis): string => `${s}_${axis}`;
export const polyPortId = (r: MusicalRegion): string => `${r}_poly`;
export const rootParamId = (r: MusicalRegion): string => `${r}_root`;
export type ArpParamKey = 'on' | 'dir' | 'div' | 'range' | 'latch';
export const arpParamId = (r: MusicalRegion, k: ArpParamKey): string => `${r}_arp_${k}`;
export const EXTRA_CONTROLS_PARAM = 'extra_controls';
export const JOIN_POLICY_PARAM = 'join_policy';
/** The LIGHTING scale (D09 owner ruling: scale affects lighting, not
 *  playability). Option 0 = chromatic (the tree's ABSENT scale: only the
 *  roots are landmarks), then `SCALE_NAMES` in the KEYS-view order. */
export const SCALE_PARAM = 'scale';
export const LINN_SCALE_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'chromatic' },
  ...SCALE_NAMES.map((name, i) => ({ value: i + 1, label: name })),
];
export function scaleFromParam(v: unknown): ScaleName | undefined {
  const i = Math.round(num(v, 0));
  return i >= 1 && i <= SCALE_NAMES.length ? SCALE_NAMES[i - 1] : undefined;
}

/** Root range: 0..96 keeps every derived note inside MIDI on both regions
 *  (keys: root + 15 + 35 ≤ 127 needs root ≤ 77; anything higher simply drops
 *  the out-of-range cells, exactly as the surface map does). */
export const LINN_ROOT_MIN = 0;
export const LINN_ROOT_MAX = 96;

/** `node.data.targets` — D15 joystick mirroring, OPT-IN and default unbound. */
export interface LinnTargets {
  r?: string;
  g?: string;
  b?: string;
}

// ── Card-api ──────────────────────────────────────────────────────────────

export interface LaneExpression {
  lane: number;
  /** The voice generation id owning this lane, or null when free. */
  voice: number | null;
  note: number | null;
  gate: 0 | 1;
  velocity: number;
  pressure: number;
  timbre: number;
  bend: number;
  /** Pitch CV the bus carries for this lane — (note − 60 + bend) / 12. */
  pitchCv: number;
  /** For an arp-generated note: the touch whose expression it carries. */
  owner: number | null;
}

export interface LinnstrumentCounters {
  events: number;
  rejected: number;
  steals: number;
}

export interface LinnstrumentSnapshot {
  session: SessionEvent;
  source: { id: string; kind: string } | null;
  selection: SelectionState;
  /** What the keys / pad LEDs are lit from: this node's roots and scale. */
  lighting: LinnLighting;
  active: Record<MusicalRegion, number>;
  arp: Record<MusicalRegion, LinnArpSnapshot>;
  counters: LinnstrumentCounters;
}

export interface LinnstrumentCardApi {
  /** Gesture-gated bind through the registered connector (WP-B's device
   *  layer registers it). Resolves false when nothing is registered. */
  connect(): Promise<boolean>;
  /** THE one door for the face: pads, Center and Panic dispatch intents. */
  dispatch(intent: ControlIntent): void;
  selection(): SelectionState;
  state(): LinnstrumentSnapshot;
  expression(region: MusicalRegion): readonly LaneExpression[];
  /** Change notifications for a mounted body; returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** Force every staged param commit to land now (gesture end, tests). */
  flush(): void;
}

// ── The connector seam ────────────────────────────────────────────────────
//
// `connect` is a USER GESTURE (Web MIDI consent) and the device layer owns it;
// this runtime must never call it on its own (trails-device.ts:9-24 rule). The
// device layer registers its `connectLinnstrument` here; until it does the
// cell reports `delivered: false` through the action seam rather than lying.

type Connector = () => Promise<boolean>;
let connector: Connector | null = null;

export function setLinnstrumentConnector(fn: Connector | null): void {
  connector = fn;
}
export function linnstrumentConnector(): Connector | null {
  return connector;
}

// ── Injectable seams ──────────────────────────────────────────────────────

export interface LinnstrumentRuntimeDeps {
  /** Durable param write. Default: `setNodeParam` on the live graph. */
  commitParam?: (nodeId: string, paramId: string, value: number) => void;
  /** `node.data.targets` read live from the graph (deletion-safe: a missing
   *  node or key is simply unbound). */
  readTargets?: (nodeId: string) => LinnTargets;
  /** The mirroring write. Default: `deliverCcToGraph`. */
  deliverCc?: (nodeId: string, paramId: string, cc: number) => boolean;
  /** TIMELORDE bpm. Default: read the transport node off the live graph. */
  bpm?: () => number;
  /** Tick source. Default: the shared scheduler clock. */
  clock?: { subscribe(fn: () => void): () => void };
  nowMs?: () => number;
  /** The shared CC batcher; pass `null` to use the pump's private timers. */
  batcher?: CcBatcher | null;
  /** `RuntimeEvent.time` → audio time. Default: performance seconds through
   *  the MIDI scheduler; pass the identity when the stamps are audio time. */
  projectTime?: (time: number) => number;
  lookaheadS?: number;
}

const clampRange = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clampBipolar = (v: number): number => (Number.isFinite(v) ? clampRange(v, -1, 1) : 0);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function timelordeBpm(): number {
  for (const n of Object.values(livePatch.nodes)) {
    if (n && (n as { type?: string }).type === 'timelorde') {
      const b = (n as { params?: Record<string, number> }).params?.bpm;
      return typeof b === 'number' && b > 0 ? b : 120;
    }
  }
  return 120;
}

function liveTargets(nodeId: string): LinnTargets {
  const node = livePatch.nodes[nodeId] as { data?: { targets?: unknown } } | undefined;
  const t = node?.data?.targets;
  if (!t || typeof t !== 'object') return {};
  const out: LinnTargets = {};
  for (const s of SELECTORS) {
    const v = (t as Record<string, unknown>)[s];
    if (typeof v === 'string' && v) out[s] = v;
  }
  return out;
}

/** Bipolar −1..1 → the 7-bit value `deliverCcToGraph` scales against the
 *  target's own −1..1 range (joystick.ts:74-78). */
export const bipolarToCc = (v: number): number => Math.round(((clampBipolar(v) + 1) / 2) * 127);

interface RegionRuntime {
  region: MusicalRegion;
  mpe: MpeState;
  sender: PolySender;
  arp: LinnArpWithSink;
  lanes: LaneExpression[];
  /** Touch id → note, for the arp's provenance and re-assertion. */
  held: Map<number, number>;
}

function freshLane(lane: number): LaneExpression {
  return { lane, voice: null, note: null, gate: 0, velocity: 0, pressure: 0, timbre: 0.5, bend: 0, pitchCv: 0, owner: null };
}

/**
 * Build the runtime for one `linnstrument` node. Returns the engine handle.
 */
export async function createLinnstrumentRuntime(
  ctx: AudioContext,
  node: ModuleNode,
  deps: LinnstrumentRuntimeDeps = {},
): Promise<AudioDomainNodeHandle> {
  const nodeId = node.id;
  const params: Record<string, number> = { ...(node.params ?? {}) };
  const commitParam = deps.commitParam ?? ((id, pid, v) => setNodeParam(id, pid, v));
  const readTargets = deps.readTargets ?? liveTargets;
  const deliverCc = deps.deliverCc ?? deliverCcToGraph;
  const bpm = deps.bpm ?? timelordeBpm;
  const clock = deps.clock ?? getSchedulerClock();
  const nowMs = deps.nowMs ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const batcher = deps.batcher === undefined ? getCcBatcher() : deps.batcher;
  const scheduler: MidiScheduler = createMidiScheduler(ctx, { nowMs, lookaheadS: deps.lookaheadS });
  const projectTime = deps.projectTime ?? ((time: number) => scheduler.schedAt(time * 1000));

  // ── Profile: the package defaults, with this node's switches applied ──
  function buildProfile(): LinnProfile {
    return {
      ...DEFAULT_LINN_PROFILE,
      keysRoot: Math.round(num(params[rootParamId('keys')], DEFAULT_LINN_PROFILE.keysRoot)),
      padRoot: Math.round(num(params[rootParamId('pad')], DEFAULT_LINN_PROFILE.padRoot)),
      extraControlsEnabled: num(params[EXTRA_CONTROLS_PARAM], 1) >= 0.5,
      selectionJoin: num(params[JOIN_POLICY_PARAM], 0) >= 0.5 ? 'soft_takeover' : 'next_coherent_xy_sample',
    };
  }
  let profile = buildProfile();
  /** The lighting the source paints keys / pad with — THIS node's roots and
   *  scale, re-published whenever they change (and on every session, so a
   *  re-bound device is lit from the module, not the profile). */
  function lighting(): LinnLighting {
    return { keysRoot: profile.keysRoot, padRoot: profile.padRoot, scale: scaleFromParam(params[SCALE_PARAM]) };
  }
  publishLinnstrumentLighting(lighting());

  // ── Selection state, hydrated from the persisted params ──
  let selection: SelectionState = createSelectionState(profile);
  {
    const hydrate: ControlIntent = {
      kind: 'hydrate',
      mask: Object.fromEntries(SELECTORS.map((s) => [s, num(params[selectorParamId(s)], profile.defaultMask[s] ? 1 : 0) >= 0.5])) as Record<SelectorId, boolean>,
      pairs: Object.fromEntries(SELECTORS.map((s) => [s, { x: clampBipolar(num(params[positionParamId(s, 'x')], 0)), y: clampBipolar(num(params[positionParamId(s, 'y')], 0)) }])) as Record<SelectorId, { x: number; y: number }>,
    };
    selection = reduceControls(selection, hydrate, profile).state;
  }

  // ── Six ConstantSources: one per retained coordinate ──
  const cvSources = new Map<string, ConstantSourceNode>();
  for (const s of SELECTORS) {
    for (const axis of ['x', 'y'] as const) {
      const c = ctx.createConstantSource();
      c.offset.value = selection.pairs[s][axis];
      c.start();
      cvSources.set(cvPortId(s, axis), c);
    }
  }

  // ── Observers (a mounted body) ──
  const listeners = new Set<() => void>();
  function notify(): void {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[linnstrument] listener threw', err);
      }
    }
  }

  // ── Two poly buses, two MPE states, two arps ──
  const regions: Record<MusicalRegion, RegionRuntime> = {
    keys: makeRegion('keys'),
    pad: makeRegion('pad'),
  };
  function makeRegion(region: MusicalRegion): RegionRuntime {
    const sender = createPolySender(ctx);
    const arp = createLinnArp({ lookaheadS: deps.lookaheadS });
    arp.attach(sender);
    const lanes: LaneExpression[] = [];
    for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) lanes.push(freshLane(i));
    return {
      region,
      mpe: createMpeState({ lanes: profile.lanesPerRegion, epoch: selection.epoch }),
      sender,
      arp,
      lanes,
      held: new Map(),
    };
  }
  function applyArpParams(region: MusicalRegion): void {
    const r = regions[region];
    r.arp.setParams({
      direction: arpDirectionFromIndex(params[arpParamId(region, 'dir')]),
      divisionIndex: num(params[arpParamId(region, 'div')], 3),
      octaveRangeIndex: num(params[arpParamId(region, 'range')], 0),
      latch: num(params[arpParamId(region, 'latch')], 0) >= 0.5,
    });
    const on = num(params[arpParamId(region, 'on')], 0) >= 0.5;
    if (on !== r.arp.enabled) {
      r.arp.setEnabled(on);
      const now = ctx.currentTime;
      if (on) {
        // The arp owns the bus now: drop the direct voice writes.
        takeBus(r, now);
        for (const lane of r.lanes) lane.gate = 0;
      } else {
        // Hand the bus back: re-assert what is physically held.
        takeBus(r, now);
        reassertVoices(r);
      }
      notify();
    }
  }
  for (const region of LINN_REGIONS) applyArpParams(region);

  // ── Per-param commit pumps (the write-storm rule) ──
  const pumps = new Map<string, CcCommit>();
  function pumpFor(paramId: string): CcCommit {
    let p = pumps.get(paramId);
    if (p) return p;
    p = createCcCommit({
      commit: (v) => commitParam(nodeId, paramId, v),
      lane: 'undoable',
      batcher: batcher ?? undefined,
    });
    pumps.set(paramId, p);
    return p;
  }
  function flushAll(): void {
    for (const p of pumps.values()) p.flush();
  }

  const counters: LinnstrumentCounters = { events: 0, rejected: 0, steals: 0 };
  let session: SessionEvent = linnstrumentSessionSnapshot();
  let disposed = false;

  // ── Reducer output → CVs, params, LEDs, mirroring ──
  function writePairs(prev: SelectionState, next: SelectionState, gestureEnd: boolean): void {
    const now = ctx.currentTime;
    const targets = readTargets(nodeId);
    for (const s of SELECTORS) {
      const p = prev.pairs[s];
      const n = next.pairs[s];
      const moved = p.x !== n.x || p.y !== n.y;
      if (moved) {
        cvSources.get(cvPortId(s, 'x'))!.offset.setValueAtTime(n.x, now);
        cvSources.get(cvPortId(s, 'y'))!.offset.setValueAtTime(n.y, now);
        params[positionParamId(s, 'x')] = n.x;
        params[positionParamId(s, 'y')] = n.y;
        pumpFor(positionParamId(s, 'x')).push(n.x);
        pumpFor(positionParamId(s, 'y')).push(n.y);
        // D15 (RECOMMENDATION, opt-in): mirror into a bound joystick's pos_x/pos_y.
        const target = targets[s];
        if (target) {
          deliverCc(target, 'pos_x', bipolarToCc(n.x));
          deliverCc(target, 'pos_y', bipolarToCc(n.y));
        }
      }
      if (prev.mask[s] !== next.mask[s]) {
        params[selectorParamId(s)] = next.mask[s] ? 1 : 0;
        pumpFor(selectorParamId(s)).push(next.mask[s] ? 1 : 0);
      }
    }
    if (gestureEnd) flushAll();
  }

  function runEffects(effects: readonly ReducerEffect[]): void {
    for (const e of effects) {
      if (e.kind === 'panic') panic();
      else if (e.kind === 'extra_control') extraControl(e.control);
    }
  }

  function dispatch(intent: ControlIntent): void {
    if (disposed) return;
    const prev = selection;
    const r = reduceControls(prev, intent, profile);
    const gestureEnd = intent.kind === 'pointer' && intent.phase === 'up';
    if (r.state !== prev) {
      selection = r.state;
      writePairs(prev, selection, gestureEnd);
      publishLinnstrumentSelection(selection);
    } else if (gestureEnd) {
      flushAll();
    }
    runEffects(r.effects);
    if (r.state !== prev || r.effects.length) notify();
  }

  function panic(): void {
    const now = ctx.currentTime;
    for (const region of LINN_REGIONS) {
      const r = regions[region];
      // The arp FORGETS — touches, provenance and the latched set — before the
      // voices end, so a finger that is still down (or a pool a lifted finger
      // left latched) has nothing the next tick can restart (F01: `cancel`
      // kept the pool; with every finger released `panicMpe` had no voice to
      // end and the latched note came back one tick later).
      r.arp.reset(now);
      for (const ev of panicMpe(r.mpe, now)) applyVoiceEvent(r, ev);
      takeBus(r, now);
      for (const lane of r.lanes) lane.gate = 0;
    }
    // XY, selection and the pointer are RETAINED (ui-specification.md:20).
  }

  /** D17 RECOMMENDATION — the lower five control cells. `panic` is routed by
   *  the reducer as its own effect; the other four land here. */
  function extraControl(control: 'keyboard_arp' | 'keyboard_hold' | 'octave_down' | 'octave_up'): void {
    if (control === 'keyboard_arp') {
      const id = arpParamId('keys', 'on');
      setParam(id, num(params[id], 0) >= 0.5 ? 0 : 1, true);
    } else if (control === 'keyboard_hold') {
      const id = arpParamId('keys', 'latch');
      setParam(id, num(params[id], 0) >= 0.5 ? 0 : 1, true);
    } else {
      const id = rootParamId('keys');
      const next = clampRange(num(params[id], DEFAULT_LINN_PROFILE.keysRoot) + (control === 'octave_up' ? 12 : -12), LINN_ROOT_MIN, LINN_ROOT_MAX);
      setParam(id, next, true);
    }
  }

  // ── Voices → lanes ──
  function laneOf(r: RegionRuntime, v: MpeVoice): LaneExpression {
    return r.lanes[v.lane] ?? (r.lanes[v.lane] = freshLane(v.lane));
  }
  function applyVoiceEvent(r: RegionRuntime, ev: MpeEvent, at: number = ctx.currentTime): void {
    const v = ev.voice;
    const lane = laneOf(r, v);
    if (ev.kind === 'voice_start') {
      Object.assign(lane, { voice: v.id, note: v.note, velocity: v.velocity, pressure: v.pressure, timbre: v.timbre, bend: v.bend, pitchCv: midiToVOct(v.note + v.bend), owner: null });
      lane.gate = 1;
      if (!r.arp.enabled) writeLane(r, v.lane, lane.pitchCv, 1, at);
      r.arp.touchStart(v.id, v.note, { velocity: v.velocity, pressure: v.pressure, timbre: v.timbre, bend: v.bend });
      return;
    }
    if (ev.kind === 'voice_expression') {
      if (lane.voice !== v.id) return; // stale: this lane was stolen (V10)
      lane.pressure = v.pressure;
      lane.timbre = v.timbre;
      lane.bend = v.bend;
      lane.pitchCv = midiToVOct(v.note + v.bend);
      if (!r.arp.enabled) writeLane(r, v.lane, lane.pitchCv, null, at);
      r.arp.touchExpression(v.id, { pressure: v.pressure, timbre: v.timbre, bend: v.bend });
      return;
    }
    // voice_end — only the CURRENT owner of the lane may close it.
    r.arp.touchEnd(v.id);
    if (lane.voice !== v.id) return;
    lane.gate = 0;
    lane.voice = null;
    lane.owner = null;
    if (!r.arp.enabled) writeLane(r, v.lane, null, 0, at);
  }
  function writeLane(r: RegionRuntime, lane: number, pitch: number | null, gate: 0 | 1 | null, at: number): void {
    const slot = r.sender.voices[lane];
    if (!slot) return;
    if (pitch !== null) slot.pitchSrc.offset.setValueAtTime(pitch, at);
    if (gate !== null) slot.gateSrc.offset.setValueAtTime(gate, at);
  }
  /**
   * THE BUS CHANGES OWNER (arp on, arp off, PANIC, a session reset): every
   * event the previous owner queued past `now` — PITCH as well as gate — is
   * dropped and the gates close now. `PolySender.silence` cancels gates only,
   * which is what every sequencer wants of it and stays untouched; here a
   * step the arp scheduled inside the lookahead would otherwise survive the
   * handover and retune the voice the direct path re-asserts a moment later
   * (F05: ARP off at 1.500 s left the arp's E2 at 1.525 s on lane 0 and the
   * restored C2 became E2).
   */
  function takeBus(r: RegionRuntime, now: number): void {
    for (const slot of r.sender.voices) {
      slot.pitchSrc.offset.cancelScheduledValues(now);
      slot.gateSrc.offset.cancelScheduledValues(now);
      slot.gateSrc.offset.setValueAtTime(0, now);
    }
  }
  function reassertVoices(r: RegionRuntime): void {
    const now = ctx.currentTime;
    for (const v of activeVoices(r.mpe)) {
      const lane = laneOf(r, v);
      lane.gate = 1;
      writeLane(r, v.lane, midiToVOct(v.note + v.bend), 1, now);
    }
  }

  /** Re-derive a touch's note from ITS cell with this node's root (D09 via
   *  the tree's keyboardCellToMidi) — the module's root, not the device's. */
  function withModuleRoot(ev: SurfaceEvent & { kind: 'touch_start' }): (SurfaceEvent & { kind: 'touch_start' }) | null {
    const root = ev.region === 'keys' ? profile.keysRoot : profile.padRoot;
    const note = keyboardCellToMidi(ev.localCol, ev.localRow, root, profile.semisPerCol, profile.semisPerRow);
    if (note < 0 || note > 127) return null;
    return { ...ev, note };
  }

  function onRuntimeEvent(event: RuntimeEvent): void {
    if (disposed) return;
    counters.events++;
    if (event.kind === 'session') {
      session = event;
      const now = ctx.currentTime;
      for (const region of LINN_REGIONS) {
        const r = regions[region];
        for (const ev of resetMpe(r.mpe, now)) applyVoiceEvent(r, ev, now);
        r.mpe.epoch = event.epoch;
        r.arp.reset(now);
        takeBus(r, now);
        for (const lane of r.lanes) Object.assign(lane, freshLane(lane.lane));
      }
      dispatch({ kind: 'session', epoch: event.epoch });
      publishLinnstrumentLighting(lighting());
      notify();
      return;
    }
    if (event.kind === 'pointer' || event.kind === 'control_edge') {
      // `profile` gates the hardware PANIC cell with the other four (D17).
      for (const intent of intentsFromRuntimeEvent(event, profile)) dispatch(intent);
      return;
    }
    const r = regions[event.region];
    const at = projectTime(event.time);
    const stealsBefore = r.mpe.counters.steals;
    const rejectedBefore = r.mpe.counters.rejected;
    let surface: SurfaceEvent = event;
    if (event.kind === 'touch_start') {
      const rooted = withModuleRoot(event);
      if (!rooted) return; // off the keyboard: no voice (surface-map's rule)
      surface = rooted;
    }
    const events = applyTouch(r.mpe, surface);
    counters.steals += r.mpe.counters.steals - stealsBefore;
    counters.rejected += r.mpe.counters.rejected - rejectedBefore;
    if (surface.kind === 'touch_start') r.held.set(surface.touch, surface.note);
    if (surface.kind === 'touch_end') r.held.delete(surface.touch);
    for (const ev of events) applyVoiceEvent(r, ev, at);
    if (events.length) notify();
  }

  const unsubscribeSource = subscribeLinnstrumentEvents(onRuntimeEvent);

  // ── Arp transport on the shared tick ──
  const unsubscribeTick = clock.subscribe(() => {
    if (disposed) return;
    const input = { nowMs: nowMs(), audioTime: ctx.currentTime, bpm: bpm() };
    for (const region of LINN_REGIONS) {
      const r = regions[region];
      if (!r.arp.enabled) continue;
      const played = r.arp.service(input);
      if (!played.length) continue;
      const last = played[played.length - 1]!;
      const lane = r.lanes[0]!;
      Object.assign(lane, {
        voice: last.owner,
        note: last.note,
        gate: 1 as const,
        velocity: last.expression.velocity,
        pressure: last.expression.pressure,
        timbre: last.expression.timbre,
        bend: last.expression.bend,
        pitchCv: midiToVOct(last.note + last.expression.bend),
        owner: last.owner,
      });
      notify();
    }
  });

  // ── Params from the graph (knob cell, CC, collaborator, reload) ──
  function setParam(paramId: string, value: number, fromRuntime = false): void {
    if (!Number.isFinite(value)) return;
    for (const s of SELECTORS) {
      if (paramId === selectorParamId(s)) {
        params[paramId] = value >= 0.5 ? 1 : 0;
        dispatch({ kind: 'set_selector', selector: s, on: value >= 0.5 });
        return;
      }
      for (const axis of ['x', 'y'] as const) {
        if (paramId !== positionParamId(s, axis)) continue;
        const v = clampBipolar(value);
        // While a live pointer drives a SELECTED pair the gesture owns it and a
        // coalesced store echo must not drag the CV back (the pad's `dragging`
        // guard, one layer down).
        if (selection.pointer.touch !== null && selection.mask[s]) return;
        params[paramId] = v;
        const cur = selection.pairs[s];
        dispatch({ kind: 'set_pair', selector: s, x: axis === 'x' ? v : cur.x, y: axis === 'y' ? v : cur.y });
        return;
      }
    }
    params[paramId] = value;
    if (fromRuntime) pumpFor(paramId).push(value);
    if (paramId === rootParamId('keys') || paramId === rootParamId('pad') || paramId === EXTRA_CONTROLS_PARAM || paramId === JOIN_POLICY_PARAM) {
      profile = buildProfile();
      publishLinnstrumentLighting(lighting());
      notify();
      return;
    }
    if (paramId === SCALE_PARAM) {
      publishLinnstrumentLighting(lighting());
      notify();
      return;
    }
    for (const region of LINN_REGIONS) {
      if (paramId.startsWith(`${region}_arp_`)) {
        applyArpParams(region);
        notify();
        return;
      }
    }
  }

  function expression(region: MusicalRegion): readonly LaneExpression[] {
    return regions[region].lanes.map((l) => ({ ...l }));
  }

  function snapshot(): LinnstrumentSnapshot {
    const src = getLinnstrumentSource();
    return {
      session,
      source: src ? { id: src.id, kind: src.kind } : null,
      selection,
      lighting: lighting(),
      active: { keys: regions.keys.mpe.voices.size, pad: regions.pad.mpe.voices.size },
      arp: { keys: regions.keys.arp.snapshot(), pad: regions.pad.arp.snapshot() },
      counters: { ...counters },
    };
  }

  const cardApi: LinnstrumentCardApi = {
    connect: () => (connector ? connector() : Promise.resolve(false)),
    dispatch,
    selection: () => selection,
    state: snapshot,
    expression,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    flush: flushAll,
  };

  return {
    domain: 'audio',
    inputs: new Map(),
    // `{ node, output }`, never a bare AudioNode (the trails lesson).
    outputs: new Map<string, { node: AudioNode; output: number }>([
      ...[...cvSources.entries()].map(([id, src]) => [id, { node: src as AudioNode, output: 0 }] as const),
      ...LINN_REGIONS.map((r) => [polyPortId(r), { node: regions[r].sender.output as AudioNode, output: 0 }] as const),
    ]),
    setParam(paramId, value) {
      setParam(paramId, value);
    },
    readParam(paramId) {
      return params[paramId];
    },
    read(key) {
      if (key === 'card-api') return cardApi;
      if (key === 'state') return snapshot();
      if (key === 'persisted') return persistedSelection(selection);
      return undefined;
    },
    dispose() {
      disposed = true;
      unsubscribeSource();
      unsubscribeTick();
      listeners.clear();
      for (const p of pumps.values()) p.dispose();
      pumps.clear();
      for (const region of LINN_REGIONS) {
        regions[region].arp.attach(null);
        regions[region].sender.dispose();
      }
      for (const src of cvSources.values()) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        src.disconnect();
      }
      cvSources.clear();
    },
  };
}
