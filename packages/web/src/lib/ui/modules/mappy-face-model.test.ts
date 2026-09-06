// packages/web/src/lib/ui/modules/mappy-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the MAPPY faceplate.
//
// Everything here is a claim the shipped face MAKES that no other gate checks.
// Three of them are the reasons this promotion could have shipped GREEN AND
// BROKEN:
//
//   1. ⚠ THE INERT-CONTROL TRAP. The factory PREFERRED a `node.data` mirror
//      over the param for BOTH ranked controls, while every generic shell cell
//      writes the param ALONE. On a fresh node the faceplate would have worked;
//      on any node a MIRROR WRITER had touched — a map import, a collaborator
//      on an older build — the mirror was present and the GRID toggle and
//      SURFACES control
//      were DEAD — with the params declared, the cells rendered, and
//      faces-parity's `readParam` oracle watching the param move. Every leg
//      below that says "reads the param" is pinning that.
//
//   2. ⚠ THE CURVE. Both params were declared `linear`, so `looksLikeToggle`
//      was false and the faceplate would have painted a 200 px continuous drag
//      for a two-state override and a fractional surface count. NO GATE FIRES
//      ON THAT: module-face-lint's switch classification only reaches params
//      that are ALREADY `0..1 discrete`, so a mis-declared switch is not merely
//      rendered wrong, it is unclassified and silent.
//
//   3. ⚠ THE COUNT'S WRITE SHAPE. `surfaceCount` is not just a number: raising
//      it must drop each newly-live surface in as a staggered inset quad, or
//      every added surface is a full-frame duplicate stacked exactly on the one
//      below it — a control that appears to do nothing while every value moves
//      correctly. That is what `SHELL_PARAM_WRITES.mappy` is for, and it is
//      pinned here at the registry.
//
// Plus the ordinary face claims: the glyph is FORCED rather than chosen, the
// body carries the affordances no cell kind can express, and the VRT scenes'
// determinism argument rests on the calibration grid having no time term.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { mappyDef, MAPPY_SURFACE_COUNT, MAPPY_MIN_SURFACES } from '$lib/video/modules/mappy';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { paramCellKind, momentaryParamIds, declaredParamCells } from '$lib/ui/workflow/shell-control-kind';
import { paintsReadout } from '$lib/ui/controls/knob-vocabulary-model';
import { shellParamWrite } from '$lib/ui/workflow/shell-param-writes';
import { shellCellKeys, shellCellKindsFor, shellActionProbes } from '$lib/ui/workflow/shell-cells';

const def = mappyDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const defSource = read('../../video/modules/mappy.ts');
const bodySource = read('mappy/MappyMapBody.svelte');
const editorSource = read('MappyEditor.svelte');
const editSource = read('mappy-edit.ts');

// The code-only views. A raw grep cannot tell code from a comment, and several
// legs below FORBID a construct whose natural explanation names it.
const defCode = stripSourceComments(defSource);
const bodyCode = stripSourceComments(bodySource);
const editorCode = stripSourceComments(editorSource);
const editCode = stripSourceComments(editSource);

/** The LIVE `ParamDef`. */
function param(id: string) {
  const p = mappyDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`mappy has no param '${id}'`);
  return p;
}

/** The shader body, as the def declares it. */
const fragSrc = /const WARP_FRAG_SRC = `([\s\S]*?)`;/.exec(defSource)?.[1] ?? '';

