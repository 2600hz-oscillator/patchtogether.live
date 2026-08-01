// packages/web/src/lib/ui/workflow/param-vocabulary.test.ts
//
// THE PF-1 / PF-10 SPLIT, ENFORCED RATHER THAN DOCUMENTED.
//
// `ParamDef.options` and `ParamDef.landmarks` look interchangeable and are not.
// `options` says the param has N states and NOTHING between them; `landmarks`
// says the param MORPHS continuously and these are its named waypoints. Get it
// backwards and the face lies to the player in one of two specific ways:
//
//   * a morph rendered as a Segmented HIDES every in-between blend — the row
//     shows three buttons for a control that has infinitely many positions,
//     and two thirds of the module becomes unreachable-looking;
//   * a discrete switch rendered as a landmarked dial asks for a 200 px drag
//     to change one of three states, which is the exact `0.00`-printing rotary
//     PF-1 exists to delete.
//
// The `curve` field ALREADY carries the distinction — it is the DSP's own
// statement about whether the value quantizes — so this gate simply refuses to
// let the UI vocabulary contradict it. That is why the split is checkable at
// all, and why it is checked here rather than trusted to a review comment.
//
// Everything here is a PURE registry read (no DOM, no engine): it runs in the
// `unit` lane at ~0 added CI wall-time and fails a def the moment it is
// authored wrong, which is where the cost of getting it wrong is lowest.

import { describe, expect, it } from 'vitest';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ParamDef } from '$lib/graph/types';
import { paramCellKind, SEGMENTED_MAX_OPTIONS } from './shell-control-kind';
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

interface DefLike {
  type: string;
  params?: readonly ParamDef[];
}

function allDefs(): DefLike[] {
  return [
    ...(listModuleDefs() as unknown as DefLike[]),
    ...(listVideoModuleDefs() as unknown as DefLike[]),
    ...(listMetaModuleDefs() as unknown as DefLike[]),
  ];
}

/** Every (module type, param) pair in the whole registry. */
function allParams(): { type: string; p: ParamDef }[] {
  return allDefs().flatMap((d) => (d.params ?? []).map((p) => ({ type: d.type, p })));
}

