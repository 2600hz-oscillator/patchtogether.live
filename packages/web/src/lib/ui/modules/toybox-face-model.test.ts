// packages/web/src/lib/ui/modules/toybox-face-model.test.ts
//
// The TOYBOX face, pinned where a def-reading gate cannot look.
//
// ⚠ WHY THIS FILE EXISTS RATHER THAN LEANING ON THE FLEET GATES. toybox is the
// LAST unfaced module besides doom, and it is the deepest surface in the rack —
// a layer editor over six kinds, an editable 17-op node graph, six routed
// modulation inputs and a preset store. Four properties of this promotion are
// invisible to every shared gate:
//
//   * NOBODY CAN SEE THAT THERE IS ONE CONSOLE. The legacy card and the
//     faceplate body mount the SAME component with a `layout` prop, and that is
//     the entire defence against the two surfaces drifting apart over one
//     Y.Doc. An edit that copied the console's markup back into the card would
//     be green in every other gate in the tree.
//   * NOBODY CAN SEE WHY THE MEDIA BLOCKER WAS DROPPED. `needs-media-controller`
//     was deleted from the registry in this same PR because toybox was its last
//     citer; the claim that justified the deletion is a property of three lane
//     SETS, and no gate asserts a module's ABSENCE from them.
//   * `EXTENSION_BODY_ROLES` resolves the `fullViewBody` and nothing else, so
//     the decision NOT to ship a `tileBody` — and the reason — is recorded here
//     or nowhere.
//   * NOBODY CAN SEE THE KNOB TESTID OVERRIDE. `faces-parity` will fail loudly
//     if it regresses, but only in e2e, and only by reporting twenty "unbacked
//     extra controls" with no hint that the cause is one missing prop.
//
// ⚠ WHAT THIS FILE IS STRUCTURALLY UNABLE TO SEE: it reads SOURCE and the DEF.
// It cannot tell you a tab is clickable, that the graph editor still opens its
// own contextual menu inside the dock, or that the composite keeps advancing
// with the screen off. That is `e2e/tests/face-toybox.spec.ts`.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { toyboxDef } from '$lib/video/modules/toybox';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  CARD_PRODUCER_LANE_TYPES,
  DOM_SOURCE_LANE_TYPES,
  HEADLESS_MOUNT_LANE_TYPES,
  needsHeadlessSourceMount,
} from '$lib/ui/workflow/dom-source-modules';
import { NON_SHELL_LANE_TYPES } from '$lib/ui/workflow/legacy-fallback';
import { EXTRAS_PRODUCER_TYPES } from '$lib/ui/media/extras-producers';
import {
  MIGRATION_BLOCKERS,
  inventoryEntry,
  migrationBlockers,
} from '$lib/ui/workflow/face-migration-inventory';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(HERE, rel), 'utf8');

const def = toyboxDef as unknown as FaceDefLike & { type: string };

const cardSource = read('ToyboxCard.svelte');
const consoleSource = read('toybox/ToyboxConsole.svelte');
const bodySource = read('toybox/ToyboxConsoleBody.svelte');
const extSource = read('toybox/shell-extension.ts');

// Comment-stripped views. Every "the source does NOT contain X" leg below reads
// one of these, because this module's files are heavily commented and several of
// those comments quote the very strings being refused.
const cardCode = stripSourceComments(cardSource);
const consoleCode = stripSourceComments(consoleSource);
const bodyCode = stripSourceComments(bodySource);

