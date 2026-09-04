// packages/web/src/lib/ui/modules/gamepad-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for GAMEPAD's faceplate.
//
// The registry-driven sweeps (`module-face-lint`, `shell-cells`,
// `param-vocabulary`, `face-rack-status-source`, `faces-parity`) enrol this
// module automatically and ask GENERIC questions: does every key resolve, does
// every cell operate, does the declared body role hold. This file asks the ones
// that are only true of THIS module — the ones that, if they silently stopped
// being true, would leave every one of those sweeps green.
//
// ⚠ EACH ASSERTION HERE EXISTS BECAUSE A PLAUSIBLE EDIT WOULD DEFEAT IT
// QUIETLY, and the comment on each says which edit.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import {
  GAMEPAD_OUTPUTS,
  GAMEPAD_SLOT_MAX,
  GAMEPAD_SLOT_MIN,
  GAMEPAD_SLOT_OPTIONS,
  gamepadDef,
  newCalibrationSweep,
  recordCalibrationSample,
} from '$lib/audio/modules/gamepad';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { paramCellKind, SEGMENTED_MAX_OPTIONS } from '$lib/ui/workflow/shell-control-kind';
import { dockFacePlan, dockPlanControls, laneOrder, curatedFace } from '$lib/ui/workflow/curated-face';
import { glyphBinding } from '$lib/ui/workflow/shell-glyph-live';
import {
  EXEMPT_FROM_VRT,
  ALLOWED_PERMANENT_EXEMPT,
} from '../../../../../../e2e/vrt/vrt-exemptions';
import {
  PAD_PX,
  dotX,
  dotY,
  sweepBox,
  padDetail,
  remapSentence,
  stickSentence,
} from './gamepad/gamepad-board-model';

const BODY = fileURLToPath(new URL('./gamepad/GamepadMappingBody.svelte', import.meta.url));
const read = (p: string) => readFileSync(p, 'utf8');

const FACE = () => gamepadDef.face!;
const SLOT = () => gamepadDef.params!.find((p) => p.id === 'padIndex')!;

describe('gamepad face — the promotion itself', () => {
  it('is PROMOTED, not merely authored', () => {
    // An authored `face` that is not in STRICT_FACES is INERT: it ships as a
    // no-op while looking complete, because `migrated()` is what decides which
    // component the player actually operates.
    expect(gamepadDef.face, 'a face is declared').toBeTruthy();
    expect(STRICT_FACES.has('gamepad'), 'and it is promoted').toBe(true);
  });

  it('declares `glyph: none`, and the ANTECEDENT is proved rather than the literal asserted', () => {
    // ⚠ NOT A PREFERENCE. Every live glyph binding short-circuits on
    // `primaryAudioOutPortId`, which matches `type === 'audio'` EXACTLY. This
    // module has eighteen outputs — six `cv`, twelve `gate` — so that resolves
    // null and every other glyph literal falls through to `{ kind: 'static' }`,
    // which module-face-lint's dead-glyph clause reddens unconditionally.
    //
    // The second and third expectations are what make this a PROOF rather than
    // a restatement: the premise (no audio output) and the consequence (the
    // resolver really does return the non-static kind for `none`) are both read
    // off the live def and the live resolver. If someone added an audio output
    // tomorrow, a `scope` glyph would become legal and THIS test would tell
    // them, instead of the literal silently staying right for a stale reason.
    expect(FACE().glyph).toBe('none');
    expect(
      gamepadDef.outputs.some((o) => o.type === 'audio'),
      'no audio output exists for a live glyph to bind to',
    ).toBe(false);
    // ⚠ RUN AGAINST THE COUNTERFACTUAL, not against the shipped def. Asking
    // `glyphBinding` about THIS def returns `'none'`, because the resolver
    // short-circuits on the declaration — which proves nothing about why the
    // declaration is right. The claim is "any OTHER glyph would be DEAD here",
    // so the thing to resolve is the same def wearing one.
    for (const glyph of ['scope', 'meter', 'waveform'] as const) {
      const wearing = { ...gamepadDef, face: { ...FACE(), glyph } };
      expect(
        glyphBinding(wearing as never).kind,
        `'${glyph}' on this def resolves to a live binding — the 'none' literal may be stale`,
      ).toBe('static');
    }
  });

  it('declares NO hero, NO pages and NO tab rail — nothing is padded', () => {
    // ⚠ A HERO WOULD EMPTY THE ONLY BAND. `heroFacePlan` MOVES a key out of its
    // band rather than duplicating it, and this face has exactly one ranked key,
    // so promoting it would leave a band with no controls — dropped, along with
    // anywhere its hint could render. The rail engages at DOCK_TAB_MIN_BANDS = 7
    // and `face.tabbed` is owner-instruction-only.
    expect(FACE().hero).toBeUndefined();
    expect(FACE().pages).toBeUndefined();
    expect(FACE().tabbed).toBeUndefined();
    expect(dockFacePlan(gamepadDef as never)?.length, 'one unlabelled band').toBe(1);
  });

  it('ranks exactly the params the def declares — DERIVED, never a re-typed list', () => {
    // The face's `order` is built from `GAMEPAD_SLOT_PARAM.id`. This is the
    // assertion that would catch a second param being added to the def and NOT
    // ranked — which module-face-lint also catches, but here with the reason
    // that this module's completeness is NOT vacuous: it has a param, unlike
    // the meta modules whose completeness sweeps probe an empty set.
    expect([...FACE().order]).toEqual(gamepadDef.params!.map((p) => p.id));
    expect(gamepadDef.params!.length, 'the sweep above is not vacuous').toBeGreaterThan(0);
  });
});

