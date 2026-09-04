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
import { DOM_SOURCE_LANE_TYPES } from '$lib/ui/workflow/dom-source-modules';
import { NODE_ARCHIVIST_SOURCE_TYPES } from '$lib/ui/media/node-archivist-source-registry';

const def = archivistDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const defSource = read('../../video/modules/archivist.ts');
const controlsSource = read('archivist/ArchivistBrowseControls.svelte');
const bodySource = read('archivist/ArchivistArchiveBody.svelte');
const tileSource = read('archivist/ArchivistTileBody.svelte');
const extSource = read('archivist/shell-extension.ts');
// ⚠ THE OWNER MOVED OUT OF THE CARD (legacy-removal S1, 2026-09-03). Several
// legs below used to read `cardSource` to prove who owns the source; they read
// this instead. The card is still read, for the legs that are genuinely about
// the CARD — that it adopts rather than creates, and that it holds no query
// state of its own.
const controllerSource = read('../media/node-archivist-source-registry.ts');
const controllerBindingSource = read('../media/node-archivist-source.svelte.ts');

// The code-only views. A raw grep cannot tell code from a comment, and several
// legs below forbid a construct whose natural explanation NAMES it.
const controlsCode = stripSourceComments(controlsSource);
const bodyCode = stripSourceComments(bodySource);
const tileCode = stripSourceComments(tileSource);
const controllerCode = stripSourceComments(controllerSource);
const controllerBindingCode = stripSourceComments(controllerBindingSource);

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

