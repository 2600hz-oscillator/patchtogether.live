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
// ── THE LEGS ───────────────────────────────────────────────────────────────
//
// (1) SOURCE. A faceplate primitive must not carry a resting numeric readout,
//     and `knobValueReadout` (the full ladder) must reach an aria value
//     attribute and nothing that paints.
//
// (2) DERIVED. A def can still put a number on a faceplate WITHOUT touching a
//     primitive, by declaring an option/landmark whose LABEL is a number — the
//     one roster that does still paint. Swept over the live registry, both
//     directions, with a NAMED exemption per instance.
//
// (3) PAINTED VALUES. A formatted value may reach an ATTRIBUTE (an aria value
//     home, a `data-*` probe) and may not reach TEXT AT REST. This is the leg
//     that catches `XyPad` (#1972) and the one legs 1-2 could not: the pad
//     never touched `persistentReadout` and never imported `knobValueReadout` —
//     it grew its own `fmt()` and printed it. The leg follows the value CHAIN
//     (`fmt` → `valueText` → `ariaLabel`), so `{valueText}` is caught as well as
//     `{fmt(x)}`; the identifier form is the commoner way it comes back, and
//     both were verified to redden by re-adding them to the real file.
//
// (4) OBSERVABILITY. A primitive that formats a value must expose it on an aria
//     attribute. Without this, "delete the line and expose nothing" satisfies
//     leg 3 perfectly while making the control unreadable — an absence check
//     cannot tell "the number moved" from "the number is gone".
//
// ── ⚠ HOW THE BLIND SPOT THAT PRODUCED #1972 WAS CLOSED ────────────────────
//
// The old `PRIMITIVES` was a two-name literal, and `XyPad.svelte` — a
// faceplate value cell `ModuleShell` mounts — was not on it. So the gate was
// green and had never opened the file, which is the blind-gate shape CLAUDE.md
// is about: the FILTER quietly redefined the subject.
//
// The roster is now DERIVED FROM THE ARTIFACT: it is parsed out of the
// `$lib/ui/controls` import in `ModuleShell.svelte`, which is the thing that
// decides what a faceplate can mount. A primitive added to that import is
// checked the moment it lands, with nobody remembering anything. Every other
// `.svelte` in this directory must then carry a NAMED exemption saying why a
// faceplate cannot mount it, and an exemption naming a file that no longer
// exists — or that `ModuleShell` has since started mounting — is RED.
//
// ⚠ Enumerating it that way immediately found the second case, and it is a
// PASS, not a defect: `ScopeScreen.svelte` calls `toFixed(4)` twice, into
// `data-trace-peak` / `data-wave-peak`. Those are test probes on a `role="img"`
// canvas, not text. A leg that banned the CALL would have reported it as an
// offence; leg 3 bans the DESTINATION, so it does not.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ───────────────────────────────
//
//   * A PRIMITIVE A FACEPLATE REACHES WITHOUT `ModuleShell` IMPORTING IT — a
//     shell EXTENSION (`shell-extensions.ts`) mounting its own component, or a
//     primitive nested inside another primitive. The derivation is one import
//     line deep, on purpose: it is the boundary that is checkable, and this is
//     the honest statement of where it stops.
//   * LEGACY CARDS. `Knob.svelte` and the ~200 hand-authored
//     cards print values and are untouched by the ruling, which was about
//     FACEPLATES. Sweeping them would be a different (much larger) decision.
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
import { readdirSync, readFileSync } from 'node:fs';
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
const SHELL = resolve(HERE, '../modules/ModuleShell.svelte');

function source(file: string): string {
  return stripSourceComments(readFileSync(resolve(HERE, file), 'utf8'));
}

/**
 * THE ROSTER, DERIVED. Every primitive `ModuleShell` pulls out of
 * `$lib/ui/controls` — i.e. everything a faceplate cell can mount. Parsed from
 * the artifact rather than re-typed here, so a primitive added to that import
 * is gated the same day it lands.
 */
