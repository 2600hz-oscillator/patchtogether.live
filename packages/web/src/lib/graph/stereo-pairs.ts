// packages/web/src/lib/graph/stereo-pairs.ts
//
// THE SINGLE SOURCE OF TRUTH for "are these two ports one stereo L/R pair?".
//
// WHY THIS EXISTS
// ---------------
// The app answered that question in FIVE independent places, with five
// different rules and five different answers:
//
//   1. stereo-autowire.ts `findStereoSibling`    — DECLARED stereoPairs only.
//   2. patch-convenience.ts `resolveMainAudioOut` — declared, ELSE the first
//      left-ish + first right-ish audio out (a MAIN-pair resolver, so it stops
//      at one pair and never stem-matches).
//   3. patch-convenience.ts `resolveMainAudioIn`  — the same, input side.
//   4. rear-card-model.ts `markStereoPairs`       — a stem regex over ADJACENT
//      outputs, blind to declarations AND to the port's cable type.
//   5. docs/doc-index.ts `stereoPairOf`           — declared only, off the
//      REGEX-PARSED manifest rather than the live def (so a computed
//      declaration — mixmstrs — was simply missing).
//
// Any wiring or UI change that depends on pairing has to be able to name ONE
// answer. This module is it. It is deliberately behavior-invisible on landing:
// it derives the map and pins it; the consumers move over one at a time.
//
// THE DERIVATION
// --------------
//   allStereoPairs(def) = DECLARED `stereoPairs` ∪ the id-token fallback,
//                         AUDIO-typed ports ONLY, resolved PER DIRECTION.
//   derivedStereoPairs(def) = allStereoPairs(def) − COLLAPSE_EXEMPT
//
// AUDIO-ONLY is load-bearing, not a convenience: `stereovca` declares
// `strength_l` / `strength_r` as **cv** inputs — independent per-channel ring
// depth. They read as a perfect L/R token pair and they are NOT one signal;
// the audio-only rule is what keeps them two jacks without needing an
// exemption. (Verified by test, not assumed — see stereo-pairs.test.ts.)
//
// PER DIRECTION is also load-bearing: a def carries ONE `stereoPairs` set
// shared by inputs and outputs (charlottes-echos declares `['L','R']` and has
// `L`/`R` on BOTH rails), so a pair is only meaningful once a direction is
// fixed. Consumers ask about a rail, never about the def as a whole.
//
// TWO LISTS, SEPARATELY CONSULTED — do not merge them. They are reached
// through two DELIBERATELY DIFFERENT entry points, so a call site has to say
// which question it is asking:
//   * COLLAPSE  — `derivedStereoPairs` / `stereoPairForPort`. "Render as one
//     jack?" Exemptions APPLIED.
//   * WIRING    — `allStereoPairs` / `wiringPairForPort`. "Does patching this
//     port imply a second cable?" Exemptions NOT applied. This is what the
//     universal commit planner in `stereo-autowire.ts` reads.
//   * COLLAPSE_EXEMPT (here) — semantic non-pairs that must keep TWO jacks.
//     `rings` is exactly why the two entry points exist: its
//     `['odd','even']` outputs are two different timbre taps that must not
//     collapse into one jack, yet its declared-pair autowire is shipped
//     behavior, pinned by the e2e "stereo source L → stereo target L
//     auto-wires R too (rings odd/even → cofefve inL/inR)" in
//     e2e/tests/stereo-autowire.spec.ts. Collapsing and autowiring are
//     different questions about the same tuple.
//
// PURITY — no Svelte / SvelteFlow / Yjs / registry imports. Reads only the
// passed def, exactly like stereo-autowire.ts and rear-card-model.ts.

/** The minimal port shape this module reads (any-domain PortDef assignable). */
export interface StereoPortLike {
  id: string;
  type: string;
}

/** The minimal def shape this module reads (any AudioModuleDef / VideoModuleDef
 *  assignable). `type` is optional so synthetic fixtures work — but a def with
 *  NO type can never match a COLLAPSE_EXEMPT entry, by construction. */
