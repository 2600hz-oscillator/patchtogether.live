// packages/web/src/lib/ui/workflow/face-resting-text-source.test.ts
//
// THE GATE FOR "THE RESTING FACEPLATE PAINTS NO DERIVED-STATE TEXT".
//
// ── THE RULING ─────────────────────────────────────────────────────────────
//
// The owner stated this four times in one day (2026-08-19), each time about a
// DIFFERENT mechanism, and each mechanism passed every gate that existed:
//
//   * on the spirographs faceplate's right-hand column —
//     *"this should go away and we reclaim the vertical space. I DO NOT WANT
//     THESE RIGHT HAND TEXT AREAS I DO NOT WANT EXTRA TEXT. i explicitly
//     already dictated that several times."*
//   * on moog984's hero row printing `OUT 1 silent · OUT 2 silent …` —
//     *"you don't need to have the out-silent text at all … we absolutely have
//     to stop doing [things] like that. i said minimal, and good use of screen real
//     estate."* (#1957)
//
// The earlier two are already codified in CLAUDE.md: the resting decimal under
// a control (`face-readout-source.test.ts`) and the per-control caption that a
// section heading already conveys (`face.bareCells`).
//
// ── WHY THIS GATE DENIES A SHAPE AND NOT A MECHANISM ───────────────────────
//
// ⚠ THIS IS THE WHOLE DESIGN, AND IT IS THE LESSON FROM THE FIRST THREE. Each
// previous fix denied the mechanism in front of it:
//
//   1. `persistentReadout` was deleted    → the number came back as a SIDEBAR
//                                            `readouts` block.
//   2. the sidebar block was gated by contract-lock → the number came back as a
//                                            HERO READOUT ROW, which is not in
//                                            the lock at all.
//   3. the hero row is deleted here       → and a fourth mechanism (a status
//                                            banner, a tab-rail subtitle, a
//                                            per-band footer) would be invisible
//                                            to all three.
//
// Three different mechanisms, one shape, and each gate was blind to the next
// one because it named its subject. So this gate does NOT enumerate forbidden
// mechanisms. It enumerates the PERMITTED TEXT ROLES and denies everything
// else by default, which is the only formulation a fourth mechanism cannot
// walk around.
//
// THE PERMITTED RESTING TEXT ON A FACEPLATE, EXHAUSTIVELY:
//
//   * the module NAME            — painted once, by the dock title bar.
//   * TAB / SECTION labels       — the rail and the band headers.
//   * CONTROL CAPTIONS           — the name of the control, not its value.
//   * OPTION / LANDMARK NAMES    — a word that disambiguates a control's own
//                                  position (`TRI`, `WET`), compact, under the
//                                  control. A NUMBER there is a different
//                                  offence, owned by `face-readout-source`.
//
// Anything else — a value, a derived quantity, a state word, a measurement, a
// sentence — is denied at rest. Its home is `aria-valuetext` on the control it
// describes, which is speakable, assertable, and unpainted; annotation mode is
// where authored PROSE lives (`face.title` / `face.hint` / band hints), behind
// an explicit per-node toggle that is off by default.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ───────────────────────────────
//
//   * TEXT DRAWN INTO A CANVAS. A glyph, a live video surface or a shell
//     extension's `fullViewBody` can `fillText()` anything it likes and no
//     source or DOM gate here will ever see it. This is the largest blind spot
//     and it is NOT theoretical — the bespoke-surface cohort (clipplayer, the
//     MIDI surfaces, videoOut, cameraInput, backdraft, spirographs) all render
//     their own bodies. The VRT dock baselines are the only thing that sees
//     those pixels, and a human reviewing them is the only thing that judges
//     them.
//
//     ⚠ NARROWED, NOT CLOSED, BY `face-rack-status-source.test.ts` (2026-08-21).
//     That gate enumerates every `fullViewBody` in the tree and requires each
//     to carry a DECLARED TEXT ROLE with an argument — so the POPULATION is now
//     named and anchored (a roster entry for a body that no longer exists is
//     RED, and a new body with no entry is RED), and a body whose declared role
//     is `status-primitive` is checked to route its status through `StatusLed`,
//     where a measurement cannot reach a text node. What remains genuinely
//     unseeable is unchanged and is stated there too: what a canvas PAINTS. A
//     body declared `picture` is taken at its word, and only the dock VRT
//     baseline can contradict it.
//   * LEGACY CARDS. The ~200 hand-authored `*Card.svelte` files print values
//     everywhere and are untouched by the ruling, which was about FACEPLATES.
//   * A CONTROL PRIMITIVE's own readout. That is a different offence with its
//     own gate (`face-readout-source.test.ts`); this one would pass while a
//     dial printed a decimal, and says so rather than implying coverage.
//   * WHETHER THE RESULT LOOKS RIGHT. Only the dock VRT baselines can say.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import '$lib/audio/modules';
import '$lib/video/modules';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = resolve(HERE, '../../graph/types.ts');
const SHELL = resolve(HERE, '../modules/ModuleShell.svelte');
const DOCK = resolve(HERE, '../dock/DockFullView.svelte');
const CELLS = resolve(HERE, './shell-cells.ts');
const TEXT_ENTRY = resolve(HERE, '../controls/TextEntry.svelte');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// ── LEG 1 · THE DECLARATION SURFACE ────────────────────────────────────────
//
// Every field a def may declare under `face` (and under `face.hero`) is named
// here with the TEXT ROLE it carries. A field with no entry is RED — which is
// what makes a FOURTH mechanism impossible to add quietly: inventing
// `face.banner` or `face.hero.status` means writing down which permitted role
// its text plays, and there is no role that fits a derived value.
//
// `role` is one of the four permitted roles, or `'none'` for a field that
// carries no painted text at all (ids, keys, flags, geometry).

