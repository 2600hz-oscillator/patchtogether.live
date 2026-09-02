// packages/web/src/lib/ui/modules/clipplayer-face-model.test.ts
//
// THE CLIP PLAYER FACE — its model, its promotion, and the legs the shared
// gates cannot carry on this module.
//
// ⚠ WHAT THE SHARED GATES DO AND DO NOT SEE HERE. `module-face-lint` reads the
// DEF, so it holds the ranks, the pages and the family completeness; the
// `faces-parity` sweep drives the DOCK and proves each of the six panels is
// operable. Neither can see: which surface a gesture came from (the extraction
// of the clip menu), whether the panels write through the shared seams or
// re-implement them, whether the tile body stayed cheap, or whether the four
// DELETED families still paint somewhere. That is this file's subject.
//
// PURE. The projections under test take a plain object; the source-level legs
// read files. No Y.Doc, no browser, no engine — which is the whole reason the
// reads were split out of the 3,652-line card in the first place.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipplayerDef } from '$lib/audio/modules/clipplayer';
import {
  CLIP_LANES,
  CLIP_SLOTS,
  clipIndex,
  defaultNoteClip,
  type ClipPlayerData,
} from '$lib/audio/modules/clip-types';
import { RATE_DEFAULT_INDEX, RATE_LABELS } from '$lib/audio/modules/clip-clock';
import {
  SCENE_REPEAT_CYCLE,
  clipplayerHasAnyClip,
  clipplayerLaneViews,
  clipplayerPadState,
  clipplayerPadViews,
  clipplayerPlayingLaneCount,
  clipplayerSceneViews,
  nextSceneRepeat,
} from './clipplayer/clipplayer-face-model';
import { curatedFace, laneOrder, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { panelCellKeys } from '$lib/ui/workflow/shell-cells';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { NON_SHELL_LANE_TYPES, laneRenderKind } from '$lib/ui/workflow/legacy-fallback';

const DEF = clipplayerDef as unknown as FaceDefLike;
const LANE_TIERS = ['mini', 'compact', 'full'] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, 'clipplayer');
const read = (f: string) => readFileSync(resolve(DIR, f), 'utf8');
const CARD = () => readFileSync(resolve(HERE, 'ClipplayerCard.svelte'), 'utf8');
const PANELS = [
  'ClipplayerLaunchPanel.svelte',
  'ClipplayerNotePanel.svelte',
  'ClipplayerMonoPanel.svelte',
  'ClipplayerRatePanel.svelte',
  'ClipplayerArmPanel.svelte',
  'ClipplayerScenePanel.svelte',
] as const;

/** A player with one loaded clip in lane 0 slot 0 and lane 1 playing slot 2. */
function loadedData(): ClipPlayerData {
  return {
    clips: { [String(clipIndex(0, 0))]: defaultNoteClip(), [String(clipIndex(2, 1))]: defaultNoteClip() },
    playing: [null, 2, null, null, null, null, null, null],
  } as unknown as ClipPlayerData;
}

describe('clipplayer face — the promotion', () => {
  it('declares a face and is in STRICT_FACES', () => {
    expect(clipplayerDef.face, 'the def declares a face').toBeTruthy();
    expect(STRICT_FACES.has('clipplayer')).toBe(true);
    expect(migrated('clipplayer')).toBe(true);
  });

  // ⚠ THE SPLIT-BRAIN LEG, and it is the one that matters most on this module.
  // `NON_SHELL_LANE_TYPES` short-circuits `laneRenderKind` BEFORE `migrated` is
  // read, while `DockFullView` switches on bare `STRICT_FACES` — so membership
  // plus promotion means the CANVAS paints the verbatim card and the DOCK
  // paints the faceplate, two different instruments for one node. No other gate
  // reads both sides. Both directions, so re-adding the entry is RED.
  it('is NOT in NON_SHELL_LANE_TYPES — the carve-out and the promotion cannot coexist', () => {
    expect(NON_SHELL_LANE_TYPES.has('clipplayer')).toBe(false);
    expect(
      laneRenderKind({
        shellFaces: true,
        userDocked: false,
        type: 'clipplayer',
        hasCard: true,
        migrated: true,
      }),
      'the lane renders the shell, not the verbatim card',
    ).toBe('shell');
  });

  it('the `?shell=legacy` escape hatch still renders the verbatim card', () => {
    // Which is what keeps the eighteen existing clipplayer specs meaningful
    // rather than merely passing.
    expect(
      laneRenderKind({
        shellFaces: false,
        userDocked: false,
        type: 'clipplayer',
        hasCard: true,
        migrated: true,
      }),
    ).toBe('legacy');
  });
});