export interface StereoPairDefLike {
  type?: string;
  inputs?: readonly StereoPortLike[];
  outputs?: readonly StereoPortLike[];
  stereoPairs?: readonly (readonly [string, string])[];
}

export type PortDirection = 'input' | 'output';

/** How a pair was established. `declared` wins when both routes agree. */
export type StereoPairSource = 'declared' | 'token';

export interface StereoPair {
  /** The LEFT port id. */
  left: string;
  /** The RIGHT port id. */
  right: string;
  /** Which rail the pair lives on — inputs and outputs resolve separately. */
  direction: PortDirection;
  /** `declared` = a `stereoPairs` tuple; `token` = the L/R id-token fallback. */
  source: StereoPairSource;
}

// ---------------- id tokenization (THE canonical copy) ----------------
//
// LIFTED from patch-convenience.ts, which now imports from here. Two copies of
// this vocabulary is the exact bug class this module exists to kill, so there
// is one definition and every consumer imports it.

/** L side words for id-token stereo detection when a def declares no
 *  stereoPairs (audioIn, stereovca, twotracks, …). */
export const LEFT_WORDS: ReadonlySet<string> = new Set<string>(['l', 'left']);
/** R side words — the mirror of LEFT_WORDS. */
export const RIGHT_WORDS: ReadonlySet<string> = new Set<string>(['r', 'right']);

/** Split a port id into lowercase word tokens, splitting BOTH on separators
 *  and on camelCase humps: `out_l` → ['out','l'], `inL` → ['in','l'],
 *  `audio_l_in` → ['audio','l','in'], `ch1L` → ['ch1','l']. */
export function idWords(id: string): string[] {
  return id
    .split(/[^a-zA-Z0-9]+/)
    .flatMap((seg) =>
      // split camelCase too: inL → ['in','L']
      seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/),
    )
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * The L/R side a port id denotes, or null. TOKEN-based, never substring:
 * `signal` ends in "l" but tokenizes to ['signal'], so it is not a left. A
 * port carrying BOTH an l and an r token is ambiguous → null.
 */
export function stereoSideOfId(id: string): 'l' | 'r' | null {
  const words = idWords(id);
  const l = words.some((w) => LEFT_WORDS.has(w));
  const r = words.some((w) => RIGHT_WORDS.has(w));
  if (l === r) return null; // neither, or contradictory
  return l ? 'l' : 'r';
}

/** The id's tokens with its side token removed, or null when it has no
 *  unambiguous side. The shared basis of the pair KEY and the pair LABEL. */
function stemTokens(id: string): string[] | null {
  const side = stereoSideOfId(id);
  if (!side) return null;
  const words = idWords(id);
  const set = side === 'l' ? LEFT_WORDS : RIGHT_WORDS;
  const at = words.findIndex((w) => set.has(w));
  return [...words.slice(0, at), ...words.slice(at + 1)];
}

/**
 * The pair STEM KEY of a sided port id — the id with its side token removed,
 * so the two halves of a pair share a key: `out_l`/`out_r` → 'out',
 * `masterL`/`masterR` → 'master', `audio_l_in`/`audio_r_in` → 'audioin',
 * `L`/`R` → '' (charlottes-echos; an empty stem is a legitimate key).
 * Returns null when the id has no unambiguous side.
 *
 * This is a matching KEY, not a label — separators are dropped so
 * `audio_l_in` and `audioLIn` collide as they should. For the human-facing
 * collapsed label see `stereoPairStemId`.
 */
export function stereoStemOfId(id: string): string | null {
  return stemTokens(id)?.join('') ?? null;
}

// ---------------- COLLAPSE exemptions (DENY BY DEFAULT, named per pair) ----------------