describe('toybox face — promoted, and the whole console came with it', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('toybox')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it('the EMPTY order is FORCED — this def declares no params at all', () => {
    // The videoOut / recorderbox / painter shape, and here it is not a choice:
    // there is nothing to rank. A non-empty order would have to name a param
    // that does not exist.
    expect(toyboxDef.params).toEqual([]);
    expect(def.face?.order).toEqual([]);
  });

  it('declares glyph none AND still has a live lane picture', () => {
    // `glyph: 'none'` is likewise forced — a glyph binding reads a topology
    // PARAM and there are none — but the lane is not left blank: a video def
    // with a `video` output resolves a surface, so the tile paints the generic
    // VideoTileThumb of the composite.
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(toyboxDef)).toBe(true);
  });

  it('declares NO pages, so no tab rail is manufactured by the shell', () => {
    // The three tabs are the BODY's own markup. With zero params there are zero
    // bands, so `dockTabPlan`'s DOCK_TAB_MIN_BANDS arithmetic is untouched —
    // and asserting it here is what stops a future reader "fixing" the body's
    // rail by declaring pages that would have nothing to hold.
    expect(def.face?.pages).toBeUndefined();
  });

  it('every tier ranks NOTHING, because there is nothing to rank', () => {
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      const plan = curatedFace(def, tier);
      expect(plan, `${tier}: the face did not resolve at all`).toBeTruthy();
      expect(plan!.controls, `${tier}: a cell appeared for a param that does not exist`).toEqual([]);
    }
  });

  it('the def is still reachable from the lane — it is not a NON_SHELL carve-out', () => {
    expect(NON_SHELL_LANE_TYPES.has('toybox')).toBe(false);
  });
});

