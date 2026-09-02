// packages/web/src/lib/ui/modules/videobox-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the VIDEOBOX faceplate.
//
// Everything here is a claim the shipped face MAKES and that no other gate can
// check. The tvLibrarian suite is the template (same audio plumbing, same
// one-fader face); what is new is the STOP-2:
//
//   1. ⚠ THE FILE SYSTEM ACCESS HANDLE ACQUISITION IS COMPONENT-ONLY BY
//      CONSTRUCTION. `showOpenFilePicker` / `getAsFileSystemHandle` are
//      honoured only inside a real user gesture, and the native
//      `<input type=file>` cannot hand back a `FileSystemFileHandle` — so a
//      body built on the input alone would never persist a handle, never
//      restore a file on rack reload (the card header calls that restore "the
//      headline of this conversion"), never set `pendingHandleName`, and would
//      ship the re-allow overlay as permanently unreachable dead code while
//      `docs.explanation` promises it works. The picker port is pinned here,
//      per element, because promotion stops the card mounting and every
//      def-reading gate stays green without it.
//
//   2. THE GLYPH DECISION IS A REAL ONE — this def HAS two audio outputs, so a
//      glyph literal would resolve to a LIVE binding (a VU of the film's
//      soundtrack over the module's own picture) and the dead-glyph clause
//      would NOT catch it.
//
//   3. THE BODY MUST NOT ADOPT THE NODE-OWNED `<video>` — one parent, and the
//      legacy card adopts it under `?shell=legacy`. Its ONE element access is
//      a NON-OWNING `nodeMedia.peek` for the playhead position, because
//      `VideoSourceStatus` publishes no position or duration.
//
//   4. THE RESIZE WRITES THE CARD'S OWN KEYS — `width`/`height`, never the
//      graphicEq/milkdrop `resizedWidth`/`resizedHeight` pair, which would
//      silently ignore every saved rack's wall-of-TVs size.
//
//   5. THE VRT ENTRY RESTS ON THE IDLE PICTURE BEING TIME-INVARIANT — pinned
//      where the claim is made.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { videoboxDef } from '$lib/video/modules/videobox';
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

const def = videoboxDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const defSource = read('../../video/modules/videobox.ts');
const bodySource = read('videobox/VideoboxScreenBody.svelte');
const cardSource = read('VideoboxCard.svelte');

// The code-only views. A raw grep cannot tell code from a comment, and several
// legs below forbid a construct whose natural explanation NAMES it.
const bodyCode = stripSourceComments(bodySource);
const cardCode = stripSourceComments(cardSource);

/** The LIVE `ParamDef`. */
function param(id: string) {
  const p = videoboxDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`videobox has no param '${id}'`);
  return p;
}

/** The shader body, as the def declares it. */
const fragSrc = /const FRAG_SRC = `([\s\S]*?)`;/.exec(defSource)?.[1] ?? '';

describe('videobox face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('videobox')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still has a live picture", () => {
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def)).toBe(true);
  });

  it('the glyph choice is a DECISION, not a forced one — this def HAS audio outputs', () => {
    // The dead-glyph clause enforces 'none' for free only on defs with no
    // `type: 'audio'` output. Here two exist, so a literal would bind LIVE and
    // ship a soundtrack VU competing with the picture, green all the way.
    const audioOuts = videoboxDef.outputs.filter((o) => o.type === 'audio').map((o) => o.id);
    expect(audioOuts).toEqual(['audio_l', 'audio_r']);
  });

  it('owns a fullViewBody extension — without it the module cannot LOAD A FILE at all', () => {
    // ⚠ A STOP-2 ASSERTION. videobox left DOM_SOURCE_LANE_TYPES in LEG-02 P1
    // (#1511), so under the shell NO card is mounted anywhere: without this
    // body there is no picker, no drop target, no transport on any surface.
    expect(def.face?.extension).toBe('videobox');
    expect(bodyCode).toMatch(/videobox-file-input/);
    expect(bodyCode).toMatch(/videobox-play-btn/);
  });
});

describe('videobox face — the tier ladder, and why it is ONE control', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('every tier shows exactly GAIN — the module has one control and says so', () => {
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
    expect(fragSrc).toMatch(/uniform float uGain;/);
    expect(fragSrc).toMatch(/texture\(uTex, vUv\)\.rgb \* uGain/);
  });

  it('draw() pushes the param into that uniform', () => {
    expect(stripSourceComments(defSource)).toMatch(/uniform1f\(uGain, params\.gain\)/);
  });
});

