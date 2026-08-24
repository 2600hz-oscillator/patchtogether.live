// packages/web/src/lib/ui/modules/picturebox-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the PICTUREBOX faceplate.
//
// Everything here is a claim the shipped face MAKES and that no pixel gate can
// check. Two of them are unusual enough to say why up front:
//
//   1. THE FACE RANKS ONE PARAM OUT OF THREE, and the other two are allowed to
//      carry no control only because the def declares them `noUserControl`.
//      That declaration is the single thing standing between this faceplate and
//      two continuous rotaries painted over a raw V/oct cache and a raw gate
//      level. `no-user-control.test.ts` sweeps the whole registry for
//      soundness; what it does NOT do is prove the escape hatch can still say
//      NO for THIS def — so the M3 block below drives the completeness rule
//      against a mutated copy in both directions rather than assuming it.
//
//   2. THE LANE PICTURE IS THE MODULE. A video def is REQUIRED to declare
//      `glyph: 'none'`, which makes "none + blank tile" and "none + live thumb"
//      indistinguishable from the declaration alone. On a module that is
//      nothing but a picture, a blank tile would be the entire module missing
//      from the lane — so the OTHER seam is asserted, the one that paints.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { pictureboxDef } from '$lib/video/modules/picturebox';
import { ASSET_SLOTS, ASSET_SLOT_LABELS } from '$lib/video/asset-select';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  noUserControlIds,
  noUserControlProblems,
  NO_USER_CONTROL_WHY_MIN,
} from '$lib/ui/workflow/no-user-control';
import type { NoUserControlDefLike } from '$lib/graph/types';
import {
  resolvePushCardControls,
  pushCardParams,
  type PushCardDefLike,
} from '$lib/control/push2/push-card-schema';
import { listExposableControls } from '$lib/graph/group-controls';

const def = pictureboxDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const bodySource = readFileSync(resolve(HERE, 'picturebox/PictureboxAssetsBody.svelte'), 'utf8');
const cardSource = readFileSync(resolve(HERE, 'PictureboxCard.svelte'), 'utf8');

// ⚠ THE CODE-ONLY VIEWS, AND THIS FILE NEEDED THEM ON ITS FIRST RUN — the
// fourth instance of the class `strip-source-comments.ts` was written for. Three
// legs below forbid a construct (`oncontextmenu`, `min={0} max={2}`, a `data:`
// preview URL) and the natural way to WRITE DOWN why is to quote it, so both
// files' own explanations were flagged as the offence. A raw grep cannot tell
// code from a comment; the shared quote-aware stripper can, and it handles the
// `<!-- … -->` markup comments in a `.svelte` file that no TS-based tool sees.
const bodyCode = stripSourceComments(bodySource);
const cardCode = stripSourceComments(cardSource);

/** The LIVE `ParamDef` — `FaceDefLike` narrows params to what curation reads,
 *  so min/max/curve are unreachable through `def.params`. */
function param(id: string) {
  const p = pictureboxDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`picturebox has no param '${id}'`);
  return p;
}

describe('picturebox face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('picturebox')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still has a live picture", () => {
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def)).toBe(true);
  });

  it('owns a fullViewBody extension — without it the module has NO input path', () => {
    // ⚠ This is a STOP-2 assertion, not decoration. Every route into this
    // module is an `<input type="file">`: one "Choose image…" plus one per slot.
    // No `ParamCellKind` mounts a file input, so a promotion without the
    // extension would ship a picture source that can never be given a picture.
    expect(def.face?.extension).toBe('picturebox');
    expect(bodyCode).toMatch(/<input\s+type="file"/);
  });
});

