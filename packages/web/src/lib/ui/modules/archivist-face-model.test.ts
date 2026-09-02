// packages/web/src/lib/ui/modules/archivist-face-model.test.ts
//
// The ARCHIVIST face, pinned where a def-reading gate cannot look.
//
// ⚠ WHY THIS FILE EXISTS RATHER THAN LEANING ON THE FLEET GATES. archivist is
// the THIRD and last member of `DOM_SOURCE_LANE_TYPES` to be promoted, and that
// membership is what makes several of the properties below invisible to every
// shared gate in the tree:
//
//   * `EXTENSION_BODY_ROLES` (face-rack-status-source.test.ts) resolves the
//     `fullViewBody` and NOTHING ELSE — it is structurally unable to see a
//     `tileBody`. archivist's tile body is load-bearing (a fresh archivist has
//     no item and the lane would offer no way to get one), so it is pinned
//     here or nowhere.
//   * No gate can see that the card and the two bodies mount ONE component. The
//     no-drift property is the whole reason `ArchivistBrowseControls.svelte`
//     exists, and a future edit that copied its markup back into the card would
//     be green everywhere else.
//   * No gate can see that the bodies are not a SECOND OWNER. "The body does
//     not fetch, adopt an element, or call the engine" is a source property,
//     and it is the property that separates this design from the one that
//     would kill a live capture.
//
// ⚠ WHAT THIS FILE IS STRUCTURALLY UNABLE TO SEE: it reads SOURCE and the DEF.
// It cannot tell you the Search button is visible, that a press reaches
// archive.org, or that the off-screen card is the mount that answered. That is
// `e2e/tests/face-archivist.spec.ts`.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { archivistDef } from '$lib/video/modules/archivist';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  noUserControlIds,
  noUserControlProblems,
} from '$lib/ui/workflow/no-user-control';
import type { NoUserControlDefLike } from '$lib/graph/types';
import { DOM_SOURCE_LANE_TYPES, needsHeadlessSourceMount } from '$lib/ui/workflow/dom-source-modules';

const def = archivistDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const defSource = read('../../video/modules/archivist.ts');
const controlsSource = read('archivist/ArchivistBrowseControls.svelte');
const bodySource = read('archivist/ArchivistArchiveBody.svelte');
const tileSource = read('archivist/ArchivistTileBody.svelte');
const extSource = read('archivist/shell-extension.ts');
const cardSource = read('ArchivistCard.svelte');

// The code-only views. A raw grep cannot tell code from a comment, and several
// legs below forbid a construct whose natural explanation NAMES it.
const controlsCode = stripSourceComments(controlsSource);
const bodyCode = stripSourceComments(bodySource);
const tileCode = stripSourceComments(tileSource);
const cardCode = stripSourceComments(cardSource);

/** The LIVE `ParamDef`. */
function param(id: string) {
  const p = archivistDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`archivist has no param '${id}'`);
  return p;
}

/** The shader body, as the def declares it. */
const fragSrc = /const FRAG_SRC = `([\s\S]*?)`;/.exec(defSource)?.[1] ?? '';

describe('archivist face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('archivist')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still has a live picture", () => {
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(archivistDef)).toBe(true);
  });

  it('the glyph choice is a DECISION, not a forced one — this def HAS audio outputs', () => {
    // `glyphBinding()` short-circuits on the first `type: 'audio'` OUTPUT, so
    // any other literal here would resolve to a LIVE binding and the dead-glyph
    // clause would stay silent while a VU of a found recording competed with
    // the module's own picture for the tile.
    const audioOuts = archivistDef.outputs.filter((o) => o.type === 'audio').map((o) => o.id);
    expect(audioOuts).toEqual(['audio_l', 'audio_r']);
  });
});

