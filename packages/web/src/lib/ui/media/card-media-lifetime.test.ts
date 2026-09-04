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
// DENY BY DEFAULT + AUTO-ENROLLING. The subject set is DERIVED from the MODULE
// SURFACE sources, as the UNION of the two private surface<->node channels:
//   * `attachExternalSource(` — the surface hands the node a DOM element;
//   * `read(id, 'extras')`    — the surface drives the node's *HandleExtras.
// Either one means the node's behaviour depends on a surface being mounted,
// which is the precondition for every bug in this class.
//
// ⚠ THE SUBJECT IS THE MODULE, AND THE WALK IS THE WHOLE SURFACE TREE. Both
// used to be narrower — one verdict per `*Card.svelte`, resolved by a flat
// readdir — and the cost is written all over this file: gibribbon, nibbles,
// doom, toybox and archivist each dropped out of the roster when a face PR
// moved the extras call into a shared surface, every time with the note "the
// substance is unchanged", which was true and was the problem. MEASURED at the
// widening: the flat card-only walk saw TWO files on either channel, the tree
// walk sees EIGHT.
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
//   EVERY MODULE ON THE EXTRAS CHANNEL MUST DECLARE WHO OWNS ITS PUSH.
//
// Deny by default, one entry per MODULE TYPE, each carrying its `why` in a
// REQUIRED type field, and each `owner` cross-checked against the artifact that
// is supposed to implement it. Anchored in BOTH directions: a module on the
// channel with no entry is RED, and an entry naming a module that is no longer
// on the channel is RED.
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
import { join } from 'node:path';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import { DOM_SOURCE_LANE_TYPES } from '$lib/ui/workflow/dom-source-modules';
import { EXTRAS_PRODUCER_TYPES } from '$lib/ui/media/extras-producers';

const CARD_DIR = fileURLToPath(new URL('../modules/', import.meta.url));

