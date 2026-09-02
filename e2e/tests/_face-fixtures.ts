// e2e/tests/_face-fixtures.ts
//
// Fixtures for the workflow-mode FACE / legacy-fallback bridge specs.
//
// NOT in `_helpers.ts`: none of this has anything to do with multiplayer, and
// `_helpers.ts` is the shared multi-context helper file. Keep it that way — put
// face/shell fixtures in THIS file.
//
// The split originally had teeth: `_helpers.ts` was a hand-listed member of the
// @collab attest basis, so anything added to it churned the collab content-hash
// and forced a full re-attest (a Postgres spin-up plus the ~50-test @collab
// lane). collab-attest was deleted 2026-08-17, so the rule now rests on meaning
// alone.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE CAN SEE, AND WHAT IT CANNOT (#1864)
//
// Every predicate below reads a COMMITTED ARTIFACT, never the live registry:
//
//   * `contract-lock.txt` — the generated I/O golden. Declared `domain`, every
//     port's cable type, every param. It is on the `docs:accept` loop, so it
//     moves in the same PR as the contract it describes.
//   * `STRICT_FACES` — the promotion set (asserted equal to "every def that
//     declares a `face`", both directions, by module-face-lint).
//   * The def and card SOURCE files.
//
// ⚠ IT CANNOT SEE THE REGISTRIES, AND THAT IS NOT A CHOICE. `$lib/**/modules/
// index.ts` fills them with Vite's `import.meta.glob`, and PLAYWRIGHT DOES NOT
// RUN VITE — under the test loader `listModuleDefs().length === 0` (measured
// 2026-08-17). A module that is registered at runtime but absent from the
// golden is therefore INVISIBLE here. The `unpromoted = pool ∪ rejections`
// identity asserted by the consuming specs is what keeps that blindness from
// silently redefining the subject: nothing may be dropped without a reason.
//
// ⚠ IT ALSO CANNOT SEE MOUNT COST. From the golden, a module that boots a game
// runtime, opens a camera or fetches a third-party host looks exactly like a
// two-knob shader. That is what `DENIED` is for — and `DENIED` grows from
// MEASURED failures, never from speculation, which is why every entry carries
// the evidence somebody already paid for.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRICT_FACES } from '../../packages/web/src/lib/ui/workflow/strict-faces';
import { domainClassForCable } from '../../packages/web/src/lib/ui/workflow/module-shell-model';
import { NON_SHELL_LANE_TYPES } from '../../packages/web/src/lib/ui/workflow/legacy-fallback';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoPath = (...segments: string[]): string => resolve(REPO, ...segments);

/**
 * Modules the predicates ACCEPT but that are known unfit, each with the
 * evidence already paid for. Deny-by-default with a reason per entry, rather
 * than a silent omission — and anchored by the consuming specs, so an entry
 * naming a module the golden does not know is RED instead of quietly
 * decorative.
 *
 * ⚠ THIS LIST IS NOT A PRE-EMPTIVE AUDIT AND MUST NOT BECOME ONE. The
 * un-promoted video population cannot be vetted from a contract golden, and
 * guessing which members are expensive would be exactly the "filter applied
 * before the check" CLAUDE.md warns about. The design is the opposite: the derivation
 * offers the SIMPLEST candidate, the consuming spec proves it mounts, and a
 * candidate that fails earns an entry here carrying the failure that was just
 * observed. Every entry below names a hard, already-established fact.
 */
