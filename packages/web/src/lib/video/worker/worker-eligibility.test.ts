// packages/web/src/lib/video/worker/worker-eligibility.test.ts
//
// THE RENDER-LOCUS GATE (#1811).
//
// Answers, for EVERY video module and without a hand-typed name anywhere:
// does its GL compute run off the main thread, and if not, WHY not?
//
// Three claims, each of which can genuinely go red:
//
//  1. DERIVED MEMBERSHIP, BOTH DIRECTIONS. The worker's bundle manifest
//     (`worker-factories.ts`) contains exactly the defs whose `renderLocus` is
//     a worker locus. Promote a def and forget the manifest → the module
//     silently keeps rendering on the main thread and the "migration" is a
//     comment. Leave a manifest entry behind after demoting a def → dead
//     DOM-free-ness risk in the worker bundle. Both are RED here.
//
//  2. NO DEF MAY CLAIM `'worker'` WITH A STRUCTURAL BLOCKER. `'worker'` means
//     PARITY-COMPLETE — it renders in the worker for every user in the default
//     flag state. A def with a picture input, a second picture output or an
//     AudioContext port cannot be parity-complete there, because the worker
//     has no cross-thread input textures, a one-bitmap-per-node return
//     protocol and no AudioContext. `'worker-experimental'` is the tier for a
//     worker path with DECLARED gaps, and it is allowed to carry blockers.
//
//  3. DENY BY DEFAULT ON THE CANDIDATES. A def with NO structural blocker that
//     is nonetheless still on the main thread must be NAMED here with a
//     reason, and the reason is required BY THE TYPE. Add a clean pure-GL
//     source and forget to promote it and this test fails until someone
//     decides. That is the ratchet: "everything that can move, has moved"
//     stops being a claim in a PR body and becomes a gate.
//
// ── WHAT THIS GATE CANNOT SEE, stated inside the gate ──────────────────────
//
// It reads the DEF. It cannot see what the FACTORY does. `document`,
// `navigator.mediaDevices`, `localStorage`, a `window.__vrtSeed` harness hook,
// a card that pushes a canvas in through `read('extras')` — every one of those
// is a genuine blocker and NONE is visible from the contract. That is exactly
// why claim 3 does not auto-promote: an empty blocker list makes a def a
// CANDIDATE, and a human either promotes it or records the factory-level
// reason below, where `why` is a required field.
//
// ⚠ DOOM is not named anywhere in this file and must not be. It is BLOCKED by
// derivation — its def declares audio outputs, so `derivedBlockers` returns
// `['audio-port']` and it never reaches the candidate set. No sweep here
// touches it, by construction rather than by exemption.

import { describe, it, expect } from 'vitest';
import '$lib/video/modules';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import {
  DOM_SOURCE_LANE_TYPES,
  CARD_PRODUCER_LANE_TYPES,
} from '$lib/ui/workflow/dom-source-modules';
import { NODE_VIDEO_SOURCE_TYPES } from '$lib/ui/media/node-video-source-registry';
import { NODE_VARISPEED_TYPES } from '$lib/ui/media/node-varispeed-registry';
import { NODE_HLS_SOURCE_TYPES } from '$lib/ui/media/node-hls-source-registry';
import { NODE_LOOPBACK_SOURCE_TYPES } from '$lib/ui/media/node-loopback-source-registry';
import { NODE_CAMERA_SOURCE_TYPES } from '$lib/ui/media/node-camera-source-registry';
import { NODE_ARCHIVIST_SOURCE_TYPES } from '$lib/ui/media/node-archivist-source-registry';
import { WORKER_FACTORY_TYPES } from './worker-factories';
import { derivedBlockers, declaredLocus, disposition } from './worker-eligibility';

