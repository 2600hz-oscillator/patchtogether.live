// packages/web/src/lib/audio/modules/clipplayer.ts
//
// CLIP PLAYER (v2) — an Ableton-Session-style clip launcher with 8 INSTRUMENT
// LANES. Rows = instruments (8), columns = clip slots (8) → 64 note clips. Each
// lane independently plays its launched clip out its OWN pitch/gate/velocity
// outputs, so up to 8 clips sound at once (one per instrument). A monome grid
// drives it (lib/grid) and the card is the always-available editor + launcher.
//
// Clock: LOCKED TO TIMELORDE (the rack transport). The module runs only while
// TIMELORDE.running, at TIMELORDE.bpm, and freezes when it stops — no internal
// BPM, no clock-input cable. A STEP-division param sets steps-per-beat. (See
// the plan doc §10 + clip-types.ts.)
//
// Inputs:  stop_all (gate) — rising edge stops every lane.
// Outputs: pitch1..8 (polyPitchGate) / gate1..8 / vel1..8 — one set per lane.
// Params:  stepDiv (1/4..1/32), octave, gateLength, quantize (launch snap).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { createPolySender, POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createEdgeCounter } from '$lib/audio/edge-detect';
import { isInputPortConnected } from './transport-helpers';
import {
  readClip,
  lanesForStep,
  clipIndex,
  CLIP_LANES,
  CLIP_COUNT,
  type ClipPlayerData,
} from './clip-types';

/** steps-per-beat for each stepDiv index (0=1/4 … 3=1/32). */
const STEP_DIV_SPB = [1, 2, 4, 8] as const;

