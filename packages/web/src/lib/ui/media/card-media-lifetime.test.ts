// packages/web/src/lib/ui/media/card-media-lifetime.test.ts
//
// THE SOURCE-LEVEL GATE for node-owned media lifetime — pure-unit, no GL, no
// DOM, no browser.
//
// WHY A SOURCE GREP AND NOT A RUNTIME ASSERT: the defect is a TEARDOWN that
// runs on card unmount. No runtime gate in this repo can see it — the engine
// keeps drawing (measured: the per-node draw counter advanced 130 -> 619
// across the collapse that destroyed playback), pull-eval keeps the node
// evaluated, and every def-reading gate is looking at the wrong side of the
// contract. This is the same reasoning that put the `controlFamilies` ->
// card-testid grep and the `attachExternalSource` grep in the tree: when the
// only observable is in the SOURCE, guard the source.
//
// DENY BY DEFAULT + AUTO-ENROLLING. The subject set is DERIVED from the card
// sources, as the UNION of the two private card<->node channels:
//   * `attachExternalSource(` — the card hands the node a DOM element;
//   * `read(id, 'extras')`    — the card drives the node's *HandleExtras.
// Either one means the node's behaviour depends on a card being mounted, which
// is the precondition for every bug in this class.
//
// ⚠ IT USED TO DERIVE FROM DOM_SOURCE_LANE_TYPES, AND THAT WAS TOO NARROW.
// That set is itself sound — dom-source-modules.test.ts holds it exhaustive by
// grep — but it encodes only the FIRST channel, so it answered the wrong
// question. Measured 2026-08-12: attachExternalSource reaches 9 cards, the
// extras channel reaches 13, and the UNION is 17. The 8-card delta (toybox,
// picturebox, painter, textmarquee, doom, blood, nibbles, gibribbon) is where
// the remaining findings live, and the union would have enrolled each of them
// the day it was written. A correct list is not the same as the right
// predicate.
//
// WHAT IT FORBIDS, and why each one is a real bug and not a style rule:
//   * `URL.revokeObjectURL` in an unmount path — the loaded file becomes
//     unrecoverable; measured, this is what made re-expanding show the
//     "re-link your file" prompt for a video that had never been unloaded.
//   * `track.stop()` in an unmount path — a capture stream cannot be restarted
//     without a fresh user gesture, so loopback / cameraInput went dark
//     permanently rather than merely pausing.
//   * `attachExternalSource(..., null)` in an unmount path — detaches the
//     engine from an element that still exists and is still playing.
//   * `attachLayerVideo(..., null)` in an unmount path — the SAME detach on the
//     EXTRAS channel. Added with #1589: the gate derived its subject set from
//     both channels but only ever forbade the first channel's detach verb, so
//     TOYBOX's per-layer detach was invisible to it. A gate that enrols a card
//     for a channel it has no pattern for is enrolment, not coverage.
// All four are legitimate on NODE deletion; they belong to
// $lib/ui/media/node-media-registry, which is keyed to graph lifetime and
// swept from Canvas against the live node set.
//
// ⚠⚠ WHAT THIS GATE IS STRUCTURALLY UNABLE TO SEE — read this before citing it
// as coverage. Every pattern above is TEARDOWN-SHAPED: it reads `onDestroy`
// bodies and asks "does this card destroy something it should not?". There is a
// second, opposite failure mode in the same class that it CANNOT detect:
// a module that never INITIALISES. painter, textmarquee and picturebox have no
// teardown at all — their node renders a placeholder until a card mounts and
// pushes its canvas/image, so with the shell swapping the card out they are
// DARK BY DEFAULT rather than broken-on-collapse. This gate certifies all three
// as clean and they are not.
//
// They ARE in the subject set (asserted below), so widening the gate later
// covers them automatically. Until then the blindness is made explicit by a
// permanent negative-control leg — 'the gate does NOT see the
// never-initialises failure mode' — which fails if anyone "fixes" it into
// looking like coverage. Stating a gate's scope inside the gate is the
// 2026-08-02 blind-gate discipline: ask what a green run would look like if the
// answer were "everything".

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import { conventionalCardName, type CardDefLike } from '$lib/ui/modules-card-map';
import { DOM_SOURCE_LANE_TYPES } from '$lib/ui/workflow/dom-source-modules';

