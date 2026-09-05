// packages/web/src/lib/ui/modules/blood-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the BLOOD faceplate (2026-08-31).
//
// Everything here is a claim the shipped face MAKES and that no pixel gate can
// check — this face has NO VRT scenes at all (`FACES_WITHOUT_SCENES`), so this
// file, `blood-boot.test.ts` and the e2e legs are the whole of its coverage.
// That raises the bar rather than lowering it: each block says what it would
// look like if it were wrong.
//
// ⚠ THE SHARPEST LEG IN THIS FILE IS THE BOOT ONE, and it is a SOURCE probe on
// purpose. `extras.ensureLoaded()` is what starts the Build engine; before this
// promotion it had exactly ONE caller in the tree and it was `BloodCard.svelte`,
// which the shipping shell stops mounting the moment blood is promoted. blood is
// in neither half of `HEADLESS_MOUNT_LANE_TYPES`, so nothing else keeps that
// card alive. A body that failed to boot would leave a module DARK FOREVER with
// every def-reading gate green — the def is unchanged, the registry is
// unchanged, the shader still compiles and still paints its "alive, no signal"
// scanline field. So the boot is asserted THREE ways, deliberately overlapping:
// here at the source, in `blood-boot.test.ts` at the seam, and in the browser by
// `blood-face-screen.spec.ts` plus the default-shell leg of
// `blood-audio-output.spec.ts`. A source probe alone can be satisfied by a body
// that imports the boot and never calls it, which is why the runtime legs exist;
// a runtime leg alone cannot say WHICH surface booted, which is why this one
// does.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bloodDef } from '$lib/video/modules/blood';
import { CV_GATE_PORT_IDS } from '$lib/blood/blood-keys';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { noUserControlIds, cvWritersOf } from '$lib/ui/workflow/no-user-control';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';

const def = bloodDef as unknown as FaceDefLike & { type: string };
const HERE = dirname(fileURLToPath(import.meta.url));

/** The LIVE `ParamDef` — `FaceDefLike` narrows params to `FaceParamLike`, which
 *  projects only what curation reads, so min/max/curve/options are unreachable
 *  through `def.params`. (svelte-check catches this; vitest does not.) */
function param(id: string) {
  const p = bloodDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`blood has no param '${id}'`);
  return p;
}

/**
 * ⚠ EVERY SOURCE PROBE IN THIS FILE READS COMMENT-STRIPPED TEXT, and it is not
 * hygiene — it is the only way these probes can be true.
 *
 * The body's own header EXPLAINS what it must not do ("never
 * `getContext('webgl')` in this file") and QUOTES the readout it deleted
 * ("Running — click + use arrows/Ctrl/Space"), because a body carrying a
 * hand-written keyboard host needs those warnings more than most. A raw grep
 * reads the explanation as the offence — which it duly did on this file's first
 * run, the fourth recorded instance of the failure `strip-source-comments.ts`
 * was written for. The negative controls below are what keep the stripping from
 * hiding a real offence instead.
 */
function bodySrc(): string {
  return stripSourceComments(
    readFileSync(resolve(HERE, 'blood/BloodScreenBody.svelte'), 'utf8'),
  );
}
/**
 * The body's CODE with runs of whitespace collapsed — for the two PROXIMITY
 * probes below ("`markWatched` is inside the collapsed branch", "`autoBootBlood`
 * is inside `onMount`").
 *
 * ⚠ STRIPPING IS NOT ENOUGH FOR A PROXIMITY PROBE, and this file learned it the
 * expensive way. `stripSourceComments` replaces comment bytes with SPACES
 * deliberately, so line and column offsets do not move — which means a
 * 25-line comment inside the collapsed branch still occupies ~1500 characters
 * of the window, and lengthening one turned a green probe red with a message
 * about the product. The distance that matters is between two pieces of CODE.
 */
function bodyCode(): string {
  return bodySrc().replace(/\s+/g, ' ');
}

describe('blood face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('blood')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' — and this one is a CHOICE, not a forced literal", () => {
    // ⚠ WORTH ASSERTING FOR A REASON THE ACIDWARP/MODTRIS VERSION OF THIS LEG
    // DOES NOT HAVE. On those modules `'none'` is mechanically forced: no
    // `type === 'audio'` output exists, so `primaryAudioOutPortId` is null and
    // every other literal resolves to a dead static binding. blood HAS audio
    // outs, so a `'scope'` glyph would bind to a live analyser tap — and it
    // would still be wrong, because `laneGlyphFor` short-circuits to 'picture'
    // for a video def, so the declared glyph paints NOTHING at any tier while
    // the tap runs. The negative control below is what makes that a real claim.
    expect(def.face?.glyph).toBe('none');
    expect(bloodDef.outputs.some((o) => o.type === 'audio')).toBe(true);
    // …and the tile's picture comes from the OTHER seam, which is what makes
    // 'none' costless here.
    expect(hasVideoSurface(def)).toBe(true);
  });

  it('owns a fullViewBody extension', () => {
    expect(def.face?.extension).toBe('blood');
  });
});

