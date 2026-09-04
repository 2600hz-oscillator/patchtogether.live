// packages/web/src/lib/ui/modules/tvLibrarian-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the TV LIBRARIAN faceplate.
//
// Everything here is a claim the shipped face MAKES and that no other gate can
// check. Four are unusual enough to say why up front:
//
//   1. THE RANKED CELL IS ONLY HONEST BECAUSE THE SHADER READS `gain`. Face
//      completeness is unconditional, so a face MUST rank `gain` — and until
//      #2189 the shader had no `uGain` and `draw()` never applied it, so
//      ranking it would have painted a dial that does nothing. That is the
//      "green gate certifying a live bug" shape arriving BY PROMOTION. The
//      precursor has landed; this file is what stops it being backed out
//      without the face noticing.
//
//   2. THE GLYPH DECISION IS A REAL ONE HERE, NOT A FORCED ONE, and it is the
//      one place this module differs from every other faced video def.
//      `glyphBinding()` short-circuits on the first `type: 'audio'` OUTPUT, and
//      this def HAS two — so a glyph literal would resolve to a LIVE binding
//      and `module-face-lint`'s dead-glyph clause would NOT catch it. On
//      picturebox or acidwarp the rule enforces itself; here nothing does.
//
//   3. THE BODY MUST NOT ADOPT THE NODE-OWNED `<video>`. A DOM node has one
//      parent and the LEGACY card adopts that element under `?shell=legacy`, so
//      a body that adopted it too would move it out from under that mount. No
//      gate can see this; the body blits the module's own OUTPUT texture
//      instead, and that is asserted at the source.
//
//   4. THE VRT ENTRY RESTS ON THE IDLE PICTURE BEING TIME-INVARIANT. Its
//      argument for a real baseline (rather than a FACES_WITHOUT_SCENES
//      exemption) is that the shader's untuned branch has no clock. If someone
//      adds one, the baseline starts flapping for a reason nobody will attribute
//      — so the claim is pinned where it is made.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { tvLibrarianDef } from '$lib/video/modules/tv-librarian';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  noUserControlIds,
  noUserControlProblems,
} from '$lib/ui/workflow/no-user-control';
import type { NoUserControlDefLike } from '$lib/graph/types';
import {
  resolvePushCardControls,
  pushCardParams,
  type PushCardDefLike,
} from '$lib/control/push2/push-card-schema';

const def = tvLibrarianDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const defSource = readFileSync(
  resolve(HERE, '../../video/modules/tv-librarian.ts'),
  'utf8',
);
const bodySource = read('tvLibrarian/TvLibrarianTunerBody.svelte');
const pickerSource = read('tvLibrarian/TvLibrarianPicker.svelte');

// The code-only views. A raw grep cannot tell code from a comment, and several
// legs below forbid a construct whose natural explanation NAMES it — this file's
// own comments say `nodeMedia.adopt` and `tv-now-playing` out loud.
const bodyCode = stripSourceComments(bodySource);
const pickerCode = stripSourceComments(pickerSource);

/** The LIVE `ParamDef` — `FaceDefLike` narrows params to what curation reads. */
function param(id: string) {
  const p = tvLibrarianDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`tvLibrarian has no param '${id}'`);
  return p;
}

/** The shader body, as the def declares it. */
const fragSrc = /const FRAG_SRC = `([\s\S]*?)`;/.exec(defSource)?.[1] ?? '';

describe('tvLibrarian face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('tvLibrarian')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still has a live picture", () => {
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def)).toBe(true);
  });

  it('the glyph choice is a DECISION, not a forced one — this def HAS audio outputs', () => {
    // ⚠ THE PERMANENT NEGATIVE CONTROL FOR THE DECLARATION'S OWN COMMENT.
    // On every other faced video module the dead-glyph clause enforces 'none'
    // for free, because no `type: 'audio'` output exists and any literal
    // resolves `{kind:'static'}`. Here two do, so a literal would bind LIVE and
    // ship a meter competing with the picture for the tile, green all the way.
    // If these outputs ever go away the comment stops being true, and this leg
    // is what says so.
    const audioOuts = tvLibrarianDef.outputs.filter((o) => o.type === 'audio').map((o) => o.id);
    expect(audioOuts).toEqual(['audio_l', 'audio_r']);
  });

  it('owns a fullViewBody extension — without it the module cannot be TUNED at all', () => {
    // ⚠ A STOP-2 ASSERTION, and a stronger one than camera's or loopback's.
    // Those keep a real card alive off-screen in <HeadlessSourceHost>, so their
    // argument is only that its buttons are unclickable. tvLibrarian left
    // DOM_SOURCE_LANE_TYPES when its stream became node-owned (LEG-02 P3), so
    // under the shell NO card is mounted anywhere: without this body there is no
    // country picker and no channel roster on any surface.
    expect(def.face?.extension).toBe('tvLibrarian');
    expect(bodyCode).toMatch(/<TvLibrarianPicker[\s/>]/);
  });
});

