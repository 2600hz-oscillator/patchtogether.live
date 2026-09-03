// packages/web/src/lib/ui/modules/doom-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the DOOM faceplate (2026-09-02).
//
// Everything here is a claim the shipped face MAKES and that no pixel gate can
// check — this face has NO VRT scenes at all (`FACES_WITHOUT_SCENES`, because
// DOOM's game clock IS its frame clock), so this file plus `face-doom.spec.ts`
// and the standing DOOM e2e battery are the whole of its coverage. That raises
// the bar rather than lowering it: each block below says what it would look like
// if it were wrong.
//
// ⚠ THE SHARPEST LEGS IN THIS FILE ARE THE TWO SOURCE PROBES, and they are
// source probes on purpose. DOOM's legacy card was not a control panel, it was
// the module's RUNTIME OWNER: `nodeDoomSession.adopt` (the pump that feeds the
// lockstep barrier), the awareness / nodes / edges observers, the capture-phase
// window keyboard listeners, the framebuffer blit and the `__doomCards` hook
// every DOOM spec reads all lived in its `onMount`. Promotion stops the default
// shell mounting that card. A faceplate that carried only CONTROLS would have
// shipped a DOOM that is a black tile with no game, no keyboard and no netgame
// — while the def is unchanged, the registry is unchanged, the shader still
// compiles and still paints its "alive but no signal" idle field, and every
// def-reading gate stays green.
//
// So the claim "both surfaces mount the SAME surface component" is asserted
// here at the source, and the behaviour is asserted in a real browser by
// `face-doom.spec.ts` and `doom-session-survives-card-collapse.spec.ts`. A
// source probe alone can be satisfied by a card that imports the surface and
// never renders it; a runtime leg alone cannot say WHICH surface booted. Both.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doomDef } from '$lib/video/modules/doom';
import { CV_GATE_PORT_IDS_BY_SLOT } from '$lib/doom/doomkeys';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { noUserControlIds, cvWritersOf } from '$lib/ui/workflow/no-user-control';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';

const def = doomDef as unknown as FaceDefLike & { type: string };
const HERE = dirname(fileURLToPath(import.meta.url));

/** The LIVE `ParamDef` — `FaceDefLike` narrows params to `FaceParamLike`, which
 *  projects only what curation reads, so min/max/curve/options are unreachable
 *  through `def.params`. (svelte-check catches this; vitest does not.) */
function param(id: string) {
  const p = doomDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`doom has no param '${id}'`);
  return p;
}

/**
 * ⚠ EVERY SOURCE PROBE IN THIS FILE READS COMMENT-STRIPPED TEXT, and it is not
 * hygiene — it is the only way these probes can be true. The three new files
 * carry long headers that NAME the things they must not do ("a face body that
 * did not carry them would ship a black tile", "unmounting DoomSurface would
 * drop `__doomCards`"), and a raw grep reads the warning as the offence. The
 * negative controls at the bottom are what keep the stripping from hiding a real
 * offence instead.
 */
function stripped(rel: string): string {
  return stripSourceComments(readFileSync(resolve(HERE, rel), 'utf8'));
}
const cardSrc = (): string => stripped('DoomCard.svelte');
const bodySrc = (): string => stripped('doom/DoomBody.svelte');
const surfaceSrc = (): string => stripped('doom/DoomSurface.svelte');
const extensionSrc = (): string => stripped('doom/shell-extension.ts');

describe('doom face — promoted, video-surfaced, extension-bodied', () => {
  it('is in STRICT_FACES (the promotion this file exists for)', () => {
    expect(STRICT_FACES.has('doom')).toBe(true);
  });

  it("declares glyph 'none' — and this one is a CHOICE, not a forced literal", () => {
    // ⚠ WORTH ASSERTING FOR THE REASON blood's version of this leg gives. On a
    // module with no `type === 'audio'` output, `'none'` is mechanically forced.
    // doom HAS audio outs, so a `'scope'` glyph would bind to a LIVE analyser
    // tap — and would still be wrong, because `laneGlyphFor` short-circuits to
    // 'picture' for a video def, so the declared glyph paints NOTHING at any
    // tier while the tap runs.
    expect(def.face?.glyph).toBe('none');
    expect(doomDef.outputs.some((o) => o.type === 'audio')).toBe(true);
    // …and the tile's picture comes from the OTHER seam, which is what makes
    // 'none' costless here: the lane tile is this peer's own live POV.
    expect(hasVideoSurface(def)).toBe(true);
  });

  it('owns a fullViewBody extension', () => {
    expect(def.face?.extension).toBe('doom');
    expect(extensionSrc()).toMatch(/fullViewBody:\s*DoomBody/);
  });

  it('declares MONITOR, and the body owns the button that drives it', () => {
    expect(def.face?.monitor?.why).toBeTruthy();
    expect(bodySrc()).toContain('hideControls');
    expect(/\.data\.hideControls\s*=/.test(bodySrc())).toBe(true);
  });
});