describe('picturebox face — the tier ladder, and why it is ONE control', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('every tier shows exactly GAIN — the module has one control and says so', () => {
    // Read back as a sentence: at every tier you get the picture, and past mini
    // you also get gain. That is the whole ladder because that is the whole
    // module. A face with one control should look like a face with one control.
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      expect(keysAt(tier), `tier ${tier}`).toEqual(['gain']);
    }
  });

  it('the two synthetic params reach NO tier — this is the whole point of the declaration', () => {
    // The failure this forbids is concrete: an undeclared `asset_pitch` renders
    // as a continuous rotary over a raw V/oct cache, and `asset_gate` as one
    // over a raw gate level. Both would be turnable, and both would be stomped
    // by the next bridge write.
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      expect(keysAt(tier), `tier ${tier}`).not.toContain('asset_pitch');
      expect(keysAt(tier), `tier ${tier}`).not.toContain('asset_gate');
    }
  });

  it('declares NO pages, so no tab rail is manufactured', () => {
    // The owner's control-heavy ruling is about many controls of DIFFERENT
    // types. One knob is not that, and padding to seven bands to earn a rail is
    // the anti-pattern the same ruling names.
    expect(def.face?.pages).toBeUndefined();
  });

  it("GAIN is a FADER, because unity is at the MIDDLE of a 0..2 throw", () => {
    // Nothing in a ParamDef separates "a level" from any other continuous
    // scalar, so an undeclared cell resolves to a KNOB and silently swaps a dial
    // in for the throw the card has always drawn — invisibly to every
    // def-reading gate.
    expect(def.face?.paramCells?.gain).toBe('fader');
    const gain = param('gain');
    expect(gain.min).toBe(0);
    expect(gain.max).toBe(2);
    expect(gain.defaultValue).toBe(1);
    // The landmark claim itself: unity really is the midpoint of the throw.
    expect((gain.defaultValue - gain.min) / (gain.max - gain.min)).toBeCloseTo(0.5, 10);
  });
});

describe('M3 — the noUserControl declaration, driven in BOTH directions', () => {
  const nucDef = pictureboxDef as unknown as NoUserControlDefLike;

  it('declares exactly the two synthetic params, and neither is ranked', () => {
    expect([...noUserControlIds(nucDef)].sort()).toEqual(['asset_gate', 'asset_pitch']);
    // Deny-by-default is intact only if the OTHER direction holds too: a param
    // in BOTH the declaration and face.order is a lie, and lint reddens it.
    for (const id of noUserControlIds(nucDef)) {
      expect(def.face?.order ?? [], `${id} must not be ranked`).not.toContain(id);
    }
    // …and the ranked key is not declared, so `gain` still needs its cell.
    expect(noUserControlIds(nucDef).has('gain')).toBe(false);
  });

  it('the declaration is SOUND against picturebox\'s own ports (positive control)', () => {
    expect(noUserControlProblems(nucDef)).toEqual([]);
  });

  it('every param is EITHER ranked OR declared — nothing falls through', () => {
    // The completeness rule module-face-lint applies, re-derived here so this
    // file fails on a param ADDED to picturebox that nobody ranked or declared.
    const ranked = new Set(def.face?.order ?? []);
    const declared = noUserControlIds(nucDef);
    const orphans = pictureboxDef.params
      .map((p) => p.id)
      .filter((id) => !ranked.has(id) && !declared.has(id));
    expect(
      orphans,
      'a param that is neither ranked nor declared noUserControl would render a ' +
        'control the player can turn to no effect',
    ).toEqual([]);
  });

  // ── the instrument's own negative controls ────────────────────────────────
  //
  // ⚠ WITHOUT THESE, THE THREE LEGS ABOVE READ IDENTICALLY GREEN whether the
  // resolver is checking anything or is invariant to the thing under test. Each
  // one perturbs exactly one dimension of the declaration and requires the
  // problem list to NAME it.

  it('REJECTS a declaration naming a param that does not exist', () => {
    const problems = noUserControlProblems({
      ...nucDef,
      noUserControl: [{ param: 'not_a_param', writer: 'cv-port', why: 'x'.repeat(40) }],
    } as NoUserControlDefLike);
    expect(problems.join('\n')).toMatch(/not a ParamDef/);
  });

  it("REJECTS writer 'internal' on a param a port DOES target", () => {
    // The direction that matters for THIS def: both synthetic params have a
    // matching `paramTarget` input, so 'cv-port' is the only legal value and
    // 'internal' must be refused. If the resolver were blind to the ports, this
    // would pass and the declaration would be describing a wiring the engine
    // does not have.
    const problems = noUserControlProblems({
      ...nucDef,
      noUserControl: [
        { param: 'asset_gate', writer: 'internal', why: 'y'.repeat(40) },
      ],
    } as NoUserControlDefLike);
    expect(problems.join('\n')).toMatch(/says writer 'internal' but input port\(s\)/);
  });

  it("REJECTS writer 'cv-port' on a param NO port targets", () => {
    // The mirror image, driven against `gain`'s def with its CV input removed —
    // so the fixture is picturebox-shaped rather than invented.
    const problems = noUserControlProblems({
      ...nucDef,
      inputs: pictureboxDef.inputs.filter((p) => p.paramTarget !== 'gain'),
      noUserControl: [{ param: 'gain', writer: 'cv-port', why: 'z'.repeat(40) }],
    } as unknown as NoUserControlDefLike);
    expect(problems.join('\n')).toMatch(/NO input port declares/);
  });

  it('REJECTS a thin `why`, and picturebox\'s own two clear the bar with room', () => {
    const problems = noUserControlProblems({
      ...nucDef,
      noUserControl: [{ param: 'asset_gate', writer: 'cv-port', why: 'hidden' }],
    } as NoUserControlDefLike);
    expect(problems.join('\n')).toMatch(/needs a real 'why'/);
    // ⚠ Check the SLACK, not just the pass: a `why` sitting one character over
    // the floor is a prose-quality claim nobody is making.
    for (const e of pictureboxDef.noUserControl ?? []) {
      expect(e.why.trim().length, `${e.param} why length`).toBeGreaterThan(
        NO_USER_CONTROL_WHY_MIN * 3,
      );
    }
  });
});

