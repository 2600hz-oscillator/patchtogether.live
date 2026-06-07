// packages/web/src/lib/audio/modules/moog993.ts
//
// MOOG 993 TRIGGER & ENVELOPE VOLTAGES PANEL — a slice of the Moog System 55
// clone initiative (.myrobots/MOOG/). The 993 is a patch-bay convenience
// panel: a configurable TRIGGER ROUTER (three trigger outs, each selecting
// one of two trigger sources, or OFF) plus two unity ENVELOPE-CV passthroughs.
// Categorized under Ports → moogafakkin (the shared bucket, mirroring the CP3 / 921A).
//
// PASSIVE ROUTING — no DSP. Pure Web Audio graph (GainNodes only): each
// trigger output is a summing GainNode fed by BOTH trigger sources through
// per-source "select" gains; the route param opens exactly one source gain
// (1.0) and mutes the other (0.0), or mutes both when OFF. The two envelope
// passthroughs are unity GainNodes. No worklet, no Faust .dsp.
//
// Inputs:
//   trig_from1 / trig_from2 (gate): the two trigger SOURCES routed to the
//     three trigger outs.
//   env_in1 / env_in2 (cv): the two envelope CONTROL VOLTAGES passed straight
//     through to env_out1 / env_out2.
//
// Outputs:
//   trig_out1 / trig_out2 / trig_out3 (gate): per-out routed trigger. Each is
//     OFF / FROM 1 / FROM 2 per its route param.
//   env_out1 / env_out2 (cv): unity copies of env_in1 / env_in2.
//
// Params:
//   route1 / route2 / route3 (discrete 0..2, default 1): source select for
//     each trigger out. 0 = OFF (both source gains 0), 1 = FROM 1 (source-1
//     gain 1, source-2 gain 0), 2 = FROM 2 (source-2 gain 1, source-1 gain 0).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export const moog993Def: AudioModuleDef = {
  type: 'moog993',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog993Card',
  domain: 'audio',
  label: '993 trig',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    { id: 'trig_from1', type: 'gate' },
    { id: 'trig_from2', type: 'gate' },
    { id: 'env_in1',    type: 'cv' },
    { id: 'env_in2',    type: 'cv' },
  ],
  outputs: [
    { id: 'trig_out1', type: 'gate' },
    { id: 'trig_out2', type: 'gate' },
    { id: 'trig_out3', type: 'gate' },
    { id: 'env_out1',  type: 'cv' },
    { id: 'env_out2',  type: 'cv' },
  ],
  params: [
    // 0 = OFF, 1 = FROM 1, 2 = FROM 2. Default 1 (FROM 1) so a freshly
    // spawned panel routes source 1 to every trigger out.
    { id: 'route1', label: 'Route 1', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'route2', label: 'Route 2', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    { id: 'route3', label: 'Route 3', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // The two trigger SOURCE inputs: a fan-out point each. Per-out "select"
    // gains tap these and sum into each output bus, so a single source can
    // drive all three outs simultaneously.
    const src1 = ctx.createGain(); // trig_from1 receiver / fan-out
    const src2 = ctx.createGain(); // trig_from2 receiver / fan-out
    src1.gain.value = 1;
    src2.gain.value = 1;

    // Three trigger output buses + their two per-source select gains.
    const ROUTES = ['route1', 'route2', 'route3'] as const;
    type RouteId = (typeof ROUTES)[number];
    const outGains: Record<RouteId, GainNode> = {} as Record<RouteId, GainNode>;
    const sel1: Record<RouteId, GainNode> = {} as Record<RouteId, GainNode>;
    const sel2: Record<RouteId, GainNode> = {} as Record<RouteId, GainNode>;

    /** route → [source-1 gain, source-2 gain]: 0=OFF, 1=FROM 1, 2=FROM 2. */
    function selectGains(route: number): [number, number] {
      if (route === 1) return [1, 0];
      if (route === 2) return [0, 1];
      return [0, 0]; // 0 (OFF) or any out-of-range value mutes both
    }

    const initial = node.params ?? {};
    for (const routeId of ROUTES) {
      const out = ctx.createGain();
      out.gain.value = 1;
      const g1 = ctx.createGain();
      const g2 = ctx.createGain();
      const route = initial[routeId] ?? moog993Def.params.find((p) => p.id === routeId)!.defaultValue;
      const [a, b] = selectGains(route);
      g1.gain.value = a;
      g2.gain.value = b;
      // src1 → g1 → out ; src2 → g2 → out
      src1.connect(g1);
      src2.connect(g2);
      g1.connect(out);
      g2.connect(out);
      outGains[routeId] = out;
      sel1[routeId] = g1;
      sel2[routeId] = g2;
    }

    // Two unity envelope-CV passthroughs: env_in → env_out.
    const env1 = ctx.createGain();
    const env2 = ctx.createGain();
    env1.gain.value = 1;
    env2.gain.value = 1;

    /** Map a routeN paramId to its (src1, src2) select-gain pair. */
    function selPair(paramId: string): [GainNode, GainNode] | null {
      if (paramId === 'route1') return [sel1.route1, sel2.route1];
      if (paramId === 'route2') return [sel1.route2, sel2.route2];
      if (paramId === 'route3') return [sel1.route3, sel2.route3];
      return null;
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        // Trigger sources land on their fan-out gains; envelopes land on
        // their passthrough gains.
        ['trig_from1', { node: src1, input: 0 }],
        ['trig_from2', { node: src2, input: 0 }],
        ['env_in1',    { node: env1, input: 0 }],
        ['env_in2',    { node: env2, input: 0 }],
      ]),
      outputs: new Map([
        ['trig_out1', { node: outGains.route1, output: 0 }],
        ['trig_out2', { node: outGains.route2, output: 0 }],
        ['trig_out3', { node: outGains.route3, output: 0 }],
        ['env_out1',  { node: env1, output: 0 }],
        ['env_out2',  { node: env2, output: 0 }],
      ]),
      setParam(paramId, value) {
        const pair = selPair(paramId);
        if (!pair) return;
        const [a, b] = selectGains(value);
        pair[0].gain.setValueAtTime(a, ctx.currentTime);
        pair[1].gain.setValueAtTime(b, ctx.currentTime);
      },
      readParam(paramId) {
        const pair = selPair(paramId);
        if (!pair) return undefined;
        // Reconstruct the discrete route value from the live select gains.
        const a = pair[0].gain.value;
        const b = pair[1].gain.value;
        if (a >= 0.5) return 1; // FROM 1
        if (b >= 0.5) return 2; // FROM 2
        return 0;               // OFF
      },
      dispose() {
        try { src1.disconnect(); } catch { /* */ }
        try { src2.disconnect(); } catch { /* */ }
        for (const routeId of ROUTES) {
          try { sel1[routeId].disconnect(); } catch { /* */ }
          try { sel2[routeId].disconnect(); } catch { /* */ }
          try { outGains[routeId].disconnect(); } catch { /* */ }
        }
        try { env1.disconnect(); } catch { /* */ }
        try { env2.disconnect(); } catch { /* */ }
      },
    };
  },
};
