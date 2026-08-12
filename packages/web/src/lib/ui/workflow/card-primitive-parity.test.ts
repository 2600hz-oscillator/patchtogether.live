// packages/web/src/lib/ui/workflow/card-primitive-parity.test.ts
//
// THE FACEPLATE PLATFORM'S CONTROL VOCABULARY, MEASURED AGAINST THE CARDS'.
//
// `param-cell-coverage.test.ts` next door asks "is every `ParamCellKind` wired
// end to end". That question is closed over the kinds the platform ALREADY HAS,
// which makes it structurally unable to see the one failure that matters here:
// a primitive a CARD can mount for which the face has no kind at all. The
// resolver never returns a kind it does not have, so every branch is wired,
// every gate is green, and the faceplate paints a KnobConic instead.
//
// ⚠ THE DOWNGRADE IS SILENT, AND IT HAS ALREADY SHIPPED ONCE. `paramCellKind`
// ends in `return 'knob'` — a total function with no failure mode. A 2-D pad
// bound to two params resolves to TWO INDEPENDENT DIALS, and every gate agrees:
// faces-parity drags each dial and each param moves, the multiset is exact, the
// docs read the def. Nothing anywhere compares the affordance the CARD gives a
// param with the affordance the FACE gives it. wavesculpt's first face shipped
// with both of its camera joysticks replaced by knobs on the strength of a def
// comment asserting "the platform has no XY-pad primitive" — a sentence that
// was false about the PRIMITIVE (`$lib/ui/controls/XyPad.svelte` exists, with
// per-axis MIDI assign) and true about the CELL KIND. This file is the
// difference between those two statements, made mechanical.
//
// TWO ASSERTIONS, in the two shapes the repo standard asks for:
//
//   1. VOCABULARY PARITY — every interactive primitive in `$lib/ui/controls/`
//      carries a declared face ANSWER, and every answer names a primitive that
//      still exists. Deny by default: a new `.svelte` dropped in that directory
//      fails here until its author says how a faceplate expresses it. `'none'`
//      is a legal answer, but only with a `why` — so a platform gap is a
//      DECLARATION that reads out of the gate, never an omission.
//
//   2. INSTANCE DENIAL — for every FACED module, a ranked param whose card
//      binds it to a `'none'` primitive FAILS, naming the exact
//      `(module, param, primitive)` triple. There is no exemption list and
//      there is deliberately no count: the answer is "add the cell kind", or
//      "do not face this module yet".
//
// NO POPULATION COUNTS ANYWHERE IN HERE (2026-08-10 owner directive). The
// primitive roster is read off the directory; the offender set is asserted
// EMPTY, not "at most N".

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import { conventionalCardName } from '$lib/ui/modules-card-map';
import { readCardSourceWithDelegates } from '$lib/ui/card-source';
import type { ModuleFace } from '$lib/graph/types';
import type { ParamCellKind } from './shell-control-kind';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLS_DIR = resolve(HERE, '../controls');
const CARD_DIR = resolve(HERE, '../modules');

// ── 1. THE ANSWER VOCABULARY ────────────────────────────────────────────────

/**
 * How a FACEPLATE expresses what a card expresses with this primitive.
 *
 * The variants are ordered by how much the platform owns:
 *
 *   `param-cell`  — a first-class `ParamCellKind`. A module declares it (or the
 *                   resolver infers it) and the shell paints it. Nothing
 *                   bespoke, nothing to register, works at every tier the kind
 *                   allows.
 *   `shell-cell`  — a `ShellCell` kind (shell-cells.ts) for a FAMILY/STATIC key
 *                   that no ParamDef backs — a roster over `node.data`, a file
 *                   import, an audition.
 *   `glyph`       — a READ-ONLY picture, not a control: `face.glyph`.
 *   `ambient`     — not a control the face ever places: it rides every cell
 *                   already, or it is chrome.
 *   `panel-only`  — reachable ONLY inside a bespoke PF-14 `panel` cell. This is
 *                   a REAL answer, not a gap — but it is the weakest one, and
 *                   the difference is worth naming: a panel is a hand-written
 *                   component registered per module, DOCK-ONLY, and (until
 *                   PF-22) rank-7-or-later. A module cannot reach it from
 *                   `face.paramCells` at all.
 *   `none`        — THE GAP. The face has no way to express this affordance.
 *                   Legal, but it makes every faced module whose card mounts it
 *                   a hard failure below.
 */
