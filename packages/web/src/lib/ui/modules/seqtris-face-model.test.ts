// packages/web/src/lib/ui/modules/seqtris-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the SEQTRIS faceplate.
//
// ⚠ SEVEN OF THE CARD'S ELEVEN TESTIDS HAVE ZERO CONSUMERS — measured over the
// tree: `seqtris-card-*`, `-well-*`, `-cell-*`, `-controls-*`, `-control-*`,
// `-status-*` and `-picker-*` are referenced by NOTHING outside
// `SeqtrisCard.svelte`. So a promoted surface that silently dropped THE WELL,
// THE SCENE COLUMN or THE LAMP would be caught by no gate in the repo, and the
// three e2e legs that could see it live in one file that is itself new. This
// file is written against that blind spot rather than around it.
//
// The claims this face rests on, none of which a shared gate can check:
//
//   1. BOTH extension slots exist and are wired — the lane tile has a picture
//      and the dock has the controller.
//   2. `glyph: 'none'` is FORCED, measured through the real resolver.
//   3. ⚠ THE WELL IS DOM, NOT A CANVAS, and must stay that way: 64 testids plus
//      `data-piece` are the only machine-readable read of the board that is not
//      a `page.evaluate` into engine internals.
//   4. ⚠ THE BODIES SUBSCRIBE. They must never grow an rAF loop — this module
//      PUSHES, unlike the modtris/skifree siblings whose bodies poll.
//   5. THE SCENE COLUMN IS THE IMPORTED ROSTER, in order, dead entries included.
//   6. THE `revision` SEAM SURVIVED, and is shared so two mounted surfaces
//      cannot disagree about one hardware claim.
//   7. The face adds NO resting numbers, and the card's status PARAGRAPH is
//      gone while all six of its strings survive verbatim.
//   8. ⚠ THE VRT DETERMINISM ARGUMENT IS DERIVED HERE RATHER THAN ASSERTED IN A
//      COMMENT — `_shell-faces.ts` carries no `simPin` for this module, and
//      this is what makes that absence a measurement.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripSourceCommentsWithReport } from '$lib/source-guards/strip-source-comments';
import { seqtrisDef } from '$lib/audio/modules/seqtris';
import {
  SEQTRIS_COLS,
  SEQTRIS_ROWS,
  SEQTRIS_DEFAULT_SEED,
  cellIndex,
  createSeqtrisState,
  renderBoard,
  clockPulse,
  shuffledBag,
  type SeqtrisState,
} from '$lib/audio/modules/seqtris-engine';
import { SEQTRIS_SCENE_ACTIONS } from '$lib/audio/seqtris-launchpad';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { curatedFace, FACE_TIER_CAPS, type FaceTier } from '$lib/ui/workflow/curated-face';
import {
  shellExtensionIds,
  WIRED_SHELL_EXTENSION_SLOTS,
} from '$lib/ui/workflow/shell-extensions';

/** Every tier the shell can render, DERIVED from the cap table rather than
 *  re-typed — a hand-listed ladder would silently stop covering a new tier.
 *  ⚠ The CAPS themselves are never read as the answer below: the raw cap is the
 *  PRE-RECONCILIATION number rather than what the lane actually fits, and four
 *  sibling faces got that wrong. Every tier claim goes through `curatedFace`. */
const ALL_TIERS = Object.keys(FACE_TIER_CAPS) as FaceTier[];

const FACE = seqtrisDef.face!;

/**
 * ⚠ EVERY GREP IN THIS FILE READS CODE WITH THE COMMENTS REMOVED. This face's
 * headers quote the things it must NOT do — `requestAnimationFrame`,
 * `launchpad.release()`, `<canvas>`, `image-rendering: pixelated` — so a naive
 * scan would flag its own explanations as offences. The stripper replaces
 * comment bytes with whitespace, so offsets survive and source-ORDER legs still
 * mean what they say.
 */
function code(src: string): string {
  const { text, report } = stripSourceCommentsWithReport(src);
  expect(
    report.line + report.block + report.html,
    'the comment stripper removed nothing — either this file lost its headers or the '
      + 'stripper is a no-op, and both make the negative controls below vacuous',
  ).toBeGreaterThan(0);
  return text;
}

const EXT = code(readFileSync(new URL('./seqtris/shell-extension.ts', import.meta.url), 'utf8'));
const WELL = code(readFileSync(new URL('./seqtris/SeqtrisWell.svelte', import.meta.url), 'utf8'));
const DOCK = code(readFileSync(new URL('./seqtris/SeqtrisWellBody.svelte', import.meta.url), 'utf8'));
const TILE = code(readFileSync(new URL('./seqtris/SeqtrisTileBody.svelte', import.meta.url), 'utf8'));
const REVISION = code(
  readFileSync(new URL('./seqtris/seqtris-surface.svelte.ts', import.meta.url), 'utf8'),
);
const BINDER = code(
  readFileSync(new URL('../../audio/seqtris-launchpad.ts', import.meta.url), 'utf8'),
);

const SURFACES = [
  ['shared well', WELL],
  ['dock body', DOCK],
  ['lane tile', TILE],
] as const;

