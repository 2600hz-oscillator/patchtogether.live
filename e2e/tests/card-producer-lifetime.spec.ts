// e2e/tests/card-producer-lifetime.spec.ts
//
// #1587 — "wavesculpt + timelorde render BLACK unless the card happens to be
// open." THE REGRESSION GUARD, and it is NOT collapse-shaped.
//
// These modules produce their picture from a rAF loop that lives on the CARD.
// Under the faceplate shell an un-migrated module's card exists only inside the
// dock full-view, so in the common case the card is NEVER MOUNTED: a SAVED rack
// with `WAVESCULPT.video_out → VIDEO OUT` is solid black ON LOAD, before the
// user touches anything. Collapse is merely how you notice it. The fix keeps the
// real card alive in <HeadlessSourceHost> — CARD_PRODUCER_LANE_TYPES, the
// producer half of the DOM-source rule.
//
// ── THE INSTRUMENT, AND WHY THIS ONE ─────────────────────────────────────────
// The issue's own confirming probe was BLIND and is recorded there as such: it
// scanned every canvas ≥32px in the page and returned BYTE-IDENTICAL readings
// with the card never-mounted and with it expanded
// (`{"w":340,"h":304,"nonBlack":2496,"max":38}` both times). Two independent
// reasons, both since confirmed: a GL-backed canvas returns null from
// `getContext('2d')` and is silently skipped, and — measured here —
// `__openDockFullView('wavesculpt')` mounted NOTHING at all, because
// WavesculptCard's bare `useStore()` threw outside the SvelteFlow provider. So
// "expanded" was not a different state.
//
// This probe cannot fail that way:
//   * it calls the MODULE'S OWN `drawFrame` — the exact callback the
//     cross-domain video-texture bridge invokes each video frame, reached
//     through the public `getVideoSource(nodeId, portId)` — into a 2D canvas
//     THIS TEST owns. No canvas scan, no GL readback, no guessing which element
//     is the output;
//   * it clears that canvas before every draw, so a producer that draws NOTHING
//     reads as black rather than as the previous sample;
//   * it requires the picture to CHANGE, so a frozen surface FAILS rather than
//     reading as a picture. That matters concretely for TIMELORDE: its
//     `drawFrame` keeps blitting the LAST bitmap the card ever pushed, so after
//     a card has once been mounted, "not black" alone cannot tell a live
//     producer from a stale leftover;
//   * the accumulator lives IN THE PAGE (one evaluate per phase, not one
//     round-trip per sample), so a loaded runner cannot starve the subject with
//     the measurement, and every assertion message carries frames / elapsedMs /
//     the values seen.
//
// ── FRAMES, NEVER MILLISECONDS — AND THE ONE PLACE THAT BIT ──────────────────
// Sampling is per-rAF-frame and the movement check EXITS ON THE EVENT (first
// changed frame), with a frame CAP that only bounds the failure. An earlier
// draft used a fixed 20-frame window instead and failed on TIMELORDE for a
// reason worth recording: its owl pulses on the beat, and `beatPulse` returns a
// FLAT 0 for the last 40 % of every beat — 200 ms at the default 120 bpm. On a
// 120 Hz display 20 frames is 166 ms, so every sample landed inside that flat
// stretch and a perfectly live producer read as frozen. A fixed frame budget is
// a different assertion on every refresh rate when the SUBJECT's period is in
// milliseconds. Waiting for the event is not.
//
// ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
//   1. NEVER-MOUNTED: spawn the rack, expand NOTHING, and require live moving
//      picture on every port that carries one. This is the owner's report.
//   2. POSITIVE CONTROL (permanent): the identical probe while the card IS
//      mounted in the dock full-view. The two live-port SETS must be EQUAL —
//      which is the causal claim in both directions, and is what stops the
//      never-mounted leg passing vacuously.
//   3. CONTINUITY: collapse, sampling EVERY frame across the handoff so the
//      re-init blip is measured rather than assumed, then require picture again.
//   4. DELETE: the node leaves the graph → the card is unmounted from every
//      host (that unmount is what runs disposeGl) and the engine handle is gone.
//
// ── #1724: THE FIRST *MIGRATED* PRODUCER, AND WHAT IT COST THIS SPEC ─────────
// CUBE joined the set through the same seam as WAVESCULPT — a frame drawer
// installed from `modules/cube/CubeVizSurface.svelte` — and broke an ASSUMPTION
// baked in here rather than derived: that a producer's lane always shows the
// un-migrated `module-shell-placeholder`. cube is MIGRATED, so its lane is a
// `module-shell` — and being migrated is NOT a reprieve, because `curatedFace`
// drops `face.hero.cell` from the lane order (PF-22 `laneOrder`) and cube's hero
// cell IS its renderer. The lane tile mounts no surface at all. `laneTestId` is
// now DERIVED from the def's own `strictFace`, so the next migrated producer
// enrols without an edit.
//
// MEASURED for cube, headless mount disabled vs enabled, same probe/port:
//   never-mounted nonBlack 0/3072 maxLuma 0   ·   card mounted 3072/3072 maxLuma 212
// ⚠ cube then SKIPS the movement leg, correctly and loudly: its viz is PARAM-
// driven, not time-animated (rotation is `view_rot_*`, not a clock), so it reads
// `distinct signatures=1 over 300 frames` even with the card mounted. The causal
// leg above it is what carries cube, and 0-vs-3072 is not a subtle signal.
//
// REGISTRY-DRIVEN: subjects are DERIVED from CARD_PRODUCER_LANE_TYPES (itself
// held exhaustive by dom-source-modules.test.ts's seam gate); each subject's
// DOMAIN and OUTPUT PORTS come from the generated registry manifest, and its
// MIGRATION STATE from STRICT_FACES. Nothing here is a hand-typed module list,
// so a producer module enrols itself.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { REGISTRY } from './_registry';

/** SwiftShader (CI, or a local E2E_SWIFTSHADER=1 flake-check) rasterizes WebGL
 *  in software at roughly an eighth of a real GPU's frame rate, and WAVESCULPT
 *  is a full 3-D pass. Every budget below is in FRAMES; only the whole-test
 *  wall-clock ceiling needs the software-renderer scale. */
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** Probe canvas size, in CSS px. Small on purpose: the question is "is there a
 *  changing picture", not "what does it look like", and every extra pixel is
 *  getImageData cost on the same main thread as the subject. */
const PROBE_W = 64;
const PROBE_H = 48;
/** Per-pixel luma (0-255) above which a pixel counts as NON-BLACK. Chosen so
 *  each module's IDLE frame reads as fully black: WAVESCULPT's undriven
 *  drawFrame fills #000 (luma 0) and TIMELORDE's fills #07090d (luma 8). */
const BLACK_LUMA = 8;
/** Frames a port is sampled to decide "does it carry a picture at all". A few,
 *  not one: WAVESCULPT's ribbon is thin and its per-frame non-black count
 *  swings (measured 78-170 of 3072), so one unlucky frame must not decide. */
const LIVE_SAMPLE_FRAMES = 5;
/** Frame CAP on the movement check. It BOUNDS THE FAILURE; the check exits on
 *  the first changed frame, so the normal cost is 1-2 frames for WAVESCULPT and
 *  at most one beat for TIMELORDE. */
const CHANGE_CAP_FRAMES = 300;
/** Frame CAP on the producer-READINESS wait that precedes every samplePorts
 *  call (#1620). It BOUNDS THE FAILURE, never gates the pass: the wait exits
 *  the frame a source registers, so the normal cost is 0-2 frames. WHY IT
 *  EXISTS: the never-mounted leg used to sample IMMEDIATELY after spawnPatch
 *  for only LIVE_SAMPLE_FRAMES(5) rAF frames, with nothing waiting for the
 *  node's producer to boot — solo that is plenty (10/10 measured), but under
 *  the webgl attest's PARALLEL pass wavesculpt's headless producer (GL context
 *  + shader compile) reliably loses the race and 5 frames of "no source" read
 *  as "never produces": the same leg failed both retries on two consecutive
 *  quiet-machine attest runs. The claim under test is that the never-mounted
 *  node PRODUCES — how long its producer takes to boot under load is not the
 *  subject. Counted in FRAMES (renderer-independent) per the repo rule; a
 *  producer that genuinely never registers (the pre-#1587 defect) exhausts
 *  this cap ONCE, bounded, and the sampler then reads no-source → the same
 *  red as before, now carrying `waitedFrames` in the message. */
const SOURCE_READY_CAP_FRAMES = 600;
/** Frames sampled around the dock→headless handoff, every frame. */
const HANDOFF_FRAMES = 90;
/** How long the picture may be absent across that handoff, in FRAMES. The card
 *  really does re-mount (WAVESCULPT re-runs initGl), so a short gap is expected
 *  and is the thing being bounded; a picture that never comes back is the bug. */
const MAX_BLACK_RUN_FRAMES = 30;

const LANE_SETS_SRC = readFileSync(
  fileURLToPath(
    new URL('../../packages/web/src/lib/ui/workflow/dom-source-modules.ts', import.meta.url),
  ),
  'utf8',
);

/** One `export const <NAME>: ReadonlySet<string> = new Set<string>([...])`
 *  literal from the shared source. ANCHORED ON THE EXPORT: a bare
 *  `/<NAME>[^[]*\[/` matches the first PROSE mention of the name in the file
 *  header and then runs on to the WRONG array — which is exactly what it did on
 *  the first run here, silently substituting the DOM-source set for the producer
 *  set and enrolling nine modules nobody asked for. */
function parseLaneSet(name: string, opts: { mayBeEmpty?: boolean } = {}): string[] {
  const re = new RegExp(`export const ${name}[^[]*\\[([\\s\\S]*?)\\]`);
  const block = re.exec(LANE_SETS_SRC);
  if (!block) throw new Error(`could not parse ${name} — has the shape changed?`);
  const types = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  // ⚠ EMPTINESS IS A DEFECT FOR SOME SETS AND A FACT FOR OTHERS, and conflating
  // them cost the WHOLE E2E LANE (legacy-removal S1, 2026-09-03). This threw
  // unconditionally, which was right while every set had members. When
  // `DOM_SOURCE_LANE_TYPES` legitimately emptied — all five members converted to
  // node-scoped controllers — the throw fired at COLLECTION time, and a
  // collection-time throw in ONE spec makes Playwright list ZERO tests in ZERO
  // files across the entire project. Not one red spec: an empty run that reports
  // success in some readers.
  //
  // ⚠ AND NO FOCUSED RUN CAN SEE IT. `task e2e:one -- <spec>` still COLLECTS
  // every file, so the failure is lane-wide the moment it exists; the thing that
  // caught it was `scripts/ci-selection-audit.test.ts`, which shells out to
  // `playwright test --list`. Worth knowing where that alarm comes from.
  //
  // So the guard is now per-set, and the caller says which it is.
  if (types.length === 0 && !opts.mayBeEmpty) {
    throw new Error(`${name} parsed EMPTY — refusing to pass vacuously`);
  }
  return types;
}