function faceplatePrimitives(): string[] {
  const shell = stripSourceComments(readFileSync(SHELL, 'utf8'));
  const m = /import\s*\{([^}]*)\}\s*from\s*'\$lib\/ui\/controls'/.exec(shell);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
    .filter(Boolean)
    .map((n) => `${n}.svelte`)
    .sort();
}

/**
 * Controls in this directory a FACEPLATE cannot mount, each with the reason.
 *
 * ⚠ ANCHORED BOTH WAYS: an entry naming a file that no longer exists is RED,
 * and so is an entry naming a file `ModuleShell` has SINCE started importing —
 * otherwise promoting a control into the faceplate roster would silently
 * inherit its own exemption and this gate would go quiet exactly when it
 * started mattering.
 */
const NOT_FACEPLATE_MOUNTABLE: readonly { file: string; why: string }[] = [
  {
    file: 'Knob.svelte',
    why: 'the LEGACY card dial. `ModuleShell` mounts `KnobConic` for a faceplate knob cell and this file is reached only by the ~200 hand-authored cards, which the 2026-08-17 ruling explicitly did not cover. Sweeping them is a different and much larger decision.',
  },
  {
    file: 'Readout.svelte',
    why: 'a standalone numeric display a legacy card places deliberately — its whole job is to print a value, so it is not a control that grew a readout. No faceplate cell kind mounts it; a face that wants a derived number states it as an option/landmark NAME and is covered by leg 2 instead.',
  },
  {
    file: 'ControlContextMenu.svelte',
    why: 'the shared right-click menu (MIDI learn / surface / Electra / annotate). It is a popover opened BY a primitive, never a value cell, and it paints command names rather than any reading of state.',
  },
  {
    file: 'MidiAssignButton.svelte',
    why: 'an assign HANDLE. It shows a binding badge (a CC number, which is an address rather than a reading of the param) and changes no value; faceplate cells reach it through the primitive they live on, not directly.',
  },
  {
    file: 'NoteEntry.svelte',
    why: 'a legacy sequencer note field. Pitch entry is a NAME roster (C4, F#3) rather than a decimal, and no faceplate cell kind mounts it — sequencer faces reach their grids through `ParamGrid`.',
  },
  {
    file: 'WaveformGlyph.svelte',
    why: 'a static shape stamp (the sine/tri/saw/square icon beside a wave selector). It is an `aria-hidden` decoration with no value input at all.',
  },
];

// ── LEG 3 · A FORMATTED VALUE MAY REACH AN ATTRIBUTE, NEVER TEXT ───────────
//
// The construct being denied is `{fmt(v)}` in a TEXT position. What makes that
// checkable is that the two legitimate destinations — `aria-valuetext` and a
// `data-*` probe — are both ATTRIBUTE BINDINGS, and an attribute binding is
// lexically distinguishable from a text interpolation. So the markup is
// stripped of every `name={...}` binding (blanked, not deleted, so line numbers
// survive) and what remains is text. A formatter call found in THAT is painted.

/** The `<template>` half of a `.svelte` file — everything after `</script>`. */
function markupOf(src: string): string {
  const i = src.lastIndexOf('</script>');
  return i < 0 ? src : src.slice(i + '</script>'.length);
}

/** Blank out every `attr={...}` binding, preserving offsets and newlines so a
 *  hit in the remainder still maps to its real line. Single-level braces only —
 *  a binding containing a nested object literal would be under-stripped, which
 *  fails LOUD (a false offender), never silent. */