describe('tvLibrarian face — the tier ladder, and why it is ONE control', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('every tier shows exactly GAIN — the module has one control and says so', () => {
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      expect(keysAt(tier), `tier ${tier}`).toEqual(['gain']);
    }
  });

  it('the two synthetic params reach NO tier', () => {
    // The failure this forbids is concrete: an undeclared `cv_next` renders as a
    // continuous rotary over a raw gate level, turnable, and stomped by the next
    // bridge write.
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      expect(keysAt(tier), `tier ${tier}`).not.toContain('cv_next');
      expect(keysAt(tier), `tier ${tier}`).not.toContain('cv_random');
    }
  });

  it('declares NO pages, so no tab rail is manufactured', () => {
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
    // ⚠ THIS IS THE PRECURSOR, PINNED. The build spec for this face is a
    // PROMOTE-WITH-PRECURSOR precisely because `gain` was declared, exposed
    // nowhere and read by nothing — the def's own docs said so. #2189 wired it.
    // Backing that out would leave a ranked fader that moves no pixel, and every
    // def-reading gate would stay green.
    expect(fragSrc).toMatch(/uniform float uGain;/);
    expect(fragSrc).toMatch(/texture\(uTex, vUv\)\.rgb \* uGain/);
  });

  it('draw() pushes the param into that uniform', () => {
    expect(stripSourceComments(defSource)).toMatch(/uniform1f\(uGain, params\.gain\)/);
  });

  it("the escape hatch it must NOT have taken would have PASSED — writer 'internal' on gain", () => {
    // ⚠ THE MEASUREMENT BEHIND THE REFUSAL, kept so it is not rediscovered as a
    // shortcut. `no-user-control` anchors on the PORTS: it checks only that no
    // input targets the param, and none targets `gain`. So declaring `gain`
    // internal would compile, pass, satisfy face completeness — and be false,
    // because nothing writes it internally either. The gate is structurally
    // unable to ask "does anything write this at all", which is why the fix had
    // to be the shader.
    const problems = noUserControlProblems({
      ...(tvLibrarianDef as unknown as NoUserControlDefLike),
      noUserControl: [{ param: 'gain', writer: 'internal', why: 'z'.repeat(40) }],
    } as NoUserControlDefLike);
    expect(problems, 'the hatch really is open — which is the point').toEqual([]);
    // …and the def does NOT take it.
    expect(noUserControlIds(tvLibrarianDef as unknown as NoUserControlDefLike).has('gain')).toBe(false);
  });
});

describe('the noUserControl declaration, driven in BOTH directions', () => {
  const nucDef = tvLibrarianDef as unknown as NoUserControlDefLike;

  it('declares exactly the two synthetic params, and neither is ranked', () => {
    expect([...noUserControlIds(nucDef)].sort()).toEqual(['cv_next', 'cv_random']);
    for (const id of noUserControlIds(nucDef)) {
      expect(def.face?.order ?? [], `${id} must not be ranked`).not.toContain(id);
    }
  });

  it("the declaration is SOUND against tvLibrarian's own ports (positive control)", () => {
    expect(noUserControlProblems(nucDef)).toEqual([]);
  });

  it('every param is EITHER ranked OR declared — nothing falls through', () => {
    const ranked = new Set(def.face?.order ?? []);
    const declared = noUserControlIds(nucDef);
    const orphans = tvLibrarianDef.params
      .map((p) => p.id)
      .filter((id) => !ranked.has(id) && !declared.has(id));
    expect(orphans).toEqual([]);
  });

  it("REJECTS writer 'internal' on cv_next — a port DOES target it", () => {
    const problems = noUserControlProblems({
      ...nucDef,
      noUserControl: [{ param: 'cv_next', writer: 'internal', why: 'y'.repeat(40) }],
    } as NoUserControlDefLike);
    expect(problems.join('\n')).toMatch(/internal/);
  });

  it('REJECTS a declaration naming a param that does not exist', () => {
    const problems = noUserControlProblems({
      ...nucDef,
      noUserControl: [{ param: 'not_a_param', writer: 'cv-port', why: 'x'.repeat(40) }],
    } as NoUserControlDefLike);
    expect(problems.join('\n')).toMatch(/not a ParamDef/);
  });
});