// ⚠ `FACE_MOUNTS_PRODUCER` WAS PARSED HERE AND IS RETIRED (legacy-removal
// S1.5) with the headless host, `needsHeadlessSourceMount` and the export
// itself: with `CARD_PRODUCER_LANE_TYPES` empty there is no producer whose
// dock state could need the exemption, and the `keepsHeadlessWhileDocked`
// subject field that consumed it went with it. The retirement record lives on
// dom-source-modules.ts.

/** The producer subjects, derived from the shared source. */
function cardProducerTypes(): string[] {
  // ⚠ MAY BE EMPTY, AND IS — the terminal state of the extractions
  // (legacy-removal S1.5: rasterize -> RASTERIZE_FRAME_PRODUCER, cube ->
  // NodeVizSurfaceHost). Every leg the first half derives from this list
  // vanishes with the population, which is exactly why the node-owner halves
  // below live in THIS file: the same modules, the same instruments, the
  // OPPOSITE claim. A type re-entering the set re-derives its four legs here
  // with no edit.
  const producers = parseLaneSet('CARD_PRODUCER_LANE_TYPES', { mayBeEmpty: true });
  // PARSE SELF-CHECK, and it is not decoration: the two sets are asserted
  // DISJOINT by dom-source-modules.test.ts, so any overlap here means this
  // parse grabbed the wrong array literal — the one failure mode a regex over
  // source has, and one that otherwise shows up as nine mysterious subjects.
  // ⚠ MAY BE EMPTY, AND IS. This is a PARSE SELF-CHECK, not a subject list: it
  // exists only to prove the regex above grabbed the right array literal. An
  // empty DOM-source set makes the overlap check trivially pass, which is
  // correct — there is nothing to overlap WITH — and the check's real value was
  // always the day the regex matched the wrong literal, which an empty result
  // cannot hide (a wrong-literal match would return the PRODUCER names here and
  // the overlap would be total). See `dom-source-modules.ts` for why the set is
  // empty and what its emptiness does and does not assert.
  const domSource = new Set(parseLaneSet('DOM_SOURCE_LANE_TYPES', { mayBeEmpty: true }));
  const overlap = producers.filter((t) => domSource.has(t));
  if (overlap.length > 0) {
    throw new Error(
      `CARD_PRODUCER_LANE_TYPES parse returned DOM-source types (${overlap.join(', ')}) — ` +
        'the regex matched the wrong array literal',
    );
  }
  return producers;
}

const SUBJECTS = cardProducerTypes().map((type) => {
  const mod = REGISTRY.find((m) => m.type === type);
  if (!mod) throw new Error(`${type} is in CARD_PRODUCER_LANE_TYPES but not in the registry manifest`);
  return {
    type,
    domain: mod.domain,
    /** The lane tile every producer renders. It used to be DERIVED from the
     *  manifest's `strictFace` (#1724), because a faced producer and an un-faced
     *  one painted different tiles and hard-coding one made the assertion
     *  silently un-satisfiable for the first faced producer to join the set —
     *  which is exactly what CUBE was. There is one tile now, so the derivation
     *  is gone and the constant is honest. */
    laneTestId: 'module-shell' as const,
    /** Every video-carrying OUTPUT port. Which of them actually carries the
     *  card-produced picture is DERIVED at runtime (a port that shows nothing
     *  even with the card mounted — SYNESTHESIA's per-band rasters with no
     *  video patched in — is not this test's subject), never declared here. */
    videoOuts: mod.outputs
      .filter((p) => p.type === 'video' || p.type === 'mono-video')
      .map((p) => p.id),
    /**
     * Does this subject KEEP its headless host while its dock full view is
     * open? DERIVED, never declared here — from the manifest's own
     * `strictFace` plus `FACE_MOUNTS_PRODUCER` parsed out of the same shared
     * source every other set on this page comes from.
     *
     * ⚠ THE DEFAULT INVERTED ON 2026-08-23 AND THIS PAGE STILL ASSERTED THE
     * OLD ONE. `FACE_MOUNTS_PRODUCER`'s own prose records why: TIMELORDE was
     * the first promoted producer whose face only BLITS, so unmounting its
     * card left the face painting a STALE bitmap (measured `nonBlack
     * 47034/48400` from a card that was already gone) or a cold black field.
     * The default is now "a faced producer KEEPS its headless host while its
     * dock full view is open", and a module leaves that default BY NAME.
     *
     * So the constant `headless: 0` this test used to assert is now true for
     * exactly three reasons and false for a fourth:
     *   * NOT migrated (wavesculpt, synesthesia) — the dock shows the real
     *     legacy card, which MOVED there out of the headless host  -> 0
     *   * migrated AND in FACE_MOUNTS_PRODUCER (cube, rasterize) — the face
     *     mounts the producing surface itself, so hosting it too would be the
     *     second mount this whole page exists to forbid                -> 0
     *   * migrated and NOT in that set (scope, timelorde) — the face only
     *     blits, so the host is what keeps the pump running            -> 1
     * The claim is unchanged in substance: EXACTLY ONE surface runs the
     * producer. Only the place it lives now depends on the module.
     */
    migrated: mod.strictFace === true,
    // ⚠ CONSTANT-FALSE SINCE S1.5: FACE_MOUNTS_PRODUCER and the headless host
    // it modulated are retired, so no subject can keep a host in any dock
    // state. Left as a field (rather than deleted from the legs) so a type
    // re-entering the set derives its four legs unchanged — and REDS on the
    // host assertions, which is correct: the repair for a returning producer
    // is a node-scoped owner, never a host revival.
    keepsHeadlessWhileDocked: false,
  };
});

interface PortSample {
  port: string;
  /** Max non-black pixel count over LIVE_SAMPLE_FRAMES frames, of PROBE_W*H. */
  nonBlack: number;
  /** Max per-pixel luma seen, 0-255. */
  maxLuma: number;
  /** Present only when the port could not be probed at all. */
  reason?: string;
}

/** ONE evaluate: sample every listed port for a few frames and report the max
 *  non-black count per port. In-page accumulator — never a Playwright poll. */
async function samplePorts(page: Page, nodeId: string, ports: string[]): Promise<PortSample[]> {
  return page.evaluate(
    async ({ nodeId, ports, frames, W, H, BLACK }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            getVideoSource?: (
              id: string,
              port: string,
            ) => { drawFrame?: (c: HTMLCanvasElement | OffscreenCanvas) => void } | null;
          };
        };
      };
      const out = ports.map((port) => ({ port, nonBlack: 0, maxLuma: 0, reason: undefined as string | undefined }));
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        for (const o of out) o.reason = 'the PROBE canvas returned no 2d context';
        return out;
      }
      let n = 0;
      await new Promise<void>((resolve) => {
        const tick = () => {
          n++;
          for (const o of out) {
            let src: { drawFrame?: (c: HTMLCanvasElement | OffscreenCanvas) => void } | null = null;
            try {
              src = w.__engine!().getDomain('audio').getVideoSource!(nodeId, o.port);
            } catch (e) {
              o.reason = `no engine: ${String(e)}`;
              continue;
            }
            if (!src || typeof src.drawFrame !== 'function') {
              o.reason = `no video source for ${nodeId}.${o.port}`;
              continue;
            }
            o.reason = undefined;
            ctx.clearRect(0, 0, W, H);
            src.drawFrame(c);
            const d = ctx.getImageData(0, 0, W, H).data;
            let nonBlack = 0;
            let maxLuma = 0;
            for (let i = 0; i < d.length; i += 4) {
              const l = (d[i]! * 77 + d[i + 1]! * 151 + d[i + 2]! * 28) >> 8;
              if (l > BLACK) nonBlack++;
              if (l > maxLuma) maxLuma = l;
            }
            if (nonBlack > o.nonBlack) o.nonBlack = nonBlack;
            if (maxLuma > o.maxLuma) o.maxLuma = maxLuma;
          }
          if (n >= frames) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return out;
    },
    { nodeId, ports, frames: LIVE_SAMPLE_FRAMES, W: PROBE_W, H: PROBE_H, BLACK: BLACK_LUMA },
  );
}

/**
 * Wait (in-page, rAF-counted, BOUNDED) until the node's video producer is
 * registered — i.e. `getVideoSource()` returns a source for at least one of
 * the node's declared video outs (#1620). Registration is per-node in the
 * engine, so any-port readiness means the boot race is over; which ports then
 * CARRY A PICTURE stays entirely samplePorts' question. Applied before BOTH
 * the never-mounted and the mounted probe, so the two phases remain the same
 * instrument.
 */
/**
 * Wait until pixel COVERAGE has stopped GROWING, then report it.
 *
 * WHY, measured (#1664 enrolled RASTERIZE and this fell out): a producer whose
 * frame FILLS IN over time is not comparable between two phases sampled at
 * different ages, and phase 2 here is ALWAYS older than phase 1. RASTERIZE
 * paints `samplesPerFrame` pixels per video frame — 800 into a 640×480 frame,
 * 0.26 % — so its raster needs hundreds of frames to establish. Sampling both
 * phases "as soon as the producer registers" therefore compared a 5-frame-old
 * raster against a several-hundred-frame-old one and read the AGE DIFFERENCE as
 * a card-mount effect: measured 3 runs of the unchanged subject, never-mounted
 * `nonBlack=0/3072` vs mounted `64/3072`, failing 1 run in 3.
 *
 * Convergence is on the MAXIMUM, not on equality, because most subjects here
 * are MOVING pictures whose per-frame count never repeats — wavesculpt's ribbon
 * would never satisfy "unchanged". A monotone fill plateaus; an already-full
 * moving picture plateaus immediately; a port that shows nothing plateaus at 0.
 * Bounded, and the bound only shapes the failure: the caller reports what it saw.
 */
async function waitForCoverageToSettle(
  page: Page,
  nodeId: string,
  ports: string[],
): Promise<{ settled: boolean; rounds: number; peak: number }> {
  const MAX_ROUNDS = 40;
  const STABLE_ROUNDS = 3;
  let peak = -1;
  let stable = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const samples = await samplePorts(page, nodeId, ports);
    const now = Math.max(0, ...samples.map((s) => s.nonBlack));
    if (now > peak) {
      peak = now;
      stable = 0;
    } else {
      stable += 1;
      if (stable >= STABLE_ROUNDS) return { settled: true, rounds: round, peak };
    }
  }
  return { settled: false, rounds: MAX_ROUNDS, peak };
}