describe('blood face — two controls, one band, no rail', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('ranks GAIN first — the only control anything downstream can hear', () => {
    expect(keysAt('mini')).toEqual(['audioGain']);
    expect(def.face?.order).toEqual(['audioGain', 'fillMode']);
  });

  it('the dock shows both real controls and NONE of the thirteen gate targets', () => {
    expect(keysAt('dock')).toEqual(['audioGain', 'fillMode']);
    for (const base of CV_GATE_PORT_IDS) {
      expect(keysAt('dock'), `cv_${base} must never reach a cell`).not.toContain(`cv_${base}`);
    }
  });

  it('renders exactly the one authored band, and no tab rail', () => {
    const bands = dockFacePlan(def)!;
    expect(bands.map((b) => b.id)).toEqual(['output']);
    expect(bands[0]!.controls.map((c) => c.key)).toEqual(['audioGain', 'fillMode']);
    // DOCK_TAB_MIN_BANDS is 7. One band is not padded toward it — the
    // control-heavy ruling is about modules that HAVE the controls.
    expect(bands.length).toBeLessThan(7);
  });
});

describe('blood — FILL is a free toggle, and the absent roster is deliberate', () => {
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
    // `'toggle'` is not even authorable (`AuthoredParamCell = grid|color|hue|fader`),
    // so a declaration here would not compile; the point of the leg is that
    // nothing was reached for.
    expect(def.face?.paramCells).toBeUndefined();
  });
});

describe('blood — the thirteen gate params are declared, and the claim is checkable', () => {
  it('every `cv_*` param is noUserControl, written by a cv-port', () => {
    const decl =
      (bloodDef as { noUserControl?: readonly { param: string; writer: string }[] })
        .noUserControl ?? [];
    expect(decl.map((d) => d.param).sort()).toEqual(
      CV_GATE_PORT_IDS.map((b) => `cv_${b}`).sort(),
    );
    expect(decl.every((d) => d.writer === 'cv-port')).toBe(true);
  });

  it('⚠ the cv-port claim is ANCHORED — a real port targets each one', () => {
    for (const base of CV_GATE_PORT_IDS) {
      expect(cvWritersOf(bloodDef, `cv_${base}`), `no jack targets cv_${base}`).toEqual([base]);
    }
    // …and the sweep reads real ports, so a hit means something.
    expect(bloodDef.inputs.length).toBe(CV_GATE_PORT_IDS.length);
  });

  it('the two REAL controls are NOT declared away', () => {
    const ids = noUserControlIds(bloodDef);
    expect(ids.has('audioGain')).toBe(false);
    expect(ids.has('fillMode')).toBe(false);
    // Completeness the other way: order ∪ noUserControl covers every param, so
    // nothing on this def is unranked and undeclared.
    const covered = new Set([...(def.face?.order ?? []), ...ids]);
    expect(bloodDef.params.filter((p) => !covered.has(p.id)).map((p) => p.id)).toEqual([]);
  });
});