describe('gamepad face — the SLOT cell is SELECTABLE, and PRESENT at every tier', () => {
  it('resolves SEGMENTED at the dock — read off the RESOLVER, not inferred', () => {
    // ⚠ "four options ≤ SEGMENTED_MAX_OPTIONS, so it is segmented" is an
    // INFERENCE. `paramCellKind` has earlier branches (`momentary`, a declared
    // `paramCells` kind, `looksLikeToggle`) and any of them could claim this
    // param first, so the resolver is CALLED.
    expect(paramCellKind(SLOT(), new Set(), 'dock', new Map())).toBe('segmented');
    expect(GAMEPAD_SLOT_OPTIONS.length).toBeLessThanOrEqual(SEGMENTED_MAX_OPTIONS);
  });

  it('THE TRAP THIS ROSTER EXISTS FOR: without it the dock cell would be a KNOB', () => {
    // ⚠ THE POSITIVE CONTROL, and it is the whole reason the roster is on the
    // def. A `0..3 discrete` param drawn as a dial has FOUR reachable positions
    // across the entire travel, so every drag lands on a quantisation boundary
    // and the control is INERT while every def-reading gate stays green —
    // `moog962` shipped exactly that and `faces-parity` failed it twice. Same
    // param, roster removed: the resolver falls back to a knob.
    const { options: _drop, ...bare } = SLOT();
    expect(
      paramCellKind(bare as never, new Set(), 'dock', new Map()),
      'the roster is load-bearing — deleting it silently returns the inert dial',
    ).toBe('knob');
  });

  it('the SLOT cell survives to every LANE tier — the `joystick` guard', () => {
    // ⚠ #1974 IS THE FAILURE THIS PREVENTS. `joystick`'s only control is an
    // `xy` pad; `laneOrder` drops a declared `hero.cell` and each xyPads entry's
    // `x` key, so EVERY lane tier resolved to zero controls — a title, a patch
    // panel, and nothing to touch. This face declares neither construct, and
    // this is what says so mechanically rather than by reading the declaration.
    expect([...laneOrder(FACE())]).toEqual(['padIndex']);
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      const face = curatedFace(gamepadDef as never, tier);
      expect(face, `a face resolves at the '${tier}' tier`).not.toBeNull();
      expect(
        face!.controls.map((c) => c.key),
        `the SLOT cell is present at the '${tier}' tier`,
      ).toContain('padIndex');
    }
    expect(dockPlanControls(dockFacePlan(gamepadDef as never) ?? []).map((c) => c.key)).toEqual([
      'padIndex',
    ]);
  });

  it('the roster is DENSE and therefore must NOT declare `optionsExhaustive`', () => {
    // ⚠ THE SPEC THIS FACE WAS BUILT FROM PRESCRIBED `optionsExhaustive: true`
    // HERE, AND IT WOULD HAVE BEEN RED. `param-vocabulary.test.ts` refuses a
    // redundant declaration BY NAME: "roster covers every step (4/4), so
    // optionsExhaustive is redundant — delete it". The sparse form exists for a
    // param whose GAPS are meaningless (midiclock's divisor names 5 of 24
    // reachable values); every slot here is legal, so the roster covers the span
    // and the ordinary every-step rule is satisfied instead.
    const steps = Math.round(GAMEPAD_SLOT_MAX - GAMEPAD_SLOT_MIN) + 1;
    expect(GAMEPAD_SLOT_OPTIONS.length, 'one option per reachable step').toBe(steps);
    expect(SLOT().optionsExhaustive, 'a dense roster may not claim the exemption').toBeUndefined();
  });

  it('the roster is DERIVED from the span, and the labels are the states\' own values', () => {
    // ⚠ NEVER FABRICATE SEMANTICS. There is no device roster behind these — the
    // Gamepad API says nothing about which controller is in which slot until you
    // select one and read `pad.id` back — so the only honest labels are the
    // indices themselves, which is also what the legacy card's four buttons
    // print. A future author tempted to write 'Player 1'…'Player 4' would be
    // inventing a fact the platform does not provide.
    expect(GAMEPAD_SLOT_OPTIONS.map((o) => o.value)).toEqual([0, 1, 2, 3]);
    expect(GAMEPAD_SLOT_OPTIONS.map((o) => o.label)).toEqual(['0', '1', '2', '3']);
    expect(SLOT().min).toBe(GAMEPAD_SLOT_MIN);
    expect(SLOT().max).toBe(GAMEPAD_SLOT_MAX);
  });

  // ⚠ TWO CARD-SOURCE LEGS STOOD HERE, and both are unspellable now.
  //
  //   * "the CARD renders the DEF's roster — one place, not two". The backdraft
  //     class applied to a roster: the card used to carry `{#each [0,1,2,3] …}`,
  //     which would have silently disagreed with the def the day a fifth slot
  //     became legal. The segmented cell resolves its options straight off the
  //     ParamDef, so there is no second roster to disagree — and the def's own
  //     `GAMEPAD_SLOT_OPTIONS` is asserted above.
  //   * "the SLOT write goes through `setNodeParam`". A LIVE DEFECT: the card
  //     wrote `patch.nodes[id].params.padIndex = …` with no `ydoc.transact` and
  //     no `LOCAL_ORIGIN`, so the change synced to collaborators but never
  //     reached the UndoManager and Cmd-Z could not undo a slot change. The
  //     face's segmented cell commits through `shell-param-writes`, which IS
  //     `setNodeParam`; the bare-proxy form has no module-local place left, and
  //     `mutate.guard.test.ts` holds the rule tree-wide.
  //
  // NAMED: the module-local witness for that raw write is gone with the file
  // that carried it.
});