/** Channel 1: the surface hands the node a DOM element. */
const ATTACH_RE = /attachExternalSource\s*\(/;
/** Channel 2: the surface drives the node's *HandleExtras. */
const EXTRAS_RE = /read\s*\(\s*[^,)]+,\s*['"]extras['"]\s*\)/;

/**
 * Every module-owned source this gate can judge: the flat `lib/ui/modules/*`
 * files AND one level of module directory beneath them, `.svelte` and plain
 * `.ts` alike.
 *
 * ⚠ THE WALK USED TO BE FLAT AND `*Card.svelte`-FILTERED, AND THIS FILE'S OWN
 * COMMENTS ARE THE EVIDENCE AGAINST THAT: five modules — gibribbon, nibbles,
 * doom, toybox, archivist — left the EXTRAS_OWNERS roster not because their
 * behaviour changed but because a face PR moved the `read(…, 'extras')` call
 * out of a `*Card.svelte` and into a shared surface the scan could not see.
 * Each departure was written up as "the substance is unchanged", which is true
 * and is exactly the problem: the gate's subject set emptied for that module
 * while the hazard stayed. MEASURED at this widening: the flat card-only walk
 * saw TWO files on either channel; the tree walk sees EIGHT, and six of them
 * are surfaces that no card-shaped scan could ever have reached.
 *
 * One level is deliberate rather than a full recursive walk: it is the depth
 * the shell-extension glob itself loads from, so the subject set is the same
 * population the shell can actually mount — the identical boundary, and the
 * identical reasoning, as `card-preview-gate`'s walk.
 */
let SOURCE_CACHE: Array<{ name: string; code: string }> | null = null;
function moduleSourceFiles(): Array<{ name: string; code: string }> {
  // MEMOISED, and not as an optimisation for its own sake: the walk reads ~660
  // files through a character-by-character comment stripper, and the teardown
  // leg asks for the channel members once PER SUBJECT MODULE. Re-walking per
  // question took the leg from 2.7 s to over the 5 s default timeout — a test
  // that fails on wall clock rather than on its claim, which is the one failure
  // mode a source gate must never have.
  if (SOURCE_CACHE) return SOURCE_CACHE;
  const wanted = (f: string): boolean =>
    f.endsWith('.svelte') || (f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const out: Array<{ name: string; code: string }> = [];
  for (const entry of readdirSync(CARD_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const inner of readdirSync(join(CARD_DIR, entry.name))) {
        if (!wanted(inner)) continue;
        const rel = `${entry.name}/${inner}`;
        out.push({ name: rel, code: stripComments(readFileSync(join(CARD_DIR, rel), 'utf8')) });
      }
      continue;
    }
    if (!wanted(entry.name)) continue;
    out.push({
      name: entry.name,
      code: stripComments(readFileSync(join(CARD_DIR, entry.name), 'utf8')),
    });
  }
  SOURCE_CACHE = out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return SOURCE_CACHE;
}

/** Every registered module type, all three domains. */
let TYPES_CACHE: Set<string> | null = null;
function registeredTypes(): Set<string> {
  TYPES_CACHE ??= new Set([
    ...listModuleDefs().map((d) => d.type),
    ...listVideoModuleDefs().map((d) => d.type),
    ...listMetaModuleDefs().map((d) => d.type),
  ]);
  return TYPES_CACHE;
}

/**
 * The module TYPE that owns a surface file, or null.
 *
 * ⚠ ATTRIBUTION IS BY DIRECTORY, which is the shell-extension glob's own
 * convention (`modules/<id>/…`, the same string a def declares as
 * `face.extension`) — so the verdict below is about the MODULE rather than
 * about whichever file currently happens to carry the call. That is the whole
 * repair: a roster keyed by filename lost an entry every time a surface moved,
 * and none of those moves changed who pushes when nothing is mounted.
 *
 * Two FLAT branches exist beside it, both derived from the registry rather than
 * from a second hand-maintained map:
 *   * a `<Type>Card.svelte` resolves to the registered type whose id matches
 *     its basename, case-insensitively. TRANSITIONAL — it exists only while the
 *     legacy fleet does.
 *   * a `<type>-<what>.ts` action seam resolves to the LONGEST registered type
 *     its basename is prefixed by. This is the repo's own flat-seam convention
 *     (`frametable-file-actions.ts`, `videocube-slot-actions.ts`,
 *     `nibbles-game-actions.ts` — the last of which is a file this gate's own
 *     comments record losing a module to), and longest-match is what keeps
 *     `videocube-…` from being read as `videobox`'s or `videoOut`'s.
 */
function typeForSurface(name: string, types: ReadonlySet<string>): string | null {
  const slash = name.indexOf('/');
  if (slash !== -1) {
    const dir = name.slice(0, slash);
    return types.has(dir) ? dir : null;
  }
  const card = /^(.*)Card\.svelte$/.exec(name);
  if (card) {
    const base = card[1]!.toLowerCase();
    for (const t of types) if (t.toLowerCase() === base) return t;
    return null;
  }
  const stem = name.replace(/\.(svelte|ts)$/, '');
  let best: string | null = null;
  for (const t of types) {
    if (stem !== t && !stem.startsWith(`${t}-`)) continue;
    if (!best || t.length > best.length) best = t;
  }
  return best;
}

interface ChannelHit {
  readonly file: string;
  readonly type: string | null;
  readonly extras: boolean;
}

/** Files on either private surface<->node channel, with the module each one
 *  belongs to — the gate's subjects, derived from the artifact so a new module
 *  enrols the day it is written. */
let HITS_CACHE: ChannelHit[] | null = null;
function channelHits(): ChannelHit[] {
  if (HITS_CACHE) return HITS_CACHE;
  const types = registeredTypes();
  const out: ChannelHit[] = [];
  for (const { name, code } of moduleSourceFiles()) {
    const extras = EXTRAS_RE.test(code);
    if (!extras && !ATTACH_RE.test(code)) continue;
    out.push({ file: name, type: typeForSurface(name, types), extras });
  }
  HITS_CACHE = out;
  return out;
}

/** Module types on either channel. */
function subjectTypes(): string[] {
  return [...new Set(channelHits().map((h) => h.type).filter((t): t is string => !!t))].sort();
}

/** Module types on the EXTRAS channel specifically — the subjects of the
 *  never-INITIALISES half of this gate (#1720). A subset of
 *  `subjectTypes()`; the attach-only modules are judged by the teardown
 *  patterns and owe no owner entry. */
function extrasChannelTypes(): string[] {
  return [
    ...new Set(channelHits().filter((h) => h.extras).map((h) => h.type).filter((t): t is string => !!t)),
  ].sort();
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
  // ⚠ `'headless-card-mount'` WAS HERE AND IS RETIRED (legacy-removal S1.5)
  // with `<HeadlessSourceHost>` itself: no entry declared it any more (the two
  // prose notes below record the last ones leaving), and a verdict whose
  // cross-check set is retired would be undeclarable anyway. If a card ever
  // regrows an extras push the honest owners are the checkable
  // 'node-lifetime-producer' or the trusted 'module-renders-itself'.
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
 * DENY BY DEFAULT, one entry per MODULE TYPE on the extras channel (#1720). A
 * module on the channel with no entry FAILS; an entry naming a module that is
 * no longer on the channel FAILS. Both directions asserted below, so this
 * cannot rot into a list of names nobody re-reads.
 *
 * ⚠ IT IS KEYED BY MODULE, NOT BY FILE, AND THAT IS THE REPAIR THIS ROSTER
 * NEEDED. It used to hold one entry per `*Card.svelte`, and five modules left
 * it — gibribbon, nibbles, doom, toybox, archivist — every one of them because
 * a face PR moved the `read(…, 'extras')` call into a shared surface the
 * card-shaped scan could not see. Each departure was recorded as "the substance
 * is unchanged", which was true and was the problem: the verdict is a claim
 * about WHO PUSHES WHEN NOTHING IS MOUNTED, which is a property of the module,
 * and keying it on whichever file currently carries the call meant the roster
 * emptied every time a surface moved while the hazard stayed exactly where it
 * was. Four of the five are back below, under their own type ids, carrying the
 * verdicts this file had already written for them.
 *
 * ⚠ ARCHIVIST IS THE ONE THAT IS GENUINELY GONE, and it left for the opposite
 * reason: the element, the attach and the extras reads all moved to
 * `$lib/ui/media/node-archivist-source-registry`, which holds them on GRAPH
 * lifetime. No archivist surface reads extras at all any more, so the scan
 * correctly finds the module off the channel — the owner it named does not
 * exist, rather than having moved to a file the scan cannot see.
 *
 * ⚠ TEXTMARQUEE and PICTUREBOX are deliberately ABSENT for the same kind of
 * reason: their push paths were DELETED (not duplicated) when the producer took
 * over, so no textmarquee or picturebox surface touches `read(id, 'extras')`
 * and neither module is on this channel. The anchoring leg below is what proved
 * it — it reddened on exactly those two the first time it ran. Their producers
 * are anchored instead by `EXTRAS_PRODUCERS`, which is the artifact that
 * actually implements them.
 *
 * ⚠ VIDEOBOX, VIDEOVARISPEED, PEERTUBE and TVLIBRARIAN all left by a THIRD
 * route worth keeping distinct from the two above: each carried
 * `owner: 'headless-card-mount'` — "the DOM-source rule already keeps this card
 * mounted off-screen" — and that verdict was true for the LANE and false
 * everywhere else, since a collapsed-group or canvas-hidden node had no card in
 * any surface and no host either, i.e. the mount the verdict named as the owner
 * did not exist. Their elements and loops moved to
 * `$lib/ui/media/node-video-source-registry` / `node-hls-source-registry` on
 * graph lifetime, and each surface's `getExtras()` helper was DELETED rather
 * than left unused — which is load-bearing in the way this file cares about: a
 * surface that cannot reach the handle cannot tear it down, so the defect
 * becomes unspellable rather than merely absent.
 */
const EXTRAS_OWNERS: Readonly<Record<string, ExtrasOwnerVerdict>> = {
  painter: {
    owner: 'node-lifetime-producer',
    why: "the picture is the deterministic replay of node.data.ops; unmounted it read a blank white page (meanRGB 255,255,255) against the drawing's 255,0,0",
  },
  blood: {
    owner: 'module-renders-itself',
    why: 'the extras channel carries a WASM boot gesture and raw Build scancodes; blood.ts runs the frame and uploads its own framebuffer, and paints a deliberate "alive, no signal" dark-red scanline idle field until a human plays it',
  },
  // ⚠ THE VERDICT BELOW IS THIS FILE'S OWN, RE-ATTACHED — not a new decision
  // about DOOM. It was written for `DoomCard` and recorded verbatim in this
  // file when the card left the roster; the widened scan finds the same
  // `read(…, 'extras')` call in `doom/DoomSurface.svelte`, the ONE surface
  // component both the legacy card and the faceplate body mount, so the module
  // is on the channel again and owes the entry it always owed.
  //
  // The substance is unchanged and is now STRONGER, because the promotion made
  // the node-ownership load-bearing rather than merely true. `nodeDoomSession`
  // (#1590) already owned the netcode, the lockstep transport, the launch state
  // and the frame pump, and keeps them running with NO card and NO face mounted
  // — that registry exists precisely because a card unmount used to starve
  // every peer's lockstep barrier. `doom.ts` still paints its own idle field
  // from `surface.draw` whether or not anything is watching (it is a pull ROOT
  // unconditionally — `VideoEngine.isPullExempt` names DOOM in its own
  // comment, via a non-empty `audioSources` map), and the surface's `onDestroy`
  // still, deliberately, tears down NO session state.
  doom: {
    owner: 'module-renders-itself',
    why: 'the LIVE half (session, netcode, lockstep, pump) is already node-owned by node-doom-session-registry (#1590); what still crosses extras is a user boot gesture and keypresses, and doom.ts paints its own "alive but no signal" idle field',
  },
  gibribbon: {
    owner: 'module-renders-itself',
    why: 'the rewritten module renders itself unconditionally — the game steps on the shared scheduler clock in the FACTORY — and the extras channel carries only human input (keyboard presses, a reset), so there is nothing a registry could reproduce and nothing an unmount can tear down',
  },
  nibbles: {
    owner: 'module-renders-itself',
    why: 'nibbles.ts paints and uploads a frame BEFORE any surface exists (paintFrame(); uploadFramebuffer(); run at factory construction) and ticks its own clock inside surface.draw, with a greedy bot under AUTO; extras carries human input only — four arrow directions and a reset — and the module is PULL-EXEMPT via its non-empty audioSources map, so it renders with nothing mounted and nothing watching',
  },
  toybox: {
    owner: 'node-lifetime-producer',
    why: 'an IMAGE layer is node.data.layers[i].imageBytes decoded — picturebox wearing a layer index — and toybox.ts renders all four layers from node.data every frame; the VIDEO half is a local file no reload can reconstruct, whose elements and object-URLs live in node-media-registry on GRAPH lifetime since #1589 and whose absence the console reports in words',
  },
};

/** The owner verdicts a module TYPE fails, given its declared entry. Exported
 *  shape is a list of strings so both the real check and the negative controls
 *  call the SAME predicate. */
function ownerOffenders(types: readonly string[]): string[] {
  const registered = registeredTypes();
  const out: string[] = [];
  for (const type of types) {
    const verdict = EXTRAS_OWNERS[type];
    if (!verdict) {
      out.push(
        `${type}: on the EXTRAS channel with no declared owner. Add an EXTRAS_OWNERS entry ` +
          'saying who pushes when no surface is mounted — a node-lifetime producer, or a ' +
          'module that renders itself.',
      );
      continue;
    }
    if (!registered.has(type)) {
      out.push(`${type}: declares an extras owner but resolves to no registered module def`);
      continue;
    }
    if (verdict.owner === 'node-lifetime-producer' && !EXTRAS_PRODUCER_TYPES.has(type)) {
      out.push(
        `${type}: declares 'node-lifetime-producer' but it has no entry in ` +
          'EXTRAS_PRODUCERS ($lib/ui/media/extras-producers)',
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

/** The FORBIDDEN pattern names a MODULE trips in an unmount path — read across
 *  every one of its surfaces that is on a channel, so a teardown is caught
 *  wherever the module happens to keep it. */
function violationsFor(type: string): string[] {
  const files = channelHits().filter((h) => h.type === type);
  const hits = new Set<string>();
  for (const { file } of files) {
    const src = readFileSync(join(CARD_DIR, file), 'utf8');
    for (const body of unmountBodies(src)) {
      for (const f of FORBIDDEN) if (f.re.test(body)) hits.add(`${file}: ${f.name}`);
    }
  }
  return [...hits];
}

describe('surfaces on a private node channel must not tear their media down on UNMOUNT', () => {
  const subjects = subjectTypes();

  it('derives a non-trivial subject set from BOTH surface<->node channels', () => {
    // A broken predicate resolves nothing and must not pass vacuously.
    expect(subjects.length, 'no subject modules resolved — the predicates are broken')
      .toBeGreaterThan(0);
    // …and the WALK itself reaches both levels, which is the half that emptied
    // five times without anything saying so. A flat-only walk would still
    // resolve subjects (the legacy cards are flat) and still be blind to every
    // shared surface a face PR moves the call into.
    const onChannel = channelHits().map((h) => h.file);
    expect(
      onChannel.filter((f) => f.includes('/')).length,
      'NOT ONE module-subdirectory surface is on either channel — the second level of the walk ' +
        'has stopped resolving, which is exactly how gibribbon, nibbles, doom, toybox and ' +
        'archivist each fell out of this gate one at a time',
    ).toBeGreaterThan(0);
    // Superset check against the (sound but narrower) attachExternalSource set:
    // every DOM-source type must appear, or the union has regressed.
    const missing = [...DOM_SOURCE_LANE_TYPES].filter((t) => !subjects.includes(t));
    expect(missing, `DOM_SOURCE_LANE_TYPES modules absent from the union: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('every file on a channel is ATTRIBUTABLE to a registered module (fail-closed)', () => {
    // A surface whose owning module cannot be resolved is invisible to the
    // owner verdict below — it would carry a live extras push that no entry has
    // to account for. Report it rather than skip it.
    const orphans = channelHits().filter((h) => !h.type).map((h) => h.file);
    expect(
      orphans,
      'These files are on a private surface<->node channel but no registered module owns them:\n' +
        `  ${orphans.join('\n  ')}\n` +
        "Put the file in its module's own directory (lib/ui/modules/<type>/), which is the " +
        'convention the shell-extension glob and `face.extension` already use.',
    ).toEqual([]);
  });

  it('every module on the EXTRAS channel declares WHO owns its push (#1720)', () => {
    // THE NEVER-INITIALISES HALF. Deny by default: a module whose surface drives
    // its node's *HandleExtras must say what pushes when NO surface is mounted,
    // because under the faceplate shell that is the COMMON case, not an edge
    // case. One of the two verdicts is cross-checked against the artifact that
    // implements it, so a declaration cannot outlive its mechanism.
    const types = extrasChannelTypes();
    expect(types.length, 'no module resolved on the extras channel — the predicate is broken')
      .toBeGreaterThan(0);
    expect(ownerOffenders(types)).toEqual([]);
  });

  it('an EXTRAS_OWNERS entry naming a module NOT on the channel is RED (anchored)', () => {
    // The other direction, and the one a list of names always rots in: an entry
    // for a module that was renamed, deleted, or has stopped using extras reads
    // as coverage while covering nothing. Anchored to the ARTIFACT.
    const onChannel = new Set(extrasChannelTypes());
    const stale = Object.keys(EXTRAS_OWNERS).filter((type) => !onChannel.has(type));
    expect(
      stale,
      `EXTRAS_OWNERS entr(ies) for module(s) no longer on the extras channel: ${stale.join(', ')}`,
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

  it('no subject surface revokes urls, stops tracks or detaches in an unmount path', () => {
    // UNCONDITIONAL. There is no exemption list to consult — see the note above
    // FORBIDDEN. Every subject module is judged by every pattern, on every one
    // of its surfaces that is on a channel.
    const offenders: string[] = [];
    for (const type of subjects) {
      for (const hit of violationsFor(type)) {
        const f = FORBIDDEN.find((x) => hit.endsWith(x.name))!;
        offenders.push(`${type} / ${hit} — ${f.why}`);
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

  it('NEGATIVE CONTROL, both directions: the owner check fires on an undeclared module and not on a declared one', () => {
    // PERMANENT, and it calls the SAME predicate the real check calls — an
    // instrument that only ever returns [] is indistinguishable from one that
    // never looked.
    //
    // DENY direction: a module on the channel with no entry is an offender.
    expect(
      ownerOffenders(['noSuchExtrasModule']).length,
      'an undeclared extras module must be reported',
    ).toBe(1);
    // ALLOW direction: a real, declared module is not.
    expect(ownerOffenders(['painter'])).toEqual([]);
  });

  it("SCOPE: 'module-renders-itself' is taken at its word — this gate reads no pixels", () => {
    // The residual blindness, asserted rather than left in prose. One of the
    // two verdicts has an artifact to check against; this one does not, by
    // construction — "the module's own draw is unconditional" is a claim about
    // RENDERING, and nothing in a source grep can confirm it. So a module could
    // declare it falsely and this gate would stay green.
    //
    // What that costs is bounded and stated: the verdict is only reachable for a
    // module in NEITHER structural set, and the `why` must name the module's own
    // idle-field paint. The behavioural net is
    // e2e/tests/extras-producer-lifetime.spec.ts, which reads the actual output
    // texture — and it can only cover the types that HAVE a producer, which is
    // precisely why the other verdict needs a human on it.
    const registered = registeredTypes();
    const trusted = Object.entries(EXTRAS_OWNERS)
      .filter(([, v]) => v.owner === 'module-renders-itself')
      .map(([type]) => type);
    for (const type of trusted) {
      expect(registered.has(type), `${type} must resolve to a registered module def`).toBe(true);
      // If one of these ever gains a structural owner, the verdict is no longer
      // the trusted kind and must be re-declared as the checkable kind.
      // (The headless-mount union used to be the second structural owner this
      // checked; it is retired — extras pushes are the only structural owner
      // kind left for this channel.)
      expect(
        EXTRAS_PRODUCER_TYPES.has(type),
        `${type} declares 'module-renders-itself' but it now HAS a structural owner — ` +
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

  it("the ACTUAL toybox unmount bodies are what the hostile control models (#1589)", () => {
    // A POSITIVE control on the subject that motivated the pattern: the exact
    // teardown above is what ToyboxCard.onDestroy contained, verbatim in shape.
    // Asserting toybox is now clean pins the fix to this gate rather than to a
    // commit message — and because `subjects` is derived, a rename cannot
    // silently drop it (the leg above fails first).
    //
    // ⚠ IT ASKS THE MODULE, NOT THE FILE, which is what makes it survive the
    // move that took toybox off this gate once already: the console left
    // `ToyboxCard.svelte` for `toybox/ToyboxConsole.svelte` and a file-keyed
    // control would have been asserting about a file with nothing in it.
    expect(subjects, 'toybox must still be a subject at all').toContain('toybox');
    expect(violationsFor('toybox')).toEqual([]);
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
