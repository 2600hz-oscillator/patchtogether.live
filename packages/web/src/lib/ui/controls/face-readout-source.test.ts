// packages/web/src/lib/ui/controls/face-readout-source.test.ts
//
// THE GATE FOR "NO FACE PRINTS A DECIMAL UNDER A CONTROL".
//
// ── THE RULING ─────────────────────────────────────────────────────────────
//
// Owner, 2026-08-17, on the mixmstrs faceplate and then generalised by him to
// the whole roster:
//
//   *"we should kill the light white decimil represebtation of knob state in
//   ALL modules"*
//   *"i want the data gone, not there but hidden or something"*
//   *"as we land new faces they land with that expectation"*
//
// The last sentence is why this file exists rather than a note in a PR. The
// removal itself is one edit; keeping it removed across every face that lands
// afterwards is a gate.
//
// ── WHY IT IS A SOURCE GATE ────────────────────────────────────────────────
//
// The thing being forbidden is an ELEMENT THAT IS NOT THERE. A rendered-page
// gate can only assert absence, and absence is exactly what a broken probe
// also reports — "the readout is gone" and "the sweep never looked" are
// indistinguishable from a green run (CLAUDE.md's blind-gates rule). Reading
// the primitive's source inverts that: the offending construct is a PRESENCE,
// so the gate fails on something it can point at.
//
// It also catches the specific wrong fix. `persistentReadout=false` leaves the
// number one hover away — "there but hidden", which the owner refused by name —
// and a page probe at rest cannot tell that apart from removal. The source can.
//
// ── THE TWO LEGS ───────────────────────────────────────────────────────────
//
// (1) SOURCE. The two dial/throw primitives a faceplate mounts must not carry a
//     resting numeric readout, and `knobValueReadout` (the full ladder) must
//     reach `aria-valuetext` and nothing that paints.
//
// (2) DERIVED. A def can still put a number on a faceplate WITHOUT touching a
//     primitive, by declaring an option/landmark whose LABEL is a number — the
//     one roster that does still paint. Swept over the live registry, both
//     directions, with a NAMED exemption per instance.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ───────────────────────────────
//
//   * ANY OTHER PRIMITIVE. It reads exactly the two files named in
//     `PRIMITIVES`. A new control that paints its own value line is invisible
//     here until someone adds it — which is the honest state, not a claim of
//     completeness. `card-primitive-parity.test.ts` is what enumerates the
//     primitive roster; this gate does not.
//   * LEGACY CARDS. `Fader.svelte`, `Knob.svelte` and the ~200 hand-authored
//     cards print values and are untouched by the ruling, which was about
//     FACEPLATES. Sweeping them would be a different (much larger) decision.
//   * PIXELS. It cannot tell whether the removal LOOKS right. The VRT dock
//     baselines are the only thing that can, and they are a separate lane.
//   * A NUMBER ARRIVING THROUGH `format`. It cannot, by construction —
//     `paintsReadout` refuses a param that declares one — but this gate reads
//     the DEF's rosters, not the render, so if that predicate were ever
//     loosened this leg would keep passing. `knob-vocabulary-model.test.ts`
//     owns that half, with both directions asserted on one function.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { paintsReadout } from './knob-vocabulary-model';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import '$lib/audio/modules';
import '$lib/video/modules';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The primitives a FACEPLATE mounts for a continuous/discrete value cell. Not
 *  the whole primitive roster — see the blind-spot note in the header. */
const PRIMITIVES = ['KnobConic.svelte', 'NeonFader.svelte'] as const;

function source(file: string): string {
  return stripSourceComments(readFileSync(resolve(HERE, file), 'utf8'));
}

