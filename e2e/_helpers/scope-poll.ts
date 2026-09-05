// e2e/_helpers/scope-poll.ts
//
// THE scope-analyser pollers for e2e. One export site, the same argument as
// e2e/_helpers/frames.ts: before this consolidated, three specs carried three
// near-identical hand-rolled poll loops and no two agreed on how they sampled.
//
// ── why the loop runs INSIDE the page ──────────────────────────────────────
//
// The shape these replace is:
//
//     while (Date.now() < deadline) {
//       const s = await readScopeStats(page, id);   // one CDP round trip
//       if (s.peak > best) best = s.peak;
//       if (best > threshold) return best;
//       await page.waitForTimeout(50);              // and a wall-clock guess
//     }
//
// That is one protocol round trip PER SAMPLE, on the SAME MAIN THREAD the audio
// graph and the render loop are running on. CLAUDE.md names this exact shape:
// "never sample a page-side quantity with a Playwright-side poll loop … a
// loaded runner starves both — and 'frozen' and 'never looked' are
// indistinguishable from the output." The bluebox variant was worse again: it
// shipped the whole ch1 Float32Array across the wire on every sample and
// reduced it test-side, so the measurement cost scaled with the buffer.
//
// Here the whole loop — sampling, reduction, threshold check, early exit — runs
// in ONE `page.evaluate`. Playwright waits on a single promise.
//
// ── why the result carries `samples` and `elapsedMs` ───────────────────────
//
// Also from CLAUDE.md: report "samples / elapsedMs / the values seen in the
// assertion message". A result of 0 then means something legible — "read 41
// times over 2013 ms and never saw signal" is a finding; "0" on its own could
// equally mean the poll never ran. Callers are expected to put these in the
// assertion message, and the specs in this repo do.
//
// ── the wall-clock argument BOUNDS THE FAILURE, it is not the gate ─────────
//
// `boundMs` exists so a dead signal fails in bounded time. The poll RETURNS the
// instant the threshold is crossed, so on a healthy run it costs whatever the
// signal costs and nothing more.

import type { Page } from '@playwright/test';

/** The reduction of one scope buffer. Mirrors what the specs asserted on. */
export interface ScopeStats {
  peak: number;
  rms: number;
  nonzeroSamples: number;
  total: number;
}

/** What every poller here returns: the reading PLUS how it was taken. */
export interface ScopePollResult extends ScopeStats {
  /** Buffers actually reduced in the page. 0 means the scope never resolved. */
  samples: number;
  /** Wall-clock the in-page loop actually spent. */
  elapsedMs: number;
  /** Did the threshold get crossed, or did the bound fire first? */
  reachedThreshold: boolean;
}

/** Band magnitude at `freqHz`, for the tone-detection specs. */
export interface BandPollResult {
  best: number;
  samples: number;
  elapsedMs: number;
  reachedThreshold: boolean;
}

/**
 * ONE-SHOT reduction of the scope's current ch1 buffer.
 *
 * The single-sample companion to the pollers below, here for the same reason
 * they are: three specs carried byte-identical private copies of it. The
 * reduction runs in the page, so the Float32Array never crosses the wire.
 */
export async function readScopeStats(page: Page, scopeNodeId: string): Promise<ScopeStats> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const empty = { peak: 0, rms: 0, nonzeroSamples: 0, total: 0 };
    const eng = w.__engine?.();
    if (!eng) return empty;
    const node = w.__patch?.nodes?.[id];
    if (!node) return empty;
    const snap = eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined;
    if (!snap?.ch1) return empty;
    let peak = 0;
    let energy = 0;
    let nonzero = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      energy += v * v;
      if (a > 1e-6) nonzero++;
    }
    return {
      peak,
      rms: Math.sqrt(energy / snap.ch1.length),
      nonzeroSamples: nonzero,
      total: snap.ch1.length,
    };
  }, scopeNodeId);
}

/** The failure line a scope poll deserves: the reading AND how it was taken. */
export function scopePollMsg(label: string, r: { samples: number; elapsedMs: number }): string {
  return `${label} — reduced ${r.samples} buffer(s) IN-PAGE over ${Math.round(r.elapsedMs)} ms`;
}

/**
 * Poll the scope's ch1 buffer until `peak` exceeds `threshold`, or `boundMs`
 * elapses. Returns the BEST reading seen, plus how it was taken.
 *
 * `sampleEveryMs` paces the in-page sampler. It is a genuine product-side
 * interval: the scope's analyser refills its buffer on the audio clock, so
 * sampling faster than a refill re-reduces bytes that have not changed. It
 * never crosses the process boundary, so it is not a Playwright-side wait.
 */