const CARD_DIR = fileURLToPath(new URL('../modules/', import.meta.url));

/** Channel 1: the card hands the node a DOM element. */
const ATTACH_RE = /attachExternalSource\s*\(/;
/** Channel 2: the card drives the node's *HandleExtras. */
const EXTRAS_RE = /read\s*\(\s*[^,)]+,\s*['"]extras['"]\s*\)/;

/** Card basenames on either private card<->node channel — the gate's subjects,
 *  derived from the artifact so a new module enrols the day it is written. */
function subjectCards(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(CARD_DIR)) {
    if (!file.endsWith('Card.svelte')) continue;
    const code = stripComments(readFileSync(new URL(file, `file://${CARD_DIR}`), 'utf8'));
    if (ATTACH_RE.test(code) || EXTRAS_RE.test(code)) out.push(file.replace(/\.svelte$/, ''));
  }
  return out.sort();
}

// THE EXEMPTION MECHANISM IS GONE, and that is the point (#1589).
//
// This file shipped with a `KNOWN_UNCONVERTED` list holding exactly one entry —
// ToyboxCard — with a `why` and a `deleteWhen`. TOYBOX now takes per-layer slots
// from $lib/ui/media/node-media-registry, so the entry was deleted, and with the
// last entry the whole construct went too: the list, the two tests that walked
// it, and the per-(card, pattern) filter in the main check. What remains is the
// UNCONDITIONAL assertion plus the negative controls that call the same
// predicate — the repo standard for a paid debt ("delete the mechanism entirely
// and leave no replacement counter"). An empty allowlist kept around for the
// next occupant is an invitation, and a reviewer cannot tell an empty one from a
// forgotten one.

/** module type id -> card component basename (explicit `def.card` wins, else
 *  the PascalCase convention) — the same resolution buildNodeTypes uses. */
function typeToCardName(): Map<string, string> {
  const defs: CardDefLike[] = [
    ...(listModuleDefs() as unknown as CardDefLike[]),
    ...(listVideoModuleDefs() as unknown as CardDefLike[]),
    ...(listMetaModuleDefs() as unknown as CardDefLike[]),
  ];
  const map = new Map<string, string>();
  for (const def of defs) map.set(def.type, def.card ?? conventionalCardName(def.type));
  return map;
}

/**
 * Strip line + block comments, leaving string and template-literal contents
 * intact.
 *
 * This is load-bearing, not hygiene: the FIRST run of this gate flagged the two
 * cards that had just been FIXED, because their new comment explains what is
 * "deliberately ABSENT here: no `attachExternalSource(id, 'video', null)`" —
 * and the pattern matched the PROSE. A gate that reads comments as code
 * reports the opposite of the truth. (The sibling attachExternalSource grep
 * dodges this only by luck: the comments it walks past happen to omit the
 * parens.) Quote-aware so a url or a regex inside a string is never eaten.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'tpl';
  let mode: Mode = 'code';
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'tpl';
      out += c; i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      // keep newlines so line numbers/structure stay roughly aligned
      if (c === '\n') out += c;
      i++; continue;
    }
    // inside a string/template: copy through, honouring escapes
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'tpl' && c === '`')
    ) mode = 'code';
    out += c; i++;
  }
  return out;
}

/**
 * Extract the bodies of every UNMOUNT path in a card: `onDestroy(...)` blocks.
 * Brace-matched from the call site so a nested block cannot truncate the
 * region. Comments are stripped FIRST (see stripComments).
 */
function unmountBodies(raw: string): string[] {
  const src = stripComments(raw);
  const out: string[] = [];
  for (const marker of ['onDestroy(']) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(marker, from);
      if (at === -1) break;
      const open = src.indexOf('{', at);
      if (open === -1) break;
      let depth = 0;
      let end = open;
      for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      out.push(src.slice(open, end + 1));
      from = end + 1;
    }
  }
  return out;
}