export const DENIED: Readonly<Record<string, string>> = {
  // ⚠ `audioIn` WAS HERE AND IS DELETED, NOT AMENDED — the THIRD instance of the
  // class the `audioOut` note directly below describes, and the second time this
  // file has watched it happen to its own neighbour. Its entry read: "needs
  // getUserMedia — capability-dependent on CI, where there is no camera or mic
  // to grant."
  //
  // Same mechanism, same reason for deleting by hand: promotion moves it out of
  // `unpromoted` (the population this record filters), so the loop below stops
  // consulting it and the record goes INVISIBLE rather than RED. ⚠ And it would
  // have been factually wrong as well as unread: after promotion nothing on
  // either face surface calls `getUserMedia` on mount at all — the acquire is
  // claimed once per node and only when `enumerateDevices()` already reports
  // LABELLED devices, which a fresh CI context never has. The stated reason
  // stopped describing the module on the day it was promoted.
  // ⚠ `audioOut` WAS HERE AND IS DELETED, NOT AMENDED. Its entry read: "the
  // rack MASTER OUTPUT: `AudioIoSurface.svelte` hosts it (and audioIn) in a
  // dedicated I/O drawer via DockCardHost, so it never renders the lane tile +
  // dock full view the bridge specs assert on."
  //
  // It is now PROMOTED, so it leaves `unpromoted` (the population this record
  // filters) and the loop below never consults it again. That is the important
  // part: a promotion does not redden a stale entry here, it makes one
  // INVISIBLE — the record would have sat on, unread and factually wrong, with
  // every anchor still green (the keys are anchored against `contract-lock.txt`,
  // and audioOut is still a module). Deleted by hand for that reason, and
  // reported to the owner as the one thing this file's own header claims to
  // prevent and cannot: "an entry naming a module the golden does not know is
  // RED instead of quietly decorative" is true for a RENAMED module and false
  // for a PROMOTED one.
  // ⚠ `twotracks` WAS HERE AND IS DELETED, NOT AMENDED — the second instance of
  // the class the audioOut note directly above describes, one merge later. Its
  // entry read: "a two-reel tape emulator: it mounts, but the bridge test timed
  // out at 30 s in `boundingBox` waiting for it, and this fixture's whole
  // contract is 'simple, stable, cheap-to-mount'."
  //
  // Same mechanism, same reason for deleting by hand: promotion moves it out of
  // `unpromoted`, so the loop below stops consulting it and the record goes
  // INVISIBLE rather than RED. ⚠ And this one would have been factually wrong as
  // well as unread — the 30 s figure was about the LEGACY CARD in the lane
  // (`io-spec-consistency`'s `HEAVY_MOUNT_TIMEOUT`), which now measures at
  // ~1 s, and the faceplate is a different surface from the one the sentence
  // describes. Two entries deleted this way in two merges is the strongest
  // evidence yet for the one-line repair already routed to the owner (a
  // `DENIED ∩ STRICT_FACES === ∅` clause in workflow-shell.spec.ts's existing
  // anchor block) — still correctly NOT self-served under the no-new-gates
  // ruling.
  cameraInput:
    'the video twin of audioIn: it needs getUserMedia, which is capability-dependent on CI ' +
    'where there is no camera to grant — the mount would depend on the machine, not the code',
  // ⚠ `recorderbox` WAS HERE AND IS DELETED, NOT AMENDED — the FOURTH instance
  // of the class the `audioOut` note above describes, in as many merges. Its
  // entry read: "mounts a MediaRecorder capture path over a hardware H.264
  // encoder. CI has no OS H.264 encoder, so this fixture would be
  // capability-dependent exactly where the suite runs."
  //
  // Same mechanism, same reason for deleting by hand: promotion moves it out of
  // `unpromoted` (the population this record filters), so the loop below stops
  // consulting it and the record goes INVISIBLE rather than RED.
  //
  // ⚠ AND IT WAS ALREADY WRONG IN ITS FIRST CLAUSE, which is worth one line
  // because the same sentence is quoted elsewhere. Nothing here mounts a
  // `MediaRecorder`: the module encodes through WebCodecs (`VideoEncoder` +
  // mediabunny), and a MOUNT does not open an encoder at all — `probeEncoders`
  // is `isConfigSupported` and nothing more, which every runner answers. What
  // is genuinely capability-dependent is a take ACTUALLY EMITTING CHUNKS, which
  // is a different sentence about a different moment, and one no fixture MOUNT
  // ever reaches. The stated reason stopped describing the module long before
  // the promotion made it invisible.
  archivist:
    'fetches archive.org over the NETWORK at mount and its media is CORS-tainted by design — ' +
    'a fixture must never depend on a third-party host being reachable from the runner',
  // ⚠ THE SECOND HALF OF THIS REASON USED TO BE FALSE, AND IT IS CORRECTED
  // RATHER THAN DELETED. It read: "…and the module itself is known-broken — no
  // audio, red CI (#786)". Both clauses are wrong and were wrong on the day
  // peertube shipped: `git log -S'muted = false'` on `PeerTubeCard.svelte`
  // returns exactly ONE commit — #786 itself — so the module was BORN with the
  // un-mute that the tv-librarian no-audio bug (#785, one day earlier) taught,
  // and #786 also shipped the real-media audio guard that still runs on every
  // PR (`peertube.spec.ts` asserts a non-zero peak at an AUDIO OUT terminal plus
  // `muted === false`). A reason string is ungated prose, so a claim like that
  // survives indefinitely and reads as evidence; this one was still being cited
  // as fact two months later. The FIRST half is true and is sufficient on its
  // own.
  peertube:
    'resolves a remote PeerTube instance over the network to play anything (same ' +
    'third-party-host class as archivist) — a fixture must never depend on a third-party host ' +
    'being reachable from the runner',
  doom:
    'OWNER RULING (2026-08-17): never touch DOOM in any way without specific approval. It is ' +
    'named here so a DERIVED pool can never select it silently — the mechanical reason is that ' +
    '`runtime.runTic()` runs inside `surface.draw`, so DOOM\'s game clock IS the frame clock and ' +
    'spawning it in a UI spec starts a WAD runtime whose progress is measured in game tics. ' +
    'It currently sorts LAST of the video candidates, and the exclusion must not depend on that.',
};

// ── The committed contract golden ────────────────────────────────────────────

/** One module's declared domain, ports and param count, read off the golden. */
interface LockedModule {
  domain: string;
  outputs: string[];
  inputs: string[];
  /** INPUT ports as `(id, cable)` pairs, in golden order.
   *
   *  ⚠ `inputs` above keeps only the CABLE, which is enough to ask "does this
   *  module accept video?" and NOT enough to WIRE one — an edge needs the port
   *  ID. A fixture that resolves a subject but cannot name the port it feeds is
   *  half a fixture, and the half it is missing is the half that made
   *  `workflow-shell-video` hard-code a module name. */
  inPorts: { id: string; cable: string }[];
  params: number;
}

/**
 * Parse `contract-lock.txt` into `type → declaration`. Lines are
 * `<type> meta domain=<d>` / `<type> in <portId> <cable> …` /
 * `<type> out <portId> <cable>` / `<type> param …`.
 */
function readContractLock(): Map<string, LockedModule> {
  const text = readFileSync(repoPath('packages/web/src/lib/docs/contract-lock.txt'), 'utf8');
  const byType = new Map<string, LockedModule>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [type, kind, third, cable] = line.split(/\s+/);
    if (!type || !kind) continue;
    const entry = byType.get(type) ?? { domain: '', outputs: [], inputs: [], inPorts: [], params: 0 };
    if (kind === 'out' && cable) entry.outputs.push(cable);
    else if (kind === 'in' && cable) {
      entry.inputs.push(cable);
      if (third) entry.inPorts.push({ id: third, cable });
    } else if (kind === 'param') entry.params += 1;
    else if (kind === 'meta' && third?.startsWith('domain=')) entry.domain = third.slice('domain='.length);
    byType.set(type, entry);
  }
  return byType;
}

const CONTRACT = readContractLock();

/** Every module type the contract golden knows — the anchor the deny list is
 *  checked against, so an entry naming a module that no longer exists is RED
 *  rather than silently decorative. */
export const CONTRACT_MODULE_TYPES: readonly string[] = [...CONTRACT.keys()].sort();

// ── Source resolution: def file → card component ─────────────────────────────

const DEF_DIRS = ['packages/web/src/lib/audio/modules', 'packages/web/src/lib/video/modules'];