describe('the noUserControl declaration, driven in BOTH directions', () => {
  const nucDef = videoboxDef as unknown as NoUserControlDefLike;

  it('declares exactly the synthetic param, and it is not ranked', () => {
    expect([...noUserControlIds(nucDef)]).toEqual(['cv_play_trigger']);
    expect(def.face?.order ?? []).not.toContain('cv_play_trigger');
  });

  it("the declaration is SOUND against videobox's own ports (positive control)", () => {
    expect(noUserControlProblems(nucDef)).toEqual([]);
  });

  it('every param is EITHER ranked OR declared — nothing falls through', () => {
    const ranked = new Set(def.face?.order ?? []);
    const declared = noUserControlIds(nucDef);
    const orphans = videoboxDef.params
      .map((p) => p.id)
      .filter((id) => !ranked.has(id) && !declared.has(id));
    expect(orphans).toEqual([]);
  });

  it("REJECTS writer 'internal' on cv_play_trigger — a port DOES target it", () => {
    const problems = noUserControlProblems({
      ...nucDef,
      noUserControl: [{ param: 'cv_play_trigger', writer: 'internal', why: 'y'.repeat(40) }],
    } as NoUserControlDefLike);
    expect(problems.join('\n')).toMatch(/internal/);
  });
});

describe('⚠ THE STOP-2 — the handle acquisition is ported VERBATIM, per element', () => {
  it('the body prefers showOpenFilePicker so a pick persists a HANDLE', () => {
    // The native <input> cannot hand back a FileSystemFileHandle; without this
    // path a pick is never remembered, a reload never restores, and the
    // re-allow overlay below is unreachable dead code.
    expect(bodyCode).toMatch(/showOpenFilePicker/);
    expect(bodyCode).toMatch(/canPersistVideoHandles\(\)/);
  });

  it('the pick <label>s carry onclick={onPickClick} so the picker path can intercept', () => {
    // Both file <label>s — the main pick button and the re-link overlay. A
    // label without the handler falls through to the native input on every
    // browser and silently stops persisting handles on Chromium.
    expect(bodyCode).toMatch(/data-testid="videobox-pick-label"[\s\S]{0,120}onclick=\{onPickClick\}|onclick=\{onPickClick\}[\s\S]{0,120}data-testid="videobox-pick-label"/);
    expect(bodyCode).toMatch(/videobox-relink-hint"\s*onclick=\{onPickClick\}|onclick=\{onPickClick\}[\s\S]{0,80}videobox-relink-hint/);
  });

  it('the DROP path grabs getAsFileSystemHandle so a dropped file is remembered too', () => {
    expect(bodyCode).toMatch(/getAsFileSystemHandle/);
  });

  it('the re-allow overlay is REACHABLE: pendingHandleName is read and the button re-grants', () => {
    expect(bodyCode).toMatch(/pendingHandleName/);
    expect(bodyCode).toMatch(/reAllowVideoHandle\(/);
    expect(bodyCode).toMatch(/videobox-reallow-btn/);
  });

  it('the re-link overlay is a REAL <label> wrapping its own input', () => {
    expect(bodyCode).toMatch(/videobox-relink-input/);
  });

  it('gestures FORWARD to the controller — the body never grows a second load path', () => {
    expect(bodyCode).toMatch(/nodeVideoSource\.request\(/);
    // The loads the controller owns must not reappear here: no object URL
    // minting, no element src writes, no wireAudio reach-in.
    expect(bodyCode).not.toMatch(/createObjectURL/);
    expect(bodyCode).not.toMatch(/\.src\s*=/);
    expect(bodyCode).not.toMatch(/wireAudio/);
  });
});

describe('the two surfaces agree, and the body is not a second owner', () => {
  it('the BODY never adopts the node-owned <video>', () => {
    // One parent; the legacy card adopts it under ?shell=legacy. A body that
    // adopted it too would move it out from under that mount — silently, and
    // only in the arrangement where both are alive.
    expect(bodyCode).not.toMatch(/\.adopt\(/);
    expect(bodyCode).not.toMatch(/nodeMedia\.ensure\(/);
  });

  it("the body's ONE element access is a NON-OWNING peek, for the playhead", () => {
    // `VideoSourceStatus` publishes no position or duration, so the seek
    // thumb's source is the element's own clock (local copy) or the sync
    // triple projected along the wallclock (peer) — derived in the body's rAF.
    expect(bodyCode).toMatch(/nodeMedia\.peek\(/);
    expect(bodyCode).toMatch(/lastSyncPosition \+ elapsed/);
    expect(bodyCode).toMatch(/Math\.min\(durationSec \|\| Infinity/);
  });

  it('the BODY paints the ENGINE OUTPUT instead, which is what `gain` scales', () => {
    expect(bodyCode).toMatch(/blitOutputForPreview/);
    expect(bodyCode).toMatch(/<canvas/);
  });

  it('the CARD still adopts it — promotion did not move the element', () => {
    expect(cardCode).toMatch(/nodeMedia\.adopt\(/);
  });

  it('the RESIZE writes the CARD\'S OWN keys — width/height, and tracked', () => {
    // `resizedWidth`/`resizedHeight` are graphicEq/milkdrop/monoglitch keys;
    // reading them here would ignore every saved rack's wall-of-TVs size.
    expect(bodyCode).toMatch(/live\.data\.width = w/);
    expect(bodyCode).toMatch(/live\.data\.height = h/);
    expect(bodyCode).not.toMatch(/resizedWidth|resizedHeight/);
  });

  it('FULL FRAME rides the SAME node.data.fullFrame key on both surfaces, tracked on both', () => {
    // The boy-scout half of this promotion: the card's fullFrame and resize
    // writes were bare proxy writes (no origin → no Cmd-Z). Both surfaces now
    // route through mutateNode.
    for (const [name, code] of [['card', cardCode], ['body', bodyCode]] as const) {
      expect(code, `${name} reads data.fullFrame`).toMatch(/data\.fullFrame/);
      expect(code, `${name} writes through mutateNode`).toMatch(/mutateNode\(/);
    }
    expect(bodyCode).toMatch(/live\.data\.fullFrame = on/);
    expect(cardCode).toMatch(/live\.data\.fullFrame = on/);
  });

  it('presenting surfaces hold a render lease on BOTH surfaces', () => {
    // Fullscreen / full-frame outlive the viewport rect; without the lease a
    // presented picture freezes when the surface scrolls off-screen.
    for (const [name, code] of [['card', cardCode], ['body', bodyCode]] as const) {
      expect(code, `${name} holds the lease`).toMatch(/attachRenderLease\(/);
      expect(code, `${name} presents on fullscreen OR full-frame`).toMatch(
        /presenting: \(\) => fs\.isFullscreen \|\| fullFrame/,
      );
    }
  });
});

describe('resting text — the time readout is REMOVED, and what makes that safe', () => {
  it('the BODY paints no `0:04 / 2:00` readout', () => {
    // Owner ruling 2026-08-17: a faceplate paints no resting readout of
    // derived state, and the data is REMOVED rather than tucked behind a
    // hover. (The LEGACY card keeps its own — the resting-text rulings govern
    // faces, the audioIn precedent.)
    expect(bodyCode).not.toMatch(/videobox-time/);
  });

  it('position SURVIVES on the seek slider itself — value plus aria-valuetext', () => {
    // Deleting a readout deletes a finding unless the value has a home. The
    // slider's thumb is the painted answer and the accessible name speaks it.
    expect(bodyCode).toMatch(/aria-valuetext="\{formatTime\(displayPos\)\} of \{formatTime\(durationSec\)\}"/);
  });

  it('the filename stays — a caption of the loaded file, not a derived value', () => {
    expect(bodyCode).toMatch(/videobox-filename/);
  });
});

describe('the VRT argument, pinned where it is made', () => {
  it('the unloaded picture is TIME-INVARIANT — no clock in the idle branch', () => {
    // The face's `_shell-faces.ts` entry claims real baselines because a scene
    // loads nothing, so `uHasInput` is 0 and the idle branch runs. If a clock
    // uniform ever appears the baselines start flapping for a reason nobody
    // will attribute.
    expect(fragSrc).toMatch(/if \(uHasInput < 0\.5\)/);
    expect(fragSrc).not.toMatch(/uTime|uClock|uFrame/);
    const uniforms = [...fragSrc.matchAll(/uniform\s+\w+\s+(\w+);/g)].map((m) => m[1]).sort();
    expect(uniforms, 'every uniform must be a param or the input flag').toEqual([
      'uGain', 'uHasInput', 'uTex',
    ]);
  });

  it('the SCREEN switch keeps the watch mark while collapsed', () => {
    // A lapsed mark is a producer kill switch (#2015): the collapsed branch
    // must keep marking the node watched while it skips the pixel copy.
    expect(bodyCode).toMatch(/markWatched\(nodeId\)/);
    expect(bodyCode).toMatch(/previewCollapsed/);
  });
});

describe('the Push 2 card re-ranks itself — a behaviour change outside the faceplate', () => {
  it('drops the bridge cache, leaving one turnable control', () => {
    const spec = resolvePushCardControls(videoboxDef as unknown as PushCardDefLike);
    const ids = pushCardParams(spec).map((p) => p.id);
    expect(ids).not.toContain('cv_play_trigger');
    expect(ids).toContain('gain');
  });
});
