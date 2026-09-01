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
// ── THE SECOND FAILURE MODE, AND THE WIDENING THAT CAUGHT IT (#1720) ─────────
//
// Every pattern above is TEARDOWN-SHAPED: it reads `onDestroy` bodies and asks
// "does this card destroy something it should not?". This file used to state,
// as a permanent negative control, that it was structurally blind to the
// OPPOSITE failure mode — a module that never INITIALISES:
//
//   "painter, textmarquee and picturebox have no teardown at all — their node
//    renders a placeholder until a card mounts and pushes its canvas/image, so
//    with the shell swapping the card out they are DARK BY DEFAULT rather than
//    broken-on-collapse. This gate certifies all three as clean and they are
//    not."
//
// That admission was correct and it was right about all three. MEASURED on the
// default `/rack` with the content already in `node.data`, nothing expanded and
// nothing clicked, reading each node's own output texture:
//
//   painter      meanRGB (255,255,255) — a blank page — vs (255,0,0) mounted
//   textmarquee  nonBlack 446/49152 (the literal word "textmarquee") vs 36992
//   picturebox   meanRGB (5,15,20) — the idle field — vs (0,0,254) mounted
//
// …and writing the per-card verdict this widening demands turned up a FOURTH,
// unreported instance: TOYBOX's image layers are `node.data.layers[i].imageBytes`
// decoded by the card and nothing else, with `renderImageLayer` painting its
// idle pattern until `hasImage` — which only `setLayerImage` sets.
//
// All four now have a NODE-LIFETIME producer ($lib/ui/media/node-extras-registry),
// so the gate is widened the way its own scope note said it would have to be:
//
//   EVERY CARD ON THE EXTRAS CHANNEL MUST DECLARE WHO OWNS ITS PUSH.
//
// Deny by default, one entry per CARD, each carrying its `why` in a REQUIRED
// type field, and each `owner` cross-checked against the artifact that is
// supposed to implement it. Anchored in BOTH directions: a card on the channel
// with no entry is RED, and an entry naming a card that is no longer on the
// channel is RED.
//
// ⚠⚠ WHAT THIS GATE STILL CANNOT SEE, stated so nobody reads a green run as
// more than it is. It reads SOURCE and DECLARATIONS. It cannot observe a pixel,
// a mount or a rAF, so:
//   * a `node-lifetime-producer` entry proves a producer is REGISTERED for that
//     type, never that the producer's output is CORRECT;
//   * a `module-renders-itself` entry is taken at its word — the claim that the
//     module's own draw is unconditional is a human judgement recorded in the
//     `why`, not something checked here;
//   * whether any of it actually works is PIXELS, and that is
//     e2e/tests/extras-producer-lifetime.spec.ts's job (it spawns each producer
//     type with persisted content, expands NOTHING, and requires the node's own
//     output texture to carry that content — with a permanent leg proving the
//     probe can tell the content from the placeholder).
// Both directions of that blindness are negative-controlled below.

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
import {
  DOM_SOURCE_LANE_TYPES,
  HEADLESS_MOUNT_LANE_TYPES,
} from '$lib/ui/workflow/dom-source-modules';
import { EXTRAS_PRODUCER_TYPES } from '$lib/ui/media/extras-producers';

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

/** Card basenames on the EXTRAS channel specifically — the subjects of the
 *  never-INITIALISES half of this gate (#1720). A strict subset of
 *  `subjectCards()`; the attach-only cards (cameraInput, frametable, loopback,
 *  videocube) are judged by the teardown patterns and owe no owner entry. */
function extrasChannelCards(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(CARD_DIR)) {
    if (!file.endsWith('Card.svelte')) continue;
    const code = stripComments(readFileSync(new URL(file, `file://${CARD_DIR}`), 'utf8'));
    if (EXTRAS_RE.test(code)) out.push(file.replace(/\.svelte$/, ''));
  }
  return out.sort();
}

/**
 * WHO owns a card's extras push when NO card is mounted. A closed union, so
 * `tsc` refuses an unrecognised verdict, and two of the three are
 * CROSS-CHECKED against the artifact that implements them.
 */