describe('⚠ THE TWO BEHAVIOUR CHANGES OUTSIDE THE FACEPLATE', () => {
  // `noUserControl` has consumers beyond `module-face-lint`, and both of them
  // change what a PLAYER sees on a surface that has nothing to do with the dock.
  // Both are improvements — neither surface should ever have offered a raw gate
  // cache as a knob — but "improvement" is a claim, and an unasserted claim in a
  // PR body is how a behaviour change ships unnoticed. Neither consumer has a
  // golden covering picturebox, so these are the only gates on them.

  it('the PUSH 2 card drops the two synthetic params', () => {
    const spec = resolvePushCardControls(pictureboxDef as unknown as PushCardDefLike, {});
    const ids = pushCardParams(spec).map((p) => p.id);
    expect(ids, 'GAIN is the only thing worth an encoder here').toEqual(['gain']);
    // picturebox has no explicit `PUSH_CARD_CONTROLS` entry, so the card is
    // resolved from the LIVE def — and authoring the face moved it from the
    // GENERIC tier to the FACE tier, which is the whole re-rank.
    expect(spec.source).toBe('face');
  });

  it('…and WITHOUT the two declarations it would have put them under encoders (the counterfactual)', () => {
    // ⚠ THE LEG ABOVE IS NOT EVIDENCE ON ITS OWN. `['gain']` is also what you
    // would get from a module that never had the other two params, so it cannot
    // distinguish "the declarations did something" from "there was nothing to
    // do". Re-resolve the SAME def with `face` and `noUserControl` stripped —
    // i.e. picturebox exactly as it shipped yesterday — and require the raw
    // caches to appear on the hardware.
    const before = resolvePushCardControls(
      { ...(pictureboxDef as unknown as PushCardDefLike), face: undefined, noUserControl: undefined },
      {},
    );
    expect(before.source, 'with no face, the generic tier ranks by declaration order').toBe('generic');
    expect(
      pushCardParams(before).map((p) => p.id),
      'this is the state the declarations removed: a raw V/oct cache on encoder 2 and a raw ' +
        'gate level on encoder 3, both turnable, both stomped by the next bridge write',
    ).toEqual(['gain', 'asset_pitch', 'asset_gate']);
  });

  it("a collapsed GROUP's instrument bar stops auto-exposing them", () => {
    const exposed = listExposableControls('picturebox', (t) =>
      t === 'picturebox' ? (pictureboxDef as unknown as { params: typeof pictureboxDef.params }) : undefined,
    ).map((c) => c.paramId);
    expect(exposed).toEqual(['gain']);
    // Same counterfactual, same reason: without the declaration the bar offered
    // all three as knobs, which is what #1726's own header describes happening
    // to backdraft's six gate params before it landed.
    const before = listExposableControls('picturebox', () => ({
      params: pictureboxDef.params,
    })).map((c) => c.paramId);
    expect(before).toEqual(['gain', 'asset_pitch', 'asset_gate']);
  });
});

