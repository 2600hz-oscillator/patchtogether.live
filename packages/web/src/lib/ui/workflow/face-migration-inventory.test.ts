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
//   3. BLOCKERS RESOLVE, BOTH WAYS — every blocker a module names is declared
//      with the issue that lands it, and every declaration is named by
//      something. A capability nothing waits on is a stale entry.
//
//   3b. BLOCKERS ARE STILL TRUE — the leg 3 was missing (#1799). Both halves of
//      leg 3 are INTERNAL referential integrity, and a blocker satisfies them
//      just as happily after its capability SHIPS. `needs-extension-registry`
//      did exactly that: #1512 landed shell-extensions.ts with two adopters, the
//      blanket 'bespoke-surface' blocker stayed, and a third of the migration
//      read as un-startable behind a green suite. Every blocker now declares a
//      CAPABILITY PROBE that reads the TREE, and a probe that fires is RED.
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
// Leg 3b has two blind spots of its own, both deliberate and both bounded:
//   - ISSUE STATE. This is a unit lane with no network, and a source gate that
//     needed github.com could not run on CI at all. The probe is the stronger
//     anchor regardless: an issue can be closed with nothing shipped, and a
//     capability can ship with its issue open. What a module WAITS ON is in the
//     tree, not in an issue's status field.
//   - PARTIAL or DIFFERENTLY-SHAPED shipment. Each probe reads ONE structural
//     signal, so a capability that lands somewhere the probe does not look stays
//     invisible to it. That is why every probe must also prove it CAN fire (the
//     `landed` leg) — a probe that never fires is the defect being replaced, and
//     it is refused rather than trusted.
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
import { DOM_SOURCE_LANE_TYPES, HEADLESS_MOUNT_LANE_TYPES } from './dom-source-modules';
// The carve-out set the CARD-OWNED SOURCE gate reads to tell "the card can be
// swapped away" from "the card always mounts" — see that test for why the
// distinction is the whole hazard.
import { NON_SHELL_LANE_TYPES } from './legacy-fallback';
import { shellExtensionIds, WIRED_SHELL_EXTENSION_SLOTS } from './shell-extensions';
import {
  FACE_MIGRATION_INVENTORY,
  MIGRATION_BLOCKERS,
  inventoryEntry,
  migrationBlockers,
  migrationDone,
  staleBlockers,
  type CapabilityEvidence,
  type MigrationBlocker,
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

  it('NEGATIVE CONTROL: a blocker comes from the ENTRY and from nowhere else', () => {
    // There is no DISPOSITION-DERIVED blocker any more (#1799). One used to fan
    // `needs-extension-registry` onto every 'bespoke-surface' entry from a single
    // declaration, which is how one stale line marked a third of the migration
    // un-startable. Assert the derivation is ABSENT, not merely unused: a bespoke
    // entry that types nothing must carry nothing.
    const offenders: string[] = [];
    for (const entry of FACE_MIGRATION_INVENTORY) {
      const typed = [...new Set('blockers' in entry ? (entry.blockers ?? []) : [])].sort();
      const resolved = [...migrationBlockers(entry)];
      if (typed.join('|') !== resolved.join('|')) {
        offenders.push(`${entry.type}: types [${typed.join(', ')}] but resolves to [${resolved.join(', ')}]`);
      }
    }
    expect(
      offenders.sort(),
      'blocker(s) attached to a module by something other than the module. A fan-out declaration ' +
        'goes stale invisibly — if one is genuinely wanted again, it comes back WITH a capability ' +
        'probe, which is what makes such a claim falsifiable.',
    ).toEqual([]);
  });

  it('every declared blocker resolves to a GitHub issue and says what it buys', () => {
    // The SHAPE only — a real issue number, a stated capability, a stated
    // payoff. ⚠ This leg used to add "that the issues are OPEN is checked at
    // review", and #1799 is what that sentence cost: #1512 closed, the review
    // never happened, and nothing mechanical could tell. Whether the capability
    // is still MISSING is now measured from the tree, one describe below.
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

describe('face-migration inventory — blockers are LIVE, measured against the TREE', () => {
  // The legs above check the blocker list against ITSELF: is it declared with an
  // issue, and does anything name it. Both stay true after a capability SHIPS,
  // and that is the whole of #1799 — `needs-extension-registry` outlived #1512
  // by days, with two modules already plugged into the seam it claimed was
  // absent. These legs ask the question the other two structurally cannot: IS
  // THIS SEAM ALREADY IN THE TREE? See the file header for what they cannot see.

  /** ModuleShell.svelte's rendered markup — the ONE renderer every face cell is
   *  painted by (module-shell-import-guard keeps it that way), read with the
   *  same template/predicate pair the gate applies to the legacy cards. */
  function moduleShellTemplate(): string {
    return cardTemplate(readFileSync(join(CARD_DIR, 'ModuleShell.svelte'), 'utf8'));
  }

  /** The live tree, reduced to the facts the probes read. Every field comes off
   *  a REAL artifact — the extension registry's own glob, the shared renderer's
   *  source, the grep-gated headless-mount set — never off another declaration. */
  function treeEvidence(): CapabilityEvidence {
    return {
      shellExtensionIds: shellExtensionIds(),
      wiredShellExtensionSlots: [...WIRED_SHELL_EXTENSION_SLOTS],
      faceShellMountsTypedEntry: mountsTypedEntry(moduleShellTemplate()),
      cardOwnedSourceTypes: [...HEADLESS_MOUNT_LANE_TYPES].sort(),
    };
  }

  it('POSITIVE CONTROL: every evidence field READ a real artifact', () => {
    // Validate the instrument before believing it. A probe reading an artifact
    // that silently failed to resolve returns "not shipped" forever — which is
    // indistinguishable from the truth, and is the exact blindness these legs
    // exist to remove. Membership, never a size.
    expect(
      moduleShellTemplate(),
      'ModuleShell.svelte did not resolve (or stopped being the renderer) — the typed-entry probe ' +
        'would then read FALSE forever, whatever the shell actually mounts',
    ).toContain('<PatchPanel');
    const tree = treeEvidence();
    expect(
      tree.shellExtensionIds,
      "the extension glob discovered no dx7 extension — dx7's algorithm glyph is #1512's own proof " +
        'of the seam, so its absence means the glob (not the fleet) changed',
    ).toContain('dx7');
    expect(
      tree.wiredShellExtensionSlots,
      'ModuleShell renders no glyph extension slot — WIRED_SHELL_EXTENSION_SLOTS is anchored to its ' +
        'source by shell-extensions.test.ts, so this reading empty means the wiring moved',
    ).toContain('glyph');
    expect(
      tree.cardOwnedSourceTypes,
      'the headless-mount set read without archivist — it is the canonical card-owned <video> source',
    ).toContain('archivist');
  });

  it('NO STALE BLOCKER: every declared blocker names a capability the tree does NOT have', () => {
    const stale = staleBlockers(treeEvidence()).map((id) => {
      const b = MIGRATION_BLOCKERS[id as MigrationBlockerId];
      return `${id} (#${b.issue}) — its probe FIRED: ${b.probe.evidence}`;
    });
    expect(
      stale,
      'blocker(s) whose capability is ALREADY IN THE TREE, so nothing is actually waiting on them. ' +
        'Delete the declaration and every `blockers` entry naming it, then re-run ' +
        '`flox activate -- task face:inventory:accept`. If some NARROWER capability is genuinely ' +
        'still missing, declare THAT with its own issue and its own probe — never leave the shipped ' +
        'claim standing, which is how a fifth of the registry read as un-startable (#1799).',
    ).toEqual([]);
  });

  it('BOTH WAYS: every probe reads FALSE on the real tree and TRUE in the world where it lands', () => {
    const tree = treeEvidence();
    const cannotFire = Object.entries(MIGRATION_BLOCKERS)
      .filter(([, b]) => !b.probe.shipped(b.probe.landed(tree)))
      .map(([id]) => `${id}: stays FALSE even on the tree its own \`landed\` describes`);
    expect(
      cannotFire.sort(),
      'capability probe(s) that cannot fire. A probe that can never go red is decoration: it makes ' +
        'the blocker look measured while measuring nothing.',
    ).toEqual([]);
  });

  it('every probe states its EVIDENCE in prose a stranger can check by hand', () => {
    const thin = Object.entries(MIGRATION_BLOCKERS)
      .filter(([, b]) => b.probe.evidence.trim().length < 60)
      .map(([id, b]) => `${id}: probe evidence is ${b.probe.evidence.trim().length} chars`);
    expect(
      thin.sort(),
      'probe(s) whose evidence line is too thin — a reader must be able to check the claim without ' +
        'reading the predicate.',
    ).toEqual([]);
  });

  it('REGRESSION (#1799): the probe `needs-extension-registry` never had catches it', () => {
    // The blocker AS IT STOOD, plus the one field it lacked. This is a PERMANENT
    // leg, not a re-enactment: it runs the SAME predicate the gate above runs,
    // against the SAME real tree, so it reddens if the blocker ever comes back
    // AND if the #1512 seam it names is ever removed.
    const asItStood: MigrationBlocker = {
      issue: 1512,
      capability:
        'a ModuleShell extension registry — a def-declared, lazily resolved slot for a bespoke ' +
        'component (glyph, editor surface, full-view body)',
      unblocks: 'the whole bespoke-surface cohort, which otherwise lands as N special cases',
      probe: {
        evidence:
          'shell-extensions.ts discovers extension modules by glob AND ModuleShell renders at ' +
          'least one of the declared slots',
        shipped: (t) => t.shellExtensionIds.length > 0 && t.wiredShellExtensionSlots.length > 0,
        landed: (t) => ({ ...t, shellExtensionIds: ['dx7'], wiredShellExtensionSlots: ['glyph'] }),
      },
    };
    const record = { 'needs-extension-registry': asItStood };
    expect(
      staleBlockers(treeEvidence(), record),
      'the extension seam (#1512) is no longer detectable in the tree — either it was removed, or ' +
        'this probe stopped reading it. This leg is what proves the gate CAN fire on the real tree.',
    ).toEqual(['needs-extension-registry']);
    // ...and the same probe reads LIVE where the seam does not exist, so it is
    // measuring the seam rather than returning true unconditionally.
    const seamless: CapabilityEvidence = {
      ...treeEvidence(),
      shellExtensionIds: [],
      wiredShellExtensionSlots: [],
    };
    expect(
      staleBlockers(seamless, record),
      'the probe fires with no extension registry at all — it is not measuring the seam',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the stale check runs the PROBE, not the declaration', () => {
    // Same predicate, synthetic record: `staleBlockers` must answer from the
    // probe and nothing else, whichever blockers happen to be declared today —
    // so this control survives the last real blocker being deleted.
    const tree = treeEvidence();
    const live: MigrationBlocker = {
      issue: 1,
      capability: 'a capability nothing in the tree satisfies',
      unblocks: 'nothing',
      probe: { evidence: 'never present', shipped: () => false, landed: (t) => t },
    };
    const shipped: MigrationBlocker = { ...live, probe: { ...live.probe, shipped: () => true } };
    expect(staleBlockers(tree, { 'probe-live': live, 'probe-stale': shipped })).toEqual([
      'probe-stale',
    ]);
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
      // ⚠ THE HAZARD IS "THE CARD GETS SWAPPED AWAY", NOT "THE SOURCE LIVES ON
      // THE CARD" — and for a module in NON_SHELL_LANE_TYPES the swap cannot
      // happen. `laneRenderKind` returns 'legacy' for those whatever
      // `migrated()` says (`hasCard` is false, and the check is
      // `if (!shellFaces || !hasCard) return 'legacy'`), so the real card
      // ALWAYS mounts and the source is never orphaned. `dom-source-modules.ts`
      // already records exactly this about the one module in both sets:
      // "cameraInput is listed here even though it is ALSO a
      // NON_SHELL_LANE_TYPE (its real card always renders in the lane, so it is
      // never swapped and never needs the headless host)".
      //
      // ⚠ THIS IS A NARROWING OF THE PREDICATE, NOT AN EXEMPTION LIST. There is
      // no name here to go stale: the condition is read from the live
      // NON_SHELL_LANE_TYPES set, so a module that LEAVES that set immediately
      // becomes an offender again if it is still generic-face — which is
      // precisely the review that removing such a carve-out should trigger.
      const cardAlwaysMounts = NON_SHELL_LANE_TYPES.has(type);
      if (entry.disposition === 'generic-face' && !cardAlwaysMounts) {
        offenders.push(
          `${type}: dispositioned generic-face, but its source exists only while its card is ` +
            'mounted (DOM_SOURCE_LANE_TYPES) — a face over it renders controls for a dead source',
        );
        continue;
      }
      if (entry.disposition === 'generic-face') continue;
      if (!migrationBlockers(entry).includes('needs-media-controller')) {
        offenders.push(`${type}: is a DOM-source module but does not declare needs-media-controller`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('NEGATIVE CONTROL: the card-always-mounts narrowing is REAL and narrow', () => {
    // Without this, the narrowing above could be silently vacuous (or silently
    // universal) and the sweep would look identical either way.
    //
    // (a) It must actually be load-bearing for someone — i.e. at least one
    //     DOM-source module really is carved out of the swap. If that stops
    //     being true the narrowing is dead code and should be deleted, not left
    //     to imply a protection nobody uses.
    const carved = [...DOM_SOURCE_LANE_TYPES].filter((t) => NON_SHELL_LANE_TYPES.has(t));
    expect(carved, 'no DOM-source module is carved out — the narrowing is dead').not.toEqual([]);

    // (b) It must NOT be universal: the great majority of DOM-source modules are
    //     still swappable, and for those the original hazard stands untouched.
    const swappable = [...DOM_SOURCE_LANE_TYPES].filter((t) => !NON_SHELL_LANE_TYPES.has(t));
    expect(swappable, 'every DOM-source module is carved out — the gate now checks nothing')
      .not.toEqual([]);

    // (c) And the predicate itself must still say NO for a swappable one. This
    //     is the leg that fails if someone "simplifies" the condition to a
    //     blanket skip.
    for (const t of swappable) {
      expect(
        NON_SHELL_LANE_TYPES.has(t),
        `${t} is swappable, so the card-always-mounts narrowing must not cover it`,
      ).toBe(false);
    }
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