/**
 * Def sources keyed by the type they DECLARE, built once and only if the
 * filename convention misses.
 *
 * ⚠ THE FILENAME IS NOT THE TYPE FOR EVERY MODULE, and reading it as if it
 * were is a filename-convention filter wearing a domain check's clothes.
 * Measured 2026-08-18: six registered video types are declared in
 * kebab-cased files — `cameraInput` in `camera-input.ts`, `outToLaunch`,
 * `tvLibrarian`, `vfpgaRunner`, `videoMixer` (in `mixer.ts`) and `videoOut`.
 * A `<type>.ts`-only lookup rejects all six with a reason that sounds like
 * "not a video module" and is really "not named the way I expected".
 *
 * The anchor is `^  type: '<name>',` — the def's OWN two-space-indented
 * property. Port entries declare `type:` too, but nested (`{ id: 'count',
 * type: 'cv' }`), so an unanchored search answers `cv` for `spirographs`.
 */
let declaredDefSources: Map<string, string> | null = null;
function defSourcesByDeclaredType(): Map<string, string> {
  if (declaredDefSources) return declaredDefSources;
  const map = new Map<string, string>();
  for (const dir of DEF_DIRS) {
    for (const file of readdirSync(repoPath(dir))) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'index.ts') continue;
      const src = readFileSync(repoPath(dir, file), 'utf8');
      for (const m of src.matchAll(/^ {2}type: '([\w-]+)',$/gm)) {
        if (!map.has(m[1])) map.set(m[1], src);
      }
    }
  }
  declaredDefSources = map;
  return map;
}

/** The def source for a module type, or null if no file declares it. */
function defSource(type: string): string | null {
  for (const dir of DEF_DIRS) {
    try {
      return readFileSync(repoPath(dir, `${type}.ts`), 'utf8');
    } catch {
      /* not this dir / not this name — fall through to the declared-type scan */
    }
  }
  return defSourcesByDeclaredType().get(type) ?? null;
}

/**
 * The card component basename this module resolves to, by the
 * `modules-card-map` convention: an explicit `card` on the def wins, else
 * `PascalCase(type) + 'Card'`.
 *
 * ⚠ THE OVERRIDE IS READ OFF THE DEF SOURCE, NOT OFF `getModuleDef` (#1864).
 * This used to ask the audio registry, which is EMPTY under Playwright's
 * loader (see the header) — so `def?.card` was `undefined` for every module on
 * every call and the convention branch was the only branch that ever ran. It
 * happened to give the same verdict for the modules it was aimed at
 * (`moog902`'s conventional `Moog902Card.svelte` does not exist, so it was
 * rejected as "no fader" rather than as "its real card `Moog902VcaCard` has no
 * fader"), which is precisely why nothing noticed. Measured 2026-08-18:
 * resolving the override from source moves NOTHING in the audio pool today —
 * same three members, same pick — so this lands as an instrument repair with a
 * verified zero behaviour delta.
 */