function withoutAttributeBindings(markup: string): string {
  return markup.replace(/[\w:@.-]+=\{[^{}]*\}/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
}

/** Names of value FORMATTERS a primitive can paint: the shared ladder, the raw
 *  number method, and any local function whose body reaches `toFixed` (which is
 *  how `XyPad`'s `fmt` escaped a gate that only knew the shared ones).
 *
 *  ⚠ The body is found by COUNTING BRACES, not by matching an indented closer.
 *  The first draft did the latter and its own negative control caught it: a
 *  one-line `function fmt(v) { return v.toFixed(2); }` — precisely the shape
 *  someone re-adds — has no closer on its own line and was invisible. */
function declarations(src: string): { name: string; body: string; isFunction: boolean }[] {
  const out: { name: string; body: string; isFunction: boolean }[] = [];
  // Function declarations: body found by COUNTING BRACES. The first draft
  // matched an indented closer instead and its own negative control caught it —
  // a one-line `function fmt(v) { return v.toFixed(2); }`, precisely the shape
  // someone re-adds, has no closer on its own line and was invisible.
  for (const m of src.matchAll(/(?:export\s+)?function\s+(\w+)\s*\(/g)) {
    const open = src.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) break;
    }
    out.push({ name: m[1], body: src.slice(open, end), isFunction: true });
  }
  // let/const, scoped to ONE LINE. ⚠ Deliberately line-bounded: a lazy
  // cross-line regex here silently PAIRED `let readout =` (KnobConic:185, a
  // NAME readout and legal) with a `;` nine lines later, swallowing
  // `knobValueReadout` and reporting the allowed element as an offence. Every
  // value chain in the roster is single-line; a multi-line one is a stated
  // limit, not a silent pass, because leg 3 still sees the formatter CALL.
  for (const line of src.split('\n')) {
    const m = /^\s*(?:let|const)\s+(\w+)\s*=\s*(.*)$/.exec(line);
    if (m) out.push({ name: m[1], body: m[2], isFunction: false });
  }
  return out;
}

/**
 * Identifiers that carry a formatted value: the formatters themselves, plus
 * anything declared from one, transitively (`fmt` → `valueText` → `ariaLabel`).
 * Three passes covers every chain in the roster today and terminates.
 */
/**
 * Two sets, resolved together to a fixpoint:
 *
 *   FORMATTERS — things that TURN a number into text. Seeded with the shared
 *     ladders, grown by aliases (`const format = formatParamNumber;`) and by
 *     local functions that call one (`fmt`, `valueText`).
 *   VALUES — things that ARE formatted text, i.e. the result of calling a
 *     formatter, or a derivation from another value (`valueText` → `ariaLabel`).
 *
 * ⚠ THE SPLIT IS THE WHOLE POINT, and a one-set version got it wrong in a way
 * that looked like a finding. Merging them made `vocab` "value-carrying" in
 * `KnobConic` — its initializer is `{ options, landmarks, format: formatValue }`
 * and the bare word `format` there is an OBJECT KEY, not a reference. That
 * propagated to `readout` and `marks` and reported the NAME readout (which the
 * ruling explicitly PERMITS) as an offence. A gate that red-lines the allowed
 * case teaches people to widen its exemption list, which is how a gate dies.
 * So: a formatter only counts when it is CALLED.
 */
