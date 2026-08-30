// packages/web/src/lib/ui/modules/timelorde-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the TIMELORDE faceplate.
//
// This module's whole design tension is that FOUR genuinely different states
// produce ONE observable: `running = 0`, `muteOutputs = 1` and both together are
// byte-identical on all thirteen gate outputs (measured on the real clock core,
// `packages/dsp/src/lib/timelorde-clock-core.test.ts`). The card answered that
// with a derived TRANSPORT STRIP; the 2026-08-19 resting-text ruling deletes it.
//
// ⚠ SO SAY WHICH FINDING LOST ITS SURFACE, per the standing rule. What the strip
// published and no single control can is the COMBINED state — *which of the two*
// is silencing your rack, plus the half no jack reports at all ("phase frozen"
// against "clock turning underneath"). The two `options` rosters recover the
// first half honestly: an option NAME is the one resting text the ruling
// permits, and `STOPPED` beside `MUTED` answers "which one" at a glance. The
// SECOND half — the consequence sentence — is now speakable and unpainted, and
// the assertions below pin that it is still DERIVED from the same pure function
// the engine handle publishes, rather than re-typed on the face.
//
// ⚠ AND ONE COVERAGE LAPSE IS NAMED RATHER THAN LEFT TO ROT.
// `e2e/tests/timelorde-transport-state.spec.ts` spawns `/rack?shell=legacy`, so
// it renders the LEGACY CARD and is UNAFFECTED by this promotion: it will stay
// green forever while asserting a strip on a surface the default shell no longer
// reaches. That is the milder form of the precondition-is-the-defect class — not
// a gate that certifies the bug, but a gate whose green is evidence about the
// wrong surface. The legacy spec is KEPT (it still covers a reachable surface)
// and this file is the face-side leg it cannot be.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timelordeDef, TIMELORDE_SWING_SOURCES } from '$lib/audio/modules/timelorde';
import {
  TIMELORDE_TRANSPORT_STATES,
  timelordeTransportState,
} from '$lib/audio/modules/timelorde-transport-state';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { paramCellKind } from '$lib/ui/workflow/shell-control-kind';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';

const def = timelordeDef as unknown as FaceDefLike & { type: string };
const EMPTY = new Set<string>();
const paramById = (id: string) => timelordeDef.params.find((p) => p.id === id)!;

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_SRC = resolve(HERE, 'timelorde/TimelordeDisplayBody.svelte');
const CARD_SRC = resolve(HERE, 'TimelordeCard.svelte');

/** Strip comments before grepping for CODE — this file's own bodies EXPLAIN in
 *  prose the very calls some legs assert are absent, and a raw grep cannot tell
 *  code from comment (the documented hazard; pong's model test hit it first). */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s+\/\/.*$/, ''))
    .join('\n');
}
const bodySrc = stripComments(readFileSync(BODY_SRC, 'utf-8'));
const cardSrc = stripComments(readFileSync(CARD_SRC, 'utf-8'));

describe('timelorde face — promoted, and the lane deliberately has NO picture', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('timelorde')).toBe(true);
  });

  it('declares glyph:none, and the ABSENCE of a lane picture is the claim', () => {
    // ⚠ FORCED, NOT CHOSEN, and asserting it stops a future reader "fixing" the
    // glyph. `hasVideoSurface` is `domain === 'video'` and timelorde is audio, so
    // no VideoTileThumb; and `primaryAudioOutPortId` matches `type === 'audio'`
    // while all fourteen outputs are thirteen `gate` plus one `video`, so every
    // glyph literal except 'none' resolves `{kind:'static'}` and reddens the
    // dead-glyph clause. A reader who knows the owl WILL look for it in the lane.
    expect(timelordeDef.face?.glyph, 'a gate-only-output def must declare glyph:none').toBe('none');
    expect(
      hasVideoSurface(def),
      'timelorde reports a video surface — it is an AUDIO module with a video PORT, and the lane ' +
        'tile has no display; if this becomes true the face model changed',
    ).toBe(false);
    expect(
      timelordeDef.outputs.filter((o) => o.type === 'audio'),
      'an audio output appeared — a live glyph would become derivable and this rule needs re-reading',
    ).toEqual([]);
  });

  it('BPM is rank 1 — the rack is DERIVED from it, not merely ridden', () => {
    expect(timelordeDef.face?.order?.[0]).toBe('bpm');
  });
});