type TextRole =
  | 'none'
  | 'section-label'
  | 'control-caption'
  | 'option-name'
  | 'annotation'
  // ── #1509 · USER-AUTHORED ENTRY CONTENT ───────────────────────────────────
  //
  // ⚠ THE FIFTH ROLE, ADDED DELIBERATELY, AND THE UNION STAYS CLOSED. Every
  // previous addition to this file was a DELETION; this is the one time a role
  // is added, so the argument is written here rather than in a PR nobody will
  // find.
  //
  // The four roles above exist because the ruling's target is text that
  // RESTATES something a control already shows: a decimal under a dial says
  // what the angle says, a hero strip says what the meter says. That is why
  // "the value lives in `aria-valuetext`" is a complete answer for them — the
  // control still expresses the value, just not in ink.
  //
  // A TEXT FIELD HAS NO NON-TEXT FORM. Its content is not a readout OF the
  // control; it IS the control, the way a knob's angle is. Moving it to
  // `aria-valuetext` would not relocate a redundant restatement, it would
  // delete the only expression the control has — which is how a REST became
  // unreachable in the first draft of this cell (see text-entry-model.ts).
  //
  // ⚠ SO THE LICENCE IS NARROW AND HELD STRUCTURALLY, NOT BY PROMISE. Three
  // properties, each asserted below, and together they make it impossible for a
  // DISPLAY to adopt this role:
  //
  //   1. TYPE     — legal only on a cell whose interface REQUIRES a write
  //                 handler. A display has none, so it cannot claim the role.
  //   2. DOM      — the render site must be a writable <input>: no `readonly`,
  //                 no `disabled`, no `aria-readonly`. An inert box painting a
  //                 computed string is exactly the "there but hidden" shape the
  //                 owner refused BY NAME when `persistentReadout=false` was
  //                 proposed as the fix for offence (1).
  //   3. NO TEXT NODE — the string reaches the DOM only as `value=` on that
  //                 form control. This is the categorical one: a readout needs
  //                 a text node, and this role forbids one. It is not a rule
  //                 about intent, it is a rule about which DOM node the
  //                 characters land in.
  | 'authored-entry';

interface FaceFieldRule {
  /** Which permitted text role this field's strings play at REST. */
  role: TextRole;
  /** Why that role is the right one. Required — `tsc` refuses the bare form. */
  why: string;
}

