// packages/web/src/lib/ui/modules/videovarispeed-face-model.test.ts
//
// VIDEOVARISPEED's face, pinned where the argument is made.
//
// Three kinds of assertion, deliberately mixed:
//   * the LIVE def object and the PURE selectors (`curatedFace`,
//     `hasVideoSurface`, `glyphBinding`, `noUserControlProblems`) — what the
//     shell will actually resolve;
//   * the comment-STRIPPED source of the def, the body and the legacy card —
//     for the ported-verbatim and moved-not-duplicated claims a runtime
//     assertion cannot reach;
//   * the VRT determinism argument, so the roster prose in `_shell-faces.ts`
//     is anchored to something rather than merely asserted.
//
// ⚠ THE STRIPPED VIEWS MATTER because several legs below FORBID a construct
// whose natural explanation NAMES it — a raw grep cannot tell code from the
// comment explaining why the code is absent.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { videoVarispeedDef } from '$lib/video/modules/videovarispeed';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { glyphBinding } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  noUserControlIds,
  noUserControlProblems,
} from '$lib/ui/workflow/no-user-control';
import type { NoUserControlDefLike } from '$lib/graph/types';
import { resolveWindow } from '$lib/video/modules/videovarispeed-transport';
import { speedKnobToMultiplier } from '$lib/video/modules/videovarispeed-transport';
import { ASSET_SLOTS } from '$lib/video/asset-select';

const def = videoVarispeedDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const defSource = read('../../video/modules/videovarispeed.ts');
const bodySource = read('videovarispeed/VideoVarispeedTransportBody.svelte');
const registrySource = read('../media/node-varispeed-registry.ts');

const bodyCode = stripSourceComments(bodySource);
const registryCode = stripSourceComments(registrySource);

/** The LIVE `ParamDef`. */
function param(id: string) {
  const p = videoVarispeedDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`videovarispeed has no param '${id}'`);
  return p;
}

describe('videovarispeed face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('videovarispeed')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it('declares glyph \'none\' AND still has a live picture', () => {
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def)).toBe(true);
    expect(laneGlyphFor(def as Parameters<typeof laneGlyphFor>[0])).toBe('picture');
  });

  it('the glyph choice is a DECISION, not a forced one — this def HAS audio outputs', () => {
    // ⚠ THIS IS THE LEG THAT MAKES `'none'` MEANINGFUL. `glyphBinding` short-
    // circuits on the first `type: 'audio'` OUTPUT, so ANY other literal here
    // would resolve to a LIVE binding and the dead-glyph clause in
    // module-face-lint would NOT catch it — the module would ship a VU of the
    // clip's SOUNDTRACK where its own picture belongs.
    const audioOuts = videoVarispeedDef.outputs.filter((o) => o.type === 'audio').map((o) => o.id);
    expect(audioOuts).toEqual(['audio_l', 'audio_r']);
    expect(glyphBinding(def as Parameters<typeof glyphBinding>[0]).kind).toBe('none');
    const asWaveform = { ...def, face: { ...def.face!, glyph: 'waveform' as const } };
    expect(
      glyphBinding(asWaveform as Parameters<typeof glyphBinding>[0]).kind,
      'the counterfactual glyph resolved DEAD, so this argument would be decoration',
    ).toBe('live-audio');
  });

  it('owns a fullViewBody extension — without it the module cannot BE GIVEN A VIDEO', () => {
    expect(def.face?.extension).toBe('videovarispeed');
    // No ParamCellKind mounts an <input type=file>, so the body is the only
    // path from a player to a clip.
    expect(bodyCode).toMatch(/data-testid="videovarispeed-file-input"/);
    expect(bodyCode).toMatch(/data-testid="videovarispeed-play-btn"/);
  });
});