async function waitForProducerRegistration(
  page: Page,
  nodeId: string,
  ports: string[],
): Promise<{ ready: boolean; waitedFrames: number }> {
  return page.evaluate(
    async ({ nodeId, ports, cap }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            getVideoSource?: (id: string, port: string) => unknown | null;
          };
        };
      };
      const hasSource = () => {
        try {
          const dom = w.__engine!().getDomain('audio');
          return ports.some((p) => {
            const s = dom.getVideoSource!(nodeId, p);
            return !!s;
          });
        } catch {
          return false;
        }
      };
      let n = 0;
      while (n < cap) {
        if (hasSource()) return { ready: true, waitedFrames: n };
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        n++;
      }
      return { ready: hasSource(), waitedFrames: n };
    },
    { nodeId, ports, cap: SOURCE_READY_CAP_FRAMES },
  );
}

/** The ports that carry a picture right now, and a printable digest. */
function livePorts(samples: PortSample[]): string[] {
  return samples.filter((s) => s.nonBlack > 0).map((s) => s.port).sort();
}
function digest(samples: PortSample[]): string {
  return samples
    .map((s) => `${s.port}: nonBlack=${s.nonBlack}/${PROBE_W * PROBE_H} maxLuma=${s.maxLuma}${s.reason ? ` (${s.reason})` : ''}`)
    .join('; ');
}

interface ChangeResult {
  changed: boolean;
  frames: number;
  elapsedMs: number;
  distinct: number;
  nonBlackMin: number;
  nonBlackMax: number;
}

/** IN-PAGE: sample one port EVERY frame until its picture CHANGES, capped in
 *  FRAMES. Exits on the event, so the cost is "frames until the producer moved"
 *  and the cap only bounds a failure. */
async function framesToChange(page: Page, nodeId: string, port: string): Promise<ChangeResult> {
  return page.evaluate(
    async ({ nodeId, port, cap, W, H, BLACK }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            getVideoSource?: (id: string, p: string) => { drawFrame?: (c: HTMLCanvasElement | OffscreenCanvas) => void } | null;
          };
        };
      };
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      const seen = new Set<number>();
      let nonBlackMin = Number.POSITIVE_INFINITY;
      let nonBlackMax = 0;
      const t0 = performance.now();
      let n = 0;
      await new Promise<void>((resolve) => {
        const tick = () => {
          n++;
          try {
            const src = w.__engine!().getDomain('audio').getVideoSource!(nodeId, port);
            ctx.clearRect(0, 0, W, H);
            src?.drawFrame?.(c);
          } catch { /* handle briefly absent — records as a black frame */ }
          const d = ctx.getImageData(0, 0, W, H).data;
          let nonBlack = 0;
          let hash = 2166136261;
          for (let i = 0; i < d.length; i += 4) {
            const l = (d[i]! * 77 + d[i + 1]! * 151 + d[i + 2]! * 28) >> 8;
            if (l > BLACK) nonBlack++;
            hash = Math.imul(hash ^ d[i]!, 16777619);
            hash = Math.imul(hash ^ d[i + 1]!, 16777619);
            hash = Math.imul(hash ^ d[i + 2]!, 16777619);
          }
          if (nonBlack < nonBlackMin) nonBlackMin = nonBlack;
          if (nonBlack > nonBlackMax) nonBlackMax = nonBlack;
          seen.add(hash >>> 0);
          if (seen.size > 1 || n >= cap) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return {
        changed: seen.size > 1,
        frames: n,
        elapsedMs: Math.round(performance.now() - t0),
        distinct: seen.size,
        nonBlackMin: nonBlackMin === Number.POSITIVE_INFINITY ? 0 : nonBlackMin,
        nonBlackMax,
      };
    },
    { nodeId, port, cap: CHANGE_CAP_FRAMES, W: PROBE_W, H: PROBE_H, BLACK: BLACK_LUMA },
  );
}

function fmtChange(r: ChangeResult): string {
  return (
    `changed=${r.changed} after ${r.frames} rAF frames (${r.elapsedMs} ms wall, cap ${CHANGE_CAP_FRAMES} frames), ` +
    `distinct signatures=${r.distinct}, nonBlack px (of ${PROBE_W * PROBE_H}) min=${r.nonBlackMin} max=${r.nonBlackMax}`
  );
}

/** IN-PAGE: sample one port EVERY frame for a fixed window, so a transient gap
 *  is MEASURED. Started before the collapse click and awaited after it, so the
 *  handoff happens inside the sampling window. */
async function probeEveryFrame(page: Page, nodeId: string, port: string) {
  return page.evaluate(
    async ({ nodeId, port, frames, W, H, BLACK }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            getVideoSource?: (i: string, p: string) => { drawFrame?: (c: HTMLCanvasElement | OffscreenCanvas) => void } | null;
          };
        };
      };
      const series: number[] = [];
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      const t0 = performance.now();
      let n = 0;
      await new Promise<void>((resolve) => {
        const tick = () => {
          n++;
          let nonBlack = 0;
          try {
            const src = w.__engine!().getDomain('audio').getVideoSource!(nodeId, port);
            ctx.clearRect(0, 0, W, H);
            if (src?.drawFrame) {
              src.drawFrame(c);
              const d = ctx.getImageData(0, 0, W, H).data;
              for (let i = 0; i < d.length; i += 4) {
                const l = (d[i]! * 77 + d[i + 1]! * 151 + d[i + 2]! * 28) >> 8;
                if (l > BLACK) nonBlack++;
              }
            }
          } catch { /* handle briefly absent — records as a black frame */ }
          series.push(nonBlack);
          if (n >= frames) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      let longest = 0;
      let run = 0;
      let black = 0;
      for (const v of series) {
        if (v === 0) { run++; black++; if (run > longest) longest = run; } else run = 0;
      }
      return {
        frames: n,
        elapsedMs: Math.round(performance.now() - t0),
        blackFrames: black,
        longestBlackRun: longest,
        series,
      };
    },
    { nodeId, port, frames: HANDOFF_FRAMES, W: PROBE_W, H: PROBE_H, BLACK: BLACK_LUMA },
  );
}

/** Where the node's REAL card is mounted right now, and how many times. */
async function cardMounts(page: Page, nodeId: string): Promise<{ headless: number; dock: number }> {
  return page.evaluate((id) => ({
    headless: document.querySelectorAll(`[data-testid="headless-source-host"][data-node-id="${id}"]`).length,
    dock: document.querySelectorAll('[data-testid="dock-full-view"]').length,
  }), nodeId);
}

/**
 * How many xyflow nodes the MAIN LANE renders for this node id.
 *
 * ⚠ THE EXCLUSION IS THE WHOLE POINT. Both off-lane hosts mount the card inside
 * their own single-node `<SvelteFlow>`, tagged with the SAME `data-id` — so a
 * bare `.svelte-flow__node[data-id=…]` count reads 2 for a shell-swapped
 * producer and cannot distinguish "the lane shows it" from "a host holds it",
 * which is exactly the distinction every assertion below turns on.
 */
async function laneNodeCount(page: Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => {
    const all = [...document.querySelectorAll(`.svelte-flow__node[data-id="${id}"]`)];
    return all.filter(
      (el) => !el.closest('[data-testid="headless-source-host"], [data-testid="viz-hidden-mount"]'),
    ).length;
  }, nodeId);
}

/** Is the module's engine handle still publishing this video source? */
async function hasVideoSource(page: Page, nodeId: string, port: string): Promise<boolean> {
  return page.evaluate(({ id, p }) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { getVideoSource?: (i: string, p: string) => unknown } };
    };
    try { return !!w.__engine!().getDomain('audio').getVideoSource!(id, p); } catch { return false; }
  }, { id: nodeId, p: port });
}

async function boot(page: Page): Promise<void> {
  // Plain /rack — the shipping faceplate shell, which is the whole point of the
  // #1587 legs: with the module's own surface pinned in the lane the shell-swap
  // bug is invisible.
  //
  // ⚠ THIS FUNCTION TOOK A `shell` ARGUMENT AND NO CALLER PASSED ONE. Its other
  // value selected a second renderer that no longer exists, so the parameter
  // and its type went with the arm.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
}