describe('gamepad face — the MAPPING BODY', () => {
  it('is declared by id and resolves to a real file', () => {
    expect(FACE().extension).toBe('gamepad');
    expect(read(BODY).length, 'the body source is readable').toBeGreaterThan(0);
  });

  it('⚠ THE SPEAKABLE LEG, ASSERTED ABOUT THE REAL STRINGS — with BOTH negative controls', () => {
    // The shared gate (`face-rack-status-source`) refuses an `aria-label={EXPR}`
    // whose SAME EXPRESSION is also painted as a text node. Its predicate is
    // expression IDENTITY, so it clears `aria-label={ledSentence(b)}` whatever
    // that function returns — the compliance argument rests on the sentence
    // genuinely DIFFERING IN CONTENT from the caption, which nothing mechanical
    // can see. This is that leg, run against the strings themselves.
    for (const btn of GAMEPAD_OUTPUTS) {
      const sentence = remapSentence({
        outputId: btn.id,
        caption: btn.label,
        role: `the ${btn.id} gate output`,
        bindings: {},
        armed: false,
        gestures: 'Right-click to rebind it, alt-click to reset it.',
      });
      expect(sentence, `${btn.id}: the accessible name restates only the caption`).not.toBe(
        btn.label,
      );
      expect(sentence.length, `${btn.id}: the name says more than the tile does`).toBeGreaterThan(
        btn.label.length + 20,
      );
    }

    // DIRECTION 1 — the body does not paint an expression it also announces.
    // Same predicate the shared gate runs, called here so this module checks
    // itself even if the roster entry were ever removed.
    const src = read(BODY);
    const painted = new Set(
      [...src.matchAll(/>\s*\{\s*([^}]+?)\s*\}/g)].map((m) => m[1]!.trim()),
    );
    const announced = [...src.matchAll(/aria-label=\{([^}]+)\}/gs)].map((m) => m[1]!.trim());
    expect(announced.length, 'the body sets accessible names at all').toBeGreaterThan(0);
    expect(
      announced.filter((a) => painted.has(a)),
      'an accessible name is ALSO painted — the resting-text violation wearing the ruling\'s '
        + 'own mechanism as a disguise',
    ).toEqual([]);

    // DIRECTION 2 — the SAME predicate FIRES on the offence. Without this the
    // clause above would pass identically against a body that set no
    // accessible names at all, or against a regex that matched nothing.
    const offender = '<button aria-label={btn.label}>{btn.label}</button>';
    const offPainted = new Set(
      [...offender.matchAll(/>\s*\{\s*([^}]+?)\s*\}/g)].map((m) => m[1]!.trim()),
    );
    const offAnnounced = [...offender.matchAll(/aria-label=\{([^}]+)\}/gs)].map((m) =>
      m[1]!.trim(),
    );
    expect(offAnnounced.filter((a) => offPainted.has(a))).toEqual(['btn.label']);
  });

  it('imports StatusLed and mounts NO raster surface — the two-predicate situation, asserted', () => {
    // ⚠ THIS BODY SATISFIES **TWO** ROLE PREDICATES. Four lamps mean
    // `status-primitive` holds as well as `control-grid`, which is legal (the
    // gate checks the DECLARED role only) but reads as a mislabelling to anyone
    // who checks the other predicate first. Pinned here so it is a stated fact
    // rather than a surprise — and so a future raster surface is caught HERE as
    // well as by the shared roster, which is the edit that would flip the role
    // to `picture` and hide every mark this body draws from every source gate.
    const src = read(BODY);
    expect(src).toContain('StatusLed');
    expect(/<canvas/.test(src), 'a raster surface would flip the declared role').toBe(false);
    expect(/getContext\(/.test(src), 'and so would acquiring a drawing context').toBe(false);
  });

  it('carries the file input and the Escape teardown the card owned', () => {
    // STOP 2, at source. `load mapping` is the module's only DATA-IN path that
    // is not a gesture on the device itself, and `Escape` is the only way out of
    // an armed remap other than waiting out the timeout. Both lived on the card,
    // which promotion stops rendering — and a body that added a window listener
    // without removing it is the node-resource-leak class from the other side.
    const src = read(BODY);
    expect(src).toContain("type=\"file\"");
    expect(src).toContain('accept=".json,application/json"');
    expect(src).toContain("addEventListener('keydown'");
    expect(src).toContain("removeEventListener('keydown'");
    expect(src).toContain('cancelAnimationFrame');
  });

  it('paints NO resting derived text — the six rows the card had are gone', () => {
    // Source-level, because `face-resting-text-source` reads FACE FIELDS and is
    // blind to a body's markup by its own admission, and the dock VRT budget
    // (DOCK_MAX_DIFF = 1500 px) is larger than a short string, so text drift can
    // pass a pixel gate. Each literal below is one row of the census.
    const src = read(BODY);
    for (const gone of ['calibrated<', '>calibrated', 'toFixed(', 'mappingStatus', 'title={']) {
      expect(src.includes(gone), `the body still carries \`${gone}\``).toBe(false);
    }
    // …and the POSITIVE control: the things that MAY paint still do, so this is
    // not passing because the body renders nothing.
    expect(src).toContain('save mapping');
    expect(src).toContain('set center');
    expect(src).toContain('{btn.label}');
  });
});