/**
 * ⚠ `domSourceTypes` IS A UNION, AND IT HAD TO BECOME ONE (legacy-removal S1).
 *
 * The `dom-source` blocker means "a live DOM `<video>`/`<img>` feeds this
 * module's texture, so its picture is main-thread BY DEFINITION". This gate fed
 * it `DOM_SOURCE_LANE_TYPES` alone, which is a narrower claim — "the CARD
 * attaches the element and the engine keeps it". The two agreed for as long as
 * every DOM source was card-owned, and they stop agreeing the moment a
 * node-scoped controller takes one over: the element is every bit as live and
 * every bit as main-thread, and the module silently reclassifies as a
 * contract-clean CANDIDATE for the render worker.
 *
 * ⚠ THAT DIVERGENCE PRE-DATES THIS BRANCH BY THREE PHASES AND WENT UNSEEN,
 * which is the part worth recording. videobox, videovarispeed, peertube and
 * tvLibrarian all left `DOM_SOURCE_LANE_TYPES` in LEG-02 P1-P3 and all lost
 * their `dom-source` blocker with it. None of them surfaced here because every
 * one of them carries ANOTHER blocker — a video input, an audio port — so the
 * disposition never moved. The hole was covered by a coincidence about those
 * four modules' port shapes, not by anything this gate checks. `loopback` is
 * simply the first node-owned DOM source with a clean enough contract to fall
 * through it, and promoting it to the worker would have rendered a black
 * picture: the worker realm cannot see a `<video>` element whoever owns it.
 *
 * Read the union as the durable question — "is a live DOM element pinned to the
 * main thread for this module", not "which file holds the reference".
 */
const DOM_SOURCE_TYPES_ANY_OWNER: ReadonlySet<string> = new Set<string>([
  ...DOM_SOURCE_LANE_TYPES,
  ...NODE_VIDEO_SOURCE_TYPES,
  ...NODE_VARISPEED_TYPES,
  ...NODE_HLS_SOURCE_TYPES,
  ...NODE_LOOPBACK_SOURCE_TYPES,
  ...NODE_CAMERA_SOURCE_TYPES,
  ...NODE_ARCHIVIST_SOURCE_TYPES,
]);

const INPUTS = {
  domSourceTypes: DOM_SOURCE_TYPES_ANY_OWNER,
  cardProducerTypes: CARD_PRODUCER_LANE_TYPES,
};

/**
 * A def with NO contract-level blocker that is deliberately still rendering on
 * the main thread, and the reason the contract cannot show.
 *
 * `why` is required by the type, so `tsc` refuses an undeclared holdout before
 * a test runs. Anchored in two directions by the test below: an entry naming a
 * def that no longer exists is RED, and so is an entry for a def that now HAS
 * a derived blocker (the entry has become redundant and its `why` is no longer
 * the real reason — which is worse than missing, because it reads authoritative).
 *
 * ── THE MEASUREMENT EVERY "cost" ENTRY BELOW REFERS TO (#1811) ──────────────
 *
 * Three of these were PROMOTED to `renderLocus:'worker'` during #1811, proven
 * to render correctly through the worker, and then DEMOTED AGAIN, because the
 * measurement said the migration made things worse. Recorded here so nobody
 * repeats it:
 *
 * Single-node rack (module → VIDEO OUT) + a SEQUENCER to run the scheduler
 * clock, measured with the in-page instrument (`__mainThreadCost`), 240
 * scheduler-tick arrivals per phase, `E2E_REAL_GPU=1` (ANGLE/Metal):
 *
 *   module     locus    engine.step ms/frame   engine rAF fps
 *   acidwarp   worker         0.0667               121.1
 *   acidwarp   main           0.0652               125.5
 *   inwards    worker         0.0640               121.3
 *   inwards    main           0.0359               121.9
 *   shapes     worker         0.0714               120.6
 *   shapes     main           0.0439               124.4
 *   tempest    worker         0.1181               123.0
 *   tempest    main           0.1172               122.2
 *
 * And under `E2E_SWIFTSHADER=1` (software GL, what CI runs) the frame-rate
 * cost is much larger: shapes 33.9 fps on main vs 19.7 fps in the worker,
 * inwards 33.7 vs 21.0, acidwarp 24.8 vs 15.9, tempest 21.4 vs 17.1.
 *
 * WHY, mechanically: a WebGL call returns when the command is QUEUED, so a
 * pure-GL module's shader work was never main-thread CPU in the first place —
 * there is nothing there to move. What the worker path ADDS is a
 * full-resolution `texImage2D(..., ImageBitmap)` upload per node per frame,
 * on the main thread. For a cheap module that upload costs more than the draw
 * it replaced.
 *
 * So the worker only pays for itself when a module's PER-FRAME MAIN-THREAD
 * cost (CPU work, or GPU back-pressure the main thread ends up waiting on)
 * exceeds one full-res bitmap upload. In this rack, measured, none of these
 * modules is close. The modules that ARE expensive — the ones that made the
 * owner's rack spend 82% of its main thread in `VideoEngine.step()` — all
 * carry a `video-input` blocker and cannot enter the worker at all until it
 * can resolve cross-thread input textures.
 */
