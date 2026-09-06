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
import type { ParamOption } from '$lib/graph/types';

/**
 * The three ROUTE states, DECLARED once and consumed by every surface (#1911).
 *
 * The 993's router is a three-position SWITCH on the real panel, and it was
 * declared `curve: 'linear'` — the only 3-state selector in the Moog family
 * that was. Measured on the shipping code: of 201 evenly-spaced positions
 * across the 0..2 travel, **149 delivered something other than their nearest
 * state** — every position between the integers muted both select gains, so a
 * persisted `1.4` came back SILENT on reload and one wheel notch off the
 * default silenced a trigger out.
 *
 * The roster is what carries the state NAMES onto a surface: the dock face
 * renders an `options` param of ≤6 states as a SEGMENTED cell
 * (`paramCellKind`, `shell-control-kind.ts:266-268`), and the card's switch
 * below is driven from this same array — so the names cannot drift from the
 * def the way a re-typed literal does.
 */
export const MOOG993_ROUTE_OPTIONS: readonly ParamOption[] = [
  { value: 0, label: 'OFF', title: 'the output carries nothing — both source select gains muted' },
  { value: 1, label: 'FROM 1', title: 'the output carries trigger SOURCE 1' },
  { value: 2, label: 'FROM 2', title: 'the output carries trigger SOURCE 2' },
];

/**
 * A dial position → the state it MEANS: the nearest declared state, clamped to
 * the declared travel.
 *
 * Exported because the banding is a property of the CONTROL, not of one
 * writer: the segmented switch and the face's segmented cell can only emit
 * 0/1/2, but MIDI learn, automation, a preset load and any persisted patch
 * written before this fix all reach `setParam` with arbitrary floats. Rounding
 * at the seam is what makes every one of those paths land on a state instead
 * of on silence.
 */
export function moog993RouteState(route: number): number {
  // A NaN / Infinity write must not silence the out; fall back to the DECLARED
  // default rather than a re-typed literal.
  if (!Number.isFinite(route)) return moog993Def.params.find((p) => p.id === 'route1')!.defaultValue;
  const { min, max } = moog993Def.params.find((p) => p.id === 'route1')!;
  return Math.round(Math.max(min, Math.min(max, route)));
}