describe('gamepad — the sweep EXTENT is a picture of the deleted readout', () => {
  it('a fresh sweep has NO box — an empty accumulator draws nothing', () => {
    expect(sweepBox(newCalibrationSweep())).toBeNull();
  });

  it('the box GROWS with the sweep and reaches the pad edges at full travel', () => {
    // ⚠ THE INSTRUMENT'S OWN NEGATIVE CONTROL, in both directions: a partial
    // sweep must be strictly SMALLER than a full one, or the picture would be
    // invariant to the thing it claims to show — which is exactly the shape of a
    // gate that reads clean while measuring nothing.
    const partial = newCalibrationSweep();
    recordCalibrationSample(partial, -0.5, -0.5);
    recordCalibrationSample(partial, 0.5, 0.5);
    const small = sweepBox(partial)!;
    expect(small).not.toBeNull();

    const full = newCalibrationSweep();
    recordCalibrationSample(full, -1, -1);
    recordCalibrationSample(full, 1, 1);
    const big = sweepBox(full)!;

    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
    // Full travel IS the pad: left/top at the origin, spanning the whole box.
    expect(big.left).toBeCloseTo(0, 6);
    expect(big.top).toBeCloseTo(0, 6);
    expect(big.width).toBeCloseTo(PAD_PX, 6);
    expect(big.height).toBeCloseTo(PAD_PX, 6);
  });

  it('the box is in the DOT\'s coordinate system, Y flip included', () => {
    // The claim that makes the picture readable at all: the box and the dot are
    // drawn from the same mapping, so "the dot reached the corner" and "the box
    // reached the corner" are the same event. `dotY` flips sign (+1 is UP), so
    // the sweep's MAX-Y is the box's TOP.
    const s = newCalibrationSweep();
    recordCalibrationSample(s, -0.25, -0.75);
    recordCalibrationSample(s, 0.5, 0.25);
    const box = sweepBox(s)!;
    expect(box.left).toBeCloseTo(dotX(-0.25), 6);
    expect(box.left + box.width).toBeCloseTo(dotX(0.5), 6);
    expect(box.top).toBeCloseTo(dotY(0.25), 6);
    expect(box.top + box.height).toBeCloseTo(dotY(-0.75), 6);
  });

  it('the four deleted DECIMALS survive on the pad\'s accessible name', () => {
    // ⚠ "Deleting a readout deletes a FINDING." The card printed
    // `x [-0.98, 0.97] · y [-1.00, 0.86]` during a sweep; the finding is "have I
    // swept far enough", and its SIGHTED channel is now the box above. The
    // ARITHMETIC still has to be assertable somewhere, and this is where.
    const s = newCalibrationSweep();
    recordCalibrationSample(s, -0.98, -1);
    recordCalibrationSample(s, 0.97, 0.86);
    const said = stickSentence({ stick: 'left', x: 0, y: 0, calibrated: false, sweep: s });
    for (const n of ['-0.98', '0.97', '-1.00', '0.86']) {
      expect(said, `the sweep bound ${n} is unassertable`).toContain(n);
    }
    // And at rest, with no sweep, the pad says which stick it is and whether it
    // is calibrated — never a number the player did not ask for.
    const resting = stickSentence({ stick: 'right', x: 0, y: 0, calibrated: true, sweep: null });
    expect(resting).toContain('right stick');
    expect(resting).toContain('Calibrated');
  });
});

