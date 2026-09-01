// packages/web/src/lib/blood/blood-boot.ts
//
// THE BLOOD BOOT SEAM — the one-shot engine boot, extracted out of
// `BloodCard.svelte` so BOTH surfaces run the SAME code.
//
// ⚠ WHY THIS FILE EXISTS, AND IT IS THE SHARPEST CASE OF THE `livecode` SHAPE
// IN THE FLEET. `extras.ensureLoaded()` is what turns a BLOOD node from a dark
// red scanline field into a running Build engine, and until this file landed
// `BloodCard.svelte` held THE ONLY CALL TO IT IN THE WHOLE TREE (no line number
// on purpose — that file moved in this very diff, and a citation with an offset
// in it is stale the moment either file is edited). Promotion
// is precisely what stops that card rendering on the surfaces a player meets,
// and blood is in NEITHER half of `HEADLESS_MOUNT_LANE_TYPES` — it owns no
// media element and it is not a `CARD_PRODUCER` — so nothing mounts the card
// off-screen to boot it either. A faceplate body that forgot to call this
// would leave a promoted BLOOD **dark forever while every gate stayed green**:
// the def is unchanged, the registry is unchanged, the surface mounts, the
// shader compiles and draws its "alive, no signal" idle field, and no
// def-reading gate can see that nobody ever pressed start.
//
// So the boot is a plain TypeScript action with no Svelte in it, called by the
// legacy card (`BloodCard.svelte`) and by the faceplate body
// (`$lib/ui/modules/blood/BloodScreenBody.svelte`), and unit-tested here
// (`blood-boot.test.ts`) against a fake extras handle. A surface can still fail
// to CALL it — that is what `blood-face-screen.spec.ts` and the default-shell
// leg of `blood-audio-output.spec.ts` are for — but the two surfaces can no
// longer DISAGREE about what booting means.
//
// ⚠ WHAT IS DELIBERATELY NOT HERE, AND BOTH ABSENCES ARE LOAD-BEARING.
//
//   * The KEYBOARD host. That is ongoing per-surface behaviour (a capture-phase
//     window listener whose claim predicate reads that surface's own focus), not
//     a one-shot action, and its pure half is already extracted —
//     `shouldClaimBloodKey` in `./blood-keys`. Both surfaces call THAT.
//
//   * ⚠ THE `engine.getDomain('video').read(id, 'extras')` ACCESSOR. Each
//     surface spells that inline, which looks like duplication and is not.
//     `card-media-lifetime.test.ts` / `dom-source-modules.test.ts` DERIVE their
//     subject set by grepping `*Card.svelte` for a literal
//     `read(…, 'extras')` — that is how a card enrols in the "who pushes when no
//     card is mounted" gate, and `EXTRAS_OWNERS.BloodCard` is the entry it holds.
//     Routing the read through a helper here took BloodCard off that gate's
//     radar and turned its still-true entry into a stale one (both files went
//     red on the first full run, which is the good outcome; the bad one is a
//     card that quietly leaves the population). It is also the fleet idiom —
//     every `fullViewBody` in `lib/ui/modules/*/` inlines the same three lines.
//     One-shot ACTIONS belong here; a one-line accessor does not.

// ⚠ DO NOT ADD A `readBloodExtras` HELPER HERE. See the paragraph above; the
// three-line inline read in each surface is deliberate.

import {
  BLOOD_REQUIRED_FILES,
  setInjectedBloodData,
  type BloodDataFile,
} from './blood-runtime';
import { getBloodFiles, putBloodFiles, canonicalBloodName } from './blood-data-store';
import type { BloodHandleExtras } from '$lib/video/modules/blood';

/** The four states a BLOOD surface shows. Identical on both surfaces because
 *  both derive it from the same {@link bootBlood} result. */
export type BloodLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** What one boot attempt concluded. `missing` is read back from the handle
 *  AFTER the attempt (the runtime is what knows which required files failed to
 *  resolve), so an error can be told apart from a data problem. */
export interface BloodBootResult {
  readonly status: 'ready' | 'error';
  readonly error: string | null;
  readonly missing: readonly string[];
}

/** The required-file list, re-exported so a surface's error prose names the
 *  same files the runtime actually looks for rather than a typed copy. */
export const BLOOD_REQUIRED = [...BLOOD_REQUIRED_FILES] as readonly string[];

/**
 * Boot the engine. Idempotent — `ensureLoaded` latches, so calling this twice
 * is one boot and the second call returns the first one's verdict.
 */
export async function bootBlood(extras: BloodHandleExtras): Promise<BloodBootResult> {
  const error = await extras.ensureLoaded();
  const missing = extras.missingDataFiles();
  return error ? { status: 'error', error, missing } : { status: 'ready', error: null, missing };
}

/**
 * Register previously-picked FULL-game data from IndexedDB with the runtime.
 * Returns the canonical names registered (empty when there is nothing stored,
 * or when IndexedDB is unavailable — a private window, a blocked origin).
 *
 * ⚠ IT IS NOT A PRECONDITION OF BOOTING. The 1997 shareware set is committed
 * under `static/blood/` (ADR-007), so a rack with no stored data boots
 * out-of-box; this only widens episode 1 to whatever the owner supplied once.
 */