interface MainThreadHoldout {
  /** What the factory does, or what the measurement showed, that the def
   *  cannot show. */
  why: string;
}

const MAIN_THREAD_HOLDOUTS: Readonly<Record<string, MainThreadHoldout>> = {
  inwards: {
    why:
      'CONTRACT-CLEAN AND PROVEN TO RENDER IN THE WORKER — held out on COST, not on ability. ' +
      'Measured (see the table above): promoting it moved engine.step from 0.0359 to 0.0640 ' +
      'ms/frame on a real GPU (the ImageBitmap upload costs more than the ring shader it ' +
      'replaces) and cut software-renderer throughput from 33.7 to 21.0 fps. Re-promote when ' +
      'the worker returns frames without a per-frame main-thread upload, not before.',
  },
  shapes: {
    why:
      'Same as inwards, and the clearest case: an SDF fullscreen quad is about as cheap as a ' +
      'module gets. Measured, promoting it moved engine.step from 0.0439 to 0.0714 ms/frame on ' +
      'a real GPU and 33.9 fps to 19.7 fps under software GL. The worker cannot save main-thread ' +
      'time on work the main thread was not doing.',
  },
  tempest: {
    why:
      'The best candidate of the three on paper — it rebuilds its whole vector well on the CPU ' +
      'every frame and uploads an interleaved VBO — and still a wash: 0.1172 → 0.1181 ms/frame. ' +
      'Its CPU work is ~0.12 ms, the same order as the bitmap upload that would replace it. ' +
      'ALSO a live interlock: P2-P6 add an audio-breathing tube, and an audio port or an ' +
      '`audioSources` publisher would make it structurally ineligible anyway.',
  },
  painter: {
    why:
      'The CARD owns the paint surface: it hands a live <canvas> to the handle through ' +
      "read('extras').setPaintCanvas(canvas) and the factory uploads it as a texture every " +
      'frame. The picture originates in the DOM, so there is nothing for the worker to ' +
      'render — the same seam as CARD_PRODUCER_LANE_TYPES, which this module is not a member ' +
      'of only because that set is derived from a different grep.',
  },
  textmarquee: {
    why:
      "Same card-pushed-surface seam as painter: read('extras').setTextCanvas(canvas, w, h). " +
      'The factory can paint its own placeholder on an OffscreenCanvas (which a worker does ' +
      'have), but the REAL text comes from the card, so a worker render would show the ' +
      'placeholder forever — a parity break, not a degradation.',
  },
  picturebox: {
    why:
      "The card decodes user-picked image files and pushes ImageBitmaps in through read('extras'), " +
      'one per asset slot. Decoding is main-thread/DOM work and the bitmaps live on the main ' +
      'side; moving the render without also moving the asset pipeline would show empty slots.',
  },
  scoreboard: {
    why:
      'Its digits are rasterised on an OffscreenCanvas (worker-safe) but the VRT harness pins ' +
      'the score through `window.__scoreboardVrtSeed`, and a worker realm has no `window`. ' +
      'Promoting it would leave the baseline capture reading an unseeded random score, so the ' +
      'blocker is the determinism hook, not the renderer.',
  },
};