export async function pollScopePeak(
  page: Page,
  scopeNodeId: string,
  threshold: number,
  boundMs: number,
  sampleEveryMs = 25,
): Promise<ScopePollResult> {
  return page.evaluate(
    ([id, thr, bound, every]) =>
      new Promise<ScopePollResult>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const t0 = performance.now();
        let best: ScopeStats = { peak: 0, rms: 0, nonzeroSamples: 0, total: 0 };
        let samples = 0;
        const done = (reachedThreshold: boolean): void => {
          clearInterval(timer);
          resolve({ ...best, samples, elapsedMs: performance.now() - t0, reachedThreshold });
        };
        const read = (): void => {
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.[id as string];
          const snap =
            eng && node ? (eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined) : undefined;
          if (snap?.ch1) {
            let peak = 0;
            let energy = 0;
            let nonzero = 0;
            for (let i = 0; i < snap.ch1.length; i++) {
              const v = snap.ch1[i]!;
              const a = Math.abs(v);
              if (a > peak) peak = a;
              energy += v * v;
              if (a > 1e-6) nonzero++;
            }
            samples++;
            if (peak > best.peak) {
              best = {
                peak,
                rms: Math.sqrt(energy / snap.ch1.length),
                nonzeroSamples: nonzero,
                total: snap.ch1.length,
              };
            }
            if (best.peak > (thr as number)) return done(true);
          }
          if (performance.now() - t0 >= (bound as number)) done(false);
        };
        const timer = setInterval(read, every as number);
        read();
      }),
    [scopeNodeId, threshold, boundMs, sampleEveryMs] as const,
  );
}

/** What the gate-pulse probe returns: the latched reading plus how it was driven. */
export interface GatePulsePollResult extends ScopePollResult {
  /** `forcePulse()` calls the PAGE actually made. */
  pulses: number;
  /** Did `extras.forcePulse` resolve at all? `false` with `pulses: 0` is a
   *  missing hook, which is a different failure from a silent bridge. */
  hookFound: boolean;
}

/**
 * Drive a module's GATE output with `extras.forcePulse(port)` and latch the
 * highest `|ch1|` the downstream scope ever shows. Both the pulsing and the
 * sampling run IN THE PAGE, on independent timers.
 *
 * ── ⚠ THE RACE THIS EXISTS TO END ──────────────────────────────────────────
 *
 * Two specs hand-rolled this, and both wrote the defect down without naming it
 * as one. `doom-per-type-death-gates.spec.ts`: "a 10ms pulse against ~43ms
 * analyser refresh is borderline, so we re-fire until the snapshot lands during
 * a HIGH window." `gibribbon.spec.ts` called `forcePulse` and read the snapshot
 * in the SAME synchronous tick, which reads the analyser ring BEFORE the pulse
 * has been rendered into it.
 *
 * Both shapes require a COINCIDENCE — the pulse must still be inside the
 * analyser's window at the moment that particular round trip reads it — and
 * each round trip is a CDP hop on the same main thread as the audio graph. On a
 * loaded shard the coincidence stops happening, and the failure MOVES: gibribbon
 * lost `evt_hit` on one run and `evt_kill` + `evt_miss` on the next, out of an
 * identical five-port loop, while DOOM's `evt_kill_demon` failed the same way.
 * A failure that rotates between interchangeable members is a probe defect, not
 * five separate bridge defects.
 *
 * ── WHY LATCHING IS THE FIX, NOT A BIGGER CEILING ──────────────────────────
 *
 * `best.peak` here is MONOTONE: once any sample sees the pulse, no later sample
 * can un-see it. So the pulse no longer has to land in the same round trip that
 * reads it — it only has to be caught ONCE, by any sample, ever. Raising a
 * timeout only buys more coincidences; latching removes the need for one.
 *
 * The two timers are deliberately independent and the SAMPLER STARTS FIRST, so
 * there is no window in which a pulse could fire before the latch is armed.
 *
 * ── ⚠ THE NEGATIVE CONTROL IS BUILT IN ─────────────────────────────────────
 *
 * `pulseEveryMs: 0` runs this identical probe — same latch, same sampler, same
 * reduction — and NEVER pulses. A gate that never fires must still read as
 * never-fired, and a latch is exactly the kind of instrument that could quietly
 * stop being able to say so. Callers pin both directions with the same helper;
 * see `gibribbon.spec.ts`.
 */