describe('videovarispeed face — the tier ladder, and why SPEED is not a fader', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('the DOCK shows exactly the three transport controls, in order', () => {
    expect(keysAt('dock')).toEqual(['speed', 'start', 'end']);
  });

  it('every LANE tier shows a PREFIX of that order — SPEED never falls off', () => {
    // The tiers cap by cell count, not by a per-tier list: what matters is that
    // the ranking degrades from the front, so the smallest tile still carries
    // the control this module is named after. (The tile also gets the module's
    // live picture for free from `hasVideoSurface`, which OUTRANKS cells —
    // #1785 — so a thin lane row here is the intended shape, not a loss.)
    const dock = keysAt('dock');
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const keys = keysAt(tier);
      expect(keys.length, `tier ${tier} paints nothing`).toBeGreaterThan(0);
      expect(keys, `tier ${tier} is not a prefix of the dock order`).toEqual(dock.slice(0, keys.length));
    }
  });

  it('NONE of the nine synthetic bridge caches reaches any tier', () => {
    // The failure this forbids is concrete: an undeclared cache renders as a
    // turnable continuous rotary over a raw gate level or a raw V/oct, stomped
    // by the CV bridge's next write.
    const synthetic = [
      'speedCv', 'startCv', 'endCv',
      'cv_start', 'cv_pause', 'cv_reset', 'cv_loop_toggle',
      'asset_pitch', 'asset_gate',
    ];
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      for (const id of synthetic) {
        expect(keysAt(tier), `tier ${tier} / ${id}`).not.toContain(id);
      }
    }
  });

  it('declares NO pages — three cells is not control-heavy', () => {
    // The wave plan proposed a transport/window split. The 2026-08-19 ruling
    // forbids padding pages to manufacture a tab rail, so it is dropped.
    expect(def.face?.pages).toBeUndefined();
  });

  it('START and END are FADERS — the primitive a windowed range wants', () => {
    expect(def.face?.paramCells?.start).toBe('fader');
    expect(def.face?.paramCells?.end).toBe('fader');
    // `fader` requires a CONTINUOUS param; both are linear 0..1.
    for (const id of ['start', 'end']) {
      expect(param(id).curve, id).toBe('linear');
      expect(param(id).min, id).toBe(0);
      expect(param(id).max, id).toBe(1);
    }
  });

  it('SPEED is deliberately NOT a fader, and its LAW is why', () => {
    expect(def.face?.paramCells?.speed).toBeUndefined();
    // An asymmetric analog-clock face: full-left −4×, twelve o'clock +1×,
    // full-right +4×. A rotary reads that; a linear throw does not.
    expect(speedKnobToMultiplier(0)).toBeCloseTo(-4, 6);
    expect(speedKnobToMultiplier(0.5)).toBeCloseTo(1, 6);
    expect(speedKnobToMultiplier(1)).toBeCloseTo(4, 6);
    const speed = param('speed');
    expect(speed.defaultValue).toBe(0.5);
    // ⚠ AND THE MIDPOINT IS NOT THE ARITHMETIC MIDPOINT OF THE MULTIPLIER
    // RANGE: (-4 + 4) / 2 is 0, not 1. That asymmetry is the whole reason a
    // fader's "unity at mid-throw" reading would be a lie here.
    expect(speedKnobToMultiplier(0.5)).not.toBeCloseTo(0, 3);
  });
});

describe('the noUserControl declaration, driven in BOTH directions', () => {
  it('declares exactly the nine bridge caches, none of them ranked', () => {
    expect([...noUserControlIds(videoVarispeedDef as NoUserControlDefLike)].sort()).toEqual([
      'asset_gate', 'asset_pitch',
      'cv_loop_toggle', 'cv_pause', 'cv_reset', 'cv_start',
      'endCv', 'speedCv', 'startCv',
    ]);
  });

  it('is SOUND against the def\'s own ports', () => {
    expect(noUserControlProblems(videoVarispeedDef as NoUserControlDefLike)).toEqual([]);
  });

  it('every param is either RANKED or DECLARED — no orphans, no doubles', () => {
    const ranked = new Set(def.face?.order ?? []);
    const declared = noUserControlIds(videoVarispeedDef as NoUserControlDefLike);
    for (const p of videoVarispeedDef.params) {
      const inRanked = ranked.has(p.id);
      const inDeclared = declared.has(p.id);
      expect(inRanked || inDeclared, `param '${p.id}' is neither ranked nor declared`).toBe(true);
      expect(inRanked && inDeclared, `param '${p.id}' is BOTH`).toBe(false);
    }
  });

  it('REJECTS writer:\'internal\' on a param whose port declares paramTarget', () => {
    // The negative control: `cv-port` is not merely a label that happens to be
    // there, it is the only legal value for these nine.
    const bad = {
      ...videoVarispeedDef,
      noUserControl: (videoVarispeedDef.noUserControl ?? []).map((n) =>
        n.param === 'cv_start' ? { ...n, writer: 'internal' as const } : n,
      ),
    };
    expect(noUserControlProblems(bad as NoUserControlDefLike)).not.toEqual([]);
  });
});

