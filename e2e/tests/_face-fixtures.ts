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
  // well as unread — the 30 s figure was measured on the surface the lane used
  // to mount (`io-spec-consistency`'s `HEAVY_MOUNT_TIMEOUT`), which now
  // measures at ~1 s, and the faceplate is a different surface from the one the
  // sentence describes. Two entries deleted this way in two merges is the strongest
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
  // ⚠ `archivist` WAS HERE AND IS DELETED BY HAND, NOT AMENDED — the SIXTH
  // instance of the class the `audioOut` note above describes, and the one this
  // file's own `peertube` note named in advance ("same third-party-host class
  // as archivist"). Its entry read: "fetches archive.org over the NETWORK at
  // mount and its media is CORS-tainted by design — a fixture must never depend
  // on a third-party host being reachable from the runner."
  //
  // Same mechanism, same reason for deleting by hand: promotion moves it out of
  // `unpromoted` (the population this record filters), so the loop below stops
  // consulting it and the record goes INVISIBLE rather than RED.
  //
  // ⚠ AND ITS FIRST CLAUSE WAS FALSE, in the recorderbox way rather than the
  // peertube way — worth the line, because the promotion's own argument turns
  // on the opposite fact. NOTHING fetches archive.org at MOUNT: `node.data.item`
  // is null at spawn, the factory loads nothing on its own, and the face's lane
  // tile was written to keep it that way (one non-reactive `onMount` read and
  // one registry subscribe — no fetch, no probe). A search is reachable ONLY
  // through a user gesture, which is why `face-archivist-compact` and
  // `face-archivist-dock` are capturable VRT scenes at all. The second clause —
  // CORS-tainted media — stays TRUE and is simply about a moment no fixture
  // mount reaches, exactly as recorderbox's encoder sentence was.
  // ⚠ `peertube` WAS HERE AND IS DELETED BY HAND, NOT AMENDED — the THIRD
  // instance of the class the `audioOut` and `twotracks` notes above describe,
  // and this file predicted it would keep happening. Its entry read: "resolves
  // a remote PeerTube instance over the network to play anything (same
  // third-party-host class as archivist) — a fixture must never depend on a
  // third-party host being reachable from the runner." That reason is STILL
  // TRUE and is not being overturned; it is simply no longer READ. peertube
  // entered STRICT_FACES with its wave-4 promotion, so it leaves `unpromoted`,
  // the loop below stops consulting this map for it, and the record would go
  // INVISIBLE rather than RED.
  //
  // Its own history is worth keeping one line of, because it is the reason this
  // entry was long: the reason string USED TO carry a second half — "…and the
  // module itself is known-broken — no audio, red CI (#786)" — and both clauses
  // were false on the day peertube shipped. `git log -S'muted = false'` on
  // `PeerTubeCard.svelte` returned exactly ONE commit, #786 itself, so the
  // module was BORN with the un-mute that the tv-librarian no-audio bug (#785,
  // one day earlier) taught, and #786 also shipped the real-media audio guard
  // that still runs on every PR. A reason string is ungated prose: that claim
  // survived two months and was still being cited as fact. Three entries
  // deleted this way in three merges is the strongest evidence yet for the
  // one-line repair already routed to the owner (a `DENIED ∩ STRICT_FACES ===
  // ∅` clause in workflow-shell.spec.ts's existing anchor block) — still
  // correctly NOT self-served under the no-new-gates ruling.
  // ⚠ `doom` WAS HERE AND IS DELETED BY HAND (2026-09-02), the SEVENTH instance
  // of the class the `audioOut`, `twotracks`, `archivist` and `peertube` notes
  // above describe — but the FIRST whose entry was carrying a standing OWNER
  // RULING rather than a capability fact, so it is quoted in full rather than
  // summarised. It read, verbatim:
  //
  //     "OWNER RULING (2026-08-17): never touch DOOM in any way without specific
  //      approval. It is named here so a DERIVED pool can never select it
  //      silently — the mechanical reason is that `runtime.runTic()` runs inside
  //      `surface.draw`, so DOOM's game clock IS the frame clock and spawning it
  //      in a UI spec starts a WAD runtime whose progress is measured in game
  //      tics. It currently sorts LAST of the video candidates, and the
  //      exclusion must not depend on that."
  //
  // ⚠ EVERY CLAUSE OF IT IS STILL TRUE. The ruling stands (this promotion was
  // made under a SPECIFIC 2026-09-02 authorisation for the FACE, which is what
  // the ruling asks for, and it does not generalise to the next change). The
  // mechanism is still true and is re-stated at two anchored sites — the
  // `FACES_WITHOUT_SCENES` entry in `e2e/vrt/_shell-faces.ts` and the standing
  // `EXEMPT_FROM_VRT` entry in `e2e/vrt/vrt-exemptions.ts` — neither of which is
  // prose nobody reads.
  //
  // IT IS DELETED FOR THE MECHANICAL REASON THE FOUR NOTES ABOVE ESTABLISHED,
  // AND HERE THE PROMOTION MAKES THE EXCLUSION **STRONGER**, NOT WEAKER. The
  // loop below iterates `unpromoted`, and `doom` entered `STRICT_FACES` with
  // this promotion, so it leaves that population entirely: a derived pool can no
  // longer reach the `DENIED` lookup for it AT ALL, rather than reaching it and
  // being turned away. A record the loop never consults again would go INVISIBLE
  // rather than RED, which is precisely the silently-decorative state the
  // `peertube` note predicted would keep recurring.
  //
  // ⚠ AND THE ENTRY'S LAST SENTENCE — "it currently sorts LAST of the video
  // candidates, and the exclusion must not depend on that" — is the one worth
  // keeping in the file, because it is now DISCHARGED rather than merely still
  // true: the exclusion no longer depends on the sort, on this map, or on
  // anybody remembering to re-add a name. It depends on set membership in
  // `STRICT_FACES`, which every fixture in this file already reads.
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

