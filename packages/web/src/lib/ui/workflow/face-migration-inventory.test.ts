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
import { DOM_SOURCE_LANE_TYPES } from './dom-source-modules';
import { shellExtensionIds, WIRED_SHELL_EXTENSION_SLOTS } from './shell-extensions';
import { shellCellKindsFor } from './shell-cells';
import {
  FACE_MIGRATION_INVENTORY,
  MIGRATION_BLOCKERS,
  inventoryEntry,
  migrationBlockers,
  migrationDone,
  staleBlockers,
  type CapabilityEvidence,
  type MigrationBlocker,
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

/** The declared `face` for one module type, or undefined. */
function faceOf(type: string): ModuleFace | undefined {
  return allDefs().find((d) => d.type === type)?.face;
}

/**
 * The SOURCE of an extension's `fullViewBody` component, or null.
 *
 * ⚠ THE FILE, NOT THE COMPONENT: `shell-extensions`' `import.meta.glob` is LAZY,
 * so the component object is unreachable from a node-env test. Same ten-liner as
 * `face-rack-status-source.test.ts` — two gates reading one seam the same way.
 *
 * READ THE SAME WAY THE CARD IS — its own source plus the local `.svelte` components it delegates to, one
 * level deep, through the shared `readCardSourceWithDelegates`.
 *
 * ⚠ THE DELEGATE FOLLOW IS A SYMMETRY FIX, NOT A WIDENING FOR ITS OWN SAKE, and
 * the asymmetry it removes was latent rather than theoretical. The typed-entry
 * leg below compares a CARD's markup against a BODY's, and the card side has
 * followed delegates since 2026-08-07 (`$lib/ui/card-source`, written for
 * exactly this: "a gate reading only the wrapper concludes whatever 'no markup'
 * happens to mean for it"). Reading the body WITHOUT delegates made the
 * comparison green only while BOTH sides were blind to the same file — which is
 * how archivist and peertube passed, since each carries its typed field inside
 * a component its body imports. The moment the card side could see one, they
 * would have reddened for carrying the affordance correctly.
 */
function fullViewBodySource(extId: string): string | null {
  const ext = resolve(CARD_DIR, extId, 'shell-extension.ts');
  if (!existsSync(ext)) return null;
  const src = readFileSync(ext, 'utf8');
  const m = /fullViewBody:\s*([A-Za-z0-9_]+)/.exec(src);
  if (!m) return null;
  const imported = new RegExp(`import\\s+${m[1]}\\s+from\\s+'\\./([^']+)'`).exec(src);
  if (!imported) return null;
  const file = resolve(CARD_DIR, extId, imported[1]!);
  if (!existsSync(file)) return null;
  return readCardSourceWithDelegates(
    file,
    resolve(CARD_DIR, extId),
    { readFileSync, existsSync },
    join,
  );
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
  // The GENERIC typed-entry primitive (#1509), beside the note-specific
  // composite above. Both are component tags that render a typed `<input>`, so
  // a subject that named only one of them would read "no typed entry" on a
  // surface that has it — which on `ModuleShell` is the difference between the
  // note-entry blocker being live and being stale.
  if (/<TextEntry[\s/>]/.test(template)) return true;
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
  const declaredIds = new Set<string>(Object.keys(MIGRATION_BLOCKERS));

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
    const used = new Set<string>();
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
    // ⚠ THE `cardOwnedSourceTypes` ANCHOR THAT STOOD HERE RETIRED WITH ITS
    // FIELD (legacy-removal S1.5). Its own failure message prescribed exactly
    // this: "either every producer has been extracted (in which case
    // <HeadlessSourceHost> and the evidence field should go with them) or this
    // probe stopped resolving". The first arm happened — every former member
    // of the headless-mount union is node-owned, the host is deleted, and the
    // deleted `needs-media-controller` blocker was the field's last probe
    // reader — so the field and this control went together, as designed.
  });

  it('NO STALE BLOCKER: every declared blocker names a capability the tree does NOT have', () => {
    const stale = staleBlockers(treeEvidence()).map((id) => {
      const b = MIGRATION_BLOCKERS[id]!;
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

  // ── TYPED ENTRY — THE PARITY FORM (#1509) ─────────────────────────────────
  //
  // ⚠ THIS LEG USED TO BE A FLAT PROHIBITION, AND ITS PRECONDITION IS THE THING
  // #1509 REMOVED. It read: a `generic-face` module whose CARD mounts typed
  // entry is an offender, *"the face system has no text cell"* — with the rest
  // of the fleet required to declare `needs-note-entry-cell` instead. Both
  // halves are now false: `ModuleShell` mounts `ShellEntryCell` -> `TextEntry`,
  // and the blocker is deleted.
  //
  // ⚠ SO THIS IS A REPAIR, NOT A RELAXATION, AND THE DIRECTION MATTERS. Left
  // alone the old leg does not go vacuous — it goes INVERTED, refusing exactly
  // the legitimate faces the capability was built to enable (cartesian is the
  // first). Deleting it would be the relaxation. Instead the premise is
  // rewritten to what it was always trying to say:
  //
  //   the face may carry typed entry — it must just ACTUALLY CARRY IT.
  //
  // A `generic-face` module whose card mounts typed entry is an offender UNLESS
  // its face carries the affordance, by one of the two routes that exist:
  //
  //   (1) a registered `entry`/`panel` cell in `SHELL_CELLS[type]` — the panel
  //       arm is not a loophole: a panel is module-owned markup that a face
  //       renders, which is exactly "the face carries it" (cartesian's grid).
  //   (2) `face.extension` whose `fullViewBody` source mounts typed entry —
  //       the wave-6/7 cohort's route (a device picker's own body).
  //
  // DENY-BY-DEFAULT WITH NO LIST: there is no exemption roster, and the escape
  // is carrying the affordance, which is the outcome wanted anyway. ANCHORED
  // BOTH WAYS: if a face later drops its entry cell or its body drops its
  // `<input>`, this reddens again — which is the regression a face PR could
  // otherwise introduce silently.
  //
  // ⚠ WHAT IT STILL CANNOT SEE, stated rather than discovered later: a SOURCE
  // scan cannot tell that the face's typed field is the SAME affordance the
  // card had — only that one of the same kind exists. That is the identical gap
  // `module-docs-lint`'s family↔card leg names about itself ("PRESENCE-ONLY"),
  // and it is the right trade at this tier: presence is checkable in the unit
  // lane, identity is not. A RUNTIME oracle would be worse rather than better —
  // a device-picker body renders its `<input>` only after a hardware grant, and
  // CI has no device, so the scan would read "no typed entry" and pass FOR THE
  // WRONG REASON.
  it('TYPED ENTRY: a faced module whose CARD types must CARRY typed entry on its face', () => {
    const offenders: string[] = [];
    for (const [type, tmpl] of templates) {
      if (!mountsTypedEntry(tmpl)) continue;
      const entry = inventoryEntry(type);
      if (!entry) continue; // reported by the totality gate
      if (entry.disposition === 'organizational-native') continue; // the text IS the object
      if (entry.disposition !== 'generic-face') continue; // not faced yet — nothing to carry
      const kinds = shellCellKindsFor(type);
      const hasCell = kinds.includes('entry') || kinds.includes('panel');
      const extId = faceOf(type)?.extension;
      const body = extId ? fullViewBodySource(extId) : null;
      const hasBody = !!body && mountsTypedEntry(body);
      if (!hasCell && !hasBody) {
        offenders.push(
          `${type}: its CARD mounts typed entry and its face carries none — no 'entry'/'panel' ` +
            `cell in SHELL_CELLS['${type}'] and no face.extension fullViewBody that types. ` +
            'Promotion deletes the card from both surfaces, so that affordance is now unreachable.',
        );
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('NEGATIVE CONTROL: the parity form FIRES on a faced module carrying nothing', () => {
    // The leg above is an ABSENCE over a population that is currently small, so
    // a bad predicate greens it silently. Drive the same two clauses over a
    // synthetic module that types on its card and carries nothing on its face,
    // and over one that carries a cell — the check must separate them.
    const carries = (cellKinds: string[], bodySrc: string | null) =>
      cellKinds.some((k) => k === 'entry' || k === 'panel') ||
      (!!bodySrc && mountsTypedEntry(bodySrc));
    expect(carries([], null), 'a face carrying nothing must NOT pass').toBe(false);
    expect(carries(['selector', 'toggle'], null), 'unrelated cells must NOT pass').toBe(false);
    expect(carries(['entry'], null), 'an entry cell carries it').toBe(true);
    expect(carries(['panel'], null), 'a panel carries it').toBe(true);
    expect(carries([], '<textarea bind:value={t}></textarea>'), 'a typing body carries it').toBe(true);
    expect(carries([], '<button>press</button>'), 'a non-typing body does NOT').toBe(false);
  });

  it('POSITIVE CONTROL: cartesian is the faced module this leg actually exercises', () => {
    // Membership, not size — and anchored so that if cartesian is ever
    // un-faced or its grid panel is renamed, the leg above stops being
    // exercised LOUDLY rather than silently.
    const entry = inventoryEntry('cartesian');
    expect(entry?.disposition, 'cartesian is faced').toBe('generic-face');
    expect(
      mountsTypedEntry(templates.get('cartesian') ?? ''),
      'CartesianCard still mounts <NoteEntry> — the condition this leg tests',
    ).toBe(true);
    expect(
      shellCellKindsFor('cartesian').includes('panel'),
      'and its face carries the pad grid panel',
    ).toBe(true);
  });

  it('POSITIVE CONTROL: the typed-entry scan finds the cards it must', () => {
    // Membership, not size: named cards known to mount each form. If the scan
    // silently stopped matching, this fails before the clause above goes vacuous.
    // ⚠ `sticky` WAS THE THIRD WITNESS and is deleted with its module (owner
    // ruling). Its card mounted a bare `<textarea>` — the plainest typed-entry
    // form the scan matches — so losing it costs this control its clearest
    // example; `cartesian` (an <input type="number">) and `textmarquee` (a
    // text <input>) still cover two of the predicate's three forms, and the
    // NEGATIVE CONTROL below exercises the <textarea> arm directly.
    const found = [...templates].filter(([, t]) => mountsTypedEntry(t)).map(([type]) => type);
    for (const type of ['cartesian', 'textmarquee']) {
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

  // ── CARD-OWNED SOURCE ─────────────────────────────────────────────────────
  //
  // ⚠ THE GATE'S ORIGINAL REASON WAS ALREADY STALE WHEN THIS WAS WRITTEN, and
  // saying so is the point rather than a footnote. Its message read "a face over
  // it renders controls for a DEAD SOURCE". That has not been true of any member
  // since `<HeadlessSourceHost>` shipped: `needsHeadlessSourceMount` returns
  // true for kind 'shell', so promoting a DOM-source module keeps its real card
  // mounted off-screen and the source keeps producing. A gate whose stated
  // reason is false is still protecting something — it just is not protecting
  // the thing it claims, and the next person to read it will "fix" the wrong
  // half.
  //
  // ⚠ THE REAL HAZARD IS REACHABILITY, NOT LIVENESS. A headless host is
  // `pointer-events: none` and parked at `left:-9999px`, so promotion makes
  // every INTERACTIVE affordance the card draws unclickable in the default
  // shell — a file picker, a URL field, a transport, an acquire gesture. On
  // cameraInput that is "Request access", the only route to `getUserMedia` for a
  // visitor this origin has not granted before, so the failure is a first-run
  // dead end rather than a degraded one. The face's own controls are alive and
  // the module is unusable, which is exactly the shape a params-only gate cannot
  // see.
  //
  // ⚠ SO THE EXEMPTION IS NOT A PREDICATE NARROWING. An earlier draft of this
  // work narrowed the condition to "the card always mounts" by reading
  // NON_SHELL_LANE_TYPES live. That was a correct statement about a module that
  // was carved out of the swap — and it evaporates the moment the module is
  // promoted, which is the same change that creates the hazard. A condition that
  // stops holding precisely when the risk appears is not a narrowing; it is a
  // gate that switches itself off. Deny-by-default with a NAMED entry per
  // module, carrying what was carried and how, is the shape that survives.
  interface CarriedAffordances {
    /** What the card draws that the face had to reproduce, and where it went. */
    readonly why: string;
    /** The seam that reaches the card from the face, so a reader can check it
     *  still exists rather than trusting the prose. */
    readonly seam: string;
  }

  const CARD_SOURCE_FACED: Readonly<Record<string, CarriedAffordances>> = {
    // ⚠ `archivist` HAD THE WIDEST ENTRY ON THIS MAP AND NO LONGER NEEDS ONE
    // (legacy-removal S1, 2026-09-03). It is the THIRD and last departure, and
    // with it `DOM_SOURCE_LANE_TYPES` is EMPTY — so this map now has no members
    // at all. Read the empty map as a statement, not as a list nobody kept up:
    // the clause it exempts is "a generic-face module whose CARD owns the
    // source, so the shell parks that card off-screen and its buttons become
    // unreachable", and no module is card-source-owned any more.
    //
    // Everything the entry described is still carried and still gated. The
    // search (a free-text term, two year bounds, a media-type filter), the ↻
    // NEXT re-roll, the four transport actions, the SEEK bar and both prose
    // channels all live in `ArchivistBrowseControls`, mounted by the dock body
    // AND the lane tile, over `$lib/ui/media/archivist-status-registry`. What
    // changed is that the thing on the other end of that seam is
    // `node-archivist-source-registry` on graph lifetime rather than a card in
    // an off-screen host — which is what made archivist's stakes the highest of
    // the three (a fresh archivist has NO item at all, so an unreachable owner
    // is a media source that can never be given any media).
    // ⚠ `cameraInput` HAD AN ENTRY HERE TOO, AND LEFT FOR THE SAME REASON AS
    // `loopback` (legacy-removal S1, 2026-09-03) — read the note below for the
    // full argument. The device PICKER, the ACQUIRE gesture, the capture LAMP
    // and the recovery TEXT are all still carried, in `CameraSourceControls` and
    // `CameraInputOutputBody` over `$lib/ui/media/camera-status-registry`, gated
    // by `e2e/tests/camerainput-shell-source.spec.ts`. What went away is the
    // parked card whose buttons the exemption existed to excuse:
    // `$lib/ui/media/node-camera-source-registry` owns getUserMedia, the device
    // roster and the permission state machine now, so cameraInput is not a
    // DOM-source module and no card is mounted for it anywhere.
    // ⚠ `loopback` HAD AN ENTRY HERE AND NO LONGER NEEDS ONE (legacy-removal S1,
    // 2026-09-03). The distinction matters, because "the exemption was deleted"
    // reads at a glance like "the affordances were dropped", and the opposite
    // happened.
    //
    // What this map exempts is one specific clause: a module dispositioned
    // `generic-face` whose CARD owns the source, so the shell parks that card
    // off-screen with `pointer-events: none` and every button it draws becomes
    // unreachable. An entry says "the buttons were carried to the face, and here
    // is the seam". Loopback's were, and they still are — the ACQUIRE and STOP
    // gestures, the capture LAMP and the recovery TEXT all live in
    // `LoopbackOutputBody.svelte` over `$lib/ui/media/loopback-status-registry`,
    // gated in BOTH directions by `e2e/tests/loopback-shell-source.spec.ts`.
    //
    // What changed is that the CLAUSE has no loopback to bite on any more.
    // `$lib/ui/media/node-loopback-source-registry` owns getDisplayMedia, the
    // `<video>` and the engine attach, so loopback left `DOM_SOURCE_LANE_TYPES`
    // and there is no parked card whose buttons could be unreachable — there is
    // no card mounted at all. An exemption that outlives its subject is the
    // stale-licence shape the ANCHORED leg below exists to catch, and it caught
    // this one on the first full run after the extraction. That is why the entry
    // is deleted rather than kept "for the prose": a covering entry nobody needs
    // reads authoritative, and the next reader would take it as evidence that
    // loopback still has a card doing something.
  };

  /**
   * The rule, as a PURE function of (types, exemptions, dispositions).
   *
   * ⚠ EXTRACTED 2026-09-02, AND THE EXTRACTION IS THE POINT. The negative
   * control below used to assert that some member of `DOM_SOURCE_LANE_TYPES`
   * was NOT in `CARD_SOURCE_FACED` — i.e. it proved the rule still bit by
   * pointing at a module that had not been faced yet. `archivist` was the last
   * such module, so promoting it made that leg UNSATISFIABLE: the set is now
   * fully covered, and the assertion "the exemption is not universal" became
   * false-by-success rather than false-by-regression.
   *
   * A population-shaped negative control expires when the population drains.
   * The honest replacement is a control over the PREDICATE, so the gate is fed
   * a synthetic uncovered module and asked to refuse it — which keeps working
   * at every population size, including this one. Both the real gate and the
   * control call THIS function, so a "simplification" of the rule to a blanket
   * skip reddens the control instead of quietly disarming it.
   */
  function carriedAffordanceOffenders(
    types: Iterable<string>,
    faced: Readonly<Record<string, CarriedAffordances>>,
    entryOf: (t: string) => ReturnType<typeof inventoryEntry>,
  ): string[] {
    const offenders: string[] = [];
    for (const type of [...types].sort()) {
      const entry = entryOf(type);
      if (!entry) continue; // reported by the totality gate
      if (entry.disposition === 'generic-face') {
        if (!faced[type]) {
          offenders.push(
            `${type}: dispositioned generic-face, but its card owns the source and the shell ` +
              'parks that card off-screen (pointer-events:none) — every button it draws becomes ' +
              'unreachable. Carry them to the face, then add a NAMED CARD_SOURCE_FACED entry ' +
              'saying which affordances moved and through what seam.',
          );
        }
        continue;
      }
      // ⚠ THIS ARM USED TO READ `if (!migrationBlockers(entry).includes(
      // 'needs-media-controller')) offenders.push(…)` — an un-faced DOM-source
      // module escaped the clause above by DECLARING the blocker. That escape
      // was deleted with the blocker itself (2026-09-02, toybox's promotion:
      // see `MigrationBlockerId` in the inventory for why the last declaration
      // went), so the condition it tested is no longer expressible — the union
      // is empty and `migrationBlockers(entry)` can only be `[]`.
      //
      // The rule is UNCHANGED in substance and is now stated directly: the
      // shell parks a DOM-source module's card off-screen with
      // `pointer-events: none`, so its buttons are unreachable no matter which
      // disposition the entry carries. Naming a capability it was waiting on
      // never made them reachable; it only deferred the question. A DOM-source
      // module therefore owes a CARRIED-affordance account, and `generic-face`
      // is the only disposition a promoted module has.
      offenders.push(
        `${type}: is a DOM-source module dispositioned '${entry.disposition}'. The shell parks ` +
          'its card off-screen (pointer-events:none) whatever the disposition says, so its ' +
          'affordances must be CARRIED to a face and recorded in CARD_SOURCE_FACED. There is no ' +
          'longer a blocker to declare instead — see MigrationBlockerId in face-migration-inventory.ts.',
      );
    }
    return offenders.sort();
  }

  it('CARD-OWNED SOURCE: a generic-face module must have CARRIED its card-only affordances', () => {
    // DOM_SOURCE_LANE_TYPES is itself grep-gated against the cards that call
    // attachExternalSource (dom-source-modules.test.ts), so this reads a
    // maintained artifact rather than re-grepping for the same thing.
    expect(
      carriedAffordanceOffenders(DOM_SOURCE_LANE_TYPES, CARD_SOURCE_FACED, inventoryEntry),
    ).toEqual([]);
  });

  it('ANCHORED: every CARD_SOURCE_FACED entry still names a faced DOM-source module', () => {
    // An entry that outlives its subject is the classic stale exemption: it
    // reads as protection and covers nothing. Both directions are checked, so a
    // module that is de-faced, re-dispositioned or removed from the DOM-source
    // set reddens here instead of leaving a silent licence behind.
    const stale: string[] = [];
    for (const type of Object.keys(CARD_SOURCE_FACED).sort()) {
      if (!DOM_SOURCE_LANE_TYPES.has(type)) {
        stale.push(`${type}: no longer a DOM-source module — the exemption has no subject`);
      }
      const entry = inventoryEntry(type);
      if (!entry) {
        stale.push(`${type}: no inventory entry at all`);
      } else if (entry.disposition !== 'generic-face') {
        stale.push(`${type}: is ${entry.disposition}, so it never reaches the clause this exempts`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('DERIVED: a carried-affordance module DECLARES an extension, because there is nowhere else', () => {
    // ⚠ THE LEG THAT MAKES THE ENTRY MORE THAN A PROMISE. A generic face is
    // param cells and nothing else, and none of these affordances is a param —
    // `controlCell` renders a `static` cell as a dead dashed label by design. So
    // a module claiming it carried them while declaring no `face.extension` has
    // carried them nowhere, and the claim is refuted by the def itself.
    const byType = new Map(allDefs().map((d) => [d.type, d]));
    const offenders: string[] = [];
    for (const type of Object.keys(CARD_SOURCE_FACED).sort()) {
      const face = byType.get(type)?.face;
      const ext = (face as { extension?: string } | undefined)?.extension;
      if (!ext) {
        offenders.push(`${type}: claims carried affordances but declares no face.extension`);
        continue;
      }
      if (!shellExtensionIds().includes(ext)) {
        offenders.push(`${type}: declares extension '${ext}', which the glob does not resolve`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('EVERY entry states WHICH affordances moved and THROUGH WHAT — prose a stranger can act on', () => {
    for (const [type, e] of Object.entries(CARD_SOURCE_FACED)) {
      expect(e.why.length, `${type}: the why must be a real argument`).toBeGreaterThan(80);
      expect(e.seam.length, `${type}: name the seam`).toBeGreaterThan(10);
    }
  });

  it('POSITIVE CONTROL: the rule REFUSES an uncovered DOM-source module', () => {
    // ⚠ THIS REPLACED A POPULATION-SHAPED NEGATIVE CONTROL ON 2026-09-02, and
    // the reason is worth keeping: the old leg asserted that some member of
    // DOM_SOURCE_LANE_TYPES was still UNCOVERED, which was a fact about how far
    // the migration had got rather than about the rule. `archivist` was the
    // last uncovered member, so promoting it would have made that assertion
    // fail — not because anything regressed, but because the queue it was
    // measuring had emptied. A control that expires when the work finishes
    // cannot protect the work that comes after it.
    //
    // So the rule is exercised DIRECTLY instead: feed it a module that is
    // generic-face and NOT in the exemption map, and require that it complains.
    // This holds at every population size, including a fully-drained one.
    const offenders = carriedAffordanceOffenders(
      ['syntheticUncoveredSource'],
      {},
      () => ({ type: 'syntheticUncoveredSource', disposition: 'generic-face', why: 'synthetic' }),
    );
    expect(offenders, 'the rule let an uncovered generic-face DOM source through').toHaveLength(1);
    expect(offenders[0]).toContain('syntheticUncoveredSource');
    expect(offenders[0]).toContain('CARD_SOURCE_FACED');

    // The other arm, likewise exercised rather than assumed: a DOM-source
    // module that is NOT generic-face is refused outright.
    //
    // ⚠ THIS ARM USED TO ASSERT THE MESSAGE NAMED `needs-media-controller` —
    // the escape a bespoke-surface entry took by DECLARING the blocker. That
    // escape was deleted with the blocker itself (2026-09-02; see
    // `MigrationBlockerId` in face-migration-inventory.ts for why the last
    // declaration went), so there is nothing left to declare and the arm now
    // asserts the refusal it was always really about: the shell parks a
    // DOM-source module's card off-screen whatever its disposition says, so an
    // un-carried one is an offender however it is labelled.
    const blockerOffenders = carriedAffordanceOffenders(
      ['syntheticBlockedSource'],
      {},
      () => ({ type: 'syntheticBlockedSource', disposition: 'bespoke-surface', why: 'synthetic' }),
    );
    expect(blockerOffenders, 'an un-carried non-generic-face DOM source was accepted').toHaveLength(1);
    expect(blockerOffenders[0]).toContain('syntheticBlockedSource');
    expect(blockerOffenders[0]).toContain('CARD_SOURCE_FACED');

    // ⚠ THIS USED TO ASSERT "real modules DO reach the exemption", over
    // `DOM_SOURCE_LANE_TYPES ∩ CARD_SOURCE_FACED`. Both sides are EMPTY since
    // legacy-removal S1, so the check is unsatisfiable — and the honest reading
    // is that the MECHANISM genuinely is dead code today, not that it broke.
    //
    // It stays, and the control moves from the POPULATION to the RULE, which is
    // the shape that survives a population reaching zero. The two synthetic legs
    // above already exercise both arms — a generic-face DOM source with no
    // entry is refused, and so is a non-generic-face one — so what is left to
    // pin is the direction those cannot show: that an entry, when one exists,
    // actually EXCUSES the module rather than being ignored. Fed a synthetic
    // covered module, the rule must accept it.
    const acceptedWhenCovered = carriedAffordanceOffenders(
      ['syntheticCoveredSource'],
      {
        syntheticCoveredSource: {
          why: 'synthetic — the affordances were carried to a face',
          seam: '$lib/ui/media/synthetic-status-registry',
        },
      },
      () => ({ type: 'syntheticCoveredSource', disposition: 'generic-face', why: 'synthetic' }),
    );
    expect(
      acceptedWhenCovered,
      'a COVERED DOM source was still reported an offender — the exemption does nothing, so the ' +
        'two refusal legs above are passing for the wrong reason',
    ).toEqual([]);

    // ...and the map really is empty, said out loud so this block reddens the
    // day a member returns and whoever adds it restores the population control.
    expect(
      Object.keys(CARD_SOURCE_FACED),
      'CARD_SOURCE_FACED has an entry again — restore the population control above, because the ' +
        'rule-level control alone cannot see a stale entry',
    ).toEqual([]);
  });

  it('SCOPE: this gate reads DISPOSITIONS and DEFS — it cannot see a rebuilt affordance WORK', () => {
    // Stated inside the gate, per the blind-gate discipline. Nothing here mounts
    // a face, clicks anything, or proves a command reaches its owner. The seam's
    // own behaviour is unit-tested in
    // `$lib/ui/media/camera-status-registry.test.ts` (delivery, hand-over,
    // delivered:false when nobody is listening), and that it works END TO END is
    // `e2e/tests/camerainput-shell-source.spec.ts`. A green run here means the
    // module DECLARED a home for its affordances, never that they function.
    //
    // ⚠ THE BLIND SPOT IS NOW TOTAL FOR THIS CLAUSE, and saying so is the point
    // of the leg. It used to assert `CARD_SOURCE_FACED` was non-empty — "the
    // exemption covers real modules, so the scope note is about something that
    // runs". Since legacy-removal S1 the map is EMPTY: no module's card owns its
    // source, so the clause this gate polices has no live subject at all. It is
    // retained for the module that reintroduces one, and until then the honest
    // statement is that this gate currently constrains NOTHING in the fleet —
    // which is a much stronger thing to write down than a population count.
    expect(
      Object.keys(CARD_SOURCE_FACED).length,
      'CARD_SOURCE_FACED is populated again — the scope note above should go back to describing ' +
        'what the exemption covers rather than that it covers nothing',
    ).toBe(0);
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
