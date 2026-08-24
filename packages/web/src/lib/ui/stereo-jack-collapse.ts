// packages/web/src/lib/ui/stereo-jack-collapse.ts
//
// JACK COLLAPSE — "render one jack per stereo pair", in ONE place.
//
// WHY THIS IS CENTRAL AND NOT PER-CARD
// ------------------------------------
// 208 cards exist; 188 mount PatchPanel and ~44 hand-build their descriptor
// lists. Some of those hand-built lists sit beside files inside the **WebGL
// attest hash basis** (FoxyCard is in it directly; cube and wavesculpt keep
// their GL in CubeVizSurface / WavesculptVizSurface, which are), plus every
// video card, so editing them forces a GPU re-attest. Collapsing inside the
// PANEL rather than in the cards means those faces collapse without a single
// byte changing in the basis — and it means a card CANNOT disagree with its def
// about what is one stereo signal, which is the exact divergence class
// `blind-gates` Pattern 4 is about.
//
// THE RULE
// --------
// A pair collapses iff BOTH of its ports are present in the descriptor list
// being rendered. That "both present" clause is load-bearing, not defensive:
//   * `MixmstrsCard.pickInputs` SILENTLY DROPS ids it does not recognise, so a
//     section could legitimately carry `ch1L` without `ch1R`;
//   * a card may deliberately expose one leg of a pair.
// In either case the honest render is TWO rows (or one uncollapsed row), never
// a collapsed row that claims to patch a port the surface never offered.
//
// WHICH LIST — `derivedStereoPairs`, the COLLAPSE entry point (exemptions
// APPLIED). `rings`' odd/even taps are two timbres and must stay two jacks even
// though they are a declared pair the WIRING layer still auto-wires. Reading
// the wiring list here would silently merge them. See `$lib/graph/stereo-pairs`
// "TWO LISTS, SEPARATELY CONSULTED".
//
// WHAT A COLLAPSED ROW ADDRESSES — its `id` is the pair's LEFT port. Every
// commit path runs through `planAudioCommit`, which reads the pair off the def
// and writes BOTH legs, so clicking the collapsed row patches the whole stereo
// image. `siblingId` is carried alongside so a surface can answer "is this jack
// patched?" about the PAIR rather than about one leg (a legacy only-R cable
// must still light the collapsed jack).
//
// PURITY — no Svelte, no registry, no Yjs. Reads the passed def and the passed
// descriptors, exactly like `stereo-pairs` and `rear-card-model`.

import {
  derivedStereoPairs,
  stereoPairStemId,
  type PortDirection,
  type StereoPair,
  type StereoPairDefLike,
} from '$lib/graph/stereo-pairs';
import { resolveVerboseLabel, type PortDescriptor } from '$lib/ui/patch-panel-labels';

/** A rendered jack row: an ordinary port, or ONE collapsed stereo pair. */
export interface CollapsedPort extends PortDescriptor {
  /** The OTHER leg's port id — set only on a collapsed stereo row. */
  siblingId?: string;
  /** Which side `id` is. Set only on a collapsed stereo row. */
  side?: 'left' | 'right';
}

/**
 * The label a collapsed pair renders.
 *
 * Policy (pinned as data by `stereoPairStemId`, PR-2b): the collapsed jack is
 * named from the pair's shared STEM, never from either member — `out_l`+`out_r`
 * → OUT, `masterL`+`masterR` → MASTER, `audio_l_in`+`audio_r_in` → AUDIO.
 *
 * A pair with NO stem of its own (`L`+`R`, declared bare by charlottes-echos /
 * qbrt / cube / meowbox / wavesculpt / audioOut) takes THE RAIL as
 * its name — 'IN' or 'OUT'. `stereoPairStemId` deliberately returns null there
 * rather than inventing a default, so this is the one place that decision is
 * made and it is visible in the golden.
 *
 * ⚠ The MEMBER labels are untouched. An UNcollapsed rail still reads "OUT L" /
 * "OUT R", which is why `resolveVerboseLabel('out_l') === 'OUT L'` stays true.
 */
export function collapsedPairLabel(pair: StereoPair): string {
  const stem = stereoPairStemId(pair);
  if (stem) return resolveVerboseLabel({ id: stem });
  return pair.direction === 'input' ? 'IN' : 'OUT';
}

// Pairs are a pure function of the def object, and a def object is a
// module-scoped singleton in the registry — so memoise on identity. Every card
// re-derives its rows on each graph pump; without this the whole registry's
// pair derivation would run per card per commit.
const PAIR_CACHE = new WeakMap<object, Partial<Record<PortDirection, StereoPair[]>>>();