/**
 * Semantic NON-pairs: two audio ports the derivation reads as one stereo pair
 * that are in truth two independent signals and must keep TWO jacks.
 *
 * Keyed by the EXACT `<type>:<direction>:<left>+<right>` triple — never a bare
 * module name — so a NEW pair appearing on an already-listed module still
 * reddens the golden. Every entry carries the reason it is here.
 *
 * ANCHORED TO THE ARTIFACT: `stereo-pairs.test.ts` fails if an entry names a
 * pair the live registry no longer derives. A stale exemption is an exemption
 * nobody is watching, and it silently re-exempts the next regression.
 *
 * ⚠ This list does NOT govern autowire. `rings` keeps its declared-pair
 * autowire (shipped, e2e-pinned at stereo-autowire.spec.ts:90) — autowire
 * reads DECLARED pairs through stereo-autowire's findStereoSibling and never
 * consults this set.
 */
export const COLLAPSE_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'rings:output:odd+even',
    "RINGS' two resonator taps are different TIMBRES (odd vs even partials), " +
      'not the two sides of one image. They must stay two jacks. The declared ' +
      'tuple still drives autowire, which is shipped behavior.',
  ],
]);

// ---------------- MONO AUDIO POINTS (hardware jacks) ----------------

/**
 * Modules whose audio ports are INDEPENDENT PHYSICAL JACKS, so the DUAL-MONO
 * rule ("stereo → mono writes BOTH legs into the mono input") must not apply to
 * them: two legs landing on one of these ports is two signals summing into one
 * hardware output, which is a wiring mistake, not a stereo cable.
 *
 * Keyed by module `type`, each with the reason it is here — the same
 * named-entry-with-a-reason discipline as `COLLAPSE_EXEMPT`, and for the same
 * reason: a predicate ("does the module talk to hardware?") would quietly
 * recruit modules nobody audited.
 *
 * ⚠ DELIBERATELY A LIST OF ONE, and it should stay that way. The owner named
 * this case and its boundary in the same breath (2026-08-07): "ES-9 is a
 * special case because it's explicitly mono channels when used for audio and
 * it's in hardware. **we're not going to have anything else like that.**"
 * `moog984`, `matrixmix` and friends are NOT instances — do not generalise.
 *
 * ⚠ SCOPE — this governs the DUAL-MONO doubling ONLY, i.e. the second leg that
 * would land on the SAME target port as the first. It says nothing about a pair
 * the module genuinely declares (`spdif_l`/`spdif_r` is a real stereo pair and
 * still wires as one), and nothing about the module as a SOURCE: one ES-9 jack
 * fanning out to both legs of a stereo input occupies one physical point and
 * sums nothing, so it keeps the ordinary mono→stereo behaviour.
 *
 * ANCHORED TO THE ARTIFACT: `stereo-pairs.test.ts` fails if an entry names a
 * module type the live registry does not have. A stale entry is one nobody is
 * watching.
 */
export const MONO_AUDIO_POINT_MODULES: ReadonlyMap<string, string> = new Map([
  [
    'es9',
    'The Expert Sleepers ES-9 is a HARDWARE interface: `out1..out8` are eight ' +
      'independent physical output jacks and `in1..in14` eight/fourteen ' +
      'independent physical input jacks. Summing two legs of a stereo bus into ' +
      'one of them is a patching error with no musical reading — the owner ' +
      'sends `send1L`→out3 and `send1R`→out4 as two separate mono cables, ' +
      'which is how the hardware works.',
  ],
]);

/** Whether `moduleType` is a declared MONO-AUDIO-POINT module — see
 *  `MONO_AUDIO_POINT_MODULES`. Undefined type ⇒ false (the safe direction:
 *  the ordinary dual-mono rule applies). */
export function isMonoAudioPointModule(moduleType: string | undefined): boolean {
  return moduleType !== undefined && MONO_AUDIO_POINT_MODULES.has(moduleType);
}

// ---------------- EXPANDABLE STEREO JACKS (the un-collapse opt-in) ----------------