export async function pollGatePulsePeak(
  page: Page,
  opts: {
    /** The module whose `extras.forcePulse` is driven. */
    sourceNodeId: string;
    /** The gate port id to pulse. Ignored when `pulseEveryMs` is 0. */
    port: string;
    /** The scope whose ch1 is latched. */
    scopeNodeId: string;
    threshold: number;
    boundMs: number;
    /** In-page sampler cadence. The analyser refills on the audio clock at
     *  ~43 ms, so this over-samples deliberately — a re-reduction of unchanged
     *  bytes is cheap and costs no round trip. */
    sampleEveryMs?: number;
    /** In-page pulse cadence. Spaced wider than the sampler so successive
     *  pulses land in DIFFERENT analyser windows. 0 = never pulse (control). */
    pulseEveryMs?: number;
  },
): Promise<GatePulsePollResult> {
  const {
    sourceNodeId,
    port,
    scopeNodeId,
    threshold,
    boundMs,
    sampleEveryMs = 20,
    pulseEveryMs = 60,
  } = opts;
  return page.evaluate(
    ([srcId, prt, scpId, thr, bound, every, pulseEvery]) =>
      new Promise<GatePulsePollResult>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const t0 = performance.now();
        let best: ScopeStats = { peak: 0, rms: 0, nonzeroSamples: 0, total: 0 };
        let samples = 0;
        let pulses = 0;
        let hookFound = false;
        const done = (reachedThreshold: boolean): void => {
          clearInterval(sampleTimer);
          if (pulseTimer !== undefined) clearInterval(pulseTimer);
          resolve({
            ...best,
            samples,
            pulses,
            hookFound,
            elapsedMs: performance.now() - t0,
            reachedThreshold,
          });
        };
        const read = (): void => {
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.[scpId as string];
          const snap =
            eng && node
              ? (eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined)
              : undefined;
          if (snap?.ch1) {
            let peak = 0;
            let energy = 0;
            let nonzero = 0;
            for (let i = 0; i < snap.ch1.length; i++) {
              const v = snap.ch1[i]!;
              const a = Math.abs(v);
              if (a > peak) peak = a;
              energy += v * v;
              if (a > 1e-6) nonzero++;
            }
            samples++;
            // THE LATCH. Monotone by construction: a pulse that any sample saw
            // cannot be erased by a later, quieter one.
            if (peak > best.peak) {
              best = {
                peak,
                rms: Math.sqrt(energy / snap.ch1.length),
                nonzeroSamples: nonzero,
                total: snap.ch1.length,
              };
            }
            if (best.peak > (thr as number)) return done(true);
          }
          if (performance.now() - t0 >= (bound as number)) done(false);
        };
        const firePulse = (): void => {
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.[srcId as string];
          if (!eng || !node) return;
          const extras = eng.read(node, 'extras') as
            | { forcePulse?: (p: string) => void }
            | undefined;
          if (!extras || typeof extras.forcePulse !== 'function') return;
          hookFound = true;
          extras.forcePulse(prt as string);
          pulses++;
        };
        // ⚠ SAMPLER FIRST. Arming the latch before anything can fire is what
        // makes "caught once, ever" true rather than nearly true.
        const sampleTimer = setInterval(read, every as number);
        read();
        const pulseTimer =
          (pulseEvery as number) > 0 ? setInterval(firePulse, pulseEvery as number) : undefined;
        if (pulseTimer !== undefined) firePulse();
      }),
    [sourceNodeId, port, scopeNodeId, threshold, boundMs, sampleEveryMs, pulseEveryMs] as const,
  );
}

/** One-line provenance for a gate-pulse assertion message. */
export function gatePulseMsg(label: string, r: GatePulsePollResult): string {
  return (
    `${label}: peak ${r.peak.toFixed(4)} from ${r.samples} sample(s) / ${r.pulses} pulse(s) ` +
    `over ${r.elapsedMs.toFixed(0)} ms (hook ${r.hookFound ? 'found' : 'MISSING'})`
  );
}

/** What the stereo poller returns: BOTH channel peaks plus provenance. */
export interface StereoPollResult {
  peakL: number;
  peakR: number;
  samples: number;
  elapsedMs: number;
  reachedThreshold: boolean;
}

