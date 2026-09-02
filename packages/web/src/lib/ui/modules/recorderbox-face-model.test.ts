// packages/web/src/lib/ui/modules/recorderbox-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the recorderbox face (wave 5).
//
// ⚠ THIS FILE EXISTS BECAUSE EVERY GENERIC GATE PASSES VACUOUSLY OVER THIS
// FACE, exactly as it does over `videoOut`'s. `recorderboxDef` declares
// `params: []`, so `module-face-lint`'s completeness check, the dock
// render-plan parity check and `faces-parity` all enumerate an EMPTY set —
// their green runs would look identical if this face were completely broken.
// And `module-face-lint`'s "every promoted lane tile paints something" clause
// SKIPS a face that ranks nothing by design. So the coverage has to be written
// here, and it has to be about the two things the declaration cannot say:
// WHICH SURFACES EXIST, and WHAT THEY DO.
//
// ⚠ THE FAILURE THIS FILE IS REALLY GUARDING is not a missing knob. recorderbox
// is in NEITHER half of `HEADLESS_MOUNT_LANE_TYPES`, not in
// `DOM_SOURCE_LANE_TYPES` and not in `CARD_PRODUCER_LANE_TYPES`, so promotion
// stops `RecorderboxCard.svelte` mounting ANYWHERE on the default shell. Six
// behaviours lived only in that component; the extraction moved them to
// `./recorderbox-transport`, and a later edit that quietly re-inlines a start
// into one surface — or drops the reconciler from the other — would leave every
// registry gate green and one surface unable to record. The source legs below
// are what notice.
//
// ⚠ WHAT THIS FILE CANNOT SEE, stated rather than implied: it reads SOURCE. It
// cannot tell you a button is visible, hit-testable, or that a press reaches
// the registry with no card mounted. That is `recorderbox-face.spec.ts` on the
// DEFAULT shell, and its transport experiment is the runtime half of the same
// claim.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recorderboxDef } from '$lib/video/modules/recorderbox';
import {
  hasVideoSurface,
  laneBodyPlan,
  laneGlyphFor,
} from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { shellExtensionIds, loadShellExtension } from '$lib/ui/workflow/shell-extensions';
import {
  DOM_SOURCE_LANE_TYPES,
  CARD_PRODUCER_LANE_TYPES,
  HEADLESS_MOUNT_LANE_TYPES,
} from '$lib/ui/workflow/dom-source-modules';
import { NON_SHELL_LANE_TYPES } from '$lib/ui/workflow/legacy-fallback';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import '$lib/video/modules';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(HERE, 'recorderbox');
const FULL_VIEW_BODY = resolve(EXT_DIR, 'RecorderboxCaptureBody.svelte');
const TILE_BODY = resolve(EXT_DIR, 'RecorderboxTileBody.svelte');
const CARD = resolve(HERE, 'RecorderboxCard.svelte');
const SEAM = resolve(HERE, 'recorderbox-transport.ts');

const readRaw = (p: string): string => readFileSync(p, 'utf8');

/**
 * Source with COMMENTS REMOVED — the only honest input for a grep whose subject
 * matter is also the natural way to write down what it forbids.
 *
 * ⚠ EVERY ABSENCE LEG BELOW WENT RED ON ITS FIRST RUN WITHOUT THIS, and each
 * one was flagging its OWN explanation: this file's bodies carry comments
 * naming `recorder.abandon()`, `ShellEntryCell`, `<select>` and the two badge
 * sentences precisely because those are the shapes being refused. The shared
 * stripper (`$lib/source-guards/strip-source-comments`) exists for exactly this
 * class — it is quote- and regex-aware and replaces comment bytes with spaces,
 * so offsets do not move — and it handles the `<script>` block AND the markup,
 * which a `.svelte` gate needs. It also removes `<!-- … -->` markup comments,
 * which is where three of the four false positives lived.
 */
const read = (p: string): string => stripSourceComments(readRaw(p));

/** The three surfaces that can operate this module, by the name a failure
 *  message should print. Derived from the files, not from a list of claims. */