describe('ParamDef vocabulary — options (PF-1) vs landmarks (PF-10)', () => {
  it('the registry is non-empty (guards a barrel import that silently no-ops)', () => {
    expect(allParams().length).toBeGreaterThan(100);
  });

  it('no param declares BOTH options and landmarks', () => {
    const both = allParams()
      .filter(({ p }) => p.options?.length && p.landmarks?.length)
      .map(({ type, p }) => `${type}.${p.id}`);
    expect(
      both,
      'options and landmarks are mutually exclusive: a param either HAS discrete ' +
        'states or MORPHS through named waypoints. Declaring both means the author ' +
        'has not decided which, and the dial would tick twice for one meaning.',
    ).toEqual([]);
  });

  it('a param with `options` is `curve: discrete`', () => {
    const bad = allParams()
      .filter(({ p }) => p.options?.length && p.curve !== 'discrete')
      .map(({ type, p }) => `${type}.${p.id} (curve=${p.curve})`);
    expect(
      bad,
      'a named-state roster over a CONTINUOUS curve is a lie: the dial can be left ' +
        'between two states the roster says do not exist. Either the curve is wrong ' +
        '(make it discrete) or the vocabulary is (use `landmarks`).',
    ).toEqual([]);
  });

  it('a param with `landmarks` is NOT `curve: discrete`', () => {
    const bad = allParams()
      .filter(({ p }) => p.landmarks?.length && p.curve === 'discrete')
      .map(({ type, p }) => `${type}.${p.id}`);
    expect(
      bad,
      'a DISCRETE param has states, not waypoints — every value it can hold is ' +
        'already named. Use `options` so the dock paints a real picker instead of a ' +
        'dial with a tick on every step.',
    ).toEqual([]);
  });

  it('every option/landmark value lies within the param range', () => {
    const bad: string[] = [];
    for (const { type, p } of allParams()) {
      for (const o of p.options ?? []) {
        if (o.value < p.min || o.value > p.max) bad.push(`${type}.${p.id} option ${o.label}=${o.value} ∉ [${p.min},${p.max}]`);
      }
      for (const l of p.landmarks ?? []) {
        if (l.value < p.min || l.value > p.max) bad.push(`${type}.${p.id} landmark ${l.label}=${l.value} ∉ [${p.min},${p.max}]`);
      }
    }
    expect(bad, 'an unreachable detent renders a tick the pointer can never reach').toEqual([]);
  });

  it('option/landmark values are unique and labels are non-empty', () => {
    const bad: string[] = [];
    for (const { type, p } of allParams()) {
      for (const roster of [p.options ?? [], p.landmarks ?? []]) {
        const values = roster.map((e) => e.value);
        if (new Set(values).size !== values.length) bad.push(`${type}.${p.id}: duplicate detent value`);
        if (roster.some((e) => !e.label.trim())) bad.push(`${type}.${p.id}: blank detent label`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('an `options` roster covers EVERY discrete step of its param', () => {
    // A discrete param's reachable values are exactly its integer steps, so a
    // roster that skips one leaves a state the dial can reach and the picker
    // cannot name — the off-detent case, created by the author rather than by
    // a legacy save.
    const bad: string[] = [];
    for (const { type, p } of allParams()) {
      if (!p.options?.length) continue;
      const steps = Math.round(p.max - p.min) + 1;
      if (p.options.length !== steps) {
        bad.push(`${type}.${p.id}: ${p.options.length} options for ${steps} discrete steps (${p.min}..${p.max})`);
      }
    }
    expect(bad, 'every reachable state of a discrete param must be named').toEqual([]);
  });

  it('a declared `format` (PF-3) is TOTAL — never throws, never returns empty', () => {
    // `format` runs on EVERY animation frame while a value moves (KnobConic's
    // readLive tick) and its output is ALSO the dial's aria-valuetext. A throw
    // kills the frame; an empty string renders an invisible readout that reads
    // exactly like "this param declared no vocabulary". Probe the declared
    // range AND the values a live/engine read can legitimately hand back
    // before the node has booted (undefined→NaN, an unclamped CV sum).
    const bad: string[] = [];
    for (const { type, p } of allParams()) {
      if (!p.format) continue;
      const probes = [
        p.min,
        p.max,
        p.defaultValue,
        (p.min + p.max) / 2,
        p.min - 1,
        p.max + 1,
        0,
        NaN,
        Infinity,
        -Infinity,
      ];
      for (const v of probes) {
        let out: string;
        try {
          out = p.format(v);
        } catch (e) {
          bad.push(`${type}.${p.id}.format(${v}) THREW: ${String(e)}`);
          continue;
        }
        if (typeof out !== 'string') bad.push(`${type}.${p.id}.format(${v}) → ${typeof out}, not a string`);
        else if (out.length === 0) bad.push(`${type}.${p.id}.format(${v}) → '' (an invisible readout)`);
      }
    }
    expect(bad.join('\n'), 'a param formatter must be pure and TOTAL').toBe('');
  });

  it('`defaultValue` resolves to a real option when a roster is declared', () => {
    const bad = allParams()
      .filter(({ p }) => p.options?.length && !p.options.some((o) => o.value === p.defaultValue))
      .map(({ type, p }) => `${type}.${p.id} (default ${p.defaultValue})`);
    expect(bad, 'a module must BOOT into a named state').toEqual([]);
  });
});

describe('paramCellKind — the tier-aware primitive choice', () => {
  const none: ReadonlySet<string> = new Set();
  const base: ParamDef = { id: 'mode', label: 'Mode', defaultValue: 0, min: 0, max: 2, curve: 'discrete' };
  const roster = (n: number) => Array.from({ length: n }, (_, i) => ({ value: i, label: `S${i}` }));

  it('a plain param is a knob at every tier', () => {
    const p: ParamDef = { id: 'cutoff', label: 'Cutoff', defaultValue: 1000, min: 20, max: 20000, curve: 'log' };
    expect(paramCellKind(p, none, 'dock')).toBe('knob');
    expect(paramCellKind(p, none, 'lane')).toBe('knob');
  });

  it('an options roster is SEGMENTED at the dock up to the button-row budget', () => {
    for (let n = 2; n <= SEGMENTED_MAX_OPTIONS; n++) {
      const p = { ...base, max: n - 1, options: roster(n) };
      expect(paramCellKind(p, none, 'dock'), `${n} options`).toBe('segmented');
    }
  });

  it('an options roster PAST the budget becomes a Selector at the dock', () => {
    const n = SEGMENTED_MAX_OPTIONS + 1;
    const p = { ...base, max: n - 1, options: roster(n) };
    expect(paramCellKind(p, none, 'dock')).toBe('selector');
  });

  it('EVERY lane tier keeps the dial — a lane column cannot hold a roster', () => {
    expect(paramCellKind({ ...base, options: roster(3) }, none, 'lane')).toBe('knob');
    expect(paramCellKind({ ...base, options: roster(12) }, none, 'lane')).toBe('knob');
  });

  it('`options` outranks the sniffed toggle shape', () => {
    // A 0..1 discrete param LOOKS like a switch, but one that named its two
    // states asked for those names to be painted.
    const p: ParamDef = {
      id: 'pol', label: 'Polarity', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      options: [{ value: 0, label: 'POS' }, { value: 1, label: 'NEG' }],
    };
    expect(paramCellKind(p, none, 'dock')).toBe('segmented');
    // …and without the roster it is still the anonymous switch PF-2 shipped.
    expect(paramCellKind({ ...p, options: undefined }, none, 'dock')).toBe('toggle');
  });

  it('a DECLARED momentary pad outranks everything, roster or not', () => {
    const p: ParamDef = {
      id: 'strike', label: 'Strike', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      options: [{ value: 0, label: 'OFF' }, { value: 1, label: 'HIT' }],
    };
    expect(paramCellKind(p, new Set(['strike']), 'dock')).toBe('momentary');
    expect(paramCellKind(p, new Set(['strike']), 'lane')).toBe('momentary');
  });

  it('landmarks do NOT change the primitive — they only decorate the dial', () => {
    const p: ParamDef = {
      id: 'shape', label: 'Shape', defaultValue: 0, min: 0, max: 2, curve: 'linear',
      landmarks: [{ value: 0, label: 'TRI' }, { value: 1, label: 'SAW' }, { value: 2, label: 'SQR' }],
    };
    expect(paramCellKind(p, none, 'dock')).toBe('knob');
    expect(paramCellKind(p, none, 'lane')).toBe('knob');
  });

  it('the tier argument defaults to `lane` (the conservative answer)', () => {
    expect(paramCellKind({ ...base, options: roster(3) }, none)).toBe('knob');
  });
});
