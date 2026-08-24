// packages/web/src/lib/ui/modules/twotracks-face-model.test.ts
//
// The twotracks faceplate's own gate — and it is mostly NEGATIVE CONTROLS,
// because almost everything this face decided is UNPROTECTED. Three of its
// choices would go green if reversed:
//
//   * the refused LANE GLYPH — a live-audio literal here is LEGAL and would
//     redden nothing (§ "the glyph trap" below);
//   * the SCREEN switch — the video-screen ruling's population is
//     `STRICT_FACES ∩ video defs` and this module is `domain: 'audio'`, so no
//     gate can see the switch or its deletion;
//   * the ORDER inside the collapse — skipping the engine READ instead of the
//     PAINT looks identical from every gate and from most screenshots.
//
// So they are asserted here, at the source, with a control in both directions
// wherever the assertion could pass vacuously.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { twotracksDef, TWOTRACKS_FILTER_MODES, TWOTRACKS_LOFI_MODES, cardParamToWorkletParam } from '$lib/audio/modules/twotracks';
import { glyphBinding } from '$lib/ui/workflow/shell-glyph-live';
import { dockFacePlan, dockPlanControls } from '$lib/ui/workflow/curated-face';
import { dockTabPlan, DOCK_TAB_MIN_BANDS } from '$lib/ui/workflow/dock-tabs-model';
import { shellCellFor, type ShellCell } from '$lib/ui/workflow/shell-cells';
import { reelOutSample } from '../../../../../dsp/src/lib/twotracks-engine';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const BODY = read('./twotracks/TwotracksReelBody.svelte');
const EXT = read('./twotracks/shell-extension.ts');
const ACTIONS = read('./twotracks-face-actions.ts');

const face = twotracksDef.face!;

describe('twotracks face — the deleted params stay deleted', () => {
  // ⚠ ANCHORED TO THE DEF, NOT TO A LIST OF NAMES WE REMEMBER. `playhead_a` /
  // `playhead_b` were DECLARED PARAMS THAT NOTHING WROTE AND NOTHING READ, and
  // they survived for as long as they did because the card never mounted a
  // control for them — the inertness was invisible until a face was obliged to
  // rank every param. Re-adding one would be silent again.
  it('no param on this module is a PLAYHEAD — the playhead is transient engine state', () => {
    const offenders = twotracksDef.params.filter((p) => /playhead/i.test(p.id));
    expect(
      offenders.map((p) => p.id),
      'the playhead moves at frame rate: a param would put it on the undo stack and in ' +
        'the Y.Doc every frame, which is the CV write-storm class. It is read through ' +
        "engine.read(node,'playheadA') and scrubbed with a {type:seek} message.",
    ).toEqual([]);
  });

  it('POSITIVE CONTROL: the predicate can see a playhead param when there is one', () => {
    // Without this the clause above would read identically green if the filter
    // were broken rather than the population empty.
    const synthetic = [...twotracksDef.params, { id: 'playhead_a', label: 'x', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const }];
    expect(synthetic.filter((p) => /playhead/i.test(p.id)).map((p) => p.id)).toEqual(['playhead_a']);
  });

  it('a SAVED RACK carrying params.playhead_a is inert rather than broken', () => {
    // The deletion is only safe if an old envelope still loads. The engine maps
    // card param ids to worklet AudioParams by NAME through this function and
    // never enumerates `node.params`, so an unknown key is simply never read.
    expect(cardParamToWorkletParam('playhead_a')).toBeNull();
    expect(cardParamToWorkletParam('playhead_b')).toBeNull();
    // POSITIVE CONTROL — the mapper is not just returning null for everything.
    expect(cardParamToWorkletParam('rate_a')).toBe('rate');
  });
});