describe('#1811 render-locus gate', () => {
  const defs = listVideoModuleDefs();

  it('the worker bundle manifest and the def registry agree — BOTH directions', () => {
    const workerLocusTypes = defs
      .filter((d) => declaredLocus(d) !== 'main')
      .map((d) => String(d.type))
      .sort();
    const manifestTypes = [...WORKER_FACTORY_TYPES].sort();

    expect(
      manifestTypes,
      'The render worker can only instantiate what its bundle manifest imports ' +
        '(worker/worker-factories.ts). These must be EXACTLY the defs declaring a worker ' +
        'renderLocus.\n' +
        `  defs declaring a worker locus: ${workerLocusTypes.join(', ') || '(none)'}\n` +
        `  manifest entries:              ${manifestTypes.join(', ') || '(none)'}\n` +
        'A def in the first list but not the second renders on the MAIN THREAD despite its ' +
        'declaration — the migration is a comment. A manifest entry with no def keeps a ' +
        'factory in the worker bundle that nothing can reach.',
    ).toEqual(workerLocusTypes);
  });

  it("no def claims parity-complete 'worker' while carrying a structural blocker", () => {
    const offenders = defs
      .filter((d) => declaredLocus(d) === 'worker')
      .map((d) => ({ type: String(d.type), blockers: derivedBlockers(d, INPUTS) }))
      .filter((r) => r.blockers.length > 0);

    expect(
      offenders,
      "renderLocus:'worker' means PARITY-COMPLETE — the module renders in the worker for " +
        'every user in the default flag state. A structural blocker makes that impossible:\n' +
        '  video-input        → the worker\'s getInputTexture always returns null, so the module\n' +
        '                       renders as if UNPATCHED (a different picture, not a worse one)\n' +
        '  multi-video-output → the return protocol is one ImageBitmap per node; the second port\n' +
        "                       can only be served by materialising the MAIN factory, i.e. a\n" +
        '                       double render that is slower than not migrating at all\n' +
        '  audio-port         → the worker realm has no AudioContext\n' +
        '  dom-source         → the CARD owns a <video>/<img>\n' +
        '  card-producer      → the CARD\'s own rAF IS the producer\n' +
        "Use 'worker-experimental' (explicit flag only) for a worker path with declared gaps.\n" +
        `Offenders: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it('every contract-clean CANDIDATE is either MOVED or NAMED with a factory-level reason', () => {
    const undeclared = defs
      .map((d) => disposition(d, INPUTS))
      .filter((r) => r.state === 'CANDIDATE')
      .filter((r) => !(r.type in MAIN_THREAD_HOLDOUTS))
      .map((r) => r.type);

    expect(
      undeclared,
      'These video modules carry NO structural blocker — nothing in their I/O contract stops ' +
        'them rendering off the main thread — yet they still render on it, and nothing says ' +
        'why.\n' +
        `  ${undeclared.join(', ')}\n` +
        'Either promote them (add `renderLocus: \'worker\'` to the def AND an import in ' +
        'worker/worker-factories.ts, then prove the picture with ' +
        'e2e/tests/render-worker-locus.spec.ts), or add a MAIN_THREAD_HOLDOUTS entry in this ' +
        'file naming what the FACTORY does that the contract cannot show (a DOM API, a ' +
        'card-pushed surface, a `window` harness hook). Deny-by-default is the point: a clean ' +
        'new source must not be able to ship on the main thread by nobody noticing.',
    ).toEqual([]);
  });

  it('ANCHORED: every holdout names a real def that is still contract-clean', () => {
    const byType = new Map(defs.map((d) => [String(d.type), d]));
    const stale: string[] = [];
    const redundant: string[] = [];
    const promoted: string[] = [];
    for (const type of Object.keys(MAIN_THREAD_HOLDOUTS)) {
      const def = byType.get(type);
      if (!def) {
        stale.push(type);
        continue;
      }
      if (derivedBlockers(def, INPUTS).length > 0) redundant.push(type);
      if (declaredLocus(def) !== 'main') promoted.push(type);
    }

    expect(
      stale,
      'MAIN_THREAD_HOLDOUTS names a module that no longer exists. A ledger entry naming ' +
        'something that is not there is RED, never quietly ignored — it is how a list stops ' +
        'describing the code and starts describing history.',
    ).toEqual([]);
    expect(
      redundant,
      'These holdouts are now REDUNDANT: the def acquired a structural blocker, so the ' +
        'contract already explains why it is on the main thread and the entry\'s `why` is no ' +
        'longer the real reason. A stale explanation that reads authoritative is worse than ' +
        'no explanation. Delete the entry.',
    ).toEqual([]);
    expect(
      promoted,
      'These holdouts have since been PROMOTED to a worker locus, so the entry contradicts ' +
        'the def. Delete the entry.',
    ).toEqual([]);
  });

  it('PERMANENT NEGATIVE CONTROL: the classifier reacts to each blocker it claims to detect', () => {
    // Without this, every assertion above is satisfied by `derivedBlockers`
    // returning `[]` unconditionally — the "green because it never looked"
    // reading. Each leg perturbs ONE clause of the worker contract on a
    // synthetic def and asserts the classifier notices, using the SAME
    // predicate the gates above call.
    const base = {
      type: 'synthetic',
      domain: 'video',
      label: 'synthetic',
      category: 'sources',
      inputs: [],
      outputs: [{ id: 'out', type: 'video' }],
      params: [],
      factory: () => {
        throw new Error('never instantiated');
      },
    } as unknown as Parameters<typeof derivedBlockers>[0];

    expect(derivedBlockers(base, INPUTS), 'a clean leaf source has no blockers').toEqual([]);
    expect(
      derivedBlockers({ ...base, inputs: [{ id: 'in', type: 'video' }] } as typeof base, INPUTS),
      'a `video` input is a blocker',
    ).toContain('video-input');
    expect(
      derivedBlockers({ ...base, inputs: [{ id: 'in', type: 'mono-video' }] } as typeof base, INPUTS),
      'a `mono-video` input is a blocker TOO — the bug an earlier pass of this analysis had',
    ).toContain('video-input');
    expect(
      derivedBlockers(
        { ...base, outputs: [{ id: 'a', type: 'video' }, { id: 'b', type: 'mono-video' }] } as typeof base,
        INPUTS,
      ),
      'a second picture output is a blocker',
    ).toContain('multi-video-output');
    expect(
      derivedBlockers({ ...base, outputs: [{ id: 'a', type: 'video' }, { id: 'g', type: 'gate' }] } as typeof base, INPUTS),
      'a CV-family OUTPUT means the handle publishes AudioNodes — the GIBRIBBON case',
    ).toContain('audio-port');
    expect(
      derivedBlockers({ ...base, inputs: [{ id: 'c', type: 'cv', paramTarget: 'c' }] } as typeof base, INPUTS),
      'a CV-family INPUT is NOT a blocker — the main thread resolves it and forwards setParam',
    ).toEqual([]);
    expect(
      derivedBlockers({ ...base, type: [...DOM_SOURCE_TYPES_ANY_OWNER][0] } as typeof base, INPUTS),
      // ⚠ READS THE UNION, NOT `DOM_SOURCE_LANE_TYPES`, which is EMPTY since
      // legacy-removal S1 — `[...emptySet][0]` is `undefined`, and a classifier
      // fed an undefined type returns no blockers, so this control would have
      // reported the classifier broken when only its INPUT had emptied. The
      // union is what the gate actually classifies on, so it is what the
      // control must exercise.
      'membership of the DOM-source union is a blocker',
    ).toContain('dom-source');
    expect(
      derivedBlockers({ ...base, type: [...CARD_PRODUCER_LANE_TYPES][0] } as typeof base, INPUTS),
      'membership of CARD_PRODUCER_LANE_TYPES is a blocker',
    ).toContain('card-producer');
  });
});
