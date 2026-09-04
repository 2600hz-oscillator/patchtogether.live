// packages/web/src/lib/ui/modules/painter-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the PAINTER faceplate.
//
// Everything here is a claim the shipped face MAKES and that no other gate in
// the tree can check. What is specific to this module:
//
//   1. ⚠ THE BODY IS THE WHOLE MODULE, NOT A PREVIEW BESIDE ONE. `params: []`
//      and `inputs: []`, so `face.order` is empty and the faceplate has ZERO
//      bands. `module-face-lint`'s empty-lane clause SKIPS the ranks-nothing
//      shape — correctly, and that means nothing else asserts painter's lane
//      still paints. This file does.
//
//   2. ⚠ THE `$effect`-KEYED-ON-THE-ELEMENT SETUP. The SCREEN guard destroys
//      and recreates the canvas, and `onMount` does not re-run — so a body that
//      set up in `onMount` would come back from a SCREEN cycle with a detached
//      2-D context and a stale engine binding: a blank editor, strokes into
//      nowhere, and ops still committing. It looks exactly like a working
//      editor to the shared face-screen-render suite, which asserts the canvas
//      RETURNS and not that it works.
//
//   3. ⚠ THE LEASE HANDSHAKE. `setPaintCanvas(null)` reads as correct cleanup
//      and IS the #1720 bug (the node drops to a blank white page). Handing the
//      binding back is `release()`. Pinned on both surfaces in
//      `painter/paint-surface.test.ts`; what is pinned HERE is that the body
//      claims at all, so the live-stroke property exists.
//
//   4. THE GLYPH DECISION IS FORCED and is asserted so a later "let's give it a
//      scope" edit fails here with the reason rather than in a lint with a
//      message about `{ kind: 'static' }`.
//
//   5. NO `face.monitor`, and the refusal is the interesting half — see below.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { painterDef } from '$lib/video/modules/painter';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

const def = painterDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const bodySource = read('painter/PainterEditorBody.svelte');
const extSource = read('painter/shell-extension.ts');

// The code-only views. A raw grep cannot tell code from a comment, and several
// legs below forbid a construct whose natural explanation NAMES it.
const bodyCode = stripSourceComments(bodySource);

const LANE_TIERS = ['mini', 'compact', 'full'] as const;