describe('timelorde face — THE TIER LADDER, derived through curatedFace', () => {
  // ⚠ DERIVED, NEVER READ OFF THE CAP CONSTANTS. Three sibling faces (ruttetra,
  // monoglitch, reshaper) each computed this ladder from `LANE_PLATE_MAX_CELLS`
  // and each was wrong, independently; a fourth shipped a wrong ladder in a spec
  // that read plausibly. `curatedFace` is the function the shell actually calls.
  const ids = (tier: 'mini' | 'compact' | 'full' | 'dock') =>
    (curatedFace(def, tier)?.controls ?? []).map((c) => c.paramId ?? c.key);

  it('mini keeps BPM alone — the one number the whole rack is a function of', () => {
    expect(ids('mini')).toEqual(['bpm']);
  });

  it('compact keeps BPM + the TRANSPORT PAIR, and the pair is what makes it legible', () => {
    // The pair is the point: either one alone names its own state and cannot say
    // which of the two is silencing the rack.
    expect(ids('compact')).toEqual(['bpm', 'running', 'muteOutputs']);
  });

  it('TAP reaches NO lane tier — the dock-only rank, asserted as an ABSENCE', () => {
    // ⚠ The falsifiable direction. Asserting "the six params are ranked" would
    // pass even if TAP had crept into the lane budget, which is the thing rank 7
    // exists to prevent (a press-pad in a 46 px knob column).
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(ids(tier), `TAP is ranked at tier '${tier}'`).not.toContain('timelorde-tap-{n}');
    }
  });

  it('POSITIVE CONTROL: the dock resolves every param AND the TAP cell', () => {
    const dock = ids('dock');
    for (const p of ['bpm', 'running', 'muteOutputs', 'swingAmount', 'swingSource', 'wizardOn']) {
      expect(dock, `'${p}' is missing from the dock face`).toContain(p);
    }
    expect(dock, 'TAP resolves nowhere at all — the absence legs above would be vacuous').toContain(
      'timelorde-tap-{n}',
    );
  });
});

