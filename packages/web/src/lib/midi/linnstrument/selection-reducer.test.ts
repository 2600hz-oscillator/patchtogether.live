// Selection reducer — D04 (owner ruling: independent bits), pointer policy
// (D05 recommendation), join policy under BOTH switches (D07 open), hold on
// release (D06), Center, Panic. SYNTHETIC vectors over the pure reducer.

import { describe, it, expect } from 'vitest';
import { DEFAULT_LINN_PROFILE } from './profile';
import { createSelectionState, intentsFromRuntimeEvent, persistedSelection, pointerToPair, reduceAll, reduceControls } from './selection-reducer';
import { createMpeState, applyTouch } from '../mpe-state';
import type { ControlIntent, LinnProfile, SelectionState, SelectorId } from './types';

const P = DEFAULT_LINN_PROFILE;
const SOFT: LinnProfile = { ...P, selectionJoin: 'soft_takeover' };
const press = (s: SelectorId): ControlIntent[] => [{ kind: 'selector_edge', selector: s, down: true }, { kind: 'selector_edge', selector: s, down: false }];
const down = (touch: number, u: number, v: number): ControlIntent => ({ kind: 'pointer', touch, phase: 'down', u, v });
const move = (touch: number, u: number, v: number): ControlIntent => ({ kind: 'pointer', touch, phase: 'move', u, v });
const up = (touch: number): ControlIntent => ({ kind: 'pointer', touch, phase: 'up', u: 0, v: 0 });
const maskOf = (s: SelectionState): string => `${s.mask.r ? 'r' : '-'}${s.mask.g ? 'g' : '-'}${s.mask.b ? 'b' : '-'}`;

describe('selection-reducer: D04 — three independent bits', () => {
  it('starts from the profile default (R on — a RECOMMENDATION) with centred pairs', () => {
    const s = createSelectionState(P);
    expect(s.mask).toEqual({ r: true, g: false, b: false });
    expect(s.pairs).toEqual({ r: { x: 0, y: 0 }, g: { x: 0, y: 0 }, b: { x: 0, y: 0 } });
    expect(s.pointer.touch).toBeNull();
  });

  it('V02/V03: each press flips ONLY its bit; the other two never move (never a radio)', () => {
    let s = createSelectionState(P);
    s = reduceAll(s, press('g'), P).state;
    expect(maskOf(s)).toBe('rg-');
    s = reduceAll(s, press('b'), P).state;
    expect(maskOf(s)).toBe('rgb');
    s = reduceAll(s, press('r'), P).state;
    expect(maskOf(s)).toBe('-gb');
  });

  it('all eight masks are reachable and legal, including none and all', () => {
    const seen = new Set<string>();
    let s = createSelectionState(P);
    // Gray-code walk over r,g,b touches every mask exactly once.
    const walk: SelectorId[] = ['r', 'g', 'r', 'b', 'r', 'g', 'r'];
    seen.add(maskOf(s));
    for (const sel of walk) {
      s = reduceAll(s, press(sel), P).state;
      seen.add(maskOf(s));
    }
    expect(seen.size).toBe(8);
    expect(seen.has('---')).toBe(true);
    expect(seen.has('rgb')).toBe(true);
  });

  it('V03 mask: fresh down flips once; a repeated down and the up do not; the next fresh down flips again', () => {
    let s = createSelectionState(P);
    const r0 = reduceControls(s, { kind: 'selector_edge', selector: 'r', down: true }, P);
    expect(r0.state.mask.r).toBe(false);
    const r1 = reduceControls(r0.state, { kind: 'selector_edge', selector: 'r', down: true }, P);
    expect(r1.state).toBe(r0.state); // same object: nothing changed
    const r2 = reduceControls(r1.state, { kind: 'selector_edge', selector: 'r', down: false }, P);
    expect(r2.state.mask.r).toBe(false);
    const r3 = reduceControls(r2.state, { kind: 'selector_edge', selector: 'r', down: true }, P);
    expect(r3.state.mask.r).toBe(true);
    s = r3.state;
    expect(s.revision).toBe(3);
  });

  it('an up without a down is ignored; set_selector is absolute and idempotent', () => {
    const s = createSelectionState(P);
    expect(reduceControls(s, { kind: 'selector_edge', selector: 'g', down: false }, P).state).toBe(s);
    const on = reduceControls(s, { kind: 'set_selector', selector: 'g', on: true }, P).state;
    expect(on.mask.g).toBe(true);
    expect(reduceControls(on, { kind: 'set_selector', selector: 'g', on: true }, P).state).toBe(on);
  });
});

