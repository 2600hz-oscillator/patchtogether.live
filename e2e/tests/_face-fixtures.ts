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
  audioIn:
    'needs getUserMedia — capability-dependent on CI, where there is no camera or mic to grant',
  audioOut:
    'the rack MASTER OUTPUT: `AudioIoSurface.svelte` hosts it (and audioIn) in a dedicated ' +
    'I/O drawer via DockCardHost, so it never renders the lane tile + dock full view the ' +
    'bridge specs assert on. It passes every content predicate and is still unfit.',
  twotracks:
    'a two-reel tape emulator: it mounts, but the bridge test timed out at 30 s in ' +
    "`boundingBox` waiting for it, and this fixture's whole contract is " +
    '"simple, stable, cheap-to-mount"',
  cameraInput:
    'the video twin of audioIn: it needs getUserMedia, which is capability-dependent on CI ' +
    'where there is no camera to grant — the mount would depend on the machine, not the code',
  recorderbox:
    'mounts a MediaRecorder capture path over a hardware H.264 encoder. CI has no OS H.264 ' +
    'encoder, so this fixture would be capability-dependent exactly where the suite runs',
  archivist:
    'fetches archive.org over the NETWORK at mount and its media is CORS-tainted by design — ' +
    'a fixture must never depend on a third-party host being reachable from the runner',
  peertube:
    'queries a remote PeerTube instance over the network at mount (same third-party-host class ' +
    'as archivist), and the module itself is known-broken — no audio, red CI (#786)',
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
    const entry = byType.get(type) ?? { domain: '', outputs: [], inputs: [], params: 0 };
    if (kind === 'out' && cable) entry.outputs.push(cable);
    else if (kind === 'in' && cable) entry.inputs.push(cable);
    else if (kind === 'param') entry.params += 1;
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
 * Does this module render `.faceplate.audio`?
 *
 * ⚠ DELIBERATELY STRICTER THAN THE RUNTIME RULE, and the reason is an ordering
 * hazard rather than caution. `cableTypeForDef` takes `outputs[0] ?? inputs[0]`
 * — the DEF's declaration order — while `contract-lock.txt` lists ports SORTED
 * BY ID. Those two orders are not the same, so asking this artifact for "the
 * first output" would be asking a different question than the app asks. Instead
 * every output must map to `audio`, which makes the answer INVARIANT to
 * ordering: whichever port the real def happens to declare first, the class is
 * the same. A module with mixed outputs is simply not offered as a fixture —
 * over-rejecting only shrinks the pool, and the slack assertion guards that.
 */
