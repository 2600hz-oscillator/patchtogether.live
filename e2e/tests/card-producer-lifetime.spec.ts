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

/** The producers whose FACE mounts the producing surface itself, so their
 *  headless host stands down while the dock full view is open. Parsed from the
 *  same shared source as the lane sets — a hand-typed copy here would be the
 *  second source of truth for a rule whose whole point is that a module leaves
 *  the default BY NAME. */
const FACE_MOUNTS_PRODUCER = new Set(parseLaneSet('FACE_MOUNTS_PRODUCER'));

/** The producer subjects, derived from the shared source. */
function cardProducerTypes(): string[] {
  const producers = parseLaneSet('CARD_PRODUCER_LANE_TYPES');
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
    /** What the shell renders in the lane INSTEAD of the real card. DERIVED
     *  from the manifest's own `strictFace`, never declared here (#1724): a
     *  MIGRATED module gets `<ModuleShell>`, an un-migrated one the uniform
     *  `<ModuleShellPlaceholder>`. Both are `needsHeadlessSourceMount` kinds, so
     *  the claim below is the same either way — but hard-coding the placeholder
     *  made the assertion silently un-satisfiable for the first migrated
     *  producer to join this set, which is exactly what CUBE is. */
    laneTestId: mod.strictFace === true ? 'module-shell' : 'module-shell-placeholder',
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
    keepsHeadlessWhileDocked:
      mod.strictFace === true && !FACE_MOUNTS_PRODUCER.has(type),
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
 * EVERY host that can hold this node's real card while the lane shows nothing
 * for it, counted from the DOM rather than from a list of module types.
 *
 * ⚠ THIS IS THE POINT OF READING IT THIS WAY. There are two such hosts and
 * which one takes a given node is a property of the module, not of this test:
 * `<HeadlessSourceHost>` holds a CARD_PRODUCER, while `GroupCard` hidden-mounts
 * a viz-passthrough child's card itself (SCOPE — $lib/ui/modules/group-viz-hosts).
 * Asserting the SUM is 1 is the claim that matters in both directions at once —
 * somebody is running the pump, and nobody is running it twice — and it needs no
 * hand-maintained list to say so, so a future opt-in changes nothing here.
 */
async function collapsedCardHosts(
  page: Page,
  nodeId: string,
): Promise<{ headless: number; groupViz: number; total: number }> {
  return page.evaluate((id) => {
    const headless = document.querySelectorAll(
      `[data-testid="headless-source-host"][data-node-id="${id}"]`,
    ).length;
    const groupViz = document.querySelectorAll(
      `[data-testid="viz-hidden-mount"][data-child-id="${id}"]`,
    ).length;
    return { headless, groupViz, total: headless + groupViz };
  }, nodeId);
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

/** Wrap `childId` in a freshly-created GROUP. A group is created COLLAPSED
 *  (`data.expanded` absent ⇒ falsy ⇒ `collapsedGroupIds` contains it), so this
 *  single mutation IS the collapse — the same state a SAVED rack loads in, and
 *  the same one `graph/group-actions.ts` commits from the marquee gesture. */
async function groupChild(page: Page, groupId: string, childId: string): Promise<void> {
  await page.evaluate(({ gid, cid }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes[gid] = {
        id: gid,
        type: 'group',
        domain: 'meta',
        position: { x: 40, y: 40 },
        params: {},
        data: { childIds: [cid], exposedPorts: [], label: 'producer group' },
      };
      const child = w.__patch.nodes[cid] as { data?: Record<string, unknown> } | undefined;
      if (!child) throw new Error(`groupChild: no node ${cid}`);
      if (!child.data) child.data = {};
      (child.data as { parentGroupId?: string }).parentGroupId = gid;
    });
  }, { gid: groupId, cid: childId });
}

/** Un-collapse the group (the user's expand click, driven through the graph so
 *  the test does not depend on the group card's chrome). */
async function expandGroup(page: Page, groupId: string): Promise<void> {
  await page.evaluate((gid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const g = w.__patch.nodes[gid] as { data?: Record<string, unknown> } | undefined;
      if (!g?.data) throw new Error(`expandGroup: no group ${gid}`);
      (g.data as { expanded?: boolean }).expanded = true;
    });
  }, groupId);
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