describe('painter face — promoted, and the module is still reachable', () => {
  it('is promoted, with a face', () => {
    expect(STRICT_FACES.has('painter')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it('RANKS NOTHING, because it HAS nothing — the flipper shape', () => {
    // ⚠ THE EXCLUSION MUST STAY A JUDGEMENT ABOUT THE MODULE. `module-face-lint`
    // skips its empty-lane clause for a face whose `order` is empty, so an
    // `order: []` on a def that DID declare params would silently buy a pass.
    // Asserting the emptiness of `params` beside the emptiness of `order` is
    // what makes this face's shape honest rather than convenient.
    expect(def.face?.order ?? [], 'painter ranks nothing').toEqual([]);
    expect((painterDef.params ?? []).length, 'painter declares no params at all').toBe(0);
    expect(painterDef.inputs.length, 'painter takes no input').toBe(0);
    for (const tier of LANE_TIERS) {
      expect(
        curatedFace(def, tier)?.controls.length ?? 0,
        `lane tier '${tier}' resolves no controls`,
      ).toBe(0);
    }
    expect(curatedFace(def, 'dock')?.controls.length ?? 0, 'and neither does the dock').toBe(0);
  });

  it('THE LANE STILL PAINTS — the tile picture is the drawing', () => {
    // With zero controls at every lane tier, `hasVideoSurface` is the ONLY
    // thing standing between a promoted painter and a blank tile. It is
    // `domain === 'video'` and nothing else, so this is what the lane depends
    // on and it is one field away from being lost.
    expect(hasVideoSurface(painterDef as never), 'the lane tile gets a VideoTileThumb').toBe(true);
    expect(painterDef.domain).toBe('video');
  });

  it('declares glyph `none`, which is MECHANICALLY FORCED here', () => {
    // One output and it is `video`, so `primaryAudioOutPortId` is null and
    // every other literal falls through `glyphBinding` to `{ kind: 'static' }`
    // — the dead squiggle the dead-glyph clause refuses. Asserted so a later
    // "give it a scope" edit fails with the reason.
    expect(def.face?.glyph).toBe('none');
    expect(painterDef.outputs.map((o) => o.type)).toEqual(['video']);
  });

  it('declares the extension, and the extension exports the fullViewBody slot', () => {
    expect(def.face?.extension).toBe('painter');
    expect(extSource).toMatch(/fullViewBody:\s*PainterEditorBody/);
    expect(extSource, 'no other slot — editorSurface is UNWIRED').not.toMatch(/editorSurface/);
  });

  it('declares NO `face.monitor`, and the refusal is the point', () => {
    // ⚠ MONITOR MODE HIDES THE BANDS. This face has none — `order` is empty —
    // so a `monitor` declaration would ship a switch that hides nothing while
    // costing `face-monitor-source` a `hideControls` read/write in the body.
    // The affordance it would seem to offer (a bigger canvas, less chrome) is
    // what SCREEN's sibling would be, and no painter surface has ever had it —
    // so the INVERSE leg of that gate does not arm either. (The card was the
    // other surface checked here; it never mounted `hideControls` and is gone.)
    expect(def.face?.monitor, 'a monitor over zero bands hides nothing').toBeUndefined();
    expect(bodyCode, 'the body must not grow hideControls silently').not.toContain('hideControls');
  });
});

describe('painter face body — the claims no registry gate can check', () => {
  it('SETS UP IN AN `$effect` KEYED ON THE ELEMENT, NEVER IN `onMount`', () => {
    // ⚠ THE HIGHEST-VALUE LEG IN THIS FILE. The SCREEN guard remounts the
    // canvas; `onMount` runs once. A body that set up there would return from a
    // SCREEN cycle holding a 2-D context on a DETACHED element and an engine
    // binding pointed at it — the editor paints nothing, the ops still commit,
    // and the shared face-screen-render suite passes because the canvas is back
    // in the DOM.
    expect(bodyCode, 'the body must not use onMount at all').not.toMatch(/\bonMount\b/);
    // …and the effect must actually key on the element, not on the node id.
    expect(bodyCode).toMatch(/\$effect\(\(\) => \{\s*const el = canvasEl;/);
    expect(bodyCode, 'the context is taken from THAT element').toMatch(/el\.getContext\('2d'\)/);
  });

  it('CLAIMS the extras binding while its canvas exists, and RELEASES it', () => {
    // The live-stroke property: an in-progress stroke must reach OUT before the
    // op commits, which requires THIS canvas to be the bound one. The release
    // is what hands the node back to the #1720 producer.
    expect(bodyCode).toMatch(/nodeExtras\.claim\(nodeId, leaseHolder\)/);
    expect(bodyCode).toMatch(/extrasLease\?\.release\(\)/);
  });

  it('CARRIES THE TYPED ENTRY IN ITS OWN FILE', () => {
    // ⚠ NOT A STYLE CHOICE. `face-migration-inventory`'s typed-entry leg reads
    // the DIRECTLY-NAMED fullViewBody source, so the stamp field moved into an
    // imported child would read as "the face carries none" and redden the
    // promotion — with the affordance present and working.
    expect(bodySource).toMatch(/type="text"/);
  });

  it('the SCREEN switch reads AND writes the shared key, and survives its own OFF', () => {
    expect(bodyCode).toContain('previewCollapsed');
    expect(bodyCode, 'it must be able to toggle, not only read')
      .toMatch(/\.data\.previewCollapsed\s*=/);
    // ⚠ THE BUTTON IS OUTSIDE THE COLLAPSE. This is what makes the Y.Doc-synced
    // collapse self-undoing: painter's canvas is its only input device, so a
    // peer flipping SCREEN OFF collapses it for everyone — and any peer must be
    // able to bring it back. Asserted structurally: the collapse guard closes
    // before the toggle's markup begins.
    //
    // ⚠ `lastIndexOf`, NOT `indexOf`. The toolbar nests a second `{#if}` (the
    // tool-gated stamp field), so the FIRST `{/if}` in the file is the inner
    // one — an `indexOf` here would still pass while proving something much
    // weaker than it claims. The collapse guard is the OUTERMOST block, so its
    // close is the last one in the markup.
    const guardEnd = bodyCode.lastIndexOf('{/if}');
    const toggleAt = bodyCode.indexOf('painter-face-screen-toggle');
    expect(guardEnd, 'the collapse guard exists').toBeGreaterThan(0);
    expect(toggleAt, 'the SCREEN toggle exists').toBeGreaterThan(0);
    expect(toggleAt, 'the SCREEN toggle renders OUTSIDE {#if !previewCollapsed}')
      .toBeGreaterThan(guardEnd);
  });

  it('RENEWS THE WATCH MARK, in BOTH screen states', () => {
    // painter is texture-only, so `computePullActiveSet` can skip it outright,
    // and `setCardVisibility(false)` on a lane tile scrolled out from under an
    // open dock DEMOTES the mark. Without this the strokes a player is making
    // would sit on this canvas and never reach OUT.
    expect(bodyCode).toContain('markWatched');
    // The call must not sit inside a `previewCollapsed` branch — the whole
    // point is that it survives OFF. There is no branch at all here.
    expect(bodyCode).toMatch(/function tick\(\): void \{[\s\S]*?markWatched/);
  });

  it('paints NO `control-` testid — this def has ZERO params', () => {
    // `faces-parity` asserts EXACT multiset equality between the `control-*`
    // testids on the faceplate and the def's params, which is `[]`. Any
    // `control-` prefixed testid in this body reddens that with a message about
    // a param that does not exist.
    expect(bodySource).not.toMatch(/data-testid="control-/);
    expect(bodySource).not.toMatch(/data-testid=\{`control-/);
  });

  it('MOUNTS NO GL CONTEXT — attest-basis membership is derived from CONTENT', () => {
    // `resolveWebglBasis()` step (2) sweeps `lib/ui/modules/**/*.svelte` by
    // content. A `getContext('webgl')` here would enrol this file permanently
    // and put every future face edit on the real-GPU attest critical path.
    expect(bodyCode).not.toMatch(/getContext\(\s*['"]webgl/);
    expect(bodyCode).not.toMatch(/WebGL2RenderingContext/);
  });
});
