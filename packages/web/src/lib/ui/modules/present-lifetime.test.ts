// present-lifetime.test.ts
//
// THE SOURCE-LEVEL GATE for node-owned PRESENTATION lifetime — pure unit, no
// GL, no DOM, no browser. Sibling of $lib/ui/media/card-media-lifetime.test.ts,
// same reasoning, different resource.
//
// WHY A SOURCE GREP. The defect is a TEARDOWN in a card's unmount path, and no
// runtime gate in this repo can see it: the engine keeps rendering, pull-eval
// keeps evaluating, and every def-reading gate is on the wrong side of the
// contract. Measured on the real thing (present-survives-card-collapse.spec.ts,
// pre-fix): collapsing BACKDRAFT's dock full-view closed the projector window
// outright, and with the close removed the node's render lease was gone too.
// When the only observable is in the SOURCE, guard the source.
//
// DENY BY DEFAULT + AUTO-ENROLLING. The subject set is DERIVED from the card
// sources — every `*Card.svelte` that calls `createPresent(` — so a module that
// gains a projector tomorrow is enrolled the day it is written, with no list to
// update. There is deliberately NO exemption list and NO count: at zero
// exemptions a list measures nothing and can only go stale, and the population
// is a property of the tree, not a number to maintain.
//
// WHAT IT FORBIDS, and why each is a real bug rather than a style rule:
//   * `present.dispose()` / `present.stop()` in an unmount path — closes the
//     projector when the VIEW goes away. Under the faceplate shell an
//     un-migrated video module has no lane card at all, so "collapse" IS an
//     unmount and this is the owner-reported "the output stops".
//   * a `getCanvas:` argument to createPresent — hands the blit loop the CARD's
//     <canvas>, which the unmount detaches. The popup then draws that element's
//     last bitmap forever: open, and frozen.
// Both are legitimate on NODE deletion, which is why they live in
// $lib/ui/modules/node-present-registry, swept from Canvas against the live
// node set.
//
// ⚠⚠ WHAT THIS GATE IS STRUCTURALLY UNABLE TO SEE. It reads card SOURCE, so it
// cannot see a teardown reached indirectly — a helper module called from
// onDestroy that stops sessions on the card's behalf would be invisible to it,
// and so would a projector killed by something that is not a card at all. The
// interface itself is the stronger half of the guard there: PresentController
// has no `dispose` and no way to enumerate other nodes' sessions, so `tsc`
// refuses the direct route before this test runs (use-present.test.ts pins the
// runtime shape too). A permanent leg below asserts that absence, so "fixing"
// the interface back into having one goes red here rather than silently
// restoring the hazard.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CARD_DIR = fileURLToPath(new URL('./', import.meta.url));

/** Strip line + block comments so prose about a forbidden pattern (including
 *  this file's own explanations, quoted in card headers) cannot trip the gate. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function cardSource(card: string): string {
  return stripComments(readFileSync(new URL(`${card}.svelte`, `file://${CARD_DIR}`), 'utf8'));
}

/** Cards that offer "Present on a second display" — derived from the artifact,
 *  so a new presenting module enrols itself. */
function presentingCards(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(CARD_DIR)) {
    if (!file.endsWith('Card.svelte')) continue;
    if (/createPresent\s*\(/.test(cardSource(file.replace(/\.svelte$/, '')))) {
      out.push(file.replace(/\.svelte$/, ''));
    }
  }
  return out.sort();
}

/** The body of every `onDestroy(...)` call in a card, as one string.
 *  PAREN-MATCHED rather than line-sliced, so a multi-line teardown is covered in
 *  full and a `present.dispose()` on the fifth line of one cannot hide.
 *
 *  ALL THREE UNMOUNT SHAPES, not just the obvious one. `onDestroy` is what the
 *  four presenting cards use today, but a `onMount(() => … return () => …)`
 *  return-value teardown and a `$effect` cleanup run on unmount just the same —
 *  and a gate that only knew the current shape would go blind the day a card
 *  changed hook, silently, with nothing to notice. An effect CLEANUP is if
 *  anything the worse case: it also fires on every dependency change, so a
 *  `present.stop()` there would close the projector mid-session. `pathsSelfTest`
 *  below is the permanent negative control on this scanner. */