type FaceAnswer =
  | { via: 'param-cell'; kind: ParamCellKind; note?: string }
  | { via: 'shell-cell'; kind: 'selector' | 'action' | 'file' | 'toggle' | 'panel'; note?: string }
  | { via: 'glyph'; kind: NonNullable<ModuleFace['glyph']>; note?: string }
  | { via: 'ambient'; why: string }
  | { via: 'panel-only'; why: string }
  | { via: 'none'; why: string };

/**
 * PRIMITIVE → how a faceplate says the same thing.
 *
 * ⚠ ANCHORED TO THE DIRECTORY, NOT TO THIS LIST. Keys are the `.svelte`
 * basenames in `$lib/ui/controls/`. A primitive added there with no entry is
 * RED; an entry naming a file that no longer exists is RED. That is the
 * deny-by-default half — the reason the table cannot quietly stop describing
 * the tree, and the reason there is no number in it.
 *
 * ⚠ THE DIRECTORY IS THE RIGHT ANCHOR, NOT THE BARREL (`controls/index.ts`).
 * Cards import primitives by direct path as often as through the barrel
 * (`ControlContextMenu` is imported by a card and is not exported at all), so
 * a barrel-anchored roster would be blind to exactly the primitives that
 * bypassed it.
 */
const FACE_ANSWER: Readonly<Record<string, FaceAnswer>> = {
  // ── first-class param cells ──
  Knob: { via: 'param-cell', kind: 'knob' },
  KnobConic: { via: 'param-cell', kind: 'knob', note: 'the shell paints this one directly' },
  Fader: {
    via: 'param-cell',
    kind: 'fader',
    note:
      'DECLARED, never inferred — nothing in a ParamDef separates "a level" from any other ' +
      'continuous scalar. A ranked param a card draws as a fader and a face does not declare ' +
      'is a look regression, NOT a lost gesture (1-D to 1-D), so it is reported by the fader ' +
      'audit below rather than failed here.',
  },
  Toggle: { via: 'param-cell', kind: 'toggle', note: 'and ShellToggleCell for a node.data switch' },
  Button: { via: 'param-cell', kind: 'momentary', note: 'and ShellActionCell for an audition' },
  Segmented: { via: 'param-cell', kind: 'segmented', note: 'dock only; a lane paints the knob' },
  Selector: { via: 'param-cell', kind: 'selector', note: 'and ShellSelectorCell for a data roster' },
  ParamGrid: { via: 'param-cell', kind: 'grid' },
  ColorField: { via: 'param-cell', kind: 'color' },

  // ── read-only pictures ──
  ScopeScreen: { via: 'glyph', kind: 'scope' },
  VuMeter: { via: 'glyph', kind: 'meter' },
  WaveformGlyph: { via: 'glyph', kind: 'waveform' },

  // ── not controls the face places ──
  Readout: {
    via: 'ambient',
    why:
      'a printed value, not an affordance. The face has FaceReadout (hero + `readouts` sidebar ' +
      'block) plus every cell\'s own persistentReadout at the dock.',
  },
  MidiAssignButton: {
    via: 'ambient',
    why:
      'MIDI-learn is not placed by a face: every shell cell passes moduleId + paramId, so the ' +
      'shared ControlContextMenu (right-click) reaches Learn/Forget on every rendered control.',
  },
  ControlContextMenu: {
    via: 'ambient',
    why: 'the shared right-click menu itself — chrome under every primitive, never a cell.',
  },

  // ── THE GAPS ──
  XyPad: {
    via: 'param-cell',
    kind: 'xy',
    note:
      'DECLARED through `face.xyPads`, not `face.paramCells` — a pad binds a PAIR and that map ' +
      'is keyed by one id. Both axis ids are REQUIRED by the type, so a pad naming one axis ' +
      'does not compile. Dock-only (square pad vs a 46px lane column), and since PF-22 it costs ' +
      'no lane rank, so it may rank FIRST.',
  },
  NoteEntry: {
    via: 'none',
    why:
      'NO text-entry cell of any kind. `ShellCell` is selector | action | file | toggle | panel, ' +
      'and none of them accepts typed input, so a sequencer step\'s pitch field ("c#3") has no ' +
      'face representation. Its params are per-step `controlFamilies` cells rather than ' +
      'ParamDefs, so a face would reach it through a panel — which is the same PF-22 rank floor.',
  },
};