const FORBIDDEN: { name: string; re: RegExp; why: string }[] = [
  {
    name: 'revokeObjectURL',
    re: /revokeObjectURL\s*\(/,
    why: 'revoking on unmount makes the loaded file unrecoverable; hand the url to nodeMedia.setObjectUrl instead',
  },
  {
    name: 'track.stop()',
    re: /getTracks\s*\(\s*\)|\.stop\s*\(\s*\)/,
    why: 'stopping capture tracks on unmount needs a fresh user gesture to undo; hand the stream to nodeMedia.setStream instead',
  },
  {
    name: "attachExternalSource(…, null)",
    re: /attachExternalSource\s*\([^)]*\bnull\s*\)/,
    why: 'detaching on unmount blanks a source that still exists; the element is node-owned and outlives the card',
  },
  {
    name: "attachLayerVideo(…, null)",
    re: /attachLayerVideo\s*\([^)]*\bnull\s*\)/,
    why: 'the EXTRAS-channel detach — same defect as attachExternalSource(…, null), on the channel half the subject set actually uses',
  },
];

/** The FORBIDDEN pattern names a card trips in its unmount path. */
function violationsFor(cardBase: string): string[] {
  const src = readFileSync(new URL(`${cardBase}.svelte`, `file://${CARD_DIR}`), 'utf8');
  const hits = new Set<string>();
  for (const body of unmountBodies(src)) {
    for (const f of FORBIDDEN) if (f.re.test(body)) hits.add(f.name);
  }
  return [...hits];
}