export async function restoreBloodData(): Promise<readonly string[]> {
  try {
    const stored = await getBloodFiles();
    if (stored.length === 0) return [];
    setInjectedBloodData(stored.map((f) => ({ name: f.name, bytes: f.bytes })));
    return stored.map((f) => f.name.toUpperCase());
  } catch {
    return [];
  }
}

/**
 * The PICKER path: read the chosen files, persist them for next reload,
 * register them with the runtime, DROP any latched failed load, and boot.
 *
 * ⚠ THE `resetLoad()` IS THE WHOLE POINT OF THE ORDER. `ensureLoaded` latches
 * its verdict, so a prior data-missing result would be handed straight back and
 * the freshly-picked bytes would never be read — which is the bug the card's
 * own comment records. Returns null when the picker was dismissed with nothing
 * selected, so a caller can leave its status alone.
 */
export async function importBloodData(
  files: readonly File[],
  extras: BloodHandleExtras,
): Promise<{ result: BloodBootResult; names: readonly string[] } | null> {
  if (files.length === 0) return null;
  const picked: BloodDataFile[] = [];
  for (const file of files) {
    picked.push({ name: canonicalBloodName(file.name), bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  await putBloodFiles(picked.map((f) => ({ name: f.name, bytes: f.bytes })));
  setInjectedBloodData(picked);
  extras.resetLoad();
  return { result: await bootBlood(extras), names: picked.map((f) => f.name.toUpperCase()) };
}

/** One animation frame, or a macrotask where there is no rAF (node tests). */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Wait for the video engine to ADOPT the node, re-reading the caller's own
 * accessor each frame. Returns the handle, or null if it never appeared.
 *
 * ⚠ THIS EXISTS BECAUSE A SURFACE THAT READS `extras` SYNCHRONOUSLY ON MOUNT
 * CAN MISS IT, AND THE FAILURE IS PERMANENT AND SILENT. A component mounts as
 * soon as the graph has the node; the VideoEngine adopts it on its own tick. A
 * mount handler that does `const e = read(); if (!e) return;` therefore boots on
 * some racks and not on others, and on the ones where it loses, BLOOD stays dark
 * forever with no error anywhere.
 *
 * ⚠ AND IT IS NOT HYPOTHETICAL. `BloodCard` used to survive this by ACCIDENT:
 * its mount handler awaited the IndexedDB restore BEFORE looking up `extras`, so
 * the engine got a turn. Extracting the boot into this file preserved the
 * behaviour on the dock (where the engine is always ahead) and broke it in
 * `blood-ingame.spec.ts`, which spawns BLOOD plus a videoOut and an edge — a
 * heavier graph, a later adoption — and went from PASS to a silent
 * `test.skip('BLOOD engine did not reach ready')`. A skip is not a pass; it was
 * the only thing that noticed.
 *
 * ⚠ BOUNDED IN FRAMES, NEVER MILLISECONDS, per the standing boundary: what is
 * being waited on is an engine tick, so frames are the honest unit. 300 is the
 * same budget the e2e spawn helper uses for a node mount.
 */
export async function awaitBloodExtras(
  read: () => BloodHandleExtras | null,
  frames = 300,
): Promise<BloodHandleExtras | null> {
  let extras = read();
  for (let i = 0; i < frames && !extras; i++) {
    await nextFrame();
    extras = read();
  }
  return extras;
}

/**
 * THE MOUNT PATH BOTH SURFACES RUN: restore any owner-supplied data, wait for
 * the engine to adopt the node, then boot out-of-box from whatever resolves. One
 * function so "what happens when a BLOOD surface appears" has exactly one
 * answer.
 *
 * Takes the surface's OWN `extras` accessor rather than a handle, so the
 * adoption wait can re-read it — and so each surface keeps the literal
 * `read(…, 'extras')` its gates enrol on (see the header).
 *
 * Returns null when the engine never adopted the node, which leaves the surface
 * in its `idle` state with the manual BOOT button — the same fallback both
 * surfaces already had, now reached deliberately instead of by a lost race.
 */
export async function autoBootBlood(
  read: () => BloodHandleExtras | null,
): Promise<BloodBootResult | null> {
  await restoreBloodData();
  const extras = await awaitBloodExtras(read);
  if (!extras) return null;
  return bootBlood(extras);
}

/**
 * Which of the three error shapes a surface should paint. Pure, so both
 * surfaces branch identically and the classification is testable without a DOM.
 *
 *   'not-built'    — no `blood.wasm`; the actionable fix is a build command.
 *   'data-missing' — the bundled shareware did not resolve; offer the picker.
 *   'engine'       — anything else the Build engine reported; show it verbatim.
 */
export function bloodErrorKind(
  error: string | null,
  missing: readonly string[],
): 'not-built' | 'data-missing' | 'engine' {
  if (error && error.includes('WASM not built')) return 'not-built';
  if (missing.length > 0) return 'data-missing';
  return 'engine';
}