export const clipplayerDef: AudioModuleDef = {
  type: 'clipplayer',
  palette: { top: 'Audio modules', sub: 'sequencers' },
  domain: 'audio',
  label: 'clip player',
  category: 'modulation',
  schemaVersion: 2,
  // 8×8 clip grid (capped) + Deluge note editor + transport — fits a 3u tile.
  size: '3u',
  hp: 2,

  // v1 (schemaVersion 1) stored single playing/queued strings + single
  // pitch/gate/velocity. v2 is per-lane; v1 saves had no live playing-set worth
  // preserving (brand-new module), so we just drop the stale single-lane state.
  migrate(data, fromVersion) {
    if (!data || typeof data !== 'object') return data;
    if (fromVersion >= 2) return data;
    const d = { ...(data as Record<string, unknown>) };
    delete d.playing; // was string|null → now (number|null)[]
    delete d.queued; // was string|'stop'|null → now per-lane array
    return d;
  },

  inputs: [{ id: 'stop_all', type: 'gate' }],
  outputs: Array.from({ length: CLIP_LANES }, (_, i) => [
    { id: `pitch${i + 1}`, type: 'polyPitchGate' as const },
    { id: `gate${i + 1}`, type: 'gate' as const },
    { id: `vel${i + 1}`, type: 'cv' as const },
  ]).flat(),
  params: [
    // stepDiv: 0=1/4, 1=1/8, 2=1/16 (default), 3=1/32 — steps per TIMELORDE beat.
    { id: 'stepDiv', label: 'Step', defaultValue: 2, min: 0, max: 3, curve: 'discrete' },
    { id: 'octave', label: 'Oct', defaultValue: 0, min: -2, max: 2, curve: 'discrete' },
    { id: 'gateLength', label: 'Gate', defaultValue: 0.9, min: 0.1, max: 1, curve: 'linear' },
    // 0 = launch immediately, 1 = quantize to the lane's clip-loop boundary.
    { id: 'quantize', label: 'Qnt', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
  ],

  exposesSequence: true,

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;
    const LANES = CLIP_LANES;
    const LOOKAHEAD_S = 0.2;

    interface Lane {
      poly: ReturnType<typeof createPolySender>;
      gateSrc: ConstantSourceNode;
      velSrc: ConstantSourceNode;
      stepIndex: number;
      nextStepTime: number;
      active: number | null; // active slot (column) in this lane, or null
      lastVOct: number;
      lastGate: number;
      lastVel: number;
    }
    const lanes: Lane[] = Array.from({ length: LANES }, () => {
      const poly = createPolySender(ctx);
      const gateSrc = ctx.createConstantSource();
      const velSrc = ctx.createConstantSource();
      gateSrc.offset.value = 0;
      velSrc.offset.value = 0;
      gateSrc.start();
      velSrc.start();
      return {
        poly,
        gateSrc,
        velSrc,
        stepIndex: 0,
        nextStepTime: ctx.currentTime + 0.05,
        active: null,
        lastVOct: 0,
        lastGate: 0,
        lastVel: 0,
      };
    });

    // --- stop_all input (windowed edge counter — no whole-buffer rescan) ---
    const stopGain = ctx.createGain();
    const stopAnalyser = ctx.createAnalyser();
    stopAnalyser.fftSize = 2048;
    stopGain.connect(stopAnalyser);
    const stopSilence = ctx.createConstantSource();
    stopSilence.offset.value = 0;
    stopSilence.start();
    stopSilence.connect(stopGain);
    const stopCounter = createEdgeCounter({ ctx, analyser: stopAnalyser });

    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    let prevRunning = false;
    let totalLoops = 0;

    function liveData(): ClipPlayerData | undefined {
      return livePatch.nodes[nodeId]?.data as ClipPlayerData | undefined;
    }
    function readParam(id: string, fallback: number): number {
      const v = livePatch.nodes[nodeId]?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }
    function writeData(mut: (d: ClipPlayerData) => void): void {
      const live = livePatch.nodes[nodeId];
      if (!live) return;
      if (!live.data) live.data = {};
      mut(live.data as ClipPlayerData);
    }

    // --- TIMELORDE transport (the rack clock we lock to) ---
    function timelorde() {
      for (const n of Object.values(livePatch.nodes)) {
        if (n && (n as { type?: string }).type === 'timelorde') return n;
      }
      return undefined;
    }
    function transportRunning(): boolean {
      const t = timelorde();
      if (!t) return true; // no TIMELORDE in rack → free-run
      const v = (t.params as Record<string, number> | undefined)?.running;
      return typeof v === 'number' ? v >= 0.5 : true;
    }
    function transportBpm(): number {
      const t = timelorde();
      const v = (t?.params as Record<string, number> | undefined)?.bpm;
      return typeof v === 'number' && v > 0 ? v : 120;
    }
    /** True when TIMELORDE is slaved to an external clock (its clock/start/stop
     *  inputs are patched) — the card hides transport in that case. */
    function transportExternallyClocked(): boolean {
      const t = timelorde();
      if (!t) return false;
      const edges = Object.values(livePatch.edges);
      return (
        isInputPortConnected(edges, t.id, 'clock') ||
        isInputPortConnected(edges, t.id, 'start_in') ||
        isInputPortConnected(edges, t.id, 'stop_in')
      );
    }

    function ensureArray<T>(v: unknown, fill: T): T[] {
      const out = new Array<T>(LANES).fill(fill);
      if (Array.isArray(v)) for (let i = 0; i < LANES; i++) if (i < v.length) out[i] = v[i] as T;
      return out;
    }

    function silenceLane(L: number, at: number): void {
      const ln = lanes[L];
      ln.gateSrc.offset.cancelScheduledValues(at);
      ln.gateSrc.offset.setValueAtTime(0, at);
      ln.velSrc.offset.cancelScheduledValues(at);
      ln.velSrc.offset.setValueAtTime(0, at);
      ln.poly.silence(at);
      ln.lastGate = 0;
      ln.lastVel = 0;
    }

    function setLaneActive(L: number, slot: number | null): void {
      const ln = lanes[L];
      ln.active = slot;
      ln.stepIndex = 0;
      ln.nextStepTime = ctx.currentTime + 0.01;
      writeData((d) => {
        const playing = ensureArray<number | null>(d.playing, null);
        playing[L] = slot;
        d.playing = playing;
      });
      if (slot === null) silenceLane(L, ctx.currentTime);
    }

    /** Apply lane L's queued launch/stop (consuming it). Returns true if the
     *  active clip changed. */
    function applyLaneQueued(L: number): boolean {
      const d = liveData();
      const q = d?.queued?.[L];
      if (q === undefined || q === null) return false;
      writeData((dd) => {
        const queued = ensureArray<number | 'stop' | null>(dd.queued, null);
        queued[L] = null;
        dd.queued = queued;
      });
      if (q === 'stop') {
        if (lanes[L].active === null) return false;
        setLaneActive(L, null);
        return true;
      }
      const slot = Number(q);
      if (slot === lanes[L].active) return false;
      setLaneActive(L, slot);
      return true;
    }

    function emitLaneStep(L: number, idx: number, atTime: number, stepDur: number): void {
      const ln = lanes[L];
      if (ln.active === null) return;
      const clip = readClip(liveData(), clipIndex(ln.active, L));
      if (!clip || clip.kind !== 'note') return;
      const r = lanesForStep(clip, idx);
      const octave = readParam('octave', 0);
      const gateFrac = readParam('gateLength', 0.9);
      const gateOff = Math.max(0.001, r.gateSteps * stepDur * gateFrac);
      const voiced = r.lanes.map((v) => ({ pitch: v.pitch + octave, gate: v.gate }));
      ln.poly.scheduleStep(atTime, voiced, gateOff);
      if (r.any) {
        ln.gateSrc.offset.setValueAtTime(1, atTime);
        ln.gateSrc.offset.setValueAtTime(0, atTime + gateOff);
        ln.velSrc.offset.setValueAtTime(r.velocity, atTime);
        ln.lastVOct = voiced[0]?.pitch ?? 0;
        ln.lastGate = 1;
        ln.lastVel = r.velocity;
      } else {
        ln.lastGate = 0;
      }
    }

    function laneLength(L: number): number {
      const ln = lanes[L];
      if (ln.active === null) return 1;
      const clip = readClip(liveData(), clipIndex(ln.active, L));
      return clip && clip.kind === 'note' ? Math.max(1, clip.lengthSteps) : 1;
    }

    function tick(): void {
      if (!alive) return;
      try {
        const running = transportRunning();
        if (running && !prevRunning) {
          // Transport started → align all lanes to step 0 on the downbeat.
          for (let L = 0; L < LANES; L++) {
            lanes[L].stepIndex = 0;
            lanes[L].nextStepTime = ctx.currentTime + 0.01;
          }
        } else if (!running && prevRunning) {
          for (let L = 0; L < LANES; L++) silenceLane(L, ctx.currentTime);
        }
        prevRunning = running;

        // Adopt peer-driven playing changes (synced playing-set).
        const d0 = liveData();
        for (let L = 0; L < LANES; L++) {
          const synced = d0?.playing?.[L] ?? null;
          const sv = typeof synced === 'number' ? synced : null;
          const hasQueued = (d0?.queued?.[L] ?? null) !== null;
          if (sv !== lanes[L].active && !hasQueued) {
            lanes[L].active = sv;
            lanes[L].stepIndex = 0;
            lanes[L].nextStepTime = ctx.currentTime + 0.01;
            if (sv === null) silenceLane(L, ctx.currentTime);
          }
        }

        // stop_all — stop every lane immediately.
        if (stopCounter.poll(ctx.currentTime) > 0) {
          for (let L = 0; L < LANES; L++) if (lanes[L].active !== null) setLaneActive(L, null);
        }

        const quantize = readParam('quantize', 1) >= 0.5;
        // Immediate-launch path (quantize off, or a lane that isn't playing).
        for (let L = 0; L < LANES; L++) {
          if (!quantize || lanes[L].active === null) applyLaneQueued(L);
        }

        if (!running) return;

        const stepDur = 60 / transportBpm() / (STEP_DIV_SPB[readParam('stepDiv', 2)] ?? 4);

        for (let L = 0; L < LANES; L++) {
          const ln = lanes[L];
          if (ln.active === null) {
            ln.nextStepTime = ctx.currentTime + 0.05;
            continue;
          }
          while (ln.nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const len = laneLength(L);
            emitLaneStep(L, ln.stepIndex, ln.nextStepTime, stepDur);
            const nextIdx = (ln.stepIndex + 1) % len;
            const nextStart = ln.nextStepTime + stepDur;
            if (nextIdx === 0) {
              totalLoops++;
              if (quantize && applyLaneQueued(L)) {
                ln.nextStepTime = nextStart;
                continue;
              }
              if (ln.active === null) break;
            }
            ln.nextStepTime = nextStart;
            ln.stepIndex = nextIdx;
          }
        }
      } catch (err) {
        console.error('[clipplayer] tick error', err);
      }
    }

    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const outputs = new Map<string, { node: AudioNode; output: number }>();
    for (let L = 0; L < LANES; L++) {
      outputs.set(`pitch${L + 1}`, { node: lanes[L].poly.output, output: 0 });
      outputs.set(`gate${L + 1}`, { node: lanes[L].gateSrc, output: 0 });
      outputs.set(`vel${L + 1}`, { node: lanes[L].velSrc, output: 0 });
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number }>([
        ['stop_all', { node: stopGain, input: 0 }],
      ]),
      outputs,
      setParam() {
        /* tick reads node.params live each iteration */
      },
      readParam(paramId) {
        const v = livePatch.nodes[nodeId]?.params?.[paramId];
        return typeof v === 'number' ? v : undefined;
      },
      read(key) {
        if (key === 'totalLoops') return totalLoops;
        if (key === 'transportRunning') return transportRunning() ? 1 : 0;
        if (key === 'externallyClocked') return transportExternallyClocked() ? 1 : 0;
        if (typeof key === 'string') {
          // per-lane reads: 'activeLane:L' 'pitchVOct:L' 'gateValue:L' 'velValue:L' 'currentStep:L'
          const m = /^(activeLane|pitchVOct|gateValue|velValue|currentStep):(\d+)$/.exec(key);
          if (m) {
            const L = Number(m[2]);
            if (L < 0 || L >= LANES) return undefined;
            const ln = lanes[L];
            switch (m[1]) {
              case 'activeLane': return ln.active === null ? -1 : ln.active;
              case 'pitchVOct': return ln.lastVOct;
              case 'gateValue': return ln.lastGate;
              case 'velValue': return ln.lastVel;
              case 'currentStep': return ln.stepIndex;
            }
          }
        }
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) {
          unsubscribeTick();
          unsubscribeTick = null;
        }
        for (const ln of lanes) {
          try { ln.gateSrc.stop(); } catch { /* */ }
          try { ln.velSrc.stop(); } catch { /* */ }
          ln.poly.dispose();
          try { ln.gateSrc.disconnect(); } catch { /* */ }
          try { ln.velSrc.disconnect(); } catch { /* */ }
        }
        try { stopSilence.stop(); } catch { /* */ }
        stopSilence.disconnect();
        stopGain.disconnect();
        stopAnalyser.disconnect();
      },
    };
  },
};

export { CLIP_COUNT, POLY_CHANNEL_PAIRS };