describe('⚠ THE BLOCKER IS DISCHARGED, NOT RECLASSIFIED — archivist really IS a DOM source', () => {
  // The two 2026-09-02 retirements next door (peertube, recorderbox) both
  // worked by showing the module was not in this set. That argument does NOT
  // transfer, and pinning the difference is what stops a future reader
  // "simplifying" archivist onto their reasoning.
  it('is STILL in DOM_SOURCE_LANE_TYPES', () => {
    expect(DOM_SOURCE_LANE_TYPES.has('archivist')).toBe(true);
  });

  it('STILL needs the headless host under the shell — the card really is parked, not deleted', () => {
    expect(needsHeadlessSourceMount({ kind: 'shell', type: 'archivist' })).toBe(true);
    expect(needsHeadlessSourceMount({ kind: 'placeholder', type: 'archivist' })).toBe(true);
    // ...and NOT double-mounted where a real card already renders.
    expect(needsHeadlessSourceMount({ kind: 'legacy', type: 'archivist' })).toBe(false);
    expect(needsHeadlessSourceMount({ kind: 'stub', type: 'archivist' })).toBe(false);
  });

  it('the card still ATTACHES the source — the property the grep gate derives', () => {
    expect(cardCode).toContain('attachExternalSource');
    expect(cardCode).toContain('nodeMedia.adopt');
  });
});

describe('archivist face — the tier ladder, and why it is ONE control', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('every tier shows exactly GAIN — the module has one param a player turns', () => {
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      expect(keysAt(tier), `tier ${tier}`).toEqual(['gain']);
    }
  });

  it('the synthetic param reaches NO tier', () => {
    // The failure this forbids is concrete: an undeclared `cv_play_trigger`
    // renders as a continuous rotary over a raw gate level, turnable, and
    // stomped by the next bridge write.
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      expect(keysAt(tier), `tier ${tier}`).not.toContain('cv_play_trigger');
    }
  });

  it('declares NO pages, so no tab rail is manufactured', () => {
    // ⚠ AND THAT IS THE OWNER RULING APPLIED CORRECTLY, not skipped. "Control
    // heavy = tabbed" is about ranked CELLS, and this face has one. The browse
    // surface is an extension BODY, which is not a band and cannot be paged;
    // every video face with a body in the tree (videobox, peertube,
    // videovarispeed, tvLibrarian) is shaped the same way.
    expect(def.face?.pages).toBeUndefined();
  });

  it('GAIN is a FADER, because unity is at the MIDDLE of a 0..2 throw', () => {
    expect(def.face?.paramCells?.gain).toBe('fader');
    const gain = param('gain');
    expect(gain.min).toBe(0);
    expect(gain.max).toBe(2);
    expect(gain.defaultValue).toBe(1);
    expect((gain.defaultValue - gain.min) / (gain.max - gain.min)).toBeCloseTo(0.5, 10);
  });
});

describe('the ranked cell is HONEST — the shader really reads `gain`', () => {
  it('FRAG_SRC declares a uGain uniform and multiplies the sample by it', () => {
    expect(fragSrc).toContain('uniform float uGain');
    expect(fragSrc).toMatch(/texture\(uTex, vUv\)\.rgb \* uGain/);
  });

  it('draw() pushes the param into that uniform', () => {
    expect(defSource).toMatch(/uniform1f\(uGain, params\.gain\)/);
  });
});

describe('the noUserControl declaration, driven in BOTH directions', () => {
  const nuc = archivistDef as unknown as NoUserControlDefLike;

  it('declares exactly the one synthetic param, and it is not ranked', () => {
    expect([...noUserControlIds(nuc)]).toEqual(['cv_play_trigger']);
    expect(def.face?.order).toEqual(['gain']);
  });

  it("the declaration is SOUND against archivist's own ports (positive control)", () => {
    expect(noUserControlProblems(nuc)).toEqual([]);
  });

  it('every param is EITHER ranked OR declared — nothing falls through', () => {
    const ranked = new Set(def.face?.order ?? []);
    const declared = new Set(noUserControlIds(nuc));
    for (const p of archivistDef.params) {
      expect(
        ranked.has(p.id) || declared.has(p.id),
        `${p.id} is neither ranked nor declared noUserControl`,
      ).toBe(true);
    }
  });

  it("REJECTS writer 'internal' on cv_play_trigger — a port DOES target it", () => {
    // The negative control on the declaration itself: `play_trigger` declares
    // `paramTarget: 'cv_play_trigger'`, so 'cv-port' is the only legal writer
    // and 'internal' must be refused rather than silently accepted.
    const wrong = {
      ...archivistDef,
      noUserControl: [{ param: 'cv_play_trigger', writer: 'internal', why: 'wrong on purpose' }],
    } as unknown as NoUserControlDefLike;
    expect(noUserControlProblems(wrong).length).toBeGreaterThan(0);
  });
});