const FACE_FIELDS: Readonly<Record<string, FaceFieldRule>> = {
  order: {
    role: 'none',
    why: 'A ranked list of control KEYS (param ids / family templates / static keys). Every string resolves to a control that paints its own caption; the list itself paints nothing.',
  },
  pages: {
    role: 'section-label',
    why: 'The band grouping. Each page carries an `id` (never painted) and a `label`, which is a SECTION LABEL — one of the four permitted roles — plus a `hint`, which is annotation-only and gated off at rest by `bandHeaderPlan`.',
  },
  hero: {
    role: 'none',
    why: 'Three control KEYS promoted out of their bands (`cell` / `control` / `action`, each named below). It paints no text of its own: each promoted cell paints its own caption exactly as it would in a band. ⚠ It carried a `readouts` strip until 2026-08-19; see ModuleFaceHero in graph/types.ts.',
  },
  cell: {
    role: 'none',
    why: 'A `face.order` KEY promoted into the hero slot as the module\'s own picture (a PF-14 panel). A key, not a string that paints; the panel it names draws a picture and is forbidden from emitting a control testid.',
  },
  control: {
    role: 'control-caption',
    why: 'A `face.order` KEY promoted into the hero as the big dial. The cell paints its own CAPTION — its name — exactly as it would inside a band; only the size changes.',
  },
  action: {
    role: 'control-caption',
    why: 'A `face.order` KEY promoted into the hero as the audition button. Its text is the button\'s own caption (a control name, e.g. STRIKE), and its observable is the audition ledger rather than any printed value.',
  },
  glyph: {
    role: 'none',
    why: 'Which live trace the shell taps for the tile. A rendering choice — pixels, not text.',
  },
  glyphDepthGain: {
    role: 'none',
    why: 'A scalar on the glyph trace. A number in the declaration, never a number on the screen.',
  },
  extension: {
    role: 'none',
    why: 'The id of a bespoke shell-extension module. A registry key, never painted. ⚠ What the extension itself draws is the canvas blind spot named in this file\'s header.',
  },
  paramCells: {
    role: 'none',
    why: 'Which PRIMITIVE renders a param (grid / color / fader). A widget choice; the primitive owns its own caption and its own readout policy.',
  },
  xyPads: {
    role: 'none',
    why:
      'Which PAIRS of params are one 2-D gesture. Param ids, an optional caption that is a '
      + 'CONTROL LABEL like any other, and a `surface` ENUM naming which surface paints the pad '
      + "at the dock ('band' | 'body'). The enum is STRUCTURE — it decides what is drawn, the way "
      + '`clusterFlow` and `bandFocus` do — and structure is free under the resting-text rulings. '
      + 'No value, measurement or state word reaches a text node from this field.',
  },
  momentary: {
    role: 'none',
    why: 'Marks a param press-and-release. A behaviour flag on a control that already has a caption.',
  },
  bareCells: {
    role: 'control-caption',
    why: 'Declares that a control\'s caption is REDUNDANT under its section heading and must be hidden (the mixmstrs ruling). It can only ever REMOVE resting text, never add it — and it hides the text while keeping the accessible name.',
  },
  channelAccent: {
    role: 'none',
    why: 'A per-channel hue for console bands. Colour, not text.',
  },
  tabbed: {
    role: 'section-label',
    why: 'Forces the dock TAB RAIL on below the band threshold. It adds no text of its own — the rail paints each band\'s own LABEL, which is a section label and already a permitted role; the flag only decides whether those labels appear as a rail or as headers down a column. ⚠ OWNER-INSTRUCTION ONLY per module: the named FACE_TAB_OPT_IN registry in dock-tabs-model.test.ts carries the instruction verbatim and refuses an undeclared adopter.',
  },
  rear: {
    role: 'section-label',
    why: 'Rear-card patch-field curation: section headings over jack groups. A heading is a SECTION LABEL, and the rear card is a different surface from the resting front face in any case.',
  },
  title: {
    role: 'annotation',
    why: 'ANNOTATION-ONLY and off by default: `facePageHeader` returns null unless annotations are explicitly toggled on for that node. The owner ruled the category word off the resting face in 2026-08-02 and it has been gated ever since.',
  },
  hint: {
    role: 'annotation',
    why: 'The same annotation gate as `title` — a sentence about the page, revealed only by the per-node annotate toggle, never synced and never painted at rest.',
  },
  monitor: {
    role: 'none',
    why:
      'MONITOR MODE\'s opt-in (#2009) — "hide the control bands and watch the picture", the ' +
      'inverse of SCREEN ON/OFF. It paints NOTHING: the shell reads it as a boolean through ' +
      '`faceMonitorPlan` to decide whether to RENDER the bands, and the toggle\'s own text is a ' +
      'CONTROL CAPTION on a button inside the module\'s `fullViewBody`. Its one field, `why`, is ' +
      'an argument for the reviewer and for `face-monitor-source.test.ts`; the shell is asserted ' +
      'below never to read it, so it cannot become a fifth resting-text mechanism. ⚠ What the ' +
      'extension body itself draws into its canvas is the blind spot named in this file\'s header.',
  },
  bandFocus: {
    role: 'none',
    why:
      'BAND FOCUS (owner ruling, 2026-08-20) — a param VALUE decides which control bands render, ' +
      'so the picture and the controls steering it share the plate. It paints NOTHING: the shell ' +
      'reads `param` / `showAllOn` / `bands` as a PREDICATE over which bands to draw, exactly as ' +
      '`monitor` above is read as a boolean. Its `why` is an argument for the reviewer and for ' +
      'the totality gate, and the shell is asserted below never to read it. ⚠ Note this field ' +
      'names a PARAM and some BAND IDS — neither is display text: the param id never reaches the ' +
      'DOM, and a band id is already painted as a SECTION LABEL under its own permitted role.',
  },
  rackStatus: {
    role: 'none',
    why:
      'RACK-GLOBAL STATUS (#2024) — state that is a property of the PATCH rather than of this '
      + 'node, and the third axis beside `monitor` (a runtime toggle) and `bandFocus` (a param '
      + 'value). It paints NOTHING: the shell reads `peers` + `primaryOnlyBands` as a PREDICATE '
      + 'over which bands to draw — exactly as `bandFocus` above is read — and `rackStatusPlan` '
      + 'returns a boolean and a set of band ids, never a string. Its `why` is an argument for '
      + 'the reviewer and for `face-rack-status-source.test.ts`, and the shell is asserted below '
      + 'never to read it. ⚠ Note this field names TYPES and BAND IDS: a type id never reaches '
      + 'the DOM, and a band id is already painted as a SECTION LABEL under its own permitted '
      + 'role. ⚠ AND THE TEXT THIS FEATURE DOES PAINT IS NOT HERE — the slot NAME and the '
      + 'indicator lamps live on the module\'s own `fullViewBody`, which is this file\'s canvas '
      + 'blind spot; `face-rack-status-source.test.ts` is what converts that blind spot from '
      + 'unnamed to a deny-by-default roster with a declared role per body.',
  },
  controlFamilies: {
    role: 'control-caption',
    why: 'Not a `face` field itself but reachable beside one; a family renders repeated controls, each painting its own caption.',
  },
};