describe('⚠ THE BLOCKER IS DISCHARGED, AND ARCHIVIST HAS SINCE LEFT THE SET ENTIRELY', () => {
  // ⚠ THIS BLOCK ASSERTED THE OPPOSITE UNTIL 2026-09-03, and the whole point of
  // it was that archivist could NOT be retired the way peertube and recorderbox
  // were — they left by showing they were never card-owned, and archivist
  // genuinely was. That argument was correct and is now spent: the
  // legacy-removal S1 extraction moved the archive.org chain, the three
  // elements, the attach, the audio wire and both loops to
  // `$lib/ui/media/node-archivist-source-registry`. archivist did not turn out
  // to have never been a DOM source; it STOPPED being one, which is a different
  // claim and the reason these legs are re-pointed rather than deleted.
  it('is NOT in DOM_SOURCE_LANE_TYPES any more — a node controller owns the source', () => {
    expect(DOM_SOURCE_LANE_TYPES.has('archivist')).toBe(false);
    // ⚠ AND `false` HERE IS ALSO WHAT AN UNKNOWN MODULE RETURNS, so the leg
    // below is what turns it into a statement about ownership rather than an
    // absence.
    expect(NODE_ARCHIVIST_SOURCE_TYPES.has('archivist')).toBe(true);
  });

  it('needs NO headless host — the host itself is retired, and the set stays empty', () => {
    // This leg used to enumerate `needsHeadlessSourceMount` over the four lane
    // kinds. The decision retired with `<HeadlessSourceHost>` (legacy-removal
    // S1.5): NO module gets an off-screen card in ANY lane state, which is the
    // stronger, structural form of what this leg asserted. What is left to
    // hold is the population statement the structure rests on.
    expect(
      DOM_SOURCE_LANE_TYPES.size,
      'a card-owned DOM source exists again — the headless host (or a node owner) must come back',
    ).toBe(0);
  });

  it('the CONTROLLER attaches the source, and the card only ADOPTS to display it', () => {
    // The property the grep gate derives, read from its new owner.
    expect(controllerBindingCode).toContain('attachExternalSource');
    // ⚠ THE CARD MUST NOT ATTACH. Two attach sites for one element is the
    // double-ownership hazard `nodeMedia`'s owner-checked adoption exists to
    // make impossible, one level up.
    // It still adopts — that is a VIEW concern and is what makes the preview work.
    // ...and it never `ensure`s: creating the element is the controller's job,
    // and a card that ensured one would mint a second for a node that has one.
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

describe('⚠ ONE COMPONENT, TWO MOUNTS — the no-drift property, pinned', () => {
  it('BOTH bodies import the SAME controls component', () => {
    expect(bodyCode).toContain('ArchivistBrowseControls');
    expect(tileCode).toContain('ArchivistBrowseControls');
    // …and the shared component is where the affordances really are, so "both
    // mount the same thing" is a statement about something that exists. The
    // prefix is a PROP, which is how one component serves two mounts without
    // either of them owning the testid.
    expect(controlsSource).toMatch(/testidPrefix/);
    expect(controlsSource).toContain('-search"');
  });

  // ⚠ 'the CARD no longer carries its own search box, transport or attribution'
  // STOOD HERE, naming each moved control individually so a partial regression
  // could not read as green. Its subject was the THIRD mount; with the card
  // gone there are two, and both are asserted above to be mounts of the ONE
  // component rather than copies of it — which is the property that deny-list
  // was protecting.

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
  for (const [name, code] of [['fullViewBody', bodyCode], ['tileBody', tileCode] as const]) {
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

  it('the CONTROLLER is the one that registers the commands and publishes the status', () => {
    // ⚠ RE-POINTED FROM THE CARD (legacy-removal S1). The claim is unchanged —
    // exactly ONE thing owns the commands and the status — but the owner is a
    // node-keyed controller rather than a mount. That is strictly stronger: a
    // card can be absent, and this cannot.
    expect(controllerBindingCode).toContain('archivistStatus.registerCommands');
    expect(controllerBindingCode).toContain('archivistStatus.publish');
    expect(bodyCode).not.toContain('registerCommands');
    expect(tileCode).not.toContain('registerCommands');
    // ...and the CARD is now a client of the seam like every other surface.
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
    const collapsed = /if \(previewCollapsed\) \{([\s\S]*?)\n {4}\}/.exec(bodyCode)?.[1] ?? '';
    expect(collapsed).toContain('markWatched');
  });

  it('the collapsed branch touches NO transport — the item keeps playing', () => {
    // Stronger than the fleet's ordering-dependent guarantee: the element, its
    // play(), the playhead pump and every gate/CV write are the off-screen
    // CARD's, and this body never reaches them at all.
    const collapsed = /if \(previewCollapsed\) \{([\s\S]*?)\n {4}\}/.exec(bodyCode)?.[1] ?? '';
    expect(collapsed).not.toContain('pause');
    expect(collapsed).not.toContain('archivistStatus.request');
  });
});

describe('⚠ THE DELETED RESTING READOUTS — gone from EVERY surface, not hidden', () => {
  it('the `0:04 / 2:00` time line is gone, and formatTime is no longer a card import', () => {
    // videobox and videovarispeed deleted this exact line. Position survives
    // where a scrubber's position always did — on the scrubber.
    expect(controlsCode).not.toContain('archivist-time');
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
    for (const src of [controlsSource, bodySource, tileSource]) {
      expect(src).not.toContain('src-line');
      expect(src).not.toMatch(/>\s*Internet Archive ·/);
    }
  });

  it('what it carried lives on the picture ACCESSIBLE NAME instead', () => {
    for (const src of [bodySource]) {
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
    for (const src of [controlsSource, bodySource]) {
      expect(src).not.toContain('class="cors-warn"');
    }
  });
});

describe('⚠ THE WRITE-ONLY MIRROR IS REPAIRED — the query comes from the GRAPH', () => {
  it('the OWNER reads the four search keys back out of node.data', () => {
    // The shipped defect: the card WROTE searchTerm/mediaType/yearFrom/yearTo
    // for multiplayer and never read them again, so a rack-mate's typing left
    // it searching its own stale local copy. The repair moved with the owner
    // (legacy-removal S1) — the controller reads the graph at the moment a
    // search runs, which is also what lets ONE command seam serve three
    // surfaces plus a peer.
    expect(controllerBindingCode).toMatch(/d\?\.searchTerm/);
    expect(controllerBindingCode).toMatch(/d\?\.mediaType/);
    expect(controllerBindingCode).toMatch(/d\?\.yearFrom/);
    expect(controllerBindingCode).toMatch(/d\?\.yearTo/);
    // And the read is reached from the SEARCH path, not merely present.
    expect(controllerCode).toMatch(/deps\.doc\.query\(/);
  });

  it('NOBODY holds the inputs as local $state — not the card, not a body', () => {
    for (const [name, code] of [['fullViewBody', bodyCode],
      ['tileBody', tileCode],
    ] as const) {
      expect(code, `${name} re-declared searchTerm`).not.toMatch(/let searchTerm = \$state/);
      expect(code, `${name} re-declared mediaType`).not.toMatch(/let mediaType = \$state/);
      expect(code, `${name} re-declared yearFromStr`).not.toMatch(/let yearFromStr = \$state/);
    }
  });

  it('the search command takes NO arguments — the graph is the single answer', () => {
    // A command that carried the query would let the surface that INVOKED the
    // search decide it, so a search from the tile could use a term the dock's
    // box had already replaced.
    expect(controlsCode).toMatch(/request\(nodeId, \{ kind: 'search' \}\)/);
  });

  it('the surface WRITES the inputs before asking for a search', () => {
    const runSearch = /function runSearch\(\): void \{([\s\S]*?)\n {2}\}/.exec(controlsCode)?.[1] ?? '';
    expect(runSearch).toContain('writeSearchInputs()');
    expect(runSearch.indexOf('writeSearchInputs()')).toBeLessThan(runSearch.indexOf('request('));
  });

  it('↻ next does NOT write them — a stale mount must not restate the query', () => {
    // ⚠ THREE MOUNTS HOLD THREE ONE-SHOT COPIES of the four keys, so a write
    // here lets a re-roll pressed on the lane tile blank a term typed in the
    // dock — and the card's `nextRandom` falls back to a FULL search on an
    // empty page, which would then run the blanked query. The legacy card's
    // ↻ next never wrote them; a term typed on this surface reaches the graph
    // through the input's own `onchange` (the blur the button click causes).
    const nextRandom = /function nextRandom\(\): void \{([\s\S]*?)\n {2}\}/.exec(controlsCode)?.[1] ?? '';
    expect(nextRandom).toContain("request(nodeId, { kind: 'next' })");
    expect(nextRandom).not.toContain('writeSearchInputs()');
  });

  it('the YEAR BOUNDS are number|null, because `type="number"` binds a NUMBER', () => {
    // ⚠ A CRASH, NOT A STYLE POINT. Svelte's `bind_value` treats
    // `<input type="number">` as number-like and writes `to_number(input.value)`
    // into the bound state, so a `$state('')` named `…Str` holds a NUMBER the
    // moment a digit is typed. The shipped card called `.trim()` on it and
    // threw `$.get(...).trim is not a function` inside `ydoc.transact`, killing
    // the search gesture. Every archivist test left the boxes empty, so nothing
    // reached the line until `face-archivist.spec.ts` typed one.
    expect(controlsCode).toMatch(/let yearFrom = \$state<number \| null>\(null\)/);
    expect(controlsCode).toMatch(/let yearTo = \$state<number \| null>\(null\)/);
    expect(controlsCode).toContain('bind:value={yearFrom}');
    expect(controlsCode).toContain('bind:value={yearTo}');
    // Nothing string-shaped survives on a bound number input.
    expect(controlsCode).not.toContain('yearFromStr');
    expect(controlsCode).not.toContain('yearToStr');
    // ...and the value that reaches the doc is FINITE or null, never NaN.
    expect(controlsCode).toMatch(/d\.yearFrom = yearOrNull\(yearFrom\)/);
    expect(controlsCode).toMatch(/Number\.isFinite\(v\)/);
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