/** Everything between `</script>` and `<style>` — the rendered DOM, as source. */
function markupOf(svelte: string): string {
  const start = svelte.indexOf('</script>');
  const end = svelte.lastIndexOf('<style>');
  expect(start, 'the component must have a script block').toBeGreaterThan(-1);
  return svelte.slice(start + '</script>'.length, end === -1 ? undefined : end);
}

/**
 * Strip every BALANCED `{…}` Svelte expression, nesting included.
 *
 * ⚠ THE SIBLING FILES' ONE-LINE `\{[^{}]*\}` CANNOT DO THIS, and it fails
 * SILENTLY IN THE UNSAFE DIRECTION — measured on this file's first run. An
 * `onclick={() => onPick(port)}` attribute nests braces, so the non-greedy
 * class stops at the inner `}` and leaves `onPick(port)}` behind; worse, the
 * arrow's own `>` then terminates the `<[^>]*>` tag match early and the rest of
 * the tag leaks into the "literal text" as `data-testid={...}` noise. A
 * resting-text assertion built on that would be comparing against garbage, and
 * the way it fails is by reporting text that is not on the surface — which
 * makes it look like a real violation and, on a quieter markup, would have hid
 * one instead.
 */
function stripExpressions(src: string): string {
  let out = '';
  let depth = 0;
  for (const ch of src) {
    if (ch === '{') {
      depth++;
      if (depth === 1) out += ' ';
      continue;
    }
    if (ch === '}') {
      if (depth > 0) { depth--; continue; }
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** The LITERAL TEXT the body's DOM would contain — markup comments, Svelte
 *  expressions and tags removed, IN THAT ORDER. Comments go first because a
 *  markup comment can contain a `>` that would split a naive tag match part-way
 *  through and leak prose into the result (the FroggerBoardBody finding);
 *  EXPRESSIONS go second for the reason above. */
function literalTextOf(markup: string): string {
  return stripExpressions(markup.replace(/<!--[\s\S]*?-->/g, ' '))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('seqtris — the face is promoted, and the bodies carry the game', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('seqtris')).toBe(true);
    expect(migrated('seqtris')).toBe(true);
  });

  it('ranks BOTH params, gravity first — the tempo outranks the latch mode', () => {
    expect(FACE.order).toEqual(['gravity', 'quantize']);
    // Completeness: the rank must cover every declared param, which is the
    // STRICT_FACES bar. Derived from the def so a third param fails here.
    expect([...FACE.order].sort()).toEqual(seqtrisDef.params.map((p) => p.id).sort());
  });

  it('ONE band, and `pages` AGREES with `order` — nothing is padded to reach a tab rail', () => {
    expect(FACE.pages?.map((p) => [p.id, [...p.controls]])).toEqual([
      ['fall', ['gravity', 'quantize']],
    ]);
    // A page's controls must be a subset of `order` — asserted here so a
    // rename in one place fails in the module's own file first.
    for (const page of FACE.pages ?? []) {
      for (const c of page.controls) expect(FACE.order).toContain(c);
    }
  });
});

describe('seqtris — CLAIM 1: BOTH extension slots, and the LANE one carries the picture', () => {
  it('the face declares the extension that carries the well and the column', () => {
    expect(FACE.extension).toBe('seqtris');
    expect(shellExtensionIds()).toContain('seqtris');
  });

  it('⚠ the extension fills `tileBody` — the LANE picture nothing else pins', () => {
    expect(EXT).toMatch(/tileBody:\s*SeqtrisTileBody/);
    expect(EXT).toMatch(/import SeqtrisTileBody from '\.\/SeqtrisTileBody\.svelte'/);
    // …and the slot is actually RENDERED by the shell, not merely declared.
    expect(WIRED_SHELL_EXTENSION_SLOTS).toContain('tileBody');
  });

  it('and `fullViewBody` — the DOCK surface, which is the only place the game is playable', () => {
    expect(EXT).toMatch(/fullViewBody:\s*SeqtrisWellBody/);
    expect(EXT).toMatch(/import SeqtrisWellBody from '\.\/SeqtrisWellBody\.svelte'/);
    expect(WIRED_SHELL_EXTENSION_SLOTS).toContain('fullViewBody');
  });

  it('ONE well component serves both, so the two pictures cannot diverge', () => {
    for (const [name, src] of [['dock body', DOCK], ['lane tile', TILE]] as const) {
      expect(src, `${name}: must mount the shared well`)
        .toMatch(/import SeqtrisWell from '\.\/SeqtrisWell\.svelte'/);
    }
    // ⚠ AND NEITHER RE-DERIVES THE PALETTE. The engine's own comment: "ONE
    // palette for both surfaces on purpose… a second copy of these numbers is
    // how the two drift apart." Only the shared well may name it.
    expect(WELL).toMatch(/seqtrisCssColor/);
    for (const [name, src] of [['dock body', DOCK], ['lane tile', TILE]] as const) {
      expect(src, `${name}: the palette belongs to the shared well`)
        .not.toMatch(/SEQTRIS_PIECE_RGB|seqtrisCssColor/);
    }
  });

  it('the two bodies NAMESPACE their testids — they can be mounted at the same time', () => {
    // A faced module's lane tile and its open dock pane coexist; sharing a
    // testid would put two elements behind every selector in the face spec.
    expect(DOCK).toMatch(/testidPrefix="seqtris-face"/);
    expect(TILE).toMatch(/testidPrefix="seqtris-tile"/);
    expect(DOCK, 'the dock body must not claim the tile namespace')
      .not.toMatch(/testidPrefix="seqtris-tile"/);
    expect(TILE, 'the tile must not claim the face namespace')
      .not.toMatch(/testidPrefix="seqtris-face"/);
  });

  it('the SCREEN switch is DOCK-ONLY, and the tile HONOURS the same flag', () => {
    expect(DOCK, 'the dock body arms the switch').toMatch(/screenToggle/);
    expect(TILE, 'a ~192px tile has no room for it').not.toMatch(/screenToggle/);
    // One flag, two surfaces, no way for them to disagree: the tile mounts the
    // same component, which reads the same `node.data` key.
    expect(WELL).toMatch(/previewCollapsed/);
  });
});

