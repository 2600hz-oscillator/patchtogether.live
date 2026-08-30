// packages/web/src/lib/ui/modules/loopback-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the LOOPBACK faceplate.
//
// ⚠ WHY THIS FILE, GIVEN THE GENERIC GATES. `module-face-lint`, the dock
// render-plan parity check and `faces-parity` all enumerate this face's TWO
// params and would go green over a face that shipped both controls correctly
// and was still completely unusable — because everything that makes LOOPBACK
// work is NOT a param and therefore not in any of their subjects. The
// `blind-gates.md` question ("would its green run look any different if the
// answer were 'everything'?") has an uncomfortable answer here, so the real
// coverage is written below.
//
// What it pins, and why each is unreachable from the declaration alone:
//
//   1. THE LANE TILE STILL SHOWS A PICTURE. `glyph: 'none'` is mandatory for a
//      video def, and `'none' + blank tile` is indistinguishable from
//      `'none' + live thumb` from the declaration — the picture arrives through
//      `hasVideoSurface`. Asserted in BOTH directions.
//   2. `crop` RESOLVES TO A TOGGLE WITHOUT BEING DECLARED, and needs no
//      momentary/latching classification. The face comment CLAIMS both; nothing
//      checks a comment, and the second claim rests on a single literal
//      (`defaultValue === 1`) that an ordinary edit could flip.
//   3. `gain`'s `paramCells` DECLARATION IS LOAD-BEARING. Undeclared it is a
//      knob, and a knob where the card draws a fader is the silent-disagreement
//      class. Pinned with the counterfactual, not just the result.
//   4. THE EXTENSION RESOLVES. A `face.extension` naming a directory the glob
//      did not discover degrades to the generic shell at RENDER time and never
//      throws — and for this module the generic shell is a face with two
//      controls and NO WAY TO START A CAPTURE. Only a test separates "the
//      bespoke surface mounted" from "it silently did not".
//   5. ⚠ THE GESTURES ARE STRUCTURALLY UN-CELLABLE, which is the claim the
//      whole design rests on. If a future edit added an `enabled`-style param,
//      the honest answer would be a face cell and this extension would be
//      carrying something that no longer needs carrying. Asserted as a property
//      of the def's param set, so it reddens on the day that changes.
//   6. THE BODY CARRIES WHAT THE HEADLESS CARD CANNOT. Source-level, because no
//      runtime gate mounts this body against an off-screen card.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loopbackDef } from '$lib/video/modules/loopback';
import {
  hasVideoSurface,
  laneBodyPlan,
  laneGlyphFor,
} from '$lib/ui/workflow/module-shell-model';
import { paramCellKind, looksLikeSwitch, declaredParamCells } from '$lib/ui/workflow/shell-control-kind';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { shellExtensionIds, loadShellExtension } from '$lib/ui/workflow/shell-extensions';
import { getVideoModuleDef } from '$lib/video/module-registry';
import '$lib/video/modules';

const LANE_TIERS = ['mini', 'compact', 'full'] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_SRC = resolve(HERE, 'loopback/LoopbackOutputBody.svelte');
const bodySrc = readFileSync(BODY_SRC, 'utf-8');

function param(id: string) {
  const p = loopbackDef.params.find((x) => x.id === id);
  expect(p, `the def must still declare a '${id}' param`).toBeDefined();
  return p!;
}