describe('timelorde face — the two TRANSPORT ROSTERS are the deleted strip’s replacement', () => {
  it('running and muteOutputs each declare a TOTAL 2-name roster', () => {
    for (const id of ['running', 'muteOutputs']) {
      const p = paramById(id);
      const values = (p.options ?? []).map((o) => o.value).sort();
      expect(values, `${id} roster does not cover its declared 0..1`).toEqual([p.min, p.max]);
    }
  });

  it('the words are STATES, not COMMANDS — a verb on a latching control is a different bug', () => {
    // `STOP`/`START` on a latching switch is the momentary/latching confusion
    // `module-face-lint` classifies separately (and which this module's three
    // switches are all acknowledged for). The chosen words are the ones
    // `timelorde-transport-state.ts` already names.
    const labels = [...(paramById('running').options ?? []), ...(paramById('muteOutputs').options ?? [])]
      .map((o) => o.label);
    expect(labels).toEqual(['STOPPED', 'RUNNING', 'GATES LIVE', 'MUTED']);
    const vocabulary = TIMELORDE_TRANSPORT_STATES.map((s) => s.short).join(' ');
    for (const word of ['STOPPED', 'RUNNING', 'MUTED']) {
      expect(vocabulary, `'${word}' is not a word this module's own derivation uses`).toContain(word);
    }
  });

  it('DOCK paints them as SEGMENTED pairs — the names, not an anonymous switch', () => {
    for (const id of ['running', 'muteOutputs']) {
      expect(paramCellKind(paramById(id), EMPTY, 'dock')).toBe('segmented');
    }
  });

  it('AT THE LANE they stay knobs — and the roster is what makes the knob NAME its state', () => {
    // The lane degrades every roster to a knob (`paramCellKind`), which is why
    // `swingSource` lost the compact tier. But a knob over a roster paints the
    // option NAME rather than a number (`paintsReadout`), and THAT is the
    // affordance the legacy button's colour carried.
    for (const id of ['running', 'muteOutputs']) {
      expect(paramCellKind(paramById(id), EMPTY, 'lane')).toBe('knob');
    }
    for (const id of ['running', 'muteOutputs']) {
      expect(paramById(id).format, `${id} declares a format — a NUMBER would paint instead of the name`)
        .toBeUndefined();
    }
  });

  it('THE COMBINED STATE IS STILL DERIVED — not re-typed on the face', () => {
    // ⚠ The half the rosters CANNOT carry: the consequence sentence. It must keep
    // coming from the same pure function the engine handle publishes as
    // read('transportState'), so the face and the engine cannot drift.
    expect(timelordeTransportState({ running: 0, muteOutputs: 1 }).id).toBe('stopped-muted');
    expect(timelordeTransportState({ running: 0, muteOutputs: 0 }).id).toBe('stopped');
    expect(timelordeTransportState({ running: 1, muteOutputs: 1 }).id).toBe('muted');
    expect(timelordeTransportState({ running: 1, muteOutputs: 0 }).id).toBe('running');
  });

  it('PERMANENT NEGATIVE CONTROL: BPM cannot move the transport state', () => {
    // ⚠ The leg the deleted strip carried, kept alive here. A "readout" that were
    // secretly keyed on the wrong param would still LOOK live because bpm moves
    // constantly under an external clock; only sweeping bpm and asserting NO
    // movement can tell them apart.
    const base = timelordeTransportState({ running: 0, muteOutputs: 1 });
    for (const bpm of [10, 60, 120, 137, 300]) {
      const withBpm = timelordeTransportState({ running: 0, muteOutputs: 1, bpm });
      expect(withBpm.id, `bpm ${bpm} moved the transport state`).toBe(base.id);
      expect(withBpm.short, `bpm ${bpm} moved the transport text`).toBe(base.short);
      expect(withBpm.detail, `bpm ${bpm} moved the transport detail`).toBe(base.detail);
    }
  });

  it('POSITIVE CONTROL: the state DOES move when the params that own it move', () => {
    // Proves the leg above is a real invariance rather than a function that
    // returns the same thing for everything.
    const a = timelordeTransportState({ running: 0, muteOutputs: 1 });
    const b = timelordeTransportState({ running: 1, muteOutputs: 0 });
    expect(a.short).not.toBe(b.short);
  });
});