describe('twotracks face — the FILTER roster is the DSP’s, not the prose’s', () => {
  // ⚠ THREE RECORDS OF ONE ROSTER DISAGREED, and the face is what made it
  // matter: a cycle button that paints only the CURRENT mode cannot be wrong
  // about a name it never shows, but a segmented control shows all four. The
  // def's own `docs` string said "off / low-pass / high-pass / band-pass" —
  // modes 1 and 2 the wrong way round — while `packages/dsp/src/twotracks.ts`
  // selects `taps.hp` at 1 and `taps.lp` at 2. The DSP is the consumer, so the
  // DSP decides.
  it('mode 1 is HIGH-pass and mode 2 is LOW-pass, matching the SVF tap order', () => {
    const byValue = Object.fromEntries(TWOTRACKS_FILTER_MODES.map((m) => [m.value, m.label]));
    expect(byValue).toEqual({ 0: 'OFF', 1: 'HP', 2: 'LP', 3: 'BP' });
  });

  it('the DSP source really does select the taps in that order', () => {
    // Anchored to the code rather than to our reading of it: if someone swaps
    // the branches, this clause is what notices the roster is now a lie.
    const dsp = read('../../../../../dsp/src/twotracks.ts');
    const branch = dsp.slice(dsp.indexOf('SVF Filter'), dsp.indexOf('SVF Filter') + 900);
    expect(branch).toMatch(/filterMode === 1\)\s*\{\s*sL = tapsL\.hp/);
    expect(branch).toMatch(/filterMode === 2\)\s*\{\s*sL = tapsL\.lp/);
  });

  it('both rosters name EVERY reachable value of their param, once', () => {
    for (const [id, roster] of [
      ['filterMode_a', TWOTRACKS_FILTER_MODES],
      ['filterMode_b', TWOTRACKS_FILTER_MODES],
      ['lofi', TWOTRACKS_LOFI_MODES],
    ] as const) {
      const p = twotracksDef.params.find((q) => q.id === id)!;
      const want = Array.from({ length: p.max - p.min + 1 }, (_, i) => p.min + i);
      expect(roster.map((o) => o.value), `${id} roster covers its whole range`).toEqual(want);
      expect(p.options, `${id} declares the roster`).toBe(roster);
    }
  });
});

describe('twotracks face — THE GLYPH TRAP (permanent negative leg)', () => {
  // ⚠ NOTHING REDDENS IF SOMEONE ADDS A LANE GLYPH HERE, which is exactly why
  // this block exists. The refusal is a judgement about what the picture would
  // SAY, and a judgement with no test is a document a future author may simply
  // disagree with.
  it('a live-audio glyph really WOULD resolve — the trap is real, not hypothetical', () => {
    // `primaryAudioOutPortId` finds the first `type: 'audio'` output, and this
    // module declares two. So the binding is LIVE, the dead-glyph clause stays
    // green, and VALID_GLYPHS is satisfied. Nothing would stop the literal.
    const binding = glyphBinding({ ...twotracksDef, face: { ...face, glyph: 'live-audio' } } as never);
    expect(binding).toMatchObject({ kind: 'live-audio', portId: 'out_l' });
  });

  it('…and the face refuses it anyway', () => {
    expect(face.glyph).toBe('none');
  });

  it('THE REASON: three different reel states are INDISTINGUISHABLE at out_l', () => {
    // What a player wants from a tape machine at a glance is "is there tape on
    // this reel, and where is the playhead". An output trace answers neither.
    // The worklet feeds the tape side only while ROLLING (play/rec/overdub);
    // ARMED and IDLE are silent there, and the input path is heard only with
    // MONITOR on. So:
    const LOUD = 0.9;
    // 1. stopped, holding a full take — the tape is not under the head.
    expect(reelOutSample(0, LOUD, false)).toBe(0);
    // 2. rolling with a BLANK tape — there is nothing to read back.
    expect(reelOutSample(0, LOUD, false)).toBe(0);
    // 3. rolling, monitoring silence.
    expect(reelOutSample(0, 0, true)).toBe(0);
    // Three distinct states, one picture — a flat line.
  });

  it('POSITIVE CONTROL: a rolling reel WITH tape is not flat, so the probe can move', () => {
    // Without this, the block above would pass just as happily if
    // `reelOutSample` returned 0 unconditionally — the instrument would be
    // broken in a way that reads exactly like the finding.
    expect(reelOutSample(0.5, 0, false)).toBeGreaterThan(0);
    expect(reelOutSample(0, 0.5, true)).toBeGreaterThan(0);
  });
});

