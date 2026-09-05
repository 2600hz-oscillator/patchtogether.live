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
//   * THE PRIMITIVES THEMSELVES. `Fader.svelte` and `Knob.svelte` print values
//     on drag/hover and are untouched by the ruling, which was about what a
//     faceplate paints AT REST.
//   * PIXELS. It cannot tell whether the removal LOOKS right. The VRT dock
//     baselines are the only thing that can, and they are a separate lane.
//   * A NUMBER ARRIVING THROUGH `format`. It cannot, by construction —
//     `paintsReadout` refuses a param that declares one — but this gate reads
//     the DEF's rosters, not the render, so if that predicate were ever
//     loosened this leg would keep passing. `knob-vocabulary-model.test.ts`
//     owns that half, with both directions asserted on one function.
//     ⚠ There is a LIVE param sitting behind exactly that door:
//     `warrensspectrum/spectralBandCount` declares options labelled
//     `16 / 24 / 33 / 48 / 66 / 99` and is invisible to Leg 2 ONLY because it
//     also declares a `format`. Removing that `format` would put six numbers
//     under a dial and this gate would go red — which is the correct outcome,
//     and is recorded here so the next reader knows the quiet case exists.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { paintsReadout } from './knob-vocabulary-model';
// The PPQN roster itself, so the exemptions below are derived from the same
// constant the param is built from rather than re-typed beside it.
import { CV_BUDDY_PPQN_CHOICES } from '$lib/audio/modules/cv-buddy';
// The twelve clock divisions `swingSource` selects — derived from timelorde's
// own output fanout, so this exemption cannot drift from the jacks it names.
import { TIMELORDE_SWING_SOURCES } from '$lib/audio/modules/timelorde';
// The BAND-STEP roster, imported for the same reason as the PPQN one above:
// cellshade's exemptions are DERIVED from the array its options are built from,
// so the two cannot drift apart.
import { CELLSHADE_BAND_STEPS } from '$lib/video/modules/cellshade';
// The four controller-slot indices `padIndex` selects — derived from the def's
// own `min`/`max` span, so the exemption cannot outlive the roster it names.
import { GAMEPAD_SLOT_OPTIONS } from '$lib/audio/modules/gamepad';
// ⚠ THE DEF ITSELF, not an exported roster constant. mappy is in the WebGL
// attest basis, where an exported constant moves the content hash and an
// accessor does not — and reading the live `options` is also the stronger form
// the blocks above reach for by importing their source arrays.
import { mappyDef } from '$lib/video/modules/mappy';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import '$lib/audio/modules';
import '$lib/video/modules';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The primitives a FACEPLATE mounts for a continuous/discrete value cell. Not
 *  the whole primitive roster — see the blind-spot note in the header.
 *
 * ⚠ `XyPad.svelte` JOINED THIS LIST ON 2026-08-22 (#1972), AND THE LIST WAS THE
 * DEFECT. The pad is a faceplate value cell — `ModuleShell`'s `xy` branch
 * mounts it, and `backdraft` has declared two of them since the first video
 * face — and it was absent here, so this gate was GREEN AND HAD NEVER LOOKED AT
 * THE FILE. That is the blind-gate shape CLAUDE.md is about, with a file list
 * as the filter that quietly redefines the subject.
 *
 * ⚠ AND ADDING THE NAME ALONE WOULD HAVE BEEN DECORATION. Both legs above key
 * on `knobValueReadout`, which the pad does not use — it formats its own value
 * with a local `fmt`. So a bare append would have made the roster look complete
 * while measuring exactly nothing new. `PRIMITIVE_VALUE_LADDERS` below names
 * the formatter each primitive actually uses, and the leg runs over THAT.
 */
const PRIMITIVES = ['KnobConic.svelte', 'NeonFader.svelte', 'XyPad.svelte'] as const;

/**
 * The value-formatting ladder each primitive really calls, and the ONE binding
 * it is allowed to reach.
 *
 * The rule is the same for all three and it is the ruling itself: a primitive
 * may FORMAT its value only to hand it to the ACCESSIBLE NAME. Any other use is
 * a printed number.
 *
 * ⚠ THE ACCESSIBLE BINDING DIFFERS BY ROLE, and that is not a loophole — it is
 * what the roles permit. A knob and a fader are `role="slider"`, whose value
 * lives in `aria-valuetext`. A pad is `role="application"` — the correct role
 * for a 2-D manipulation surface that owns its own handling — and
 * `aria-valuetext` is only meaningful on a RANGE role, so its accessible value
 * lives in `aria-label`. `XyPad.svelte` records the same conclusion where #2038
 * deleted its readout row. Hard-coding `aria-valuetext` for all three would
 * have made the pad unable to satisfy a gate written for a role it does not
 * have, and the likely "fix" would have been to give the pad two `role="slider"`
 * children — the "the visible thing and the operable thing are two different
 * elements" shape `faces-parity` exists to outlaw.
 */
interface ValueLadderRule {
  /** The identifier the MARKUP would reference to paint this primitive's value.
   *  Not the script-side formatter — a derivation is free; a text node is not. */
  value: RegExp;
  /** The accessible binding this primitive's ROLE permits, which must exist. */
  aria: RegExp;
  /** A PAINTED use that is not resting text, with the guard that makes it
   *  transient. Both halves are asserted: the line is allowed, AND the guard
   *  must appear in the markup, so removing the guard reddens. */
  transient?: { line: RegExp; guard: RegExp; why: string };
  why: string;
}

const PRIMITIVE_VALUE_LADDERS: Readonly<
  Record<(typeof PRIMITIVES)[number], ValueLadderRule>
> = {
  'KnobConic.svelte': {
    value: /\bspokenValue\b/,
    aria: /aria-valuetext/,
    why:
      'role="slider": `knobValueReadout` derives the numeric ladder in the script and the markup '
      + 'references it ONLY as `spokenValue`, bound to aria-valuetext. The `.readout` div beside '
      + 'it is a different variable (`readout`, from `knobNameReadout`) and paints an option / '
      + 'landmark NAME, which is permitted resting text — a name disambiguates otherwise '
      + 'identical dial positions, a number restates the dial.',
  },
  'NeonFader.svelte': {
    value: /\breadoutText\b/,
    aria: /aria-valuetext/,
    transient: {
      line: /class="value-tag"/,
      guard: /\{#if\s+dragging\s*\|\|\s*hovering\s*\}/,
      why:
        'the drag/hover VALUE TAG. It is not resting text — it requires a pointer on the control '
        + 'and vanishes when the pointer leaves — and it is the documented survivor of the '
        + '2026-08-17 removal ("the value is speakable, assertable, and visible WHILE YOU SET IT '
        + '— it just does not sit on the panel at rest"). The guard is asserted rather than '
        + 'trusted: an unguarded `.value-tag` is exactly the resting decimal that was deleted.',
    },
    why:
      'role="slider". ⚠ THIS ENTRY IS ALSO A CORRECTION: the previous leg keyed on '
      + '`knobValueReadout`, which NeonFader does not call at all — it formats through '
      + '`formatParamNumber` into `readoutText` — so the roster named this file while the check '
      + 'matched nothing in it. A second instance of the same blind spot #1972 found on XyPad, '
      + 'in the file sitting next to it.',
  },
  'XyPad.svelte': {
    value: /\bariaLabel\b/,
    aria: /aria-label/,
    why:
      'role="application": a LOCAL `fmt` (2 dp under 10) formats both axes into `ariaLabel`, the '
      + "pad's accessible NAME. There is no aria-valuetext on this role to move it to (that "
      + 'attribute is only meaningful on a RANGE role), so aria-label is where the value lives '
      + 'and is what every spec proving a pad tracks the graph reads. #2038 deleted the painted '
      + 'row; #1972 is why this file is in the roster at all.',
  },
};

/** The MARKUP half of a `.svelte` file — everything after the closing script
 *  tag. A derivation is free; what reaches a text node is the question. */
function markup(file: string): string {
  const src = source(file);
  const i = src.indexOf('</script>');
  return i >= 0 ? src.slice(i) : src;
}

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

  it('the value reaches the ACCESSIBLE NAME and nothing that rests on the plate', () => {
    // Each primitive's value text has exactly one legitimate consumer in the
    // MARKUP: the accessible binding its ROLE permits. Anywhere else it is a
    // painted number — unless it is a declared TRANSIENT (NeonFader's drag/hover
    // tag), which carries its own asserted guard. Checked per line so the
    // assertion can name the line.
    const offenders: string[] = [];
    for (const file of PRIMITIVES) {
      const rule = PRIMITIVE_VALUE_LADDERS[file];
      markup(file)
        .split('\n')
        .forEach((line, i) => {
          if (!rule.value.test(line)) return;
          if (rule.aria.test(line)) return;
          if (rule.transient?.line.test(line)) return;
          offenders.push(`${file} markup+${i}: ${line.trim()}`);
        });
    }
    expect(
      offenders,
      "a primitive's value text reaches the markup somewhere other than the accessible name its " +
        'role permits. If it paints at rest, it is the decimal the owner removed.',
    ).toEqual([]);
  });

  it('every PRIMITIVE declares the value binding this gate checks it on', () => {
    // ⚠ THE ANTI-DECORATION LEG (#1972), and it found a second defect on its
    // first run. Adding a filename to `PRIMITIVES` without saying which
    // identifier carries its value would make the roster look complete while
    // the leg above skipped the file entirely — which is how `XyPad` sat
    // outside this gate while `backdraft` painted four resting decimals, AND
    // how `NeonFader` sat inside it measuring nothing (the old leg keyed on
    // `knobValueReadout`, which NeonFader does not call). A declaration is
    // required, its `why` must be an argument rather than a word, and every
    // regex it names must actually MATCH the file it names — which is the leg
    // that catches both failure modes.
    const problems: string[] = [];
    for (const file of PRIMITIVES) {
      const rule = PRIMITIVE_VALUE_LADDERS[file];
      if (!rule) { problems.push(`${file}: no PRIMITIVE_VALUE_LADDERS entry`); continue; }
      if (rule.why.trim().length < 40) problems.push(`${file}: \`why\` is a placeholder, not an argument`);
      const mk = markup(file);
      if (!rule.value.test(mk)) {
        problems.push(
          `${file}: declares value binding ${rule.value} but the MARKUP never references it — ` +
            'either the primitive stopped surfacing its value (in which case the aria leg below ' +
            'is the one that should be red) or the entry names the wrong identifier and this ' +
            'gate has been checking nothing, which is the exact defect it exists to prevent.',
        );
      }
      if (!rule.aria.test(mk)) {
        problems.push(
          `${file}: declares accessible binding ${rule.aria} but the markup has none — the ` +
            'value would be neither painted NOR speakable, which is not what the ruling asked ' +
            'for ("the data gone" means unpainted, not unobservable).',
        );
      }
      if (rule.transient) {
        if (rule.transient.why.trim().length < 40) {
          problems.push(`${file}: the transient allowance carries no argument`);
        }
        if (!rule.transient.line.test(mk)) {
          problems.push(
            `${file}: declares a transient painted use (${rule.transient.line}) that no longer ` +
              'exists — delete the allowance rather than leaving a permission behind for the ' +
              'next thing that matches it.',
          );
        }
        if (!rule.transient.guard.test(mk)) {
          problems.push(
            `${file}: the transient painted use is NOT GUARDED by ${rule.transient.guard}. ` +
              'Without the guard it is resting text, which is precisely the decimal that was ' +
              'deleted — an allowance for a transient must be able to fail when it stops being ' +
              'transient.',
          );
        }
      }
    }
    expect(problems.join('\n')).toBe('');
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
 *
 * ⚠ POPULATE IT FROM A SWEEP, NOT FROM THE RED LINE. When this list grew for
 * backdraft it was tempting to add the five labels the assertion happened to
 * print and stop. The whole registry was swept instead — every def, faced or
 * not, every `options`/`landmarks` label through this file's own
 * `looksNumeric` + `paintsReadout` — and it returns exactly five params:
 * `cofefve/tempoSync`, `slewSwitch/length`, `tidyVco/oct2`,
 * `backdraft/flicker`, and `warrensspectrum/spectralBandCount` (the last one
 * masked by a declared `format`, see the header). The first four are this
 * list; the fifth is the blind spot named above. So the answer today really is
 * "the red one and nothing else" — but it is a MEASURED answer, and the sweep
 * is four lines of the same two predicates whenever it needs re-running.
 */
const NUMERIC_LABEL_EXEMPTIONS: readonly { type: string; param: string; label: string; why: string }[] = [
  // ── CV BUDDY / CV BUDDY MINI · `ppqn` (2026-08-21, Q52) ──────────────────
  //
  // ⚠ DERIVED FROM THE ROSTER, not typed out seven times per kind, and that is
  // the stronger form rather than the lazier one. The labels here are
  // `String(n)` BY CONSTRUCTION — `CV_BUDDY_PPQN_PARAM` builds its options by
  // mapping the exported `CV_BUDDY_PPQN_CHOICES` — so a hand-typed list would
  // be a second copy of a roster that already exists, free to go stale in the
  // direction that FAILS OPEN: a value added to the roster and forgotten here
  // reddens, but a value REMOVED leaves a dead entry the anchor leg then has to
  // catch. Deriving makes both impossible.
  //
  // What it pre-approves is exactly right and no more: every label in THIS
  // roster, because that roster's labels cannot be anything but the number.
  // ⚠ It does NOT pre-approve the param — `optionsExhaustive` (#2055) declares
  // these seven to be the whole legal set, so a new member is a deliberate
  // contract edit that lands with its own argument, not a quiet addition.
  ...CV_BUDDY_PPQN_CHOICES.flatMap((n) =>
    (['cvBuddy', 'cvBuddyMini'] as const).map((type) => ({
      type,
      param: 'ppqn',
      label: String(n),
      why:
        `PULSES PER QUARTER NOTE — ${n} is not a reading of the dial, it is what the division is `
        + 'CALLED. A player says "run it at 24 ppqn" out loud, gear is sold with "24 ppqn" printed '
        + 'on it, and 24 in particular IS the DIN-sync standard; there is no name for the state '
        + 'that is not the integer, and inventing one ("standard", "half") would be the '
        + 'vocabulary-invention the moog904c review declined. The roster is also what makes each '
        + 'state reachable at all: it is a sparse legal set inside a 1..48 range, so without it '
        + 'the control is a 48-position dial of which 41 positions are values this module has no '
        + 'meaning for (#2024, fixed by #2055).',
    })),
  ),
  // ── TIMELORDE · `swingSource` (2026-08-23) ───────────────────────────────
  //
  // ⚠ DERIVED FROM THE ROSTER for the cvBuddy reason, and here the derivation is
  // two levels deep: `TIMELORDE_SWING_SOURCES` is itself computed from the def's
  // OUTPUT FANOUT (each option's label IS a gate port's id), because the twelve
  // divisions and their ORDER are pinned to the DSP's `OUT_*` indices. Typing
  // twelve labels here would be a third copy of a list the module already
  // refuses to let anyone re-state.
  //
  // Four of the twelve read as numeric to this gate (`1x`, `2x`, `4x`, `8x`);
  // the rest carry a slash and read as names already. Mapping the WHOLE roster
  // is deliberate and matches cvBuddy: the anchor leg below requires every
  // exemption to name a label that really paints, so an over-broad entry cannot
  // hide — and a division renamed at the def would redden here rather than
  // silently losing its approval.
  ...TIMELORDE_SWING_SOURCES.map((o) => ({
    type: 'timelorde',
    param: 'swingSource',
    label: o.label,
    why:
      `a musical DIVISION of the master clock — \`${o.label}\` is not a reading of the dial, it is `
      + 'what the division is CALLED, and it is the id of the gate OUTPUT that carries it. A '
      + 'player patches "the 4x out" and swings "the 4x train"; the two must print the same word '
      + 'or the selector stops naming anything a cable can be found by. There is no name that is '
      + 'not this one, and inventing one ("sixteenths") would be the vocabulary invention the '
      + 'moog904c review declined — and would then disagree with the jack it points at. The '
      + 'param itself is a 0..11 INDEX, which is exactly what the roster exists to stop the face '
      + 'painting.',
  })),
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
    type: 'moog962',
    param: 'stages',
    label: '2',
    why: 'a COUNT of sequencer stages, the slewSwitch/length case exactly: STAGES 2 means "alternate IN 1 and IN 2, ignoring IN 3". The integer is what a player says out loud and there is no name for the state that is not the number — naming it would mean inventing one. ⚠ The roster exists for SELECTABILITY, not decoration: a 2..3 discrete param drawn as a knob has two reachable positions across the whole dial, so a drag quantises back to where it started and the control is inert. faces-parity caught exactly that on this param.',
  },
  {
    type: 'moog962',
    param: 'stages',
    label: '3',
    why: 'the other half of the same two-state stage count — rotate IN 1 → IN 2 → IN 3 → IN 1. Same reasoning as its sibling: the number IS the name, and the roster is what makes each state directly reachable rather than a position a drag cannot land on.',
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
  // ── FLICKER · a DISPLAY REFRESH RATE is spoken as its number ────────────
  //
  // The six positions are `OFF, 6, 24, 50, 60, 120` and the five numeric ones
  // are FRAME RATES, not a reading of the param — the param is a 0..5 index and
  // the label is not derived from it (position 4 is labelled `60` and emits
  // 59.94 Hz, position 5 is `120` and emits 119.88 Hz; see
  // `BACKDRAFT_FLICKER_HZ`, which deliberately uses the NTSC 60000/1001 rate so
  // the beat against the 60 fps virtual camera does not genlock). A label that
  // does not track the value cannot be a decimal representation of it.
  //
  // They are also the case the ban is FOR permitting rather than catching: a
  // refresh rate has no name that is not its number. "cinema" for 24 and
  // "PAL" for 50 exist, but 6, 60 and 120 have none, and half a roster spelled
  // in prose and half in digits is less readable than the panel convention
  // every camera, projector and monitor already uses.
  {
    type: 'backdraft',
    param: 'flicker',
    label: '6',
    why: 'a display FRAME RATE in Hz — the sub-refresh position, modelling a slow strobe/BFI/dimmer below the 60 fps virtual camera. There is no name for "six hertz" that is not the number, and the label does not track the param (a 0..5 index), so it is not a reading of state.',
  },
  {
    type: 'backdraft',
    param: 'flicker',
    label: '24',
    why: 'the same frame-rate roster — CINEMA. The number is how the rate is spoken on every camera and projector, and writing it as a word here while 6/60/120 stay numeric would make one roster two vocabularies.',
  },
  {
    type: 'backdraft',
    param: 'flicker',
    label: '50',
    why: 'the same frame-rate roster — the PAL/SECAM field rate and 50 Hz mains. Same argument: the number is the name, and it is what a shooter says out loud when picking a shutter against a 50 Hz supply.',
  },
  {
    type: 'backdraft',
    param: 'flicker',
    label: '60',
    why: 'the same frame-rate roster — the NTSC field rate. ⚠ It EMITS 59.94 Hz (60000/1001), not 60.000, so the label is provably a NAME for the standard rather than a printed reading of what the param is worth.',
  },
  {
    type: 'backdraft',
    param: 'flicker',
    label: '120',
    why: 'the same frame-rate roster — a 120 Hz panel (or double-strobed 60). Emits 119.88 Hz for the same NTSC reason as the 60 position, so it too names a standard rather than reporting a value.',
  },
  // ── CELLSHADE · `bits` (2026-08-22, batch-21) ────────────────────────────
  //
  // ⚠ DERIVED FROM `CELLSHADE_BAND_STEPS`, the array the param's options are
  // built from and the array the shader's quantiser indexes — the same stronger
  // form the PPQN block above uses, for the same reason: a hand-typed copy
  // could go stale in the direction that fails OPEN.
  //
  // The `slewSwitch/length` entries are the closest precedent and the argument
  // is theirs: this is a COUNT, not a measurement. BANDS 4 means "collapse the
  // luma into four flat tonal steps"; a player says "four bands" out loud, and
  // there is no name for the state that is not the integer. Inventing one
  // ("coarse" / "fine") would be exactly the vocabulary-invention the moog904c
  // review declined.
  //
  // ⚠ AND THE ALTERNATIVE HERE IS NOT "NO LABEL", IT IS A WRONG ONE. `bits`
  // stores an INDEX 0..4 while the picture shows 2/3/4/6/8 bands, and the
  // card's `formatValue` bridge is a card-side prop `ModuleShell` does not
  // pass. Without this roster `NeonFader`'s readout falls back to
  // `format(v, units)` and `aria-valuetext` announces the INDEX — the face
  // would say "2" while four bands are on screen. So the number painted here
  // REPLACES a wrong number rather than adding one.
  ...CELLSHADE_BAND_STEPS.map((bands) => ({
    type: 'cellshade',
    param: 'bits',
    label: String(bands),
    why:
      `BAND COUNT — ${bands} is not a reading of the dial (that is an index 0..4), it is what the `
      + 'state IS: the luma collapsed into '
      + `${bands} flat tonal steps. A player says "${bands} bands" out loud, the param is labelled `
      + 'BANDS, and the def\'s own docs describe the control as picking 2/3/4/6/8. There is no '
      + 'name for it that is not the integer, and inventing one would be vocabulary-invention.',
  })),
  // ── GAMEPAD · `padIndex` (2026-08-24) ────────────────────────────────────
  //
  // ⚠ DERIVED FROM `GAMEPAD_SLOT_OPTIONS`, the roster the def builds from its
  // own `min`/`max` span — the same stronger form the PPQN and BANDS blocks use,
  // and here the derivation goes one step further: those labels are
  // `String(value)` BY CONSTRUCTION, so a hand-typed copy could not even be
  // wrong in an interesting way, only stale.
  //
  // ⚠ THIS IS THE ONE ENTRY WHERE "INVENT A NAME" IS NOT MERELY DECLINED, IT IS
  // FORBIDDEN BY THE PLATFORM. The other numeric rosters at least HAVE candidate
  // names somebody could argue for (`cinema` for 24 fps, `coarse` for 2 bands).
  // Here there is nothing to name: the Web Gamepad spec exposes up to four pads
  // and indexes them 0..3, and NOTHING says which controller is in which slot
  // until you select one and read `pad.id` back. `Player 1` would be a fact the
  // API does not provide; a device name would be a runtime value this label
  // cannot hold. The index IS the state, it is what this module's four buttons
  // have always printed, and it is what a player says out loud ("try
  // slot 2").
  //
  // ⚠ AND THE ROSTER EXISTS FOR SELECTABILITY, NOT DECORATION — the moog962
  // argument, one state wider. `padIndex` is `0..3 discrete`: drawn as a bare
  // dial it has four reachable positions across the whole travel, so every drag
  // lands on a quantisation boundary and the control is inert while every
  // def-reading gate stays green. `gamepad-face-model.test.ts` proves it by
  // stripping the roster and re-running the resolver.
  ...GAMEPAD_SLOT_OPTIONS.map((o) => ({
    type: 'gamepad',
    param: 'padIndex',
    label: o.label,
    why:
      `a CONTROLLER SLOT INDEX — ${o.label} is not a reading of the dial, it is the slot's own `
      + 'address in `navigator.getGamepads()`. The Web Gamepad spec allows four simultaneous pads '
      + 'and identifies them ONLY by index; nothing reports which controller sits in which slot '
      + 'until one is selected and its `pad.id` is read back, so there is no name for this state '
      + 'that is not the integer and inventing one ("Player 1") would assert a fact the platform '
      + 'does not provide. This module has always printed exactly these four glyphs.',
  })),
  // ── MAPPY · `surfaceCount` (2026-09-01, wave 4) ──────────────────────────
  //
  // ⚠ DERIVED FROM THE LIVE DEF, which is one step stronger than the imported
  // arrays above: it reads the roster the shell will actually paint, so this
  // block cannot go stale in the direction that fails OPEN and it costs the def
  // no exported constant (the `paramSpec` discipline — an export off a def in
  // the WebGL attest basis moves the hash, an accessor does not).
  //
  // The `cellshade/bits` and `slewSwitch/length` argument, verbatim: this is a
  // COUNT, not a measurement. SURFACES 3 means "three live projection surfaces,
  // each with its own quad and its own input"; a player says "three surfaces"
  // out loud, and there is no name for the state that is not the integer.
  // Inventing one would be the vocabulary-invention the moog904c review
  // declined.
  //
  // ⚠ AND THE ROSTER EXISTS FOR THE READOUT AND THE AFFORDANCE TOGETHER. The
  // module has always painted the live count as a number between its −/+
  // buttons (`mappy-count-n`), and `paintsReadout` refuses a `format` — so
  // WITHOUT the
  // roster the promoted lane tile would show a dial with no number on it, and
  // the count would be reachable and unreadable. With it the dock paints a
  // six-state `Segmented` row (the honest replacement for a stepper) and the
  // lane dial prints the count. The number here is not an addition to the
  // faceplate's text, it is the card's own readout surviving promotion.
  ...(((mappyDef.params ?? []).find((p) => p.id === 'surfaceCount')?.options ?? []) as readonly { label: string }[])
    .map((o) => ({
      type: 'mappy',
      param: 'surfaceCount',
      label: o.label,
      why:
        `a SURFACE COUNT — ${o.label} is not a reading of the dial, it is what the state IS: `
        + `${o.label} live projection surface${o.label === '1' ? '' : 's'}, each warped onto its own `
        + 'quad and fed by its own input. A player says the number out loud while aligning a venue, '
        + 'this module prints exactly this glyph between its −/+ buttons, and there is no name '
        + 'for "three surfaces" that is not the integer.',
    })),
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
