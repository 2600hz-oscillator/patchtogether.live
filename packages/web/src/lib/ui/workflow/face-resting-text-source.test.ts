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
//     to stop doing shit like that. i said minimal, and good use of screen real
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

type TextRole = 'none' | 'section-label' | 'control-caption' | 'option-name' | 'annotation';

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
    why: 'Which PAIRS of params are one 2-D gesture. Param ids only.',
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