describe('twotracks face — the SEVEN bands and the rail', () => {
  it('the rail engages through the ORDINARY threshold, with no opt-in', () => {
    const plan = dockFacePlan(twotracksDef as never)!;
    expect(plan.length).toBeGreaterThanOrEqual(DOCK_TAB_MIN_BANDS);
    expect(dockTabPlan(plan, 'dock-full', twotracksDef as never)).not.toBeNull();
    // ⚠ `face.tabbed` is OWNER-INSTRUCTION-ONLY and there is no instruction for
    // this module. The rail must come from the band count or not at all.
    expect(face.tabbed, 'twotracks must not force the rail').toBeUndefined();
  });

  it('every ranked control is CLAIMED by a page — no defensive tail band', () => {
    // `dockFacePlan` sweeps anything unclaimed into an `__unpaged` band, which
    // would silently make this an eight-band face and move its baseline. This
    // asserts the property rather than the number.
    const paged = new Set((face.pages ?? []).flatMap((p) => p.controls));
    expect(face.order.filter((k) => !paged.has(k))).toEqual([]);
    expect(dockFacePlan(twotracksDef as never)!.map((b) => b.id)).not.toContain('__unpaged');
  });

  it('neither TONE band stacks its clusters into a false console grid', () => {
    // Two equal-sized clusters STACKED would be handed a column ruler, which
    // claims column j means the same thing in both. Here column 1 would be EQ
    // LOW above FILTER MODE. It does not.
    for (const id of ['a-tone', 'b-tone']) {
      const page = (face.pages ?? []).find((p) => p.id === id)!;
      expect(page.clusterFlow, `${id} flows its clusters as a row`).toBe('row');
    }
  });
});