describe('selection-reducer: pointer policy (first_eligible_fresh_contact) and fan-out', () => {
  it('V04 fan-out: R+B selected, sample (u=.75,v=.25) → R and B receive (.5,−.5) together; G unchanged', () => {
    let s = reduceAll(createSelectionState(P), press('b'), P).state;
    s = reduceAll(s, [down(1, 0.5, 0.5), move(1, 0.75, 0.25)], P).state;
    expect(s.pairs.r).toEqual({ x: 0.5, y: -0.5 });
    expect(s.pairs.b).toEqual({ x: 0.5, y: -0.5 });
    expect(s.pairs.g).toEqual({ x: 0, y: 0 });
  });

  it('pointerToPair: left/bottom −1, centre 0, right/top +1', () => {
    expect(pointerToPair(0, 0)).toEqual({ x: -1, y: -1 });
    expect(pointerToPair(0.5, 0.5)).toEqual({ x: 0, y: 0 });
    expect(pointerToPair(1, 1)).toEqual({ x: 1, y: 1 });
  });

  it('V08: a second contact while the pointer is owned is ignored — its down and moves do nothing', () => {
    let s = reduceAll(createSelectionState(P), [down(1, 0.2, 0.2)], P).state;
    const before = s;
    s = reduceAll(s, [down(2, 0.9, 0.9), move(2, 0.8, 0.8)], P).state;
    expect(s).toBe(before);
    expect(s.pairs.r).toEqual(pointerToPair(0.2, 0.2));
    // The owner still moves it.
    s = reduceAll(s, [move(1, 0.3, 0.3)], P).state;
    expect(s.pairs.r).toEqual(pointerToPair(0.3, 0.3));
  });

  it('V04 hold on release: up keeps every pair and frees the pointer; the OLD second finger does not inherit it', () => {
    let s = reduceAll(createSelectionState(P), [down(1, 0.2, 0.8), down(2, 0.9, 0.9), up(1)], P).state;
    expect(s.pointer.touch).toBeNull();
    expect(s.pairs.r).toEqual(pointerToPair(0.2, 0.8));
    // Finger 2 was never the owner; its moves are still ignored (no jump to an old secondary finger).
    const held = s;
    s = reduceAll(s, [move(2, 0.1, 0.1)], P).state;
    expect(s).toBe(held);
    // A FRESH contact takes the pointer.
    s = reduceAll(s, [down(3, 0.6, 0.6)], P).state;
    expect(s.pointer.touch).toBe(3);
    expect(s.pairs.r).toEqual(pointerToPair(0.6, 0.6));
  });

  it('an unselected pair keeps its prior value while others follow', () => {
    let s = reduceAll(createSelectionState(P), [{ kind: 'set_pair', selector: 'g', x: -0.4, y: 0.9 }], P).state;
    s = reduceAll(s, [down(1, 1, 1)], P).state;
    expect(s.pairs.r).toEqual({ x: 1, y: 1 });
    expect(s.pairs.g).toEqual({ x: -0.4, y: 0.9 });
  });

  it('non-finite samples are rejected and values are clamped', () => {
    const s = createSelectionState(P);
    expect(reduceControls(s, down(1, Number.NaN, 0.5), P).state).toBe(s);
    const t = reduceControls(s, down(1, 7, -3), P).state;
    expect(t.pairs.r).toEqual({ x: 1, y: -1 });
  });
});