/**
 * Poll BOTH scope channels (ch1 + ch2) until each peak exceeds `threshold`,
 * or `boundMs` elapses. Tracks the best reading PER CHANNEL, so a channel that
 * crossed early stays crossed while the loop waits on the other one.
 *
 * Exists for the stereo-pair gates (AUDIO IN L/R, ES-9 pairs): the
 * Playwright-side `expect.poll` shape it replaces did one CDP round trip per
 * sample on the thread being measured and read a constant near-zero on a
 * healthy chain.
 */
export async function pollScopeStereoPeaks(
  page: Page,
  scopeNodeId: string,
  threshold: number,
  boundMs: number,
  sampleEveryMs = 25,
): Promise<StereoPollResult> {
  return page.evaluate(
    ([id, thr, bound, every]) =>
      new Promise<StereoPollResult>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const t0 = performance.now();
        let bestL = 0;
        let bestR = 0;
        let samples = 0;
        const done = (reachedThreshold: boolean): void => {
          clearInterval(timer);
          resolve({
            peakL: bestL,
            peakR: bestR,
            samples,
            elapsedMs: performance.now() - t0,
            reachedThreshold,
          });
        };
        const read = (): void => {
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.[id as string];
          const snap =
            eng && node
              ? (eng.read(node, 'snapshot') as
                  | { ch1?: Float32Array; ch2?: Float32Array }
                  | undefined)
              : undefined;
          if (snap?.ch1 || snap?.ch2) {
            const peak = (buf?: Float32Array): number => {
              if (!buf) return 0;
              let p = 0;
              for (let i = 0; i < buf.length; i++) {
                const a = Math.abs(buf[i]!);
                if (a > p) p = a;
              }
              return p;
            };
            const l = peak(snap.ch1);
            const r = peak(snap.ch2);
            samples++;
            if (l > bestL) bestL = l;
            if (r > bestR) bestR = r;
            if (bestL > (thr as number) && bestR > (thr as number)) return done(true);
          }
          if (performance.now() - t0 >= (bound as number)) done(false);
        };
        const timer = setInterval(read, every as number);
        read();
      }),
    [scopeNodeId, threshold, boundMs, sampleEveryMs] as const,
  );
}

/** What the RMS pollers return: the reading PLUS how it was taken. */
export interface RmsPollResult {
  rms: number;
  samples: number;
  elapsedMs: number;
  reachedThreshold: boolean;
}

/** What the windowed RMS sampler returns — the SPREAD plus its provenance. */
export interface RmsWindowResult {
  lo: number;
  hi: number;
  samples: number;
  elapsedMs: number;
}

/**
 * Poll the scope's ch1 RMS until it exceeds `threshold`, or `boundMs` elapses.
 *
 * The RMS sibling of `pollScopePeak`, and it exists for the same reason: five
 * specs carried a private `while (Date.now() < deadline) { await
 * readScopeRms(page, id); … await page.waitForTimeout(100); }` — a CDP round
 * trip per sample against an audio analyser on the thread being sampled.
 */
export async function pollScopeRms(
  page: Page,
  scopeNodeId: string,
  threshold: number,
  boundMs: number,
  sampleEveryMs = 25,
): Promise<RmsPollResult> {
  return page.evaluate(
    ([id, thr, bound, every]) =>
      new Promise<RmsPollResult>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const t0 = performance.now();
        let best = 0;
        let samples = 0;
        const done = (reachedThreshold: boolean): void => {
          clearInterval(timer);
          resolve({ rms: best, samples, elapsedMs: performance.now() - t0, reachedThreshold });
        };
        const read = (): void => {
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.[id as string];
          const snap =
            eng && node ? (eng.read(node, 'snapshot') as { ch1?: Float32Array } | undefined) : undefined;
          if (snap?.ch1 && snap.ch1.length > 0) {
            let energy = 0;
            for (let i = 0; i < snap.ch1.length; i++) energy += snap.ch1[i]! * snap.ch1[i]!;
            const rms = Math.sqrt(energy / snap.ch1.length);
            samples++;
            if (rms > best) best = rms;
            if (best > (thr as number)) return done(true);
          }
          if (performance.now() - t0 >= (bound as number)) done(false);
        };
        const timer = setInterval(read, every as number);
        read();
      }),
    [scopeNodeId, threshold, boundMs, sampleEveryMs] as const,
  );
}

/**
 * Take `sampleCount` RMS readings `everyMs` apart and return the LO/HI seen.
 *
 * For the specs that characterise a MOVING signal rather than wait for one:
 * a filter sweep's RMS spread, or the peak RMS a note reaches over a window.
 * Both used to be Playwright-side `for` loops doing one round trip per sample.
 *
 * `everyMs` is a real product-side cadence — the scope analyser refills its
 * buffer on the audio clock, so sampling faster re-reduces bytes that have not
 * changed — and it never crosses the process boundary.
 */
