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
// The ONE snap implementation, and the readout resolver it shares — the
// exhaustive-roster clauses assert the two agree rather than trusting it.
import { snapToOptions, knobNameReadout } from '$lib/ui/controls/knob-vocabulary-model';
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
    //
    // ⚠ UNLESS THE ROSTER **IS** THE REACHABLE SET. A param declaring
    // `optionsExhaustive` inverts the premise above: its gaps are not unnamed
    // states, they are values the module has no meaning for, and it SNAPS so
    // they cannot be held. That satisfies this rule's actual purpose — no
    // reachable state is unnameable — by shrinking the reachable set instead of
    // growing the roster. The exemption is DECLARED (a required `why` on the
    // type), and the clauses below are what make it stronger than this one
    // rather than a way around it.
    const bad: string[] = [];
    for (const { type, p } of allParams()) {
      if (!p.options?.length) continue;
      if (p.optionsExhaustive) continue;
      const steps = Math.round(p.max - p.min) + 1;
      if (p.options.length !== steps) {
        bad.push(`${type}.${p.id}: ${p.options.length} options for ${steps} discrete steps (${p.min}..${p.max})`);
      }
    }
    expect(bad, 'every reachable state of a discrete param must be named').toEqual([]);
  });

  // ── THE EXHAUSTIVE-ROSTER FORM (sparse `options`) ─────────────────────────
  //
  // Deny-by-default: the declaration buys an exemption from the every-step rule
  // and pays for it with stricter obligations, asserted here. ⚠ A param that
  // declares it and does NOT snap is worse than one that never declared it —
  // it would hold values its own roster says do not exist while the picker
  // claims otherwise.

  it('an exhaustive roster is SPARSE, in-range, unique and fully labeled', () => {
    const bad: string[] = [];
    for (const { type, p } of allParams()) {
      if (!p.optionsExhaustive) continue;
      const opts = p.options ?? [];
      if (!opts.length) {
        bad.push(`${type}.${p.id}: declares optionsExhaustive with NO options roster`);
        continue;
      }
      if (p.curve !== 'discrete') bad.push(`${type}.${p.id}: exhaustive roster on a ${p.curve} curve`);
      const steps = Math.round(p.max - p.min) + 1;
      if (opts.length === steps) {
        // Not an error in spirit, but it means the declaration bought nothing —
        // and an exemption nobody needs is one nobody is watching.
        bad.push(
          `${type}.${p.id}: roster covers every step (${opts.length}/${steps}), so optionsExhaustive is redundant — delete it`,
        );
      }
      for (const o of opts) {
        if (o.value < p.min || o.value > p.max) bad.push(`${type}.${p.id}: option ${o.label}=${o.value} ∉ [${p.min},${p.max}]`);
        if (!o.label.trim()) bad.push(`${type}.${p.id}: blank label on ${o.value}`);
        if (!Number.isInteger(o.value)) bad.push(`${type}.${p.id}: non-integer option ${o.value} on a discrete param`);
      }
      if (new Set(opts.map((o) => o.value)).size !== opts.length) {
        bad.push(`${type}.${p.id}: duplicate option value`);
      }
      // The `why` is required by the type; this refuses the one-word placeholder
      // that satisfies tsc and says nothing.
      const why = p.optionsExhaustive.why ?? '';
      if (why.trim().split(/\s+/).length < 8) {
        bad.push(`${type}.${p.id}: optionsExhaustive.why is a placeholder — say why the GAPS are meaningless`);
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('SNAPPING is TOTAL and EXACT — both directions, on every exhaustive roster', () => {
    // The obligation the exemption buys. Asserted on the live defs rather than
    // a fixture, so a real roster that stopped snapping is what goes red.
    const bad: string[] = [];
    for (const { type, p } of allParams()) {
      if (!p.optionsExhaustive) continue;
      const opts = p.options ?? [];
      if (!opts.length) continue;

      // DIRECTION 1 — a legal value passes through EXACT, by identity. If this
      // failed, snapping would perturb settings a user deliberately chose.
      for (const o of opts) {
        const out = snapToOptions(o.value, opts);
        if (out !== o.value) bad.push(`${type}.${p.id}: legal ${o.value} snapped to ${out}`);
      }

      // DIRECTION 2 — EVERY integer in the declared span lands on a MEMBER.
      // This is the leg that makes "the roster is the legal set" true rather
      // than asserted: it walks the whole reachable span, including the 41
      // illegal ppqn positions this form exists for.
      const members = new Set(opts.map((o) => o.value));
      for (let v = p.min; v <= p.max; v++) {
        const out = snapToOptions(v, opts);
        if (!members.has(out)) bad.push(`${type}.${p.id}: ${v} snapped to ${out}, which is not a roster member`);
      }
      // …and outside it, since CV/automation/a legacy save can hand over
      // anything at all.
      for (const v of [p.min - 100, p.max + 100, 0, -1, NaN]) {
        const out = snapToOptions(v, opts);
        if (!Number.isNaN(v) && !members.has(out)) {
          bad.push(`${type}.${p.id}: out-of-range ${v} snapped to ${out}, not a member`);
        }
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('NEGATIVE CONTROL — the snap clauses fire on a roster that does NOT snap', () => {
    // ⚠ Every leg above passes vacuously if no def declares the form, and would
    // pass identically against a `snapToOptions` that returned its input. Both
    // failure modes are closed here: a synthetic sparse roster is walked with
    // the REAL resolver, and an identity "snap" is shown to be caught.
    const roster = [1, 2, 4, 8, 12, 24, 48].map((v) => ({ value: v, label: String(v) }));
    const members = new Set(roster.map((o) => o.value));

    // The real one lands every illegal integer on a member…
    const offRoster = [3, 5, 6, 7, 9, 13, 25, 47];
    for (const v of offRoster) expect(members.has(snapToOptions(v, roster)), `snap(${v})`).toBe(true);
    // …and leaves legal ones untouched.
    for (const o of roster) expect(snapToOptions(o.value, roster)).toBe(o.value);

    // The identity stand-in does NOT — which is what the sweep above would be
    // silently accepting if `snapToOptions` ever regressed to a passthrough.
    const identity = (v: number) => v;
    expect(offRoster.some((v) => !members.has(identity(v)))).toBe(true);

    // NON-VACUITY: at least one live param actually declares the form, or the
    // sweeps above probed nothing at all.
    const adopters = allParams().filter(({ p }) => p.optionsExhaustive);
    expect(
      adopters.length,
      'no param declares optionsExhaustive — the sweeps above are vacuous',
    ).toBeGreaterThan(0);
  });

  it('NEAREST, not floor — display and snap resolve identically', () => {
    // The documented rounding decision, held so it cannot drift apart from the
    // readout. A floor-snapping value would SHOW one member and STORE another.
    const roster = [1, 2, 4, 8, 12, 24, 48].map((v) => ({ value: v, label: String(v) }));
    expect(snapToOptions(7, roster)).toBe(8);   // nearest (1 away) not floor (4)
    expect(snapToOptions(5, roster)).toBe(4);   // nearest below
    expect(snapToOptions(30, roster)).toBe(24);
    expect(snapToOptions(40, roster)).toBe(48);
    // A tie resolves to the EARLIER member, deterministically.
    expect(snapToOptions(3, roster)).toBe(2);   // 2 and 4 are both 1 away
    // And the readout agrees with the snap on every one of those.
    for (const v of [7, 5, 30, 40, 3]) {
      expect(knobNameReadout(v, { options: roster })).toBe(String(snapToOptions(v, roster)));
    }
  });

  it('a declared `format` (PF-3) is TOTAL — never throws, never returns empty', () => {
    // `format` runs on EVERY animation frame while a value moves (KnobConic's
    // readLive tick) and its output is ALSO the dial's aria-valuetext. A throw
    // kills the frame; an empty string renders an invisible readout that reads
    // exactly like "this param declared no vocabulary". Probe the declared
    // range AND the values a live/engine read can legitimately hand back
    // before the node has booted (undefined→NaN, an unclamped CV sum).
    // ⚠ A ZERO-ITERATION SWEEP IS A GREEN THAT MEANS NOTHING. `format` has few
    // consumers, so `if (!p.format) continue` turns this whole test into a
    // no-op the moment the last one is deleted — a gate that cannot fail on
    // the thing it is named after. Floor it: at least one param in the live
    // registry must actually declare a formatter for the sweep to have run.
    const withFormat = allParams().filter(({ p }) => p.format);
    expect(
      withFormat.length,
      'no param declares a `format` — this totality sweep just probed nothing',
    ).toBeGreaterThan(0);

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
