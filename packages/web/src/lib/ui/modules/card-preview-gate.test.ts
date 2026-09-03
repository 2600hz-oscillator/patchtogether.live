// packages/web/src/lib/ui/modules/card-preview-gate.test.ts
//
// A CARD MAY NOT PREVIEW ITS OWN NODE THROUGH THE UNGATED BLIT (#1802).
//
// `VideoEngine.blitOutputToDrawingBuffer` marks the node WATCHED, which makes
// it a pull root, which pulls its whole upstream chain into every frame. A card
// that calls it unconditionally therefore keeps a chain rendering whether or
// not it is showing anything — MEASURED: `toybox → backdraft`, backdraft's
// output patched nowhere and its card not expanded, both nodes drew 481 frames
// in 4 s for a picture presented on no surface at all.
//
// `blitOutputForPreview(id)` is the same call with the viewport gate and the
// preview cadence cap applied, returning whether the drawing buffer actually
// holds the picture, so the card can skip its `drawImage` — the synchronising
// half, and the expensive one.
//
// ── why this gate is at the SOURCE level ───────────────────────────────────
//
// There is no runtime gate that can see this. Both methods do the same thing
// when a card is visible and on cadence, so every pixel test, every VRT
// baseline and every render smoke passes either way. The difference only shows
// up as main-thread milliseconds on a rack nobody is looking at — which is
// exactly the shape CLAUDE.md describes as needing a source gate, because "no
// runtime gate sees it".
//
// ── DENY BY DEFAULT, with the exemption anchored to what it claims ─────────
//
// The rule keys on the ARGUMENT, which is what actually distinguishes the two
// cases:
//   * `blit…(id)`            — the card's OWN node. That is a preview. Gated.
//   * `blit…(src.nodeId)`    — somebody ELSE's node, whose pixels this card
//                              CONSUMES (WAVESCULPT uploads them into a GL
//                              texture, SYNESTHESIA derives audio levels from
//                              them, TIMELORDE composites them into the frame
//                              it pushes back). The consumer's need for fresh
//                              pixels has nothing to do with the SOURCE card's
//                              viewport, and gating it would feed a producer a
//                              stale frame — the #1721/#1728 failure class.
//
// So a bare `id` argument is the offence, and anything else is out of scope by
// construction rather than by listing filenames.
//
// ⚠ WHAT THIS GATE CANNOT SEE, stated inside the gate:
//   * it reads TEXT. A card that aliases its own id (`const n = id;` then
//     `blit…(n)`) is invisible here.
//   * it cannot tell whether the RESULT of `blitOutputForPreview` is actually
//     honoured beyond refusing the bare-statement form below — a card could
//     assign it and ignore it.
//   * it says nothing about the cards that legitimately consume another node:
//     whether THOSE keep working is an e2e question, and
//     `video-preview-gate.spec.ts` is where it is asked.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MODULES_DIR = join(import.meta.dirname);

/**
 * Files allowed to call the UNGATED blit with a bare `id`, and why. `why` is
 * required by the type, so `tsc` refuses an undeclared exemption before this
 * test runs.
 *
 * Anchored below in two directions: an entry naming a file that does not exist
 * is RED, and so is an entry for a file that no longer makes the call at all
 * (the exemption has stopped describing the code).
 */
interface UngatedExemption {
  why: string;
}

const UNGATED_OK: Readonly<Record<string, UngatedExemption>> = {
  'VideoTileThumb.svelte': {
    why:
      'ALREADY the reference implementation, and it previews a node whose CARD is elsewhere ' +
      '(it takes the node id as a prop). It carries its own IntersectionObserver — which ' +
      'really does `cancelAnimationFrame`, not just skip a frame — plus its own fps throttle. ' +
      'Routing it through the engine gate would key the viewport check on the SOURCE card ' +
      'rather than on the thumbnail, which is the wrong element. #1785 LANDED and live lane ' +
      'thumbnails are back for promoted video faces, so this loop now serves BOTH tile hosts ' +
      '(ModuleShellPlaceholder and ModuleShell) — one more reason the gate belongs on the ' +
      'thumbnail element rather than on any one card.',
  },
};