function cardComponentName(type: string): string {
  const declared = defSource(type)?.match(/^ {2}card: '(\w+)',$/m);
  if (declared) return declared[1];
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}Card`;
}

/** The card component source, or null when no component file resolves. */
function cardSource(type: string): string | null {
  try {
    return readFileSync(
      repoPath('packages/web/src/lib/ui/modules', `${cardComponentName(type)}.svelte`),
      'utf8',
    );
  } catch {
    return null;
  }
}

// ── The predicates the ASSERTIONS depend on ──────────────────────────────────

/**
 * Does this module's legacy card mount a fader? Read off the CARD SOURCE, so
 * the fixture is rejected at import time with a reason instead of at 30 s with
 * a timeout.
 *
 * ⚠ THE TAG IS `<NeonFader`, NOT `<Fader` (#1794). This read `/<Fader\b/` until
 * every card was migrated onto `NeonFader` and `Fader.svelte` was deleted —
 * and `<NeonFader` does NOT match `/<Fader\b/`, so the un-updated predicate
 * would have rejected every candidate at once and emptied the pool.
 */
function mountsAFader(type: string): boolean {
  const src = cardSource(type);
  return src !== null && /<NeonFader\b/.test(src);
}

/**
 * WHICH `.faceplate.<class>` this module renders — DERIVED, or null when the
 * golden cannot answer without guessing.
 *
 * ⚠ THIS REPLACED A PREDICATE THAT ASKED "IS IT AUDIO?" (#2137), and the
 * distinction is the whole reason the audio pool had shrunk to two members.
 * The old `rendersAudioFaceplate` REJECTED any module whose cables were not
 * audio-class — 31 of 38 un-promoted audio-domain modules — and it existed for
 * exactly one reason: `workflow-shell.spec.ts` hard-coded
 * `.faceplate.audio`. That is an ASSERTION'S HARD-CODING WEARING A FITNESS
 * CHECK'S CLOTHES: nothing about the legacy-fallback path cares what hue the
 * plate is, so a module was being refused for a property the case does not
 * depend on. Deriving the class instead and asserting THAT makes the leg
 * strictly stronger — it now proves the faceplate carries the RIGHT class for
 * whatever subject the derivation handed it, instead of proving one hard-coded
 * class for a subject hand-filtered to have it.
 *
 * ⚠ IT IS NOT MEASURED SLACK EITHER. The pick this widening produces today is
 * `modtris`, whose class is `gate`, and two of the four operable candidates are
 * gate-class — so `.faceplate.audio` was about to be the WRONG assertion, not
 * merely a narrow one.
 *
 * ⚠ STILL ORDER-INVARIANT, which is the part that must not regress.
 * `cableTypeForDef` takes `outputs[0] ?? inputs[0]` — the DEF's declaration
 * order — while `contract-lock.txt` lists ports SORTED BY ID. Those two orders
 * are not the same, so asking this artifact for "the first output" would ask a
 * different question than the app asks. Requiring every output to agree makes
 * the answer invariant to ordering: whichever port the real def happens to
 * declare first, the class is the same. A module whose outputs DISAGREE is
 * refused by name — the golden genuinely cannot say which class wins without
 * knowing an order it does not record.
 */
function uniformDomainClass(type: string): string | null {
  const ports = CONTRACT.get(type);
  if (!ports) return null; // unknown to the golden → fail safe, never guess
  const cables = ports.outputs.length > 0 ? ports.outputs : ports.inputs;
  if (cables.length === 0) return null;
  const classes = new Set(cables.map((c) => domainClassForCable(c)));
  return classes.size === 1 ? [...classes][0] : null;
}

/**
 * Does this module render the uniform PLACEHOLDER tile when it is un-promoted?
 *
 * ⚠ THE AUDIO SIDE NEVER CHECKED THIS AND WAS ONLY ACCIDENTALLY SAFE. Read
 * `laneRenderKind` — `if (!shellFaces || !hasCard) return 'legacy'; return
 * migrated ? 'shell' : 'placeholder'` — and TWO independent things route a
 * module away from the placeholder, of which promotion is only one. A type with
 * no resolvable card, or a `NON_SHELL_LANE_TYPES` snowflake, renders its
 * VERBATIM LEGACY CARD, so there is no `module-shell-placeholder` for the
 * specs to find at all. The old audio predicate happened to exclude every such
 * module as a side effect of demanding audio-class cables (clipplayer,
 * controlSurface and electraControl are all snowflakes), so dropping that
 * filter without adding this one would have put them straight into the pool and
 * failed in the confusing direction. `VIDEO_SINK_FIXTURE` already documents
 * this exact class; the audio side now states it too.
 *
 * ⚠ THE EXAMPLES IN THAT SENTENCE ARE A SNAPSHOT, AND TWO OF THEM HAVE EXPIRED:
 * `electraControl` was promoted and left `NON_SHELL_LANE_TYPES`, and
 * `controlSurface` followed on 2026-09-01 (its face PR), so neither is a
 * snowflake any more. The ARGUMENT is unaffected and the code cannot drift —
 * `rendersPlaceholderTile` reads the LIVE set below rather than any list here —
 * but the names are corrected (twice now) because a reader takes a
 * parenthetical for a fact. `clipplayer` remains a member.
 */
function rendersPlaceholderTile(type: string): string | null {
  if (cardSource(type) === null) {
    return `no card component resolves (${cardComponentName(type)}.svelte is not in lib/ui/modules), so laneRenderKind returns 'legacy' and there is no module-shell-placeholder to assert on`;
  }
  if (NON_SHELL_LANE_TYPES.has(type)) {
    return "a NON_SHELL_LANE_TYPES snowflake: laneRenderKind returns 'legacy' for it, so it renders its verbatim card rather than the placeholder tile";
  }
  return null;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * What the derivation found. THREE outcomes, and they are three because two of
 * them used to be one:
 *
 *   * `ok` — a fixture. `type` is the pick, `pool` the alternatives.
 *   * `migration-complete` — the predicate still accepts modules in this domain,
 *     but every one it accepts is PROMOTED (or excluded by name), so the
 *     legacy-fallback case has NO SUBJECT **by design**. It is the end state of
 *     the face programme, not a defect: nothing eligible is un-migrated, so
 *     nothing can render the lane placeholder + verbatim dock card these specs
 *     assert on. Consuming specs SKIP with `why` — loud and named, never silent.
 *
 *     ⚠ ITS MEANING WIDENED IN #2137 AND THE CALL SITES DID NOT MOVE. It used to
 *     fire only on `unpromoted.length === 0` — "every module in this domain is
 *     promoted" — which is a state THE FACE PROGRAMME WILL NEVER REACH in audio,
 *     because a dozen games and MIDI surfaces are `bespoke-surface` and are not
 *     queued for a face at all. So the arm that was supposed to be the designed
 *     end state was unreachable, and the reachable outcome was the RED one. The
 *     honest question is not "is anything left un-migrated" but "is anything
 *     left that could SERVE THIS CASE", and that is what it now answers.
 *   * `no-candidate` — the predicate accepts NOTHING IN THE WHOLE POPULATION, or
 *     the golden did not parse. That is a FIXTURE DEFECT — the instrument went
 *     blind — and the consuming gate FAILS on it, printing each rejection.
 *
 * ⚠ THE TWO EMPTY CASES NEED OPPOSITE RESPONSES, WHICH IS WHY THEY ARE
 * SEPARATE VALUES. "Nothing is left to test" and "the instrument rejected
 * everything" are indistinguishable from an empty list alone — the exact
 * shape CLAUDE.md's VALIDATE-THE-INSTRUMENT rule is about. Discriminating them
 * on `unpromoted.length` is the whole point: one is a skip, the other is red.
 *
 * ⚠ AND NEITHER ONE THROWS AT IMPORT (#1864). The previous shape resolved the
 * pick in a module-scope IIFE that threw when it came up empty, so a promotion
 * emptying the pool did not fail the case that lost its subject — it took down
 * EVERY spec importing this file, before any of them ran a line. A fixture's
 * exhaustion must surface where the fixture is USED.
 */
interface FixtureCommon {
  readonly why: string;
  readonly pool: readonly string[];
  readonly rejections: Readonly<Record<string, string>>;
  readonly unpromoted: readonly string[];
  /**
   * Every module in the WHOLE domain population — promoted, un-promoted and
   * denied alike — that the fitness predicate ACCEPTS.
   *
   * ⚠ THIS IS THE INSTRUMENT'S NEGATIVE CONTROL, AND IT IS THE FIELD THAT MAKES
   * THE END STATE EXPRESSIBLE (#2137). "The predicate went blind" and "the
   * migration consumed every eligible subject" produce the SAME empty pool, and
   * before this field they were the same VALUE — both `no-candidate`, i.e. RED.
   * They need opposite responses, which is exactly CLAUDE.md's
   * VALIDATE-THE-INSTRUMENT meta-tell. Asking the predicate what it accepts
   * across the whole population separates them: a predicate that accepts
   * NOTHING ANYWHERE is broken (the `<Fader>` → `<NeonFader>` rename class, which
   * would have rejected every candidate at once); a predicate that accepts
   * plenty but finds them all promoted is a migration that finished.
   */
  readonly eligible: readonly string[];
  /**
   * The SAME fitness closure the derivation ran, exposed so a spec's negative
   * control calls the predicate under test rather than a paraphrase of it
   * (CLAUDE.md: "a permanent negative control calling the same predicate the
   * check calls"). Returns a REASON to reject, or null to accept.
   */
  readonly probe: (type: string) => string | null;
}

export type FixtureResolution =
  | (FixtureCommon & {
      readonly kind: 'ok';
      readonly type: string;
      /** The `.faceplate.<class>` this pick renders — DERIVED from the golden,
       *  so a spec asserts the RIGHT class for whatever subject it was handed
       *  instead of hard-coding one. Null only when the fixture does not
       *  require a determinate class (the placeholder legs never read it). */
      readonly domainClass: string | null;
    })
  | (FixtureCommon & {
      readonly kind: 'migration-complete' | 'no-candidate';
    });

/**
 * Derive one domain's fixture from the golden.
 *
 * ⚠ THE ORDER IS DERIVED, NOT ALPHABETICAL, and that is the point rather than a
 * detail. What this fixture needs is stated in its own contract — "simple,
 * stable, cheap-to-mount" — and param count is that contract's own measure, so
 * ordering by it means the fixture's REQUIREMENT chooses the pick instead of
 * the accident of a name's first letter. Ties break on port count and then on
 * the type name, so the result is fully deterministic and never depends on
 * registry or glob iteration order.
 */
function deriveFixture(
  domain: 'audio' | 'video',
  purpose: string,
  /** Domain-specific fitness: return a REASON to reject, or null to accept. */
  rejectUnfit: (type: string) => string | null,
): FixtureResolution {
  const population = [...CONTRACT.entries()]
    .filter(([, m]) => m.domain === domain)
    .map(([type]) => type)
    .sort();
  const unpromoted = population.filter((t) => !STRICT_FACES.has(t));

  // THE NEGATIVE CONTROL, computed BEFORE the pool and over the WHOLE
  // population: what does this predicate accept when promotion and the deny
  // list are not allowed to shrink the answer? An empty result here means the
  // predicate itself stopped working, which no amount of migration can cause.
  // (DENIED is deliberately NOT applied — it is a hand-maintained exclusion, and
  // letting it feed the instrument check would let a deny entry disguise a blind
  // predicate as a finished migration.)
  const eligible = population.filter((t) => rejectUnfit(t) === null);

  const rejections: Record<string, string> = {};
  const pool: string[] = [];
  for (const type of unpromoted) {
    const denied = DENIED[type];
    if (denied !== undefined) {
      rejections[type] = `DENIED — ${denied}`;
      continue;
    }
    const unfit = rejectUnfit(type);
    if (unfit !== null) {
      rejections[type] = unfit;
      continue;
    }
    pool.push(type);
  }
  pool.sort((a, b) => {
    const ma = CONTRACT.get(a)!;
    const mb = CONTRACT.get(b)!;
    const ports = (m: LockedModule): number => m.inputs.length + m.outputs.length;
    return ma.params - mb.params || ports(ma) - ports(mb) || a.localeCompare(b);
  });

  // ⚠ AN EMPTY POPULATION IS AN INSTRUMENT FAILURE, NEVER A MIGRATION STATE, and
  // this arm exists because without it the two are the SAME VALUE. If the golden
  // failed to parse, or `meta domain=` stopped saying `audio`/`video`, then
  // `population` is empty, `unpromoted` is empty with it, and the arm below would
  // report "every module is promoted" — so every consuming spec would SKIP and the
  // suite would go green while reading nothing at all. "The migration finished" and
  // "the instrument went blind" must not be indistinguishable from the output.
  if (population.length === 0) {
    return {
      kind: 'no-candidate',
      why:
        `contract-lock.txt declares NO module with domain=${domain} at all. That is not a ` +
        'migration state — a domain with no modules in the committed golden means the golden ' +
        'did not parse, moved, or stopped spelling its domains this way. Fix the READER before ' +
        'reading anything into the result.',
      pool,
      rejections,
      unpromoted,
      eligible,
      probe: rejectUnfit,
    };
  }

  // ⚠ THE INSTRUMENT CHECK COMES BEFORE THE MIGRATION CHECK, because a blind
  // predicate would otherwise present itself as a finished migration — the
  // failure mode is silent and green, which is the worst of the two.
  if (eligible.length === 0) {
    return {
      kind: 'no-candidate',
      why:
        `THE FITNESS PREDICATE ACCEPTS NOTHING IN THE ENTIRE domain=${domain} POPULATION ` +
        `(${population.length} modules, promoted and un-promoted alike). That cannot be a ` +
        'migration state: promotion removes modules from the POOL, never from the population ' +
        'this was measured over. So the predicate itself stopped working — the class of ' +
        'failure where `<Fader>` was renamed `<NeonFader>` and a `/<Fader\\b/` test began ' +
        'rejecting every candidate at once. FIX THE PREDICATE, do not re-point the fixture. ' +
        `Un-promoted rejections:\n  ` +
        Object.entries(rejections)
          .map(([t, r]) => `${t}: ${r}`)
          .join('\n  '),
      pool,
      rejections,
      unpromoted,
      eligible,
      probe: rejectUnfit,
    };
  }

  const pick = pool[0];
  if (pick === undefined) {
    // The predicate works (it accepts `eligible.length` modules) and every one
    // it accepts is already promoted or excluded by name. NO SUBJECT BY DESIGN.
    const consumedByPromotion = eligible.filter((t) => STRICT_FACES.has(t));
    const consumedByDenial = eligible.filter((t) => !STRICT_FACES.has(t) && DENIED[t] !== undefined);
    return {
      kind: 'migration-complete',
      why:
        `THE ${domain.toUpperCase()} LEGACY-FALLBACK CASE HAS NO SUBJECT LEFT, BY DESIGN. The ` +
        `fitness predicate still works — it accepts ${eligible.length} of the ` +
        `${population.length} domain=${domain} modules — but every module it accepts is ` +
        'already promoted or excluded by name, so nothing renders ' +
        `${purpose} any more. That is the END STATE of the face programme, not a failure — ` +
        'either DELETE this case, or re-point it at a purpose-built fixture module that is ' +
        'deliberately never promoted.\n' +
        `  consumed by PROMOTION (${consumedByPromotion.length}): ${consumedByPromotion.join(', ') || '(none)'}\n` +
        `  eligible but DENIED (${consumedByDenial.length}): ${consumedByDenial.join(', ') || '(none)'}\n` +
        `  un-promoted but unfit:\n    ` +
        Object.entries(rejections)
          .map(([t, r]) => `${t}: ${r}`)
          .join('\n    '),
      pool,
      rejections,
      unpromoted,
      eligible,
      probe: rejectUnfit,
    };
  }
  return {
    kind: 'ok',
    type: pick,
    domainClass: uniformDomainClass(pick),
    why:
      `${domain} legacy-fallback fixture: ${pick} — first by param count, then port count, ` +
      `then name, of the ${pool.length} un-promoted ${domain} modules that pass the ` +
      `predicates (${pool.join(', ')})`,
    pool,
    rejections,
    unpromoted,
    eligible,
    probe: rejectUnfit,
  };
}

/**
 * A still-UN-MIGRATED audio module — the fixture for every legacy-fallback test
 * (uniform placeholder in the lane + the verbatim legacy card in the dock).
 *
 * DERIVED, not hard-coded, because a hard-coded fixture ROTS: each face wave
 * promotes more modules, and whichever module the bridge tests named eventually
 * joins STRICT_FACES and starts rendering a curated face — so the test asserting
 * "placeholder is visible" fails for a reason that is not a bug. That happened
 * five times before the pool was derived (#1789, #1794): `vca`, `delay`,
 * `noise`, `attenumix`, `destroy`, each discovered by breaking the suite.
 *
 * Its predicates are the ASSERTIONS' OWN, run here rather than described in
 * prose:
 *   * `STRICT_FACES` — a promoted module renders a curated face, so the spec
 *     asserting "placeholder is visible" fails for a reason that is not a bug.
 *   * `rendersPlaceholderTile` — a card that resolves, and not a snowflake.
 *     Both route a module to the VERBATIM LEGACY CARD instead of the
 *     placeholder, and neither has anything to do with promotion.
 *
 * ⚠ IT NO LONGER REQUIRES A FADER OR AN AUDIO-CLASS PLATE, and that is the
 * change that un-wedged this pool (#2137). Those two belong to ONE leg, which
 * now has its own fixture below; carrying them here made every leg pay the
 * strictest requirement and shrank a 34-module pool to two. See
 * `AUDIO_OPERABLE_FIXTURE` for what moved and why.
 */
export const AUDIO_PLACEHOLDER_FIXTURE: FixtureResolution = deriveFixture(
  'audio',
  'the uniform lane placeholder and its EXPAND affordance',
  rendersPlaceholderTile,
);

/**
 * A still-UN-MIGRATED audio module whose legacy card is also OPERABLE — the
 * fixture for the one leg that DRIVES a control instead of merely looking at
 * the tile.
 *
 * ⚠ IT IS A SECOND FIXTURE BECAUSE THE THREE CONSUMING LEGS NEVER WANTED THE
 * SAME THING (#2137). One fixture served all three, so its predicates were the
 * UNION of their requirements and every leg paid for the strictest one. Only
 * `workflow-shell.spec.ts`'s "legacy card operable in the dock" leg drives
 * `.fader-wrap .track` or reads the plate's domain class; the EXPAND-pill legs
 * in `workflow-shell.spec.ts` and `workflow-dock-ux.spec.ts` need nothing but a
 * module that renders a placeholder. Splitting them stops a promotion that
 * empties the narrow pool from also silencing the two legs that never needed it
 * — measured at the split: 4 candidates here against 34 for the placeholder
 * pool.
 *
 * Its predicates, and what each is for:
 *   * `rendersPlaceholderTile` — the shared floor (see above);
 *   * a determinate `uniformDomainClass` — the leg asserts
 *     `.faceplate.<class>`, so the golden has to be able to NAME the class
 *     without guessing a port order it does not record;
 *   * `mountsAFader` — the leg drives `.fader-wrap .track` specifically.
 *     `moog902` satisfied every OTHER stated requirement and its card draws
 *     KNOBS, so the spec spent 30 s in `locator.boundingBox` and failed as a
 *     TIMEOUT, which reads like a broken app rather than an unfit fixture.
 */
export const AUDIO_OPERABLE_FIXTURE: FixtureResolution = deriveFixture(
  'audio',
  'the verbatim legacy card, OPERABLE, in the dock full view',
  (type) => {
    const placeholder = rendersPlaceholderTile(type);
    if (placeholder !== null) return placeholder;
    if (uniformDomainClass(type) === null) {
      return 'its output cables map to MORE THAN ONE domain class, so the golden cannot say which `.faceplate.<class>` it renders without knowing the def\'s declaration order — which contract-lock.txt does not record (it sorts ports by id)';
    }
    if (!mountsAFader(type)) {
      return `its legacy card (${cardComponentName(type)}.svelte) mounts no <NeonFader>, so the operability leg has no '.fader-wrap .track' to drive`;
    }
    return null;
  },
);

/**
 * A still-UN-MIGRATED **VIDEO** module — the legacy-card half of
 * `workflow-dock-ux`'s "migrated AND legacy cards" split-pane case.
 *
 * ⚠ IT EXISTS BECAUSE THAT SPEC HARD-CODED `backdraft`, AND THE FIRST VIDEO
 * FACE PROMOTED IT. The spec needs a module that renders a lane PLACEHOLDER and
 * a verbatim LEGACY CARD in the dock — i.e. one NOT in STRICT_FACES — and it
 * named the most obvious un-migrated video card at the time.
 *
 * ⚠ ITS REPLACEMENT WAS A FOUR-DEEP HAND-PICKED LIST, AND THE COHORT IN FLIGHT
 * SPENT ALL FOUR (#1864). `['bentbox', 'b3ntb0x', 'freezeframe',
 * 'grainsOfVision']` was self-HEALING (a promoted entry was skipped) but never
 * self-REFILLING, and the queue promotes every one of them — so the last
 * promotion in that cohort would have emptied it and thrown at import. No
 * single PR in that queue looks dangerous, which is the tell: the obligation to
 * top the list up lived in a comment, in a file a promoting PR has no other
 * reason to open.
 *
 * Deriving the CANDIDATE SET removes the obligation instead of restating it. A
 * promotion drops a module out of the pool automatically (it enters
 * `STRICT_FACES`) and the pool REFILLS as new un-promoted video modules land.
 * Read against the golden it is not a wider list but a different KIND of list:
 * every un-promoted `domain=video` module that passes the predicates, which
 * today is most of the video registry rather than a hand-picked few.
 *
 * The predicates are, again, the assertions' own: un-promoted (else it renders
 * a curated face, not a placeholder), `domain: 'video'` (the case is explicitly
 * the VIDEO legacy-card path — the `useStore()`-at-init card class its
 * crash-free assertion is about), and a card component that actually resolves
 * (without one SvelteFlow falls back to its default node renderer and there is
 * no `[data-dock-card]` to assert on at all).
 */
export const VIDEO_FIXTURE: FixtureResolution = deriveFixture(
  'video',
  'the uniform lane placeholder and its verbatim legacy VIDEO card in the dock',
  (type) => {
    if (cardSource(type) === null) {
      return `no card component resolves (${cardComponentName(type)}.svelte is not in lib/ui/modules), so SvelteFlow falls back to its default node renderer and there is no [data-dock-card] to assert on`;
    }
    return null;
  },
);

/** The first `video`-cabled INPUT port of a type, or null. Reads the golden, so
 *  it cannot disagree with the contract the engine wires. */
export function videoInPortId(type: string): string | null {
  return CONTRACT.get(type)?.inPorts.find((p) => p.cable === 'video')?.id ?? null;
}

/**
 * A type's declared `domain`, off the golden — `''` when the golden has never
 * heard of it (fail safe, never guess).
 *
 * Exported for the specs that read a module type OFF THE PAGE (a placeholder
 * tile carries its own `data-shell-type`) and need to know whether the video
 * assertions apply to it. Reading the domain here rather than re-listing video
 * module names in a spec is the same discipline the fixtures above follow: the
 * golden moves in the same PR as the contract it describes, a hand list does
 * not. ⚠ It answers about the DECLARED domain only — it says nothing about
 * promotion, card resolution or mount cost, which is what the fixtures are for.
 */
export function contractDomain(type: string): string {
  return CONTRACT.get(type)?.domain ?? '';
}

/**
 * A still-UN-MIGRATED **VIDEO SINK** — an un-promoted video module that can be
 * FED by a source, for the PLACEHOLDER-host half of `workflow-shell-video`'s
 * live-thumb case.
 *
 * ⚠ IT EXISTS BECAUSE THAT SPEC HARD-CODED `grainsOfVision`, AND THIS PR
 * PROMOTES IT (#1929). The spec spawns `lines → g1` and then proves three
 * things ABOUT A PLACEHOLDER TILE: the tile carries a live `video-tile-thumb`,
 * the thumb's blit DRIVES the real chain (`framesDrawn` advances while it is the
 * only watcher), and the picture ANIMATES across frames. A faced tile also has a
 * thumb (#1785), and `b1` already covers that host — so promoting the hard-coded
 * subject leaves **every assertion passing while the placeholder host stops
 * being proven**. That is CLAUDE.md's "a gate whose PRECONDITION is the defect"
 * class, and it goes GREEN rather than red, which is why the re-point is
 * mandatory in the promoting diff rather than a follow-up.
 *
 * ⚠ WHY A SECOND FIXTURE AND NOT `VIDEO_FIXTURE`. That one resolves a subject
 * for the *dock legacy-card* case, whose only requirement is that a card
 * component renders. This case must also **wire an edge into it**, so it needs a
 * module with a `video`-cabled INPUT PORT — and it needs that port's ID, which
 * is why `LockedModule` now records `inPorts`. `VIDEO_FIXTURE`'s pick is free to
 * be a source with no inputs at all, and reusing it would resolve happily and
 * then fail at `injectPatch` with an edge to a port that does not exist.
 *
 * The predicates are the assertions' own, and every one of them was READ OFF
 * `laneRenderKind` rather than guessed — `laneRenderKind` is
 * `if (!shellFaces || !hasCard) return 'legacy'; return migrated ? 'shell' :
 * 'placeholder'`, so **two** independent things route a module away from the
 * placeholder tile and only one of them is promotion:
 *
 *   * un-promoted — else it renders a FACE (`'shell'`), which is `b1`'s host;
 *   * `domain: 'video'`;
 *   * a resolvable card AND not a `NON_SHELL_LANE_TYPES` snowflake — either
 *     makes `hasCard` false, which renders the VERBATIM LEGACY CARD and not a
 *     placeholder at all. ⚠ This is the predicate a "just pick an un-migrated
 *     video module" rule would have missed, and it fails in the confusing
 *     direction: a legacy card has no `module-shell-placeholder` for the loop
 *     to find;
 *   * a `video` INPUT port to receive the chain — and its ID, so the edge can
 *     actually be built;
 *   * a `video` OUTPUT — without one the node is never pulled, `framesDrawn`
 *     has nothing to advance, and the "blit drives the chain" leg would pass
 *     vacuously.
 *
 * `doom` cannot be selected: the shared `DENIED` map excludes it BY NAME with
 * the owner ruling, so this pool inherits the exclusion rather than relying on
 * it sorting last.
 */
export const VIDEO_SINK_FIXTURE: FixtureResolution = deriveFixture(
  'video',
  'the PLACEHOLDER lane tile whose live thumb drives a real upstream chain',
  (type) => {
    if (cardSource(type) === null) {
      return `no card component resolves (${cardComponentName(type)}.svelte is not in lib/ui/modules), so laneRenderKind returns 'legacy' and there is no module-shell-placeholder to assert on`;
    }
    if (NON_SHELL_LANE_TYPES.has(type)) {
      return "a NON_SHELL_LANE_TYPES snowflake: laneRenderKind returns 'legacy' for it, so it renders its verbatim card rather than the placeholder tile";
    }
    if (videoInPortId(type) === null) {
      return 'declares no `video`-cabled INPUT port, so the lines→subject edge has nothing to land on';
    }
    if (!(CONTRACT.get(type)?.outputs ?? []).includes('video')) {
      return 'declares no `video` OUTPUT, so it is never pulled and `framesDrawn` could not advance — the thumb-drives-the-chain leg would pass vacuously';
    }
    return null;
  },
);

/**
 * Everything wrong with a resolution, as messages — EMPTY means healthy, so the
 * consuming gate is `expect(fixtureProblems(F)).toEqual([])` and can never go
 * stale the way a count would.
 *
 * It lives here rather than in either spec because both domains need the same
 * gate and a copy would drift; the ASSERTION stays in the specs, where a
 * failure names the suite that lost its fixture.
 *
 * The checks, and what each is structurally for:
 *   * `no-candidate` — un-promoted modules exist and every one was rejected: a
 *     fixture defect, RED, with each rejection printed.
 *   * THE PICK CAME FROM THE POOL — the derivation's own output, not a value
 *     that arrived some other way.
 *   * `pool ∪ rejections === unpromoted` — ⚠ THE ONE THAT GUARDS THE FILTER
 *     ITSELF. Every un-promoted module is either offered or refused BY NAME,
 *     so a predicate cannot quietly shrink the subject it is measuring. This is
 *     the check that would have caught the old hand-picked list: four names out
 *     of the whole video registry, with the rest neither offered nor refused.
 *   * (THE INSTRUMENT-IS-NOT-BLIND check is NOT here — see the note at the
 *     `no-candidate` line in the body. `deriveFixture` detects an empty
 *     `eligible` itself and returns `no-candidate`, so a clause here could
 *     never fire; the consuming spec owns the positive and negative controls
 *     over `eligible` and `probe`.)
 *
 * ⚠ THE `pool.length <= 1` SLACK FLOOR IS GONE (#2137), AND ITS REMOVAL IS THE
 * POINT RATHER THAN A TIDY-UP. Two things were wrong with it. It was a
 * POPULATION THRESHOLD SITTING EXACTLY ON THE POPULATION — the audio pool held
 * two members and the floor tripped at one, so it had ZERO slack, which is
 * CLAUDE.md's named "a floor sitting exactly ON the population is a ratchet in
 * behaviour whatever it is in intent" hazard. And the PROPERTY it asserted — "a
 * promotion from here is survivable" — became unconditionally true in this same
 * change: emptying the pool now degrades to a NAMED SKIP rather than to a red
 * fixture defect, so there is no longer a cliff to warn about.
 *
 * Per CLAUDE.md the mechanism is DELETED rather than re-tuned, and what replaces
 * it is the unconditional check plus a PERMANENT NEGATIVE CONTROL CALLING THE
 * SAME PREDICATE (`eligible`, and `probe` for the consuming spec's both-
 * directions leg). That is strictly stronger than the floor: the floor could
 * only notice a broken predicate once the pool happened to empty, while
 * `eligible` notices it the moment the predicate stops accepting anything —
 * even if the pool is coincidentally full.
 *
 * `migration-complete` is NOT a problem — it is the designed end state, and the
 * consuming spec skips on it by name.
 */
export function fixtureProblems(fixture: FixtureResolution): string[] {
  const problems: string[] = [];
  if (fixture.kind === 'no-candidate') problems.push(fixture.why);
  // ⚠ THERE IS DELIBERATELY NO `eligible.length === 0` CLAUSE HERE, and its
  // absence is the honest shape rather than an omission. A first draft added
  // one, guarded `&& kind !== 'no-candidate'` — and it could never fire:
  // `deriveFixture` returns `no-candidate` for exactly that condition, so the
  // guard excluded the only state that reaches it. A check that cannot fail is
  // decoration, and listing it among "the checks" would have made this file
  // claim coverage it does not have — the very shape the derivation above
  // exists to prevent. The blind-instrument case is enforced where it is
  // detected (in `deriveFixture`) and surfaced by the `no-candidate` line
  // above, whose `why` carries the full diagnosis; the consuming spec adds the
  // POSITIVE and NEGATIVE controls over `eligible` and `probe`.
  if (fixture.kind === 'ok') {
    if (!fixture.pool.includes(fixture.type)) {
      problems.push(`the pick (${fixture.type}) is not a member of the derived pool`);
    }
  }
  const accounted = [...fixture.pool, ...Object.keys(fixture.rejections)].sort();
  const unaccounted = [...fixture.unpromoted].sort().filter((t) => !accounted.includes(t));
  if (unaccounted.length > 0) {
    problems.push(
      `these un-promoted modules were neither offered nor refused by name — a predicate ` +
        `dropped them silently: ${unaccounted.join(', ')}`,
    );
  }
  return problems;
}

/**
 * The picked module type, for a spec BODY.
 *
 * Throws — deliberately, and only from inside the test that needs a fixture it
 * cannot have. The throw carries the full diagnosis, and it can no longer take
 * an unrelated spec down with it, because resolution no longer happens at
 * import. Pair it with `test.skip(F.kind === 'migration-complete', F.why)`:
 * the end of the migration is a NAMED SKIP, everything else is red.
 */
export function fixtureType(fixture: FixtureResolution): string {
  if (fixture.kind === 'ok') return fixture.type;
  throw new Error(fixture.why);
}