type ExtrasOwner =
  /** $lib/ui/media/node-extras-registry reproduces the push from persisted
   *  `node.data`. Cross-checked: the type must be in EXTRAS_PRODUCER_TYPES. */
  | 'node-lifetime-producer'
  /** <HeadlessSourceHost> keeps the real card alive off-screen. Cross-checked:
   *  the type must be in HEADLESS_MOUNT_LANE_TYPES. */
  | 'headless-card-mount'
  /** The module's own draw is unconditional and the extras channel carries only
   *  HUMAN INPUT (keys, a boot gesture, a reset) — there is nothing a registry
   *  could reproduce, and "no picture until someone plays it" is the designed
   *  behaviour. NOT cross-checkable: this one is a judgement, recorded in `why`
   *  and negative-controlled below as a thing this gate takes on trust. */
  | 'module-renders-itself';

interface ExtrasOwnerVerdict {
  readonly owner: ExtrasOwner;
  /** REQUIRED BY THE TYPE. The reason is the only thing a reviewer of a future
   *  entry actually needs, and a reason that lives in a commit message is not
   *  available at the point of the edit. */
  readonly why: string;
}

/**
 * DENY BY DEFAULT, one entry per CARD on the extras channel (#1720). A card on
 * the channel with no entry FAILS; an entry naming a card that is no longer on
 * the channel FAILS. Both directions asserted below, so this cannot rot into a
 * list of names nobody re-reads.
 */
//
// ⚠ TEXTMARQUEE and PICTUREBOX are deliberately ABSENT, and their absence is
// the fix rather than an oversight: their card-side push paths were DELETED
// (not duplicated) when the producer took over, so neither card touches
// `read(id, 'extras')` any more and neither is on this channel at all. The
// anchoring leg below is what proved it — it reddened on exactly those two the
// first time it ran. Their producers are anchored instead by
// `EXTRAS_PRODUCERS` (see the producer-anchoring leg), which is the artifact
// that actually implements them.
//
// ⚠ VIDEOBOX (P1) AND VIDEOVARISPEED (P2) ARRIVED FROM THE OTHER DIRECTION
// (LEG-02, #1511). The other two never had a media element; videobox did, and its
// entry read `owner: 'headless-card-mount'` — "the DOM-source rule already keeps
// this card mounted off-screen". That verdict was TRUE and is now false: the
// element's attach, its audio wiring and its three loops moved to
// `$lib/ui/media/node-video-source-registry` on graph lifetime, so nothing keeps
// a videobox card alive anywhere and nothing needs to.
//
// The card's `getExtras()` helper was DELETED rather than left unused, which is
// what took it off this channel — and that deletion is load-bearing in the way
// this file cares about: a card that cannot reach the handle cannot tear it
// down, so the defect this gate exists for becomes unspellable rather than
// merely absent. This leg reddened on exactly that entry, which is the anchoring
// working as designed: the verdict could not quietly outlive the mechanism it
// described.
//
// ⚠ PEERTUBE AND TVLIBRARIAN LEFT THE SAME WAY IN P3, and their departure is
// worth reading as a pattern rather than two more names. Both entries said
// `owner: 'headless-card-mount'` — "the DOM-source rule already keeps this card
// mounted off-screen" — and that verdict was true for the LANE and false
// everywhere else: `needsHeadlessSourceMount` returns FALSE on the
// `laneOmitsNode` arm for a non-producer, so a collapsed-group or canvas-hidden
// tuner had no card in any surface and no host either, i.e. the very mount this
// verdict named as the owner did not exist. `getExtras()` was DELETED from both
// cards rather than left unused, which is what took them off this channel;
// `$lib/ui/media/node-hls-source-registry` reaches the handle now, on graph
// lifetime.
const EXTRAS_OWNERS: Readonly<Record<string, ExtrasOwnerVerdict>> = {
  PainterCard: {
    owner: 'node-lifetime-producer',
    why: "the picture is the deterministic replay of node.data.ops; unmounted it read a blank white page (meanRGB 255,255,255) against the drawing's 255,0,0",
  },
  ToyboxCard: {
    owner: 'node-lifetime-producer',
    why: 'an IMAGE layer is node.data.layers[i].imageBytes decoded — picturebox wearing a layer index; the VIDEO half is a local file no reload can reconstruct and its attach already survives an unmount',
  },
  ArchivistCard: {
    owner: 'headless-card-mount',
    why: 'the extras channel rides alongside a card-owned DOM media element the engine holds via attachExternalSource, so the card must stay mounted for the SOURCE regardless',
  },
  BloodCard: {
    owner: 'module-renders-itself',
    why: 'the extras channel carries a WASM boot gesture and raw Build scancodes; blood.ts runs the frame and uploads its own framebuffer, and paints a deliberate "alive, no signal" dark-red scanline idle field until a human plays it',
  },
  DoomCard: {
    owner: 'module-renders-itself',
    why: 'the LIVE half (session, netcode, lockstep, pump) is already node-owned by node-doom-session-registry (#1590); what still crosses extras is a user boot gesture and keypresses, and doom.ts paints its own "alive but no signal" idle field',
  },
  // ⚠ GibribbonCard LEFT THIS ROSTER 2026-08-29 (the rewrite), and the reason
  // is a scan-boundary fact worth recording: the card became a thin bridge
  // mounting the SHARED $lib/ui/modules/gibribbon/GibribbonScreen.svelte (one
  // playfield for the card AND the dock face body), and the `read(…,'extras')`
  // call moved into that component — which this file's `*Card.svelte`-only
  // scan cannot see (the same structural boundary dom-source-modules.test.ts
  // declares for its own `.svelte` subtree). The SUBSTANCE of the old verdict
  // is unchanged and now stronger: the rewritten module renders itself
  // unconditionally (the game steps on the shared scheduler clock in the
  // FACTORY), and the extras channel carries only human input (keyboard
  // presses, a reset) — there is nothing a registry could reproduce and
  // nothing an unmount can tear down.
  NibblesCard: {
    owner: 'module-renders-itself',
    why: 'nibbles.ts paints a frame before the first tick and ticks its own clock, with a built-in greedy bot under AUTO; the card pushes only arrow keys and a reset',
  },
};