function valueChain(src: string): { formatters: Set<string>; values: Set<string> } {
  const formatters = new Set<string>(SHARED_FORMATTERS);
  const values = new Set<string>();
  const decls = declarations(src);
  // ⚠ A CALL may be preceded by a dot — `toFixed` is ALWAYS `v.toFixed(…)`, and
  // an earlier draft's `(?<![.\w])` guard excluded exactly the one formatter the
  // whole gate is named after, silently collapsing every chain built on it. The
  // guard here blocks a longer identifier ENDING in the name (`myFormat(`) and
  // nothing else; requiring the `(` is what keeps an object key like `format:`
  // from matching.
  const callsAFormatter = (body: string): boolean =>
    [...formatters].some((f) => new RegExp(String.raw`(?<![\w$])${f}\s*\(`).test(body));
  const namesAValue = (body: string): boolean =>
    [...values].some((v) => new RegExp(String.raw`(?<![.\w])${v}\b(?!\s*:)`).test(body));

  for (let pass = 0; pass < 6; pass++) {
    let grew = false;
    for (const d of decls) {
      // An ALIAS: `const format = formatParamNumber;` — the body is nothing but
      // a formatter's name, so the alias is a formatter too.
      if (!formatters.has(d.name) && formatters.has(d.body.replace(/[;\s]+$/, '').trim())) {
        formatters.add(d.name);
        grew = true;
        continue;
      }
      if (d.isFunction) {
        // A function that formats is itself a formatter (`fmt`, `valueText`).
        if (!formatters.has(d.name) && (callsAFormatter(d.body) || namesAValue(d.body))) {
          formatters.add(d.name);
          grew = true;
        }
        continue;
      }
      if (values.has(d.name)) continue;
      if (callsAFormatter(d.body) || namesAValue(d.body)) {
        values.add(d.name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return { formatters, values };
}

/** Everything that, painted, would put a formatted number on the panel. */
function valueCarryingIdentifiers(src: string): Set<string> {
  const { formatters, values } = valueChain(src);
  return new Set([...formatters, ...values]);
}

/**
 * The number→text converters a primitive can reach. `toFixed` is the raw one;
 * the other two are this directory's shared ladders (`knob-vocabulary-model`,
 * `param-format`).
 *
 * ⚠ `formatParamNumber` is here because the roster sweep found it: `NeonFader`
 * formats through it, not through `knobValueReadout`, so a predicate that knew
 * only the knob ladder silently excluded the fader from every value-bearing
 * check. That is the same filter-redefines-the-subject shape as the missing
 * `XyPad`, one layer down.
 */
const SHARED_FORMATTERS = ['toFixed', 'knobValueReadout', 'formatParamNumber'] as const;

/** Does this primitive turn a number into display text at all? */
function formatsAValue(src: string): boolean {
  // A REFERENCE, not a call: `NeonFader:349` does `const format = formatParamNumber;`
  // and calls the alias, so a call-shaped predicate excluded the fader entirely.
  return new RegExp(String.raw`\b(${SHARED_FORMATTERS.join('|')})\b`).test(src);
}

/** A regex matching "a formatted value appears here" — a formatter being
 *  CALLED, or a value identifier being referenced. Property keys (`format:`)
 *  and member accesses (`m.value`) are excluded; both produced false offences
 *  in an earlier draft. */
function valueExpressionRe(src: string): RegExp {
  const { formatters, values } = valueChain(src);
  const parts = [
    ...[...formatters].map((f) => String.raw`(?<![\w$])${f}\s*\(`),
    ...[...values].map((v) => String.raw`(?<![.\w])${v}\b(?!\s*:)`),
  ];
  return new RegExp(parts.join('|'));
}

/** Does a formatted value reach any `aria-*` attribute in the markup? */
function routesValueToAria(src: string): boolean {
  const re = valueExpressionRe(src);
  return [...markupOf(src).matchAll(/aria-[\w-]+=\{([^{}]*)\}/g)].some((m) => re.test(m[1]));
}

/**
 * The ONE painted value the ruling keeps: a tag that appears WHILE YOU SET the
 * control and is absent at rest. `NeonFader` shipped it with the removal and
 * says why in its own markup — *"the value is speakable, assertable, and
 * visible WHILE YOU SET IT — it just does not sit on the panel at rest"*.
 *
 * ⚠ NAMED PER LINE, WITH ITS GUARD, so the exemption cannot quietly widen: the
 * anchor leg re-reads the source and fails if the line stops painting what it
 * says, or stops being wrapped in the `{#if}` that makes it transient.
 *
 * ⚠ `XyPad` is deliberately NOT here. Its resting readout was DELETED outright
 * per the brief for #1972 ("GONE, not hidden"), so the pad and the fader now
 * differ: the fader shows a number while you drag it, the pad shows none. That
 * is a real inconsistency between two primitives under one ruling and it is
 * filed rather than settled here — see the PR body.
 */
const PAINTED_WHILE_SETTING: readonly {
  file: string;
  line: number;
  paints: string;
  gatedOn: string;
  why: string;
}[] = [
  {
    file: 'KnobConic.svelte',
    line: 260,
    paints: 'format(liveValue, units)',
    gatedOn: 'dragging',
    why: 'the dial\'s drag/hover `.value` tag, the same construct and the same `{#if dragging || hovering}` guard as the fader below. KnobConic still paints a NAME readout at rest (options/landmarks, which the ruling permits); this tag is the NUMBER, and it appears only while the dial is being turned or pointed at.',
  },
  {
    file: 'NeonFader.svelte',
    line: 402,
    paints: 'readoutText',
    gatedOn: 'dragging',
    why: 'the drag/hover `.value-tag`. A fader has no option/landmark NAME a level could print, so the RESTING line went entirely; this tag paints only under `{#if dragging || hovering}`, i.e. while the player is setting the control and is looking at it. It is the shipped reading of "the data is gone" — gone from the PANEL, not from the gesture.',
  },
];

/**
 * Primitives that format a number for a MACHINE rather than for a person, so
 * requiring an ARIA home for it would be wrong. Deny-by-default: anything not
 * listed must expose its formatted value.
 */
const VALUE_NOT_SPOKEN: readonly { file: string; why: string }[] = [
  {
    file: 'ScopeScreen.svelte',
    why: 'its two `toFixed(4)` calls feed `data-trace-peak` / `data-wave-peak`, which are TEST PROBES on a `role="img"` canvas. The scope has no single value to speak — it draws a trace — and its accessible name is the mode, so there is nothing an aria value attribute could honestly carry. Found by the roster enumeration that produced this file, and it is the reason leg 3 bans the DESTINATION rather than the call.',
  },
];

/**
 * Lines of `src`'s markup where a formatted value reaches a TEXT position.
 *
 * ⚠ IT MATCHES IDENTIFIERS, NOT JUST CALLS. The first draft looked for
 * `fmt(`-shaped calls, which caught `XyPad` (it painted the call inline) and
 * would have MISSED the far more common shape — derive once, paint the
 * variable, which is exactly what `NeonFader:402` does with `readoutText`. A
 * gate that only sees the rarer spelling of the offence is the blind gate
 * again, so the value CHAIN is what is tracked.
 */
function paintedValueLines(src: string): number[] {
  const inner = valueExpressionRe(src).source;
  // Only inside a `{…}` interpolation — literal prose in the markup that
  // happens to contain an identifier's name is not a painted value.
  const re = new RegExp(String.raw`\{[^{}]*(?:${inner})[^{}]*\}`);
  const head = src.slice(0, src.length - markupOf(src).length);
  const offset = head.split('\n').length - 1;
  const out: number[] = [];
  withoutAttributeBindings(markupOf(src))
    .split('\n')
    .forEach((line, i) => {
      if (re.test(line)) out.push(offset + i + 1);
    });
  return out;
}

describe('face readouts — the resting decimal is REMOVED, not hidden', () => {
  it('the ROSTER is derived from what ModuleShell mounts, and it is not empty', () => {
    // The anti-vacuity leg for the derivation itself. Every assertion below
    // iterates `faceplatePrimitives()`; if the parse ever returns [] — a
    // reordered import, a renamed alias, a moved file — every one of them would
    // pass over nothing and this file would certify silence.
    const roster = faceplatePrimitives();
    expect(roster.length, 'the ModuleShell controls import did not parse').toBeGreaterThan(3);
    expect(
      roster,
      'the three primitives this file reasons about must be in the derived roster',
    ).toEqual(expect.arrayContaining(['KnobConic.svelte', 'NeonFader.svelte', 'XyPad.svelte']));
    for (const file of roster) {
      expect(source(file).length, `${file} is in the roster but did not read`).toBeGreaterThan(200);
    }
  });

  it('every control in this directory is MOUNTABLE-and-checked or NAMED-exempt', () => {
    // Deny by default. This is the assertion that would have made #1972
    // impossible: `XyPad.svelte` was neither checked nor exempt, and nothing
    // said so.
    const files = readdirSync(HERE)
      .filter((f) => f.endsWith('.svelte'))
      .sort();
    const roster = new Set(faceplatePrimitives());
    const exempt = new Set(NOT_FACEPLATE_MOUNTABLE.map((e) => e.file));
    expect(
      files.filter((f) => !roster.has(f) && !exempt.has(f)),
      'a control primitive is neither mounted by ModuleShell (so gated here) nor carries a ' +
        'NOT_FACEPLATE_MOUNTABLE entry saying why a faceplate cannot mount it. An unlisted ' +
        'primitive is how the XyPad readout survived the ruling for two months.',
    ).toEqual([]);
    expect(
      NOT_FACEPLATE_MOUNTABLE.filter((e) => !files.includes(e.file)).map((e) => e.file),
      'an exemption names a file that no longer exists — delete it',
    ).toEqual([]);
    expect(
      NOT_FACEPLATE_MOUNTABLE.filter((e) => roster.has(e.file)).map((e) => e.file),
      'an exemption names a control ModuleShell now MOUNTS. It is a faceplate primitive; drop ' +
        'the entry so the checks above start reading it.',
    ).toEqual([]);
    expect(
      NOT_FACEPLATE_MOUNTABLE.filter((e) => e.why.trim().length < 40).map((e) => e.file),
      'an exemption without a stated reason is a suppression',
    ).toEqual([]);

    // The second exemption list, anchored the same way.
    expect(
      VALUE_NOT_SPOKEN.filter((e) => !roster.has(e.file)).map((e) => e.file),
      'a VALUE_NOT_SPOKEN entry names something ModuleShell no longer mounts — delete it',
    ).toEqual([]);
    expect(
      VALUE_NOT_SPOKEN.filter((e) => !formatsAValue(source(e.file))).map((e) => e.file),
      'a VALUE_NOT_SPOKEN entry names a primitive that formats nothing, so it is excusing ' +
        'something that no longer happens',
    ).toEqual([]);
    expect(
      VALUE_NOT_SPOKEN.filter((e) => e.why.trim().length < 40).map((e) => e.file),
      'an exemption without a stated reason is a suppression',
    ).toEqual([]);
  });

  it('no faceplate primitive PAINTS a formatted value AT REST', () => {
    const exempt = new Set(PAINTED_WHILE_SETTING.map((e) => `${e.file}:${e.line}`));
    const offenders = faceplatePrimitives()
      .flatMap((f) => paintedValueLines(source(f)).map((n) => `${f}:${n}`))
      .filter((k) => !exempt.has(k));
    expect(
      offenders,
      'a formatted value reaches a TEXT position in a faceplate primitive — that is the ' +
        'decimal under the control the owner removed. It may reach an aria value attribute or ' +
        'a `data-*` probe; it may not be printed at rest.',
    ).toEqual([]);
  });

  it('ANCHOR: every while-setting exemption still names a GATED line', () => {
    // The exemption is "this paints only while you are setting the control", so
    // the thing to anchor is the GATE, not the line number alone. A line that
    // drifts, or loses its `{#if}`, stops being exempt.
    const problems: string[] = [];
    for (const e of PAINTED_WHILE_SETTING) {
      const lines = source(e.file).split('\n');
      const line = lines[e.line - 1] ?? '';
      if (!line.includes(e.paints)) {
        problems.push(`${e.file}:${e.line} no longer paints \`${e.paints}\` (found: ${line.trim()})`);
        continue;
      }
      const before = lines.slice(Math.max(0, e.line - 4), e.line - 1).join('\n');
      if (!new RegExp(String.raw`\{#if[^}]*\b${e.gatedOn}\b`).test(before)) {
        problems.push(`${e.file}:${e.line} is no longer gated on \`${e.gatedOn}\` — it paints AT REST`);
      }
      if (e.why.trim().length < 40) problems.push(`${e.file}:${e.line} has no stated reason`);
    }
    expect(
      problems,
      'a while-setting exemption no longer describes what the source does. An exemption that ' +
        'has drifted off its guard is permitting a RESTING readout.',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the painted-formatter probe discriminates, both ways', () => {
    // Leg 3 is an absence, so on its own a green run is also what a broken
    // predicate produces. Both directions, on fixtures this file owns.
    const painted = `<script lang="ts">
  function fmt(v: number): string { return v.toFixed(2); }
</script>
<div class="xy-readout"><strong>{fmt(x)}</strong></div>`;
    const attributed = `<script lang="ts">
  function fmt(v: number): string { return v.toFixed(2); }
</script>
<div role="application" aria-valuetext={fmt(x)} data-peak={peak.toFixed(4)}></div>`;
    expect(
      [...valueCarryingIdentifiers(painted)],
      'a local toFixed wrapper must be discovered',
    ).toContain('fmt');
    expect(paintedValueLines(painted), 'the probe missed a painted formatter').toEqual([4]);
    expect(
      paintedValueLines(attributed),
      'the probe flagged an ATTRIBUTE binding — an aria value home and a `data-*` probe are the ' +
        'two destinations the ruling keeps, and ScopeScreen ships the data-* case today',
    ).toEqual([]);

    // And the ARIA-home probe, both ways, on the same fixtures. `attributed`
    // binds `fmt(x)` straight onto an aria attribute; `painted` binds it onto
    // nothing. A probe that answered `true` for both would let the wrong fix
    // (delete the line, expose nothing) through.
    expect(routesValueToAria(attributed), 'the aria-home probe missed a direct binding').toBe(true);
    expect(routesValueToAria(painted), 'the aria-home probe passed a value with no home').toBe(false);
    // The transitive case, which is the shape XyPad actually uses:
    // fmt -> valueText -> ariaLabel -> aria-label.
    const chained = `<script lang="ts">
  function fmt(v: number): string { return v.toFixed(2); }
  let valueText = $derived(\`X \${fmt(x)}\`);
  let ariaLabel = $derived(\`pad: \${valueText}\`);
</script>
<div role="application" aria-label={ariaLabel}></div>`;
    expect(
      valueCarryingIdentifiers(chained).has('ariaLabel'),
      'the value chain is not followed through an intermediate derivation',
    ).toBe(true);
    expect(routesValueToAria(chained), 'the aria-home probe does not follow a chain').toBe(true);
  });

  it('a primitive that FORMATS a value routes it to an ARIA attribute', () => {
    // The other half of leg 3, and the half that stops the wrong fix. Deleting
    // the painted line without this makes the value unobservable to every spec
    // and to AT, and leg 3 is perfectly happy about that — an absence check
    // cannot tell "the number moved" from "the number is gone".
    //
    // ⚠ THE REQUIREMENT IS "AN ARIA ATTRIBUTE", NOT "`aria-valuetext`". The
    // first draft of this leg demanded the literal attribute and svelte-check
    // refused the resulting markup: `aria-valuetext` is not supported on
    // `role="application"`, which is what the pad is. A gate that can only be
    // satisfied by an attribute the platform ignores would have forced a
    // suppression comment and certified a dead attribute. So the destinations
    // are checked, the ROLE picks which one, and the divergence is written down
    // where a spec author will hit it (`XyPad.svelte`'s header).
    const subjects = faceplatePrimitives().filter(
      (f) => formatsAValue(source(f)) && !VALUE_NOT_SPOKEN.some((e) => e.file === f),
    );
    // Anti-vacuity: the filter must not have emptied the sweep. Both of the
    // primitives the ruling was originally applied to have to be IN it, or this
    // leg is checking the one file that prompted it and nothing else.
    expect(
      subjects,
      'the value-bearing filter no longer selects the primitives this leg is about',
    ).toEqual(expect.arrayContaining(['KnobConic.svelte', 'NeonFader.svelte', 'XyPad.svelte']));
    const offenders = subjects.filter((f) => !routesValueToAria(source(f)));
    expect(
      offenders,
      'a faceplate primitive computes a formatted value and exposes it nowhere. The painted ' +
        'readout was removed on the owner ruling, so an ARIA attribute is the only place the ' +
        'value still lives; without one the control is unobservable rather than tidy.',
    ).toEqual([]);
  });

  it('no faceplate primitive carries a `persistentReadout` switch', () => {
    // ⚠ THE PROP IS THE OFFENCE, NOT ITS VALUE. A reintroduced
    // `persistentReadout={false}` would render nothing today and be one prop
    // away from rendering everything tomorrow, and it is the exact shape the
    // owner rejected ("not there but hidden"). Deny the switch itself.
    const offenders = faceplatePrimitives().filter((f) => /persistentReadout/.test(source(f)));
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
    for (const file of faceplatePrimitives()) {
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