describe('⚠ ONE COMPONENT, THREE MOUNTS — the no-drift property, pinned', () => {
  it('the CARD and BOTH bodies import the SAME controls component', () => {
    expect(cardCode).toContain('ArchivistBrowseControls');
    expect(bodyCode).toContain('ArchivistBrowseControls');
    expect(tileCode).toContain('ArchivistBrowseControls');
  });

  it('the CARD no longer carries its own search box, transport or attribution', () => {
    // The half that would silently rot: a future edit that "just adds the
    // search box back to the card" gives the module two answers about what the
    // query is. Each of these is a control that MOVED, named individually so a
    // partial regression is not green.
    expect(cardCode).not.toContain('search archive.org…');
    expect(cardCode).not.toContain('archivist-search-btn');
    expect(cardCode).not.toContain('archivist-reroll-btn');
    expect(cardCode).not.toContain('archivist-year-from');
    expect(cardCode).not.toContain('archivist-play');
    expect(cardCode).not.toContain('archivist-seek');
    expect(cardCode).not.toContain('title-link');
  });

  it('the controls take node.data LEAVES, never the enclosing `data` object', () => {
    // ⚠ THE SyncedStore PROXY HAS A STABLE IDENTITY, so a `$derived` handed the
    // `data` object recomputes to the same proxy, is value-equal, and notifies
    // NOBODY — the shape that shipped a dead RECORD switch on recorderbox. The
    // props are scalars for that reason.
    for (const leaf of ['itemTitle', 'itemType', 'durationSec', 'isPlaying', 'cleanOutput', 'detailsUrl', 'hasItem']) {
      expect(controlsCode, `${leaf} must be a declared prop`).toContain(leaf);
    }
    // ...and the component never reaches for the object itself.
    expect(controlsCode).not.toMatch(/data\s*:\s*Partial<ArchivistData>/);
  });

  it('the search inputs are rehydrated ONCE at mount, not read reactively', () => {
    // ⚠ FORCED BY HAVING A MOUNT INSIDE THE LEGACY CARD SUBTREE, where
    // `patch.nodes[…]` reads are NOT reactive. A one-shot onMount read is the
    // only shape that is correct in BOTH subtrees — the argument
    // `PeerTubePicker` records for its own box.
    expect(controlsCode).toContain('onMount');
    expect(controlsCode).toMatch(/d\.searchTerm/);
  });
});

describe('⚠ THE BODIES ARE NOT A SECOND OWNER', () => {
  // The property that separates this design from the one that kills a live
  // capture. Each leg is a thing the CARD does and the bodies must not.
  for (const [name, code] of [['fullViewBody', bodyCode], ['tileBody', tileCode]] as const) {
    it(`${name} never FETCHES archive.org`, () => {
      expect(code).not.toContain('fetch(');
      expect(code).not.toContain('advancedsearch');
      expect(code).not.toContain('METADATA_URL');
    });

    it(`${name} never ADOPTS a node-owned element`, () => {
      // A DOM node has one parent, and the card holds all three nodeMedia
      // leases. Adopting one here would move it out from under the mount that
      // owns the attach.
      expect(code).not.toContain('nodeMedia');
      expect(code).not.toContain('.adopt(');
    });

    it(`${name} never calls attachExternalSource or drives the element`, () => {
      expect(code).not.toContain('attachExternalSource');
      expect(code).not.toContain('.currentTime');
      expect(code).not.toContain('.play()');
    });
  }

  it('the CARD is the one that registers the commands and publishes the status', () => {
    expect(cardCode).toContain('archivistStatus.registerCommands');
    expect(cardCode).toContain('archivistStatus.publish');
    expect(bodyCode).not.toContain('registerCommands');
    expect(tileCode).not.toContain('registerCommands');
  });

  it('the bodies reach the card ONLY through the registry', () => {
    expect(controlsCode).toContain('archivistStatus.request');
  });
});