for (const subject of SUBJECTS) {
  const { type, domain, videoOuts, laneTestId, migrated, keepsHeadlessWhileDocked } = subject;
  const nodeId = `producer-${type}`;

  test(`${type}: its card is kept alive off-screen when the shell swaps the lane card away`, async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 120_000 : 60_000);
    await boot(page);
    await spawnPatch(page, [{ id: nodeId, type, domain }], [], { mountTimeout: 30_000 });

    // The lane shows the SHELL's tile — the uniform placeholder for an
    // un-migrated module, the curated face for a migrated one — i.e. its real
    // card is NOT in the lane…
    //
    // ⚠ A MIGRATED FACE IS NOT EVIDENCE THE PRODUCER IS MOUNTED, and CUBE is the
    // case that proves it (#1724). `curatedFace` drops `face.hero.cell` from the
    // lane order (PF-22 `laneOrder`: a 280px panel cannot paint in a 46px knob
    // column) and cube's hero cell IS its renderer, so the lane tile mounts no
    // surface at all. The claim is identical for both kinds.
    await expect(
      page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="${laneTestId}"]`),
    ).toHaveCount(1, { timeout: 20_000 });

    // …and the headless host is holding it, exactly once. This leg carries the
    // whole claim for a producer whose output is not a picture (SYNESTHESIA
    // writes per-band levels to its AUDIO outs), so no subject is uncovered.
    await expect
      .poll(async () => (await cardMounts(page, nodeId)).headless, {
        message: `${type}'s real card must be mounted in <HeadlessSourceHost> exactly once`,
        timeout: 20_000,
      })
      .toBe(1);
  });

  if (videoOuts.length === 0) continue;

  test(`${type}: live picture with the card NEVER expanded, across expand → collapse → delete`, async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 240_000 : 120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    const canvasesBefore = await page.evaluate(() => document.querySelectorAll('canvas').length);

    // The owner's rack: the producer patched straight into the video monitor.
    await spawnPatch(
      page,
      [
        { id: nodeId, type, domain },
        { id: 'producer-out', type: 'videoOut', domain: 'video' },
      ],
      [
        {
          id: 'producer-edge',
          from: { nodeId, portId: videoOuts[0]! },
          to: { nodeId: 'producer-out', portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
      { mountTimeout: 30_000 },
    );

    // ── 1. NEVER MOUNTED — nothing has been expanded, clicked or docked ──────
    // Readiness first (#1620): sampling before the headless producer BOOTS
    // reads "no source" for the whole 5-frame window and calls a loaded
    // machine a regression. Bounded; the failure message carries the wait.
    const neverReady = await waitForProducerRegistration(page, nodeId, videoOuts);
    // ...and then wait for COVERAGE to establish, so this phase is compared
    // against phase 2 at the same raster age rather than at a younger one.
    const neverSettle = await waitForCoverageToSettle(page, nodeId, videoOuts);
    const neverSamples = await samplePorts(page, nodeId, videoOuts);
    const liveNever = livePorts(neverSamples);

    // ── 2. POSITIVE CONTROL — the identical probe while the card IS mounted ──
    // Permanent, and it is also the regression guard for the dock mount itself,
    // which THREW (bare useStore outside the SvelteFlow provider) and rendered
    // nothing at all — the reason the issue's own expanded/collapsed readings
    // were identical.
    await page.evaluate((id) => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id);
    }, nodeId);
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 30_000 });
    // Exactly ONE surface runs the producer while the dock holds this node, so
    // two GL contexts / two producers never race. WHERE that surface lives is a
    // property of the module (see `keepsHeadlessWhileDocked`), so the expected
    // headless count is DERIVED rather than the constant 0 this asserted before
    // the 2026-08-23 default inversion — a constant that was RIGHT for the two
    // producers promoted at the time and silently wrong for every one promoted
    // after, which is how it came to fail for scope and timelorde.
    const expectedHeadless = keepsHeadlessWhileDocked ? 1 : 0;
    expect(
      await cardMounts(page, nodeId),
      `${type} must have EXACTLY ONE surface running its producer while its dock full view is ` +
        `open. It is ${keepsHeadlessWhileDocked ? '' : 'NOT '}a module that keeps its headless ` +
        `host while docked (migrated=${migrated}), so the headless host must be ` +
        `${expectedHeadless}: ${keepsHeadlessWhileDocked
          ? 'its face only BLITS, so unmounting the card would leave a stale or black picture'
          : 'either the dock holds the real card, or the face mounts the producing surface itself'}`,
    ).toEqual({ headless: expectedHeadless, dock: 1 });
    // The SAME port list in both states — the set comparison below is only
    // meaningful if the probe looked at the same thing twice.
    // Same readiness gate as phase 1 — both phases stay the same instrument.
    await waitForProducerRegistration(page, nodeId, videoOuts);
    const mountedSettle = await waitForCoverageToSettle(page, nodeId, videoOuts);
    const mountedSamples = await samplePorts(page, nodeId, videoOuts);
    const liveMounted = livePorts(mountedSamples);

    // THE CAUSAL CLAIM, both directions: a port lights up when the card is
    // mounted IF AND ONLY IF it lights up when the card was never mounted.
    // Before the fix WAVESCULPT read `[]` never-mounted and `['video_out']`
    // mounted; that inequality IS the bug.
    expect(
      liveNever,
      `#1587: the ports carrying a picture must be the same whether or not ${type}'s card is ` +
        `mounted.\n  never-mounted: ${digest(neverSamples)} (producer ready=${neverReady.ready} ` +
        `after ${neverReady.waitedFrames} frames, cap ${SOURCE_READY_CAP_FRAMES}; coverage ` +
        `settled=${neverSettle.settled} in ${neverSettle.rounds} rounds at peak ${neverSettle.peak})` +
        `\n  card mounted:  ${digest(mountedSamples)} (coverage settled=${mountedSettle.settled} ` +
        `in ${mountedSettle.rounds} rounds at peak ${mountedSettle.peak})` +
        '\n  ⚠ if the two coverage peaks differ but both settled, the pictures genuinely differ; ' +
        'if either did NOT settle, this comparison is between two moving targets.',
    ).toEqual(liveMounted);

    // A subject whose ports show nothing even WITH the card mounted is not
    // carrying pixel coverage here — SYNESTHESIA's per-band rasters need a video
    // source patched in before they render anything. Skip LOUDLY, and only
    // AFTER the dock-mount assertions above, so a broken mount fails rather
    // than quietly turning into a skip.
    test.skip(
      liveMounted.length === 0,
      `${type} shows no picture on any video output even with its card mounted, so there is ` +
        `nothing here to lose: ${digest(mountedSamples)}. Its producer lifetime is covered by ` +
        'the headless-mount test above and by dom-source-modules.test.ts.',
    );

    // ...and a subject whose picture is FROZEN even WITH the card mounted has
    // no card-driven motion to lose either. "Did it move" is then a property of
    // the SUBJECT AT REST, not evidence about the producer.
    //
    // SCOPE and RASTERIZE are that shape (#1664). They joined this set for the
    // LIFETIME half of the rule — their card pushes `write(node,'cvCombined')`,
    // which is the only way a SAME-DOMAIN cv cable reaches a DISPLAY param —
    // but they render their picture inside the MODULE from its own analysers,
    // so an idle rack draws a static grid (measured: nonBlack 3072/3072,
    // 1 distinct signature over 300 frames) whether or not any card exists. The
    // card only refines WHICH display params that picture is drawn with.
    //
    // Measured WHILE MOUNTED, so this cannot be satisfied by the very
    // regression the movement leg exists to catch: TIMELORDE's stale-bitmap
    // shape still MOVES when mounted, so it is never skipped here.
    // ⚠ The residual, stated: a producer that died in BOTH states reads frozen
    // here and is skipped — the same hole the `liveMounted.length === 0` skip
    // above already has, and covered by the headless-mount test and by
    // dom-source-modules.test.ts rather than by this leg.
    //
    // ⚠ #1724 — THIS SKIPS THE MOVEMENT LEGS, NOT THE TEST. It used to be a
    // `test.skip()`, which aborted the whole case and therefore silently dropped
    // phases 3 (COLLAPSE CONTINUITY) and 4 (DELETE) for every static subject.
    // That cost real coverage the moment cube joined: cube's viz is PARAM-driven
    // (rotation is `view_rot_*`, not a clock) so it reads `distinct=1 over 300
    // frames` even mounted — and "does the picture come back after a collapse or
    // an LRU eviction" is exactly the question its issue was about. Motion is one
    // CLAIM, not the test's precondition; the two claims are now scoped
    // independently, and the reason is recorded as a loud annotation so a reader
    // of the report sees which leg stood down and why.
    const mountedMotion = await framesToChange(page, nodeId, liveMounted[0]!);
    const motionIsEvidence = mountedMotion.changed;
    if (!motionIsEvidence) {
      test.info().annotations.push({
        type: 'movement-leg-stood-down',
        description:
          `${type} renders a STATIC picture even with its card mounted on ${liveMounted[0]} ` +
          `(${fmtChange(mountedMotion)}), so "did it move" is a property of the SUBJECT AT REST ` +
          'and not evidence about the producer. The causal leg above (which ports carry a ' +
          'picture, mounted vs never-mounted) and phases 3+4 below still ran.',
      });
    }

    // MOVEMENT, on the state that matters. "Not black" alone is not enough for
    // TIMELORDE: its drawFrame keeps blitting the last bitmap the card ever
    // pushed, so a dead producer can read non-black forever.
    for (const port of motionIsEvidence ? liveNever : []) {
      const moved = await framesToChange(page, nodeId, port);
      expect(
        moved.changed,
        `#1587: ${type}.${port} must emit a MOVING picture — a frozen surface is exactly how ` +
          `the issue's own probe read a dead producer as a live one. ${fmtChange(moved)}`,
      ).toBe(true);
    }

    // ── 3. CONTINUITY — collapse, sampling EVERY frame across the handoff ────
    // The card MOVES from the dock back to the headless host, which for
    // WAVESCULPT re-runs initGl(). Measure the gap instead of assuming it away.
    const witness = liveNever[0]!;
    const pending = probeEveryFrame(page, nodeId, witness);
    await page.getByTestId('faceplate-collapse').first().click();
    const handoff = await pending;
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, { timeout: 20_000 });
    expect(
      handoff.longestBlackRun,
      `${type}.${witness} lost its picture across the dock→headless handoff for ` +
        `${handoff.longestBlackRun} consecutive frames (of ${handoff.frames} sampled, ` +
        `${handoff.blackFrames} black in total, ${handoff.elapsedMs} ms wall). ` +
        `Series (nonBlack px/frame): ${handoff.series.join(',')}`,
    ).toBeLessThan(MAX_BLACK_RUN_FRAMES);

    await expect
      .poll(async () => (await cardMounts(page, nodeId)).headless, {
        message: 'the headless host takes the card back when the full-view closes',
        timeout: 20_000,
      })
      .toBe(1);
    await waitForProducerRegistration(page, nodeId, videoOuts);
    const afterSamples = await samplePorts(page, nodeId, videoOuts);
    expect(
      livePorts(afterSamples),
      `${type} must still carry the same picture after the collapse: ${digest(afterSamples)}`,
    ).toEqual(liveNever);
    for (const port of motionIsEvidence ? liveNever : []) {
      const moved = await framesToChange(page, nodeId, port);
      expect(
        moved.changed,
        `${type}.${port} must still emit a MOVING picture after the collapse — a frozen last ` +
          `frame is what a producer that never restarted looks like. ${fmtChange(moved)}`,
      ).toBe(true);
    }

    // ── 4. DELETE — the node leaves the graph, the card goes with it ─────────
    // The card's onDestroy is what releases the GL context (disposeGl) and its
    // frame drawer, so what this asserts is that the card really did unmount
    // and the module handle really did go with the node.
    await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const [eid, e] of Object.entries(w.__patch.edges)) {
          const edge = e as { source?: { nodeId?: string }; target?: { nodeId?: string } } | undefined;
          if (edge?.source?.nodeId === id || edge?.target?.nodeId === id) delete w.__patch.edges[eid];
        }
        delete w.__patch.nodes[id];
      });
    }, nodeId);

    await expect
      .poll(async () => (await cardMounts(page, nodeId)).headless, {
        message:
          `${type}'s card must be unmounted from every host when its node is deleted ` +
          '(that unmount is what runs disposeGl + drops the frame drawer)',
        timeout: 20_000,
      })
      .toBe(0);
    await expect
      .poll(async () => hasVideoSource(page, nodeId, witness), {
        message: `${type}'s engine handle must be gone after the node is deleted`,
        timeout: 20_000,
      })
      .toBe(false);
    // No detached card canvas left behind in the document.
    await expect
      .poll(async () => page.evaluate(() => document.querySelectorAll('canvas').length), {
        message: `canvas count must return to the pre-spawn baseline (${canvasesBefore})`,
        timeout: 20_000,
      })
      .toBeLessThanOrEqual(canvasesBefore);

    // The dock mount used to throw a provider error and render nothing; nothing
    // in this whole flow may raise one.
    const providerErrors = errors.filter((e) => /useStore|SvelteFlowProvider/i.test(e));
    expect(providerErrors, `provider throw(s) during the lifecycle: ${providerErrors.join(' | ')}`).toEqual([]);
  });

  // ── #1721 — THE GROUP-COLLAPSE LEG IS DELETED WITH ITS SUBJECT ────────────
  //
  // This block ran every CARD_PRODUCER through "wrapped in a COLLAPSED GROUP,
  // in BOTH renderers" and asserted the module kept its picture, that its
  // surface was mounted EXACTLY ONCE across every host that could hold it, and
  // that an expand put the child back in the lane. Its trigger was Canvas's
  // `flowNodes` derivation dropping a collapsed group's children BEFORE the
  // lane decision ran — the one member of the #1583 family that was not
  // specific to one renderer, which is why the second one was a real subject
  // here.
  //
  // The GROUP! module is deleted (owner ruling: group and sticky are deleted
  // entirely), so `collapsedGroupIds` and the `parentGroupId` lane filter are
  // gone with it and there is no longer any way for a producer to be dropped
  // from the lane by grouping. The leg is not re-pointed anywhere: its subject
  // is the mechanism, not the modules.
  //
  // ⚠ NAMED COVERAGE LOSS, stated rather than absorbed. What went with it is the
  // DOUBLE-MOUNT half — `GroupCard` hidden-mounting a viz-passthrough child's
  // real card (SCOPE, via $lib/ui/modules/group-viz-hosts) while
  // `<HeadlessSourceHost>` also held it. That host is deleted too, so the
  // hazard is gone by construction rather than merely untested; the surviving
  // single-host claim is still made by the `laneOmitsNode` legs above and by
  // `timelorde-pinned-source.spec.ts` for the canvas-hidden arm.
}

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER HALF: producers the NODE owns (legacy-removal S1)
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ WHY THIS LIVES IN THIS FILE AND NOT A NEW ONE. Everything above is derived
// from `CARD_PRODUCER_LANE_TYPES`, so a module LEAVING that set does not turn a
// test red — it removes four of them, silently, and the lane stays green with
// less coverage than it had. That is the "a control over a population that
// reaches zero stops controlling anything" shape this repo keeps meeting, and
// the answer it keeps reaching is to re-point the control rather than to let the
// subject evaporate. These subjects are the SAME modules, measured with the SAME
// instruments, making the OPPOSITE claim: no card anywhere, no host anywhere,
// and the producer still running.
//
// (It also keeps the CI lane: the filename decides which job a spec runs in, and
// `**/card-producer-lifetime.spec.ts` is on the webgl-heavy list. A new file
// would have needed a glob edit to run at all.)
//
// ⚠ AND THE LIVENESS PROBE IS NOT PIXELS FOR THESE, WHICH IS THE POINT. The
// legs above measure a picture MOVING, and record that SCOPE is structurally
// invisible to that instrument: its trace is drawn inside the module from its
// own analysers, so it reads `distinct=1 over 300 frames` even with a card
// mounted (an idle rack draws a static grid). Its producer writes DISPLAY
// PARAMS, not pixels — so the honest progress assertion is the one that reads
// the channel that actually moved: patch a modulator at a display param and
// require the module's own `drawParams` to follow it, with no card in the
// document. A dead producer leaves that number pinned at the knob forever.