describe('selection-reducer: V09 join policy under BOTH switches', () => {
  it('next_coherent_xy_sample (RECOMMENDATION): the newly selected pair does not move on selection, then jumps on the next sample', () => {
    let s = reduceAll(createSelectionState(P), [down(1, 0.9, 0.9)], P).state;
    expect(s.pairs.g).toEqual({ x: 0, y: 0 });
    s = reduceAll(s, press('g'), P).state;
    expect(s.pairs.g).toEqual({ x: 0, y: 0 }); // not yet
    s = reduceAll(s, [move(1, 0.8, 0.8)], P).state;
    expect(s.pairs.g).toEqual(pointerToPair(0.8, 0.8)); // joined, coherently with R
    expect(s.pairs.r).toEqual(pointerToPair(0.8, 0.8));
  });

  it('soft_takeover: the newly selected pair holds until the pointer passes within the pickup radius', () => {
    let s = reduceAll(createSelectionState(SOFT), [down(1, 0.9, 0.9)], SOFT).state;
    s = reduceAll(s, press('g'), SOFT).state;
    expect(s.armed.g).toBe(true);
    s = reduceAll(s, [move(1, 0.8, 0.8)], SOFT).state;
    expect(s.pairs.g).toEqual({ x: 0, y: 0 }); // far from (0,0): still held
    expect(s.pairs.r).toEqual(pointerToPair(0.8, 0.8)); // R was never armed
    s = reduceAll(s, [move(1, 0.52, 0.51)], SOFT).state; // within 0.1 of (0,0)
    expect(s.armed.g).toBe(false);
    expect(s.pairs.g).toEqual(pointerToPair(0.52, 0.51));
    s = reduceAll(s, [move(1, 0.1, 0.1)], SOFT).state; // now it follows
    expect(s.pairs.g).toEqual(pointerToPair(0.1, 0.1));
  });

  it('soft_takeover: selecting with NO live pointer does not arm — the next fresh contact moves it', () => {
    let s = reduceAll(createSelectionState(SOFT), press('b'), SOFT).state;
    expect(s.armed.b).toBe(false);
    s = reduceAll(s, [down(1, 1, 0)], SOFT).state;
    expect(s.pairs.b).toEqual({ x: 1, y: -1 });
  });

  it('deselecting freezes immediately under either policy', () => {
    for (const profile of [P, SOFT]) {
      let s = reduceAll(createSelectionState(profile), [down(1, 0.25, 0.25)], profile).state;
      s = reduceAll(s, press('r'), profile).state; // R off
      s = reduceAll(s, [move(1, 0.9, 0.9)], profile).state;
      expect(s.pairs.r).toEqual(pointerToPair(0.25, 0.25));
    }
  });
});