async function boot(page: Page, shell: Shell = 'default'): Promise<void> {
  // Plain /rack — the DEFAULT faceplate shell, which is the whole point of the
  // #1587 legs: under `?shell=legacy` the real card renders in the lane and the
  // shell-swap bug is invisible. The #1721 leg passes 'legacy' as well, because
  // ITS defect is not shell-shaped (see there).
  await page.goto(shell === 'legacy' ? '/rack?shell=legacy' : '/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
}

type Shell = 'default' | 'legacy';

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
        `host while docked (migrated=${migrated}` +
        `, faceMountsProducer=${FACE_MOUNTS_PRODUCER.has(type)}), so the headless host must be ` +
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

  // ── #1721 — THE GROUP-COLLAPSE LEG, IN BOTH SHELLS ─────────────────────────
  //
  // The legs above are all about the SHELL swapping a lane card for a tile. This
  // one is not, and that is the whole reason it exists: Canvas's `flowNodes`
  // derivation drops a COLLAPSED GROUP'S CHILDREN outside its `shellFaces`
  // branch, so a producer inside a collapsed group has no card in EITHER shell
  // — the first member of the #1583 family that is not a default-shell-only
  // exposure. `?shell=legacy` is therefore a REAL second subject here, not the
  // ceremonial no-op it is for the tests above.
  //
  // NO CLICK, AND THAT IS THE TRIGGER UNDER TEST. A group is created COLLAPSED,
  // so wrapping the node in one IS the collapse — the same state a SAVED rack
  // loads in, with no user action against the producer at all. The expand leg at
  // the end then exercises the other direction.
  //
  // THE VACUITY GUARDS, since an equality between two probes of the same dead
  // thing passes:
  //   * phase 1 (UNGROUPED) must itself carry a MOVING picture, asserted, before
  //     anything is compared against it — the permanent positive control;
  //   * the port SET must match, not merely "something is non-black";
  //   * the movement check is re-run after the collapse and exits ON THE EVENT
  //     (TIMELORDE's stale-bitmap shape reads non-black forever while frozen —
  //     measured on the pre-fix tree: `nonBlack 2944/3072` unchanged, `1 distinct
  //     signature in 20 frames`, i.e. dead but bright);
  //   * and the card must be mounted EXACTLY ONCE across every host that can
  //     hold it, which fails both if nobody took it and if two hosts did.
  //
  // ⚠ WHAT THIS LEG STRUCTURALLY CANNOT SEE. It reads the module's own
  // `drawFrame`, so a producer whose engine-visible state is NOT a picture is
  // invisible to it — SYNESTHESIA's `video_levels_a/b` writes and SCOPE's /
  // RASTERIZE's `cvCombined` writes are covered by the mount-count assertion and
  // by dom-source-modules.test.ts, never by these pixels. And it covers only the
  // COLLAPSED-GROUP arm of the exclusion it fixes: the CANVAS-HIDDEN arm
  // (`isCanvasHiddenNode` — pinned singletons + `hiddenCard` cameras) is a
  // different subject.
  //
  // ⚠ THAT ARM IS NOW FIXED AND COVERED ELSEWHERE — #1754, 2026-08-23. The
  // pinned TIMELORDE every rack auto-spawns is a CARD_PRODUCER that was sitting
  // in it: measured on a default rack, `nonBlack 0/3072, maxLuma 8` (its idle
  // #07090d field), `1 distinct signature over 30 frames`, with zero card mounts
  // ANYWHERE, in both shells. `headlessSourceNodes` now routes canvas-hidden
  // nodes through `needsHeadlessSourceMount`'s `laneOmitsNode` arm — which
  // returns `CARD_PRODUCER_LANE_TYPES.has(type)`, so hidden cameras are
  // unchanged — and `e2e/tests/timelorde-pinned-source.spec.ts` is the leg that
  // proves it, with the same in-page drawFrame probe this file uses.
  for (const shell of ['default', 'legacy'] as const) {
    test(`${type} [${shell} shell]: its card survives its GROUP being COLLAPSED (#1721)`, async ({ page }) => {
      test.setTimeout(SLOW_RENDER ? 240_000 : 120_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await boot(page, shell);
      const groupId = `producer-group-${type}`;
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

      // ── 1. UNGROUPED — the permanent positive control ────────────────────
      const beforeReady = await waitForProducerRegistration(page, nodeId, videoOuts);
      const beforeSettle = await waitForCoverageToSettle(page, nodeId, videoOuts);
      const beforeSamples = await samplePorts(page, nodeId, videoOuts);
      const liveBefore = livePorts(beforeSamples);

      // A subject with no pixel coverage even ungrouped has no picture to lose
      // here (SYNESTHESIA's per-band rasters need a video source patched in).
      // Skip LOUDLY — and only after the phase-1 probe has actually run, so a
      // broken probe fails instead of quietly becoming a skip.
      test.skip(
        liveBefore.length === 0,
        `${type} shows no picture on any video output even UNGROUPED, so there is nothing here ` +
          `to lose: ${digest(beforeSamples)} (producer ready=${beforeReady.ready} after ` +
          `${beforeReady.waitedFrames} frames; coverage settled=${beforeSettle.settled}). Its ` +
          'producer lifetime is covered by the headless-mount test above.',
      );

      const witness = liveBefore[0]!;
      const movedBefore = await framesToChange(page, nodeId, witness);

      // ── 2. COLLAPSE — wrap it in a group, which is created collapsed ──────
      await groupChild(page, groupId, nodeId);
      // The group's own card is what the lane now shows for the whole set…
      await expect(page.locator(`.svelte-flow__node[data-id="${groupId}"]`)).toHaveCount(1, {
        timeout: 20_000,
      });
      // …and the child's own lane node is gone, in BOTH shells. This is the
      // premise of the whole leg, so it is asserted rather than assumed: if the
      // lane still rendered the card there would be no defect to guard.
      await expect
        .poll(async () => laneNodeCount(page, nodeId), {
          message:
            `[${shell}] the collapsed group's child must have NO lane node of its own — ` +
            'otherwise this leg is measuring nothing',
          timeout: 20_000,
        })
        .toBe(0);

      // EXACTLY ONE host holds the real card. Fails on 0 (the #1721 defect) and
      // on 2 (a double mount), and does not care WHICH host it is.
      await expect
        .poll(async () => (await collapsedCardHosts(page, nodeId)).total, {
          message:
            `[${shell}] ${type}'s real card must be mounted EXACTLY ONCE while its group is ` +
            'collapsed — in <HeadlessSourceHost>, or in GroupCard\'s hidden viz mount for a ' +
            'viz-passthrough child',
          timeout: 20_000,
        })
        .toBe(1);

      const afterReady = await waitForProducerRegistration(page, nodeId, videoOuts);
      const afterSettle = await waitForCoverageToSettle(page, nodeId, videoOuts);
      const afterSamples = await samplePorts(page, nodeId, videoOuts);
      const hosts = await collapsedCardHosts(page, nodeId);

      expect(
        livePorts(afterSamples),
        `#1721 [${shell} shell]: the ports carrying a picture must be the same whether or not ` +
          `${type} sits in a COLLAPSED GROUP. Its card is the pump, and a collapsed group is UI ` +
          'state.\n' +
          `  ungrouped: ${digest(beforeSamples)} (producer ready=${beforeReady.ready} after ` +
          `${beforeReady.waitedFrames} frames; coverage settled=${beforeSettle.settled} in ` +
          `${beforeSettle.rounds} rounds at peak ${beforeSettle.peak})\n` +
          `  collapsed: ${digest(afterSamples)} (producer ready=${afterReady.ready} after ` +
          `${afterReady.waitedFrames} frames; coverage settled=${afterSettle.settled} in ` +
          `${afterSettle.rounds} rounds at peak ${afterSettle.peak}; hosts=${JSON.stringify(hosts)})`,
      ).toEqual(liveBefore);

      // MOVEMENT, on the same witness port and with the same event-exit probe
      // used ungrouped — so the two phases are one instrument. Skipped only when
      // the subject was ALREADY static ungrouped (SCOPE / RASTERIZE draw their
      // picture inside the module; the card only refines WHICH display params).
      if (movedBefore.changed) {
        const movedAfter = await framesToChange(page, nodeId, witness);
        expect(
          movedAfter.changed,
          `#1721 [${shell} shell]: ${type}.${witness} must still emit a MOVING picture inside a ` +
            'collapsed group. A frozen-but-bright surface is exactly what a dead producer looks ' +
            `like here.\n  ungrouped: ${fmtChange(movedBefore)}\n  collapsed: ${fmtChange(movedAfter)}`,
        ).toBe(true);
      }

      // ── 3. EXPAND — the other direction, so the guard is not one-sided ────
      // The child returns to the lane, and the picture must survive that
      // handoff too: whichever host held it during the collapsed window has to
      // let go without taking the producer down with it.
      //
      // ⚠ WHAT IS NOT ASSERTED HERE, AND WHY. GroupCard's own `expanded` chrome
      // does NOT react to `data.expanded` flipping — measured on origin/main
      // with the unmodified tree, twice, once after a dev-server restart
      // (#1753: grouping-phase2 "Phase 2A", grouping-phase3 "expand mode" and
      // save-group-and-naming "group rename" are all RED there, all reading a
      // stale `data-expanded="false"` / stale label while the children DO
      // re-appear inline). So its hidden viz mount is still present after an
      // expand. That is a live GroupCard reactivity defect that predates this
      // leg; it is not what #1721 is about, and asserting it here would make
      // this leg fail for someone else's bug. Canvas's `collapsedGroupIds` DOES
      // react — which is why the lane-node assertion below is meaningful and is
      // the one kept.
      await expandGroup(page, groupId);
      await expect
        .poll(async () => laneNodeCount(page, nodeId), {
          message: `[${shell}] the expanded group's child returns to the lane`,
          timeout: 20_000,
        })
        .toBe(1);
      await waitForProducerRegistration(page, nodeId, videoOuts);
      await waitForCoverageToSettle(page, nodeId, videoOuts);
      const expandedSamples = await samplePorts(page, nodeId, videoOuts);
      expect(
        livePorts(expandedSamples),
        `[${shell}] ${type} must still carry the same picture once the group is EXPANDED again: ` +
          `${digest(expandedSamples)}`,
      ).toEqual(liveBefore);

      const providerErrors = errors.filter((e) => /useStore|SvelteFlowProvider/i.test(e));
      expect(
        providerErrors,
        `provider throw(s) across the group collapse/expand: ${providerErrors.join(' | ')}`,
      ).toEqual([]);
    });
  }
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
          mod.strictFace === true ? 'module-shell' : 'module-shell-placeholder'
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