/** The field names the TYPE declares, read off `ModuleFace` + `ModuleFaceHero`
 *  in graph/types.ts. Read from SOURCE rather than from a live def so a field
 *  that is typed but not yet used by any module is still covered. */
function declaredFaceFields(): string[] {
  const src = stripSourceComments(read(TYPES));
  const out = new Set<string>();
  for (const iface of ['ModuleFace', 'ModuleFaceHero']) {
    const m = new RegExp(`export interface ${iface}\\s*\\{`).exec(src);
    if (!m) continue;
    // walk to the matching close brace
    let depth = 0;
    let i = src.indexOf('{', m.index);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    for (const line of src.slice(start, i).split('\n')) {
      const f = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/.exec(line);
      if (f) out.add(f[1]!);
    }
  }
  return [...out].sort();
}

/** Every `face` key any registered def actually declares. */
function liveFaceKeys(): string[] {
  const defs = [
    ...(listModuleDefs() as unknown as { face?: Record<string, unknown> }[]),
    ...(listVideoModuleDefs() as unknown as { face?: Record<string, unknown> }[]),
    ...(listMetaModuleDefs() as unknown as { face?: Record<string, unknown> }[]),
  ];
  const out = new Set<string>();
  for (const d of defs) {
    if (!d.face) continue;
    for (const k of Object.keys(d.face)) out.add(k);
    const hero = d.face.hero as Record<string, unknown> | undefined;
    if (hero) for (const k of Object.keys(hero)) out.add(k);
  }
  return [...out].sort();
}

describe('the resting faceplate — every declarable field has a PERMITTED text role', () => {
  it('no `face` field is declarable without a named text role', () => {
    const undeclared = declaredFaceFields().filter((f) => !(f in FACE_FIELDS));
    expect(
      undeclared,
      'a new `ModuleFace`/`ModuleFaceHero` field exists with no FACE_FIELDS entry. Before adding ' +
        'one, check what its strings PAINT at rest: the only permitted roles are the module name, ' +
        'a tab/section label, a control caption, and an option/landmark name. A derived value, a ' +
        'state word, a measurement or a sentence has no role here — that is the shape three ' +
        'separate mechanisms have now been deleted for.',
    ).toEqual([]);
  });

  it('no LIVE def declares a face key outside the roster', () => {
    // The type is the primary subject; this is the second direction, so a key
    // smuggled in through a cast or a widened type is caught too.
    const rogue = liveFaceKeys().filter((k) => !(k in FACE_FIELDS));
    expect(
      rogue,
      'a registered def declares a `face` key that the roster does not name. Same question as ' +
        'above: what does its text paint at rest?',
    ).toEqual([]);
  });

  it('ANCHOR: every roster entry still names a real field — a dead entry is RED', () => {
    const live = new Set([...declaredFaceFields(), ...liveFaceKeys()]);
    // `controlFamilies` sits on the def, not inside `face`; it is named here
    // deliberately and is the one entry exempt from the anchor.
    const dead = Object.keys(FACE_FIELDS).filter(
      (k) => k !== 'controlFamilies' && !live.has(k),
    );
    expect(
      dead,
      'a FACE_FIELDS entry names a field that no longer exists. Delete it — a stale entry ' +
        'silently pre-approves whatever takes its name next.',
    ).toEqual([]);
  });

  it('every entry carries a REASON, not a shrug', () => {
    const thin = Object.entries(FACE_FIELDS)
      .filter(([, r]) => r.why.trim().length < 40)
      .map(([k]) => k);
    expect(thin, 'an entry without a stated reason is a suppression').toEqual([]);
  });
});

