// packages/web/src/lib/ui/workflow/face-migration-inventory.test.ts
//
// THE RATCHET for the total migration record (LEG-01, #1510).
//
// The inventory is only worth having if it is TOTAL and stays total without
// anyone counting anything. Four gates make that structural:
//
//   1. TOTALITY / ANCHORING — a registered def with no disposition is RED, and
//      an entry naming a def that no longer exists is RED. Deny by default in
//      both directions, so a new module cannot merge without a disposition and a
//      deleted module cannot leave a ghost behind.
//
//   2. IDENTITY WITH THE FACED POPULATION — the done-set IS `STRICT_FACES`, and
//      every def that DECLARES a `face` is dispositioned 'generic-face'. This
//      file does NOT re-derive faced-ness: module-face-lint.test.ts already
//      pins `STRICT_FACES` ≡ "the defs declaring a face", in both directions,
//      and this keys off that set rather than forking a second derivation.
//
//   3. BLOCKERS RESOLVE, BOTH WAYS — every blocker a module or a disposition
//      names is declared with the issue that lands it, and every declaration is
//      named by something. A capability nothing waits on is a stale entry.
//
//   4. DERIVED FROM THE TREE, NOT FROM THE LIST — the two judgements that can be
//      made mechanically are re-derived here from the cards and from the
//      committed DOM-source set, so the classification cannot quietly disagree
//      with the code: a card that mounts TYPED ENTRY cannot be 'generic-face'
//      (the face has no text cell — card-primitive-parity declares NoteEntry
//      `via: 'none'`), and a card that OWNS its engine source cannot be either.
//
// ⚠ WHAT THIS GATE CANNOT SEE, stated inside the gate. Three of the four
// dispositions are a JUDGEMENT about whether a module's primary interaction is
// param-shaped, and no test can make that call — a card of plain knobs may still
// hide a behaviour a face cannot express, and the per-module PR is where that
// gets found. What IS mechanical is checked in leg 4 above, and leg 4 is
// positively controlled below (if the card reader silently stopped resolving
// cards, every derived clause would pass on an empty set — so the resolution
// itself is asserted, per module).
//
// NO POPULATION COUNTS. Every assertion is membership or identity; the counts a
// human wants live in the GENERATED artifact (docs/design/face-migration.generated.md),
// which is pinned by the freshness gate at the bottom and read by nothing.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

import { STRICT_FACES } from './strict-faces';
import { DOM_SOURCE_LANE_TYPES } from './dom-source-modules';
import {
  FACE_MIGRATION_INVENTORY,
  MIGRATION_BLOCKERS,
  DISPOSITION_BLOCKER,
  inventoryEntry,
  migrationBlockers,
  migrationDone,
  type MigrationBlockerId,
} from './face-migration-inventory';
import { renderFaceMigrationReport, type ReportModule } from './face-migration-report';

const HERE = dirname(fileURLToPath(import.meta.url));
const CARD_DIR = resolve(HERE, '../modules');
// workflow → ui → lib → src → web → packages → repo root.
const REPORT_PATH = resolve(HERE, '../../../../../../docs/design/face-migration.generated.md');

interface RegisteredDef {
  type: string;
  domain?: string;
  card?: string;
  face?: ModuleFace;
}

function allDefs(): RegisteredDef[] {
  return [
    ...(listModuleDefs() as unknown as RegisteredDef[]),
    ...(listVideoModuleDefs() as unknown as RegisteredDef[]),
    ...(listMetaModuleDefs() as unknown as RegisteredDef[]),
  ].sort((a, b) => a.type.localeCompare(b.type));
}

/** CADILLAC is drawn as a full-canvas overlay, never as a flow node, so it is
 *  the one registered def with no card file — the same carve-out
 *  modules-card-map.test.ts makes, for the same reason. */
const NO_CARD_BY_DESIGN = new Set(['cadillac']);

function cardPathFor(def: RegisteredDef): string {
  return join(CARD_DIR, `${def.card ?? conventionalCardName(def.type)}.svelte`);
}