describe('the dock body — the affordances promotion would otherwise delete', () => {
  it('carries the SCREEN switch over the SHARED previewCollapsed key', () => {
    // A second spelling of this key is how it forks: a rack saved before the
    // promotion already carries `previewCollapsed`, and reading a different key
    // would silently re-open every preview collapsed before it.
    expect(bodyCode).toContain('previewCollapsed');
    expect(bodyCode).toMatch(/\.data\.previewCollapsed\s*=/);
  });

  it('KEEPS RENDERING with the screen off — the mark is not dropped', () => {
    // ⚠ THE STAKES ARE HIGHER HERE THAN ON A STATELESS EFFECT, and that is why
    // this is asserted rather than inherited from the posterbox pattern. An
    // animated gif's frame index advances INSIDE `surface.draw` off the engine
    // clock, so a collapsed state that stopped marking the node watched would
    // stop the gif's clock — and switching the screen back on would resume from
    // a stale frame, which is exactly what the ruling forbids.
    expect(bodyCode).toMatch(/markWatched/);
    // …and the loop is not restarted on toggle: one rAF owns both states.
    expect(bodyCode).toMatch(/if \(previewCollapsed\) \{[\s\S]*?markWatched/);
  });

  it('shows the ACTIVE SLOT, not `imageBytes` — the picture is the engine output', () => {
    // ⚠ THE DIFFERENCE IS A WRONG PICTURE, not a style. `imageBytes` is the
    // SINGLE-image field; the displayed slot is local render state the module
    // deliberately never writes to the Y.Doc. An <img> of `imageBytes` would
    // show the wrong picture the moment a gate selected slot 3, and would be
    // blind to GAIN — the one control this face ranks.
    expect(bodyCode).toMatch(/blitOutputForPreview\(nodeId\)/);
    expect(
      bodyCode,
      'the body must not preview node.data.imageBytes through a data: URL',
    ).not.toMatch(/src=\{`data:/);
  });

  it('puts ALL SEVEN slots on screen, with no gesture in front of them', () => {
    // THE DEFECT THE PROMOTION FIXES. On the card, slots 2-7 are behind an
    // `oncontextmenu` toggle nothing advertises. The body binds no context menu
    // at all, which also hands the node its normal right-click menu back.
    expect(bodyCode).toContain('ASSET_SLOT_LABELS');
    expect(bodyCode, 'the body must not bind oncontextmenu').not.toMatch(/oncontextmenu/);
    // …and the CARD still does, which is what makes the line above a real
    // difference rather than a grep that matches nothing anywhere.
    expect(cardCode, 'the card is still the surface with the gesture').toMatch(/oncontextmenu/);
    expect(ASSET_SLOT_LABELS.length).toBe(ASSET_SLOTS);
    // Each slot row must be reachable by its own selector, one per slot.
    expect(bodyCode).toMatch(/picturebox-face-slot-input-\{i\}/);
    expect(bodyCode).toMatch(/picturebox-face-slot-clear-\{i\}/);
  });

  it('does NOT re-emit the card testids — the two surfaces coexist under ?shell=legacy', () => {
    // ⚠ THE SPEC ASKED FOR THE OPPOSITE, and the measurement inverted it. Every
    // picturebox-driving e2e navigates `/rack?shell=legacy`, where the LANE
    // still renders the legacy card. Re-emitting `picturebox-file-input` /
    // `picturebox-card` on the dock body would put two elements with one testid
    // on the same page the moment a spec opened the dock — a strict-mode
    // violation manufactured to save edits that turned out not to be needed.
    for (const id of ['picturebox-card', 'picturebox-file-input', 'picturebox-preview']) {
      expect(bodyCode, `body re-emits ${id}`).not.toContain(`"${id}"`);
    }
    // …and the card still owns them, so the specs that drive them keep working.
    expect(cardCode).toContain('picturebox-file-input');
    expect(cardCode).toContain('picturebox-card');
  });

  it('renames the panel testid rather than carrying a name that stopped being true', () => {
    // `picturebox-multi-panel` named a panel whose defining property was that it
    // was HIDDEN behind a right-click. On an always-visible body the name would
    // be a lie, so the rename is the signal.
    expect(bodyCode).toContain('picturebox-assets-body');
    expect(bodyCode).not.toContain('picturebox-multi-panel');
  });
});

describe('the REMOVED readout, and where its finding went', () => {
  it('the face paints NO sync hint — it is a state word and a measurement', () => {
    // ⚠ DELETING A READOUT DELETES A FINDING, so this names the one that lost
    // its painted surface: the card's `gif` / `synced (1024×768)` line is the
    // only place a user learns whether their gif was preserved frame-for-frame
    // or downscaled and re-encoded. Neither is a control caption, an option name
    // or a section label, so neither may paint on a faceplate.
    expect(bodyCode).not.toContain('picturebox-synced');
    expect(bodyCode).not.toMatch(/>\s*\{?\s*isGif\s*\?/);
  });

  it('…and it survives, speakable, on the picture it describes', () => {
    // The ruling's own instruction: the value lives in the accessible
    // description, which is assertable and unpainted.
    expect(bodyCode).toMatch(/aria-label=\{pictureDescription\}/);
    expect(bodyCode).toMatch(/animated gif preserved frame-for-frame/);
    expect(bodyCode).toMatch(/synced at \$\{TARGET_W\}×\$\{TARGET_H\}/);
    // Both branches exist, so the description is not a constant that happens to
    // mention gifs.
    expect(bodyCode).toMatch(/no image loaded/);
  });

  it('the LEGACY CARD keeps its hint — the ruling is faceplate-scoped', () => {
    // ⚠ The build spec said "REMOVED from every surface". CLAUDE.md's rule is
    // explicit that these rulings are about FACEPLATES and "the legacy cards are
    // untouched", and the card is still the lane surface under `?shell=legacy`
    // where two live assertions read this element. Removing it there would break
    // them for a rule that does not reach the card.
    expect(cardCode).toContain('picturebox-synced');
  });
});

describe('the card and the body write through ONE seam', () => {
  it('neither surface hand-rolls the slot pad-and-slice any more', () => {
    // D5: `onSlotFileChange` and `clearSlot` were the same eighteen lines, and
    // this body would have been the third copy. The shared writers are pinned by
    // `$lib/graph/picturebox-data.test.ts`, including the LOCAL_ORIGIN leg that
    // decides whether Cmd-Z works at all.
    for (const [name, src] of [['card', cardCode], ['body', bodyCode]] as const) {
      expect(src, `${name} imports the shared writers`).toContain('$lib/graph/picturebox-data');
      expect(src, `${name} still hand-rolls the pad loop`).not.toMatch(
        /while \(\w+\.length < ASSET_SLOTS\)/,
      );
    }
  });

  it('the CARD no longer re-types the GAIN range (D3, the backdraft class)', () => {
    // It passed `min={0} max={2}` as literals while reading `defaultValue` off
    // the def — the half-bound state, which looks def-bound to a reader. From
    // promotion the dock renders this fader straight off the `ParamDef`, so the
    // second copy would give one control two travels depending on the surface.
    expect(cardCode).toMatch(/paramSpec\(pictureboxDef, 'gain'\)/);
    expect(cardCode).not.toMatch(/min=\{0\}\s+max=\{2\}/);
  });
});