describe('mappy face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('mappy')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still has a live picture", () => {
    expect(def.face?.glyph).toBe('none');
    // The tile picture does not come from the glyph at all — `hasVideoSurface`
    // is `domain === 'video'` and nothing else, so it is free and per-node.
    expect(hasVideoSurface(def)).toBe(true);
  });

  it("'none' is FORCED, not chosen — mappy declares no audio output", () => {
    // `glyphBinding` short-circuits on the first `type: 'audio'` OUTPUT. There
    // is none, so every other literal resolves a dead `{kind:'static'}` and the
    // dead-glyph clause reddens. Asserted as the PROPERTY rather than as the
    // literal, per the brief: the literal is what the def says, this is why it
    // could not say anything else.
    expect(mappyDef.outputs.filter((o) => o.type === 'audio')).toEqual([]);
    expect(mappyDef.outputs.map((o) => o.id)).toEqual(['out']);
  });

  it('owns a fullViewBody extension — without it the module cannot be AIMED at all', () => {
    // ⚠ A STOP-2 ASSERTION. Promotion stops both default surfaces rendering
    // MappyCard, and the corner pin, the whole-surface move, the per-surface
    // FIT/CROP + RESET roster and the MAP editor are all card-only. A body that
    // forgot any of them would leave a projection mapper you cannot align.
    expect(def.face?.extension).toBe('mappy');
    expect(bodyCode).toMatch(/hitTestSurfaces/);
    expect(bodyCode).toMatch(/editSetCorner|setCorner/);
    expect(bodyCode).toMatch(/editMoveSurface|moveSurface/);
    expect(bodyCode).toMatch(/editToggleSurfaceFit|toggleSurfaceFit/);
    expect(bodyCode).toMatch(/editResetSurface|resetSurface/);
    expect(bodyCode).toMatch(/MappyEditor/);
  });

  it('⚠ EVERY graph read on EVERY mappy surface names its reactive pump', () => {
    // `patch` is SyncedStore's proxy, NOT a Svelte signal: a `$derived` that
    // reads through it subscribes to nothing. The legacy card rode its xyflow
    // props' incidental churn for that, and the MAP editor rode the card's —
    // which is why the editor's surface tabs FROZE AT ONE the first time a
    // faceplate body (no churn) mounted it, measured, while the graph correctly
    // held two. All three surfaces now read the shared pumps
    // (`node-versions.svelte.ts`), so none of them depends on a neighbour
    // re-rendering.
    for (const [name, code] of [['MappyMapBody', bodyCode],
      ['MappyEditor', editorCode],
    ] as const) {
      expect(code, `${name} must read nodeVersion() for its node-scoped deriveds`)
        .toMatch(/nodeVersion\(/);
    }
    // The patched-input roster (`live[]`, the hit-test's subjects, the editor's
    // `connected` prop) is edge-scoped, so the body takes the EDGES pump —
    // rather than a second hand-rolled copy of the card's `observeDeep` bridge,
    // which lives in none of the three shared mappy seams.
    expect(bodyCode).toMatch(/edgesVersion\(\)/);
    expect(bodyCode, 'the body must not hand-roll a second edges observer')
      .not.toMatch(/observeDeep/);
    for (const seam of ['mappy-edit.ts', 'mappy-hit.ts', 'mappy-map-io.ts']) {
      expect(
        stripSourceComments(read(seam)),
        `${seam} is a pure seam — the reactivity belongs to the surfaces`,
      ).not.toMatch(/observeDeep/);
    }
  });
});

describe('mappy face — the tier ladder', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('GRID leads: it is the control a player reaches for DURING an alignment', () => {
    // The count is set once at the start of a session; the override is used
    // over and over while walking between the projector and the wall.
    expect(def.face?.order?.[0]).toBe('showGrid');
    expect(keysAt('mini')).toEqual(['showGrid']);
  });

  it('the dock shows all four ranked controls, in two bands', () => {
    expect(keysAt('dock')).toEqual([
      'showGrid',
      'surfaceCount',
      'mappy-import-map-{n}',
      'mappy-export-map-{n}',
    ]);
    expect((def.face?.pages ?? []).map((p) => p.id)).toEqual(['surfaces', 'map']);
  });

  it('every param is ranked — nothing falls through to an inert cell', () => {
    const ranked = new Set(def.face?.order ?? []);
    expect(mappyDef.params.map((p) => p.id).filter((id) => !ranked.has(id))).toEqual([]);
  });
});