// ── LEG 1b · THE CELL SURFACE ──────────────────────────────────────────────
//
// ⚠ THIS ROSTER CLOSES A HOLE THAT PREDATES #1509, AND THE HOLE IS THE POINT.
// LEG 1 enumerates `ModuleFace` FIELDS — what a DEF may declare. But a face's
// text is painted by CELLS, and a `ShellCell` kind is not a `face` field, so
// **no cell kind has ever been checked by this file**. That is not theoretical:
// `dx7` has shipped four typed `<input>`s and a `{presetName}{dirty ? ' ✱' : ''}`
// chip on its FACE since PF-14, inside the `dx7-op-detail-{n}` PANEL, and every
// leg here is blind to them because a panel is module-owned markup rather than a
// declared field.
//
// So the same deny-by-default shape is applied one layer down: every kind in the
// `ShellCell` union names the role its strings play, a kind with no entry is RED
// on the TYPE, and an entry naming a kind that no longer exists is RED.
//
// ⚠ WHAT THIS STILL CANNOT SEE, unchanged and stated rather than implied: what a
// PANEL's own component paints. `panel` is declared `'none'` because the CELL
// contributes no text of its own — the component inside it is the canvas blind
// spot this file's header names, and only the dock VRT baselines and a human
// reviewing them can see it. Declaring `'none'` here is a statement about the
// cell, NOT a clearance for its contents.

interface CellKindRule {
  role: TextRole;
  why: string;
  /**
   * For `'authored-entry'` ONLY: the interface field that makes the cell
   * user-writable. Asserted NON-OPTIONAL in `shell-cells.ts` source, which is
   * what stops a read-only cell claiming the role. Required by the TYPE for
   * that role via the assertion below rather than by convention.
   */
  writeField?: string;
}

const CELL_KINDS: Readonly<Record<string, CellKindRule>> = {
  selector: {
    role: 'option-name',
    why: 'A dropdown over a named roster. Its resting string is the CURRENT OPTION NAME — a word that disambiguates the control\'s own position, which is a permitted role — plus a small uppercase `tag` that is a control caption.',
  },
  action: {
    role: 'control-caption',
    why: 'A <Button>. Its text is the button\'s own name (STRIKE, REC, Save table) — a control caption. Its observable is the audition ledger or a node.data key, never a printed result.',
  },
  file: {
    role: 'control-caption',
    why: 'An import button whose text is its caption ("Load .syx bank"). ⚠ It ALSO paints a status/error line after an import — which is a RESULT, not a resting string: it exists only after the player acts, and is absent on every fresh plate. Resting text is what this file governs.',
  },
  toggle: {
    role: 'control-caption',
    why: 'A 0/1 switch backed by node.data. It paints its own label and nothing else; the state is carried by the switch\'s appearance and `aria-pressed`, not by a word.',
  },
  panel: {
    role: 'none',
    why: 'A bespoke component rendered inside a cell. The CELL contributes one caption (handled as a control caption by the shell) and no other text. ⚠ What the COMPONENT paints is this file\'s canvas blind spot — declaring `none` here describes the cell, and is NOT a clearance for the component\'s contents.',
  },
  'warped-fader': {
    role: 'option-name',
    why: 'A throw over a param whose card converts at the boundary. It paints its caption and its LANDMARK NAMES — words placed at named waypoints, which is the option/landmark role — while the value itself goes to `aria-valuetext` through the declared `format`.',
  },
  entry: {
    role: 'authored-entry',
    why: 'The typed-entry field (#1509). Its resting string is what the USER TYPED, round-tripped from the module\'s own store — not a derived quantity, and not a restatement of something the control shows another way, because a text field has no other way. Held structurally: the string reaches the DOM only as `value=` on a writable <input>, so a display cannot adopt this role without becoming one.',
    writeField: 'onCommit',
  },
};

/**
 * The `kind` literal every ShellCell interface declares, read from SOURCE so a
 * kind that is typed but not yet used by any module is still covered.
 *
 * ⚠ IT WALKS THE `ShellCell` UNION, NOT EVERY `kind:` IN THE FILE. The naive
 * scan matched the PROBE discriminants too (`kind: 'audition'`, `kind: 'param'`
 * inside `ShellActionProbe.effect`), which are a different vocabulary entirely —
 * what an action's effect IS, not what a cell PAINTS. Demanding a text role for
 * them would be nonsense, and quietly excluding them by pattern would leave the
 * scan's real subject undefined. The union is the definition of "a ShellCell
 * kind", so that is what this reads.
 */