describe('timelorde face — the SWING ROSTER is DERIVED from the jacks it names', () => {
  it('is TOTAL over swingSource’s declared range', () => {
    const p = paramById('swingSource');
    expect(TIMELORDE_SWING_SOURCES.map((o) => o.value)).toEqual(
      Array.from({ length: p.max - p.min + 1 }, (_, i) => p.min + i),
    );
    expect(p.options, 'the def does not declare the derived roster').toBe(TIMELORDE_SWING_SOURCES);
  });

  it('every label IS a gate OUTPUT id — the selector names the cable', () => {
    // ⚠ THE PROPERTY THAT MAKES THE ROSTER WORTH DERIVING. A player patches "the
    // 4x out" and swings "the 4x train"; if the two ever printed different words
    // the selector would stop naming anything a cable could be found by.
    const gateOuts = timelordeDef.outputs.filter((o) => o.type === 'gate').map((o) => o.id);
    for (const o of TIMELORDE_SWING_SOURCES) {
      expect(gateOuts, `'${o.label}' is not an output on this module`).toContain(o.label);
    }
    expect(
      TIMELORDE_SWING_SOURCES.map((o) => o.label),
      'the roster names `swing` — a train cannot shadow itself',
    ).not.toContain('swing');
  });

  it('the DOCK resolves a SELECTOR, not a wall of twelve buttons', () => {
    expect(paramCellKind(paramById('swingSource'), EMPTY, 'dock')).toBe('selector');
  });

  it('THE CARD READS THE SAME LIST — no re-typed copy survives', () => {
    // The backdraft one-source rule, applied to a list. `SRC_LABELS` used to be a
    // hand-typed twelve-entry literal in the card; a literal there would be a
    // second copy free to disagree with the def about which index is `1/12`.
    expect(cardSrc, 'the card imports the derived roster').toContain('TIMELORDE_SWING_SOURCES');
    expect(
      /const SRC_LABELS\s*=\s*\[/.test(cardSrc),
      'the card re-declares SRC_LABELS as a literal array — that is the duplicate this face removed',
    ).toBe(false);
  });
});

describe('timelorde face — the TAP cell, and why its probe needed two new fields', () => {
  const cell = shellCellFor('timelorde', {
    key: 'timelorde-tap-{n}',
    kind: 'family',
    label: 'tap',
  });

  it('resolves an ACTION cell in trigger mode with a handler', () => {
    expect(cell?.kind).toBe('action');
    expect(cell?.kind === 'action' && (cell.mode ?? 'trigger')).toBe('trigger');
    expect(cell?.kind === 'action' && typeof cell.onFire).toBe('function');
  });

  it('probes the BPM PARAM — and the paramId is one this module declares', () => {
    // ⚠ The cross-check the generic gate cannot do without the registry: a probe
    // naming a param that does not exist would poll `null` against `null` forever
    // and time out, which is a probe that can only fail.
    expect(cell?.kind === 'action' && cell.probe.effect.kind).toBe('param');
    const pid =
      cell?.kind === 'action' && cell.probe.effect.kind === 'param' ? cell.probe.effect.paramId : '';
    expect(timelordeDef.params.map((p) => p.id), `'${pid}' is not a declared param`).toContain(pid);
  });

  it('declares TWO presses — and ONE press is genuinely a no-op, which is why', () => {
    // ⚠ THE MEASUREMENT, not a preference. `TapTempo` needs two timestamps to
    // have an interval; the first press returns null and writes nothing. A
    // single-press probe therefore reads bpm unchanged on a PERFECTLY WORKING
    // button — indistinguishable from a dead one, which is the sixstrum defect.
    expect(cell?.kind === 'action' && cell.probe.presses).toBe(2);
  });

  it('the FACE TAP and the CARD TAP are one implementation', () => {
    // Both routes call the same `TapTempo` and write through `setNodeParam`, so
    // the Spacebar shortcut, the card button and the face pad cannot disagree
    // about what a tap means.
    const faceTapSrc = stripComments(readFileSync(resolve(HERE, 'timelorde/face-tap.ts'), 'utf-8'));
    expect(faceTapSrc).toContain("from '$lib/electra/tap-tempo'");
    expect(cardSrc).toContain("from '$lib/electra/tap-tempo'");
    // ⚠ NODE-KEYED, NOT COMPONENT-HELD. A tap series spans presses and the
    // faceplate cell's component unmounts on collapse / LRU / tab switch — the
    // #1531 class — so a component-held controller would forget the first tap.
    expect(
      /new Map<string, TapTempo>/.test(faceTapSrc),
      'the face tap controller is not node-keyed — a series would not survive a remount',
    ).toBe(true);
  });
});

describe('timelorde body — it BLITS the producer, it does not re-render it', () => {
  it('pulls video_out’s own drawFrame rather than painting an owl', () => {
    // ⚠ THE CLAIM THAT KEEPS ONE RENDERER. The picture is composited by
    // `TimelordeCard` and pushed as `write(node,'displayFrame')`; `video_out`'s
    // `drawFrame` blits the latest. A second owl renderer here would be a second
    // place for the display to be wrong on a module whose whole design tension is
    // that two states look identical.
    expect(bodySrc).toContain("getVideoSource?.(nodeId, 'video_out')");
    expect(bodySrc).toContain('drawFrame');
    expect(
      /drawOwl|applyBeatBoost|OWL_SRC/.test(bodySrc),
      'the body renders the owl itself — that is a second implementation of the card’s display',
    ).toBe(false);
  });

  it('SCREEN OFF costs a BLIT and never the producer', () => {
    // ⚠ THE SHARPEST OBLIGATION ON THIS MODULE. The card's rAF is the SOLE writer
    // of `displayFrame`, and `drawFrame` falls back to a #07090d idle field with
    // nothing pushed — so a SCREEN switch that stopped the producer would be a
    // preview toggle acting as a kill switch for everything downstream
    // (#1720/#1721). It cannot happen here because this body is a pure consumer:
    // nothing it does reaches the card. Pinned by ABSENCE, which is falsifiable.
    expect(
      /handle\.write|\.write\(\s*node|markWatched/.test(bodySrc),
      'the body writes to the node or claims a watch mark — it is supposed to be a pure consumer, ' +
        'and either would make SCREEN OFF able to affect the producer',
    ).toBe(false);
    // …and the collapse really does gate only the paint.
    expect(bodySrc).toContain('!previewCollapsed');
  });

  it('the SCREEN state lives on node.data, never in component state', () => {
    // A `$state` here dies with the component, and this component unmounts on
    // dock collapse / LRU eviction (#1531 / #1574 / #1583). `node.data` survives a
    // tab switch — the owner's stated floor — a remount, a reload, and syncs.
    expect(bodySrc).toContain('previewCollapsed');
    expect(bodySrc).toContain('mutateNode');
    expect(
      /let\s+previewCollapsed\s*=\s*\$state/.test(bodySrc),
      'previewCollapsed is component state — it would reset on every dock collapse',
    ).toBe(false);
  });

  it('the WIZARD switch and the SCREEN switch are NOT merged', () => {
    // `wizardOn` is a graph param that syncs to rack-mates and is drivable by the
    // `gate` input; `previewCollapsed` is local view furniture. Merging them would
    // collapse a collaborator's preview when you hid your owl.
    // ⚠ READING it is fine and is what the accessible name is FOR — the label has
    // to say whether the owl is hidden. WRITING it is the merge, so the leg is
    // aimed at the write paths and at the testid that would make the body claim a
    // second cell for the param (`faces-parity` asserts EXACT multiset equality
    // between the dock's `control-*` testids and the def's params, and it scans
    // the extension body too).
    expect(
      /setNodeParam/.test(bodySrc),
      'the body writes a PARAM — its only write is previewCollapsed on node.data',
    ).toBe(false);
    expect(
      /wizardOn\s*[:=]\s*(?!\s*$)/.test(bodySrc.replace(/params\.wizardOn/g, '')),
      'the body assigns wizardOn — the display switch and the wizard param must stay separate',
    ).toBe(false);
    expect(
      /control-wizardOn|data-control-params/.test(bodySrc),
      'the body claims a control cell — it would be an EXTRA control against the def’s param multiset',
    ).toBe(false);
    // …and the param keeps its own cell in a band, which is the fallback §6 of
    // the spec names: there is no body-surfaced mechanism for a plain param
    // (`face.xyPads[].surface` is pads only) and `module-face-lint`'s
    // completeness loop has no skip list, so a param with no cell is RED.
    expect(timelordeDef.face?.order, 'wizardOn lost its own cell').toContain('wizardOn');
    expect(
      (timelordeDef.face?.pages ?? []).flatMap((p) => p.controls),
      'wizardOn is ranked but sits in no band',
    ).toContain('wizardOn');
  });

  it('stays a 2D context — a WebGL body would put this module in the GPU attest basis', () => {
    // ⚠ MEASURED: `scripts/webgl-attest-hash.sh --list` returns 218 files and none
    // of them is a timelorde file, so this face costs NO attest. That is a
    // property of what the surfaces DO, not of where they live: the basis sweeps
    // WebGL-context-creating cards under `lib/ui/modules`. A `getContext('webgl')`
    // here would put a real-GPU attest on every future edit to this module.
    expect(
      /getContext\(\s*['"]webgl/.test(bodySrc) || /getContext\(\s*['"]webgl/.test(cardSrc),
      'a WebGL context appeared on a timelorde surface — this module would join the attest basis',
    ).toBe(false);
  });
});

describe('timelorde face — the DISPLAY’s determinism is a DECODE, not a freeze', () => {
  it('the card awaits img.decode() before the first paint', () => {
    // ⚠ THE MEASUREMENT: `vrt-live-surfaces.ts` recorded 13 of 20 SEPARATE
    // PROCESSES failing the timelorde CARD scene unmasked. Under
    // prefers-reduced-motion the card paints EXACTLY ONE frame and stops, and
    // `owlReady` used to flip in `onload` — which fires when the bytes arrive,
    // not when the bitmap is rastered — so the latched frame was a function of
    // boot speed. The card scene could be masked; the FACES roster has no mask
    // mechanism at all, so the dock baseline would have inherited that flake with
    // nowhere to put it. Fixed at the source instead.
    expect(cardSrc).toContain('img.decode()');
    expect(
      /owlReady\s*=\s*true/.test(cardSrc),
      'the owl-ready latch vanished — this leg is measuring nothing',
    ).toBe(true);
  });

  it('the PUSH is CONVERGENT, not fire-and-forget — the reduced-motion defect', () => {
    // ⚠ FOUND BY THIS FACE AND FIXED IN THE SAME DIFF, and it was never a face
    // bug: under `prefers-reduced-motion` the card paints ONE frame and pushes
    // ONE bitmap, so a write that lands before the engine handle exists (or on a
    // handle that is then replaced) is lost FOREVER and `video_out` serves the
    // #07090d idle field for the rest of the session. MEASURED on a default rack
    // with `reducedMotion: 'reduce'`, the card mounted and its own canvas
    // carrying the owl at `nonBlack 47034/48400`: `video_out` read
    // `nonBlack 0/3072, maxLuma 9`. Non-reduced racks never saw it because the
    // ordinary rAF re-pushes every frame and the loss self-heals invisibly.
    //
    // The card now ASKS the node whether its frame arrived and re-pushes only
    // while it has not — which also heals a replaced handle, where a one-shot
    // retry could not.
    expect(cardSrc).toContain("'hasDisplayFrame'");
    expect(
      /if \(e && node && e\.read\?\.\(node, 'hasDisplayFrame'\) !== 1\) pushDisplayFrame\(\)/.test(cardSrc),
      'the reduced-motion branch no longer re-pushes while the node holds no frame — a single ' +
        'lost write makes video_out dark for the whole session',
    ).toBe(true);
  });

  it('declares NO freeze param — so freezeIsNotASeam must NOT be declared either', () => {
    // `UnbaselinableFace.freezeIsNotASeam` is REQUIRED when a def declares
    // `freeze` and FORBIDDEN when it does not, so declaring one here would redden
    // the gate in the second direction. And `freezeFaceVideo` writes
    // `params.freeze` on the VIDEO engine, which does not produce this picture at
    // all — the seam is structurally inapplicable, not merely unused.
    expect(timelordeDef.params.map((p) => p.id)).not.toContain('freeze');
  });
});