/** The node-lifetime producers, parsed from their own source.
 *
 *  ⚠ ANCHORED ON `= [`, NOT ON THE FIRST `[` — the sibling parser's
 *  `[^[]*\[` idiom is wrong here for the reason `extras-producer-lifetime`
 *  records: the type annotation is `readonly FrameProducer[]`, so `[^[]*` stops
 *  at the annotation's own bracket pair and the capture comes back EMPTY. */
const FRAME_PRODUCERS_SRC = readFileSync(
  fileURLToPath(
    new URL('../../packages/web/src/lib/ui/media/frame-producers.ts', import.meta.url),
  ),
  'utf8',
);

function nodeFrameProducerTypes(): string[] {
  const declared = [
    ...FRAME_PRODUCERS_SRC.matchAll(
      /const\s+(\w+):\s*FrameProducer\s*=\s*\{\s*\n\s*type:\s*'([^']+)'/g,
    ),
  ].map((m) => ({ constName: m[1]!, type: m[2]! }));
  const arr = /export const FRAME_PRODUCERS[^=]*=\s*\[([\s\S]*?)\]/.exec(FRAME_PRODUCERS_SRC);
  if (!arr) throw new Error('could not parse FRAME_PRODUCERS — has the shape changed?');
  const registered = new Set(
    [...arr[1]!.matchAll(/(\w+)/g)].map((m) => m[1]!).filter((n) => n.endsWith('PRODUCER')),
  );
  // BOTH DIRECTIONS, because each hides a different real hole: a producer
  // DECLARED but never registered never runs (and nothing else would notice); a
  // name registered with no declaration means this parse missed one and the
  // subject list is short.
  const orphan = declared.filter((d) => !registered.has(d.constName)).map((d) => d.constName);
  if (orphan.length > 0) {
    throw new Error(`FrameProducer(s) declared but NOT in FRAME_PRODUCERS: ${orphan.join(', ')}`);
  }
  const missing = [...registered].filter((n) => !declared.some((d) => d.constName === n));
  if (missing.length > 0) {
    throw new Error(`FRAME_PRODUCERS names with no declaration parsed: ${missing.join(', ')}`);
  }
  if (declared.length === 0) {
    throw new Error('FRAME_PRODUCERS parsed EMPTY — refusing to pass vacuously');
  }
  return declared.map((d) => d.type);
}

/**
 * How a given producer is DRIVEN and what number must move because of it.
 *
 * DENY BY DEFAULT: a producer with no fixture throws at collection, so adding
 * one to `frame-producers.ts` without saying how to observe it cannot land
 * silently green. The same discipline `extras-producer-lifetime.spec.ts` uses.
 */
interface FrameProducerFixture {
  /** Extra nodes to spawn beside the subject. Omitted when the module drives
   *  ITSELF — timelorde's owl pulses off its own transport. */
  readonly driver?: { id: string; type: string; domain: 'audio' | 'video' | 'meta' };
  /** Params the SUBJECT needs for its producer to have anything to do. */
  readonly params?: Record<string, number>;
  /** The edge that makes the subject's producer have something to report.
   *  Present exactly when `driver` is. */
  readonly edge?: { fromPort: string; toPort: string; sourceType: string; targetType: string };
  /**
   * THE PROGRESS PROBE — exactly one of these two, and which one is a fact about
   * the module rather than a preference.
   *
   * `read` — `engine.read(node, key)` → a record; `field` (optionally indexed)
   * is the number that must move. For producers whose output is NOT a picture:
   * scope pushes display PARAMS, synesthesia pushes channel LEVELS, and this
   * page's own pixel instrument is documented as blind to both.
   *
   * `pixelPort` — the module's own video output, measured with `framesToChange`
   * (distinct frame signatures, exiting on the first change). For a producer
   * whose product IS the picture, that is the honest probe and a number would
   * be a proxy for it.
   */
  readonly read?: { key: string; field: string; index?: number };
  readonly pixelPort?: string;
  /**
   * Params that must make the picture GO STILL — the negative control for a
   * `pixelPort` probe, and the module's own semantics rather than a trick:
   * timelorde's owl pulses off the transport, so stopping the transport is the
   * one state where a live producer legitimately stops moving.
   */
  readonly stillWhen?: Record<string, number>;
  /**
   * Does the channel return to the KNOB when the cable is pulled?
   *
   * ⚠ NOT UNIVERSAL, AND THE DIFFERENCE IS THE MODULE'S SEMANTICS RATHER THAN
   * A TEST DETAIL. `cvCombined` is an OVERRIDE of a knob, so an un-patched
   * param must come back to that knob or it has latched. `video_levels_*` is a
   * SAMPLE-AND-HOLD into a worklet: with nothing patched the producer pushes
   * NOTHING (which is correct — "no source" must not be reported as zeros), so
   * the held value staying put is the specified behaviour, not a latch.
   */
  readonly unlatchesToKnob?: true;
  /** Why this is the channel the producer actually owns. */
  readonly why: string;
}