describe('selection-reducer: Center, Panic, hydrate, epoch', () => {
  it('Center zeroes ONLY selected pairs and the next physical update moves them again', () => {
    let s = reduceAll(createSelectionState(P), [{ kind: 'set_pair', selector: 'g', x: 0.3, y: 0.3 }, down(1, 1, 1)], P).state;
    s = reduceAll(s, [{ kind: 'center' }], P).state;
    expect(s.pairs.r).toEqual({ x: 0, y: 0 });
    expect(s.pairs.g).toEqual({ x: 0.3, y: 0.3 });
    s = reduceAll(s, [move(1, 0, 0)], P).state;
    expect(s.pairs.r).toEqual({ x: -1, y: -1 });
  });

  it('Panic is an effect only: XY, mask and pointer are retained', () => {
    const s = reduceAll(createSelectionState(P), [down(1, 0.75, 0.75)], P).state;
    const r = reduceControls(s, { kind: 'panic' }, P);
    expect(r.effects).toEqual([{ kind: 'panic' }]);
    expect(r.state).toBe(s);
  });

  it('extra controls: fresh down → effect when enabled (D17 recommendation); inert when the switch is off', () => {
    const s = createSelectionState(P);
    expect(reduceControls(s, { kind: 'extra_control', control: 'keyboard_arp', down: true }, P).effects).toEqual([{ kind: 'extra_control', control: 'keyboard_arp' }]);
    expect(reduceControls(s, { kind: 'extra_control', control: 'keyboard_arp', down: false }, P).effects).toEqual([]);
    const off: LinnProfile = { ...P, extraControlsEnabled: false };
    expect(reduceControls(s, { kind: 'extra_control', control: 'keyboard_arp', down: true }, off).effects).toEqual([]);
  });

  it('V05: persisted selection survives a JSON round trip; pointer/held/armed are not persisted', () => {
    const s = reduceAll(createSelectionState(P), [...press('b'), down(1, 0.75, 0.25), up(1)], P).state;
    const json = JSON.stringify(persistedSelection(s));
    const back = JSON.parse(json) as ReturnType<typeof persistedSelection>;
    const loaded = reduceControls(createSelectionState(P), { kind: 'hydrate', ...back }, P).state;
    expect(loaded.mask).toEqual({ r: true, g: false, b: true });
    expect(loaded.pairs).toEqual(s.pairs);
    expect(loaded.pointer.touch).toBeNull();
    expect(json).not.toContain('pointer');
  });

  it('a hardware intent from an older epoch is rejected; a session intent advances the epoch and drops the pointer', () => {
    let s = reduceAll(createSelectionState(P, 1), [down(1, 0.1, 0.1)], P).state;
    s = reduceControls(s, { kind: 'session', epoch: 2 }, P).state;
    expect(s.epoch).toBe(2);
    expect(s.pointer.touch).toBeNull();
    const stale = reduceControls(s, { kind: 'pointer', touch: 1, phase: 'down', u: 0.9, v: 0.9, epoch: 1 }, P);
    expect(stale.state).toBe(s);
    const fresh = reduceControls(s, { kind: 'pointer', touch: 2, phase: 'down', u: 0.9, v: 0.9, epoch: 2 }, P);
    expect(fresh.state.pointer.touch).toBe(2);
  });

  it('intentsFromRuntimeEvent: control edges, pointer and session map; voice events map to nothing', () => {
    expect(intentsFromRuntimeEvent({ kind: 'control_edge', epoch: 1, control: 'r', down: true, time: 0 }, P)).toEqual([{ kind: 'selector_edge', selector: 'r', down: true, epoch: 1 }]);
    expect(intentsFromRuntimeEvent({ kind: 'control_edge', epoch: 1, control: 'panic', down: true, time: 0 }, P)).toEqual([{ kind: 'panic' }]);
    expect(intentsFromRuntimeEvent({ kind: 'control_edge', epoch: 1, control: 'panic', down: false, time: 0 }, P)).toEqual([]);
    expect(intentsFromRuntimeEvent({ kind: 'control_edge', epoch: 1, control: 'octave_up', down: true, time: 0 }, P)).toEqual([{ kind: 'extra_control', control: 'octave_up', down: true, epoch: 1 }]);
    expect(intentsFromRuntimeEvent({ kind: 'pointer', epoch: 1, touch: 4, phase: 'move', u: 0.1, v: 0.2, pressure: 0, time: 0 }, P)).toEqual([{ kind: 'pointer', touch: 4, phase: 'move', u: 0.1, v: 0.2, epoch: 1 }]);
    expect(intentsFromRuntimeEvent({ kind: 'touch_start', epoch: 1, touch: 4, region: 'pad', col: 17, row: 0, localCol: 0, localRow: 0, note: 60, velocity: 100, time: 0 }, P)).toEqual([]);
  });

  it('D17 OFF: the HARDWARE panic cell is inert with the other four — no intent leaves the wire translation; the face intent is ungated', () => {
    const off: LinnProfile = { ...P, extraControlsEnabled: false };
    expect(intentsFromRuntimeEvent({ kind: 'control_edge', epoch: 1, control: 'panic', down: true, time: 0 }, off)).toEqual([]);
    expect(intentsFromRuntimeEvent({ kind: 'control_edge', epoch: 1, control: 'keyboard_arp', down: true, time: 0 }, off)).toEqual([{ kind: 'extra_control', control: 'keyboard_arp', down: true, epoch: 1 }]);
    expect(reduceControls(createSelectionState(off), { kind: 'extra_control', control: 'keyboard_arp', down: true }, off).effects).toEqual([]);
    // The selectors above the five stay live, and a DISPATCHED panic (the face's cell) still fires.
    expect(intentsFromRuntimeEvent({ kind: 'control_edge', epoch: 1, control: 'r', down: true, time: 0 }, off)).toHaveLength(1);
    expect(reduceControls(createSelectionState(off), { kind: 'panic' }, off).effects).toEqual([{ kind: 'panic' }]);
  });
});

describe('selection-reducer + mpe-state: D13 / V10 musical identity', () => {
  it('two touches of the same pitch are two voices, and identity survives a horizontal slide', () => {
    const mpe = createMpeState({ lanes: 16 });
    const start = (touch: number, note: number) => applyTouch(mpe, { kind: 'touch_start', epoch: 1, touch, region: 'keys', col: 0, row: 0, localCol: 0, localRow: 0, note, velocity: 100, time: 0 });
    start(1, 41);
    start(2, 41);
    expect(mpe.voices.size).toBe(2);
    expect(new Set([...mpe.voices.values()].map((v) => v.lane)).size).toBe(2);
    applyTouch(mpe, { kind: 'touch_slide', epoch: 1, touch: 1, region: 'keys', fromCol: 5, toCol: 6, row: 0, time: 1 });
    applyTouch(mpe, { kind: 'touch_expression', epoch: 1, touch: 1, region: 'keys', bendSemitones: 1, time: 1 });
    expect(mpe.voices.get(1)).toMatchObject({ note: 41, bend: 1, lane: 0, held: true });
    expect(mpe.voices.get(2)).toMatchObject({ note: 41, bend: 0, lane: 1 });
    const ended = applyTouch(mpe, { kind: 'touch_end', epoch: 1, touch: 1, region: 'keys', reason: 'release', time: 2 });
    expect(ended).toMatchObject([{ kind: 'voice_end', voice: { id: 1, lane: 0 } }]);
    expect(mpe.voices.size).toBe(1);
  });
});