describe('the two surfaces agree, and the body is not a second owner', () => {
  it('the BODY never adopts the node-owned <video>', () => {
    // ⚠ NO GATE SEES THIS. The element has exactly one parent, and the legacy
    // card adopts it under ?shell=legacy or as a dock rail occupant. A body that
    // adopted it too would move it out from under that mount — silently, and
    // only in the arrangement where both are alive.
    expect(bodyCode).not.toMatch(/nodeMedia/);
    expect(bodyCode).not.toMatch(/\.adopt\(/);
  });

  it('the BODY paints the ENGINE OUTPUT instead, which is what `gain` scales', () => {
    // Not merely a substitute for the element: the card's preview shows the raw
    // <video> and therefore cannot show what the one ranked control on this face
    // does. The body's picture can, because it is the module's own output FBO.
    expect(bodyCode).toMatch(/blitOutputForPreview/);
    expect(bodyCode).toMatch(/<canvas/);
  });

  // ⚠ 'the CARD still adopts it — promotion did not move the element' STOOD
  // HERE, asserting `nodeMedia.adopt(` on the card so that promotion could be
  // shown NOT to have moved the <video>. The element belongs to
  // `node-hls-source-registry` on graph lifetime — which card-media-lifetime
  // holds — and there is no second adopter left to move it away.

  it('the browse surface is the SHARED component, not a copy of it', () => {
    // Two copies of a picker is how surfaces drift, and this module has a
    // documented instance of correctness travelling by hand-copy and arriving
    // late (the `muted = false` audio trap). The card was the other mount; the
    // property that outlives it is that the surviving mount is the shared
    // component rather than a fork, which is what a future second surface would
    // be measured against.
    expect(bodyCode).toMatch(/<TvLibrarianPicker[\s/>]/);
    expect(pickerCode, 'the shared picker really carries the browse affordance')
      .toMatch(/data-testid=/);
  });
});

describe('resting text — the readout is REMOVED, and what makes that safe', () => {
  it('no surface paints a NOW PLAYING readout', () => {
    // Owner ruling, 2026-08-17: the data is REMOVED, not hidden. It was deleted
    // on the card as well as the faceplate — two surfaces disagreeing about
    // what a module paints is exactly the drift the shared picker exists to
    // prevent — and the surviving surface is asserted here.
    expect(bodyCode).not.toMatch(/tv-now-playing/);
    expect(pickerCode).not.toMatch(/tv-now-playing/);
  });

  it('the station name survives on the picture’s accessible name', () => {
    expect(bodyCode, 'the body must expose the station name')
      .toMatch(/aria-label=\{pictureLabel\}/);
    expect(bodyCode, 'the body must build it from the tuned channel').toMatch(/channel\.name/);
  });

  it('the roster scrolls its selected row into view — the thing that makes the removal safe', () => {
    // ⚠ Deleting a readout deletes a finding. The highlighted row is now the
    // ONLY painted answer to "which station is this?", and a highlight the
    // player has to scroll to find is not an answer.
    expect(pickerCode).toMatch(/scrollIntoView/);
    expect(pickerCode).toMatch(/class:sel=\{c\.key === channel\?\.nanoid\}/);
  });

  it('the legal disclaimer and the dataset attribution are present', () => {
    // ⚠ THE ONE TEXT HERE WITH NO DECLARED RESTING-TEXT ROLE. It stays because
    // the famelack / iptv-org licence requires it, and body text is
    // face-resting-text-source's stated blind spot — so it would ship green
    // either way, and a future literal reading of the ruling would delete it
    // with nothing to object. This leg is the objection.
    expect(pickerCode).toMatch(/data-testid="tv-disclaimer"/);
    expect(pickerCode).toMatch(/Famelack/);
    expect(pickerCode).toMatch(/iptv-org/);
  });
});

describe('the VRT argument, pinned where it is made', () => {
  it('the untuned picture is TIME-INVARIANT — no clock in the idle branch', () => {
    // ⚠ THE CLAIM THE FACE'S VRT ROSTER ENTRY RESTS ON. A scene tunes nothing,
    // so `uHasInput` is 0 and the idle branch runs. If a clock uniform ever
    // appears the baselines start flapping for a reason nobody will attribute,
    // and the entry's "needs no picture pin" stops being true.
    expect(fragSrc).toMatch(/if \(uHasInput < 0\.5\)/);
    expect(fragSrc).not.toMatch(/uTime|uClock|uFrame/);
    const uniforms = [...fragSrc.matchAll(/uniform\s+\w+\s+(\w+);/g)].map((m) => m[1]).sort();
    expect(uniforms, 'every uniform must be a param or the input flag').toEqual([
      'uGain', 'uHasInput', 'uTex',
    ]);
  });

  it('the ROSTER has a determinism seam, and it is read at mount', () => {
    expect(pickerCode).toMatch(/__tvLibrarianTestCountries/);
    expect(pickerCode).toMatch(/pinnedCountries\(\)/);
  });

  it('the seam short-circuits the network rather than mocking a response', () => {
    // An unreachable third-party host does not fail identically twice, and the
    // message the catch paints is the BROWSER's, not ours.
    const guard = /if \(pinned\) \{ countries = pinned; return; \}/;
    expect(pickerCode).toMatch(guard);
    expect(pickerCode.indexOf('pinnedCountries()')).toBeLessThan(pickerCode.indexOf('await fetch('));
  });
});

describe('the Push 2 card re-ranks itself — a behaviour change outside the faceplate', () => {
  it('drops the two bridge caches, leaving one turnable control', () => {
    // ⚠ Stated because it is a real change and no face gate would report it:
    // `push-card-schema` drops `noUserControl` params, tvLibrarian has no
    // explicit PUSH_CARD_CONTROLS entry, so its card is resolved from the live
    // def and goes from three params to one. An improvement — a raw gate cache
    // should never have been on a hardware controller — but a change.
    const spec = resolvePushCardControls(tvLibrarianDef as unknown as PushCardDefLike);
    const ids = pushCardParams(spec).map((p) => p.id);
    expect(ids).not.toContain('cv_next');
    expect(ids).not.toContain('cv_random');
    expect(ids).toContain('gain');
  });
});