const FRAME_PRODUCER_FIXTURES: Record<string, FrameProducerFixture> = {
  foxy: {
    // ⚠ NO DRIVER, AND THE PRODUCT IS NOT A PICTURE. FOXY's three rasters are
    // painted by the module's own SWOLEVCO oscillators, so the subject drives
    // itself; what the producer owns is the WAVETABLE those rasters are folded
    // into, which the internal `wavecel` worklet then PLAYS. So the probe reads
    // a sample out of the live table rather than any of the module's three video
    // outs — and that is the honest choice, not a convenience: `scope_out`,
    // `wave3d_out` and `combined_out` all render from the last table anyone
    // built, so a dead producer would keep serving a picture (the timelorde
    // failure mode: bright and frozen) while the module went SILENT.
    read: { key: 'wavetableFrames', field: '0', index: 8 },
    why:
      "the module's audio IS this table: `bridgeTick()` paints the rasters, folds them into the "
      + '3-axis field and posts a rebuilt wavetable to the worklet, and nothing else calls it. '
      + 'The only reachable caller used to be a preview-drawing surface reading its rasters, so '
      + 'the sound had a component lifetime — MEASURED at the moment it was found, FOXY -> SCOPE.ch1 '
      + 'on one patch: maxPeak 1.0000 with that surface mounted and 0.0000 without it, over '
      + 'a 6 s window. A sample of the table moving frame to frame is the closest observable to '
      + '"the oscillator has something new to play"; the pixel probe cannot see it.',
  },
  scope: {
    driver: { id: 'producer-driver', type: 'lfo', domain: 'audio' },
    edge: {
      fromPort: 'phase0',
      toPort: 'ch1Offset',
      sourceType: 'cv',
      targetType: 'cv',
    },
    read: { key: 'drawParams', field: 'ch1Offset' },
    unlatchesToKnob: true,
    why:
      'the producer reads `readParam` (knob PLUS the engine per-port CV tap) and pushes the ' +
      'combined record back through cvCombined — the ONLY path a same-domain cv cable has to a ' +
      'display param, because addEdge connects to the AudioParam and never calls setParam. ' +
      '`read("drawParams")` is the inverse of that push and is what the module\'s own drawFrame ' +
      'renders `out` from, so a number that follows the LFO proves the whole chain end to end.',
  },
  synesthesia: {
    // A SELF-RUNNING video source, so the frame keeps changing without anything
    // in this test driving it — the same driver `synesthesia-video-mode.spec.ts`
    // uses for the same reason.
    driver: { id: 'producer-driver', type: 'acidwarp', domain: 'video' },
    // Copy A in VIDEO mode. Without it the producer correctly does nothing —
    // in AUDIO mode the worklet's own spectral bands are the levels.
    params: { a_mode: 1 },
    edge: { fromPort: 'out', toPort: 'a_video_in', sourceType: 'video', targetType: 'video' },
    read: { key: 'snapshot', field: 'levelsA', index: 0 },
    why:
      'in VIDEO mode the four lanes ARE the patched frame\'s R/G/B/Luma channels, and only the ' +
      'main thread can sample a frame — the worklet has no canvas. The producer resolves the ' +
      'upstream source, blits one frame into a 64×48 scratch, averages it and hands the numbers ' +
      'to the worklet, which sample-and-holds them through the env/gate/meter stage. ' +
      '`read("snapshot").levelsA` is what comes back out, and it is what all 48 of this ' +
      'module\'s outputs carry in that mode.',
  },
  rasterize: {
    driver: { id: 'producer-driver', type: 'lfo', domain: 'audio' },
    edge: {
      fromPort: 'phase0',
      toPort: 'cursor',
      sourceType: 'cv',
      targetType: 'cv',
    },
    read: { key: 'drawParams', field: 'cursor' },
    unlatchesToKnob: true,
    why:
      'scope\'s seam on a different module, plus the module\'s own heartbeat: the painter is ' +
      "advanced INSIDE read('imageData') and the bridge only pulls drawFrame when a downstream " +
      'video edge exists, so the producer both pushes cvCombined (the only path a same-domain ' +
      'cv cable has to the picture) and reads the frame (the only advance when nothing is ' +
      "patched downstream). `read('drawParams')` is the inverse of the push — the combined " +
      'values the painter actually draws with — so a number that follows the LFO proves the ' +
      'chain with no surface mounted anywhere. ⚠ The obvious pixel probe is BLIND here by ' +
      'construction: sampling the video out calls drawFrame, which itself advances the painter, ' +
      'so a dead producer would still show a moving picture to the instrument that asks.',
  },
  timelorde: {
    // ⚠ NO DRIVER, AND THAT IS THE MODULE. The owl's eyes and border pulse off
    // TIMELORDE's own transport at its own BPM, so the subject drives itself and
    // a patched source would only replace the picture under test.
    params: { running: 1, bpm: 120 },
    pixelPort: 'video_out',
    // The transport is the switch: `beatPulse` returns a flat 0 when `running`
    // is 0, so a stopped clock is the one state in which a LIVE producer is
    // legitimately still. That makes it a negative control the module itself
    // defines rather than one the test invents.
    stillWhen: { running: 0 },
    why:
      'the composite is pushed into the node and `video_out`\'s own drawFrame blits the LATEST ' +
      'one, so this port IS the producer\'s product. And "not black" cannot judge it: drawFrame ' +
      'keeps serving the last bitmap anyone pushed, so a dead producer reads BRIGHT and FROZEN ' +
      '(measured: nonBlack 47034/48400 from a card that was already gone). Only motion can tell ' +
      'a live producer from a stale leftover.',
  },
};

/** Every mount of this node's REAL card, anywhere in the document. */
async function anyCardMounts(page: Page, nodeId: string, type: string): Promise<number> {
  return page.evaluate(({ id, t }) => {
    const inHosts = document.querySelectorAll(
      `[data-testid="headless-source-host"][data-node-id="${id}"], ` +
        `[data-testid="viz-hidden-mount"][data-child-id="${id}"]`,
    ).length;
    const cards = document.querySelectorAll(`[data-testid="${t}-card"], .mod-card.${t}-card`).length;
    return inHosts + cards;
  }, { id: nodeId, t: type });
}

/** Sample `read(node, key)[field]` (or `[field][index]`) once per rAF frame, in
 *  the page, and report how many DISTINCT values were seen. One evaluate, never
 *  a Playwright poll — a poll would starve the very loop it is measuring. */
async function sampleProducerChannel(
  page: Page,
  nodeId: string,
  read: { key: string; field: string; index?: number },
  frames: number,
): Promise<{ frames: number; distinct: number; first: number | null; values: number[] }> {
  return page.evaluate(
    async ({ id, key, field, index, n }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } };
        __patch: { nodes: Record<string, unknown> };
      };
      const seen: number[] = [];
      const next = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      for (let i = 0; i < n; i++) {
        let v: number | null = null;
        try {
          const rec = w.__engine!().getDomain('audio').read(id, key) as
            | Record<string, unknown>
            | undefined;
          const slot = rec?.[field];
          const raw =
            index === undefined
              ? slot
              : (slot as ArrayLike<number> | undefined)?.[index];
          if (typeof raw === 'number' && Number.isFinite(raw)) v = raw;
        } catch {
          /* engine not ready — recorded as a gap, never as a value */
        }
        if (v !== null) seen.push(v);
        await next();
      }
      return {
        frames: n,
        distinct: new Set(seen.map((x) => Math.round(x * 1e4))).size,
        first: seen.length > 0 ? seen[0]! : null,
        values: seen.slice(0, 12),
      };
    },
    { id: nodeId, key: read.key, field: read.field, index: read.index, n: frames },
  );
}

const CHANNEL_FRAMES = 90;

for (const type of nodeFrameProducerTypes()) {
  const fixture = FRAME_PRODUCER_FIXTURES[type];
  if (!fixture) {
    throw new Error(
      `${type} is a node-lifetime FrameProducer with no fixture in this spec. Add one saying ` +
        'how it is DRIVEN and which number must move — a producer nothing observes is a producer ' +
        'that can stop running without any gate noticing.',
    );
  }
  // Deny-by-default on the FIXTURE'S OWN SHAPE, too: exactly one progress probe,
  // and a driver iff there is an edge for it. A fixture that declared neither
  // probe would run every structural leg below and observe nothing at all.
  if ((fixture.read === undefined) === (fixture.pixelPort === undefined)) {
    throw new Error(`${type}: a fixture declares EXACTLY ONE of \`read\` or \`pixelPort\``);
  }
  if ((fixture.driver === undefined) !== (fixture.edge === undefined)) {
    throw new Error(`${type}: \`driver\` and \`edge\` are declared together or not at all`);
  }
  if (fixture.pixelPort !== undefined && fixture.stillWhen === undefined) {
    throw new Error(
      `${type}: a \`pixelPort\` probe needs a \`stillWhen\` — a movement claim with no state ` +
        'that stops the movement cannot tell a producer from a noisy instrument',
    );
  }
  const mod = REGISTRY.find((m) => m.type === type);
  if (!mod) throw new Error(`${type} has a node producer but is not in the registry manifest`);
  const nodeId = `nodeproducer-${type}`;

  test(`${type}: the producer runs with NO card mounted anywhere — no host, no lane card, no dock`, async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 180_000 : 90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    await spawnPatch(
      page,
      [
        { id: nodeId, type, domain: mod.domain, ...(fixture.params ? { params: fixture.params } : {}) },
        ...(fixture.driver ? [fixture.driver] : []),
      ],
      fixture.driver && fixture.edge
        ? [
            {
              id: 'nodeproducer-edge',
              from: { nodeId: fixture.driver.id, portId: fixture.edge.fromPort },
              to: { nodeId, portId: fixture.edge.toPort },
              sourceType: fixture.edge.sourceType,
              targetType: fixture.edge.targetType,
            },
          ]
        : [],
      { mountTimeout: 30_000 },
    );

    // The lane shows the shell's tile for a faced module…
    await expect(
      page.locator(
        `.svelte-flow__node[data-id="${nodeId}"] [data-testid="${
          'module-shell'
        }"]`,
      ),
    ).toHaveCount(1, { timeout: 20_000 });

    // …and its REAL card is nowhere: not in the lane, not in a headless host,
    // not in a group's hidden mount, not in the dock. THIS is the claim the
    // card-producer legs above make in reverse, and it is the one that lets the
    // file be deleted in S4.
    await expect
      .poll(async () => anyCardMounts(page, nodeId, type), {
        message:
          `${type}'s card must not be mounted ANYWHERE — its producer is node-lifetime ` +
          '($lib/ui/media/frame-producers), so a card mount would be a second owner',
        timeout: 20_000,
      })
      .toBe(0);

    // ⚠ THE PROGRESS LEG. Everything above is satisfiable by a producer that is
    // registered, swept, counted and completely silent — which is exactly the
    // failure shape the archivist extraction shipped, where every assertion
    // about state was green while the media made no progress at all.
    if (fixture.pixelPort) {
      // THE PICTURE ITSELF, with `framesToChange` — the same instrument the
      // card-producer legs above use, exiting on the first CHANGED frame with a
      // frame cap that only bounds the failure. "Not black" is refused on
      // purpose here: this module's drawFrame keeps blitting the last bitmap
      // anyone pushed, so a dead producer reads bright and frozen.
      const moved = await framesToChange(page, nodeId, fixture.pixelPort);
      expect(
        moved.changed,
        `${type}.${fixture.pixelPort} must emit a MOVING picture with no card anywhere. ` +
          `${fixture.why}\n  ${fmtChange(moved)}`,
      ).toBe(true);

      // NEGATIVE CONTROL on the instrument, defined by the MODULE: the state in
      // which a live producer legitimately stops moving. Without it, a probe
      // that reported change for any reason at all would pass the leg above on a
      // producer that was never running.
      await page.evaluate(({ id, params }) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params?: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes[id];
          if (!n) throw new Error(`stillWhen: no node ${id}`);
          if (!n.params) n.params = {};
          for (const [k, v] of Object.entries(params)) n.params[k] = v;
        });
      }, { id: nodeId, params: fixture.stillWhen! });
      await expect
        .poll(async () => (await framesToChange(page, nodeId, fixture.pixelPort!)).changed, {
          message:
            `${type}: in the state that must STOP the picture ` +
            `(${JSON.stringify(fixture.stillWhen)}) the same probe still reports motion — a ` +
            'picture that moves whatever the module is doing cannot be evidence that the ' +
            'producer is running',
          timeout: 30_000,
        })
        .toBe(false);
    } else {
      const read = fixture.read!;
      const driven = await sampleProducerChannel(page, nodeId, read, CHANNEL_FRAMES);
      expect(
        driven.distinct,
        `${type}: ${read.key}.${read.field} must FOLLOW the patched modulator with ` +
          `no card anywhere. ${fixture.why}\n  saw ${driven.distinct} distinct value(s) over ` +
          `${driven.frames} frames; first ${driven.first}; sample ${driven.values.join(', ')}`,
      ).toBeGreaterThan(1);

      // NEGATIVE CONTROL on the instrument itself: with the modulator UNPATCHED
      // the same probe must go still. Without this, a probe that reported noise —
      // or read a field that jitters for unrelated reasons — would pass the leg
      // above on a dead producer.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          delete w.__patch.edges['nodeproducer-edge'];
        });
      });
      await expect
        .poll(
          async () => (await sampleProducerChannel(page, nodeId, read, 30)).distinct,
          {
            message:
              `${type}: with the modulator unpatched the same probe must settle — a channel that ` +
              'keeps moving on its own cannot be evidence that the producer is running',
            timeout: 30_000,
          },
        )
        .toBe(1);
    }

    // ⚠ AND THE UN-LATCH, which is the half a "does it move" leg cannot see —
    // for the producers whose channel HAS that semantics (see the fixture
    // field). `cv-shadow` clears the combined value only on a KNOB MOVE, so a
    // producer that stopped pushing would leave the param frozen at whatever the
    // modulator happened to be at: bright, moving, completely stale. The settled
    // value must be the KNOB, which is only true if the push is still running
    // after the cable is gone.
    if (fixture.unlatchesToKnob && fixture.read) {
      const knob = await page.evaluate(({ id, f }) => {
        const w = globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> }> } };
        return w.__patch.nodes[id]?.params?.[f];
      }, { id: nodeId, f: fixture.read.field });
      const settled = await sampleProducerChannel(page, nodeId, fixture.read, 20);
      expect(
        settled.first,
        `${type}: after the cable is pulled, ${fixture.read.field} must return to the KNOB ` +
          `(${knob}) rather than LATCHING at its last modulated value — the producer is what ` +
          `overwrites it. Saw ${settled.first}.`,
      ).toBeCloseTo(typeof knob === 'number' ? knob : 0, 3);
    }

    // ── DELETE — the node leaves the graph and the producer goes with it ─────
    await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const [eid, e] of Object.entries(w.__patch.edges)) {
          const edge = e as { source?: { nodeId?: string }; target?: { nodeId?: string } } | undefined;
          if (edge?.source?.nodeId === id || edge?.target?.nodeId === id) delete w.__patch.edges[eid];
        }
        delete w.__patch.nodes[id];
      });
    }, nodeId);
    // DERIVED from the manifest, never named here — the port that carries this
    // module's picture is a property of the module.
    const videoOut = mod.outputs.find((p) => p.type === 'video' || p.type === 'mono-video')?.id;
    if (videoOut) {
      await expect
        .poll(async () => hasVideoSource(page, nodeId, videoOut), {
          message: `${type}'s engine handle must be gone after the node is deleted`,
          timeout: 20_000,
        })
        .toBe(false);
    }

    const providerErrors = errors.filter((e) => /useStore|SvelteFlowProvider/i.test(e));
    expect(providerErrors, `provider throw(s): ${providerErrors.join(' | ')}`).toEqual([]);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE THIRD SHAPE: a producer the NODE MOUNTS AS A SURFACE (legacy-removal S1)