/* ⚠ THREE SOURCE-READING HELPERS STOOD HERE AND ARE DELETED WITH THE FILES THEY
 * READ: `cardComponentName`, `cardSource` and `mountsAFader` opened
 * `lib/ui/modules/<Type>Card.svelte` to ask what a module's card drew, and
 * `rendersPlaceholderTile` asked whether one resolved at all. None of those
 * files exists.
 *
 * ⚠ ONE ARGUMENT FROM THEM SURVIVES AND IS KEPT BELOW, because it was never
 * about cards: a `NON_SHELL_LANE_TYPES` member renders its OWN roaming surface
 * rather than a lane tile, so a tile-geometry or tile-thumb assertion has
 * nothing to measure on it. That term is now stated directly in
 * `VIDEO_SINK_FIXTURE`'s predicate, where its one remaining consumer is. */

/**
 * The single `.faceplate.<class>` a module's cables all map to, or null when
 * they disagree.
 *
 * Derived from the CONTRACT GOLDEN's port cable types — never from any
 * component source — so it survives every UI change. Null when the outputs (or,
 * for a sink, the inputs) span more than one domain class: a spec asserting
 * `.faceplate.<class>` cannot name the right one without knowing a declaration
 * order the golden does not record, and guessing is worse than declining.
 */