/**
 * Cards that install a ONE-SHOT PRESENT hook and are allowed NOT to present
 * immediately, and why. Same shape and same anchoring as {@link UNGATED_OK}:
 * `why` is required by the type, so `tsc` refuses an undeclared exemption.
 *
 * Empty is the correct resting state — see the `it` block for what earns a row.
 */
const THROTTLED_ONE_SHOT_OK: Readonly<Record<string, UngatedExemption>> = {};

/** An assignment that PUBLISHES a one-shot render/present hook on the global —
 *  `g.__toyboxFreeze = (t) => { step(); present(); }` and its relatives. The
 *  shape, not a module name: any card that renders a specific frame on demand
 *  and then presents it is in scope. */
const ONE_SHOT_HOOK_INSTALL =
  /\b(?:g|w|globalThis)\.__[A-Za-z0-9_$]*(?:Freeze|Step)[A-Za-z0-9_$]*\s*=\s*(?:\(|function|async|[A-Za-z_$][\w$]*\s*=>)/;

/** The gated preview blit, in either arity. */
const GATED_PREVIEW_CALL = /\bblitOutput(?:Port)?ForPreview\s*\(/;

/** `{ immediate: true }` reaching a preview blit — directly at the call site or
 *  forwarded through the card's own local blit helper. */
const IMMEDIATE_PRESENT = /\bimmediate\s*:\s*true\b/;

/** Strip comments conservatively: whole-line `//` and `*` continuations, and
 *  `/* … *\/` blocks. Deliberately NOT a mid-line `//` strip — CLAUDE.md's
 *  string-safety note (a naive `//` regex eats `'https://x'`) applies, and the
 *  conservative direction here is to keep text, which can only produce a LOUD
 *  false positive, never a silent miss. */
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

/**
 * Every module-owned source this gate judges: the flat `lib/ui/modules/*` files
 * AND one level of module directory beneath them.
 *
 * ⚠ THE SUBDIRECTORY LEVEL WAS ADDED 2026-09-02 BECAUSE THE FLAT WALK WENT
 * VACUOUS, and the vacuity floor above is what caught it rather than a reviewer.
 * toybox's promotion moved its console — the tree's only `__toyboxFreeze`
 * one-shot present hook — from `ToyboxCard.svelte` into
 * `toybox/ToyboxConsole.svelte`, so the ONE-SHOT population emptied and the
 * #1836 leg would have gone green while measuring nothing. That is the same
 * structural boundary `dom-source-modules.test.ts` widened its own walk for
 * (#1724: "the gate's file walk was flat + `*Card.svelte`-filtered, so the
 * pattern matched a file nothing read"), and it will keep happening: a
 * `fullViewBody` lives at `modules/<extension-id>/`, by the shell-extension
 * glob's own convention, so a face PR moves a card's preview code across this
 * boundary EVERY time.
 *
 * One level is deliberate rather than a full recursive walk: it is exactly the
 * depth the shell-extension glob itself looks at (one directory under
 * `lib/ui/modules`, holding that module's `shell-extension.ts`), so the subject
 * set is the same population the shell can actually load.
 */
function sourceFiles(): Array<{ name: string; src: string }> {
  const wanted = (f: string): boolean =>
    f.endsWith('.svelte') || (f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const out: Array<{ name: string; src: string }> = [];
  for (const entry of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const inner of readdirSync(join(MODULES_DIR, entry.name))) {
        if (!wanted(inner)) continue;
        const rel = `${entry.name}/${inner}`;
        out.push({ name: rel, src: stripComments(readFileSync(join(MODULES_DIR, rel), 'utf8')) });
      }
      continue;
    }
    if (!wanted(entry.name)) continue;
    out.push({
      name: entry.name,
      src: stripComments(readFileSync(join(MODULES_DIR, entry.name), 'utf8')),
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Calls to the ungated blit whose argument is the card's own `id`. */
const OWN_NODE_UNGATED = /\bblitOutput(?:Port)?ToDrawingBuffer\s*\(\s*id\s*[,)]/;

describe('#1802 card preview gate', () => {
  const files = sourceFiles();

  it('the sweep actually found the card sources (a vacuity floor)', () => {
    expect(
      files.some((f) => f.name === 'VideoOutCard.svelte'),
      'the module-card directory did not resolve, so every assertion below is vacuous',
    ).toBe(true);
    expect(
      files.some((f) => f.src.includes('blitOutputForPreview')),
      'NOT ONE card uses the gated preview blit. Either the migration was reverted or the ' +
        'comment-stripper is eating the code — both make this whole file green and blind.',
    ).toBe(true);
  });

  it('no card previews its OWN node through the ungated blit', () => {
    const offenders = files
      .filter((f) => OWN_NODE_UNGATED.test(f.src))
      .map((f) => f.name)
      .filter((name) => !(name in UNGATED_OK));

    expect(
      offenders,
      'These files call `blitOutputToDrawingBuffer(id)` — the UNGATED blit — for their own ' +
        'node.\n' +
        `  ${offenders.join(', ')}\n` +
        'That marks the node WATCHED every frame, which makes it a pull root, which pulls its ' +
        'whole upstream chain into the frame whether or not the card is showing anything. Use ' +
        '`blitOutputForPreview(id)` and skip the drawImage when it returns false.\n' +
        'If this really is a CONSUMER of another node\'s pixels, pass that node\'s id — the ' +
        'rule keys on the argument, not on the filename.',
    ).toEqual([]);
  });

  it('the gated result is USED, never called as a bare statement', () => {
    // `ve.blitOutputForPreview(id);` on its own is a gate whose answer is
    // thrown away: the blit is skipped but the drawImage still runs against a
    // stale drawing buffer — strictly worse than not gating, because the card
    // now shows another node's picture.
    const bare = files
      .filter((f) => /^\s*(?:[A-Za-z_$][\w$]*\.)*blitOutputForPreview\s*\([^)]*\)\s*;/m.test(f.src))
      .map((f) => f.name);
    expect(
      bare,
      'These files call `blitOutputForPreview` and discard the result:\n' +
        `  ${bare.join(', ')}\n` +
        'The return value is the whole point — it says whether the drawing buffer holds this ' +
        "node's picture. Ignoring it means painting whatever the previous card left there.",
    ).toEqual([]);
  });

  // ── #1836: A ONE-SHOT PRESENT MUST NOT BE THROTTLED ──────────────────────
  //
  // The cadence cap is sound for a FREE-RUNNING loop and only for one: the
  // frame it drops is replaced by the next rAF 8-16 ms later, so nobody sees
  // the gap. A card that renders ONE specific frame and then presents it — a
  // VRT/determinism hook, an on-demand refresh — has no next rAF. There the cap
  // does not defer the frame, it LOSES it, and the surface keeps showing an
  // older render for as long as nothing else repaints.
  //
  // MEASURED (#1836, `toybox-layer-input.spec.ts` at real GPU / workers=1):
  // twelve engine frames rendered through `__toyboxFreeze`, TWO presented. The
  // card was showing feedback iteration 2 while the engine was on iteration 12
  // — matcap distance 3.66 against a floor of 4, where the uncapped value is
  // 32.52. It reproduced 4 times in 6 and 0 times in 34 on main.
  //
  // Membership is DERIVED from the source (a global one-shot hook install +
  // the gated blit), not from a list of module names, so the next card that
  // grows a determinism hook is in scope the day it lands.
  it('a card that installs a ONE-SHOT PRESENT hook presents IMMEDIATELY', () => {
    const oneShotCards = files.filter(
      (f) => ONE_SHOT_HOOK_INSTALL.test(f.src) && GATED_PREVIEW_CALL.test(f.src),
    );

    // Vacuity floor with real slack: this asserts the DETECTOR still finds the
    // population, not how big the population is. If the two regexes stop
    // matching anything, every claim below is green and blind.
    expect(
      oneShotCards.map((f) => f.name),
      'NO card matched "installs a one-shot present hook AND uses the gated preview blit". ' +
        'Either the detector broke or the hooks moved — either way this assertion is vacuous ' +
        'and the next card to throttle a determinism hook will ship green.',
    ).not.toEqual([]);

    const offenders = oneShotCards
      .filter((f) => !IMMEDIATE_PRESENT.test(f.src))
      .map((f) => f.name)
      .filter((name) => !(name in THROTTLED_ONE_SHOT_OK));

    expect(
      offenders,
      'These cards publish a hook that renders a specific frame and then presents it, but ' +
        'never pass `{ immediate: true }` to the preview blit:\n' +
        `  ${offenders.join(', ')}\n` +
        'The preview cadence cap will silently eat that frame and the surface will keep ' +
        'showing the previous render. Pass `{ immediate: true }` on the ONE-SHOT path only — ' +
        'the free-running rAF loop must stay throttled, which is where the whole #1802 ' +
        'main-thread saving lives.',
    ).toEqual([]);

    // THE OTHER DIRECTION, PER FILE. "Pass `immediate: true`" is trivially
    // satisfied by passing it EVERYWHERE, which deletes the cadence cap and
    // with it the entire #1802 main-thread saving — and reads as a clean pass.
    // So each one-shot card must ALSO retain a preview call that does not force
    // it: the free-running loop it still runs.
    const capDeleted = oneShotCards
      .filter((f) => {
        const calls = [...f.src.matchAll(/\bblitOutput(?:Port)?ForPreview\s*\(([^()]*)\)/g)];
        return calls.length > 0 && calls.every((m) => IMMEDIATE_PRESENT.test(m[1] ?? ''));
      })
      .map((f) => f.name);
    expect(
      capDeleted,
      'These cards force `immediate: true` at EVERY preview call site:\n' +
        `  ${capDeleted.join(', ')}\n` +
        'That is not an escape hatch for the one-shot path, it is the cadence cap deleted — ' +
        'the card repaints every rAF again and the measured saving (step 49.7% -> 24.7% of ' +
        'the main thread) is gone. The free-running loop must keep the plain call.',
    ).toEqual([]);

    // ⚠ WHAT THIS CANNOT SEE, stated inside the gate: it reads TEXT. It proves
    // a one-shot card has BOTH a forced-immediate call and a plain one; it
    // cannot prove the immediate one is on the one-shot path and the plain one
    // on the rAF loop, and a card that aliases the option object
    // (`const now = { immediate: true }`) is invisible to it. The runtime half
    // of the pair is `e2e/tests/toybox-layer-input.spec.ts` (RED when a
    // one-shot present is throttled — measured 4 failures in 6 runs) and
    // `e2e/tests/video-preview-gate.spec.ts` (RED if throttling stops).
  });

  it('ANCHORED: every one-shot exemption names a file that still installs a hook', () => {
    const byName = new Map(files.map((f) => [f.name, f]));
    const stale = Object.keys(THROTTLED_ONE_SHOT_OK).filter((name) => {
      const f = byName.get(name);
      return !f || !ONE_SHOT_HOOK_INSTALL.test(f.src) || !GATED_PREVIEW_CALL.test(f.src);
    });
    expect(
      stale,
      'THROTTLED_ONE_SHOT_OK names a file that no longer exists or no longer installs a ' +
        'one-shot present hook. An entry naming something that is not there is RED.',
    ).toEqual([]);
  });

  it('ANCHORED: every ungated exemption names a file that still makes the call', () => {
    const byName = new Map(files.map((f) => [f.name, f]));
    const missing: string[] = [];
    const noLongerCalls: string[] = [];
    for (const name of Object.keys(UNGATED_OK)) {
      const f = byName.get(name);
      if (!f) {
        missing.push(name);
        continue;
      }
      if (!/\bblitOutput(?:Port)?ToDrawingBuffer\s*\(/.test(f.src)) noLongerCalls.push(name);
    }
    expect(
      missing,
      'UNGATED_OK names a file that does not exist. A ledger entry naming something that is ' +
        'not there is RED — it is how a list stops describing the code and starts describing ' +
        'history.',
    ).toEqual([]);
    expect(
      noLongerCalls,
      'These exemptions are for files that no longer call the ungated blit at all, so the ' +
        'exemption has stopped describing the code. Delete them.',
    ).toEqual([]);
  });
});