// ─────────────────────────────────────────────────────────────────────────────
//
// Same file, same reason as the block above: subjects here are modules LEAVING
// `CARD_PRODUCER_LANE_TYPES`, so a departure removes four tests from the first
// half silently, with the lane green and less coverage than it had. And the
// filename decides the CI job — `**/card-producer-lifetime.spec.ts` is on the
// webgl-heavy list, so a new file would have run in no job at all.
//
// ⚠ WHAT IS DIFFERENT FROM THE `FrameProducer` HALF, because a reader will look
// for a copy and find a different shape. Those producers are CALLBACKS on a
// shared ticker. WAVESCULPT's is a WebGL2 renderer with a persistent GL context
// and a presentation canvas, in a file whose BYTES are pinned by the attest
// basis — so the component stayed a component and the NODE mounts it
// (`$lib/ui/media/NodeVizSurfaceHost`). That makes ONE extra claim testable and
// necessary, and it is the one this block exists for beyond "the producer runs":
// there is exactly ONE `wavesculpt-canvas` element in the document at all times,
// and the views ADOPT it rather than mounting their own.
//
// ⚠ THE PROGRESS PROBE IS MOTION *AND* A BLACK FLOOR, WHICH IS NOT THE MIX
// TIMELORDE USES, AND THE DIFFERENCE IS THE MODULE. timelorde's dead producer
// reads BRIGHT and FROZEN (drawFrame blits the last bitmap anyone pushed), so
// "not black" proves nothing there and only motion can judge it. WAVESCULPT's
// dead state is a literal `fillRect('#000')` in `wavesculpt.ts`'s own drawFrame
// when no drawer is installed — so here BOTH readings are evidence, and they
// fail in different ways: a producer that never installed reads black AND
// still, a renderer that installed and then died reads lit AND still.
//
// ⚠ AND THE NEGATIVE CONTROL THIS MODULE CANNOT OFFER, STATED RATHER THAN
// FAKED. The `pixelPort` fixtures above require a `stillWhen` — a module-defined
// state in which a LIVE producer legitimately stops moving — and wavesculpt has
// none: its shader clock advances every frame in every view mode, which is
// exactly why the VRT scenes need `__wavesculptVrtFreeze` and why this file's
// own `waitForCoverageToSettle` says its ribbon "would never satisfy
// unchanged". Inventing one (pinning the test-only freeze flag) would control
// the INSTRUMENT with a test hook rather than with the module. What stands in
// its place: the BLACK FLOOR is an independent second reading of the same
// frame, the DELETE leg shows the probe reports nothing for nothing, and the
// extraction was verified with a measured POSITIVE control — with the node
// host's surface suppressed, the movement leg goes red and the port reads
// `nonBlack 0`. That control is a build-time measurement, not a shipped leg,
// and saying so is the honest version.

const VIZ_SURFACES_SRC = readFileSync(
  fileURLToPath(
    new URL('../../packages/web/src/lib/ui/media/node-viz-surfaces.ts', import.meta.url),
  ),
  'utf8',
);

/** The node-mounted viz surfaces, parsed from their own roster.
 *
 *  ⚠ ANCHORED ON `= [` AND CLOSED ON `\n];`, for the reason the sibling parser
 *  records: the type annotation is `readonly VizSurfaceProducer[]`, so a lazy
 *  `[^[]*\[` stops at the annotation's own bracket pair and captures nothing. */
function nodeVizSurfaceTypes(): string[] {
  const arr = /export const VIZ_SURFACE_PRODUCERS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(VIZ_SURFACES_SRC);
  if (!arr) throw new Error('could not parse VIZ_SURFACE_PRODUCERS — has the shape changed?');
  const types = [...arr[1]!.matchAll(/\btype:\s*'([^']+)'/g)].map((m) => m[1]!);
  if (types.length === 0) {
    throw new Error('VIZ_SURFACE_PRODUCERS parsed EMPTY — refusing to pass vacuously');
  }
  return types;
}

/**
 * Per-type facts the shared viz legs need — the deny-by-default discipline the
 * `FrameProducer` half already uses: a roster member with no fixture throws at
 * collection, so adding a surface to `node-viz-surfaces.ts` without saying how
 * to observe it cannot land silently green.
 */
interface VizSurfaceFixture {
  /** The surface's OWN testid on its headline element — the one every selector
   *  in the tree assumes is unique per document. */
  readonly canvasTestId: string;
  /** The legacy card's claim-hold testid (where the adopted element lands). */
  readonly cardHoldTestId: string;
  /** The DRS step-seam globals the surface installs (`ownsVideoOut` default). */
  readonly stepGlobal: string;
  readonly stepCountGlobal: string;
  /** Extra nodes/edges that make the picture MOVE. wavesculpt free-runs (its
   *  shader clock advances every frame); cube is param-driven and STILL at
   *  rest — that stillness is its VRT-determinism licence (`zdet`, see
   *  `_shell-faces.ts`), so the movement probe must drive a param. */
  readonly drive?: {
    readonly node: { id: string; type: string; domain: 'audio' | 'video' | 'meta' };
    readonly edge: { fromPort: string; toPort: string; sourceType: string; targetType: string };
  };
  readonly why: string;
}

const VIZ_SURFACE_FIXTURES: Record<string, VizSurfaceFixture> = {
  wavesculpt: {
    canvasTestId: 'wavesculpt-canvas',
    cardHoldTestId: 'wavesculpt-screen-wrap',
    stepGlobal: '__wavesculptStep',
    stepCountGlobal: '__wavesculptStepCount',
    why:
      'free-running WebGL2 ribbon — the shader clock advances every frame in every view mode, ' +
      'so motion needs no driver and stillness cannot be commanded (the block comment above ' +
      'records why that negative control is deliberately absent).',
  },
  cube: {
    canvasTestId: 'cube-3d-viz',
    cardHoldTestId: 'cube-viz-hold',
    stepGlobal: '__cubeStep',
    stepCountGlobal: '__cubeStepCount',
    // slice_ry is a cv INPUT; an LFO through it rotates the slicing plane, so
    // the volume render provably ADVANCES. At rest cube is legitimately STILL
    // (no time-varying view — every frame is recomputed from params), which is
    // what `vrt-determinism-probe.spec.ts` pins from the other side.
    drive: {
      node: { id: 'nodeviz-driver', type: 'lfo', domain: 'audio' },
      edge: { fromPort: 'phase0', toPort: 'slice_ry', sourceType: 'cv', targetType: 'cv' },
    },
    why:
      'param-driven WebGL2 volume — the picture is a pure function of the params and tables, ' +
      'so a moving picture needs a moving param (the LFO into slice_ry) and an idle cube being ' +
      'still is the module working, not the producer dead. The lit floor is what separates a ' +
      'still cube from a black one: with no drawer installed cube.ts fills SOLID BLACK (#1724).',
  },
};

/** Where a node's viz-surface element currently LIVES, by landmark. The whole
 *  adoption mechanism is a DOM move, so the assertion is about ancestry. */