describe('face readouts — the resting decimal is REMOVED, not hidden', () => {
  it('no faceplate primitive carries a `persistentReadout` switch', () => {
    // ⚠ THE PROP IS THE OFFENCE, NOT ITS VALUE. A reintroduced
    // `persistentReadout={false}` would render nothing today and be one prop
    // away from rendering everything tomorrow, and it is the exact shape the
    // owner rejected ("not there but hidden"). Deny the switch itself.
    const offenders = PRIMITIVES.filter((f) => /persistentReadout/.test(source(f)));
    expect(
      offenders,
      'a faceplate primitive grew a persistent-readout switch again. The value belongs in ' +
        '`aria-valuetext` (speakable, assertable, unpainted); a prop that toggles a printed ' +
        'decimal is the thing that was removed.',
    ).toEqual([]);
  });

  it('the FULL value ladder reaches `aria-valuetext` and nothing that paints', () => {
    // `knobValueReadout` is the numeric ladder. It has exactly one legitimate
    // consumer in a primitive; anywhere else in these files it is a printed
    // number. Checked per line so the assertion can name the line.
    const offenders: string[] = [];
    for (const file of PRIMITIVES) {
      source(file)
        .split('\n')
        .forEach((line, i) => {
          if (!/knobValueReadout/.test(line)) return;
          // The derivation itself, and the aria binding, are the allowed uses.
          if (/^\s*(let|const)\s|aria-valuetext/.test(line)) return;
          if (/^\s*import\s/.test(line)) return;
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(
      offenders,
      'the numeric ladder is reachable from something other than `aria-valuetext`. If it is ' +
        'painted, it is the decimal the owner removed.',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the source probe can actually find a readout element', () => {
    // The permanent leg. Both assertions above are absences, so on a probe that
    // reads the wrong path (a renamed file, a bad resolve) they pass vacuously
    // and say nothing. This one requires the probe to be READING the primitive:
    // KnobConic does still paint a NAME readout, and its element must be found.
    const knob = source('KnobConic.svelte');
    expect(knob.length, 'the probe read an empty/missing file').toBeGreaterThan(1000);
    expect(
      /class="readout"/.test(knob),
      'KnobConic still paints a NAME readout (options/landmarks) — if this element has gone ' +
        'too, the two absence checks above are no longer evidence of anything',
    ).toBe(true);
    expect(
      /knobNameReadout/.test(knob),
      'and it is fed by the NAME resolver, not the value ladder',
    ).toBe(true);
  });
});

// ── LEG 2 · A LABEL IS NOT A BACK DOOR FOR A NUMBER ────────────────────────
//
// The only roster that still paints is `options` / `landmarks`, and a def is
// free to label one `'0.50'`. That would put a decimal back under a dial
// without touching a primitive, so it is denied by default here.

/**
 * Labels that ARE numbers and are allowed to be, each with the reason the
 * number is the name rather than a reading of the value.
 *
 * ⚠ ANCHORED: an entry naming a `(type, param, label)` triple that no longer
 * exists on the live def is RED, so a rename cannot leave a dead exemption
 * quietly permitting the next one.
 */
const NUMERIC_LABEL_EXEMPTIONS: readonly { type: string; param: string; label: string; why: string }[] = [
  {
    type: 'cofefve',
    param: 'tempoSync',
    label: '1',
    why: 'a musical DIVISION, and the roster it sits in is written the way a delay pedal writes it — `1`, `1/2`, `1/4T`, `1/8.`. The bare `1` is one whole beat; every sibling in the same roster carries a slash and reads as a name for the same reason. It is not a reading of the param, which is a 0..19 index.',
  },
  {
    type: 'slewSwitch',
    param: 'length',
    label: '1',
    why: 'a COUNT of active channels, not a measurement — LENGTH 1 means "hold channel 1 and stop scanning". The integer is what a player says out loud, and there is no name for it that is not the number.',
  },
  {
    type: 'slewSwitch',
    param: 'length',
    label: '2',
    why: 'the same four-state channel count — scan channels 1-2.',
  },
  {
    type: 'slewSwitch',
    param: 'length',
    label: '3',
    why: 'the same four-state channel count — scan channels 1-3.',
  },
  {
    type: 'slewSwitch',
    param: 'length',
    label: '4',
    why: 'the same four-state channel count — scan all four channels.',
  },
  {
    type: 'tidyVco',
    param: 'oct2',
    label: '-1',
    why: 'an OCTAVE switch: the integer IS the state name, the way a transpose control is written on every synth panel. It is not a reading of a continuous value — there are exactly three states and each is spelled by its interval.',
  },
  {
    type: 'tidyVco',
    param: 'oct2',
    label: '0',
    why: 'the centre position of the same three-state octave switch.',
  },
  {
    type: 'tidyVco',
    param: 'oct2',
    label: '+1',
    why: 'the up position of the same three-state octave switch; the sign is part of the name.',
  },
];

/** Every label that could reach a painted readout, as `(type, param, label)`. */
function paintableLabels(): { type: string; param: string; label: string }[] {
  const defs = [
    ...(listModuleDefs() as unknown as { type: string; params?: readonly unknown[]; face?: unknown }[]),
    ...(listVideoModuleDefs() as unknown as { type: string; params?: readonly unknown[]; face?: unknown }[]),
    ...(listMetaModuleDefs() as unknown as { type: string; params?: readonly unknown[]; face?: unknown }[]),
  ];
  const out: { type: string; param: string; label: string }[] = [];
  for (const def of defs) {
    if (!def.face) continue;
    for (const raw of def.params ?? []) {
      const p = raw as {
        id: string;
        options?: readonly { label: string }[];
        landmarks?: readonly { label?: string }[];
        format?: unknown;
      };
      if (!paintsReadout(p as never)) continue;
      for (const entry of [...(p.options ?? []), ...(p.landmarks ?? [])]) {
        const label = (entry as { label?: string }).label;
        if (label) out.push({ type: def.type, param: p.id, label });
      }
    }
  }
  return out;
}

/** Does this label read as a bare number — i.e. a decimal representation of
 *  state rather than a name for it? Signs and a leading `x`/`×` count as part
 *  of the number; a unit suffix does NOT rescue it (`450 ms` is what came off
 *  the panel). */
function looksNumeric(label: string): boolean {
  return /^[+\-−]?[0-9]+(\.[0-9]+)?\s*[a-zA-Z%°¢×x]{0,3}$/.test(label.trim());
}

describe('face readouts — a painted LABEL is a name, not a number', () => {
  it('no face paints a numeric label except the NAMED exemptions', () => {
    const exempt = new Set(
      NUMERIC_LABEL_EXEMPTIONS.map((e) => `${e.type}/${e.param}/${e.label}`),
    );
    const offenders = paintableLabels()
      .filter((l) => looksNumeric(l.label))
      .map((l) => `${l.type}/${l.param}/${l.label}`)
      .filter((k) => !exempt.has(k));
    expect(
      [...new Set(offenders)].sort(),
      'an option/landmark LABEL that reads as a number will be PAINTED under the dial, which ' +
        'is the decimal representation of knob state the owner removed. Either name the state ' +
        '(`TRI`, `WET`, `SR/2`) or add a NUMERIC_LABEL_EXEMPTIONS entry saying why the number ' +
        'IS the name.',
    ).toEqual([]);
  });

  it('ANCHOR: every exemption still names a live label — a dead entry is RED', () => {
    const live = new Set(paintableLabels().map((l) => `${l.type}/${l.param}/${l.label}`));
    const dead = NUMERIC_LABEL_EXEMPTIONS.map((e) => `${e.type}/${e.param}/${e.label}`).filter(
      (k) => !live.has(k),
    );
    expect(
      dead,
      'an exemption names a (module, param, label) that no longer paints. Delete it — a stale ' +
        'entry silently permits whatever takes its name next.',
    ).toEqual([]);
  });

  it('every exemption carries a REASON, not a shrug', () => {
    const thin = NUMERIC_LABEL_EXEMPTIONS.filter((e) => e.why.trim().length < 40).map(
      (e) => `${e.type}/${e.param}/${e.label}`,
    );
    expect(thin, 'an exemption without a stated reason is a suppression').toEqual([]);
  });

  it('NEGATIVE CONTROL: the sweep found labels, and the predicate discriminates', () => {
    // Anti-vacuity in both directions. `paintableLabels()` returning [] would
    // green the whole describe; `looksNumeric` returning false for everything
    // would too.
    const labels = paintableLabels();
    expect(labels.length, 'no face declares a paintable label — the sweep probed nothing').toBeGreaterThan(0);
    expect(labels.some((l) => !looksNumeric(l.label)), 'no NAME-shaped label found').toBe(true);
    expect(['0.50', '-12', '450 ms', '2.00'].every(looksNumeric), 'the predicate misses numbers').toBe(true);
    expect(['TRI', 'WET', 'SR/2.0', 'MASSPASS'].some(looksNumeric), 'the predicate eats names').toBe(false);
  });
});