function declaredCellKinds(src: string): string[] {
  const union = /export type ShellCell =([\s\S]*?);/.exec(src);
  if (!union) return [];
  const names = [...union[1]!.matchAll(/\|\s*(Shell[A-Za-z]+Cell)/g)].map((m) => m[1]!);
  const out = new Set<string>();
  for (const name of names) {
    const iface = new RegExp(`export interface ${name}(?:<[^>]*>)?\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src);
    if (!iface) continue;
    const kind = /^\s*kind:\s*'([a-z-]+)';/m.exec(iface[1]!);
    if (kind) out.add(kind[1]!);
  }
  return [...out].sort();
}

describe('the resting faceplate — every CELL KIND has a permitted text role', () => {
  const cellSrc = stripSourceComments(read(CELLS));

  it('POSITIVE CONTROL: the kind scan read a real registry and found the shipped kinds', () => {
    // Both assertions below are ABSENCES over a derived set, so an empty or
    // misread source would green them silently.
    const kinds = declaredCellKinds(cellSrc);
    expect(cellSrc.length, 'the probe read an empty/missing shell-cells.ts').toBeGreaterThan(10000);
    expect(kinds, 'the scan must find the kinds that demonstrably ship').toEqual(
      expect.arrayContaining(['selector', 'action', 'file', 'toggle', 'panel', 'entry']),
    );
  });

  it('no ShellCell kind is declarable without a named text role', () => {
    const undeclared = declaredCellKinds(cellSrc).filter((k) => !(k in CELL_KINDS));
    expect(
      undeclared,
      'a new `ShellCell` kind exists with no CELL_KINDS entry. Before adding one, ask what its ' +
        'strings PAINT at rest. A cell that paints a derived value has no permitted role — and ' +
        '`authored-entry` is not the escape hatch: it is legal only on a cell that is genuinely ' +
        'user-writable, which the legs below check rather than take on trust.',
    ).toEqual([]);
  });

  it('ANCHOR: every roster entry still names a real kind — a dead entry is RED', () => {
    const live = new Set(declaredCellKinds(cellSrc));
    const dead = Object.keys(CELL_KINDS).filter((k) => !live.has(k));
    expect(
      dead,
      'a CELL_KINDS entry names a kind that no longer exists. Delete it — a stale entry silently ' +
        'pre-approves whatever takes its name next.',
    ).toEqual([]);
  });

  it('every entry carries a REASON, not a shrug', () => {
    const thin = Object.entries(CELL_KINDS)
      .filter(([, r]) => r.why.trim().length < 40)
      .map(([k]) => k);
    expect(thin, 'an entry without a stated reason is a suppression').toEqual([]);
  });

  // ── THE THREE STRUCTURAL LEGS FOR `authored-entry` ────────────────────────

  it('LEG 1 (TYPE): an authored-entry kind REQUIRES a write handler', () => {
    const offenders: string[] = [];
    for (const [kind, rule] of Object.entries(CELL_KINDS)) {
      if (rule.role !== 'authored-entry') {
        if (rule.writeField) offenders.push(`${kind}: declares writeField but is not authored-entry`);
        continue;
      }
      if (!rule.writeField) {
        offenders.push(`${kind}: claims 'authored-entry' without naming the field that makes it writable`);
        continue;
      }
      // The field must be declared NON-OPTIONAL on the interface. `foo?:` is the
      // optional form, so its absence beside a present `foo:` is the assertion.
      const required = new RegExp(`^\\s*${rule.writeField}:`, 'm').test(cellSrc);
      const optional = new RegExp(`^\\s*${rule.writeField}\\?:`, 'm').test(cellSrc);
      if (!required || optional) {
        offenders.push(
          `${kind}: '${rule.writeField}' is not a REQUIRED field in shell-cells.ts. A cell that can ` +
            'omit its write is a display, and a display may not paint an authored-entry string.',
        );
      }
    }
    expect(offenders, 'the authored-entry role must be unusable by a read-only cell').toEqual([]);
  });

  it('LEG 2 (DOM): the entry render site is a WRITABLE input — never readonly or disabled', () => {
    const shell = stripSourceComments(read(SHELL));
    const site = /<div class="kcol ms-cell-entry"[\s\S]*?<\/div>/.exec(shell);
    expect(site, 'no `ms-cell-entry` render site found in ModuleShell — this leg would be vacuous').toBeTruthy();
    const block = site![0];
    for (const banned of ['readonly', 'disabled', 'aria-readonly']) {
      expect(
        block.includes(banned),
        `the entry cell's render site declares \`${banned}\`. An inert box painting a computed ` +
          'string is a READOUT wearing an input\'s clothes — "there but hidden", refused by name.',
      ).toBe(false);
    }
    // And the primitive it mounts must itself be writable.
    const prim = stripSourceComments(read(TEXT_ENTRY));
    expect(prim.includes('<input'), 'TextEntry must render a real <input>').toBe(true);
    for (const banned of ['readonly', 'disabled', 'aria-readonly']) {
      expect(prim.includes(banned), `TextEntry declares \`${banned}\``).toBe(false);
    }
  });

  it('LEG 3 (NO TEXT NODE): the entry value reaches the DOM only as `value=`', () => {
    // The categorical leg. A readout REQUIRES a text node; if the typed string
    // can only ever be an attribute/property of a form control, no amount of
    // re-declaration turns this cell into one.
    const prim = stripSourceComments(read(TEXT_ENTRY));
    expect(
      /value=\{displayValue\}/.test(prim),
      'TextEntry must bind its string to the input\'s `value`',
    ).toBe(true);
    // `{displayValue}` anywhere OUTSIDE a `value=` binding would be a text node.
    const textNodeUse = prim.replace(/value=\{displayValue\}/g, '').includes('{displayValue}');
    expect(
      textNodeUse,
      'TextEntry interpolates its string somewhere other than the input\'s `value` — that is a ' +
        'TEXT NODE, which is what makes something a readout. The whole licence for the ' +
        "'authored-entry' role is that this cannot happen.",
    ).toBe(false);
    // NEGATIVE CONTROL, in both directions: the probe can see a text node when
    // there is one, and does not fire on the `value=` binding alone.
    expect(
      '<span>{displayValue}</span>'.replace(/value=\{displayValue\}/g, '').includes('{displayValue}'),
      'positive control — a real text node must be detected',
    ).toBe(true);
    expect(
      '<input value={displayValue} />'.replace(/value=\{displayValue\}/g, '').includes('{displayValue}'),
      'negative control — the permitted binding must NOT read as a text node',
    ).toBe(false);
  });
});