/**
 * Modules whose collapsed stereo jacks the USER may un-collapse into their two
 * L/R legs, via right-click → "expand to L / R jacks".
 *
 * WHAT THIS GATES, AND WHAT IT DOES NOT. It gates the ENTRY POINT only — which
 * modules offer the gesture. The mechanism itself (`stereo-jack-expansion` +
 * `collapseStereoPorts`' `expandedLeftIds` argument) is module-agnostic and
 * knows nothing about mixmstrs: flipping a module on here is a one-line change,
 * and dropping the gate entirely (expand everywhere) is deleting the
 * `isExpandableStereoJackModule` call at the two menu sites. That shape is
 * deliberate — the owner asked for mixmstrs "for now" and said in the same
 * breath "we will probably extend this to all our stereo ports" (2026-08-10).
 *
 * WHY IT IS NEEDED AT ALL. A collapsed jack is the right default: one cable,
 * one gesture, both legs. But it makes a per-leg patch invisible — MIXMSTRS
 * renders `ch1L`+`ch1R` as one `CH1` hole, so "put the left of this stereo
 * source on ch1 L and the right on ch1 R" has no surface to point at, and the
 * user cannot SEE which leg a cable landed on. Expanding shows both holes.
 *
 * Keyed by module `type` with the reason it is here — the same
 * named-entry-with-a-reason discipline as `COLLAPSE_EXEMPT` and
 * `MONO_AUDIO_POINT_MODULES`, and for the same reason: a predicate ("does it
 * have lots of pairs?") would quietly recruit modules nobody audited.
 *
 * ANCHORED TO THE ARTIFACT: `stereo-pairs.test.ts` fails if an entry names a
 * module type the live registry does not have, and fails if the named module
 * derives no stereo pairs at all (an expand gesture with nothing to expand).
 */
export const EXPANDABLE_STEREO_JACK_MODULES: ReadonlyMap<string, string> = new Map([
  [
    'mixmstrs',
    'MIXMSTRS is the rack mixer: every one of its audio rails is a declared ' +
      'pair (`ch1L/R`..`ch8L/R`, `ret1L/R`, `ret2L/R`, `masterL/R`, ' +
      '`send1L/R`, `send2L/R`), so EVERY audio jack on the card is collapsed ' +
      'and none of the 26 legs is individually visible. It is also the module ' +
      'where per-leg patching actually comes up — hardware returns arrive as ' +
      'two independent mono points that have to land on a known side.',
  ],
]);

/** Whether `moduleType` offers the right-click "expand to L / R jacks"
 *  gesture — see `EXPANDABLE_STEREO_JACK_MODULES`. Undefined type ⇒ false
 *  (the safe direction: jacks stay collapsed, which is today's behaviour). */
export function isExpandableStereoJackModule(moduleType: string | undefined): boolean {
  return moduleType !== undefined && EXPANDABLE_STEREO_JACK_MODULES.has(moduleType);
}

/** The COLLAPSE_EXEMPT key for a pair — the exact (module, direction, pair)
 *  triple. A def with no `type` can never produce a matching key. */
export function collapseExemptKey(
  moduleType: string | undefined,
  pair: Pick<StereoPair, 'left' | 'right' | 'direction'>,
): string {
  return `${moduleType ?? '?'}:${pair.direction}:${pair.left}+${pair.right}`;
}

// ---------------- the derivation ----------------

function railOf(def: StereoPairDefLike, direction: PortDirection): readonly StereoPortLike[] {
  return (direction === 'input' ? def.inputs : def.outputs) ?? [];
}

/**
 * Every stereo pair the app can derive for `def`, BEFORE exemptions — the
 * ARTIFACT the exemption list has to explain. Declared tuples first (in
 * declaration order), then token-derived pairs the declarations did not
 * already cover, per direction, inputs before outputs.
 *
 * AUDIO-typed ports only. A declared tuple whose ports are not both audio on
 * the rail under test yields nothing there (that is the rule that keeps
 * cv-typed L/R jacks — stereovca's strength_l/strength_r — independent).
 *
 * ⚠ SCOPE — what this CANNOT see, stated so a green run is not read as more
 * than it is:
 *   • a pair whose two ids share NO l/r token and carry NO declaration
 *     (scope's `ch1`/`ch2`, synesthesia's band taps, es9's `in1..in14`) — such
 *     a pair is invisible here and therefore stays two jacks by default, which
 *     is the safe direction;
 *   • a stem with MORE than one left or more than one right (ambiguous) — it
 *     is skipped, and `ambiguousStereoStems()` NAMES it so the blind spot is
 *     an enumerable list rather than an unstated zero;
 *   • anything a CARD hardcodes. This reads the DEF; a card that hand-lists
 *     L/R descriptors can still disagree with it (the backdraft class). The
 *     PatchPanel-central collapse in PR-4 is what removes that second source.
 */