function unmountPaths(src: string): string {
  const out: string[] = [];
  for (const [hook, cleanupOnly] of [
    ['onDestroy', false],
    ['onMount', true],
    ['$effect', true],
  ] as const) {
    const re = new RegExp(`${hook.replace('$', '\\$')}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      const from = i;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const body = src.slice(from, i + 1);
      if (!cleanupOnly) {
        out.push(body);
        continue;
      }
      // Only the CLEANUP half of onMount/$effect is an unmount path; the setup
      // half is ordinary init and may legitimately touch the controller.
      const ret = /\breturn\s*(?:\(\s*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(body);
      if (ret) out.push(body.slice(ret.index));
    }
  }
  return out.join('\n');
}

describe('present lifetime — the projector belongs to the NODE, not the card', () => {
  it('the subject set is derived and contains every card that can present', () => {
    const cards = presentingCards();
    // Anchored to NAMES, not a count: a name that no longer resolves is red,
    // and a card that gains createPresent is picked up with no edit here.
    expect(cards).toEqual(
      expect.arrayContaining(['B3ntb0xCard', 'BackdraftCard', 'BentboxCard', 'VideoOutCard']),
    );
    // Non-vacuity anchored to a name the population must contain, rather than a
    // floor on its size.
    expect(cards).toContain('BackdraftCard');
  });

  it('NO presenting card tears its projector down on unmount', () => {
    const offenders: string[] = [];
    for (const card of presentingCards()) {
      const teardown = unmountPaths(cardSource(card));
      for (const pattern of [/present\s*\.\s*dispose\s*\(/, /present\s*\.\s*stop\s*\(/]) {
        if (pattern.test(teardown)) offenders.push(`${card}: ${pattern.source} in an unmount path`);
      }
    }
    expect(
      offenders,
      'a card unmount is a VIEW change (shell collapse / dock move), not a node deletion — ' +
        'close projectors from $lib/ui/modules/node-present-registry\'s graph sweep instead',
    ).toEqual([]);
  });

  it('NO presenting card hands the blit loop its own canvas', () => {
    const offenders: string[] = [];
    for (const card of presentingCards()) {
      const src = cardSource(card);
      const call = /createPresent\s*\(\s*\{[\s\S]{0,400}?\}\s*\)/.exec(src)?.[0] ?? '';
      if (/getCanvas\s*:/.test(call)) offenders.push(`${card}: createPresent({ getCanvas: … })`);
      if (!/nodeId\s*:/.test(call)) offenders.push(`${card}: createPresent without a nodeId`);
    }
    expect(
      offenders,
      'the blit source must be the ENGINE (via the node id), never a card element — ' +
        'an unmounted card leaves a detached canvas and the projector freezes on its last frame',
    ).toEqual([]);
  });

  // PERMANENT NEGATIVE CONTROL ON THE SCANNER ITSELF. A gate that reads source
  // is only as good as its reader, and "found nothing" and "looked nowhere" are
  // indistinguishable from a green run. Feed it each unmount shape with the
  // offending call inside, and each shape's SETUP half with a legitimate call
  // inside, and require it to separate them. A reader that returned '' — or the
  // whole file — fails this.
  it('PERMANENT LEG: the unmount-path reader sees all three hooks, and only their teardowns', () => {
    const seen = (src: string) => unmountPaths(src).includes('present.stop()');

    expect(seen('onDestroy(() => {\n  a();\n  present.stop();\n});'), 'onDestroy').toBe(true);
    expect(seen('onMount(() => {\n  go();\n  return () => { present.stop(); };\n});'), 'onMount cleanup').toBe(true);
    expect(seen('$effect(() => {\n  read();\n  return () => present.stop();\n});'), '$effect cleanup').toBe(true);

    expect(seen('function onClick() { present.stop(); }'), 'a plain handler is not a teardown').toBe(false);
    expect(seen('onMount(() => { present.stop(); });'), 'onMount SETUP is not a teardown').toBe(false);
    expect(seen('$effect(() => { present.stop(); });'), '$effect SETUP is not a teardown').toBe(false);
  });

  it('PERMANENT LEG: the controller exposes no card-reachable teardown at all', () => {
    const api = stripComments(
      readFileSync(new URL('./use-present.svelte.ts', `file://${CARD_DIR}`), 'utf8'),
    );
    const iface = /export interface PresentController\s*\{[\s\S]*?\n\}/.exec(api)?.[0] ?? '';
    expect(iface, 'PresentController interface found').not.toBe('');
    expect(
      /\bdispose\s*\(/.test(iface),
      'PresentController must not regain a dispose() — its absence is what makes the ' +
        'card-unmount teardown unrepresentable rather than merely discouraged',
    ).toBe(false);
  });
});