function pairsFor(def: StereoPairDefLike, direction: PortDirection): StereoPair[] {
  let byDir = PAIR_CACHE.get(def as object);
  if (!byDir) PAIR_CACHE.set(def as object, (byDir = {}));
  let pairs = byDir[direction];
  if (!pairs) {
    pairs = derivedStereoPairs(def).filter((p) => p.direction === direction);
    byDir[direction] = pairs;
  }
  return pairs;
}

/**
 * Collapse the derived stereo pairs in `ports` into single rows.
 *
 * Order is preserved: the collapsed row lands at the position of whichever
 * member came FIRST in the input list (so a card that lists R before L still
 * gets one row where the user expects it), and the other member is dropped.
 * Everything else passes through untouched, including cv / gate / video ports —
 * `derivedStereoPairs` is audio-typed-only by construction, so `stereovca`'s
 * cv `strength_l`/`strength_r` stay two independent jacks with no exemption.
 *
 * `def === undefined` (a node mid-teardown, or a synthetic descriptor list with
 * no module behind it) ⇒ nothing collapses. That is the safe direction: two
 * jacks always work, a collapsed jack for a pair that is not one does not.
 *
 * ⚠ SCOPE — what this CANNOT see: a pair `derivedStereoPairs` does not derive
 * (no declaration and no shared L/R token — scope's ch1/ch2, es9's in1..in14).
 * Those stay two jacks, which is the safe direction, and the population is
 * ratcheted in stereo-pairs.test.ts rather than left as an unstated zero.
 *
 * `expandedLeftIds` — pairs the USER has un-collapsed via right-click, named by
 * their LEFT port id (`$lib/ui/stereo-jack-expansion`). A pair listed there
 * skips collapse and its two legs pass through as ordinary rows, keeping their
 * own per-leg labels ("CH1 L" / "CH1 R") and their positions in the input list.
 * Everything else on the card collapses exactly as before, so expansion is
 * per-jack and never a card-wide mode.
 *
 * ⚠ EXPANSION IS A RENDER CHOICE AND CHANGES NO WIRING. The returned rows are
 * plain single-port descriptors — no `siblingId`, no `side` — so a click on one
 * addresses exactly that leg. `planAudioCommit` still reads the PAIR off the
 * def, so dropping a mono source on an expanded `CH1 L` writes the same edge it
 * would have written had the user drilled into the collapsed jack's "L" row.
 * The gesture is new; the commit seam is untouched.
 */
export function collapseStereoPorts(
  ports: readonly PortDescriptor[],
  def: StereoPairDefLike | undefined,
  direction: PortDirection,
  expandedLeftIds?: ReadonlySet<string>,
): CollapsedPort[] {
  if (!def || ports.length === 0) return ports.map((p) => ({ ...p }));
  const pairs = pairsFor(def, direction);
  if (pairs.length === 0) return ports.map((p) => ({ ...p }));

  const present = new Set(ports.map((p) => p.id));
  /** portId → the pair it collapses into, but ONLY for pairs whose two ports
   *  are BOTH on this surface AND that the user has not expanded. */
  const pairOf = new Map<string, StereoPair>();
  for (const pair of pairs) {
    if (!present.has(pair.left) || !present.has(pair.right)) continue;
    if (expandedLeftIds?.has(pair.left)) continue;
    pairOf.set(pair.left, pair);
    pairOf.set(pair.right, pair);
  }
  if (pairOf.size === 0) return ports.map((p) => ({ ...p }));

  const emitted = new Set<StereoPair>();
  const out: CollapsedPort[] = [];
  for (const port of ports) {
    const pair = pairOf.get(port.id);
    if (!pair) {
      out.push({ ...port });
      continue;
    }
    if (emitted.has(pair)) continue; // the other leg already produced the row
    emitted.add(pair);
    const side = pair.left === port.id ? 'left' : 'right';
    out.push({
      ...port,
      id: port.id,
      siblingId: side === 'left' ? pair.right : pair.left,
      side,
      // The pair's own name REPLACES the member's — including an explicit
      // per-leg `label` a card passed ("OUT L" on FoxyCard). A collapsed jack
      // named after one of its legs is exactly the lie this module removes.
      label: collapsedPairLabel(pair),
      cable: port.cable ?? 'audio',
    });
  }
  return out;
}

/** Every port id a rendered row addresses — one, or a collapsed pair's two.
 *  The basis of "is this jack patched?" and "what does right-click act on?" */
export function collapsedPortIds(port: CollapsedPort): string[] {
  return port.siblingId ? [port.id, port.siblingId] : [port.id];
}