async function vizCanvasHome(
  page: Page,
  nodeId: string,
  fixture: VizSurfaceFixture,
): Promise<{ count: number; parked: boolean; inCard: boolean; inDock: boolean; hosts: number }> {
  return page.evaluate(({ id, canvasTestId, cardHoldTestId }) => {
    const all = [...document.querySelectorAll(`[data-testid="${canvasTestId}"]`)];
    // Per-node filtering uses the surface's own data-node-id where it stamps
    // one (wavesculpt); cube's canvases carry none (its surface is byte-pinned
    // and predates the attribute), so ancestry against the park's data-node-id
    // does the same job — every leg here spawns ONE node of the type anyway.
    const mine = all.filter((c) => {
      const stamped = c.getAttribute('data-node-id');
      if (stamped !== null) return stamped === id;
      return true;
    });
    const el = mine[0] ?? null;
    const closest = (sel: string) => !!el?.closest(sel);
    return {
      // EVERY such element in the document, not just this node's — a second
      // mount for ANY node is the defect this leg exists for.
      count: all.length,
      parked: closest(`[data-testid="node-viz-surface"][data-node-id="${id}"]`),
      inCard: closest(`[data-testid="${cardHoldTestId}"]`),
      inDock: closest('[data-testid="dock-full-view"]'),
      hosts: document.querySelectorAll(`[data-testid="node-viz-surface"][data-node-id="${id}"]`).length,
    };
  }, { id: nodeId, canvasTestId: fixture.canvasTestId, cardHoldTestId: fixture.cardHoldTestId });
}

for (const type of nodeVizSurfaceTypes()) {
  const fixture = VIZ_SURFACE_FIXTURES[type];
  if (!fixture) {
    throw new Error(
      `${type} is a node-mounted viz surface with no fixture in this spec. Add one naming its ` +
        'canvas testid, its card hold, its DRS seam globals and how its picture is DRIVEN — a ' +
        'renderer nothing observes is a renderer that can stop running without any gate noticing.',
    );
  }
  const mod = REGISTRY.find((m) => m.type === type);
  if (!mod) throw new Error(`${type} has a node viz surface but is not in the registry manifest`);
  const pixelPort = mod.outputs.find((p) => p.type === 'video' || p.type === 'mono-video')?.id;
  if (!pixelPort) {
    throw new Error(
      `${type} is a node-mounted viz surface with no video output — its producer's product is a ` +
        'picture, so a module with nowhere to put one cannot be what this registry is for',
    );
  }
  const nodeId = `nodeviz-${type}`;

  test(`${type}: the renderer runs with NO card mounted anywhere, and there is exactly ONE of it`, async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 180_000 : 90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    await spawnPatch(
      page,
      [
        { id: nodeId, type, domain: mod.domain },
        ...(fixture.drive ? [fixture.drive.node] : []),
      ],
      fixture.drive
        ? [
            {
              id: 'nodeviz-drive-edge',
              from: { nodeId: fixture.drive.node.id, portId: fixture.drive.edge.fromPort },
              to: { nodeId, portId: fixture.drive.edge.toPort },
              sourceType: fixture.drive.edge.sourceType,
              targetType: fixture.drive.edge.targetType,
            },
          ]
        : [],
      { mountTimeout: 30_000 },
    );

    // The lane shows the shell's tile for a faced module…
    await expect(
      page.locator(
        `.svelte-flow__node[data-id="${nodeId}"] [data-testid="${
          'module-shell'
        }"]`,
      ),
    ).toHaveCount(1, { timeout: 20_000 });

    // …its REAL card is nowhere…
    await expect
      .poll(async () => anyCardMounts(page, nodeId, type), {
        message:
          `${type}'s card must not be mounted ANYWHERE — its renderer is node-lifetime, so a ` +
          'card mount would be a second owner of the frame drawer',
        timeout: 20_000,
      })
      .toBe(0);

    // …and the ONE surface is parked in its node host, claimed by nobody.
    await expect
      .poll(async () => (await vizCanvasHome(page, nodeId, fixture)).hosts, { timeout: 20_000 })
      .toBe(1);
    const cold = await vizCanvasHome(page, nodeId, fixture);
    expect(
      cold.count,
      `exactly one ${type} canvas must exist in the document. Two means a view MOUNTED the ` +
        'surface instead of claiming it — two GL contexts for one node, and two elements ' +
        'carrying one data-testid, which every selector in this tree assumes is unique. ' +
        `Saw ${JSON.stringify(cold)}`,
    ).toBe(1);
    expect(cold.parked, 'with no view claiming it the canvas sits in the node host').toBe(true);

    // ⚠ THE PROGRESS LEG. Everything above is satisfiable by a surface that
    // mounted, published, was counted — and rendered nothing at all.
    const moved = await framesToChange(page, nodeId, pixelPort);
    expect(
      moved.changed,
      `${type}.${pixelPort} must emit a MOVING picture with no card and no faceplate anywhere. ` +
        `${fmtChange(moved)}`,
    ).toBe(true);
    expect(
      moved.nonBlackMax,
      `${type}.${pixelPort} must be LIT, not merely changing. With no frame drawer installed ` +
        "this module's own drawFrame fills SOLID BLACK, so a zero here is the exact #1587 " +
        `defect — the node mounted no renderer. ${fmtChange(moved)}`,
    ).toBeGreaterThan(0);

    // ── THE ADOPTION HANDOFF, which is this shape's own failure mode ─────────
    // A dock full view CLAIMS the canvas out of the node host. That is a DOM
    // move on a live element, and the claim it must not break is that the
    // producer never stops — so sample EVERY frame across the move.
    const openPending = probeEveryFrame(page, nodeId, pixelPort);
    await page.evaluate((id) => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id);
    }, nodeId);
    const openHandoff = await openPending;
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 30_000 });
    expect(
      openHandoff.longestBlackRun,
      `${type}.${pixelPort} lost its picture while the dock full view CLAIMED its canvas, for ` +
        `${openHandoff.longestBlackRun} consecutive frames of ${openHandoff.frames} sampled. ` +
        `Series (nonBlack px/frame): ${openHandoff.series.join(',')}`,
    ).toBeLessThan(MAX_BLACK_RUN_FRAMES);

    await expect
      .poll(async () => (await vizCanvasHome(page, nodeId, fixture)).inDock, {
        message: 'the dock body must ADOPT the node canvas, not mount a second surface',
        timeout: 20_000,
      })
      .toBe(true);
    const docked = await vizCanvasHome(page, nodeId, fixture);
    expect(docked.count, `still exactly one canvas with the dock open: ${JSON.stringify(docked)}`)
      .toBe(1);
    expect(docked.parked, 'the claimed canvas has LEFT the node host').toBe(false);
    // ...and still no card, anywhere: the whole point of the extraction is that
    // a faced producer no longer needs one kept alive behind the faceplate.
    expect(
      await anyCardMounts(page, nodeId, type),
      'a node-owned renderer needs no headless host while its faceplate is open',
    ).toBe(0);

    // ── AND BACK. Closing the pane releases the claim; the canvas returns to the
    // node host rather than being destroyed, and the picture never stops.
    const closePending = probeEveryFrame(page, nodeId, pixelPort);
    await page.getByTestId('faceplate-collapse').first().click();
    const closeHandoff = await closePending;
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, { timeout: 20_000 });
    expect(
      closeHandoff.longestBlackRun,
      `${type}.${pixelPort} lost its picture when the dock RELEASED its canvas, for ` +
        `${closeHandoff.longestBlackRun} consecutive frames of ${closeHandoff.frames} sampled. ` +
        `Series (nonBlack px/frame): ${closeHandoff.series.join(',')}`,
    ).toBeLessThan(MAX_BLACK_RUN_FRAMES);
    await expect
      .poll(async () => (await vizCanvasHome(page, nodeId, fixture)).parked, {
        message: 'a released claim parks the canvas back with the node host',
        timeout: 20_000,
      })
      .toBe(true);
    const after = await framesToChange(page, nodeId, pixelPort);
    expect(
      after.changed && after.nonBlackMax > 0,
      `${type}.${pixelPort} must still be lit and moving after the claim round-trip. ` +
        `${fmtChange(after)}`,
    ).toBe(true);

    // ── DELETE — the node leaves the graph and the renderer goes with it. This
    // is also the instrument's own negative control: the same probe, on a
    // subject that is gone, must report nothing.
    await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const [eid, e] of Object.entries(w.__patch.edges)) {
          const edge = e as { source?: { nodeId?: string }; target?: { nodeId?: string } } | undefined;
          if (edge?.source?.nodeId === id || edge?.target?.nodeId === id) delete w.__patch.edges[eid];
        }
        delete w.__patch.nodes[id];
      });
    }, nodeId);
    await expect
      .poll(async () => hasVideoSource(page, nodeId, pixelPort), {
        message: `${type}'s engine handle must be gone after the node is deleted`,
        timeout: 20_000,
      })
      .toBe(false);
    await expect
      .poll(async () => (await vizCanvasHome(page, nodeId, fixture)).count, {
        message: 'the node host unmounts with the node, so no canvas is left behind',
        timeout: 20_000,
      })
      .toBe(0);
    const gone = await framesToChange(page, nodeId, pixelPort);
    expect(
      gone.changed || gone.nonBlackMax > 0,
      `the probe reports a live picture for a node that no longer exists — it is measuring ` +
        `something other than this producer. ${fmtChange(gone)}`,
    ).toBe(false);

    const providerErrors = errors.filter((e) => /useStore|SvelteFlowProvider/i.test(e));
    expect(providerErrors, `provider throw(s): ${providerErrors.join(' | ')}`).toEqual([]);
  });

  // ⚠ A SECOND ARM IS DELETED WITH THE SURFACE IT PHOTOGRAPHED, and it was the
  // LAST thing in `e2e/tests/` that booted the pre-inversion renderer.
  //
  // It asserted that the module's own surface ADOPTS the node-owned canvas — one
  // element, one renderer — because the two-mount alternative would have put the
  // DRS step seam on a surface nobody was looking at: stepping would freeze the
  // seam owner while the photographed element free-ran. `wavesculpt.spec.ts`
  // (17 tests) and `cube.spec.ts` consume that construction.
  //
  // ⚠ WHAT IS LOST, STATED RATHER THAN IMPLIED: the ADOPTION half. There is no
  // second host to adopt INTO, so "the card holds it, not the node host" is not
  // a claim that can be made or broken. What the consuming suites actually need
  // — that the seam owner and the photographed element are ONE mount — is now
  // true by construction and is asserted positively by the surviving arm above
  // ("the renderer runs with NO card mounted anywhere, and there is exactly ONE
  // of it"), which counts the canvases and reads `hosts === 1`.
}