describe('clipplayer face — the ranking', () => {
  it('ranks every param and every declared family exactly once', () => {
    const order = clipplayerDef.face!.order;
    const want = [
      ...clipplayerDef.params.map((p) => p.id),
      ...(clipplayerDef.controlFamilies ?? []).map((f) => `${f.id}-{n}`),
    ];
    expect([...order].sort()).toEqual([...want].sort());
    expect(new Set(order).size, 'no duplicate rank').toBe(order.length);
  });

  // ⚠ SIX FAMILIES, AND THE COUNT IS THE POINT. It was TEN; four are deleted in
  // the promotion because a pure or conditional READOUT has no gesture a
  // faces-parity probe can drive, and a family that cannot be probed is a cell
  // nothing can prove is alive. Naming them here means re-adding one without a
  // cell is red rather than discovered in a sweep.
  it('declares SIX families, and the four deleted ones are gone', () => {
    expect((clipplayerDef.controlFamilies ?? []).map((f) => f.id).sort()).toEqual([
      'clipplayer-auto-arm',
      'clipplayer-cell',
      'clipplayer-mono',
      'clipplayer-pad',
      'clipplayer-rate',
      'clipplayer-scene-repeat',
    ]);
  });

  // ⚠ AND THE DELETED FOUR MUST NOT LEAVE AN ORPHANED DOC KEY BEHIND. The docs
  // lint catches that too; this leg states the intent at the source, so a
  // half-revert (family back, docs still gone, or vice versa) is red here.
  it('no docs.controls key survives for a deleted family', () => {
    const keys = Object.keys(clipplayerDef.docs?.controls ?? {});
    for (const gone of ['auto-assigned', 'auto-cap', 'auto-override', 'clear-auto']) {
      expect(keys, `docs for the deleted family ${gone}`).not.toContain(`clipplayer-${gone}-{n}`);
    }
  });

  it('the hero is the launch grid, and it resolves to a registered PANEL', () => {
    expect(clipplayerDef.face!.hero?.cell).toBe('clipplayer-pad-{n}');
    expect(panelCellKeys('clipplayer'), 'the hero cell is a PF-14 panel').toContain(
      'clipplayer-pad-{n}',
    );
  });

  // ⚠ THE PANEL/LANE-TIER RULE, ASSERTED AS ARITHMETIC RATHER THAN TRUSTED.
  // `module-face-lint` refuses a panel SELECTED at a lane tier, and the 'full'
  // plate holds six cells — so every panel must sit at index >= 6 of
  // `laneOrder` (which drops the hero). Seven params hold ranks 0..6, which is
  // exactly why the ranking looks param-first.
  it('no panel is reachable at a lane tier — every one ranks past the plate', () => {
    const lane = laneOrder(clipplayerDef.face!);
    const panels = new Set(panelCellKeys('clipplayer'));
    for (const [i, key] of lane.entries()) {
      if (!panels.has(key)) continue;
      expect(i, `${key} must rank past the six-cell plate`).toBeGreaterThanOrEqual(6);
    }
    // …and the positive half: there ARE panels in the lane order, so the loop
    // above is not vacuously green.
    expect(lane.filter((k) => panels.has(k)).length).toBeGreaterThan(0);
  });

  it('every lane tier paints only PARAM cells — the launcher is dock-only', () => {
    for (const tier of LANE_TIERS) {
      const controls = curatedFace(DEF, tier)!.controls;
      expect(controls.length, `${tier} paints something`).toBeGreaterThan(0);
      for (const c of controls) {
        expect(c.kind, `${tier}: ${c.key} is a param cell`).toBe('param');
      }
    }
    // …and the DOCK is where the launcher lives: every family reaches it.
    const dock = curatedFace(DEF, 'dock')!.controls;
    expect(dock.filter((c) => c.kind === 'family')).toHaveLength(
      (clipplayerDef.controlFamilies ?? []).length,
    );
  });

  it('four honest pages, no tab rail, and every ranked key is on one', () => {
    const pages = clipplayerDef.face!.pages ?? [];
    expect(pages.map((p) => p.id)).toEqual(['session', 'channels', 'editor', 'playback']);
    const claimed = new Set(pages.flatMap((p) => p.controls));
    expect([...clipplayerDef.face!.order].sort()).toEqual([...claimed].sort());
    // `DOCK_TAB_MIN_BANDS` is 7. A launcher's whole job is comparing eight
    // lanes, and a rail renders exactly one band at a time.
    expect(pages.length).toBeLessThan(7);
    expect(clipplayerDef.face!.tabbed, 'no owner-instructed rail opt-in').toBeUndefined();
  });

  // ⚠ THE SESSION PAGE CARRIES A SECOND CONTROL FOR A MECHANICAL REASON.
  // `heroFacePlan` DROPS a band the hero emptied, taking its hint with it — so
  // a page whose only control is the hero cell is a page whose prose is
  // authored, reviewed and painted nowhere. The scene repeats keep it alive,
  // and a row of the grid IS a scene, so the pairing is honest as well.
  it('the session page is not emptied by the hero promotion', () => {
    const session = (clipplayerDef.face!.pages ?? []).find((p) => p.id === 'session')!;
    expect(session.controls).toContain('clipplayer-pad-{n}');
    expect(session.controls.filter((c) => c !== 'clipplayer-pad-{n}').length).toBeGreaterThan(0);
    expect(session.hint, 'the band has a hint to paint').toBeTruthy();
  });

  it("glyph is 'none', and the def has no audio output to bind one to", () => {
    expect(clipplayerDef.face!.glyph).toBe('none');
    // The premise, checked rather than asserted: `primaryAudioOutPortId` matches
    // `type === 'audio'`, and every one of the 24 outputs is polyPitchGate, gate
    // or cv — so a live glyph would resolve to a dead static picture.
    expect(clipplayerDef.outputs.some((o) => o.type === 'audio')).toBe(false);
  });

  // ⚠ ALL SIX ARE PANELS, and each one's PROBE is what `shell-cells.test.ts`
  // then checks for usability — an unregistered key renders `data-cell-inert`
  // and fails both that gate and the parity sweep.
  it('every ranked family resolves to a registered PANEL cell', () => {
    const panels = new Set(panelCellKeys('clipplayer'));
    for (const f of clipplayerDef.controlFamilies ?? []) {
      expect(panels, `${f.id} resolves to a panel cell`).toContain(`${f.id}-{n}`);
    }
    expect(panels.size, 'and the module registers no cell nothing ranks').toBe(
      (clipplayerDef.controlFamilies ?? []).length,
    );
  });
});