describe('doom face — two controls, one band, no rail', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('ranks GAIN first — the only control anything downstream can hear', () => {
    expect(keysAt('mini')).toEqual(['audioGain']);
    expect(def.face?.order).toEqual(['audioGain', 'fillMode']);
  });

  it('the dock shows both real controls and NONE of the forty gate targets', () => {
    expect(keysAt('dock')).toEqual(['audioGain', 'fillMode']);
    for (const { portId } of CV_GATE_PORT_IDS_BY_SLOT) {
      expect(keysAt('dock'), `cv_${portId} must never reach a cell`).not.toContain(`cv_${portId}`);
    }
    for (const cheat of ['cv_iddqd_in', 'cv_idkfa_in']) {
      expect(keysAt('dock'), `${cheat} must never reach a cell`).not.toContain(cheat);
    }
  });

  it('renders one authored band and no tab rail — 40 params, 2 cells', () => {
    const bands = dockFacePlan(def)!;
    expect(bands[0]!.controls.map((c) => c.key)).toEqual(['audioGain', 'fillMode']);
    // ⚠ THE NUMBER IS THE POINT. This def declares 40 params and the plate shows
    // TWO. DOCK_TAB_MIN_BANDS is 7; a face that had accidentally ranked the
    // gate targets would blow straight past it and the control-heavy ruling
    // would demand a tab rail for a module with two knobs.
    expect(doomDef.params.length).toBe(40);
    expect(bands.length).toBeLessThan(7);
  });
});

describe('doom — FILL is a free toggle, and the absent roster is deliberate', () => {
  it('`fillMode` is `discrete 0..1`, so a toggle derives with NO options roster', () => {
    const p = param('fillMode');
    expect(p.curve).toBe('discrete');
    expect(p.min).toBe(0);
    expect(p.max).toBe(1);
    // ⚠ THE ABSENCE IS THE ASSERTION. LETTERBOX/FILL captions would be a
    // `params` edit on a def inside the WebGL attest basis — a real-GPU
    // re-attest plus a contract re-pin — for two words the shape already
    // implies. If a future edit adds them, this goes red and the author has to
    // budget the attest deliberately rather than discover it in CI.
    expect(
      p.options,
      'adding an options roster to fillMode costs a GPU re-attest + a contract re-pin; the ' +
        'discrete 0..1 shape already derives a toggle for free',
    ).toBeUndefined();
  });

  it('the FACE declares no paramCells — both primitives are derived', () => {
    expect(def.face?.paramCells).toBeUndefined();
  });
});

describe('doom — the forty gate params are declared, and the claim is checkable', () => {
  const declared = () =>
    (doomDef as { noUserControl?: readonly { param: string; writer: string }[] })
      .noUserControl ?? [];

  it('every `cv_*` param is noUserControl, written by a cv-port', () => {
    const expected = [
      ...CV_GATE_PORT_IDS_BY_SLOT.map(({ portId }) => `cv_${portId}`),
      'cv_iddqd_in',
      'cv_idkfa_in',
    ].sort();
    expect(declared().map((d) => d.param).sort()).toEqual(expected);
    expect(declared().every((d) => d.writer === 'cv-port')).toBe(true);
  });

  it('⚠ the cv-port claim is ANCHORED — a real jack targets each one', () => {
    for (const { portId } of CV_GATE_PORT_IDS_BY_SLOT) {
      expect(cvWritersOf(doomDef, `cv_${portId}`), `no jack targets cv_${portId}`).toEqual([portId]);
    }
    expect(cvWritersOf(doomDef, 'cv_iddqd_in')).toEqual(['iddqd_in']);
    expect(cvWritersOf(doomDef, 'cv_idkfa_in')).toEqual(['idkfa_in']);
    // …and the sweep reads real ports, so a hit means something.
    expect(doomDef.inputs.length).toBe(CV_GATE_PORT_IDS_BY_SLOT.length + 2);
  });

  it('the two REAL controls are NOT declared away', () => {
    const ids = noUserControlIds(doomDef);
    expect(ids.has('audioGain')).toBe(false);
    expect(ids.has('fillMode')).toBe(false);
    // Completeness the other way: order ∪ noUserControl covers every param, so
    // nothing on this def is unranked and undeclared.
    const covered = new Set([...(def.face?.order ?? []), ...ids]);
    expect(doomDef.params.filter((p) => !covered.has(p.id)).map((p) => p.id)).toEqual([]);
  });
});