describe('⚠ THE MEDIA BLOCKER WAS FALSE FOR THIS MODULE — recorderbox’s argument, not archivist’s', () => {
  // The distinction matters because all three promotions landed in one week and
  // the arguments do not transfer. archivist IS a DOM source and needed a
  // status/command registry so its parked card could stay the sole owner.
  it('toybox is in NEITHER half of HEADLESS_MOUNT_LANE_TYPES', () => {
    expect(DOM_SOURCE_LANE_TYPES.has('toybox')).toBe(false);
    expect(CARD_PRODUCER_LANE_TYPES.has('toybox')).toBe(false);
    expect(HEADLESS_MOUNT_LANE_TYPES.has('toybox')).toBe(false);
  });

  it('so NO card is mounted anywhere after promotion — there is no headless host', () => {
    // Both shell kinds, and the two arms that could still produce a mount.
    for (const kind of ['shell', 'placeholder'] as const) {
      expect(needsHeadlessSourceMount({ kind, type: 'toybox' })).toBe(false);
    }
    expect(needsHeadlessSourceMount({ kind: 'shell', type: 'toybox', laneOmitsNode: true })).toBe(false);
    // ⚠ POSITIVE CONTROL ON THE SAME PREDICATE, so a passing row above cannot be
    // the function having stopped answering. Its subject was `archivist`, which
    // stopped needing a host on 2026-09-03 (legacy-removal S1 moved its source
    // to a node controller) — and a control whose subject converts is a control
    // that silently stops controlling, which is exactly the failure this leg
    // guards against in the other direction. It was re-pointed to `wavesculpt`,
    // whose renderer left the card one slice later (legacy-removal S1/7) — so
    // the subject is DERIVED now rather than named a third time. Any member of
    // the union proves the same thing: the predicate is still answering TRUE for
    // something, so toybox's FALSE above is a fact about toybox.
    const stillHosted = [...HEADLESS_MOUNT_LANE_TYPES][0];
    expect(
      HEADLESS_MOUNT_LANE_TYPES.size,
      'the control needs a module the headless host still applies to — when the union empties, ' +
        'this control has no subject and the host itself should be gone',
    ).toBeGreaterThan(0);
    expect(needsHeadlessSourceMount({ kind: 'shell', type: stillHosted! })).toBe(true);
  });

  it('the card never calls attachExternalSource — its layers reach the engine through the module’s OWN extras', () => {
    // This is the mechanical reason for the membership above, and it is what
    // `dom-source-modules.test.ts` derives the set from. Both files, because
    // the console is where the call would now live.
    expect(cardCode).not.toContain('attachExternalSource');
    expect(consoleCode).not.toContain('attachExternalSource');
    expect(consoleCode).toContain('attachLayerVideo');
  });

  it('the media tax was ALREADY PAID — elements and streams live on NODE lifetime (#1589)', () => {
    // The registry, not the component, owns every per-layer element, object-URL
    // and camera track. `card-media-lifetime.test.ts` holds the other half (no
    // revoke/stop/detach in an unmount path); this holds the ownership itself.
    expect(consoleCode).toContain('node-media-registry');
    expect(consoleCode).toMatch(/nodeMedia\.ensure\(/);
    expect(consoleCode).toMatch(/nodeMedia\.setObjectUrl\(/);
    expect(consoleCode).toMatch(/nodeMedia\.setStream\(/);
  });

  it('the IMAGE half is reproduced from the GRAPH with no surface mounted', () => {
    expect(EXTRAS_PRODUCER_TYPES.has('toybox')).toBe(true);
  });

  it('the inventory entry is generic-face and names no blocker', () => {
    const entry = inventoryEntry('toybox');
    expect(entry?.disposition).toBe('generic-face');
    expect(migrationBlockers(entry!)).toEqual([]);
  });

  it('and toybox was the LAST citer, so the blocker registry is now empty', () => {
    // ⚠ NOT a claim that #1511 shipped — it has not, and
    // HEADLESS_MOUNT_LANE_TYPES is non-empty right below. The registry is empty
    // because nothing is WAITING, which is the disposal the inventory's own
    // anchor gate asks for.
    expect(Object.keys(MIGRATION_BLOCKERS)).toEqual([]);
    expect([...HEADLESS_MOUNT_LANE_TYPES].length).toBeGreaterThan(0);
  });
});

describe('⚠ ONE CONSOLE, TWO MOUNTS — the no-drift property, pinned in both directions', () => {
  it('the CARD and the BODY import the SAME console component', () => {
    expect(cardCode).toContain("from './toybox/ToyboxConsole.svelte'");
    expect(bodyCode).toContain("from './ToyboxConsole.svelte'");
  });

  it('each host mounts it with its OWN layout, and only those two exist', () => {
    expect(cardCode).toMatch(/<ToyboxConsole[^>]*layout="card"/s);
    expect(bodyCode).toMatch(/<ToyboxConsole[^>]*layout="face"/s);
    expect(consoleCode).toContain("type ToyboxConsoleLayout = 'card' | 'face'");
  });

  it('the CARD owns NO control — every affordance moved, none was copied', () => {
    // A representative control from each of the five zones. If any of these
    // comes back into the card file, the console has been forked.
    for (const marker of [
      'toybox-canvas',
      'toybox-preset-select',
      'toybox-layer-tabs',
      'toybox-kind-select',
      'toybox-graph-svg',
      'toybox-cv-rows',
    ]) {
      expect(cardCode, `${marker} is back in the card — the console has been forked`)
        .not.toContain(marker);
    }
    // …and it calls no graph mutator of its own.
    expect(cardCode).not.toContain('$lib/graph/toybox-');
  });

  it('the BODY owns NO control either — it is a host plus the SCREEN switch', () => {
    for (const marker of [
      'toybox-preset-select',
      'toybox-layer-tabs',
      'toybox-kind-select',
      'toybox-graph-svg',
      'toybox-cv-rows',
      'toybox-add-row',
    ]) {
      expect(bodyCode, `${marker} is duplicated in the body — the console has been forked`)
        .not.toContain(marker);
    }
    expect(bodyCode).not.toContain('$lib/graph/toybox-');
  });

  it('EVERY zone is a snippet rendered by BOTH layouts — a zone cannot be host-specific', () => {
    // The structural guarantee behind "capability parity". A zone rendered in
    // one branch and not the other would be an affordance the promotion
    // deleted, and this is the leg that says so by name.
    const zones = ['screenZone', 'presetZone', 'layerZone', 'combineZone', 'cvZone'];
    for (const z of zones) {
      expect(consoleCode, `${z} is not defined as a snippet`).toContain(`{#snippet ${z}()}`);
      const renders = consoleCode.split(`{@render ${z}()}`).length - 1;
      expect(renders, `${z} is rendered ${renders}×; it must be rendered by BOTH layouts`).toBe(2);
    }
  });

  it('the CARD frame keeps only what is outside the console’s subtree', () => {
    // Svelte scopes CSS per component, so a rule left behind whose element
    // moved stops applying SILENTLY. These four are the only rules whose
    // subject is the card's own frame.
    expect(cardSource).toContain('.mod-card {');
    expect(cardSource).toContain('.stripe {');
    expect(cardSource).toContain(':global(.svelte-flow__node:hover) .mod-card');
    // …and the pairs that would die if split are all on the console's side.
    for (const rule of [
      '.cable-hit:hover + .cable',
      '.graph-wrap {',
      '.input-picker .filename',
      '.preset-section .sync-hint',
    ]) {
      expect(consoleSource, `${rule} was left behind in the card — its subject moved`).toContain(rule);
      expect(cardCode, `${rule} is in the card, whose subtree no longer contains its subject`)
        .not.toContain(rule);
    }
  });
});

describe('⚠ THE FACE MOUNTS NO `control-*` TESTID — the faces-parity identity', () => {
  // `Knob.svelte` derives `control-<paramId>` from the MIDI-learn key, and
  // faces-parity asserts EXACT MULTISET EQUALITY between the dock's
  // `[data-testid^="control-"]` elements and this def's ParamDef ids — the
  // empty set. Twenty knobs would each have read as an unbacked extra control.
  it('every MIDI-assignable knob passes a testid override', () => {
    const paramIds = consoleCode.match(/paramId=\{/g) ?? [];
    const overrides = consoleCode.match(/testid=\{knobTestid\(/g) ?? [];
    expect(paramIds.length, 'the console stopped binding MIDI-learn keys').toBeGreaterThan(15);
    expect(
      overrides.length,
      'a knob binds paramId without a testid override — it will emit control-* on the faceplate',
    ).toBe(paramIds.length);
  });

  it('the override is FACE-ONLY, so the legacy card keeps its shipped ids', () => {
    expect(consoleCode).toMatch(
      /function knobTestid\([^)]*\)[^{]*\{\s*return layout === 'face' \? `toybox-dial-\$\{paramId\}` : undefined;/,
    );
  });

  it('⚠ DROPPING paramId IS NOT THE FIX — the MIDI binding is still passed', () => {
    // The trap Knob's `testid` prop exists to avoid: suppressing the testid by
    // omitting `paramId` would silently make twenty controls un-learnable.
    expect(consoleCode).toContain('moduleId={id}');
    expect(consoleCode).toMatch(/paramId=\{layerParam\(/);
  });
});

describe('⚠ SCREEN ON/OFF — on the shared key, and it keeps the watch mark', () => {
  it('the body owns the switch over `previewCollapsed`', () => {
    expect(bodySource).toContain('previewCollapsed');
    expect(bodySource).toMatch(/\.data\.previewCollapsed\s*=/);
    expect(bodySource).toMatch(/<button/);
    expect(bodySource).toContain('toybox-face-screen-toggle');
  });

  it('the canvas is the conventional <prefix>-face-canvas and is REMOVED by the collapse', () => {
    // `face-screen-render-suite` looks for that testid, and the suite's whole
    // subject is that the space is RECLAIMED — `hidden` would not do.
    expect(consoleCode).toContain("'toybox-face-canvas'");
    expect(consoleCode).toMatch(/\{#if screenOn\}\s*\{@render screenZone\(\)\}/);
  });

  it('the collapsed branch STILL renews the watch mark — OFF is not a pause', () => {
    // The load-bearing half. On the blit path the mark is a side effect of
    // painting, so a face whose screen is off would let it lapse and the engine
    // would stop advancing a composite whose FEEDBACK/FRAMEDELAY/EXQUISITE/
    // DATAMOSH ops carry history between frames.
    expect(consoleCode).toMatch(/function renewWatchMark\(\)/);
    expect(consoleCode).toMatch(/markWatched\?\.\(id\)/);
    // …and it is called BEFORE the screen gate, not inside it.
    expect(consoleCode).toMatch(
      /if \(layout === 'face'\) renewWatchMark\(\);\s*if \(screenOn\) blitOnce\(\);/,
    );
  });

  it('the switch renders OUTSIDE the collapse, so a peer can always undo it', () => {
    // `previewCollapsed` is Y.Doc-synced, so a rack-mate can switch off the
    // only picture for everyone. Self-undoing is why toybox takes the fleet
    // switch rather than a NO_SCREEN_SWITCH exemption.
    const beforeConsole = bodySource.split('<ToyboxConsole')[0] ?? '';
    expect(beforeConsole).toContain('toybox-face-screen-toggle');
  });
});

describe('⚠ THE TAB RAIL IS THE TWO SECTION COLLAPSES, RESTYLED', () => {
  it('three tabs, named for the owner’s three sections', () => {
    for (const t of ['toybox-face-tab-cv', 'toybox-face-tab-combine', 'toybox-face-tab-presets']) {
      expect(consoleCode).toContain(t);
    }
  });

  it('CV-MOD is the default tab, and the tab is LOCAL per collaborator', () => {
    expect(consoleCode).toMatch(/let faceTab = \$state<ToyboxFaceTab>\('cv'\)/);
    // Not on the node: a rack-mate must not move the tab under your hands.
    expect(consoleCode).not.toMatch(/data\.faceTab/);
  });

  it('ONE predicate answers "is this section showing" for both hosts', () => {
    expect(consoleCode).toMatch(
      /let editorVisible = \$derived\(layout === 'face' \? faceTab === 'combine' : editorOpen\)/,
    );
    expect(consoleCode).toMatch(
      /let cvVisible = \$derived\(layout === 'face' \? faceTab === 'cv' : cvOpen\)/,
    );
  });

  it('the card KEEPS its ▾ toggles and the face does not double them up', () => {
    // Capability parity in the direction that is easy to lose: the legacy card
    // must not lose a control the face happens not to need.
    expect(consoleCode).toContain('toybox-combine-toggle');
    expect(consoleCode).toContain('toybox-cv-toggle');
    expect(consoleCode).toMatch(/\{#if layout === 'card'\}\s*<button[\s\S]{0,400}?toybox-combine-toggle/);
    expect(consoleCode).toMatch(/\{#if layout === 'card'\}\s*<button[\s\S]{0,400}?toybox-cv-toggle/);
  });

  it('an INACTIVE tab costs nothing — the scopes stop on the same predicate', () => {
    expect(consoleCode).toMatch(/function tickScopes\(\): void \{\s*if \(!cvVisible \|\| frozen\) return;/);
  });
});

describe('⚠ THE EXTENSION — one slot, and the tile is a DECISION', () => {
  it('the def names the extension this directory provides', () => {
    expect(def.face?.extension).toBe('toybox');
  });

  it('it declares a fullViewBody and deliberately NO tileBody', () => {
    // EXTENSION_BODY_ROLES is structurally unable to see a tileBody, so the
    // ABSENCE of one is pinned here. Every control on this module is
    // layer-scoped or graph-node-scoped, so choosing WHICH one to operate is
    // already a dock task; a lone control on a 192 px tile would be operating
    // something the player cannot see they selected.
    expect(extSource).toMatch(/fullViewBody:\s*ToyboxConsoleBody/);
    expect(extSource).not.toMatch(/^\s*tileBody:/m);
  });

  it('the body does NO mount-time heavy work of its own', () => {
    // recorderbox's 60-scene VRT regression, applied before it could cost
    // anything: the body's own script must not fetch, decode or open a device.
    expect(bodyCode).not.toContain('fetch(');
    expect(bodyCode).not.toContain('getUserMedia');
    expect(bodyCode).not.toContain('createObjectURL');
    expect(bodyCode).not.toContain('requestAnimationFrame');
  });
});

describe('⚠ HASH TRANSPARENCY — every new file is outside the WebGL attest basis', () => {
  it('the console, the body and the extension live under lib/ui, never lib/video', () => {
    for (const rel of [
      'toybox/ToyboxConsole.svelte',
      'toybox/ToyboxConsoleBody.svelte',
      'toybox/shell-extension.ts',
    ]) {
      expect(resolve(HERE, rel)).toContain(`${'lib'}/ui/modules/toybox/`);
    }
  });

  it('none of them creates a GL context — the basis sweep reads CONTENT', () => {
    // `resolveWebglBasis()` sweeps lib/ui/modules/**/*.svelte BY CONTENT for a
    // GL context, so a getContext('webgl2') here would enrol these files in the
    // real-GPU attest and put every future face edit on its critical path.
    for (const src of [consoleCode, bodyCode]) {
      expect(src).not.toMatch(/getContext\(\s*['"]webgl/);
    }
    // The console DOES take a 2-D context — that is the preview blit, and it is
    // the shape this leg permits.
    expect(consoleCode).toContain("getContext('2d'");
  });

  it('the def gained ONLY hash-transparent keys — no param, port or factory move', () => {
    expect(toyboxDef.params).toEqual([]);
    expect(toyboxDef.inputs.map((p) => p.id)).toEqual([
      'cv1', 'cv2', 'cv3', 'cv4', 'cv5', 'cv6', 'inA', 'inB',
    ]);
    expect(toyboxDef.outputs.map((p) => p.id)).toEqual(['out']);
  });
});