/** The RENDERED markup only: script blocks, style blocks and comments removed.
 *  Documentation that spells out a banned form must never read as the form —
 *  the same discipline the PatchPanel gate applies one directory up. */
export function cardTemplate(src: string): string {
  return src
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Does this card mount TYPED ENTRY — the primitive class the face system has no
 * cell for (`card-primitive-parity.test.ts`: NoteEntry `via: 'none'`, and the
 * raw text input shares the gap)?
 *
 * Deliberately NOT matched: `range` (a fader in disguise), `file` (there IS a
 * file cell), `color` (there IS a colour cell), `checkbox` / `radio` (toggles).
 * Those are all expressible today, and matching them would turn this leg into a
 * blanket ban on `<input>`.
 */
export function mountsTypedEntry(template: string): boolean {
  if (/<NoteEntry[\s/>]/.test(template)) return true;
  if (/<textarea[\s/>]/.test(template)) return true;
  if (/contenteditable/.test(template)) return true;
  return /<input\b[^>]*\btype="(text|number|url|search|email|tel)"/.test(template);
}

/** Card sources, resolved once: type → rendered template. A type missing here
 *  either has no card by design or FAILED TO RESOLVE, and the difference is
 *  asserted (a silently empty read would make every derived clause vacuous). */
function cardTemplates(): { templates: Map<string, string>; unreadable: string[] } {
  const templates = new Map<string, string>();
  const unreadable: string[] = [];
  for (const def of allDefs()) {
    if (NO_CARD_BY_DESIGN.has(def.type)) continue;
    const path = cardPathFor(def);
    if (!existsSync(path)) {
      unreadable.push(`${def.type} → ${path.split('/').pop()}`);
      continue;
    }
    const src = readCardSourceWithDelegates(path, CARD_DIR, { readFileSync, existsSync }, join);
    const tmpl = cardTemplate(src);
    if (tmpl.trim() === '') {
      unreadable.push(`${def.type} → template read as EMPTY`);
      continue;
    }
    templates.set(def.type, tmpl);
  }
  return { templates, unreadable };
}

describe('face-migration inventory — TOTALITY (deny by default, both directions)', () => {
  it('every registered def carries exactly one disposition', () => {
    const missing = allDefs()
      .map((d) => d.type)
      .filter((t) => !inventoryEntry(t))
      .sort();
    expect(
      missing,
      'registered module(s) with NO entry in face-migration-inventory.ts. Every module needs a ' +
        'disposition before it merges — that is what keeps the migration record total. Add one ' +
        '(generic-face | bespoke-surface | organizational-native | blocked + a named blocker).',
    ).toEqual([]);
  });

  it('ANCHORED TO THE ARTIFACT: every entry names a live registered def', () => {
    const registered = new Set(allDefs().map((d) => d.type));
    const ghosts = FACE_MIGRATION_INVENTORY.map((e) => e.type)
      .filter((t) => !registered.has(t))
      .sort();
    expect(
      ghosts,
      'inventory entr(ies) naming a module type that is not registered — a renamed or deleted ' +
        'module left a ghost. Delete the entry (or fix the type id).',
    ).toEqual([]);
  });

  it('no module is dispositioned twice', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of FACE_MIGRATION_INVENTORY) {
      if (seen.has(e.type)) dupes.push(e.type);
      seen.add(e.type);
    }
    expect(dupes.sort(), 'module type(s) with more than one inventory entry').toEqual([]);
  });
});