describe('seqtris — CLAIM 2: `glyph: none` is FORCED, and that is measured', () => {
  it('there is NO primary audio output — two poly note ports and two gates', () => {
    expect(seqtrisDef.outputs.map((o) => o.type)).toEqual([
      'polyPitchGate', 'polyPitchGate', 'gate', 'gate',
    ]);
    expect(primaryAudioOutPortId(seqtrisDef)).toBeNull();
  });

  it("and the shell's own video thumbnail is out of reach — this is an AUDIO def", () => {
    expect(seqtrisDef.domain).toBe('audio');
    expect(hasVideoSurface(seqtrisDef)).toBe(false);
    // POSITIVE CONTROL: the predicate can be true, so the leg above is not
    // passing on a function that returns false for everything.
    expect(hasVideoSurface({ domain: 'video' })).toBe(true);
  });

  it('so every LIVE glyph kind resolves STATIC and is refused by the dead-glyph clause', () => {
    for (const kind of ['scope', 'meter', 'envelope', 'waveform'] as const) {
      const bound = glyphBinding({ ...seqtrisDef, face: { ...FACE, glyph: kind } });
      expect(
        bound.kind,
        `glyph '${kind}' must resolve static on a def with no type:'audio' output — if this ever `
          + 'resolves live, the `none` declaration has become a preference rather than a force',
      ).toBe('static');
    }
  });

  it('and the face declares none, so the tile picture MUST come from the module', () => {
    expect(FACE.glyph).toBe('none');
    expect(laneGlyphFor(seqtrisDef)).toBe('none');
  });

  it('⚠ `paramCells` is ABSENT, and the absence is the declaration', () => {
    // A KNOB is what the shell already resolves for both params — which is what
    // the card draws — so declaring anything here would be noise at best. There
    // is no 'knob' literal in the union to declare even if one wanted to, and
    // 'fader' would be refused by module-face-lint on a discrete param.
    expect(FACE.paramCells).toBeUndefined();
  });
});

describe('seqtris — the TIER LADDER, read back as a sentence', () => {
  it('resolves through curatedFace at every declared tier', () => {
    expect(ALL_TIERS.length, 'the ladder must cover every declared tier').toBeGreaterThan(1);
    for (const tier of ALL_TIERS) {
      expect(curatedFace(seqtrisDef, tier), `tier ${tier} must resolve a face`).not.toBeNull();
    }
  });

  it('mini shows the TEMPO alone; compact, full and dock show both', () => {
    const at = (tier: FaceTier) => curatedFace(seqtrisDef, tier)!.controls.map((c) => c.key);
    // ⚠ Derived, never read off FACE_TIER_CAPS: the raw cap is the
    // pre-reconciliation number rather than what the lane actually fits.
    expect(at('mini'), 'at one control, gravity is the one that survives').toEqual(['gravity']);
    for (const tier of ['compact', 'full', 'dock'] as const) {
      expect(at(tier), `tier ${tier}`).toEqual(['gravity', 'quantize']);
    }
  });
});