describe('gamepad — the VRT drain', () => {
  it('is drained from BOTH lists, and the anchor holds in both directions', () => {
    // ⚠ A ONE-SIDED DELETE IS RED IN `vrt-meta.test.ts`, which is what makes a
    // drain a two-line edit rather than a policy discussion. Restated here with
    // the reason, because this module's exemption is the one whose PREMISE was
    // true and whose CONCLUSION did not follow.
    expect('gamepad' in EXEMPT_FROM_VRT, 'the card scene is captured now').toBe(false);
    expect(ALLOWED_PERMANENT_EXEMPT.has('gamepad'), 'no stale licence left behind').toBe(false);
  });

  it('the DISCONNECTED surface is a pure function of the code — the drain\'s premise', () => {
    // The exemption said the live `navigator.getGamepads()` poll defeats
    // deterministic capture. The poll IS live; its OUTPUT on a runner with no
    // controller is a constant, and the constant is what the baseline sees:
    // every one of the eighteen values is 0, so both dots sit at pad centre and
    // both trigger fills are zero-width. Asserted through the SAME mapping the
    // body draws with, so a change to `dotX`/`dotY` that moved the resting
    // picture would redden here before a baseline drifted.
    expect(dotX(0)).toBeCloseTo(PAD_PX / 2, 6);
    expect(dotY(0)).toBeCloseTo(PAD_PX / 2, 6);
    expect(padDetail(false, '')).toContain('press a button');
    // And the connected sentence is DIFFERENT, so the lamp's detail is not a
    // constant that happens to read correctly in the state CI can reach.
    expect(padDetail(true, 'Xbox Wireless Controller')).toContain('Xbox Wireless Controller');
  });
});