const SURFACES: readonly { name: string; path: string }[] = [
  { name: 'fullViewBody (RecorderboxCaptureBody)', path: FULL_VIEW_BODY },
  { name: 'tileBody (RecorderboxTileBody)', path: TILE_BODY },
  { name: 'legacy card (RecorderboxCard)', path: CARD },
];

const LANE_TIERS = ['mini', 'compact', 'full'] as const;

describe('recorderbox face — the DECLARATION', () => {
  it('is promoted, and its face is the videoOut shape', () => {
    expect(STRICT_FACES.has('recorderbox')).toBe(true);
    expect(recorderboxDef.face?.order).toEqual([]);
    expect(recorderboxDef.face?.glyph).toBe('none');
    expect(recorderboxDef.face?.extension).toBe('recorderbox');
  });

  it('the EMPTY order is HONEST — it is empty because `params` is', () => {
    // The forward-looking half, and the one that actually bites: an empty
    // `order` is correct only while there is nothing to rank. The day a param is
    // added, an empty order is a completeness failure that `module-face-lint`
    // WOULD catch — but it would also walk this tile toward the plate branch,
    // and that change deserves to be a deliberate edit here rather than a
    // surprise in a shared gate's output.
    expect(recorderboxDef.params).toEqual([]);
    expect((recorderboxDef.face?.order ?? []).length).toBe(recorderboxDef.params.length);
  });

  it('`glyph: none` is FORCED, not chosen — there is no audio OUTPUT to bind', () => {
    // `glyphBinding` short-circuits on the first `type: 'audio'` OUTPUT. This
    // def's audio ports are INPUTS (audio_l / audio_r), so no literal but `none`
    // could resolve anything live, and with `params: []` every other literal
    // falls through to a dead `{ kind: 'static' }` the dead-glyph clause refuses
    // by name. Asserted against the PORTS so it cannot rot into a preference.
    expect(recorderboxDef.outputs.some((o) => o.type === 'audio')).toBe(false);
    expect(recorderboxDef.inputs.filter((i) => i.type === 'audio').map((i) => i.id)).toEqual([
      'audio_l',
      'audio_r',
    ]);
  });

  it('the CONTRACT did not move for the face: no params, no port labels', () => {
    // `face` and `docs` are hash-transparent by construction (attest-code-basis
    // strips both), so this promotion costs ZERO GPU attest — but only while no
    // param and no `PortDef.label` is added to a def that sits in the WebGL
    // basis. The rail derives AUDIO L / AUDIO R where the card wrote A·L / A·R;
    // buying the card's spelling back would cost a real-GPU window for prose.
    expect(recorderboxDef.params).toEqual([]);
    for (const p of [...recorderboxDef.inputs, ...recorderboxDef.outputs]) {
      expect((p as { label?: string }).label, `port ${p.id} must declare no label`).toBeUndefined();
    }
  });
});