describe('⚠ THE STOP-2 — the handle acquisition is ported VERBATIM', () => {
  it('the body uses showOpenFilePicker, not only the native input', () => {
    // The native <input type=file> cannot hand back a FileSystemFileHandle, so
    // a body built on it alone would never persist a handle, never restore a
    // clip on reload, never set `pendingHandleName`, and would ship the
    // re-allow overlay as unreachable dead code.
    expect(bodyCode).toMatch(/showOpenFilePicker/);
    expect(bodyCode).toMatch(/onclick=\{onPickClick\}/);
  });

  it('the DROP path grabs a handle too', () => {
    expect(bodyCode).toMatch(/getAsFileSystemHandle/);
  });

  it('the re-allow overlay is reachable and performs the re-grant in the click', () => {
    expect(bodyCode).toMatch(/data-testid="videovarispeed-reallow-btn"/);
    expect(bodyCode).toMatch(/reAllowVarispeedHandle\(nodeId\)/);
  });

  it('the re-link prompt is a real <label> over a file input', () => {
    expect(bodyCode).toMatch(/data-testid="videovarispeed-relink-input"/);
  });
});

describe('the loader MOVED to the node — it is not duplicated on two surfaces', () => {
  it('the CONTROLLER owns the loader, the restores and the export resolver', () => {
    expect(registryCode).toMatch(/function loadFileIntoSlot/);
    expect(registryCode).toMatch(/function tryReloadSlot/);
    expect(registryCode).toMatch(/function resolveAllSlotBytes/);
    expect(registryCode).toMatch(/function refitCropForAspect/);
    expect(registryCode).toMatch(/VIDEOVARISPEED_MAX_SLOT_BYTES/);
  });

  it('NEITHER surface loads bytes itself — both forward the gesture', () => {
    // ⚠ The failure this forbids is two owners for one slot: a card and a body
    // each creating an object URL for `slot0` would leave whichever ran last
    // winning and the other's bytes orphaned.
    for (const [name, code] of [['body', bodyCode] as const]) {
      expect(code, `${name} still creates its own object URL`).not.toMatch(/URL\.createObjectURL/);
      expect(code, `${name} still writes fileMeta directly`).not.toMatch(/writeFileMeta/);
      expect(code, `${name} still registers the export resolver`).not.toMatch(/registerVideoExport/);
      expect(code, `${name} forwards no load command`).toMatch(/kind: 'loadFile'/);
    }
  });

  // ⚠ 'the CARD keeps its file input and play button — the collapse sweep reads
  // them' STOOD HERE, and what it recorded is a LIVE CROSS-SLICE HAZARD rather
  // than a claim about this face. `e2e/tests/collapse-keeps-playing.spec.ts`
  // DERIVES its "real player" population by `readdirSync`-ing the card
  // directory and grepping each `*Card.svelte` for a `-file-input` plus a
  // `-play-btn` testid. When the fleet goes, that population resolves to
  // NOTHING and the sweep passes while measuring zero modules — the vacuous-all
  // shape, in an e2e nobody would think to re-read.
  //
  // That is an E2E subject-derivation problem, not a unit one, so it is not
  // repaired here: this file's job is to stop depending on the card, and the
  // spec's job is to stop deriving its population from one. Recorded at the
  // exact leg that knew about it so the next reader finds it.
  it('the BODY carries the file input and the play button', () => {
    // The affordances themselves, on the surface that survives — which is what
    // the deleted leg was ultimately about.
    expect(bodyCode).toMatch(/data-testid="videovarispeed-file-input"/);
    expect(bodyCode).toMatch(/data-testid="videovarispeed-play-btn"/);
  });

  it('neither surface keeps a stale mirror of the node\'s slot state', () => {
    for (const [name, code] of [['body', bodyCode] as const]) {
      expect(code, `${name} mirrors slotNames into component $state`)
        .not.toMatch(/let slotNames = \$state/);
      expect(code, `${name} runs its own playhead interval`)
        .not.toMatch(/setInterval\(refreshDisplay/);
    }
  });
});

describe('the two surfaces agree, and the body is not a second owner', () => {
  it('the body BLITS and never adopts the node-owned <video>', () => {
    // A DOM node has ONE parent, and the element belongs to
    // `node-varispeed-registry` on graph lifetime; adopting here would move it
    // out from under the owner that keeps it alive with nothing mounted.
    expect(bodyCode).toMatch(/blitOutputForPreview/);
    expect(bodyCode).toMatch(/<canvas/);
    expect(bodyCode, 'the body adopts the element — that is a second owner')
      .not.toMatch(/nodeMedia\.adopt/);
  });

  // ⚠ 'the CARD still adopts it — the `?shell=legacy` path is unchanged' STOOD
  // HERE, and it was the OTHER half of the pair above: exactly one surface
  // adopts. The card was that surface; the registry is the owner now, which
  // card-media-lifetime holds, and the body is asserted above not to become a
  // second one.

  it('the bank is a permanent section, NOT a whole-surface right-click', () => {
    // Right-click is claimed PER-CONTROL by ControlContextMenu (MIDI-learn /
    // automation), so an affordance whose only opener is a surface-wide
    // `oncontextmenu` has no opener on a faceplate.
    expect(bodyCode).toMatch(/data-testid="videovarispeed-multi-panel"/);
    expect(bodyCode).not.toMatch(/oncontextmenu/);
    for (let i = 0; i < ASSET_SLOTS; i++) {
      expect(bodySource).toContain('videovarispeed-slot-input-{i}');
    }
  });

  it('SCREEN writes the SHARED key, tracked, on the body', () => {
    expect(bodyCode).toMatch(/previewCollapsed/);
    expect(bodyCode).toMatch(/mutateNode\(nodeId/);
  });
});

describe('resting text — the time readout is REMOVED, and what makes that safe', () => {
  it('no surface paints the card\'s `0:04 / 2:00` line any more', () => {
    for (const [name, code] of [['body', bodyCode] as const]) {
      expect(code, `${name} still paints the time readout`)
        .not.toMatch(/data-testid="videovarispeed-time"/);
    }
  });

  it('position survives on the seek slider\'s aria-valuetext', () => {
    expect(bodyCode).toMatch(/aria-valuetext="\{formatTime\(displayPos\)\} of \{formatTime\(durationSec\)\}"/);
  });

  it('the SPEED multiplier is KEPT, body-side, and costs no def edit', () => {
    // Owner decision 2026-08-31 §8. `params` is NOT hash-transparent, so a
    // `ParamDef.format` would move the WebGL attest hash for a readout.
    expect(bodyCode).toMatch(/data-testid="videovarispeed-speed-readout"/);
    expect(param('speed')).not.toHaveProperty('format');
    expect(defSource, 'a ParamDef.format crept into the def — that is a GPU re-attest')
      .not.toMatch(/format:/);
  });

  it('the START-past-END warning survives — it is the only diagnostic for a HALT', () => {
    expect(bodyCode).toMatch(/data-testid="videovarispeed-window-warn"/);
    // With START past END the window is empty, the controller pauses the
    // element every frame, and Play does nothing with no other explanation.
    expect(resolveWindow(10, 0.9, 0.1).hasWindow).toBe(false);
    expect(resolveWindow(10, 0, 1).hasWindow).toBe(true);
  });
});

describe('the VRT argument, pinned where it is made', () => {
  it('the idle picture is TIME-INVARIANT — no clock, no accumulator', () => {
    // A face scene loads NOTHING, so `uHasInput` is 0 and this branch runs.
    const frag = /const FRAG_SRC = `([\s\S]*?)`;/.exec(defSource)?.[1] ?? '';
    expect(frag.length).toBeGreaterThan(0);
    const idle = frag.slice(frag.indexOf('if (uHasInput < 0.5)'), frag.indexOf('// Centre'));
    expect(idle).toMatch(/vUv\.y/);
    expect(idle, 'the idle branch reads a clock — the face scene is not deterministic')
      .not.toMatch(/uTime|iTime|frameCount/);
  });

  it('the surface rests at spawn — the seek slider is DISABLED with no duration', () => {
    expect(bodyCode).toMatch(/disabled=\{durationSec <= 0\}/);
  });

  it('the SCREEN switch keeps the watch mark while collapsed', () => {
    // A lapsed mark is a producer kill switch (#2015), and this module has TWO
    // video outputs: CROP is a second pass over its own frame, so a lapsed mark
    // idles the zoom a second screen is showing as well as the picture.
    expect(bodyCode).toMatch(/markWatched\(nodeId\)/);
    expect(bodyCode).toMatch(/previewCollapsed/);
  });
});