describe('face-migration inventory — IDENTITY with the faced population', () => {
  it('the DONE set IS STRICT_FACES — both directions, no count', () => {
    const done = allDefs()
      .map((d) => d.type)
      .filter((t) => {
        const entry = inventoryEntry(t);
        return !!entry && migrationDone(entry, STRICT_FACES.has(t));
      })
      .sort();
    expect(
      done,
      'the inventory\'s done-set (generic-face ∩ STRICT_FACES) must BE STRICT_FACES. A promoted ' +
        'module missing here is dispositioned as something other than generic-face; a STRICT_FACES ' +
        'name missing from the registry is module-face-lint\'s to report.',
    ).toEqual([...STRICT_FACES].sort());
  });

  it('every def that DECLARES a `face` is dispositioned generic-face', () => {
    // The independent leg: read the DEF, not the promoted set. A module cannot
    // be "needs a bespoke surface" and ship a curated face at the same time.
    const contradictions = allDefs()
      .filter((d) => d.face)
      .filter((d) => inventoryEntry(d.type)?.disposition !== 'generic-face')
      .map((d) => `${d.type}: declares a face but is dispositioned ${inventoryEntry(d.type)?.disposition ?? 'NOTHING'}`)
      .sort();
    expect(contradictions, 'def(s) whose live `face` contradicts their disposition').toEqual([]);
  });
});