export async function sampleScopeRms(
  page: Page,
  scopeNodeId: string,
  sampleCount: number,
  everyMs: number,
): Promise<RmsWindowResult> {
  return page.evaluate(
    ([id, count, every]) =>
      new Promise<RmsWindowResult>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const t0 = performance.now();
        let lo = Number.POSITIVE_INFINITY;
        let hi = 0;
        let samples = 0;
        let taken = 0;
        const read = (): void => {
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.[id as string];
          const snap =
            eng && node ? (eng.read(node, 'snapshot') as { ch1?: Float32Array } | undefined) : undefined;
          if (snap?.ch1 && snap.ch1.length > 0) {
            let energy = 0;
            for (let i = 0; i < snap.ch1.length; i++) energy += snap.ch1[i]! * snap.ch1[i]!;
            const rms = Math.sqrt(energy / snap.ch1.length);
            samples++;
            if (rms < lo) lo = rms;
            if (rms > hi) hi = rms;
          }
          if (++taken >= (count as number)) {
            clearInterval(timer);
            resolve({
              lo: Number.isFinite(lo) ? lo : 0,
              hi,
              samples,
              elapsedMs: performance.now() - t0,
            });
          }
        };
        const timer = setInterval(read, every as number);
        read();
      }),
    [scopeNodeId, sampleCount, everyMs] as const,
  );
}

/**
 * Poll the scope's ch1 buffer for the Goertzel band magnitude at `freqHz`,
 * until it exceeds `threshold` or `boundMs` elapses.
 *
 * ⚠ THE REDUCTION HAPPENS IN THE PAGE. The previous form shipped the entire
 * Float32Array over CDP on every sample and ran the Goertzel test-side, so the
 * cost of MEASURING scaled with the thing being measured.
 */
export async function pollScopeBandAmp(
  page: Page,
  scopeNodeId: string,
  freqHz: number,
  threshold: number,
  boundMs: number,
  sampleEveryMs = 25,
): Promise<BandPollResult> {
  return page.evaluate(
    ([id, hz, thr, bound, every]) =>
      new Promise<BandPollResult>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const t0 = performance.now();
        let best = 0;
        let samples = 0;
        const done = (reachedThreshold: boolean): void => {
          clearInterval(timer);
          resolve({ best, samples, elapsedMs: performance.now() - t0, reachedThreshold });
        };
        const read = (): void => {
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.[id as string];
          const snap =
            eng && node
              ? (eng.read(node, 'snapshot') as { ch1: Float32Array; sampleRate: number } | undefined)
              : undefined;
          if (snap?.ch1 && snap.ch1.length > 0) {
            // Goertzel-style band magnitude — the same shape the unit-test
            // helper uses, kept here so no spec re-implements it.
            const omega = (2 * Math.PI * (hz as number)) / snap.sampleRate;
            let re = 0;
            let im = 0;
            const n = snap.ch1.length;
            for (let i = 0; i < n; i++) {
              const v = snap.ch1[i] ?? 0;
              re += v * Math.cos(omega * i);
              im += v * Math.sin(omega * i);
            }
            const amp = (2 * Math.sqrt(re * re + im * im)) / n;
            samples++;
            if (amp > best) best = amp;
            if (best > (thr as number)) return done(true);
          }
          if (performance.now() - t0 >= (bound as number)) done(false);
        };
        const timer = setInterval(read, every as number);
        read();
      }),
    [scopeNodeId, freqHz, threshold, boundMs, sampleEveryMs] as const,
  );
}

// ── TIMBRE FINGERPRINT ──────────────────────────────────────────────────────
//
// ⚠ WHY COMPARING TWO RAW CAPTURES DOES NOT WORK, MEASURED.
//
// The obvious way to prove "changing X changed the sound" is to capture the
// scope before and after and assert the buffers differ. On a signal that is
// still running, that assertion CANNOT FAIL. Measured on dx7's algorithm
// switch (2026-08-23), with the switch made a NO-OP — same algorithm before
// and after:
//
//   normalised per-sample L2 between the captures : 1.2636   (threshold 0.1)
//   single-capture band-energy distance           : 0.5131   (real switch 0.5386)
//
// Both read "hugely different" for a change that did not happen. The cause is
// NOT pitch — dx7's sequencer holds midi 60 on every step — it is ENVELOPE
// PHASE: the note retriggers continuously and an FM voice's spectrum evolves
// across its envelope, so two captures at different instants disagree however
// little the patch changed.
//
// The repair is to make the DESCRIPTOR steady rather than the patch: average
// the L2-normalised band vector over a window spanning several note cycles.
// Phase and envelope position average out; the timbre the algorithm actually
// determines survives.