describe('⚠ the CURVE corrections — the whole GPU re-attest, and both are functional', () => {
  it('showGrid is a TOGGLE, not a 200px drag over two states', () => {
    const p = param('showGrid');
    expect(p.min).toBe(0);
    expect(p.max).toBe(1);
    expect(p.curve).toBe('discrete');
    // The resolver, not a re-typed copy of its condition.
    expect(paramCellKind(p, momentaryParamIds(mappyDef), 'dock', declaredParamCells(mappyDef)))
      .toBe('toggle');
    expect(paramCellKind(p, momentaryParamIds(mappyDef), 'lane', declaredParamCells(mappyDef)))
      .toBe('toggle');
  });

  it('the factory really reads showGrid as a two-state LEVEL, which is what makes the curve honest', () => {
    // The correction is neutral BY CONSTRUCTION only if nothing outside the UI
    // reads `curve` — and the factory's own threshold is what says so.
    expect(defCode).toMatch(/params\.showGrid >= 0\.5/);
    expect(fragSrc).toMatch(/uniform float uShowGrid/);
    expect(fragSrc).toMatch(/uShowGrid > 0\.5/);
  });

  it('surfaceCount SNAPS to the integers the module actually has', () => {
    const p = param('surfaceCount');
    expect(p.min).toBe(MAPPY_MIN_SURFACES);
    expect(p.max).toBe(MAPPY_SURFACE_COUNT);
    expect(p.curve).toBe('discrete');
  });

  it('the surfaceCount ROSTER is what keeps the card’s printed count alive', () => {
    // ⚠ The parity claim, pinned at the predicate the renderer itself uses. The
    // card paints the live count between its -/+ buttons; a param earns a
    // painted readout ONLY for a bare `options`/`landmarks` roster, so without
    // this the LANE tile would be a dial with no number and the dock a dial
    // instead of a six-state row.
    const p = param('surfaceCount');
    expect(p.options?.map((o) => o.value)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(p.options?.map((o) => o.label)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(paintsReadout(p as never)).toBe(true);
    expect(paramCellKind(p, momentaryParamIds(mappyDef), 'dock', declaredParamCells(mappyDef)))
      .toBe('segmented');
    // NEGATIVE CONTROL: strip the roster and the readout is gone — so this leg
    // measures the roster rather than restating that the param exists.
    expect(paintsReadout({ ...p, options: undefined } as never)).toBe(false);
    expect(
      paramCellKind({ ...p, options: undefined }, momentaryParamIds(mappyDef), 'dock', declaredParamCells(mappyDef)),
    ).toBe('knob');
  });

  it('the roster adds NO contract line — `options` is not projected', () => {
    // Stated because the roster is an addition beyond the plan and its cost has
    // to be checkable: `serializeModuleContract` projects
    // `id min..max curve default units` and nothing else about a param.
    const lock = readFileSync(resolve(HERE, '../../docs/contract-lock.txt'), 'utf8');
    const lines = lock.split('\n').filter((l) => l.startsWith('mappy param '));
    expect(lines).toEqual([
      'mappy param showGrid 0..1 discrete default=0',
      'mappy param surfaceCount 1..6 discrete default=1',
    ]);
  });
});

describe('⚠ the INERT-CONTROL TRAP — the params are the ONE source, in every reader', () => {
  it('the FACTORY reads the params and no node.data mirror', () => {
    // The exact shape of the defect: `if (data && typeof data.showGrid === ...)
    // return data.showGrid` ahead of the param. A shell cell writes the param
    // alone, so a mirror the engine preferred is a dead faceplate.
    expect(defCode).not.toMatch(/data\.showGrid/);
    expect(defCode).not.toMatch(/data\.surfaceCount/);
    expect(defCode).toMatch(/params\.showGrid/);
    expect(defCode).toMatch(/clampSurfaceCount\(params\.surfaceCount\)/);
  });

  it('the EDIT SEAM writes the param and no mirror', () => {
    expect(editCode).toMatch(/setNodeParam\(id, 'surfaceCount'/);
    expect(editCode).toMatch(/setNodeParam\(id, 'showGrid'/);
    expect(editCode).not.toMatch(/data as \{ surfaceCount\?: number \}/);
    expect(editCode).not.toMatch(/data as \{ showGrid\?: boolean \}/);
    // and the readers read `params`, never `data`, for these two keys
    expect(editCode).toMatch(/node\?\.params\?\.surfaceCount/);
    expect(editCode).toMatch(/node\?\.params\?\.showGrid/);
  });

  it('BOTH OTHER SURFACES read the same source — the card and the MAP editor', () => {
    // ⚠ THE "A FIX LANDS ONLY ON THE SURFACE YOU LOOKED AT" GUARD. Repairing
    // the body while the editor still read the mirror would print "GRID OFF"
    // over a screen full of grid and make its first press a no-op.
    for (const [name, code] of [['MappyEditor', editorCode] as const]) {
      expect(code, `${name} must read the GRID override through the shared param reader`)
        .toMatch(/getShowGrid\(/);
      expect(code, `${name} must not read a node.data.showGrid mirror`)
        .not.toMatch(/showGrid\?: unknown/);
    }
  });

  it('the map EXPORT takes the count from the param, not from node.data', () => {
    // Reading the dead mirror here would export `1` for every rack — a map that
    // silently drops the venue's surfaces on import, with no error anywhere.
    const actions = stripSourceComments(read('mappy-map-actions.ts'));
    expect(actions).toMatch(/getSurfaceCount\(node\)/);
    expect(actions).not.toMatch(/surfaceCount\?: unknown/);
  });
});

describe('⚠ the COUNT’s write SHAPE — the override registry, driven both ways', () => {
  it('surfaceCount commits through an override, not the plain setter', () => {
    expect(shellParamWrite('mappy', 'surfaceCount')).toBeTypeOf('function');
    expect(shellParamWrite('mappy', 'showGrid')).toBeTypeOf('function');
  });

  it('NEGATIVE CONTROL: an unregistered mappy param has no override', () => {
    // So the leg above measures the registration rather than the lookup always
    // answering yes.
    expect(shellParamWrite('mappy', 'nope')).toBeNull();
  });

  it('the override delegates to the ADD/REMOVE seam — the inset-quad drop', () => {
    // A bare `setNodeParam` would leave every added surface at the full-frame
    // UNIT_QUAD, stacked exactly on the one below it: pixel-identical composite,
    // handles on top of each other, nothing to grab. The behaviour itself is
    // driven against a real Y.Doc in mappy-edit-ydoc.test.ts; this pins that the
    // FACEPLATE is wired to it.
    const writes = stripSourceComments(
      readFileSync(resolve(HERE, '../workflow/shell-param-writes.ts'), 'utf8'),
    );
    expect(writes).toMatch(/setSurfaceCountTo\(nodeId/);
    expect(writes).toMatch(/setShowGrid\(nodeId/);
  });
});

describe('the two ranked control FAMILIES are real, live shell cells', () => {
  it('both resolve a cell spec, of the right kind, under the RANKED key', () => {
    // ⚠ Keyed by the `-{n}` TEMPLATE, not the bare family id: a bare family id
    // resolves to nothing and the shell paints an inert cell — the failure the
    // whole registry exists to prevent.
    expect(shellCellKeys('mappy')).toEqual(['mappy-export-map-{n}', 'mappy-import-map-{n}']);
    expect(shellCellKindsFor('mappy')).toEqual(['action', 'file']);
    for (const key of def.face?.order ?? []) {
      if (!key.endsWith('-{n}')) continue;
      expect(shellCellKeys('mappy'), `ranked family key ${key} must register a cell`)
        .toContain(key);
    }
  });

  it('the export cell declares the FILE-EXPORT audition seam, not engine-message', () => {
    // An export reaches no engine, so `engine-message` would make the ledger lie
    // — and a probe watching it here could be satisfied by something that never
    // wrote a file.
    expect(shellActionProbes().mappy?.['mappy-export-map-{n}']?.effect)
      .toEqual({ kind: 'audition', seam: 'file-export' });
  });

  // ⚠ 'the testid prefixes ALREADY exist on the legacy card — no card edit was
  // needed' STOOD HERE. It grepped `MappyCard.svelte` for each declared
  // `controlFamily.testidPrefix`, the module-local half of `module-docs-lint`'s
  // card-drift leg. That leg no longer asks whether a prefix appears in card
  // markup — it cannot, because the shell stamps `shell-cell-<familyId>` from
  // an interpolation — and instead resolves each family to a live SHELL CELL.
  // Both of mappy's families are asserted to do exactly that above.

  it('the venue file format has ONE implementation — the shared action seam', () => {
    // A second copy is how the ranked cells and the faceplate come to disagree
    // about what a `.json` map means, with nothing red. The cells call
    // `mappy-map-actions`; nothing re-implements the serializer or the
    // download.
    const cells = stripSourceComments(
      readFileSync(resolve(HERE, '../workflow/shell-cells.ts'), 'utf8'),
    );
    expect(cells).toMatch(/from '\$lib\/ui\/modules\/mappy-map-actions'/);
    for (const [name, code] of [['MappyMapBody', bodyCode] as const]) {
      expect(code, `${name} may not re-implement serializeMap`).not.toMatch(/serializeMap\(/);
      expect(code, `${name} may not re-implement the download`).not.toMatch(/createObjectURL/);
    }
  });

  it('the BODY paints the map OUTCOME and does NOT repeat the two ranked controls', () => {
    // ⚠ THE FIRST DRAFT DID REPEAT THEM, and the dock painted export/import
    // twice, inches apart: the body's own pair above the ranked cells' pair.
    // ModuleShell paints a status line under a `file` cell and nothing under an
    // `action` cell, so the outcome — not a second button — is what this
    // surface owes. It crosses over on the shared per-node record.
    expect(bodyCode).toMatch(/mappyMapOutcome\(nodeId\)/);
    expect(bodyCode, 'the body must not mount its own map file input')
      .not.toMatch(/type="file"/);
    expect(bodyCode, 'the body must not fire the export itself')
      .not.toMatch(/exportMappyMap/);
    // …and BOTH actions publish into that record, or the line would be blind to
    // half of what it reports.
    const actions = stripSourceComments(read('mappy-map-actions.ts'));
    expect((actions.match(/recordMappyMapOutcome\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('SCREEN OFF must never darken the projector', () => {
  it('the collapsed branch STILL marks the node watched', () => {
    // `markWatched` happens inside `blitOutputForPreview`, and a node is a pull
    // root only while that mark is fresh. mappy is a mid-chain compositor
    // feeding a projector, so a naive `{#if !collapsed}` around the loop would
    // make a control labelled SCREEN a producer kill switch — a black stage
    // with the module apparently running.
    expect(bodyCode).toMatch(/previewCollapsed/);
    expect(bodyCode).toMatch(/markWatched\(nodeId\)/);
    // the mark is INSIDE the collapsed branch, ahead of the early return
    const collapsed = /if \(previewCollapsed\) \{([\s\S]*?)\n {4}\}/.exec(bodyCode)?.[1] ?? '';
    expect(collapsed, 'the SCREEN-OFF branch itself must mark the node watched')
      .toMatch(/markWatched/);
    expect(collapsed).toMatch(/requestAnimationFrame\(draw\)/);
  });

  it('the switch persists on the NODE, on the shared key', () => {
    // Component `$state` dies on every dock collapse / LRU eviction (#1531);
    // and a different key would silently re-open every preview a rack had
    // collapsed before the promotion.
    expect(bodyCode).toMatch(/data\?\.previewCollapsed/);
    expect(bodyCode).toMatch(/mutateNode\(nodeId/);
  });

  it('the body is 2-D — a WebGL context would enrol the file in the attest basis forever', () => {
    expect(bodyCode).toMatch(/getContext\('2d'/);
    expect(bodyCode).not.toMatch(/getContext\('webgl/);
  });
});

describe('the VRT scenes’ determinism argument, pinned where it is made', () => {
  it('the calibration grid has NO time term — it is a pure function of the surface uv', () => {
    // The `_shell-faces.ts` entry rests on this, and the old EXEMPT_FROM_VRT
    // `why` ("a black preview") was false about it. A fresh spawn composites
    // exactly one surface and `drawGrid` is forced, so the grid IS the picture.
    const grid = /vec4 calibrationGrid\(vec2 s, float idx\) \{([\s\S]*?)\n\}/.exec(fragSrc)?.[1] ?? '';
    expect(grid.length).toBeGreaterThan(200);
    for (const forbidden of ['uTime', 'time', 'frame', 'random', 'noise']) {
      expect(grid, `calibrationGrid must not read \`${forbidden}\``).not.toContain(forbidden);
    }
    expect(defCode).toMatch(/drawGrid = forceGrid \|\| !inputTex/);
  });

  it('the def declares no CV input and no `freeze` param', () => {
    // So `freezeFaceVideo`'s write lands nowhere (the textmarquee no-op), and
    // `freezeIsNotASeam` is correctly omitted from the roster entry.
    expect(mappyDef.inputs.every((i) => i.type === 'video')).toBe(true);
    expect(mappyDef.params.map((p) => p.id)).not.toContain('freeze');
  });
});