export const moog993Def: AudioModuleDef = {
  type: 'moog993',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '993 trig',
  category: 'modulation',

  inputs: [
    { id: 'trig_from1', type: 'gate', edge: 'trigger' },
    { id: 'trig_from2', type: 'gate', edge: 'trigger' },
    { id: 'env_in1',    type: 'cv' },
    { id: 'env_in2',    type: 'cv' },
  ],
  outputs: [
    { id: 'trig_out1', type: 'gate', edge: 'trigger' },
    { id: 'trig_out2', type: 'gate', edge: 'trigger' },
    { id: 'trig_out3', type: 'gate', edge: 'trigger' },
    { id: 'env_out1',  type: 'cv' },
    { id: 'env_out2',  type: 'cv' },
  ],
  params: [
    // 0 = OFF, 1 = FROM 1, 2 = FROM 2. Default 1 (FROM 1) so a freshly
    // spawned panel routes source 1 to every trigger out.
    { id: 'route1', label: 'Route 1', defaultValue: 1, min: 0, max: 2, curve: 'discrete', options: MOOG993_ROUTE_OPTIONS },
    { id: 'route2', label: 'Route 2', defaultValue: 1, min: 0, max: 2, curve: 'discrete', options: MOOG993_ROUTE_OPTIONS },
    { id: 'route3', label: 'Route 3', defaultValue: 1, min: 0, max: 2, curve: 'discrete', options: MOOG993_ROUTE_OPTIONS },
  ],

  // ── THE FACEPLATE ──────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR. Every other panel in this family PROCESSES a signal. The
  // 993 does nothing to one — it DECIDES WHERE IT GOES. It is a trigger
  // switchboard: two clocks in, three outs, and one 3-position switch per out
  // saying which clock that out carries. The verb is PATCHING WITHOUT
  // REPATCHING — changing the shape of a rhythm section from three switches
  // instead of from three cables.
  //
  // ⚠ MERIT IS NARROW AND IT IS THE READOUT THAT CARRIES IT. Three params, no
  // control families, no `node.data`, and the three routers are PEERS — so the
  // usual ranking argument ("what does a shrinking tier keep") is nearly empty
  // here: at mini you get ROUTE 1 because it is the first out on the panel, not
  // because it matters more. What makes the face worth its two baselines is the
  // hero readout: the CONFIGURATION is a property of all three switches at
  // once, and no switch can print it. (This is a weaker case than most in the
  // queue and is recorded as such rather than dressed up.)
  //
  // THE LADDER, read back as a sentence: mini shows ROUTE 1; compact adds
  // ROUTE 2; every tier from plate up shows all three plus the routing name.
  // `order` and `pages` do NOT disagree here and there is no `pages` at all —
  // three peers are ONE idea, and a page per switch would be three headers over
  // three controls, which is the padding the band rules forbid.
  //
  // The cells are SEGMENTED, not dials, and that is a consequence of the def
  // rather than a face choice: each router declares an `options` roster, and
  // `paramCellKind` renders an options param of ≤6 states as a segmented cell
  // at the dock. That roster is also what paints OFF / FROM 1 / FROM 2 instead
  // of a bare number — see #1911, where these were `curve: 'linear'` dials over
  // a DSP that selected on exact float equality.
  face: {
    order: ['route1', 'route2', 'route3'],
    glyph: 'none',
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog 993 Trigger & Envelope Voltages panel — a passive patch-bay convenience panel with two jobs. (1) A TRIGGER ROUTER: two trigger SOURCES (FROM 1 / FROM 2) feed three trigger OUTPUTS, and each output's ROUTE switch independently selects which source it carries — OFF (silent), FROM 1, or FROM 2. A single source can drive all three outs at once, so it works as a 1→3 trigger multiple, or you can split the three outs between two clocks. (2) Two unity ENVELOPE passthroughs: ENV IN 1/2 are copied straight to ENV OUT 1/2 (a tidy normalled feed-through for routing envelope CVs across a patch). Mental model: a small trigger switchboard (pick a source per output) bundled with two CV thru-jacks. Passive routing — no DSP, no audio.",
    inputs: {
      trig_from1:
        "Trigger SOURCE 1: a trigger/gate signal made available to any of the three outputs whose ROUTE is set to FROM 1. Patch a clock or trigger here.",
      trig_from2:
        "Trigger SOURCE 2: a second trigger/gate source, selected by any output whose ROUTE is set to FROM 2.",
      env_in1: "Envelope CV input 1 — passed straight through (unity) to ENV OUT 1. A normalled feed-through for routing an envelope across the patch.",
      env_in2: "Envelope CV input 2 — passed straight through (unity) to ENV OUT 2.",
    },
    outputs: {
      trig_out1: "Trigger output 1 — carries whichever source its ROUTE 1 switch selects (OFF, FROM 1, or FROM 2).",
      trig_out2: "Trigger output 2 — carries whichever source its ROUTE 2 switch selects.",
      trig_out3: "Trigger output 3 — carries whichever source its ROUTE 3 switch selects.",
      env_out1: "A unity copy of ENV IN 1 — the routed-through envelope CV.",
      env_out2: "A unity copy of ENV IN 2 — the routed-through envelope CV.",
    },
    controls: {
      route1: "Source select for trigger OUT 1: OFF (output silent), FROM 1 (carry source 1), or FROM 2 (carry source 2).",
      route2: "Source select for trigger OUT 2: OFF, FROM 1, or FROM 2.",
      route3: "Source select for trigger OUT 3: OFF, FROM 1, or FROM 2.",
    },
  },

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

    /**
     * route → [source-1 gain, source-2 gain]: 0=OFF, 1=FROM 1, 2=FROM 2.
     *
     * BANDS the incoming value first (#1911). This used to select on exact
     * float equality, so anything between the integers muted BOTH gains — the
     * one outcome a three-position switch has no position for.
     */
    function selectGains(route: number): [number, number] {
      const state = moog993RouteState(route);
      if (state === 1) return [1, 0];
      if (state === 2) return [0, 1];
      return [0, 0]; // OFF
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