describe('loopback face — the LANE PICTURE', () => {
  it('resolves a LIVE VIDEO SURFACE, and that is what makes its lane glyph a PICTURE', () => {
    // `face.glyph: 'none'` says nothing about the picture — it is mandatory for
    // a video def (no audio out ⇒ any other literal is a dead binding that
    // reddens module-face-lint). The picture arrives from the DOMAIN.
    expect(loopbackDef.face?.glyph).toBe('none');
    expect(hasVideoSurface(loopbackDef)).toBe(true);
    expect(laneGlyphFor(loopbackDef)).toBe('picture');
  });

  it('KEEPS its picture at EVERY lane tier', () => {
    const glyph = laneGlyphFor(loopbackDef);
    const cells = (loopbackDef.face?.order ?? []).length;
    for (const tier of LANE_TIERS) {
      expect(
        laneBodyPlan(cells, glyph, tier).glyph,
        `${tier}: the rack tile keeps its live picture`,
      ).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the plan can still say FALSE, so the legs above are not constants', () => {
    const heavy = laneBodyPlan(28, 'trace', 'full');
    expect(heavy.layout).toBe('plate');
    expect(heavy.glyph, 'ranked cells still outrank a TRACE — the instrument can say false').toBe(false);
    for (const tier of LANE_TIERS) {
      expect(laneBodyPlan(0, 'none', tier).glyph).toBe(false);
    }
  });
});

describe('loopback face — the TWO CELLS, and why only one is declared', () => {
  it('is PROMOTED — an authored face outside STRICT_FACES ships as a no-op', () => {
    expect(STRICT_FACES.has('loopback')).toBe(true);
  });

  it('ranks EXACTLY the params the def declares, in the authored order', () => {
    expect(loopbackDef.face?.order).toEqual(['crop', 'gain']);
    expect([...(loopbackDef.face?.order ?? [])].sort()).toEqual(
      loopbackDef.params.map((p) => p.id).sort(),
    );
    expect(loopbackDef.face?.pages, 'two controls over one capture are ONE band').toBeUndefined();
  });

  it('`crop` resolves to a TOGGLE on its own — the face declares no cell for it', () => {
    // The face comment argues this rather than declaring it. If `looksLikeToggle`
    // ever stopped recognising the shape, the cell would silently become a KNOB
    // over a 0/1 discrete param and nothing else would notice.
    const declared = declaredParamCells(loopbackDef);
    expect(declared.has('crop'), 'crop must stay UNDECLARED — that is the claim').toBe(false);
    expect(paramCellKind(param('crop'), new Set(), 'dock', declared)).toBe('toggle');
    expect(paramCellKind(param('crop'), new Set(), 'lane', declared)).toBe('toggle');
  });

  it('`crop` needs NO momentary/latching classification, and that rests on ONE literal', () => {
    // ⚠ `looksLikeSwitch` is `looksLikeToggle(p) && p.defaultValue === 0`, and
    // `crop` ships at 1 — a loopback arrives cropped to the viewport. Every
    // other faced two-state param in the fleet DID need the classification, so
    // this is the exception, and it is one edit away from stopping being true.
    expect(param('crop').defaultValue, 'a loopback arrives CROPPED').toBe(1);
    expect(looksLikeSwitch(param('crop'))).toBe(false);
    expect(loopbackDef.face?.momentary, 'nothing to classify ⇒ nothing declared').toBeUndefined();

    // POSITIVE CONTROL: the same predicate DOES fire on the shape it is for, so
    // the leg above is a fact about `crop` rather than about a dead predicate.
    expect(looksLikeSwitch({ ...param('crop'), defaultValue: 0 })).toBe(true);
  });

  it('`gain`\'s fader DECLARATION is load-bearing — undeclared it would be a KNOB', () => {
    // The counterfactual is the point: nothing in a ParamDef separates "a level"
    // from any other continuous scalar, so the card's NeonFader and an
    // undeclared face cell would silently disagree.
    const declared = declaredParamCells(loopbackDef);
    expect(paramCellKind(param('gain'), new Set(), 'dock', declared)).toBe('fader');
    expect(
      paramCellKind(param('gain'), new Set(), 'dock', new Map()),
      'with nothing declared it falls to a knob — which is why the declaration exists',
    ).toBe('knob');
  });
});

describe('loopback face — the BESPOKE SURFACE is STRUCTURALLY REQUIRED', () => {
  it('declares the extension, and the extension actually resolves a fullViewBody', async () => {
    const id = loopbackDef.face?.extension;
    expect(id).toBe('loopback');
    expect(shellExtensionIds()).toContain('loopback');
    const ext = await loadShellExtension(id!);
    expect(ext, 'the declared extension id must resolve to a discovered module').not.toBeNull();
    expect(typeof ext?.fullViewBody, 'the fullViewBody slot must be filled').toBe('function');
  });

  it('the def has NO param that could carry acquire or stop — so the body is not a preference', () => {
    // ⚠ THE CLAIM THE WHOLE DESIGN RESTS ON. cameraInput gets pause/resume free
    // as an `enabled` toggle cell; LOOPBACK has no equivalent, so both capture
    // gestures MUST ride the command seam. The day someone adds such a param,
    // the honest answer becomes a face cell and this extension is carrying
    // something that no longer needs carrying — so this reddens then, on
    // purpose. It is a MEMBERSHIP assertion, never a count.
    expect(loopbackDef.params.map((p) => p.id).sort()).toEqual(['crop', 'gain']);
  });

  it('the body carries BOTH gestures, the lamp and the SCREEN switch, through the seam', () => {
    // Source-level, because no runtime gate in this package mounts this body
    // against an off-screen card — and the failure it guards against is a body
    // that renders but reaches nothing.
    for (const testid of [
      'loopback-output-body',
      'loopback-face-canvas',
      'loopback-face-screen-toggle',
      'loopback-face-lamp',
      'loopback-face-acquire',
      'loopback-face-stop',
    ]) {
      expect(bodySrc, `the body must expose ${testid}`).toContain(testid);
    }
    expect(
      bodySrc,
      'both gestures must go through the registry — a body calling getDisplayMedia itself is a SECOND owner',
    ).toContain('loopbackStatus.request(nodeId');
    // ⚠ THE PREDICATES NAME A CALL, NOT A WORD, AND THE FIRST DRAFT DID NOT.
    // `/getDisplayMedia/` reddened on this very file — the header argues at
    // length about who may call it, and a grep over source cannot tell code
    // from comment. That is the third time this class has been recorded in this
    // tree, and the answer is not to strip comments (a `//`-eating regex eats
    // `'https://x'`): it is to match the DEFECT'S SHAPE. Acquiring is a CALL, so
    // require the parenthesis and the receiver; adopting is an ASSIGNMENT, so
    // require the `=`. A body that merely discusses either still passes, which
    // is correct — and a body that does either still fails, which is the point.
    expect(
      /getDisplayMedia\s*\(|navigator\s*\.\s*mediaDevices/.test(bodySrc),
      'the body must NEVER acquire a stream itself — that would be a second owner of the capture',
    ).toBe(false);
    expect(
      /nodeMedia\s*\.\s*adopt\s*\(|\.\s*srcObject\s*=/.test(bodySrc),
      'the body must NEVER adopt the node-owned <video> — a DOM node has one parent, and a stolen '
        + 'tab capture cannot be re-acquired without sending the user back through the picker',
    ).toBe(false);
  });

  it('POSITIVE CONTROL: those two predicates DO fire on the code they forbid', () => {
    // ⚠ WITHOUT THIS, THE LEG ABOVE IS TWO ASSERTIONS THAT NOTHING IS PRESENT —
    // which is exactly what a typo'd regex also reports. Both predicates are
    // re-run here against the shapes they exist to catch, so "the body is clean"
    // and "the scan stopped working" cannot look the same.
    const acquires = "const s = await navigator.mediaDevices.getDisplayMedia(C);";
    const adopts = "const lease = nodeMedia.adopt(id, 'main', host, {}); v.srcObject = stream;";
    expect(/getDisplayMedia\s*\(|navigator\s*\.\s*mediaDevices/.test(acquires)).toBe(true);
    expect(/nodeMedia\s*\.\s*adopt\s*\(|\.\s*srcObject\s*=/.test(adopts)).toBe(true);
    // ...and do NOT fire on prose that merely names them, which is the false
    // positive that produced this control in the first place.
    const prose = '// it must never call `getDisplayMedia` itself, and never adopt via nodeMedia.';
    expect(/getDisplayMedia\s*\(|navigator\s*\.\s*mediaDevices/.test(prose)).toBe(false);
    expect(/nodeMedia\s*\.\s*adopt\s*\(|\.\s*srcObject\s*=/.test(prose)).toBe(false);
  });

  it('DELIVERY IS REPORTED, NEVER DROPPED — an acquire writes nothing a probe could read', () => {
    // An ACTION-shaped affordance is invisible to readParam/readData by
    // construction, so the `delivered` flag is the only observable that
    // separates "the card acted" from "no card was listening". A body that
    // discarded it would make those two indistinguishable.
    expect(bodySrc).toContain('res.delivered');
    expect(
      (bodySrc.match(/if \(!res\.delivered\)/g) ?? []).length,
      'BOTH gestures must report their delivery, not just the acquire',
    ).toBe(2);
  });

  it('the body is 2-D, so the face stays OUT of the WebGL attest basis', () => {
    // `lib/ui/**` is not hashed, but a WebGL context here would be a renderer
    // the attest cannot see. The picture is a BLIT of the module's own output.
    expect(bodySrc).toContain("getContext('2d'");
    expect(/getContext\(\s*['"]webgl/.test(bodySrc), 'no GL in a face body').toBe(false);
    expect(bodySrc).toContain('blitOutputForPreview');
  });
});

describe('loopback face — anchored to the live registry', () => {
  it('the def in the LIVE REGISTRY is the one this file asserts about', () => {
    expect(getVideoModuleDef('loopback')).toBe(loopbackDef);
  });
});
