// packages/web/src/lib/ui/modules/moog993-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for moog993's one derived readout.
//
// The bar (module-faceplates.md): a derived readout is negative-controlled on
// the input a knob readback would be BLIND to, permanently. This module has
// exactly three params and the readout is a JOIN over all of them, so the
// control is symmetric and total: EACH router must be able to move it while
// the other two are held. A readback of any one switch is blind to the other
// two by construction, and the test below proves that for all three rather
// than for the one that happened to be convenient.

import { describe, it, expect } from 'vitest';
import { moog993RoutingText, moog993RouteStates, MOOG993_ROUTE_IDS } from './moog993-face-model';
import { moog993Def } from '$lib/audio/modules/moog993';

function reader(over: Record<string, number> = {}) {
  return (id: string): number | undefined => over[id];
}

describe('moog993 routing readout: the JOIN no single switch can print', () => {
  it('reads "from 1" at the shipped defaults (every out on source 1)', () => {
    // The factory-fresh 993 is a 1→3 trigger multiple. If that ever changes,
    // the module's first impression changed.
    expect(moog993RoutingText(reader())).toBe('from 1');
  });

  it('names each configuration the docs describe', () => {
    expect(moog993RoutingText(reader({ route1: 0, route2: 0, route3: 0 }))).toBe('silent');
    expect(moog993RoutingText(reader({ route1: 2, route2: 2, route3: 2 }))).toBe('from 2');
    expect(moog993RoutingText(reader({ route1: 1, route2: 2, route3: 1 }))).toBe('split');
    // OFF outs do not make it a split — a 1→2 multiple with one out muted is
    // still one clock feeding everything that is live.
    expect(moog993RoutingText(reader({ route1: 1, route2: 1, route3: 0 }))).toBe('from 1');
    expect(moog993RoutingText(reader({ route1: 0, route2: 0, route3: 2 }))).toBe('from 2');
  });

  // ── The negative control, run over EVERY router ─────────────────────────
  it('EACH router can move the readout while the other two are held', () => {
    const stuck: string[] = [];
    for (const id of MOOG993_ROUTE_IDS) {
      // Hold every other router on source 1; sweep this one across its states.
      const held: Record<string, number> = {};
      for (const other of MOOG993_ROUTE_IDS) if (other !== id) held[other] = 1;
      const seen = new Set([0, 1, 2].map((v) => moog993RoutingText(reader({ ...held, [id]: v }))));
      // Sweeping one switch alone must reach at least two different names —
      // otherwise the readout is not reading that switch at all.
      if (seen.size < 2) stuck.push(`${id}: sweeping it alone produced only ${[...seen].join(', ')}`);
    }
    expect(stuck, 'routers the readout is blind to').toEqual([]);
  });

  it('a readback of ONE switch cannot distinguish two different configurations', () => {
    // The positive statement of why this is a derived readout rather than a
    // relabelled knob: route1 is identical in both, and the module is in two
    // genuinely different states.
    const a = reader({ route1: 1, route2: 1, route3: 1 });
    const b = reader({ route1: 1, route2: 2, route3: 1 });
    expect(a('route1')).toBe(b('route1'));
    expect(moog993RoutingText(a)).not.toBe(moog993RoutingText(b));
  });

  // ── It reads through the module's own banding (#1911) ───────────────────
  it('a non-integer stored value reads as the state it ROUTES, not as OFF', () => {
    // Before #1911 a stored 1.4 routed nothing. It now bands to FROM 1, and the
    // readout must agree with the audio rather than with a `=== 1` comparison.
    expect(moog993RouteStates(reader({ route1: 1.4, route2: 1.4, route3: 1.4 }))).toEqual([1, 1, 1]);
    expect(moog993RoutingText(reader({ route1: 1.4, route2: 1.4, route3: 1.4 }))).toBe('from 1');
    expect(moog993RoutingText(reader({ route1: 0.4, route2: 0.4, route3: 0.4 }))).toBe('silent');
  });

  // ── Totality ────────────────────────────────────────────────────────────
  it('is TOTAL — a fresh node, NaN, ±Infinity and out-of-range all name a state', () => {
    const NAMES = ['silent', 'from 1', 'from 2', 'split'];
    expect(NAMES).toContain(moog993RoutingText(reader()));
    for (const bad of [NaN, Infinity, -Infinity, 99, -99]) {
      for (const id of MOOG993_ROUTE_IDS) {
        const text = moog993RoutingText(reader({ [id]: bad }));
        expect(NAMES, `${id}=${bad} produced ${text}`).toContain(text);
      }
    }
  });

  it('the roster is DERIVED from the def, not typed out', () => {
    // A fourth router would join the readout on its own; this asserts the
    // derivation rather than a count.
    expect(MOOG993_ROUTE_IDS).toEqual(
      moog993Def.params.map((p) => p.id).filter((id) => id.startsWith('route')),
    );
    expect(MOOG993_ROUTE_IDS.length).toBeGreaterThan(1);
  });
});

describe('moog993 face declaration', () => {
  const face = moog993Def.face!;

  it('ranks every param, and the routers keep their declared roster', () => {
    for (const p of moog993Def.params) expect(face.order).toContain(p.id);
    for (const p of moog993Def.params) {
      // The roster is what paints OFF / FROM 1 / FROM 2 on the segmented cell
      // instead of an anonymous dial — the #1911 half that reaches the face.
      expect(p.options?.length, `${p.id} options`).toBeGreaterThan(0);
      expect(p.curve, `${p.id} curve`).toBe('discrete');
    }
  });
});