export function allStereoPairs(def: StereoPairDefLike): StereoPair[] {
  const out: StereoPair[] = [];

  for (const direction of ['input', 'output'] as const) {
    const ports = railOf(def, direction).filter((p) => p.type === 'audio');
    const ids = new Set(ports.map((p) => p.id));
    /** Ports already claimed by a pair on THIS rail — a port is in at most one
     *  pair by construction, not by luck (asserted in the test too). */
    const claimed = new Set<string>();

    // 1) DECLARED tuples — authoritative, naming-agnostic, declaration order.
    //    Counted only on a rail where BOTH ports exist AND are audio-typed.
    for (const [a, b] of def.stereoPairs ?? []) {
      if (!ids.has(a) || !ids.has(b)) continue;
      if (claimed.has(a) || claimed.has(b)) continue;
      claimed.add(a);
      claimed.add(b);
      out.push({ left: a, right: b, direction, source: 'declared' });
    }

    // 2) TOKEN fallback — stem-matched, exactly one left + one right per stem,
    //    over the ports no declaration already claimed.
    const byStem = new Map<string, { l: string[]; r: string[] }>();
    for (const p of ports) {
      const side = stereoSideOfId(p.id);
      if (!side) continue;
      const stem = stereoStemOfId(p.id)!;
      let slot = byStem.get(stem);
      if (!slot) byStem.set(stem, (slot = { l: [], r: [] }));
      slot[side].push(p.id);
    }
    for (const { l, r } of byStem.values()) {
      if (l.length !== 1 || r.length !== 1) continue; // ambiguous → skip
      const [left] = l;
      const [right] = r;
      // A declaration is the STRONGER claim: if either side is already spoken
      // for, the fallback stays out of it rather than inventing a second pair.
      if (claimed.has(left) || claimed.has(right)) continue;
      claimed.add(left);
      claimed.add(right);
      out.push({ left, right, direction, source: 'token' });
    }
  }

  return out;
}

/**
 * Stems on `def` that the token fallback REFUSED because the rail carries more
 * than one left or more than one right for that stem. Returns the NAMES, so the
 * blind spot is an enumerable list rather than an unstated zero — the caller
 * asserts a property of it. (This used to say "a ratcheted number"; the three
 * ceilings that phrasing referred to — DERIVED_PAIR_CEILING,
 * MODULES_WITH_PAIRS_CEILING, UNPAIRED_AUDIO_PORT_CEILING — were deleted in the
 * 2026-08-10 sweep, and no successor counter exists.)
 */
export function ambiguousStereoStems(def: StereoPairDefLike): string[] {
  const found: string[] = [];
  for (const direction of ['input', 'output'] as const) {
    const byStem = new Map<string, { l: number; r: number }>();
    for (const p of railOf(def, direction)) {
      if (p.type !== 'audio') continue;
      const side = stereoSideOfId(p.id);
      if (!side) continue;
      const stem = stereoStemOfId(p.id)!;
      let slot = byStem.get(stem);
      if (!slot) byStem.set(stem, (slot = { l: 0, r: 0 }));
      slot[side] += 1;
    }
    for (const [stem, { l, r }] of byStem) {
      if (l > 1 || r > 1) found.push(`${direction}:${stem}`);
    }
  }
  return found.sort();
}

/**
 * THE ANSWER every consumer asks for: the stereo pairs of `def` that should be
 * treated as ONE stereo signal — `allStereoPairs` minus COLLAPSE_EXEMPT.
 */