describe('recorderbox face — the LANE PICTURE', () => {
  it('resolves a live video surface, so the tile glyph is a PICTURE', () => {
    expect(hasVideoSurface(recorderboxDef)).toBe(true);
    expect(laneGlyphFor(recorderboxDef)).toBe('picture');
  });

  it('KEEPS that picture at EVERY lane tier', () => {
    const glyph = laneGlyphFor(recorderboxDef);
    const cells = (recorderboxDef.face?.order ?? []).length;
    for (const tier of LANE_TIERS) {
      expect(
        laneBodyPlan(cells, glyph, tier).glyph,
        `${tier}: the rack tile keeps its live picture`,
      ).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the plan can still answer FALSE, so the legs above are not constants', () => {
    // Without this, a `laneBodyPlan` that returned `glyph: true` for everything
    // would satisfy the assertions above while measuring nothing.
    //
    // ⚠ THE CONTROL IS A `trace`, NOT A `picture`, and the difference is the
    // rule itself: #1845 INVERTED the precedence for a picture, so a
    // control-heavy PICTURE face keeps its glyph and sheds cells instead — the
    // property recorderbox's own legs above depend on. Eviction survives for an
    // AUDIO face's scope strip, so that is where a working instrument can still
    // be shown answering false.
    const heavy = laneBodyPlan(28, 'trace', 'full');
    expect(heavy.layout).toBe('plate');
    expect(heavy.glyph, 'ranked cells still outrank a TRACE — the instrument can say false').toBe(false);
  });
});

describe('recorderbox face — the EXTENSION is REAL and fills BOTH wired slots', () => {
  it('the declared id resolves to a discovered extension', () => {
    // A `face.extension` naming a directory that does not exist degrades to the
    // generic shell at RENDER time and never throws, so only a test can tell
    // "the bespoke surface mounted" from "it silently did not". For this module
    // that is the whole faceplate.
    expect(shellExtensionIds()).toContain('recorderbox');
  });

  it('it fills fullViewBody AND tileBody — the tile is the load-bearing half', () => {
    // ⚠ THE TILE IS NOT A CONVENIENCE HERE. `Canvas.svelte`'s workflow seed
    // auto-spawns a recorderbox into the video zone of every fresh rack, and
    // this face ranks NOTHING — so a `fullViewBody`-only extension would make
    // the first module of every new session a live thumbnail with no way to
    // start a take under it. That is cameraInput's lesson one module worse, and
    // `EXTENSION_BODY_ROLES` is structurally unable to see a `tileBody` (its own
    // blind-spot list says so), which is why the assertion lives here.
    const src = read(resolve(EXT_DIR, 'shell-extension.ts'));
    expect(/fullViewBody:\s*RecorderboxCaptureBody/.test(src)).toBe(true);
    expect(/tileBody:\s*RecorderboxTileBody/.test(src)).toBe(true);
    expect(existsSync(FULL_VIEW_BODY)).toBe(true);
    expect(existsSync(TILE_BODY)).toBe(true);
  });

  it('and it LOADS, both slots present on the resolved map', async () => {
    const ext = await loadShellExtension('recorderbox');
    expect(ext, 'the extension module resolved').not.toBeNull();
    expect(ext!.fullViewBody, 'fullViewBody component').toBeTruthy();
    expect(ext!.tileBody, 'tileBody component').toBeTruthy();
  });

  it('NEGATIVE CONTROL: an id nobody declared resolves NULL', async () => {
    await expect(loadShellExtension('definitely-not-a-module')).resolves.toBeNull();
  });
});

describe('recorderbox face — NO CARD IS MOUNTED, which is what the seam is for', () => {
  it('recorderbox is in none of the card-keeping sets', () => {
    // The whole premise of the extraction. If a future PR adds recorderbox to
    // any of these, a headless card WOULD be mounted and half the reasoning in
    // the seam's header stops applying — so the change should have to edit this
    // assertion and say why.
    expect(HEADLESS_MOUNT_LANE_TYPES.has('recorderbox')).toBe(false);
    expect(DOM_SOURCE_LANE_TYPES.has('recorderbox')).toBe(false);
    expect(CARD_PRODUCER_LANE_TYPES.has('recorderbox')).toBe(false);
    expect(NON_SHELL_LANE_TYPES.has('recorderbox')).toBe(false);
  });

  it('ALL THREE surfaces drive the SHARED reconciler — none re-inlines a start', () => {
    // ⚠ THE STOP-2 PIN. `data.recording` is Y.Doc-synced, so the reactor also
    // handles a rack-mate's press and a patch loaded with `recording: true`.
    // Re-writing the start call at a surface would drop both paths while every
    // hand test still passed, which is why the check is "calls the seam", not
    // "starts a recording somehow".
    for (const { name, path } of SURFACES) {
      const src = read(path);
      expect(
        /reconcileRecorderboxTransport\(/.test(src),
        `${name}: must drive the shared reconciler`,
      ).toBe(true);
      expect(
        /nodeRecorder\.start\(/.test(src),
        `${name}: must NOT call nodeRecorder.start directly — go through the seam, or a surface `
          + 'can arm a take on terms the other two do not share',
      ).toBe(false);
    }
  });

  it('NO surface can end a recording on unmount — the #1574 shape is unexpressible', () => {
    // The registry deliberately exposes no teardown (no dispose, no release, no
    // detach), so `tsc` already refuses the call. These are the SPELLINGS that
    // existed before it did: a card `onDestroy` calling `recorder.abandon()`
    // made COLLAPSING the dock destroy the user's take — an owner P0.
    for (const { name, path } of SURFACES) {
      const src = read(path);
      expect(/\.abandon\(/.test(src), `${name}: must never abandon a recording`).toBe(false);
      expect(/nodeRecorder\.(dispose|release|detach)\(/.test(src), `${name}: no per-surface teardown`).toBe(false);
    }
  });

  it('the seam lives in lib/ui, OUTSIDE the WebGL attest basis', () => {
    // `packages/web/src/lib/video/**` is hashed WHOLESALE for the real-GPU
    // attest and nine recorderbox files already sit in it. A transport module
    // there would put every future folder-picker edit on the GPU-attest critical
    // path. `recorderbox-present-policy.ts` was placed here for the same reason.
    expect(existsSync(SEAM)).toBe(true);
    expect(SEAM.includes(`${'/lib/ui/'}`)).toBe(true);
    expect(SEAM.includes(`${'/lib/video/'}`)).toBe(false);
  });
});

describe('recorderbox face — the SCREEN switch, and what it cannot reach', () => {
  it('the full-view body reads, WRITES and exposes a button for previewCollapsed', () => {
    // The same three legs `video-face-screen-source.test.ts` runs fleet-wide,
    // re-asserted per module so a failure names recorderbox rather than a sweep.
    const src = read(FULL_VIEW_BODY);
    expect(src.includes('previewCollapsed')).toBe(true);
    expect(/\.data\.previewCollapsed\s*=/.test(src)).toBe(true);
    expect(/<button/.test(src)).toBe(true);
  });

  it('the COLLAPSED branch still renews the watch mark', () => {
    // ⚠ THIS IS NOT ABOUT THE RECORDING, and that distinction is the reason the
    // assertion is here at all. A take is safe by construction — it runs on the
    // registry's own pump under an `acquireRenderLease` that bypasses both
    // preview gates. What the mark protects is the IDLE case: `markWatched` is
    // how a node stays a pull root, and recorderbox is a mid-chain sink with a
    // video pass-through, so a collapsed branch that stopped marking would idle
    // the whole chain feeding `in` and stall the `out` every downstream module
    // reads — a control labelled SCREEN muting a signal path.
    const src = read(FULL_VIEW_BODY);
    const collapsedBranch = /if\s*\(previewCollapsed\)\s*\{[\s\S]*?\n\s{4}\}/.exec(src);
    expect(collapsedBranch, 'the collapsed branch of the draw loop').not.toBeNull();
    expect(
      /markWatched\(/.test(collapsedBranch![0]),
      'SCREEN OFF must still mark the node watched',
    ).toBe(true);
  });

  it('the canvas is the conventional `<prefix>-face-canvas`, INSIDE the collapse guard', () => {
    // `face-screen-render-suite` derives the element the switch REMOVES from the
    // prefix, so a rename here silently makes that row assert nothing.
    const src = read(FULL_VIEW_BODY);
    expect(src).toContain('data-testid="recorderbox-face-canvas"');
    expect(/\{#if !previewCollapsed\}[\s\S]*recorderbox-face-canvas/.test(src)).toBe(true);
  });
});

describe('recorderbox face — the RESTING READOUTS that were DELETED', () => {
  const bodySources = () => SURFACES.slice(0, 2).map((s) => ({ ...s, src: read(s.path) }));

  it('no faceplate surface paints the ELAPSED TIME, the SAVING word or the CHUNK line', () => {
    // The card painted `REC {fmtElapsed(elapsed)}` over the picture, a literal
    // `SAVING…`, and `saved {lastSavedChunk}`. All three are derived values
    // outside a control — the 2026-08-17/19 rulings' exact shape — and all three
    // are `StatusLed` `detail` now, reaching aria-label and title only.
    for (const { name, src } of bodySources()) {
      expect(/>\s*\{?\s*(fmtElapsed|formatElapsed)\(/.test(src), `${name}: elapsed painted`).toBe(false);
      expect(src.includes('SAVING…'), `${name}: the SAVING state word is painted`).toBe(false);
      expect(/>\s*saved\s*\{/.test(src), `${name}: the chunk line is painted`).toBe(false);
    }
  });

  it('the two capability BADGES became LAMPS — no sentence outside a control', () => {
    for (const { name, src } of bodySources()) {
      // ⚠ THE PREDICATE IS "NOT IN A TEXT NODE", NOT "NOT IN THE FILE". The
      // sentences SURVIVE — that is the point of the conversion — they just
      // survive on `detail`, which reaches aria-label and title and never the
      // page. A naive `!src.includes(...)` would refuse the correct shape.
      for (const phrase of ['no H.264 encoder', 'crash recovery unavailable', 'crash-recovery unavailable']) {
        const painted = new RegExp(`>[^<>{]*${phrase.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}`, 'i');
        expect(painted.test(src), `${name}: "${phrase}" is painted as a text node`).toBe(false);
      }
    }
    // …and the facts they carried survive, on the primitive that cannot paint
    // them. `StatusLed` has no `value` prop by design.
    const full = read(FULL_VIEW_BODY);
    expect(full.includes('StatusLed')).toBe(true);
    expect(/detail="[^"]*no H\.264 encoder/.test(full), 'the sentence is a lamp detail').toBe(true);
  });

  it('every StatusLed CAPTION is a literal — the call-site half of the primitive', () => {
    // `status-led-source.test.ts` proves the COMPONENT cannot paint a
    // measurement; it cannot see what a caller passes, and
    // `caption={lit ? 'REC 0:12' : 'REC'}` defeats the design from outside.
    for (const { name, src } of bodySources()) {
      const computed = [...src.matchAll(/caption=\{([^}]*)\}/g)].map((m) => m[1]!.trim());
      expect(computed, `${name}: a caption is a NAME, so it is a string literal`).toEqual([]);
    }
  });

  it('NEGATIVE CONTROL: these predicates DO fire on the shapes they refuse', () => {
    // Four absence checks over a mis-read file would look exactly like four
    // passes, so each predicate is shown rejecting the thing it exists for.
    expect(/>\s*\{?\s*(fmtElapsed|formatElapsed)\(/.test('<span> {fmtElapsed(elapsed)}</span>')).toBe(true);
    expect(/>\s*saved\s*\{/.test('<span> saved {lastSavedChunk}</span>')).toBe(true);
    expect(/>[^<>{]*no H\.264 encoder/i.test('<span class="badge">no H.264 encoder available</span>')).toBe(true);
    expect(/caption=\{([^}]*)\}/.test("<StatusLed caption={lit ? 'REC 0:12' : 'REC'} />")).toBe(true);
    // …and the real sources are non-empty, so the loops above are not running
    // over blank strings.
    for (const { name, src } of bodySources()) {
      expect(src.length, `${name}: source read`).toBeGreaterThan(500);
    }
  });
});

describe('recorderbox face — the controls that must NOT become generic cells', () => {
  it('the FILE field is a real <input type="text">, not a ShellEntryCell', () => {
    // `ShellEntryCell` forbids clamping and the shipped save path SANITIZES
    // (`recorderbox-store.sanitizeRecordingFilename`), so an entry cell's
    // rejections would disagree with the name actually written to disk. This
    // field is also what discharges the typed-entry parity leg for this module.
    const src = read(FULL_VIEW_BODY);
    expect(src).toContain('data-testid="recorderbox-face-filename"');
    expect(/type="text"/.test(src)).toBe(true);
    expect(src.includes('ShellEntryCell')).toBe(false);
  });

  it('SIZE keeps its `disabled` — the SOLE guard on a mid-take quality change', () => {
    // `onQualityChange` carries no `recState` check of its own, so this
    // attribute is the whole interlock. `Selector.svelte` HAS `disabled`;
    // `ShellSelectorCell` cannot reach it, which is why SIZE is not a cell.
    const src = read(FULL_VIEW_BODY);
    const select = /<select[\s\S]*?>/.exec(src);
    expect(select, 'the SIZE select').not.toBeNull();
    expect(/disabled=\{busy\}/.test(select![0]), 'SIZE must be disabled mid-take').toBe(true);
  });

  it('RECORD is disabled ONLY once the probe has ANSWERED', () => {
    // `disabled={support.checked && !support.canRecord}` — not
    // `disabled={!support.canRecord}`. The difference is a slow probe painting a
    // dead-looking switch on a machine that can encode perfectly well.
    for (const { name, path } of SURFACES.slice(0, 2)) {
      const src = read(path);
      expect(
        /disabled=\{support\.checked && !support\.canRecord\}/.test(src),
        `${name}: RECORD must gate on checked AND canRecord`,
      ).toBe(true);
    }
  });

  it('the TILE can start a take at all — the cameraInput lesson', () => {
    const src = read(TILE_BODY);
    expect(src).toContain('data-testid="recorderbox-tile-record"');
    expect(/onclick=\{toggleRecord\}/.test(src)).toBe(true);
  });

  it('⚠ THE TILE STARTS NO ENCODER PROBE AT MOUNT — the ~60-scene VRT regression', () => {
    // THE DEFECT THIS PINS, measured by CI rather than reasoned about: the tile
    // body used to kick `probeRecorderboxSupport` from a mount `$effect`. That
    // is a REAL four-frame encode-and-flush (`probeEncoders` deliberately does
    // not trust `isConfigSupported`), and `Canvas` auto-spawns a recorderbox
    // into every workflow rack — so it ran codec work on EVERY rack boot, while
    // every other video tile's thumb was establishing its first frames. The
    // first strict VRT run after the promotion reddened ~60 scenes: every video
    // face's COMPACT tile plus several timing-sensitive dock scenes. The two
    // video face scenes that PASSED were recorderbox's own, i.e. exactly the two
    // where `__recorderboxTestEncoder` skips the probe — CI ran the controlled
    // experiment for us. (videoOut's promotion put an equally live thumb in the
    // same zone and moved TWO baselines, which rules out "one more tile".)
    //
    // The tile may still READ a cached answer and may probe ON INTENT; what it
    // must never do again is probe because it mounted.
    const src = read(TILE_BODY);
    expect(
      src.includes('cachedRecorderboxSupport'),
      'the tile reads the memoised answer rather than starting a probe',
    ).toBe(true);
    // No `$effect` in this body may reach the probe. Scan each effect block.
    for (const m of src.matchAll(/\$effect\(/g)) {
      const start = m.index!;
      // Take the balanced-ish tail: up to the next `\n  });` at script indent.
      const end = src.indexOf('\n  });', start);
      const block = src.slice(start, end === -1 ? src.length : end);
      expect(
        /probeRecorderboxSupport\(/.test(block),
        'a mount/reactive effect in the TILE body starts an encoder probe again — that is the '
          + '~60-scene VRT regression. Probe on intent, or read the cache.',
      ).toBe(false);
    }
  });

  it('NEGATIVE CONTROL: the effect scan CAN see a probe inside an effect', () => {
    // Four absence checks over a mis-parsed file look exactly like four passes.
    const fixture = '$effect(() => {\n    void probeRecorderboxSupport(1, 2);\n  });';
    const start = fixture.indexOf('$effect(');
    const end = fixture.indexOf('\n  });', start);
    expect(/probeRecorderboxSupport\(/.test(fixture.slice(start, end))).toBe(true);
    // …and the real tile really does contain at least one effect to scan.
    expect((read(TILE_BODY).match(/\$effect\(/g) ?? []).length).toBeGreaterThan(0);
  });

  it('the DOCK body still probes at mount — the asymmetry is deliberate', () => {
    // Opening a dock full view is ONE deliberate act on ONE node, and the
    // ENCODER / RECOVERY fault lamps are that surface's job and cannot be
    // painted without an answer. Memoised, so it is a cache read once anything
    // has asked.
    expect(/probeRecorderboxSupport\(/.test(read(FULL_VIEW_BODY))).toBe(true);
  });

  it('the tile does NOT duplicate the dock body\'s heavy surfaces', () => {
    // A 192 px tile cannot hold a text field, an ellipsised path and a
    // three-option select without becoming the card again — and none of the
    // three is needed to START. The recovery scan is deliberately dock-only too,
    // which also keeps an IndexedDB read off every rack boot.
    const src = read(TILE_BODY);
    expect(src.includes('recorderbox-tile-filename')).toBe(false);
    expect(src.includes('<select')).toBe(false);
    expect(src.includes('scanRecoverableTakes'), 'no OPFS scan on the lane').toBe(false);
  });
});