describe('⚠ BOTH BODY SLOTS — the half EXTENSION_BODY_ROLES cannot see', () => {
  it('the extension declares a fullViewBody AND a tileBody', () => {
    // ⚠ THE TILE IS LOAD-BEARING, not a nicety: a fresh archivist has NO item
    // (`node.data.item` is null until a search writes one and the factory
    // searches nothing on its own), so a fullViewBody-only extension would
    // paint the idle gradient in the lane with no way to fill it —
    // cameraInput's shipped mistake, on the module it costs most.
    expect(extSource).toMatch(/fullViewBody:\s*ArchivistArchiveBody/);
    expect(extSource).toMatch(/tileBody:\s*ArchivistTileBody/);
  });

  it('the def names the extension the directory provides', () => {
    expect(def.face?.extension).toBe('archivist');
  });

  it('the TILE does NO mount-time work — no fetch, no probe, no rAF', () => {
    // ⚠ recorderbox (#2314) shipped a 60-scene VRT regression because a tile
    // `$effect` ran a real encoder probe on every rack boot. This is that
    // lesson, pinned on the next tile to ship.
    expect(tileCode).not.toContain('requestAnimationFrame');
    expect(tileCode).not.toContain('setInterval');
    expect(tileCode).not.toContain('fetch(');
  });

  it('the TILE drops ONLY what a 192 px lane cannot hold', () => {
    // `compact` must never drop a control that is the only route to something.
    expect(tileCode).toContain('compact');
    expect(controlsCode).toMatch(/\{#if !compact\}/);
    // Search, ↻ next and the whole transport are OUTSIDE every compact guard.
    const guarded = controlsCode.slice(controlsCode.indexOf('{#if !compact}'));
    expect(guarded.indexOf('archivist')).toBe(-1); // no testid prefix literal inside
    expect(controlsCode).toContain('{testidPrefix}-search-btn');
    expect(controlsCode).toContain('{testidPrefix}-reroll-btn');
    expect(controlsCode).toContain('{testidPrefix}-play');
  });
});

describe('⚠ SCREEN ON/OFF — present, on the shared key, and it keeps the watch mark', () => {
  it('the body owns a SCREEN switch over `previewCollapsed`', () => {
    expect(bodyCode).toContain('previewCollapsed');
    expect(bodyCode).toContain('archivist-face-screen-toggle');
    expect(bodySource).toContain('SCREEN ON');
    expect(bodySource).toContain('SCREEN OFF');
  });

  it('the collapsed branch STILL calls markWatched', () => {
    // A lapsed mark drops the node from the pull set. archivist is a pure
    // SOURCE feeding image, video AND both audio jacks, so that would idle the
    // picture every consumer samples — a control labelled SCREEN must not be a
    // downstream mute.
    const collapsed = /if \(previewCollapsed\) \{([\s\S]*?)\n    \}/.exec(bodyCode)?.[1] ?? '';
    expect(collapsed).toContain('markWatched');
  });

  it('the collapsed branch touches NO transport — the item keeps playing', () => {
    // Stronger than the fleet's ordering-dependent guarantee: the element, its
    // play(), the playhead pump and every gate/CV write are the off-screen
    // CARD's, and this body never reaches them at all.
    const collapsed = /if \(previewCollapsed\) \{([\s\S]*?)\n    \}/.exec(bodyCode)?.[1] ?? '';
    expect(collapsed).not.toContain('pause');
    expect(collapsed).not.toContain('archivistStatus.request');
  });
});

describe('⚠ THE DELETED RESTING READOUTS — gone from EVERY surface, not hidden', () => {
  it('the `0:04 / 2:00` time line is gone, and formatTime is no longer a card import', () => {
    // videobox and videovarispeed deleted this exact line. Position survives
    // where a scrubber's position always did — on the scrubber.
    expect(cardCode).not.toContain('archivist-time');
    expect(controlsCode).not.toContain('archivist-time');
    expect(cardCode).not.toMatch(/formatTime\(/);
  });

  it('position survives on the seek control as aria-valuetext', () => {
    expect(controlsCode).toContain('aria-valuetext');
    expect(controlsCode).toContain('seekValueText');
  });

  it('the `Internet Archive · {type}` line is gone from every surface', () => {
    // ⚠ ASSERTED ON THE ELEMENT, NOT THE PROSE. The sentence naming the
    // deletion appears in three headers by design — that is what a reader needs
    // — so the gate reads the markup instead: `.src-line` was the div and it
    // exists nowhere now.
    for (const src of [cardSource, controlsSource, bodySource, tileSource]) {
      expect(src).not.toContain('src-line');
      expect(src).not.toMatch(/>\s*Internet Archive ·/);
    }
  });

  it('what it carried lives on the picture ACCESSIBLE NAME instead', () => {
    for (const src of [cardSource, bodySource]) {
      expect(src).toContain('from the Internet Archive');
      expect(src).toContain('aria-label');
    }
  });

  it('the play-only warning is a StatusLed — a STATIC caption with the sentence on the label', () => {
    // KEPT rather than deleted: it is the only account a player has of a
    // patched `video` jack delivering the idle pattern. As a lamp it paints no
    // derived text.
    expect(controlsSource).toContain('StatusLed');
    expect(controlsSource).toContain('caption="CLEAN OUT"');
    expect(controlsSource).toContain('detail=');
    // The refused shape: the old free-text warning SPAN. Asserted on the
    // painted string and the class, not on the phrase — the headers explain
    // the change and must stay free to say it.
    expect(controlsSource).not.toContain('⚠ play-only');
    for (const src of [cardSource, controlsSource, bodySource]) {
      expect(src).not.toContain('class="cors-warn"');
    }
  });
});

describe('⚠ THE WRITE-ONLY MIRROR IS REPAIRED — the query comes from the GRAPH', () => {
  it('the card reads the four search keys back out of node.data', () => {
    // The shipped defect: the card WROTE searchTerm/mediaType/yearFrom/yearTo
    // for multiplayer and never read them again, so a rack-mate's typing left
    // it searching its own stale local copy.
    expect(cardCode).toContain('currentQuery');
    expect(cardCode).toMatch(/d\?\.searchTerm/);
    expect(cardCode).toMatch(/d\?\.mediaType/);
    expect(cardCode).toMatch(/d\?\.yearFrom/);
    expect(cardCode).toMatch(/d\?\.yearTo/);
  });

  it('the card no longer holds the inputs as its own $state', () => {
    expect(cardCode).not.toMatch(/let searchTerm = \$state/);
    expect(cardCode).not.toMatch(/let mediaType = \$state/);
    expect(cardCode).not.toMatch(/let yearFromStr = \$state/);
  });

  it('the search command takes NO arguments — the graph is the single answer', () => {
    // A command that carried the query would let the surface that INVOKED the
    // search decide it, so a search from the tile could use a term the dock's
    // box had already replaced.
    expect(controlsCode).toMatch(/request\(nodeId, \{ kind: 'search' \}\)/);
  });

  it('the surface WRITES the inputs before asking for a search', () => {
    const runSearch = /function runSearch\(\): void \{([\s\S]*?)\n  \}/.exec(controlsCode)?.[1] ?? '';
    expect(runSearch).toContain('writeSearchInputs()');
    expect(runSearch.indexOf('writeSearchInputs()')).toBeLessThan(runSearch.indexOf('request('));
  });
});

describe('⚠ HASH TRANSPARENCY — every new file is outside the WebGL attest basis', () => {
  it('the seam and both bodies live under lib/ui, never lib/video', () => {
    // `lib/video/**` is hashed WHOLESALE for the real-GPU attest, so a file
    // there puts every future face edit on that critical path. This is a
    // constraint on future edits, not just a description of today.
    for (const rel of [
      'archivist/ArchivistBrowseControls.svelte',
      'archivist/ArchivistArchiveBody.svelte',
      'archivist/ArchivistTileBody.svelte',
      'archivist/shell-extension.ts',
    ]) {
      expect(() => read(rel)).not.toThrow();
    }
  });

  it('the def gained ONLY hash-transparent keys — no param, port or factory move', () => {
    expect(archivistDef.params.map((p) => p.id)).toEqual(['gain', 'cv_play_trigger']);
    expect(archivistDef.inputs.map((p) => p.id)).toEqual(['play_trigger']);
    expect(archivistDef.outputs.map((p) => p.id)).toEqual([
      'image', 'video', 'audio_l', 'audio_r', 'loaded', 'ended', 'playing', 'playhead',
    ]);
  });

  it('the bodies never create a GL context', () => {
    // `resolveWebglBasis()` sweeps lib/ui/modules/**/*.svelte by CONTENT, so a
    // getContext("webgl") here would ENROL these files in the real-GPU attest.
    // The preview is a 2-D blit of the engine's own output for that reason.
    for (const code of [bodyCode, tileCode, controlsCode]) {
      expect(code).not.toContain("getContext('webgl");
      expect(code).not.toContain('getContext("webgl');
    }
    expect(bodyCode).toContain("getContext('2d'");
  });
});