/** An averaged, phase- and envelope-robust timbre fingerprint. */
export interface TimbreFingerprint {
  /** L2-normalised mean band-energy vector. */
  bands: number[];
  samples: number;
  elapsedMs: number;
  meanRms: number;
}

/** Log-spaced Goertzel bins used for the fingerprint. */
const TIMBRE_BANDS = 24;

/**
 * Accumulate a TIMBRE FINGERPRINT over `windowMs`, entirely in the page.
 *
 * Each sample's band vector is L2-normalised (so level drops out), the
 * normalised vectors are averaged, and the mean is normalised again. Averaging
 * across several note cycles is what makes two captures of the SAME timbre
 * agree — see the measurement above for why a single capture cannot.
 */
export async function captureScopeTimbre(
  page: Page,
  scopeNodeId: string,
  windowMs: number,
  sampleEveryMs = 25,
): Promise<TimbreFingerprint> {
  return page.evaluate(
    ([id, win, every, nBands]) =>
      new Promise<TimbreFingerprint>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const BANDS = nBands as number;
        const acc = new Array<number>(BANDS).fill(0);
        const t0 = performance.now();
        let samples = 0;
        let rmsSum = 0;
        const read = (): void => {
          const eng = w.__engine?.();
          const node = w.__patch?.nodes?.[id as string];
          const snap =
            eng && node
              ? (eng.read(node, 'snapshot') as
                  | { ch1?: Float32Array; sampleRate?: number }
                  | undefined)
              : undefined;
          if (snap?.ch1 && snap.ch1.length > 0) {
            const ch1 = snap.ch1;
            const sr = snap.sampleRate && snap.sampleRate > 0 ? snap.sampleRate : 48000;
            let energy = 0;
            for (let i = 0; i < ch1.length; i++) energy += ch1[i]! * ch1[i]!;
            const rms = Math.sqrt(energy / ch1.length);
            // Silent buffers carry no timbre; averaging them in would drag the
            // fingerprint toward whatever normalising near-zero noise produces.
            if (rms > 1e-6) {
              const f0 = 80;
              const fMax = Math.min(12000, sr / 2);
              const bins: number[] = [];
              for (let b = 0; b < BANDS; b++) {
                const hz = f0 * Math.pow(fMax / f0, b / (BANDS - 1));
                const omega = (2 * Math.PI * hz) / sr;
                let re = 0;
                let im = 0;
                for (let i = 0; i < ch1.length; i++) {
                  const v = ch1[i]!;
                  re += v * Math.cos(omega * i);
                  im += v * Math.sin(omega * i);
                }
                bins.push(Math.sqrt(re * re + im * im) / ch1.length);
              }
              let nrm = 0;
              for (const v of bins) nrm += v * v;
              nrm = Math.sqrt(nrm);
              if (nrm > 1e-12) {
                for (let b = 0; b < BANDS; b++) acc[b] = acc[b]! + bins[b]! / nrm;
                samples++;
                rmsSum += rms;
              }
            }
          }
          if (performance.now() - t0 >= (win as number)) {
            clearInterval(timer);
            let nrm = 0;
            for (const v of acc) nrm += v * v;
            nrm = Math.sqrt(nrm);
            const bands = nrm > 1e-12 ? acc.map((v) => v / nrm) : acc.slice();
            resolve({
              bands,
              samples,
              elapsedMs: performance.now() - t0,
              meanRms: samples > 0 ? rmsSum / samples : 0,
            });
          }
        };
        const timer = setInterval(read, every as number);
        read();
      }),
    [scopeNodeId, windowMs, sampleEveryMs, TIMBRE_BANDS] as const,
  );
}

/** L2 distance between two fingerprints. 0 = identical timbre. */
export function timbreDistance(a: TimbreFingerprint, b: TimbreFingerprint): number {
  const n = Math.min(a.bands.length, b.bands.length);
  let d2 = 0;
  for (let i = 0; i < n; i++) {
    const d = a.bands[i]! - b.bands[i]!;
    d2 += d * d;
  }
  return Math.sqrt(d2);
}