describe('clipplayer face — the pure projections', () => {
  it('an empty player projects 64 empty pads and eight default lanes', () => {
    const pads = clipplayerPadViews(undefined);
    expect(pads).toHaveLength(CLIP_LANES * CLIP_SLOTS);
    expect(pads.every((p) => p.state === 'empty' && !p.hasClip && !p.hasAuto)).toBe(true);

    const lanes = clipplayerLaneViews(undefined);
    expect(lanes).toHaveLength(CLIP_LANES);
    for (const l of lanes) {
      expect(l.mono, 'POLY is the default').toBe(false);
      expect(l.rate).toBe(RATE_DEFAULT_INDEX);
      expect(l.rateLabel).toBe(RATE_LABELS[RATE_DEFAULT_INDEX]);
      expect(l.armed).toBe(false);
      expect(l.playing).toBeNull();
      // A CONCRETE hex on every lane, never null — a caller cannot paint a lane
      // with no colour at all.
      expect(l.color).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Eight DISTINCT default hues, which is what makes a column identifiable.
    expect(new Set(lanes.map((l) => l.color)).size).toBe(CLIP_LANES);
  });

  it('a loaded player projects loaded and playing pads', () => {
    const d = loadedData();
    expect(clipplayerPadState(d, clipIndex(0, 0))).toBe('loaded');
    expect(clipplayerPadState(d, clipIndex(2, 1))).toBe('playing');
    expect(clipplayerPadState(d, clipIndex(3, 3))).toBe('empty');
    expect(clipplayerHasAnyClip(d)).toBe(true);
    expect(clipplayerHasAnyClip(undefined)).toBe(false);
    expect(clipplayerPlayingLaneCount(d)).toBe(1);
    expect(clipplayerPlayingLaneCount(undefined)).toBe(0);
  });

  // ⚠ THE PRECEDENCE IS LOAD-BEARING AND IT IS NOT ALPHABETICAL. A pending STOP
  // on the pad that is currently sounding is the single most important thing
  // the grid can say, and `lanePlaying === slot` is true throughout it — so
  // QUEUED must win over PLAYING or the change coming is invisible.
  it('QUEUED wins over PLAYING, including a pending stop on the playing pad', () => {
    const d = { ...loadedData(), queued: [null, 'stop', null, null, null, null, null, null] } as unknown as ClipPlayerData;
    expect(clipplayerPadState(d, clipIndex(2, 1))).toBe('queued');

    const switching = {
      ...loadedData(),
      clips: { ...(loadedData().clips as object), [String(clipIndex(5, 1))]: defaultNoteClip() },
      queued: [null, 5, null, null, null, null, null, null],
    } as unknown as ClipPlayerData;
    expect(clipplayerPadState(switching, clipIndex(5, 1)), 'the incoming pad').toBe('queued');
    expect(clipplayerPadState(switching, clipIndex(2, 1)), 'the outgoing pad still sounds').toBe('playing');
  });

  it('scene views default to infinite and read a set count', () => {
    const none = clipplayerSceneViews(undefined);
    expect(none).toHaveLength(CLIP_SLOTS);
    expect(none.every((s) => s.count === 0 && s.label === '∞')).toBe(true);

    const set = clipplayerSceneViews({ sceneRepeats: { '3': 4 } } as unknown as ClipPlayerData);
    expect(set[3]!.count).toBe(4);
    expect(set[3]!.label).toBe('×4');
    expect(set[0]!.label).toBe('∞');
  });

  it('the repeat cycle wraps, and an off-ring count falls back to infinite', () => {
    // The card's gesture, and the face's: ∞ → 2 → 3 → 4 → 8 → ∞.
    expect(SCENE_REPEAT_CYCLE[0], 'the cycle starts at the quiet default').toBe(0);
    let cur = 0;
    const seen: number[] = [];
    for (let i = 0; i < SCENE_REPEAT_CYCLE.length; i++) {
      cur = nextSceneRepeat(cur);
      seen.push(cur);
    }
    expect(seen).toEqual([2, 3, 4, 8, 0]);
    // A Launchpad-set count that is not on the ring (1..63 are all legal there)
    // must not make the gesture a NO-OP: it falls to the ring's first entry.
    expect(nextSceneRepeat(37)).toBe(0);
    expect(nextSceneRepeat(37)).not.toBe(37);
  });

  it('a dangling automation assignment is not counted', () => {
    const d = { autoAssign: { alive: 0, deleted: 0 } } as unknown as ClipPlayerData;
    expect(clipplayerLaneViews(d)[0]!.assigned, 'no filter: both counted').toBe(2);
    expect(
      clipplayerLaneViews(d, (id) => id === 'alive')[0]!.assigned,
      'the ghost is filtered while the prune catches up',
    ).toBe(1);
  });
});

describe('clipplayer face — what a def-reading gate cannot see', () => {
  // ⚠ THE EXTRACTION LEG. The card's own comment records that two copies of the
  // clip menu is how a restructure once landed on ONE surface with every test
  // green. Promotion would have made that four copies (card, launch panel, note
  // panel). This asserts there is exactly one definition and that all three
  // surfaces render it.
  it('ONE clip-menu definition, rendered by all three surfaces', () => {
    const menu = read('ClipplayerClipMenu.svelte');
    // The option lists live in the shared component, not in any consumer.
    expect(menu).toContain('probMenuLevels()');
    expect(menu).toContain('pitchProbMenuLevels()');
    for (const consumer of ['ClipplayerLaunchPanel.svelte', 'ClipplayerNotePanel.svelte']) {
      expect(read(consumer), `${consumer} mounts the shared menu`).toContain('<ClipplayerClipMenu');
    }
    expect(CARD(), 'the legacy card mounts the shared menu too').toContain('<ClipplayerClipMenu');
    // …and NOBODY re-implements the option list.
    for (const f of PANELS) {
      expect(read(f), `${f} does not re-list the probability levels`).not.toContain('probMenuLevels(');
    }
    expect(CARD()).not.toContain('probMenuLevels()');
  });

  // ⚠ RULE 1 OF THE PANEL CONTRACT: `faces-parity` asserts EXACT MULTISET
  // EQUALITY between the dock's `control-*` testids and the def's param ids. A
  // panel edits `node.data`, so any `control-` testid inside one reads as an
  // extra control with no def backing and fails the whole face. This is the
  // latent shape #2302 found on ElectraGridBody — a bound Knob emitting
  // `control-<paramId>` — so it is asserted here rather than trusted.
  it('no panel or body emits a `control-` testid', () => {
    for (const f of [...PANELS, 'ClipplayerDeckBody.svelte', 'ClipplayerTileBody.svelte', 'ClipplayerClipMenu.svelte']) {
      expect(read(f), `${f} emits no control- testid`).not.toMatch(/data-testid=["'{`][^\n]*control-/);
    }
  });

  // ⚠ THE #2314 RULE, AT THE SOURCE. The tile body mounts for EVERY clip player
  // on EVERY rack boot. #2314 shipped a 60-scene VRT regression because a tile
  // `$effect` ran a real encoder probe per mount. Nothing here may poll, read
  // the engine, or subscribe.
  it('the tile body does no work: no rAF, no engine read, no effect', () => {
    const tile = read('ClipplayerTileBody.svelte');
    expect(tile).not.toContain('requestAnimationFrame');
    expect(tile).not.toContain('useEngine');
    expect(tile).not.toContain('$effect');
    expect(tile).not.toContain('setInterval');
    // …and the positive half: it DOES project the lanes, so the leg above is
    // not green because the file is empty.
    expect(tile).toContain('clipplayerLaneViews');
  });

  // ⚠ AND THE POLL THE CARD OWNED IS IN THE DOCK BODY, which exists only while
  // the full view is open — exactly the cost the legacy card had while IT was
  // open, and no more.
  it('the one rAF poll lives in the fullViewBody', () => {
    expect(read('ClipplayerDeckBody.svelte')).toContain('requestAnimationFrame');
  });

  // ⚠ THE NOTE PANEL MUST NOT WRITE ON MOUNT. It draws a DEFAULT clip's grid
  // for an empty slot and commits on the first EDIT; a band that committed a
  // clip to the Y.Doc for being rendered would put a write in every rack boot
  // and in every VRT capture.
  it('the note panel creates a clip only from a click, never from an effect', () => {
    const src = read('ClipplayerNotePanel.svelte');
    expect(src).toContain('ensureThenEdit');
    // The only call site is the helper; the helper is only called from onclick.
    const calls = [...src.matchAll(/ensureClipplayerClip\(/g)];
    expect(calls, 'exactly one ensure call site').toHaveLength(1);
    for (const m of src.matchAll(/\$effect\(([\s\S]{0,400}?)\n  \}\);/g)) {
      expect(m[1], 'no $effect writes a clip').not.toContain('ensureClipplayerClip');
    }
  });

  // ⚠ THE FOUR DELETED FAMILIES STILL PAINT, which is the difference between
  // "not a cell" and "gone". Three are StatusLed lamps in the deck body; CLR
  // AUTO is a button in the note panel, where the clip it clears is open.
  it('every deleted family still has a surface', () => {
    const deck = read('ClipplayerDeckBody.svelte');
    expect(deck).toContain('clipplayer-auto-assigned-');
    expect(deck).toContain('clipplayer-auto-cap-');
    expect(deck).toContain('clipplayer-auto-override-');
    expect(deck).toContain('StatusLed');
    expect(read('ClipplayerNotePanel.svelte')).toContain('clipplayer-clear-auto-');
  });

  // ⚠ THE MIDI BINDING ON RST IS DOCUMENTED AND PERSISTED (its keys live in
  // localStorage and the def advertises it), and a bare <Button> in a shell
  // action cell would have dropped it. The body wraps RST in the same
  // MidiAssignButton the card does, on the same paramId.
  it('RST keeps its MIDI-assign binding on the face', () => {
    const deck = read('ClipplayerDeckBody.svelte');
    expect(deck).toContain('MidiAssignButton');
    expect(deck).toMatch(/paramId="reset"/);
  });

  // ⚠ THE ONE ONGOING BEHAVIOUR, AND WHY IT NEEDED NO MOVE. The card's
  // `pruneAutoAssignDangling` $effect is the shape promotion deletes silently —
  // but `pruneAllAutoAssignDangling()` already sweeps every clip player from
  // the Canvas graph-change seam. Re-mounting it on a face surface would add a
  // second janitor for a finished job.
  it('the platform prune is what covers the card effect — no duplicate on the face', () => {
    const canvas = readFileSync(resolve(HERE, '..', 'Canvas.svelte'), 'utf8');
    expect(canvas, 'the platform sweep exists and is called').toContain('pruneAllAutoAssignDangling()');
    for (const f of ['ClipplayerDeckBody.svelte', 'ClipplayerTileBody.svelte']) {
      // THE IMPORT, not a mention: the deck body's header explains the decision
      // by naming the function, so a substring check would fail on the prose
      // that documents the very thing it asserts. A janitor it cannot import is
      // a janitor it cannot run.
      expect(read(f), `${f} adds no second janitor`).not.toMatch(
        /import[^;]*pruneAutoAssignDangling/,
      );
    }
  });

  // ⚠ THE PANELS WRITE THROUGH THE SHARED SEAMS, never their own arithmetic.
  // Two copies of a per-lane array rebuild is how the card and the face come to
  // disagree about what a gesture does, on data that is already synced.
  it('no panel writes node.data directly', () => {
    for (const f of PANELS) {
      const src = read(f);
      expect(src, `${f} does not open its own transaction`).not.toContain('ydoc.transact');
      expect(src, `${f} imports its writes`).toContain('./clipplayer-face-actions');
    }
  });

  // ⚠ THE SELECTION IS NODE-KEYED AND NOT SYNCED. The card's spec calls the
  // equivalent card-local state "a personal authoring lens"; putting it in
  // node.data would drag a collaborator's editor to your clip mid-edit, and
  // putting it in component state would reset it every time the dock collapsed
  // (#1531/#1574/#1583).
  it('the editor selection is node-keyed component-free state, never node.data', () => {
    const sel = read('clipplayer-face-selection.svelte.ts');
    expect(sel).toContain('SvelteMap');
    expect(sel, 'not synced').not.toContain('ydoc');
    expect(sel, 'and it is bounded — an unwired cleanup export is a leak').toContain('pruneDeletedNodes');
  });
});

describe('clipplayer — the docs corrections this promotion carried', () => {
  // ⚠ THE SHIPPED WINDOW IS THREE OCTAVES AND SEVEN AUTHORED SURFACES SAID
  // FOUR. `restrictedRowWindow(root, scale, floor, octaves = 3)` is the law and
  // the card passes 3. Nothing caught it because every one of the seven is
  // PROSE; the tooltips that state the number to a player INTERPOLATE the
  // constant and were right the whole time.
  it('no surface says "4-octave" any more, and the law is still three', () => {
    const clipTypes = readFileSync(
      resolve(HERE, '..', '..', 'audio', 'modules', 'clip-types.ts'),
      'utf8',
    );
    expect(clipTypes, 'the shipped default').toMatch(/octaves\s*=\s*3/);
    const defSrc = readFileSync(resolve(HERE, '..', '..', 'audio', 'modules', 'clipplayer.ts'), 'utf8');
    expect(defSrc).not.toContain('4-octave');
    expect(CARD()).not.toContain('4-octave');
    // ⚠ THE NOTE PANEL IS ASSERTED POSITIVELY, not by a negative grep: its own
    // header names the drift it is not repeating (the string "4-octave" appears
    // there on purpose), so the property worth pinning is that it declares the
    // constant and hands it to `restrictedRowWindow` rather than spelling any
    // number into a player-visible string. That is exactly what kept the card's
    // tooltips right while seven prose surfaces went wrong.
    const panel = read('ClipplayerNotePanel.svelte');
    expect(panel).toMatch(/const RESTRICT_OCTAVES = 3;/);
    expect(panel).toMatch(/restrictedRowWindow\([^)]*RESTRICT_OCTAVES\)/);
    expect(clipplayerDef.docs!.controls!.restrictRange).toContain('3-octave');
    expect(clipplayerDef.docs!.controls!.rangeFloor).toContain('3-octave');
  });

  // ⚠ AND THIS CORRECTION IS WHAT LET THE FAMILY KEEP A CELL. The blob called
  // the flair "read-only" and card editing "a follow-up"; the card has carried
  // `cycleSceneRepeat` on a click long enough to say so in its own comment. A
  // read-only family has no honest probe and would have joined the four
  // deleted ones.
  it('the scene-repeat docs describe the click gesture the card actually has', () => {
    const blob = clipplayerDef.docs!.controls!['clipplayer-scene-repeat-{n}']!;
    expect(blob).not.toContain('read-only');
    expect(blob).not.toContain('card-side editing is a follow-up');
    expect(blob.toUpperCase()).toContain('CLICK');
    expect(CARD(), 'the gesture the doc now describes').toContain('cycleSceneRepeat');
  });

  // ⚠ THE SAME STALE CLAIM WAS IN THE EXPLANATION TOO — a THIRD surface, found
  // only by grepping the def for the sentence rather than trusting that fixing
  // the control blob had fixed the module's prose. It also said "nothing shown
  // for infinite", which the card contradicts in its own markup: at rest it
  // renders `sceneRepeatLabel`, which returns "∞" for a count of 0, and only
  // swaps to the progress flair WHILE a scene is counting.
  it('the EXPLANATION carries the same correction, not just the control blob', () => {
    const explanation = clipplayerDef.docs!.explanation;
    expect(explanation).not.toContain('read-only');
    expect(explanation).not.toContain('editing the count from the card is a follow-up');
    expect(explanation).not.toContain('nothing shown for infinite');
    expect(explanation, 'and it states the gesture both surfaces perform').toContain(
      '∞ → 2 → 3 → 4 → 8 → ∞',
    );
    // The card's own resting label is what makes "∞" the honest word.
    expect(CARD()).toContain("return c === 0 ? '∞'");
  });
});