describe('cards on a private node channel must not tear their media down on UNMOUNT', () => {
  const subjects = subjectCards();

  it('derives a non-trivial subject set from BOTH card<->node channels', () => {
    // A broken predicate resolves nothing and must not pass vacuously.
    expect(subjects.length, 'no subject cards resolved — the predicates are broken').toBeGreaterThan(0);
    // Superset check against the (sound but narrower) attachExternalSource set:
    // every DOM-source type's card must appear, or the union has regressed.
    const byType = typeToCardName();
    const missing = [...DOM_SOURCE_LANE_TYPES]
      .map((t) => byType.get(t))
      .filter((base): base is string => !!base && !subjects.includes(base));
    expect(missing, `DOM_SOURCE_LANE_TYPES cards absent from the union: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('enrols the DARK-BY-DEFAULT cards even though it cannot yet judge them', () => {
    // painter / textmarquee / picturebox fail by never INITIALISING, which the
    // teardown patterns cannot see (see the header). Enrolling them now means a
    // widened gate covers them without anyone having to remember.
    for (const card of ['PainterCard', 'TextmarqueeCard', 'PictureboxCard']) {
      expect(subjects, `${card} must be a gate subject`).toContain(card);
    }
  });

  it('TOYBOX is a subject on the EXTRAS channel — the one this gate used to enrol and not judge', () => {
    // Anchored to the ARTIFACT: if the card is renamed or its extras channel
    // goes away, this reddens rather than quietly certifying nothing. It is the
    // positive counterpart of the deleted KNOWN_UNCONVERTED entry — the card is
    // still watched, it is simply no longer excused.
    expect(subjects, 'ToyboxCard must remain a gate subject').toContain('ToyboxCard');
  });

  it('no subject card revokes urls, stops tracks or detaches in an unmount path', () => {
    // UNCONDITIONAL. There is no exemption list to consult — see the note above
    // FORBIDDEN. Every subject card is judged by every pattern.
    const offenders: string[] = [];
    for (const card of subjects) {
      for (const name of violationsFor(card)) {
        const f = FORBIDDEN.find((x) => x.name === name)!;
        offenders.push(`${card}: ${name} — ${f.why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the gate does NOT see the never-initialises failure mode (documented blind spot)', () => {
    // PERMANENT negative control for the scope statement in the header. A card
    // that is DARK BY DEFAULT — no teardown at all, the node simply renders
    // nothing until this mounts and pushes — passes every pattern above. This
    // asserts the blindness so nobody can read a green gate as coverage; if the
    // gate is ever widened to catch this shape, this test fails and its prose
    // (and the header) must be rewritten at the same time.
    const darkByDefault = `
      onMount(() => {
        const ve = videoEngine();
        ve?.pushCanvas(id, canvasEl);
      });
      onDestroy(() => {
        cancelAnimationFrame(raf);
      });
    `;
    const hits = unmountBodies(darkByDefault).flatMap((b) =>
      FORBIDDEN.filter((f) => f.re.test(b)).map((f) => f.name),
    );
    expect(hits, 'if this now reports a hit, the gate grew a capability the header denies').toEqual([]);
  });

  it('the predicate actually fires on a teardown body (negative control)', () => {
    const hostile = `
      onDestroy(() => {
        const ve = videoEngine();
        try { ve?.attachExternalSource(id, 'video', null); } catch {}
        try { extras?.attachLayerVideo(i, null); } catch {}
        if (objectUrl) { URL.revokeObjectURL(objectUrl); }
        for (const t of stream.getTracks()) t.stop();
      });
    `;
    const bodies = unmountBodies(hostile);
    expect(bodies).toHaveLength(1);
    const hits = FORBIDDEN.filter((f) => f.re.test(bodies[0]!)).map((f) => f.name);
    expect(hits.sort()).toEqual(
      [
        'attachExternalSource(…, null)',
        'attachLayerVideo(…, null)',
        'revokeObjectURL',
        'track.stop()',
      ].sort(),
    );
  });

  it('the ACTUAL ToyboxCard unmount body is what the hostile control models (#1589)', () => {
    // A POSITIVE control on the subject that motivated the pattern: the exact
    // teardown above is what ToyboxCard.onDestroy contained, verbatim in shape.
    // Asserting it is now clean pins the fix to this gate rather than to a
    // commit message — and because `subjects` is derived, a rename cannot
    // silently drop it (the leg above fails first).
    expect(violationsFor('ToyboxCard')).toEqual([]);
  });

  it('the predicate does NOT fire on a clean unmount body (negative control)', () => {
    const clean = `
      onDestroy(() => {
        stopGateLoop();
        unregisterVideoExport(id);
        mediaLease?.release();
      });
    `;
    const bodies = unmountBodies(clean);
    expect(bodies).toHaveLength(1);
    expect(FORBIDDEN.filter((f) => f.re.test(bodies[0]!))).toEqual([]);
  });

  it('a COMMENT describing the teardown does not trip the gate', () => {
    // The exact shape that produced this gate's first (false) failure.
    const documented = `
      onDestroy(() => {
        // NOTE what is deliberately ABSENT here: no \`attachExternalSource(id,
        // 'video', null)\`, no \`URL.revokeObjectURL\`, no \`track.stop()\`.
        /* block form too: URL.revokeObjectURL(objectUrl); */
        mediaLease?.release();
      });
    `;
    const bodies = unmountBodies(documented);
    expect(bodies).toHaveLength(1);
    expect(FORBIDDEN.filter((f) => f.re.test(bodies[0]!)).map((f) => f.name)).toEqual([]);
  });

  it('stripComments leaves string and template contents intact', () => {
    // A comment stripper that eats these would silently blind the gate.
    expect(stripComments(`const u = 'https://x/y';`)).toContain("'https://x/y'");
    expect(stripComments('const t = `a // b`;')).toContain('`a // b`');
    expect(stripComments(`const s = "/* not a comment */";`)).toContain(
      '"/* not a comment */"',
    );
    expect(stripComments(`code(); // gone`)).not.toContain('gone');
    expect(stripComments(`code(); /* gone */ more();`)).not.toContain('gone');
  });

  it('brace matching survives a nested block inside the unmount body', () => {
    const nested = `
      onDestroy(() => {
        if (a) { for (const x of y) { z(x); } }
        cleanup();
      });
      function later() { URL.revokeObjectURL(other); }
    `;
    const bodies = unmountBodies(nested);
    expect(bodies).toHaveLength(1);
    // The revoke lives OUTSIDE the unmount path and must not be attributed to it.
    expect(FORBIDDEN.filter((f) => f.re.test(bodies[0]!))).toEqual([]);
  });
});