function uniformDomainClass(type: string): string | null {
  const ports = CONTRACT.get(type);
  if (!ports) return null; // unknown to the golden → fail safe, never guess
  const cables = ports.outputs.length > 0 ? ports.outputs : ports.inputs;
  if (cables.length === 0) return null;
  const classes = new Set(cables.map((c) => domainClassForCable(c)));
  return classes.size === 1 ? [...classes][0] : null;
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
  /** Every module of this domain in the golden — the set the pool and the
   *  rejections must between them account for, with nothing dropped silently. */
  readonly population: readonly string[];
  /**
   * Every module in the WHOLE domain population — the deny list included — that
   * the fitness predicate ACCEPTS.
   *
   * ⚠ THIS IS THE INSTRUMENT'S NEGATIVE CONTROL. A predicate that has gone
   * BLIND and a domain that genuinely has no fit subject produce the same empty
   * pool, and only this field tells them apart: asking the predicate what it
   * accepts across the whole population, with no exclusion allowed to shrink
   * the answer, catches the `<Fader>` → `<NeonFader>` rename class — where a
   * source regex begins rejecting every candidate at once and the pool empties
   * for a reason that has nothing to do with the subject.
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
      readonly kind: 'no-candidate';
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

  // THE NEGATIVE CONTROL, computed BEFORE the pool and over the WHOLE
  // population: what does this predicate accept when the deny list is not
  // allowed to shrink the answer? An empty result here means the predicate
  // itself stopped working. (DENIED is deliberately NOT applied — letting a
  // hand-maintained exclusion feed the instrument check would let a deny entry
  // disguise a blind predicate as a domain with no fit subject.)
  const eligible = population.filter((t) => rejectUnfit(t) === null);

  const rejections: Record<string, string> = {};
  const pool: string[] = [];
  for (const type of population) {
    const denied = DENIED[type];
    if (denied !== undefined) {
      rejections[type] = denied;
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
    const ma = CONTRACT.get(a);
    const mb = CONTRACT.get(b);
    const pa = ma?.params ?? 0;
    const pb = mb?.params ?? 0;
    if (pa !== pb) return pa - pb;
    const na = (ma?.inputs.length ?? 0) + (ma?.outputs.length ?? 0);
    const nb = (mb?.inputs.length ?? 0) + (mb?.outputs.length ?? 0);
    if (na !== nb) return na - nb;
    return a.localeCompare(b);
  });

  if (population.length === 0) {
    return {
      kind: 'no-candidate',
      why:
        `contract-lock.txt declares NO module with domain=${domain} at all. A domain with no ` +
        'modules in the committed golden means the golden did not parse, moved, or stopped ' +
        'spelling its domains this way. Fix the READER before reading anything into the result.',
      pool,
      rejections,
      population,
      eligible,
      probe: rejectUnfit,
    };
  }

  if (eligible.length === 0) {
    return {
      kind: 'no-candidate',
      why:
        `THE FITNESS PREDICATE ACCEPTS NOTHING IN THE ENTIRE domain=${domain} POPULATION ` +
        `(${population.length} modules, the deny list included). The predicate itself stopped ` +
        'working — the class of failure where `<Fader>` was renamed `<NeonFader>` and a ' +
        '`/<Fader\\b/` test began rejecting every candidate at once. FIX THE PREDICATE, do not ' +
        `re-point the fixture. Rejections:\n  ` +
        Object.entries(rejections)
          .map(([t, r]) => `${t}: ${r}`)
          .join('\n  '),
      pool,
      rejections,
      population,
      eligible,
      probe: rejectUnfit,
    };
  }

  const pick = pool[0];
  if (pick === undefined) {
    // The predicate works — it accepts `eligible.length` modules — but every
    // one of them is excluded BY NAME. That is a deny-list problem, and naming
    // it as one is the difference between "fix DENIED" and "fix the predicate".
    return {
      kind: 'no-candidate',
      why:
        `EVERY module the predicate accepts is excluded BY NAME in DENIED, so ${purpose} has no ` +
        `subject. The predicate is healthy (it accepts ${eligible.length} of the ` +
        `${population.length} domain=${domain} modules); the deny list is what emptied the pool, ` +
        `so review DENIED rather than the predicate. Accepted-then-denied: ` +
        `${eligible.filter((t) => DENIED[t] !== undefined).join(', ') || '(none)'}`,
      pool,
      rejections,
      population,
      eligible,
      probe: rejectUnfit,
    };
  }
  return {
    kind: 'ok',
    type: pick,
    domainClass: uniformDomainClass(pick),
    why:
      `${domain} fixture: ${pick} — first by param count, then port count, then name, of the ` +
      `${pool.length} ${domain} modules that pass the predicates (${pool.join(', ')})`,
    pool,
    rejections,
    population,
    eligible,
    probe: rejectUnfit,
  };
}

/* ⚠ THREE DERIVED POOLS STOOD HERE AND ARE DELETED WITH THE POPULATION THEY
 * SELECTED FROM: `AUDIO_PLACEHOLDER_FIXTURE`, `AUDIO_OPERABLE_FIXTURE` and
 * `VIDEO_FIXTURE`. Each meant "an un-faced module whose card does X", and both
 * halves of that sentence are gone — there is no un-faced population, and the
 * fitness predicates read CARD SOURCE that no longer exists.
 *
 * ⚠ THIS FILE'S OWN GUARD IS WHAT REPORTED IT, and it reported it correctly:
 * *"THE FITNESS PREDICATE ACCEPTS NOTHING IN THE ENTIRE domain=audio POPULATION
 * (121 modules) … FIX THE PREDICATE, do not re-point the fixture."* Neither arm
 * of that instruction applied — the predicates could not be fixed and the
 * fixtures could not be re-pointed, because what they selected from was the
 * thing that had been removed. A guard whose two answers are both wrong is
 * still the reason this surfaced as one named failure instead of a suite of
 * silent skips, and that is why the guard survives below rather than going with
 * the pools.
 *
 * Their consumers did not need a derived pick at all once every module renders
 * the same lane tile: the legs that used them assert EXPAND-pill behaviour and
 * dock-faceplate chrome, and now name an ordinary module directly. */

/**
 * An audio module for the DOCK FACEPLATE legs: the chrome assertions and the
 * "a control in the dock actually drives the graph" leg.
 *
 * ⚠ ITS ONE PREDICATE IS A DETERMINATE DOMAIN CLASS, and that is the whole
 * requirement now. The leg asserts `.faceplate.<class>`, so the golden has to
 * be able to NAME the class without guessing a port declaration order it does
 * not record — everything else the leg needs, it discovers from the DOM.
 *
 * ⚠ IT READS NO COMPONENT SOURCE, DELIBERATELY. The pool this replaces demanded
 * that the subject's CARD mount a `<NeonFader>`, so it could drive
 * `.fader-wrap .track` by name. That is what made it brittle twice over: it
 * broke when a component was renamed, and it broke completely when the
 * components were deleted. The leg now drives whichever control the faceplate
 * actually mounts, found in the DOM at test time — which cannot go stale
 * against a component it never reads, and is a stronger assertion besides,
 * because it proves the REAL surface is operable rather than that a particular
 * widget was authored.
 */
export const AUDIO_DOCK_FIXTURE: FixtureResolution = deriveFixture(
  'audio',
  'the dock faceplate chrome and an operable control',
  (type) => {
    if (NON_SHELL_LANE_TYPES.has(type)) {
      return 'a NON_SHELL_LANE_TYPES snowflake: it renders its own roaming surface rather than a lane tile, so the lane half of this leg has nothing to assert on';
    }
    if (uniformDomainClass(type) === null) {
      return 'its cables map to MORE THAN ONE domain class, so the golden cannot say which `.faceplate.<class>` it renders without knowing a declaration order contract-lock.txt does not record';
    }
    // ⚠ IT MUST DECLARE A PARAM, AND THE SORT IS WHY THIS TERM IS NEEDED.
    // `deriveFixture` orders ASCENDING by param count — "simple, cheap to
    // mount" — so without this it hands back the module with the FEWEST params,
    // which is the one with NONE. Measured: the pick was `flipper`, whose
    // faceplate ranks no control at all, and the operability half failed with
    // "must mount at least one ranked control to drive". The cheapest subject
    // and the cheapest OPERABLE subject are one apart, and this term is that
    // one.
    if ((CONTRACT.get(type)?.params ?? 0) === 0) {
      return 'declares no params, so its faceplate ranks no control and the operability half of the leg would have nothing to drive';
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
 * A **VIDEO SINK** — a video module that can be FED by a source, for the
 * fed-host half of `workflow-shell-video`'s live-thumb case.
 *
 * ⚠ IT EXISTS BECAUSE THAT SPEC HARD-CODED `grainsOfVision` (#1929). The spec
 * spawns `lines → g1` and then proves three things ABOUT A LANE TILE: the tile
 * carries a live `video-tile-thumb`, the thumb's blit DRIVES the real chain
 * (`framesDrawn` advances while it is the only watcher), and the picture
 * ANIMATES across frames. A hard-coded subject leaves **every assertion
 * passing while the host it was chosen for stops being proven** the moment
 * that subject changes shape. That is CLAUDE.md's "a gate whose PRECONDITION
 * is the defect" class, and it goes GREEN rather than red, which is why the
 * subject is DERIVED here rather than named.
 *
 * ⚠ WHY A SECOND FIXTURE AND NOT `VIDEO_FIXTURE`. That one resolves a subject
 * for the dock-body case, whose only requirement is that a faceplate body
 * renders. This case must also **wire an edge into it**, so it needs a
 * module with a `video`-cabled INPUT PORT — and it needs that port's ID, which
 * is why `LockedModule` now records `inPorts`. `VIDEO_FIXTURE`'s pick is free to
 * be a source with no inputs at all, and reusing it would resolve happily and
 * then fail at `injectPatch` with an edge to a port that does not exist.
 *
 * The predicates are the assertions' own, and every one of them was READ OFF
 * `laneRenderKind` rather than guessed — `laneRenderKind` is
 * `if (userDocked) return 'stub'; return laneNative ? 'native' : 'shell'`, so
 * the one thing that routes a module away from a measurable lane tile is
 * membership of `NON_SHELL_LANE_TYPES`:
 *
 *   * `domain: 'video'`;
 *   * not a `NON_SHELL_LANE_TYPES` snowflake — such a type renders its own
 *     roaming surface and no lane tile at all, so there is no thumb for the
 *     loop to find. ⚠ This is the predicate a "just pick any video module"
 *     rule would have missed, and it fails in the confusing direction: the
 *     subject resolves and then nothing is there to measure;
 *   * a `video` INPUT port to receive the chain — and its ID, so the edge can
 *     actually be built;
 *   * a `video` OUTPUT — without one the node is never pulled, `framesDrawn`
 *     has nothing to advance, and the "blit drives the chain" leg would pass
 *     vacuously.
 *
 * ⚠ `doom` cannot be selected, and the MECHANISM CHANGED on 2026-09-02 — the
 * prose is updated rather than left true-by-accident. It used to read: "the
 * shared `DENIED` map excludes it BY NAME with the owner ruling, so this pool
 * inherits the exclusion rather than relying on it sorting last." `doom` was
 * PROMOTED (under a specific owner authorisation for its face), so it is no
 * longer in `unpromoted` and the loop never reaches the `DENIED` lookup for it.
 * The exclusion is now STRUCTURAL — a promoted module can never enter a derived
 * pool — which is strictly stronger than a hand-maintained name, and the
 * now-unread `DENIED` entry was deleted with a tombstone rather than left to
 * read as live. The owner ruling itself is unchanged and still governs every
 * other kind of DOOM change.
 */
export const VIDEO_SINK_FIXTURE: FixtureResolution = deriveFixture(
  'video',
  'the lane TILE whose live thumb drives a real upstream chain',
  (type) => {
    // ⚠ A `cardSource(type) === null` TERM STOOD FIRST AND IS DELETED. It meant
    // "a card component resolves, so this renders the placeholder tile rather
    // than its verbatim card" — a question about a render branch that no longer
    // exists. The remaining three are the ones the ASSERTIONS actually need,
    // and none of them ever had anything to do with migration state.
    if (NON_SHELL_LANE_TYPES.has(type)) {
      return 'a NON_SHELL_LANE_TYPES snowflake: it renders its own roaming surface rather than a lane tile, so there is no tile thumb to measure';
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
  const unaccounted = [...fixture.population].sort().filter((t) => !accounted.includes(t));
  if (unaccounted.length > 0) {
    problems.push(
      `these modules were neither offered nor refused by name — a predicate dropped them ` +
        `silently: ${unaccounted.join(', ')}`,
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