describe('seqtris — CLAIM 3: the WELL IS DOM, and converting it would delete the seams', () => {
  it('NO SURFACE MOUNTS A CANVAS — the DPR blit hazard is structurally absent', () => {
    for (const [name, src] of SURFACES) {
      expect(src, `${name}: the well is a CSS grid of 64 spans, not a drawing surface`)
        .not.toMatch(/<canvas|getContext\(/);
    }
    // ⚠ AND NO COPIED INCANTATION EITHER. modtris needs `image-rendering:
    // pixelated` because it IS a bitmap; on DOM cells it is inert.
    expect(WELL).not.toMatch(/image-rendering/);
  });

  it('all 64 cells are rendered, keyed by ROW and COL, each carrying `data-piece`', () => {
    // The loop is what produces them, so the loop is what is pinned: a grid
    // that stopped nesting would render 8 cells and every count assertion
    // downstream would still be about "cells".
    expect(WELL).toMatch(/\{#each ROWS as row/);
    expect(WELL).toMatch(/\{#each COLS as col/);
    expect(WELL).toMatch(/data-testid=\{`\$\{testidPrefix\}-cell-\$\{row\}-\$\{col\}`\}/);
    expect(
      WELL,
      'data-piece is the ONLY machine-readable read of the board that is not a page.evaluate '
        + 'into engine internals — deleting it would make the e2e assert on colours',
    ).toMatch(/data-piece=\{cell \?\? ''\}/);
    // The dimensions come from the engine, never re-typed as 8.
    expect(WELL).toMatch(/SEQTRIS_ROWS/);
    expect(WELL).toMatch(/SEQTRIS_COLS/);
    expect(SEQTRIS_ROWS * SEQTRIS_COLS).toBe(64);
  });

  it('the size lands on the CONTAINER, and the cells stay `1fr`', () => {
    // A per-cell pixel size accumulates rounding into a ninth column; `1fr`
    // columns under one sized box divide it exactly.
    expect(WELL).toMatch(/--well-px/);
    expect(WELL).toMatch(/grid-template-columns:\s*repeat\(8, 1fr\)/);
    expect(WELL).toMatch(/aspect-ratio:\s*1 \/ 1/);
  });

  it('the 64-null fallback survives — the pre-attach frame renders an EMPTY well', () => {
    // Load-bearing for VRT: without it the frame before the engine handle
    // appears throws instead of painting an empty board.
    expect(WELL).toMatch(/snap\?\.board \?\? Array\.from\(/);
  });
});

describe('seqtris — CLAIM 4: the bodies SUBSCRIBE, and must never grow an rAF loop', () => {
  // ⚠ THE SHARPEST DIVERGENCE FROM THE TWO SIBLINGS, and the one a future
  // author is most likely to "fix" by copying them. `ModtrisWellBody` and
  // `SkifreeScreen` poll because their modules expose no listener seam. THIS
  // one pushes: `changed()` fires a listener set on every state change.
  it('the factory really does PUSH — the premise, read from the def rather than remembered', () => {
    const defSrc = code(
      readFileSync(new URL('../../audio/modules/seqtris.ts', import.meta.url), 'utf8'),
    );
    expect(defSrc).toMatch(/const listeners = new Set<\(\) => void>\(\)/);
    expect(defSrc).toMatch(/subscribe: \(fn\) => \{/);
    expect(defSrc, 'changed() is what makes a subscription sufficient').toMatch(/for \(const fn of listeners\)/);
  });

  it('NO SURFACE RUNS requestAnimationFrame', () => {
    for (const [name, src] of SURFACES) {
      expect(
        src,
        `${name}: an rAF poll would re-read a board that moves at most once per clock pulse, and `
          + 'would make an IDLE, UNCLOCKED seqtris — the resting state a VRT scene captures — do '
          + 'work forever. The module pushes; subscribe.',
      ).not.toMatch(/requestAnimationFrame/);
    }
  });

  it('the subscription is IDEMPOTENT and torn down on destroy', () => {
    expect(WELL, 'a second attach while subscribed must be a no-op')
      .toMatch(/if \(unsubscribe\) return true;/);
    expect(WELL, 'a body unmounts on every dock collapse and LRU eviction')
      .toMatch(/onDestroy\(/);
    expect(WELL).toMatch(/unsubscribe\?\.\(\);/);
  });

  it('⚠ and the attach retry SELF-CANCELS — a readiness wait, not a render loop', () => {
    // The engine handle can appear with NO node write behind it (the node lands
    // in the Y.Doc first, the reconciler builds the handle after), so the node
    // version alone cannot be the only driver. The backstop is one scheduler
    // subscriber that removes itself the moment attach succeeds.
    expect(WELL).toMatch(/getSchedulerClock\(\)\.subscribe\(/);
    expect(WELL, 'an attached body must cost ZERO ticks')
      .toMatch(/if \(attach\(\)\) stopRetry\(\);/);
  });
});

describe('seqtris — CLAIM 5: the SCENE COLUMN is the imported roster, in order', () => {
  // ⚠ The column is TOP-ORIGIN and the codebase has two disagreeing row
  // conventions. The binder's header records it: `decodeMidiMessage` hands back
  // `ev.row` from the BOTTOM while `SCENE_CCS` is written TOP-first, and
  // "reading `ev.row` instead would invert the whole controller and every
  // button would still 'work'". Indexing the export inherits the right one.
  it('the roster is EIGHT entries with the two dead buttons at 1 and 2', () => {
    expect(SEQTRIS_SCENE_ACTIONS.length).toBe(8);
    expect([...SEQTRIS_SCENE_ACTIONS]).toEqual([
      'reset', null, null, 'drop', 'rotateLeft', 'rotateRight', 'moveLeft', 'moveRight',
    ]);
    // The binder is where the convention is decided; asserting it is imported
    // rather than re-derived is the whole of this claim.
    expect(BINDER).toMatch(/export const SEQTRIS_SCENE_ACTIONS/);
  });

  it('the dock body ITERATES that export and never re-types the list', () => {
    expect(DOCK).toMatch(/import \{[\s\S]*?SEQTRIS_SCENE_ACTIONS[\s\S]*?\} from '\$lib\/audio\/seqtris-launchpad'/);
    expect(DOCK).toMatch(/\{#each SEQTRIS_SCENE_ACTIONS as action, i \(i\)\}/);
    // ⚠ A SECOND COPY IS HOW THE SCREEN AND THE HARDWARE DRIFT. A literal
    // array of the six action names in this file would be exactly that.
    for (const action of ['rotateLeft', 'rotateRight', 'moveLeft', 'moveRight']) {
      expect(
        DOCK.includes(`'${action}'`),
        `${action} must not be re-typed as a literal — index the imported roster`,
      ).toBe(false);
    }
  });

  it('⚠ THE DEAD BUTTONS ARE RENDERED, IN POSITION, aria-hidden', () => {
    // Tidying them out would slide the six live captions up two rows and the
    // screen would teach the WRONG mapping — and nothing in CI would notice.
    expect(DOCK).toMatch(/\{#if action === null\}/);
    expect(DOCK).toMatch(/<span class="scene dead" aria-hidden="true"><\/span>/);
    expect(DOCK, 'eight rows, always').toMatch(/grid-template-rows:\s*repeat\(8, 1fr\)/);
  });

  it('a press INDEXES the roster rather than mapping a caption back to an action', () => {
    expect(DOCK).toMatch(/const action = SEQTRIS_SCENE_ACTIONS\[index\];/);
    expect(DOCK).toMatch(/api\(\)\?\.press\(action\);/);
  });

  it('⚠ NO SURFACE CALLS `release()` — that is the node\'s death, not a component\'s', () => {
    // #1728, refused by name in the binder's own header: `release()` is called
    // from the factory's `dispose`. `unbind()` is a USER GESTURE and lives on
    // the dock body only.
    for (const [name, src] of SURFACES) {
      expect(src, `${name}: a lifecycle hook must never hand the hardware back`)
        .not.toMatch(/\.release\(\)/);
    }
    expect(DOCK, 'the user gesture is the sanctioned one').toMatch(/api\(\)\?\.unbindPort\(\);/);
    expect(TILE, 'the tile has no gestures at all').not.toMatch(/unbindPort|bindPort|\.connect\(/);
  });

  it('⚠ CONNECT has NO `await` above it — the user-activation constraint, verbatim', () => {
    // "An await above requestMIDIAccess spends the user activation and Chromium
    // refuses to prompt." The handler must be synchronous down to `connect()`.
    expect(DOCK).toMatch(/function onConnect\(\): void \{/);
    expect(DOCK).toMatch(/void api\(\)\?\.connect\(\)\.then\(/);
    const fn = DOCK.slice(DOCK.indexOf('function onConnect('), DOCK.indexOf('function onPick('));
    expect(fn, 'an async onConnect would spend the activation before the request')
      .not.toMatch(/await/);
  });

  it('the port picker is keyed by INDEX, not name — the Windows dual-port finding', () => {
    // Windows reports IDENTICAL port names for a Launchpad's two ports, so a
    // name-keyed testid would collide and the e2e would drive whichever the
    // locator happened to resolve.
    expect(DOCK).toMatch(/data-testid=\{`seqtris-face-port-\$\{i\}`\}/);
    expect(DOCK).not.toMatch(/seqtris-face-port-\$\{port\.name\}/);
  });
});

describe('seqtris — CLAIM 6: the `revision` seam survived, and it is SHARED', () => {
  // ⚠ OMIT IT AND THE STATUS, THE LAMP AND THE CONNECT/UNBIND SWAP FREEZE.
  // `launchpadStatus()` walks a per-binding closure that nothing invalidates,
  // and no gate in the tree reads any of the three.
  // ⚠ 'the card had one, and it was component-scope' STOOD HERE, reading the
  // card's own `let revision = $state(0); void revision;` pair. It was the
  // PREMISE for the seam below: the card's tick was component-scoped, so two
  // surfaces each had their own and could disagree about when the well had
  // changed. The premise is history; the seam it argued for is asserted below
  // as a MODULE-scope tick that both surviving bodies subscribe to.

  it('the face has one too, and it is MODULE-scope so two surfaces cannot disagree', () => {
    expect(REVISION).toMatch(/let revision = \$state\(0\);/);
    expect(REVISION).toMatch(/export function seqtrisRevision\(\): number/);
    expect(REVISION).toMatch(/export function bumpSeqtrisRevision\(\): void/);
    // BOTH bodies subscribe to it — the tile's lamp is the half that would
    // otherwise sit frozen at whatever it read on mount.
    for (const [name, src] of [['dock body', DOCK], ['lane tile', TILE]] as const) {
      expect(src, `${name}: must read the shared tick`).toMatch(/void seqtrisRevision\(\);/);
    }
  });

  it('EVERY dock gesture bumps it — connect, pick, unbind and press', () => {
    for (const fn of ['onConnect', 'onPick', 'onUnbind', 'onControl']) {
      const start = DOCK.indexOf(`function ${fn}(`);
      expect(start, `${fn} must exist`).toBeGreaterThan(-1);
      const body = DOCK.slice(start, DOCK.indexOf('\n  }', start));
      expect(body, `${fn} must invalidate the non-reactive status read`)
        .toMatch(/bumpSeqtrisRevision\(\)/);
    }
  });

  it('⚠ and the node reads go through `nodeVersion` — `patch.nodes[id]` is NOT reactive', () => {
    // Measured on recorderbox: `node-versions.svelte.ts` maintains the per-node
    // signal and `nodeVersion(id)` is how a surface subscribes. ⚠ AND THE
    // DERIVED MUST RETURN THE LEAF: the SyncedStore proxy has a stable
    // identity, so a derived recomputing to "the same proxy" is value-equal and
    // Svelte never notifies its dependents.
    for (const [name, src] of [['shared well', WELL], ['dock body', DOCK], ['lane tile', TILE]] as const) {
      expect(src, `${name}: a bare patch.nodes read never re-runs`)
        .toMatch(/nodeVersion\(nodeId\)/);
    }
  });

  it('SCREEN state lives on node.data, never in the component (#1531/#1574/#1583)', () => {
    expect(WELL).toMatch(/data\?\.previewCollapsed/);
    expect(WELL).toMatch(/mutateNode\(/);
    // A `$state` here dies with the component, and this component unmounts on
    // dock collapse / LRU eviction.
    expect(WELL).not.toMatch(/let previewCollapsed = \$state/);
    // ⚠ ONE WRITE PER CLICK, NEVER PER FRAME — the board never touches the
    // graph store at all, which is the write-storm rule satisfied by
    // construction rather than by care.
    const toggle = WELL.slice(WELL.indexOf('function togglePreview('));
    expect(toggle.slice(0, 300)).toMatch(/mutateNode\(nodeId, \(live\) => \{/);
  });

  it('⚠ the `role="img"` frame is OUTSIDE the collapse guard — the name survives SCREEN OFF', () => {
    const frameAt = WELL.indexOf('role="img"');
    const guardAt = WELL.indexOf('{#if !previewCollapsed}');
    expect(frameAt, 'the frame must exist').toBeGreaterThan(-1);
    expect(guardAt, 'the guard must exist').toBeGreaterThan(-1);
    expect(
      frameAt,
      'the frame must render UNCONDITIONALLY and only the GRID may sit inside the guard, so a '
        + 'screen reader still tracks the board with the picture off. (FroggerBoardBody puts the '
        + 'frame INSIDE its guard, which makes its own comment\'s claim false there — another '
        + "module's file, reported rather than fixed here.)",
    ).toBeLessThan(guardAt);
  });
});

describe('seqtris — CLAIM 7: no resting numbers, and the status PARAGRAPH is gone', () => {
  it('the surfaces paint CAPTIONS and OPTION NAMES only', () => {
    const dockText = literalTextOf(markupOf(DOCK));
    expect(
      dockText,
      'the only literal text on the dock body may be the two bind-row button captions — every '
        + 'scene caption and every port name is an interpolation, and the status SENTENCE is on '
        + "the lamp's aria-label rather than in a text node",
    ).toBe('Unbind Connect Launchpad');
    // The tile paints nothing at all beyond its lamp's static caption.
    expect(literalTextOf(markupOf(TILE))).toBe('');
    // The shared well paints only its own switch caption.
    expect(literalTextOf(markupOf(WELL))).toBe('SCREEN');
  });

  it('NEGATIVE CONTROL: the extractor CAN see a counter row if one comes back', () => {
    const withRow = markupOf(DOCK).replace(
      '<div class="bind-row">',
      '<span>LINES 4</span><span>· game overs 1</span><div class="bind-row">',
    );
    const text = literalTextOf(withRow);
    expect(text).toContain('LINES 4');
    expect(text).toContain('game overs 1');
    expect(text).not.toBe('Unbind Connect Launchpad');
  });

  it('⚠ NO COUNTER REACHES ANY SURFACE, though the snapshot exposes eight', () => {
    // The card's own header: "No timers, no counters, no live numbers on the
    // plate." The face adds none back.
    for (const field of [
      'totalLines', 'gameOvers', 'notesFired', 'spawns', 'lineFires', 'tiedDrops', 'clockPulses',
    ]) {
      for (const [name, src] of SURFACES) {
        expect(src.includes(field), `${name} must not read snapshot.${field}`).toBe(false);
      }
    }
  });

  it('the face paints NO status paragraph', () => {
    // ⚠ THE PREMISE HALF READ THE CARD. The card DID paint the sentence as a
    // resting text node (`<p class="status">`), which is what made "the face
    // does NOT" a disposal rather than an omission. The disposal is what still
    // has a subject, and the leg below is where the sentence actually went —
    // StatusLed's `detail`, speakable rather than painted.
    expect(DOCK, 'the face must not re-create it').not.toMatch(/class="status"/);
    expect(TILE, 'nor may the lane tile').not.toMatch(/class="status"/);
  });

  it('⚠ BUT ALL SIX STRINGS SURVIVE VERBATIM — on the lamp, not in the DOM', () => {
    // The pure function is untouched, so `seqtris-launchpad.test.ts` still pins
    // every string; what changed is only where they land.
    expect(BINDER).toMatch(/export function seqtrisStatusMessage\(/);
    for (const [name, src] of [['dock body', DOCK], ['lane tile', TILE]] as const) {
      expect(src, `${name}: the sentence rides StatusLed's detail`)
        .toMatch(/detail=\{status\?\.message \?\? /);
      expect(src, `${name}: and the lamp is the primitive, never a Readout`)
        .toMatch(/import \{ StatusLed \} from '\$lib\/ui\/controls'/);
    }
    // ⚠ AND NOT RE-TYPED. A body that spelled a status string itself would
    // drift from the unit-tested function silently.
    for (const [name, src] of SURFACES) {
      expect(src.includes('Not connected.'), `${name} must not re-type the idle string`).toBe(false);
      expect(src.includes('No Launchpad found'), `${name} must not re-type the no-device string`)
        .toBe(false);
    }
  });

  it('⚠ the SPEAKABLE scene name is NOT also PAINTED — the control-grid leg, at the source', () => {
    // The button paints `CONTROL_LABELS[action]` (a control caption, permitted)
    // and speaks `sceneName(i, action)` (the row number a caption cannot
    // carry). Two structurally different expressions.
    expect(DOCK).toMatch(/aria-label=\{sceneName\(i, action\)\}/);
    expect(
      DOCK,
      'binding the accessible name AND rendering the same expression as a text node is the '
        + "resting-text violation wearing the ruling's own mechanism as a disguise",
    ).not.toMatch(/>\s*\{sceneName\(/);
    expect(DOCK).toMatch(/\{CONTROL_LABELS\[action\]\}/);
  });
});

/** `n` clock pulses from a fresh state, returning the resulting state. The
 *  engine is pure, so the input is never mutated. */
function pulseTimes(from: SeqtrisState, n: number): SeqtrisState {
  let s = from;
  for (let i = 0; i < n; i++) s = clockPulse(s).state;
  return s;
}

// ────────────────────────────────────────────────────────────────────────────

const STATUS_LED = readFileSync(
  new URL('../controls/StatusLed.svelte', import.meta.url),
  'utf8',
);

describe("seqtris — CLAIM 7b: a FAULT is VISIBLE, not just speakable", () => {
  // ⚠ THE HOLE THIS CLOSES SHIPPED ONCE ALREADY ON THIS BRANCH, and nothing in
  // the tree could see it. The card signalled `no-device` / `claimed` /
  // `unsupported` THREE ways at once — the paragraph's TEXT changed, it took
  // `.status.problem` colouring, and it took `role="alert"`. The promotion
  // deletes the paragraph (correctly: a sentence of derived service state
  // painted at rest is none of the four permitted roles) and compensates with
  // `tone="warn"` on the lamp. But `tone` is COLOUR ON A LIT LAMP ONLY, and the
  // first version of this body passed `lit={bound}` — mutually exclusive with
  // `problem` — so the warn tone could NEVER render and a denied grant left the
  // plate pixel-identical to idle: a dark lamp and a CONNECT button that looked
  // like it did nothing.
  //
  // The three shipped fault lamps all pair `warn` with a `lit` that is TRUE
  // EXACTLY WHEN THE FAULT HOLDS (`audioIn` FAULT, `es9` XRUN, `midiOutBuddy`
  // LANE). This claim pins that pairing here, at the mechanism rather than at
  // the call site's good intentions.
  it('the MECHANISM: every tone rule in StatusLed is gated on `.lit`', () => {
    // The premise, read rather than remembered — this is WHY `lit` has to
    // include `problem`. If StatusLed ever tints an UNLIT lamp, this leg goes
    // red and the pairing below stops being load-bearing.
    const warnRules = [...STATUS_LED.matchAll(/^\s*(\.status-led[^{]*\.warn[^{]*)\{/gm)]
      .map((m) => m[1]!.trim());
    expect(warnRules.length, 'the tone must have rules at all, or this claim is vacuous')
      .toBeGreaterThan(0);
    for (const rule of warnRules) {
      expect(rule, `\`${rule}\` tints without requiring .lit — the pairing below is now stale`)
        .toContain('.lit');
    }
  });

  it('`bound` and `problem` are DISJOINT, so `lit={bound}` would make `warn` unreachable', () => {
    // Both predicates are derived from the same six-kind union. `bound` is one
    // kind; `problem` is three others. There is no state in which a
    // `lit={bound}` lamp is lit AND `tone` is `warn`.
    const kinds = ['unsupported', 'idle', 'listing', 'no-device', 'claimed', 'bound'] as const;
    const isBound = (k: string): boolean => k === 'bound';
    const isProblem = (k: string): boolean =>
      k === 'no-device' || k === 'claimed' || k === 'unsupported';
    expect(kinds.filter((k) => isBound(k) && isProblem(k)), 'the two must not overlap')
      .toEqual([]);
    expect(kinds.filter(isProblem).length, 'and a fault must be REACHABLE, or nothing is at stake')
      .toBe(3);
  });

  it('⚠ BOTH surfaces light the lamp on a PROBLEM, and pass the warn tone with it', () => {
    for (const [name, src] of [['dock body', DOCK], ['lane tile', TILE]] as const) {
      expect(
        src,
        `${name}: \`lit\` must include \`problem\` — with \`lit={bound}\` the warn tone is dead `
          + 'CSS and a denied grant is INVISIBLE (dark lamp, unchanged caption, a CONNECT button '
          + 'that looks like it did nothing)',
      ).toMatch(/lit=\{bound \|\| problem\}/);
      expect(src, `${name}: and the tone must ride with it`)
        .toMatch(/tone=\{problem \? 'warn' : 'accent'\}/);
    }
  });

  it('the two surfaces carry the IDENTICAL expression — they cannot disagree', () => {
    // A lane tile and an open dock pane are mounted at once on the same node.
    // One lit amber beside one dark is two surfaces disagreeing about one
    // hardware claim, which is the failure the page-wide revision tick exists
    // to prevent — so the expressions are compared, not just each matched.
    const litOf = (src: string): string | null => /lit=\{([^}]*)\}/.exec(src)?.[1]?.trim() ?? null;
    const toneOf = (src: string): string | null =>
      /tone=\{([^}]*)\}/.exec(src)?.[1]?.trim() ?? null;
    expect(litOf(DOCK)).toBe(litOf(TILE));
    expect(toneOf(DOCK)).toBe(toneOf(TILE));
    expect(litOf(DOCK), 'vacuity control: the extractor really found an expression').toBeTruthy();
  });

  it('NEGATIVE CONTROL: the matcher REJECTS the readiness-only shape it replaced', () => {
    // Driven against the exact source this branch shipped first, so the legs
    // above are not passing on a regex nobody has watched fail.
    const before = DOCK.replace('lit={bound || problem}', 'lit={bound}');
    expect(before, 'VACUITY GUARD: the substitution must have actually changed the source, or '
      + 'this control is comparing a string with itself').not.toBe(DOCK);
    expect(before).not.toMatch(/lit=\{bound \|\| problem\}/);
    expect(before, 'the substitution must have actually landed').toMatch(/lit=\{bound\}/);
  });
});

describe('seqtris — CLAIM 8: the VRT determinism argument, DERIVED', () => {
  // ⚠ `_shell-faces.ts` carries NO `simPin` for this module. That absence is
  // only honest if the board really is time-invariant at rest, so it is
  // measured here rather than argued in the roster's prose.
  it('the bag is seeded from a FIXED constant — there is no Math.random to pin', () => {
    const engineSrc = readFileSync(
      new URL('../../audio/modules/seqtris-engine.ts', import.meta.url),
      'utf8',
    );
    expect(
      code(engineSrc),
      'a single Math.random in the engine would make the seed argument false and the missing '
        + 'simPin a real gap',
    ).not.toMatch(/Math\.random/);
    expect(SEQTRIS_DEFAULT_SEED).toBe(0x5e9721);
  });

  it('the resting board is the SAME board every time, from the default seed', () => {
    const a = renderBoard(createSeqtrisState({ baseDivisor: 8 }));
    const b = renderBoard(createSeqtrisState({ baseDivisor: 8 }));
    expect([...a]).toEqual([...b]);
    // The first piece is whatever the seeded bag yields — DERIVED, never
    // hard-coded, so a change to the shuffle shows up as a red test here rather
    // than as a mystery baseline diff on CI.
    const { bag } = shuffledBag(SEQTRIS_DEFAULT_SEED);
    const first = bag[0]!;
    const filled = [...a]
      .map((cell, i) => (cell === null ? null : i))
      .filter((i): i is number => i !== null);
    expect(filled.length, 'a fresh spawn must put SOME piece at the top of an empty well')
      .toBeGreaterThan(0);
    for (const i of filled) {
      expect(a[i], 'only the spawned piece may be on a fresh board').toBe(first);
      expect(Math.floor(i / SEQTRIS_COLS), 'a fresh spawn sits in the top rows')
        .toBeLessThan(3);
    }
    // …and nothing below the spawn rows is filled, which is what "empty well"
    // means for a baseline.
    for (let row = 3; row < SEQTRIS_ROWS; row++) {
      for (let col = 0; col < SEQTRIS_COLS; col++) {
        expect(a[cellIndex(row, col)], `row ${row} col ${col} must be empty at rest`).toBeNull();
      }
    }
  });

  it('⚠ AND THE BOARD ONLY MOVES ON A CLOCK EDGE — time alone changes nothing', () => {
    // `tick()` returns early on `edges <= 0`, so a VRT scene that patches
    // nothing into `clock` captures the same frame however slow the runner is.
    // This is the half modtris' `__modtrisVrtTicks` had to buy and seqtris gets
    // for free.
    const state = createSeqtrisState({ baseDivisor: 8 });
    const before = [...renderBoard(state)];

    // ⚠ ONE PULSE IS NOT ONE ROW, and getting that wrong is how this leg first
    // failed. GRAVITY IS A CLOCK DIVISOR: the piece falls one row every
    // `state.divisor` pulses, so a single `clockPulse` leaves the board
    // IDENTICAL at the default of 8. That is worth pinning rather than merely
    // working around — it means a VRT capture is stable across the first seven
    // pulses too, not only across zero of them.
    expect(state.divisor, 'the default ladder starts at 8 pulses per row').toBe(8);
    for (let i = 1; i < state.divisor; i++) {
      const partial = [...renderBoard(pulseTimes(state, i))];
      expect(partial, `after ${i} of ${state.divisor} pulses the piece must not have moved`)
        .toEqual(before);
    }

    // …and at the divisor'th it DOES move — the positive control, so the legs
    // above are not passing on a board that can never change at all.
    const after = [...renderBoard(pulseTimes(state, state.divisor))];
    expect(after, 'a full gravity step must move the piece, or this claim is vacuous')
      .not.toEqual(before);

    // …and the untouched state is unchanged, because the engine is pure.
    expect([...renderBoard(state)]).toEqual(before);
  });
});