describe('face-migration inventory — blockers resolve, in both directions', () => {
  const declaredIds = new Set(Object.keys(MIGRATION_BLOCKERS) as MigrationBlockerId[]);

  it('every blocker a module or a disposition names is DECLARED with its issue', () => {
    const undeclared: string[] = [];
    for (const entry of FACE_MIGRATION_INVENTORY) {
      for (const id of migrationBlockers(entry)) {
        if (!declaredIds.has(id)) undeclared.push(`${entry.type} → '${id}'`);
      }
    }
    expect(undeclared.sort(), 'blocker id(s) with no entry in MIGRATION_BLOCKERS').toEqual([]);
  });

  it('ANCHORED: every declared blocker is named by something', () => {
    const used = new Set<MigrationBlockerId>();
    for (const entry of FACE_MIGRATION_INVENTORY) {
      for (const id of migrationBlockers(entry)) used.add(id);
    }
    const orphaned = [...declaredIds].filter((id) => !used.has(id)).sort();
    expect(
      orphaned,
      'declared blocker(s) no module (and no disposition) waits on — a capability nothing needs ' +
        'is a stale entry, not a roadmap. Delete it, or the modules that needed it were ' +
        'reclassified and the issue can be closed.',
    ).toEqual([]);
  });

  it('every `blocked` entry names at least one blocker, and no generic-face entry names any', () => {
    // The type already says both; assert them anyway, because a `satisfies` /
    // cast at an edit site can bypass the type and nothing else would notice.
    const offenders: string[] = [];
    for (const entry of FACE_MIGRATION_INVENTORY) {
      const declared = 'blockers' in entry ? (entry.blockers ?? []) : [];
      if (entry.disposition === 'blocked' && declared.length === 0) {
        offenders.push(`${entry.type}: 'blocked' with no named blocker`);
      }
      if (entry.disposition === 'generic-face' && declared.length > 0) {
        offenders.push(`${entry.type}: 'generic-face' cannot be waiting on a capability`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('every declared blocker resolves to a GitHub issue and says what it buys', () => {
    // Cheap by design (#1510: "checked by the test via a committed list, or at
    // review time"). The test pins the SHAPE — a real issue number, a stated
    // capability, a stated payoff; that the issues are OPEN is checked at review
    // (#1509 note-entry, #1511 media lifecycle, #1512 extension registry).
    const bad: string[] = [];
    for (const [id, b] of Object.entries(MIGRATION_BLOCKERS)) {
      if (!Number.isInteger(b.issue) || b.issue <= 0) bad.push(`${id}: issue ${b.issue}`);
      if (b.capability.trim().length < 40) bad.push(`${id}: capability too thin to act on`);
      if (b.unblocks.trim().length < 40) bad.push(`${id}: unblocks too thin to act on`);
    }
    expect(bad.sort()).toEqual([]);
    const issues = Object.values(MIGRATION_BLOCKERS).map((b) => b.issue);
    expect(new Set(issues).size, 'two blockers pointing at the same issue').toBe(issues.length);
  });
});

describe('face-migration inventory — every exception carries its reason', () => {
  it('a non-generic disposition states WHY, in prose a stranger can act on', () => {
    const thin: string[] = [];
    for (const entry of FACE_MIGRATION_INVENTORY) {
      if (entry.disposition === 'generic-face') continue;
      const why = entry.why ?? '';
      if (why.trim().length < 60) thin.push(`${entry.type}: why is ${why.trim().length} chars`);
    }
    expect(
      thin.sort(),
      'exception(s) whose `why` is too thin — the reason is the deliverable here; a cohort agent ' +
        'reads it instead of re-deriving the classification.',
    ).toEqual([]);
  });
});

describe('face-migration inventory — DERIVED from the tree, not from this list', () => {
  const { templates, unreadable } = cardTemplates();

  it('POSITIVE CONTROL: every registered card actually resolved and was read', () => {
    // Without this, a moved directory or a renamed convention would empty the
    // scan and turn every clause below into a green assertion over nothing.
    expect(
      unreadable.sort(),
      'card source(s) that did not resolve — the derived legs below are BLIND to these modules',
    ).toEqual([]);
    expect(
      [...templates.keys()].sort(),
      'the scan must cover every registered def except the one with no card by design',
    ).toEqual(
      allDefs()
        .map((d) => d.type)
        .filter((t) => !NO_CARD_BY_DESIGN.has(t))
        .sort(),
    );
  });

  it('TYPED ENTRY: no generic-face module mounts it, and every module that does declares the blocker', () => {
    const offenders: string[] = [];
    for (const [type, tmpl] of templates) {
      if (!mountsTypedEntry(tmpl)) continue;
      const entry = inventoryEntry(type);
      if (!entry) continue; // reported by the totality gate
      if (entry.disposition === 'generic-face') {
        offenders.push(
          `${type}: dispositioned generic-face, but its card mounts typed entry — the face system ` +
            'has no text cell (card-primitive-parity: NoteEntry via:none)',
        );
        continue;
      }
      if (entry.disposition === 'organizational-native') continue; // the text IS the object
      if (!migrationBlockers(entry).includes('needs-note-entry-cell')) {
        offenders.push(`${type}: its card mounts typed entry but it does not declare needs-note-entry-cell`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('POSITIVE CONTROL: the typed-entry scan finds the cards it must', () => {
    // Membership, not size: named cards known to mount each form. If the scan
    // silently stopped matching, this fails before the clause above goes vacuous.
    const found = [...templates].filter(([, t]) => mountsTypedEntry(t)).map(([type]) => type);
    for (const type of ['sequencer', 'drumseqz', 'sticky', 'textmarquee']) {
      expect(found, `${type} mounts typed entry in the tree and the scan must see it`).toContain(type);
    }
  });

  it('NEGATIVE CONTROL: the typed-entry predicate fires on each typed form, and only on those', () => {
    expect(mountsTypedEntry('<NoteEntry value={x} />')).toBe(true);
    expect(mountsTypedEntry('<textarea bind:value={t}></textarea>')).toBe(true);
    expect(mountsTypedEntry('<div contenteditable="true"></div>')).toBe(true);
    expect(mountsTypedEntry('<input class="a" type="text" />')).toBe(true);
    expect(mountsTypedEntry('<input type="number" min="0" />')).toBe(true);
    // The expressible ones must NOT fire — otherwise this leg is a blanket ban
    // on <input> and every file/colour/toggle card reads as blocked.
    expect(mountsTypedEntry('<input type="range" min="0" max="1" />')).toBe(false);
    expect(mountsTypedEntry('<input type="file" accept="audio/*" />')).toBe(false);
    expect(mountsTypedEntry('<input type="color" />')).toBe(false);
    expect(mountsTypedEntry('<input type="checkbox" />')).toBe(false);
    expect(mountsTypedEntry('<Knob paramId="gain" />')).toBe(false);
    // And a card that only TALKS about typed entry is not a card that mounts it.
    expect(mountsTypedEntry(cardTemplate('<!-- a <textarea> would need #1509 -->'))).toBe(false);
    expect(mountsTypedEntry(cardTemplate('<script>const s = \'<input type="text">\';</script>'))).toBe(false);
  });

  it('CARD-OWNED SOURCE: no generic-face module owns one, and every one that does declares the blocker', () => {
    // DOM_SOURCE_LANE_TYPES is itself grep-gated against the cards that call
    // attachExternalSource (dom-source-modules.test.ts), so this reads a
    // maintained artifact rather than re-grepping for the same thing.
    const offenders: string[] = [];
    for (const type of [...DOM_SOURCE_LANE_TYPES].sort()) {
      const entry = inventoryEntry(type);
      if (!entry) continue; // reported by the totality gate
      if (entry.disposition === 'generic-face') {
        offenders.push(
          `${type}: dispositioned generic-face, but its source exists only while its card is ` +
            'mounted (DOM_SOURCE_LANE_TYPES) — a face over it renders controls for a dead source',
        );
        continue;
      }
      if (!migrationBlockers(entry).includes('needs-media-controller')) {
        offenders.push(`${type}: is a DOM-source module but does not declare needs-media-controller`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('NEGATIVE CONTROL: the disposition-derived blocker reaches every bespoke entry', () => {
    // DISPOSITION_BLOCKER is the one blocker nobody types per module, so the
    // derivation is the only thing carrying it. Assert it both ways.
    expect(DISPOSITION_BLOCKER['bespoke-surface']).toBe('needs-extension-registry');
    const bespoke = FACE_MIGRATION_INVENTORY.filter((e) => e.disposition === 'bespoke-surface');
    const missing = bespoke
      .filter((e) => !migrationBlockers(e).includes('needs-extension-registry'))
      .map((e) => e.type);
    expect(missing.sort(), 'bespoke entr(ies) the disposition-derived blocker did not reach').toEqual([]);
    const generic = FACE_MIGRATION_INVENTORY.filter((e) => e.disposition === 'generic-face');
    const leaked = generic
      .filter((e) => migrationBlockers(e).includes('needs-extension-registry'))
      .map((e) => e.type);
    expect(leaked.sort(), 'generic-face entr(ies) the seam blocker leaked onto').toEqual([]);
  });
});

describe('face-migration inventory — the GENERATED progress artifact', () => {
  function reportModules(): ReportModule[] {
    return allDefs().map((d) => ({
      type: d.type,
      domain: d.domain ?? 'unknown',
      faced: STRICT_FACES.has(d.type),
    }));
  }

  it('the committed report matches a fresh regeneration from the record + the registry', () => {
    const current = renderFaceMigrationReport(reportModules());
    if (process.env.FACE_INVENTORY_UPDATE) {
      writeFileSync(REPORT_PATH, current, 'utf8');
      return;
    }
    let committed = '';
    try {
      committed = readFileSync(REPORT_PATH, 'utf8');
    } catch {
      committed = '';
    }
    expect(
      committed,
      'docs/design/face-migration.generated.md is STALE — a disposition, a blocker or the module ' +
        'registry moved. Regenerate with `flox activate -- task face:inventory:accept` and review ' +
        'the diff (a diff = the migration moved: accept it, or recognize a bug).',
    ).toBe(current);
  });

  it('is deterministic (two regenerations are byte-identical)', () => {
    expect(renderFaceMigrationReport(reportModules())).toBe(
      renderFaceMigrationReport(reportModules()),
    );
  });

  it('NEGATIVE CONTROL: the report NOTICES a module with no disposition', () => {
    // The artifact a human reads must not be able to quietly omit the failure
    // the gate exists for. Feed it a module the record has never heard of.
    const SECTION = '## ⚠ registered with NO disposition';
    const md = renderFaceMigrationReport([
      ...reportModules(),
      { type: 'zzUnclassifiedProbe', domain: 'audio', faced: false },
    ]);
    expect(md).toContain(SECTION);
    expect(md).toContain('zzUnclassifiedProbe');
    // …and does not cry wolf on the real tree (the summary row above always
    // names the measure — this asserts the SECTION, which only an offender
    // opens).
    expect(renderFaceMigrationReport(reportModules())).not.toContain(SECTION);
  });
});