/** Which prop(s) a primitive binds a param through, for naming the instance. */
const PARAM_PROPS: Readonly<Record<string, readonly string[]>> = {
  XyPad: ['xParamId', 'yParamId'],
};
const DEFAULT_PARAM_PROPS = ['paramId'] as const;

// ── 2. READING THE TREE ─────────────────────────────────────────────────────

/** Every interactive primitive the control library ships, off the DIRECTORY. */
function primitivesInTree(): string[] {
  return readdirSync(CONTROLS_DIR)
    .filter((f) => f.endsWith('.svelte'))
    .map((f) => basename(f, '.svelte'))
    .sort();
}

interface FacedDef {
  type: string;
  card?: string;
  face?: ModuleFace;
  params?: readonly { id: string }[];
}

function facedDefs(): FacedDef[] {
  return [
    ...(listModuleDefs() as unknown as FacedDef[]),
    ...(listVideoModuleDefs() as unknown as FacedDef[]),
    ...(listMetaModuleDefs() as unknown as FacedDef[]),
  ].filter((d) => !!d.face);
}

/** The card file a def resolves to (`def.card` override, else the convention). */
function cardPathFor(def: FacedDef): string | null {
  const name = def.card ?? conventionalCardName(def.type);
  const p = join(CARD_DIR, `${name}.svelte`);
  return existsSync(p) ? p : null;
}

const fsShim = { readFileSync: (p: string, e: 'utf8') => readFileSync(p, e), existsSync };

/** A card's own source plus its sibling delegates (CvBuddyBody and friends). */
function cardSourceFor(def: FacedDef): { path: string; src: string } | null {
  const path = cardPathFor(def);
  if (!path) return null;
  return { path, src: readCardSourceWithDelegates(path, CARD_DIR, fsShim, join) };
}

/**
 * Every `<Primitive …>` tag in a source, with the param ids it binds.
 *
 * ⚠ TAG-SCOPED, and the bound is why: a `<Foo` is read only as far as the next
 * `>` that is not inside a brace expression. A whole-file grep for `paramId="x"`
 * would attribute every param on the card to every primitive on it, which on a
 * 24-fader card is 24× wrong in the direction that manufactures findings.
 */