function rendersAudioFaceplate(type: string): boolean {
  const ports = CONTRACT.get(type);
  if (!ports) return false; // unknown to the golden → fail safe, never guess
  const cables = ports.outputs.length > 0 ? ports.outputs : ports.inputs;
  if (cables.length === 0) return false;
  return cables.every((c) => domainClassForCable(c) === 'audio');
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * What the derivation found. THREE outcomes, and they are three because two of
 * them used to be one:
 *
 *   * `ok` — a fixture. `type` is the pick, `pool` the alternatives.
 *   * `migration-complete` — every module in this domain is PROMOTED, so the
 *     legacy-fallback case has NO SUBJECT **by design**. It is the end state of
 *     the face programme, not a defect: nothing is un-migrated, so nothing can
 *     render the lane placeholder + verbatim dock card these specs assert on.
 *     Consuming specs SKIP with `why` — loud and named, never silent.
 *   * `no-candidate` — un-promoted modules in this domain exist, but every one
 *     was rejected. That is a FIXTURE DEFECT and the consuming gate FAILS on
 *     it, printing each candidate's rejection.
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
export type FixtureResolution =
  | {
      readonly kind: 'ok';
      readonly type: string;
      readonly why: string;
      readonly pool: readonly string[];
      readonly rejections: Readonly<Record<string, string>>;
      readonly unpromoted: readonly string[];
    }
  | {
      readonly kind: 'migration-complete' | 'no-candidate';
      readonly why: string;
      readonly pool: readonly string[];
      readonly rejections: Readonly<Record<string, string>>;
      readonly unpromoted: readonly string[];
    };

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
    };
  }
  if (unpromoted.length === 0) {
    return {
      kind: 'migration-complete',
      why:
        `THE ${domain.toUpperCase()} FACE MIGRATION IS COMPLETE — every module declaring ` +
        `domain=${domain} in contract-lock.txt is in STRICT_FACES, so it renders a curated ` +
        'face. This case has NO SUBJECT by design: there is no un-migrated module left to ' +
        `show ${purpose}. That is the END STATE, not a failure — either delete this case, or ` +
        're-point it at a purpose-built fixture module that is deliberately never promoted. ' +
        `Promoted ${domain} modules: ${population.join(', ')}`,
      pool,
      rejections,
      unpromoted,
    };
  }
  const pick = pool[0];
  if (pick === undefined) {
    return {
      kind: 'no-candidate',
      why:
        `the derived ${domain} legacy-fallback pool is EMPTY while un-promoted ${domain} ` +
        'modules still exist — so this is a FIXTURE DEFECT, not the end of the migration. ' +
        `Every un-promoted ${domain} module was rejected by a predicate:\n  ` +
        Object.entries(rejections)
          .map(([t, r]) => `${t}: ${r}`)
          .join('\n  '),
      pool,
      rejections,
      unpromoted,
    };
  }
  return {
    kind: 'ok',
    type: pick,
    why:
      `${domain} legacy-fallback fixture: ${pick} — first by param count, then port count, ` +
      `then name, of the ${pool.length} un-promoted ${domain} modules that pass the ` +
      `predicates (${pool.join(', ')})`,
    pool,
    rejections,
    unpromoted,
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
 * The predicates are the ASSERTIONS' OWN predicates, run here rather than
 * described in prose, because each one has already cost a cycle when it was
 * only prose:
 *   * `STRICT_FACES` — a promoted module renders a curated face, so the spec
 *     asserting "placeholder is visible" fails for a reason that is not a bug.
 *   * the DOMAIN CLASS — the bridge specs assert `.faceplate.audio`, which is
 *     derived from the module's CABLE TYPES, not its declared `domain`.
 *     `gatemaiden` is `domain: 'audio'` with GATE ports and renders
 *     `.faceplate.gate`: it satisfied the requirement as written and still
 *     could not satisfy the assertion.
 *   * `mountsAFader` — `workflow-shell.spec.ts`'s operability leg drives
 *     `.fader-wrap .track` specifically. `moog902` satisfied every OTHER stated
 *     requirement and its card draws KNOBS, so the spec spent 30 s in
 *     `locator.boundingBox` and failed as a TIMEOUT, which reads like a broken
 *     app rather than an unfit fixture.
 */
export const AUDIO_FIXTURE: FixtureResolution = deriveFixture(
  'audio',
  'the uniform lane placeholder and its verbatim legacy card in the dock',
  (type) => {
    if (!rendersAudioFaceplate(type)) {
      return 'does not render .faceplate.audio (its cable types put it in another domain class)';
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
 *   * SLACK — more than one candidate. Deliberately a `>` and not an `=`: the
 *     un-promoted population is a population, not a target, and pinning it
 *     would be the ratchet this repo forbids. The PROPERTY asserted is "a
 *     promotion from here is survivable", which needs exactly two members to be
 *     true, and it reddens ONE named test while a replacement still exists
 *     instead of at the moment the last candidate is consumed.
 *
 * `migration-complete` is NOT a problem — it is the designed end state, and the
 * consuming spec skips on it by name.
 */
export function fixtureProblems(fixture: FixtureResolution): string[] {
  const problems: string[] = [];
  if (fixture.kind === 'no-candidate') problems.push(fixture.why);
  if (fixture.kind === 'ok') {
    if (!fixture.pool.includes(fixture.type)) {
      problems.push(`the pick (${fixture.type}) is not a member of the derived pool`);
    }
    if (fixture.pool.length <= 1) {
      problems.push(
        `the legacy-fallback fixture pool is down to ${fixture.pool.join(', ') || 'nothing'}. ` +
          'The NEXT face promotion empties it. Either land an un-promoted module that passes ' +
          'the predicates, or re-home these bridge specs on a purpose-built fixture module ' +
          'instead of borrowing a real one. Rejected candidates and why:\n  ' +
          Object.entries(fixture.rejections)
            .map(([t, r]) => `${t}: ${r}`)
            .join('\n  '),
      );
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