/** The module TYPE a card basename resolves to, or null. */
function typeForCard(base: string): string | null {
  for (const [type, cardBase] of typeToCardName()) if (cardBase === base) return type;
  return null;
}

/** The owner verdicts a card FAILS, given its declared entry. Exported shape is
 *  a list of strings so both the real check and the negative controls call the
 *  SAME predicate. */
function ownerOffenders(cards: readonly string[]): string[] {
  const out: string[] = [];
  for (const base of cards) {
    const verdict = EXTRAS_OWNERS[base];
    if (!verdict) {
      out.push(
        `${base}: on the EXTRAS channel with no declared owner. Add an EXTRAS_OWNERS entry ` +
          "saying who pushes when no card is mounted — a node-lifetime producer, a headless " +
          'card mount, or a module that renders itself.',
      );
      continue;
    }
    const type = typeForCard(base);
    if (!type) {
      out.push(`${base}: declares an extras owner but resolves to no registered module def`);
      continue;
    }
    if (verdict.owner === 'node-lifetime-producer' && !EXTRAS_PRODUCER_TYPES.has(type)) {
      out.push(
        `${base}: declares 'node-lifetime-producer' but '${type}' has no entry in ` +
          'EXTRAS_PRODUCERS ($lib/ui/media/extras-producers)',
      );
    }
    if (verdict.owner === 'headless-card-mount' && !HEADLESS_MOUNT_LANE_TYPES.has(type)) {
      out.push(
        `${base}: declares 'headless-card-mount' but '${type}' is not in ` +
          'HEADLESS_MOUNT_LANE_TYPES, so nothing keeps its card alive',
      );
    }
  }
  return out;
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

  it('every card on the EXTRAS channel declares WHO owns its push (#1720)', () => {
    // THE NEVER-INITIALISES HALF. Deny by default: a card that drives a node's
    // *HandleExtras must say what pushes when NO card is mounted, because under
    // the faceplate shell that is the COMMON case, not an edge case. Two of the
    // three verdicts are cross-checked against the artifact that implements
    // them, so a declaration cannot outlive its mechanism.
    const cards = extrasChannelCards();
    expect(cards.length, 'no card resolved on the extras channel — the predicate is broken')
      .toBeGreaterThan(0);
    expect(ownerOffenders(cards)).toEqual([]);
  });

  it('an EXTRAS_OWNERS entry naming a card NOT on the channel is RED (anchored)', () => {
    // The other direction, and the one a list of names always rots in: an entry
    // for a card that was renamed, deleted, or has stopped using extras reads as
    // coverage while covering nothing. Anchored to the ARTIFACT.
    const onChannel = new Set(extrasChannelCards());
    const stale = Object.keys(EXTRAS_OWNERS).filter((base) => !onChannel.has(base));
    expect(
      stale,
      `EXTRAS_OWNERS entr(ies) for card(s) no longer on the extras channel: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('every NODE-LIFETIME PRODUCER is anchored to a module that still HAS an extras channel', () => {
    // The other half of the anchoring, on the artifact that matters once a
    // card's push path is gone. A producer pushes through the module handle's
    // `extras`, so a producer for a module whose factory no longer exposes one
    // is dead code reading as coverage — RED, not silently green.
    const defsDir = fileURLToPath(new URL('../../video/modules/', import.meta.url));
    const sources = readdirSync(defsDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => stripComments(readFileSync(new URL(f, `file://${defsDir}`), 'utf8')));
    const orphans: string[] = [];
    for (const type of EXTRAS_PRODUCER_TYPES) {
      const declaresType = new RegExp(`type:\\s*'${type}'`);
      const hit = sources.some((src) => declaresType.test(src) && /'extras'/.test(src));
      if (!hit) orphans.push(type);
    }
    expect(
      orphans,
      `EXTRAS_PRODUCERS entr(ies) whose module def declares no extras channel: ${orphans.join(', ')}`,
    ).toEqual([]);
    expect(EXTRAS_PRODUCER_TYPES.size, 'the producer set must not silently empty').toBeGreaterThan(0);
  });

  it('every verdict carries a REAL reason, not a placeholder', () => {
    // `why` is required by the TYPE, so tsc already refuses an absent one. This
    // is the prose-quality floor that stops it being satisfied with ''.
    const thin = Object.entries(EXTRAS_OWNERS)
      .filter(([, v]) => v.why.trim().length < 40)
      .map(([k]) => k);
    expect(thin, `EXTRAS_OWNERS entr(ies) with a stub reason: ${thin.join(', ')}`).toEqual([]);
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

  it('the TEARDOWN patterns still do NOT see the never-initialises mode (they never could)', () => {
    // The permanent scope control this file has always carried, kept and
    // re-pointed. A card that is DARK BY DEFAULT — no teardown at all, the node
    // simply renders nothing until this mounts and pushes — trips no FORBIDDEN
    // pattern, and never will: those patterns read `onDestroy` bodies. What
    // changed with #1720 is not that they grew an eye, it is that a SECOND,
    // declaration-shaped check now covers the mode they cannot see. If this
    // ever reports a hit, the teardown half grew a capability the header denies
    // and the header must be rewritten in the same commit.
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

  it('NEGATIVE CONTROL, both directions: the owner check fires on an undeclared card and not on a declared one', () => {
    // PERMANENT, and it calls the SAME predicate the real check calls — an
    // instrument that only ever returns [] is indistinguishable from one that
    // never looked.
    //
    // DENY direction: a card on the channel with no entry is an offender.
    expect(
      ownerOffenders(['NoSuchExtrasCard']).length,
      'an undeclared extras card must be reported',
    ).toBe(1);
    // ALLOW direction: a real, declared card is not.
    expect(ownerOffenders(['PainterCard'])).toEqual([]);
  });

  it("SCOPE: 'module-renders-itself' is taken at its word — this gate reads no pixels", () => {
    // The residual blindness, asserted rather than left in prose. Two of the
    // three verdicts have an artifact to check against; this one does not, by
    // construction — "the module's own draw is unconditional" is a claim about
    // RENDERING, and nothing in a source grep can confirm it. So a card could
    // declare it falsely and this gate would stay green.
    //
    // What that costs is bounded and stated: the verdict is only reachable for a
    // card whose module is in NEITHER structural set, and the `why` must name
    // the module's own idle-field paint. The behavioural net is
    // e2e/tests/extras-producer-lifetime.spec.ts, which reads the actual output
    // texture — and it can only cover the types that HAVE a producer, which is
    // precisely why the other verdict needs a human on it.
    const trusted = Object.entries(EXTRAS_OWNERS)
      .filter(([, v]) => v.owner === 'module-renders-itself')
      .map(([base]) => base);
    for (const base of trusted) {
      const type = typeForCard(base);
      expect(type, `${base} must resolve to a registered module def`).toBeTruthy();
      // If one of these ever gains a structural owner, the verdict is no longer
      // the trusted kind and must be re-declared as the checkable kind.
      expect(
        EXTRAS_PRODUCER_TYPES.has(type!) || HEADLESS_MOUNT_LANE_TYPES.has(type!),
        `${base} declares 'module-renders-itself' but '${type}' now HAS a structural owner — ` +
          're-declare it as that owner so the check stops being a judgement',
      ).toBe(false);
    }
    expect(trusted.length, 'the trusted-verdict set must not silently empty').toBeGreaterThan(0);
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