describe('twotracks face — the two gestures keep their two seams', () => {
  // ⚠ THE SPLIT IS THE WHOLE ARGUMENT and it is invisible to every runtime
  // gate: both gestures start as a pointer drag on one canvas.
  it('the LOOP MARKERS write params (durable, undoable, synced)', () => {
    expect(BODY).toMatch(/setNodeParam\(nodeId, 'start_a'/);
    expect(BODY).toMatch(/setNodeParam\(nodeId, 'end_a'/);
    expect(BODY).toMatch(/setNodeParam\(nodeId, 'start_b'/);
    expect(BODY).toMatch(/setNodeParam\(nodeId, 'end_b'/);
  });

  it('the PLAYHEAD scrub is an engine MESSAGE and never a param', () => {
    expect(BODY).toContain('twotracksSeek(nodeId, reel, frac)');
    expect(ACTIONS).toMatch(/postMessage\(\{ type: 'seek'/);
    // The refusal, stated as a claim about the source: no `setNodeParam` call
    // on this surface names a PLAYHEAD param. A face that made the playhead a
    // param would be the write-storm.
    //
    // ⚠ THE PATTERN TARGETS THE PARAM ID — the SECOND argument — and an earlier
    // version of it did not, which is worth leaving written down because the
    // sloppy version FAILED on correct code: `setNodeParam(nodeId, 'start_a',
    // clampLoopStart(frac, endA, rollingA ? shownPlayheadA : null))` legitimately
    // READS the playhead to clamp a marker against it, and a grep for
    // "setNodeParam(...playhead" cannot tell that from writing one.
    expect(BODY).not.toMatch(/setNodeParam\([^,]*,\s*['"][^'"]*playhead/i);
  });

  it('POSITIVE CONTROL: that pattern can see a playhead WRITE', () => {
    // The clause above is a `not.toMatch` over real source, which is the shape
    // most likely to pass because the pattern is broken rather than because the
    // code is clean.
    expect("setNodeParam(nodeId, 'playhead_a', frac);").toMatch(
      /setNodeParam\([^,]*,\s*['"][^'"]*playhead/i,
    );
    // …and does NOT fire on the legitimate clamp-read that shipped.
    expect("setNodeParam(nodeId, 'start_a', clampLoopStart(frac, endA, shownPlayheadA));").not.toMatch(
      /setNodeParam\([^,]*,\s*['"][^'"]*playhead/i,
    );
  });

  it('the clamp arithmetic is IMPORTED, never re-typed beside the drag', () => {
    expect(BODY).toMatch(/import \{[\s\S]*clampLoopStart[\s\S]*\} from '\$lib\/audio\/modules\/twotracks'/);
    expect(BODY).toContain('clampLoopEnd');
  });
});

describe('twotracks face — the EXPORT seam is not the transport seam', () => {
  // ⚠ RESOLVED THROUGH THE REAL DOCK PLAN rather than by reaching into the
  // registry object: `shellCellFor` is the function the shell itself calls, so
  // a cell that is declared but does not RESOLVE (a key the plan spells
  // differently, say) fails here instead of passing on a lookup nobody makes.
  const cells: Record<string, ShellCell> = {};
  for (const ctl of dockPlanControls(dockFacePlan(twotracksDef as never)!)) {
    const cell = shellCellFor('twotracks', ctl);
    if (cell) cells[ctl.key] = cell;
  }

  it('SAVE TAPE watches file-export — REC on the same node must not satisfy it', () => {
    // ⚠ THE ADJACENCY IS THE HAZARD: SAVE TAPE sits in the same reel block as
    // REC, on the same node. A probe watching `engine-message` here would be
    // green because the user pressed a DIFFERENT button.
    for (const key of ['twotracks-save-a-{n}', 'twotracks-save-b-{n}']) {
      expect(cells[key]).toMatchObject({
        kind: 'action',
        probe: { effect: { kind: 'audition', seam: 'file-export' } },
      });
    }
  });

  it('every TRANSPORT cell is a trigger on the engine-message seam', () => {
    const transport = Object.entries(cells).filter(([k]) => /-(rec|play|stop)-/.test(k));
    expect(transport.length).toBeGreaterThan(0);
    for (const [key, cell] of transport) {
      expect(cell, `${key} is a one-shot, not a held gate`).toMatchObject({
        kind: 'action',
        mode: 'trigger',
        probe: { effect: { kind: 'audition', seam: 'engine-message' } },
      });
    }
  });

  it('an export of an EMPTY reel is recorded, not dropped', () => {
    // "Pressed and exported nothing" and "never pressed" must stay
    // distinguishable — the card answers an empty reel with a silent no-op.
    // ⚠ `delivered` means THE SEAM WAS REACHED, so an empty reel that resolved a
    // live node and a live port DELIVERED, with a `false` RETURN for a caller
    // that cares. Recording false there would make every bare-rack press look
    // like a broken button, and faces-parity presses on a bare rack.
    expect(ACTIONS).toMatch(/recordAudition\(\{ nodeId, seam: 'file-export', delivered: true \}\)/);
    expect(ACTIONS).toMatch(/return twotracksReelHasTape\(node, reel\)/);
  });
});

describe('twotracks face — SCREEN ON/OFF (unguarded, so asserted at source)', () => {
  it('the body READS and WRITES the fleet-standard previewCollapsed key', () => {
    expect(BODY).toMatch(/previewCollapsed = next/);
    // On node.data, never component $state: a dock LRU eviction unmounts this
    // component, and component state would re-open the picture the player shut.
    expect(BODY).not.toMatch(/let previewCollapsed = \$state/);
  });

  it('⚠ the read goes STRAIGHT to the store, not through an intermediate derived', () => {
    // ⚠ A REAL DEFECT SHIPPED AND WAS CAUGHT HERE, so this is a regression pin
    // rather than style. Reading the flag through an intermediate
    // `data = $derived(node?.data)` made the switch DEAD ON A FRESH SPAWN: a
    // bare twotracks has NO `node.data` (the engine creates it only when the
    // worklet first posts, which needs a running context), so the intermediate
    // memoised `undefined` and never re-ran when the toggle created the object.
    // The click wrote through correctly and the button never moved.
    //
    // ⚠ AND EVERY SOURCE-LEVEL ASSERTION ABOUT THE SWITCH PASSED THROUGHOUT —
    // it reads the key, it writes the key, the bail guards the paint, the order
    // is right. Only `face-screen-render.spec.ts`'s runtime leg could see it,
    // which is the argument for that SUBJECTS row in one sentence.
    expect(BODY).toMatch(/patch\.nodes\[nodeId\]\?\.data\?\.previewCollapsed/);
  });

  it('⚠ THE ORDER: the collapse skips the PAINT and never the engine READ', () => {
    // This is the clause that catches a collapse implemented by stopping the
    // read — which looks identical from every gate and from a screenshot, and
    // would mean switching SCREEN back on shows a STALE tape.
    const readIdx = BODY.indexOf('onMeterFrame(gateEl');
    const bailIdx = BODY.indexOf('if (previewCollapsed) return;');
    const paintIdx = BODY.indexOf('drawTwotracksReel(canvasElA');
    expect(readIdx, 'the per-frame engine read exists').toBeGreaterThan(-1);
    expect(bailIdx, 'the collapse bail exists').toBeGreaterThan(-1);
    expect(paintIdx, 'the paint exists').toBeGreaterThan(-1);
    // The bail sits BETWEEN the read and the paint — i.e. it guards the paint.
    expect(bailIdx).toBeGreaterThan(readIdx);
    expect(paintIdx).toBeGreaterThan(bailIdx);
    // …and the read callback itself contains no collapse test.
    const readBlock = BODY.slice(readIdx, bailIdx);
    expect(readBlock, 'the engine read is NOT gated on the switch').not.toContain('previewCollapsed');
  });

  it('the per-frame read is visibility-gated on an ALWAYS-MOUNTED element', () => {
    // Gating on a canvas would be wrong twice: the canvases are removed while
    // collapsed, so an IntersectionObserver would never report and the read
    // would stop for the wrong reason.
    expect(BODY).toMatch(/const gateEl = wrapEl;/);
    expect(BODY).toMatch(/bind:this=\{wrapEl\}/);
  });

  it('the two testids `face-screen-render` locates are the ones the body emits', () => {
    // ⚠ THE RUNTIME LEG IS IN ANOTHER FILE AND CANNOT SEE THIS ONE. That spec
    // builds its locators from a declared `prefix` — `<prefix>-face-screen-toggle`
    // by convention, plus a `canvas` override — so a rename here would make it
    // fail with "element(s) not found" and blame the FACE rather than the
    // testid. Pinning both names on this side turns that into a unit failure
    // naming the actual change.
    expect(BODY).toContain('data-testid="twotracks-face-screen-toggle"');
    expect(BODY).toContain('data-testid="twotracks-face-reels"');
    // …and the element the override names really is the one the collapse
    // removes, rather than something outside the `{#if}` that would never move.
    const gate = BODY.indexOf('{#if !previewCollapsed}');
    const reels = BODY.indexOf('data-testid="twotracks-face-reels"');
    const toggle = BODY.indexOf('data-testid="twotracks-face-screen-toggle"');
    expect(gate, 'the collapse gate exists').toBeGreaterThan(-1);
    expect(reels, 'the reels container is INSIDE the collapse gate').toBeGreaterThan(gate);
    expect(toggle, 'the toggle itself is OUTSIDE it — it must survive its own press').toBeLessThan(gate);
  });

  it('the extension records WHY the switch is here, since nothing else can', () => {
    expect(EXT).toContain('previewCollapsed');
    expect(EXT.length, 'the argument is written down, not implied').toBeGreaterThan(400);
  });
});

describe('twotracks face — the body shows BOTH reels, and why', () => {
  it('two canvases, one per reel', () => {
    expect(BODY).toContain('twotracks-face-canvas-a');
    expect(BODY).toContain('twotracks-face-canvas-b');
  });

  it('the reason is a PLATFORM FACT, and it is still true', () => {
    // The build spec asked for the ACTIVE TAB's reel. A body is handed only
    // `nodeId`, so it is never told which tab is showing. If that ever changes,
    // this clause is where the decision gets revisited rather than inherited.
    const props = read('../workflow/shell-extensions.ts');
    const block = props.slice(props.indexOf('interface ShellExtensionFullViewBodyProps'));
    expect(block.slice(0, block.indexOf('}'))).not.toContain('activePage');
  });

  it('the picture stays 2D — a WebGL reel would enrol the module in the attest basis', () => {
    // ⚠ THE SUBJECT IS THE CONTEXT REQUEST, NOT THE WORD. A plain `/webgl/i`
    // sweep over the source FAILED on the very comment that explains why the
    // surface must stay 2D — the third occurrence of "did I match CODE or PROSE
    // about code?" this repo has recorded, met here by writing the assertion
    // against `getContext(...)` calls instead.
    const draw = read('./twotracks-waveform-draw.ts');
    const contexts = [...BODY.matchAll(/getContext\(\s*['"]([^'"]+)['"]/g), ...draw.matchAll(/getContext\(\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1]);
    expect(contexts.length, 'the surface really does request a context').toBeGreaterThan(0);
    expect([...new Set(contexts)]).toEqual(['2d']);
  });
});