describe('⚠ blood — the BODY BOOTS THE ENGINE (the promotion hazard)', () => {
  it('the body calls the shared boot on mount', () => {
    const src = bodyCode();
    expect(src.length, 'the probe read an empty/missing component').toBeGreaterThan(2000);
    expect(src).toContain('autoBootBlood');
    expect(
      /onMount\(\(\) => \{ .*?autoBootBlood/.test(src),
      'the faceplate body must boot BLOOD when it mounts. This is the whole promotion hazard: ' +
        'ensureLoaded had one caller in the tree (BloodCard), blood is in neither half of ' +
        'HEADLESS_MOUNT_LANE_TYPES, and a body that does not boot ships a module that is dark ' +
        'forever while every def-reading gate stays green.',
    ).toBe(true);
  });

  it('the surface boots through the SHARED seam — it does not re-implement it', () => {
    // The `livecode` shape. A surface that grew its own `ensureLoaded()` call
    // would have its own idea of what booting means (the IndexedDB restore, the
    // resetLoad ordering) — and when there were two surfaces, only one of them
    // was covered by e2e. That is why this reads the seam import rather than
    // trusting the boot to happen.
    for (const [name, src] of [['body', bodySrc()] as const]) {
      expect(src, `${name} must import the shared boot seam`).toContain('$lib/blood/blood-boot');
      expect(
        /extras\??\.\s*ensureLoaded\(/.test(src),
        `${name} must not call ensureLoaded() directly — go through blood-boot.ts`,
      ).toBe(false);
    }
  });

  it('⚠ NEGATIVE CONTROL: the boot probe can go red', () => {
    const sabotaged = bodyCode().replace(/autoBootBlood/g, 'noopBoot');
    expect(/onMount\(\(\) => \{ .*?autoBootBlood/.test(sabotaged)).toBe(false);
  });
});

describe('blood — the body keeps the parity affordances the card owned', () => {
  it('carries the folder picker, the reset-on-import and the actionable errors', () => {
    const src = bodySrc();
    // The picker is `multiple + webkitdirectory` — point it at a whole Blood
    // folder in one go, which is the gesture the owner actually performs.
    expect(src).toContain('webkitdirectory');
    expect(src).toContain('multiple');
    // The import path (which is where `resetLoad()` lives — see blood-boot.ts).
    expect(src).toContain('importBloodData');
    // Instructions for a gesture: without the build command a local developer
    // cannot act on the not-built state at all.
    expect(src).toContain('BLOOD_LINK=1');
    expect(src).toContain('blood-face-data-missing');
  });

  it('carries the capture-phase keyboard host through the SHARED predicate', () => {
    const src = bodySrc();
    expect(src).toContain('shouldClaimBloodKey');
    // CAPTURE phase, or xyflow's own document keydown wins and the arrows pan
    // the canvas instead of driving the marine.
    expect(/addEventListener\('keydown',\s*onKeyDown,\s*true\)/.test(src)).toBe(true);
    expect(/addEventListener\('keyup',\s*onKeyUp,\s*true\)/.test(src)).toBe(true);
    // ⚠ AND IT IS TORN DOWN. A window listener that outlives its component is a
    // rack-wide key sink — this body is LRU-evicted from the dock like any other.
    expect(/removeEventListener\('keydown',\s*onKeyDown,\s*true\)/.test(src)).toBe(true);
    expect(/removeEventListener\('keyup',\s*onKeyUp,\s*true\)/.test(src)).toBe(true);
    // The frame must be focusable, because focus-within is the WHOLE claim
    // predicate here (the card's `selected` branch has no equivalent in a
    // `{ nodeId }` slot, and never fired in the dock anyway).
    expect(src).toContain('role="application"');
    expect(src).toContain('tabindex="0"');
  });
});

describe('blood — the face DELETES the card\'s resting readout', () => {
  it('the body paints no "Running" state line', () => {
    const src = bodySrc();
    // The card's readout, by its rendered shape. It must not be ported.
    expect(
      /Running — click/.test(src),
      'the card\'s "Running — click + use arrows/Ctrl/Space" state line is a derived state word ' +
        'outside any control; the 2026-08-19 ruling deletes it from a faceplate',
    ).toBe(false);
    // …and the fact it carried is RELOCATED rather than lost: onto the frame's
    // accessible name and onto a data attribute a spec can read.
    expect(src).toContain('data-blood-status');
    expect(src).toContain('aria-label={frameName}');
  });

  it('SCREEN OFF keeps the watch mark BEFORE it returns', () => {
    // #1937 / #2015 — the fleet shape.
    //
    // ⚠ THIS IS THE ONLY GATE ON THAT LINE, AND IT IS A SOURCE GATE. Measured
    // 2026-08-31: deleting the `markWatched` call and re-running
    // `blood-face-screen.spec.ts` leaves it GREEN, because blood is pull-exempt
    // from construction (a non-empty `audioSources` map — `registerDomain`
    // injects the AudioContext whenever both domains exist, which `/rack` always
    // does). So no RUNTIME leg can cover it on this module today. It is kept as
    // topology-independent insurance — `surface.draw` is what calls
    // `runtime.runFrame()`, so on any rack where the exemption did not hold the
    // switch would freeze the SIMULATION — and this assertion is what stops it
    // being deleted as dead code by someone who checked only the runtime legs.
    const code = bodyCode();
    expect(code).toContain('markWatched');
    expect(
      /if \(previewCollapsed\) \{ .{0,120}markWatched/.test(code),
      'SCREEN OFF must keep the watch mark — see the note above for what that is and is not worth',
    ).toBe(true);
  });

  it('⚠ THE BODY IS 2-D — a GL context would enrol it in the attest basis', () => {
    const src = bodySrc();
    expect(src).toContain("getContext('2d'");
    expect(
      /getContext\(\s*'webgl/.test(src) || /getContext\(\s*"webgl/.test(src),
      'a WebGL context in this file enrols it in the WebGL attest basis PERMANENTLY, putting ' +
        'every future edit to it on the real-GPU attest critical path',
    ).toBe(false);
  });

  it('⚠ NEGATIVE CONTROL: the watch-mark probe discriminates', () => {
    const code = bodyCode();
    expect(code).toContain('blood-face-screen-toggle');
    const sabotaged = code.replace(
      /if \(previewCollapsed\) \{ .{0,120}?markWatched[^;]*;/,
      'if (previewCollapsed) {',
    );
    expect(/if \(previewCollapsed\) \{ .{0,120}markWatched/.test(sabotaged)).toBe(false);
  });
});