function boundParams(src: string, primitive: string): string[] {
  const out: string[] = [];
  const props = PARAM_PROPS[primitive] ?? DEFAULT_PARAM_PROPS;
  const open = new RegExp(`<${primitive}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) !== null) {
    const tag = readTag(src, m.index);
    for (const prop of props) {
      const hit = new RegExp(`\\b${prop}=(?:"([A-Za-z0-9_]+)"|\\{'([A-Za-z0-9_]+)'\\})`).exec(tag);
      if (hit) out.push((hit[1] ?? hit[2])!);
    }
  }
  return out;
}

/** The text of one element's OPEN TAG, from `<` to its matching `>`, ignoring
 *  `>` inside a `{…}` expression or a quoted attribute. */
function readTag(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth <= 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** `(module, param, primitive)` — one silent downgrade. */
interface Offender {
  module: string;
  param: string;
  primitive: string;
  card: string;
  why: string;
}

/**
 * The PREDICATE, injectable so both controls at the bottom call THIS function
 * and not a re-typed copy of it. (A self-test that re-implements the rule is
 * how the raw-write guard went blind — CLAUDE.md, "the ledger you invert it
 * with is the next blind spot".)
 */
function downgradesIn(
  def: FacedDef,
  cardFile: string,
  src: string,
  answers: Readonly<Record<string, FaceAnswer>> = FACE_ANSWER,
): Offender[] {
  const ranked = new Set(def.face?.order ?? []);
  const declared = new Set((def.params ?? []).map((p) => p.id));

  const out: Offender[] = [];
  for (const [primitive, answer] of Object.entries(answers)) {
    if (answer.via !== 'none') continue;
    for (const param of boundParams(src, primitive)) {
      // Only a param the FACE actually ranks is a downgrade: an unranked param
      // is a card-only control the faceplate never claimed to render, and
      // face-lint's completeness rule is what covers that separately.
      if (!ranked.has(param) || !declared.has(param)) continue;
      out.push({ module: def.type, param, primitive, card: cardFile, why: answer.why });
    }
  }
  return out;
}

const fmt = (o: Offender) =>
  `${o.module}.${o.param} — ${o.card} binds it to <${o.primitive}>, the faceplate paints a ` +
  `KnobConic. ${o.why}`;

// ── THE GATE ────────────────────────────────────────────────────────────────

describe('card ↔ face PRIMITIVE PARITY — the vocabulary', () => {
  it('every primitive in $lib/ui/controls has a declared face answer', () => {
    const undeclared = primitivesInTree().filter((p) => !FACE_ANSWER[p]);
    expect(
      undeclared.join('\n'),
      'a control primitive with no entry in FACE_ANSWER. Say how a FACEPLATE expresses it — ' +
        "a ParamCellKind, a ShellCell, a glyph, chrome, or `via:'none'` with the reason. " +
        'Falling through means a face silently paints a knob for it.',
    ).toBe('');
  });

  it('…and every declared answer still names a primitive that EXISTS', () => {
    const tree = new Set(primitivesInTree());
    const ghosts = Object.keys(FACE_ANSWER).filter((p) => !tree.has(p));
    expect(
      ghosts.join('\n'),
      'FACE_ANSWER names a primitive that is no longer in $lib/ui/controls. A stale entry is ' +
        'one nobody is watching — delete it, or restore the file.',
    ).toBe('');
  });

  it('every `none` answer states WHY (a gap is a declaration, not an omission)', () => {
    const mute = Object.entries(FACE_ANSWER)
      .filter(([, a]) => (a.via === 'none' || a.via === 'panel-only' || a.via === 'ambient') && !a.why.trim())
      .map(([p]) => p);
    expect(mute.join('\n')).toBe('');
  });

  it('prints the vocabulary, so the shape of the gap is readable at a glance', () => {
    const lines = primitivesInTree().map((p) => {
      const a = FACE_ANSWER[p]!;
      const rhs = a.via === 'none' || a.via === 'panel-only' || a.via === 'ambient' ? a.via : `${a.via}:${a.kind}`;
      return `  ${p.padEnd(20)} ${rhs}`;
    });
    // Not an assertion about how many — an assertion that the roster RESOLVED.
    // A directory read that returned nothing would otherwise leave every clause
    // above vacuously green.
    expect(lines.length, '$lib/ui/controls resolved no primitives — the path is wrong').toBeGreaterThan(0);
    expect(
      primitivesInTree(),
      'the roster must contain the primitives this file reasons about; if XyPad has moved, the ' +
        'reasoning in the header needs re-checking, not the path',
    ).toEqual(expect.arrayContaining(['Knob', 'Fader', 'XyPad']));
  });
});

describe('card ↔ face PRIMITIVE PARITY — the instances', () => {
  const defs = facedDefs();

  it('the scan reaches a REAL card source for every faced module (anti-vacuity)', () => {
    // The clause that would rot first. If `cardPathFor` stopped resolving, every
    // module below would scan an empty string and the gate would be green
    // having read nothing — indistinguishable, from the output, from a clean
    // tree. This is the leg that makes the difference visible.
    const unreadable = defs
      .filter((d) => {
        const s = cardSourceFor(d);
        return !s || s.src.length < 200;
      })
      .map((d) => `${d.type} → ${d.card ?? conventionalCardName(d.type)}.svelte`);
    expect(
      unreadable.join('\n'),
      'a faced module whose card source could not be read — the primitive scan below is blind ' +
        'for it and says nothing about it',
    ).toBe('');
    expect(defs.length, 'no faced modules resolved — the registry did not load').toBeGreaterThan(0);
  });

  it('NO faced module ranks a param its card binds to a primitive the face cannot express', () => {
    const offenders: Offender[] = [];
    for (const def of defs) {
      const s = cardSourceFor(def);
      if (!s) continue;
      offenders.push(...downgradesIn(def, basename(s.path), s.src));
    }
    expect(
      offenders.map(fmt).join('\n'),
      'SILENT AFFORDANCE DOWNGRADE. The card gives this param a control the faceplate has no ' +
        'kind for, so `paramCellKind` falls through to `knob` and every other gate stays green ' +
        '(faces-parity drags the dial and the param moves). Add the cell kind to the platform, ' +
        'or do not promote this module to a face yet.',
    ).toBe('');
  });
});

describe('card ↔ face PRIMITIVE PARITY — CONTROLS on the predicate', () => {
  // A textual gate that matches nothing looks exactly like a clean codebase, and
  // this one is green on `main` for a REASON THAT CAN CHANGE (no faced module's
  // card mounts a `none` primitive today). Both controls call `downgradesIn`
  // itself, never a re-typed rule.

  const backdraft = readFileSync(join(CARD_DIR, 'BackdraftCard.svelte'), 'utf8');

  /** BackdraftCard is the card the whole card↔def divergence class is named
   *  after, and it mounts two `<XyPad>`s over four params. Read as if faced. */
  const AS_IF_FACED: FacedDef = {
    type: 'backdraft',
    face: { order: ['camTiltX', 'camTiltY', 'camPosX', 'camPosY'] },
    params: [{ id: 'camTiltX' }, { id: 'camTiltY' }, { id: 'camPosX' }, { id: 'camPosY' }],
  };
  /** XyPad answered as it was BEFORE the `xy` cell kind existed. Keeping the
   *  historical answer as a fixture is what lets the positive control keep
   *  working after the gap it was written for was closed — the alternative is
   *  deleting the only leg that proves the predicate can fire on a real card. */
  const GAPPED = { ...FACE_ANSWER, XyPad: { via: 'none', why: 'control' } as FaceAnswer };

  it('POSITIVE: with XyPad marked as a gap, a real card names BOTH axes of BOTH pads', () => {
    const found = downgradesIn(AS_IF_FACED, 'BackdraftCard.svelte', backdraft, GAPPED);
    expect(found.map((o) => o.param).sort()).toEqual(['camPosX', 'camPosY', 'camTiltX', 'camTiltY']);
    expect(new Set(found.map((o) => o.primitive))).toEqual(new Set(['XyPad']));
  });

  it('NEGATIVE: the SAME card and params, with XyPad ANSWERED, is clean', () => {
    // The leg that makes the positive control mean something: ONLY the answer
    // table differs between the two, so the scan is provably keying off it and
    // not off some property of the card. It is also the live assertion that the
    // `xy` cell kind closed the gap — `FACE_ANSWER` here is the real table.
    expect(downgradesIn(AS_IF_FACED, 'BackdraftCard.svelte', backdraft)).toEqual([]);
    expect(FACE_ANSWER.XyPad!.via, 'XyPad now has a first-class cell kind').toBe('param-cell');
  });

  it('NEGATIVE: an UNRANKED param bound to a gap primitive is not a downgrade', () => {
    const unranked: FacedDef = {
      type: 'backdraft',
      face: { order: [] },
      params: [{ id: 'camTiltX' }, { id: 'camTiltY' }],
    };
    expect(downgradesIn(unranked, 'BackdraftCard.svelte', backdraft, GAPPED)).toEqual([]);
  });

  it('PERMANENT: the FULL registry sweep can go red (not just the synthetic legs)', () => {
    // The two legs above prove `downgradesIn` works on one hand-built def. This
    // one perturbs the answer table and re-runs the REAL sweep — registry load,
    // card-path resolution, delegate following and all — so a break anywhere in
    // that chain shows up as "the perturbed sweep found nothing" instead of as a
    // green gate. Fader is the perturbation because it is the primitive the most
    // faced cards mount, so a resolution bug cannot hide behind a thin card.
    const patched = { ...FACE_ANSWER, Fader: { via: 'none', why: 'control' } as FaceAnswer };
    const found = facedDefs().flatMap((def) => {
      const s = cardSourceFor(def);
      return s ? downgradesIn(def, basename(s.path), s.src, patched) : [];
    });
    expect(
      found.length,
      'the sweep found NO downgrade even with the commonest primitive marked as a gap — the ' +
        'registry, the card paths, or the tag reader is broken and the real assertion above is ' +
        'green having scanned nothing',
    ).toBeGreaterThan(0);
    expect(
      new Set(found.map((o) => o.primitive)),
      'the perturbation must be the ONLY thing reported — anything else means the unperturbed ' +
        'sweep is already dirty',
    ).toEqual(new Set(['Fader']));
  });

  it('the tag reader is TAG-SCOPED, not file-scoped', () => {
    // The failure mode that would manufacture findings: attributing every
    // paramId on a card to every primitive on it.
    const src = `<Knob paramId="a" /><XyPad xParamId="b" yParamId="c" /><Knob paramId="d" />`;
    expect(boundParams(src, 'XyPad')).toEqual(['b', 'c']);
    expect(boundParams(src, 'Knob')).toEqual(['a', 'd']);
    // …and a `>` inside a brace expression does not end the tag early.
    expect(boundParams(`<XyPad size={a > b ? 96 : 64} xParamId="x" yParamId="y" />`, 'XyPad')).toEqual([
      'x',
      'y',
    ]);
  });

  it('the delegate follower is live (a shared body is not invisible to the scan)', () => {
    // Anchored to the mechanism, not to a card: a wrapper whose only content is
    // a sibling import must scan as its BODY. `readCardSourceWithDelegates` is
    // the shared helper the PatchPanel + stripe gates already use.
    const wrapper = join(CARD_DIR, 'CvBuddyCard.svelte');
    const own = readFileSync(wrapper, 'utf8');
    const followed = readCardSourceWithDelegates(wrapper, CARD_DIR, fsShim, join);
    expect(followed.length, 'the wrapper did not pull in its sibling body').toBeGreaterThan(own.length);
  });
});

// ── SCOPE — what this gate is STRUCTURALLY UNABLE TO SEE ────────────────────
//
// Stated as assertions where it can be, in prose where it genuinely cannot.
describe('card ↔ face PRIMITIVE PARITY — stated scope', () => {
  it('it reads COMPONENT tags only — raw HTML affordances are out of scope', () => {
    // A card's `<select>` / `<input type="file">` / `<input type="text">` are
    // invisible here. The first two have face answers (ShellSelectorCell /
    // ShellFileCell) and are registered per module in shell-cells.ts; the THIRD
    // does not, and shares NoteEntry's gap. Asserted rather than claimed:
    const raw = `<select><option>a</option></select><input type="text" />`;
    expect(Object.keys(FACE_ANSWER).filter((p) => boundParams(raw, p).length)).toEqual([]);
  });

  it('it follows sibling delegates ONE level, exactly like every other card gate', () => {
    // Inherited from `readCardSourceWithDelegates`, deliberately: a body that
    // itself delegates, or an import from another directory, is not followed.
    // Errs toward reading MORE of a card, never less.
    expect(typeof readCardSourceWithDelegates).toBe('function');
  });

  it('it sees the SHARED primitive, never a hand-cloned copy of one', () => {
    // ⚠ THE LARGEST BLIND SPOT, AND IT IS THE SAME AFFORDANCE. Measured
    // 2026-08-12: the shared `<XyPad>` is mounted by two cards, but EIGHT cards
    // mount a 2-D pointer pad — JoystickCard, QuadralogicalCard, MirrorpoolCard,
    // FrametableCard (×2) and WavesculptCard (×2) each grew their own
    // `div.pad` + `onpointerdown` + pointer-capture clone, which is exactly the
    // duplication `XyPad.svelte`'s own header says it exists to end. A clone is
    // invisible to this scan, so the true size of the `xy` gap is larger than
    // what it reports — in the direction of MORE demand for the cell kind, not
    // less.
    //
    // Asserted as far as it can be: the clones are not reachable by name, so
    // what is pinned here is that the SHARED primitive is the thing the table
    // answers for, and that migrating a clone onto it makes that card visible
    // to the gate rather than hiding it.
    expect(Object.keys(FACE_ANSWER)).toContain('XyPad');
    const clone = `<div class="pad nodrag" onpointerdown={down}><div class="dot"></div></div>`;
    expect(
      Object.keys(FACE_ANSWER).filter((p) => boundParams(clone, p).length),
      'a hand-cloned pad is NOT detected — migrate it onto <XyPad> to bring it in scope',
    ).toEqual([]);
  });

  it('a primitive mounted inside a registered PANEL still reports (and should)', () => {
    // A panel is a real answer for an affordance — but it is a hand-written
    // per-module component, dock-only, and unreachable from `face.paramCells`.
    // The gate does NOT special-case it: if a faced module's CARD binds a ranked
    // param to a gap primitive, the platform still owes that module a cell kind,
    // whether or not the module also hand-built a panel. Making the panel
    // silence the gate would re-open the hole one indirection down.
    expect(FACE_ANSWER.NoteEntry!.via).toBe('none');
  });
});