describe('⚠ doom — ONE SURFACE, TWO MOUNTS (the promotion hazard)', () => {
  it('the legacy card is a THIN BRIDGE onto the shared surface', () => {
    const src = cardSrc();
    expect(src).toContain("import DoomSurface from './doom/DoomSurface.svelte'");
    expect(src).toMatch(/<DoomSurface[^>]*variant="card"/s);
    // ⚠ THE CARD MUST NOT RE-IMPLEMENT ANY OF IT. If a future edit copies logic
    // back into the card, the two surfaces can disagree about who owns the
    // keyboard and who adopted the session — the exact drift this split exists
    // to make unrepresentable. Every one of these belongs to the surface now.
    for (const owned of [
      'nodeDoomSession',
      'addEventListener',
      '__doomCards',
      'requestAnimationFrame',
      'DoomNetcode',
      'LockstepTransport',
    ]) {
      expect(src, `DoomCard.svelte must not own '${owned}' any more`).not.toContain(owned);
    }
  });

  it('the FACE BODY mounts the same surface, in face variant', () => {
    const src = bodySrc();
    expect(src).toContain("import DoomSurface from './DoomSurface.svelte'");
    expect(src).toMatch(/<DoomSurface[^>]*variant="face"/s);
  });

  it('⚠ the SURFACE — not either wrapper — owns the session and the keyboard', () => {
    const src = surfaceSrc();
    // The node-owned session adoption. Without this call in whatever component
    // the shell mounts, a running netgame's pump dies and every peer's lockstep
    // barrier starves (#345 semantics) — the #1590 defect, re-armed by the
    // promotion.
    expect(src).toContain('nodeDoomSession.adopt(');
    // The capture-phase window keyboard listeners: the only reason arrow keys
    // reach the marine instead of moving the node.
    expect(src).toContain("window.addEventListener('keydown', onWindowKeyDownCapture, true)");
    expect(src).toContain("window.addEventListener('keyup', onWindowKeyUpCapture, true)");
    // The hook every DOOM spec and `_doom-helpers.ts` reads.
    expect(src).toContain('__doomCards');
    // The user-gesture WAD boot. DOOM must never load at MOUNT — that is the
    // #2314 lesson, and here it is worth 4 MB and a WASM instantiation per tile.
    expect(src).toContain('extras.ensureLoaded()');
  });

  it('⚠ the WAD boot is NOT mount-time work', () => {
    const src = surfaceSrc();
    // `tryLoad` is the only caller path, and `onMount` must not call it. The
    // probe is proximity-free on purpose: `onMount` is one block and a
    // `tryLoad()` inside it would be visible as a call in the mount body, which
    // this asserts is absent by asserting the mount body's known callees
    // instead — `adopt`, the listeners, the blit — and that the load button
    // exists as a user gesture.
    expect(src).toMatch(/onclick=\{\(\)\s*=>\s*void tryLoad\(\)\}/);
    // The remount-recovery branch may set `loadStatus = 'ready'` when a runtime
    // ALREADY exists; that is adoption, not a load, and it must stay guarded on
    // an existing initialized runtime rather than starting one.
    expect(src).toContain("getExtras()?.getRuntime()?.isInitialized()");
  });

  it('⚠ SCREEN OFF collapses the CANVAS ONLY — never the session', () => {
    const src = bodySrc();
    // The body passes the flag DOWN rather than unmounting the surface. If a
    // future edit wraps `<DoomSurface>` in `{#if !previewCollapsed}` — which is
    // what every OTHER video face does, and what gibribbon does on purpose —
    // turning the screen off would drop the node session adoption, the keyboard,
    // the Join button and the New Game dialog with it.
    expect(src).toMatch(/<DoomSurface[^>]*\{previewCollapsed\}/s);
    expect(src).not.toMatch(/\{#if\s*!previewCollapsed\}\s*<DoomSurface/s);
    // …and the surface gates only the <canvas> on it.
    expect(surfaceSrc()).toMatch(/\{#if\s*!previewCollapsed\}\s*<canvas/s);
  });

  it('⚠ NO GL CONTEXT is created by any of the three new files (attest basis)', () => {
    // The WebGL attest basis sweeps `lib/ui/modules/**` BY CONTENT for
    // `getContext('webgl')`. All three preview paths are 2-D blits, exactly as
    // the card's always was, so none of these files enters the basis and the
    // promotion costs no GPU re-attest. If one ever does, this goes red BEFORE
    // CI discovers it as a hash move.
    const CTX = /getContext\(\s*['"`]webgl2?['"`]/;
    for (const [name, src] of [
      ['DoomSurface.svelte', surfaceSrc()],
      ['DoomBody.svelte', bodySrc()],
      ['DoomCard.svelte', cardSrc()],
    ] as const) {
      expect(CTX.test(src), `${name} must not create a GL context`).toBe(false);
    }
  });

  it('⚠ the param writes are TRACKED, and stay where the ledgers can see them', () => {
    // The OUTPUT FIT row and the Volume knob are CARD chrome and must remain in
    // `DoomCard.svelte`: `card-def-agreement.test.ts` and
    // `card-range-source.test.ts` scan `*Card.svelte` ONLY, so a control that
    // moved into the shared surface would take its recorded card↔def divergence
    // out of their reach and the ledger entry would read as PAID when nothing
    // had been fixed. The surface renders them through a snippet PROP instead.
    const card = cardSrc();
    expect(card).toContain('data-testid="doom-fit-row"');
    expect(card).toContain('data-testid="doom-volume"');
    expect(card).toMatch(/\{#snippet controlsRow\(\)\}/);
    expect(surfaceSrc()).toMatch(/\{@render controlsRow\?\.\(\)\}/);
    // ⚠ AND THE ONE DIVERGENCE THAT IS STILL OPEN IS STILL WHERE IT WAS. The def
    // says 'Gain'; the card's Knob says "Volume". `VOCABULARY_DEBT` carries the
    // pair, and this leg is what keeps the two facts joined — if a future edit
    // renames either side, one of these three goes red rather than the ledger
    // quietly going stale.
    expect(param('audioGain').label).toBe('Gain');
    expect(card).toContain('label="Volume"');
  });

  it('⚠ the param writes are TRACKED — the raw-write debt is paid, not moved', () => {
    const card = cardSrc();
    expect(card).toContain("setNodeParam(id, 'fillMode', v)");
    expect(card).toContain("setNodeParam(id, 'audioGain', v)");
    // The raw form this replaced. It was neither undoable nor LOCAL_ORIGIN-
    // tagged, so Cmd-Z stepped straight over an OUTPUT FIT flip.
    expect(card).not.toMatch(/target\.params\.(fillMode|audioGain)\s*=/);
    expect(surfaceSrc()).not.toMatch(/\.params\.(fillMode|audioGain)\s*=/);
  });

});

describe('⚠ the source probes above can say NO (instrument negative controls)', () => {
  it('the shared-surface probes reject a card that re-implements the surface', () => {
    const fake = "import DoomSurface from './doom/DoomSurface.svelte'\nnodeDoomSession.adopt(id, {})";
    expect(fake.includes('nodeDoomSession')).toBe(true);
    expect(/<DoomSurface[^>]*variant="card"/s.test(fake)).toBe(false);
  });

  it('the SCREEN probe rejects a body that unmounts the whole surface', () => {
    const fake = '{#if !previewCollapsed}<DoomSurface id={nodeId} variant="face" />{/if}';
    expect(/\{#if\s*!previewCollapsed\}\s*<DoomSurface/s.test(fake)).toBe(true);
    expect(/<DoomSurface[^>]*\{previewCollapsed\}/s.test(fake)).toBe(false);
  });

  it('the GL probe rejects a file that DOES open a context', () => {
    const CTX = /getContext\(\s*['"`]webgl2?['"`]/;
    expect(CTX.test("const gl = c.getContext('webgl2');")).toBe(true);
    expect(CTX.test("const ctx2d = c.getContext('2d');")).toBe(false);
  });

  it('⚠ comment stripping does not hide a REAL offence', () => {
    // The headers of all three files discuss `getContext('webgl')`,
    // `previewCollapsed` and the raw writes in prose. Stripping is what makes
    // the probes read CODE — and this leg proves the stripper removes comments
    // without removing the code beside them.
    const src = stripSourceComments(
      "// never call getContext('webgl') here\nconst gl = c.getContext('webgl2');\n",
    );
    expect(src).toContain("c.getContext('webgl2')");
    expect(src).not.toContain('never call');
  });
});