// ── LEG 2 · THE RENDER SURFACE ─────────────────────────────────────────────
//
// The declaration roster above is only half the answer: the SHELL could paint a
// derived value without any def declaring anything, by reading the live graph
// directly in markup. That is exactly what the hero readout strip did — it
// resolved its numbers through a shell-side registry, not through the contract.
//
// So the shell's own source must not reach a value-formatting path from
// anything that paints. The three deleted seams are named because they are the
// ones that existed; the `data-testid` sweep below is the part that generalises.

/** Symbols whose reappearance in the shell means a deleted mechanism is back. */
const DELETED_SEAMS: readonly { needle: string; why: string }[] = [
  {
    needle: 'face-readout-values',
    why: 'the derived-value registry the hero readout strip resolved its numbers through',
  },
  { needle: 'sidebar-panels', why: 'the `custom` sidebar panel registry' },
  { needle: 'FaceSidebar', why: 'the right-hand context column component' },
  { needle: 'sidebarPlan', why: 'the model function that decided whether the column painted' },
  { needle: 'readoutText', why: 'the value formatter the readout strip printed through' },
  { needle: 'has-sidebar', why: 'the two-column page grid the column occupied' },
];

describe('the resting faceplate — the SHELL cannot paint a value', () => {
  it('no deleted text mechanism has reappeared in the shell', () => {
    const files: [string, string][] = [
      ['ModuleShell.svelte', stripSourceComments(read(SHELL))],
      ['DockFullView.svelte', stripSourceComments(read(DOCK))],
    ];
    const offenders: string[] = [];
    for (const [name, src] of files) {
      for (const s of DELETED_SEAMS) {
        if (src.includes(s.needle)) offenders.push(`${name}: ${s.needle} — ${s.why}`);
      }
    }
    expect(
      offenders,
      'a deleted resting-text mechanism is referenced by the shell again. These were removed by ' +
        'owner ruling, not deprecated; see ModuleFaceHero in graph/types.ts.',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the probe is reading the real shell, and the needles discriminate', () => {
    // Both assertions above are ABSENCES, so a bad path greens them silently.
    // This leg requires the probe to have read a real shell that still paints
    // the things it SHOULD — and requires the needle test to be capable of
    // firing at all.
    const shell = stripSourceComments(read(SHELL));
    expect(shell.length, 'the probe read an empty/missing ModuleShell').toBeGreaterThan(10000);
    expect(
      /data-testid="face-hero"/.test(shell),
      'the hero rail itself must still exist — the deletion was the READOUT STRIP, not the hero',
    ).toBe(true);
    expect(
      /aria-valuetext|controlCell/.test(shell),
      'the shell must still mount control cells; if it does not, the absence checks prove nothing',
    ).toBe(true);
    // The needle mechanism can fire: a string that IS present is found.
    expect(DELETED_SEAMS.every((s) => !shell.includes(s.needle))).toBe(true);
    expect(shell.includes('heroFacePlan'), 'positive control for the same substring probe').toBe(
      true,
    );
  });

  it('MONITOR MODE\'s `why` is an ARGUMENT, never a string the shell can paint', () => {
    // `face.monitor.why` is the newest `ModuleFace` field carrying prose, so it
    // is the newest candidate for the shape this file exists to deny: a
    // sentence declared on the def that finds its way onto the resting plate.
    // The roster entry above says it paints nothing; this is the leg that
    // CHECKS it, at the only place that could do otherwise.
    const shell = stripSourceComments(read(SHELL));
    expect(
      /monitor\s*[?.]*\.\s*why|monitor\.why/.test(shell),
      '`face.monitor.why` is reachable from the shell. It is a reviewer-facing argument for why a ' +
        'face may be watched without its controls — not display text. The shell needs only the ' +
        'BOOLEAN "is it declared", which is what `faceMonitorPlan({ declared })` takes.',
    ).toBe(false);
    // POSITIVE CONTROL for the same probe, so an empty/misread source cannot
    // green the absence above: the shell DOES reach the declaration itself.
    expect(
      /face\?\.monitor/.test(shell),
      'positive control — the shell must still READ `face.monitor` to gate the bands at all',
    ).toBe(true);
  });

  it("BAND FOCUS's `why` is an ARGUMENT, never a string the shell can paint", () => {
    // Same shape as the `monitor` leg above, for the same reason: `bandFocus`
    // is the newest `ModuleFace` field carrying prose, so it is the newest
    // candidate for a sentence declared on a def finding its way onto the
    // resting plate. The roster entry says it paints nothing; this CHECKS it at
    // the only place that could do otherwise.
    const shell = stripSourceComments(read(SHELL));
    expect(
      /bandFocus\s*[?.]*\.\s*why|bandFocus\.why/.test(shell),
      '`face.bandFocus.why` is reachable from the shell. It is a reviewer-facing argument for why ' +
        'hiding the other bands is right on that module — not display text. The shell needs only ' +
        'the PREDICATE (`param` / `showAllOn` / `bands`), which is what `visibleBandIds` takes.',
    ).toBe(false);
    // POSITIVE CONTROL for the same probe, so an empty or misread source cannot
    // green the absence above: the shell DOES reach the declaration itself.
    expect(
      /face\?\.bandFocus|bandFocus/.test(shell),
      'positive control — the shell must still READ `face.bandFocus` to gate the bands at all',
    ).toBe(true);
  });

  it("RACK STATUS's `why` is an ARGUMENT, never a string the shell can paint", () => {
    // Same shape as the `monitor` and `bandFocus` legs above, and the newest
    // candidate for the offence this file exists to deny: `rackStatus` is the
    // third `ModuleFace` field carrying prose, and its subject — "why do this
    // face's controls depend on which OTHER nodes exist" — is exactly the kind
    // of explanation an author would be tempted to show the player.
    const shell = stripSourceComments(read(SHELL));
    expect(
      /rackStatus\s*[?.]*\.\s*why|rackStatus\.why/.test(shell),
      '`face.rackStatus.why` is reachable from the shell. It is a reviewer-facing argument for '
        + 'why a band belongs to one instance only — not display text. The shell needs the '
        + 'PREDICATE (`peers` / `primaryOnlyBands`), which is what `rackStatusPlan` takes, and '
        + 'the player learns the fact from the band being ABSENT, which is structure.',
    ).toBe(false);
    // POSITIVE CONTROL for the same probe, so an empty or misread source cannot
    // green the absence above: the shell DOES reach the declaration itself.
    expect(
      /face\?\.rackStatus|rackStatus/.test(shell),
      'positive control — the shell must still READ `face.rackStatus` to filter the bands at all',
    ).toBe(true);
  });

  it('the hero rail no longer declares a readouts strip anywhere', () => {
    // Anchored to the ARTIFACT rather than to the list: the testid the strip
    // emitted must not exist in any shell-layer file.
    const shell = stripSourceComments(read(SHELL));
    expect(
      /face-hero-readouts|hero-readouts|hero-ro\b/.test(shell),
      'the hero readout strip\'s markup or CSS is back in ModuleShell',
    ).toBe(false);
  });
});