export function derivedStereoPairs(def: StereoPairDefLike): StereoPair[] {
  return allStereoPairs(def).filter((p) => !COLLAPSE_EXEMPT.has(collapseExemptKey(def.type, p)));
}

function pairForPortIn(
  pairs: readonly StereoPair[],
  portId: string,
  direction: PortDirection,
): StereoPair | null {
  for (const p of pairs) {
    if (p.direction !== direction) continue;
    if (p.left === portId || p.right === portId) return p;
  }
  return null;
}

/**
 * The COLLAPSE pair containing `portId` on `direction`'s rail, or null — the
 * question "should these two jacks render as one?".
 *
 * ⚠ NOT the question the WIRING layer asks. Use `wiringPairForPort` there. The
 * two differ by exactly `COLLAPSE_EXEMPT`, and `rings` is why the distinction
 * has to be made at the call site rather than defaulted: its `odd`/`even` taps
 * must stay TWO jacks and must STILL auto-wire as a pair. A planner reading
 * this list would silently drop rings' shipped, e2e-pinned autowire.
 */
export function stereoPairForPort(
  def: StereoPairDefLike,
  portId: string,
  direction: PortDirection,
): StereoPair | null {
  return pairForPortIn(derivedStereoPairs(def), portId, direction);
}

/**
 * The WIRING pair containing `portId` on `direction`'s rail, or null — the
 * question "does patching this port imply a second cable?".
 *
 * Reads `allStereoPairs`: declarations ∪ the id-token fallback, WITHOUT the
 * collapse exemptions. A pair the UI refuses to merge into one jack is still a
 * pair the cable planner honours; see the TWO LISTS note at the top of this
 * file. This is the list `$lib/graph/stereo-autowire`'s commit planner uses.
 */
export function wiringPairForPort(
  def: StereoPairDefLike,
  portId: string,
  direction: PortDirection,
): StereoPair | null {
  return pairForPortIn(allStereoPairs(def), portId, direction);
}

/** Which side of its derived pair `portId` is, or null when it is unpaired. */
export function stereoSideForPort(
  def: StereoPairDefLike,
  portId: string,
  direction: PortDirection,
): 'left' | 'right' | null {
  const pair = stereoPairForPort(def, portId, direction);
  if (!pair) return null;
  return pair.left === portId ? 'left' : 'right';
}

/** Deterministic `<direction>:<left>+<right>[:token]` line for a pair — the
 *  golden's unit. Declared pairs carry no suffix so a declaration ADDED for an
 *  already-token-derived pair shows up as a line change, not silence. */
export function serializeStereoPair(p: StereoPair): string {
  return `${p.direction}:${p.left}+${p.right}${p.source === 'token' ? ':token' : ''}`;
}

/**
 * THE COLLAPSED-LABEL POLICY, as data rather than as prose.
 *
 * When PR-4 renders a derived pair as ONE jack, that jack is labelled from the
 * pair's shared STEM, not from either member: `out_l`+`out_r` → `out` → "OUT",
 * `masterL`+`masterR` → `master` → "MASTER", `audio_l_in`+`audio_r_in` →
 * `audio_in` → "AUDIO IN". The individual member labels are UNCHANGED — an
 * uncollapsed rail still reads "OUT L" / "OUT R", which is why
 * `resolveVerboseLabel('out_l') === 'OUT L'` stays true.
 *
 * Returns null when the pair has NO stem of its own (charlottes-echos declares
 * bare `L`/`R`). That is deliberately not papered over with a default: a
 * stemless pair has to take its collapsed label from somewhere else (the
 * port's explicit `label`, or the rail), and returning null forces the caller
 * to say so instead of silently rendering an empty jack.
 *
 * The id is returned UNDERSCORED and lowercase — the shape the shared
 * `resolveVerboseLabel` already knows how to render — so this module stays
 * free of any UI import.
 */
export function stereoPairStemId(pair: Pick<StereoPair, 'left'>): string | null {
  const rest = stemTokens(pair.left);
  return rest && rest.length > 0 ? rest.join('_') : null;
}
