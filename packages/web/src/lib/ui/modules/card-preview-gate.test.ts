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
      'rather than on the thumbnail, which is the wrong element. Relevant to #1785: if live ' +
      'lane thumbnails come back for promoted faces, this is the loop they land on.',
  },
};

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

function sourceFiles(): Array<{ name: string; src: string }> {
  return readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.svelte') || (f.endsWith('.ts') && !f.endsWith('.test.ts')))
    .sort()
    .map((name) => ({ name, src: stripComments(readFileSync(join(MODULES_DIR, name), 'utf8')) }));
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
