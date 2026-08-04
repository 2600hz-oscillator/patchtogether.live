// packages/dsp/src/lib/timelorde-clock-core.ts
//
// TIMELORDE CLOCK CORE — the pure, sample-accurate clock engine extracted
// VERBATIM from the TIMELORDE AudioWorklet (../timelorde.ts) so it can be
// unit-tested without an AudioWorkletGlobalScope. The worklet is now a thin
// wrapper that owns the parameterDescriptors + the MessagePort and forwards
// each block to `TimelordeClockCore.process(...)`.
//
// BEHAVIOR-PRESERVING: the process/fireMaster/scheduleNow logic is byte-for-byte
// the same code that used to live in the worklet. The only edits at extraction
// were mechanical: the `sampleRate` global became the `sr` parameter, and
// `this.port.postMessage` became the injected `post` callback. No timing,
// counter, or output value changed — proven by the per-port + behavioral e2e
// rows staying green.
//
// One AudioWorklet, thirteen outputs (12 gates + swing):
//   1x, 8x, 4x, 2x, 1/2, 1/3, 1/4, 1/8, 1/12, 1/16, 1/32, 1/64, swing
//
// External clock is auto-detected: if a rising edge arrives on input 0 within
// ~2 master periods, we follow it; otherwise the internal BPM generator drives
// 1x. Multiplier outputs (8x, 4x, 2x) lag by exactly one master period due to a
// predictor-style scheduler (the next pulse arrival is only knowable AFTER the
// current pulse fires). Divider outputs are exact (counter-based, no prediction).

const CLOCK_THRESHOLD = 0.5;
// Gate pulse width (samples). 10 ms at 48 kHz = 480 samples.
const PULSE_WIDTH_S = 0.01;
// External-clock dropout: if no edge has arrived for >EXT_DROPOUT_MULT *
// last_master_period, fall back to internal BPM.
const EXT_DROPOUT_MULT = 2;

// Output indices — keep in sync with module-registry.ts outputs[] order.
export const OUT_1X = 0;
export const OUT_8X = 1;
export const OUT_4X = 2;
export const OUT_2X = 3;
export const OUT_HALF = 4;
export const OUT_THIRD = 5;
export const OUT_QTR = 6;
export const OUT_8TH = 7;
export const OUT_12TH = 8;
export const OUT_16TH = 9;
export const OUT_32ND = 10;
export const OUT_64TH = 11;
export const OUT_SWING = 12;

// Swing source encoding: 0 = 1x, 1 = 8x, 2 = 4x, 3 = 2x, 4 = 1/2, ..., 11 = 1/64.
// Maps to the same order as outputs above (sans swing itself).
export const SWING_SOURCES = [
  OUT_1X, OUT_8X, OUT_4X, OUT_2X, OUT_HALF, OUT_THIRD, OUT_QTR,
  OUT_8TH, OUT_12TH, OUT_16TH, OUT_32ND, OUT_64TH,
];

// Divisor outputs and their integer ratios (master pulses per emit).
export const DIVISOR_DEFS: { out: number; ratio: number }[] = [
  { out: OUT_HALF, ratio: 2 },
  { out: OUT_THIRD, ratio: 3 },
  { out: OUT_QTR, ratio: 4 },
  { out: OUT_8TH, ratio: 8 },
  { out: OUT_12TH, ratio: 12 },
  { out: OUT_16TH, ratio: 16 },
  { out: OUT_32ND, ratio: 32 },
  { out: OUT_64TH, ratio: 64 },
];

// Multiplier outputs and their factors (M-1 sub-pulses scheduled per master).
// 8x: useful for audio-rate clock effects + driving GRIDS-style finely-
// divided patterns. At 120 BPM the master is 2 Hz; 8x = 16 Hz, still
// well under audio rate but fast enough to feel "continuous".
export const MULTIPLIER_DEFS: { out: number; factor: number }[] = [
  { out: OUT_8X, factor: 8 },
  { out: OUT_4X, factor: 4 },
  { out: OUT_2X, factor: 2 },
];

/** Schedule a pulse to fire `delaySamples` from now, lasting PULSE_WIDTH samples. */
interface PendingPulse {
  outIdx: number;
  startSample: number; // absolute sample count
  endSample: number;
}

/** The k-rate parameter block a worklet passes through unchanged (each value is
 *  a Float32Array; only [0] is read — these are k-rate). */
export type TimelordeParams = Record<string, Float32Array>;

/** postMessage sink — the worklet injects `this.port.postMessage`; tests can
 *  inject a spy (or a no-op). */
export type PostFn = (message: unknown) => void;

export class TimelordeClockCore {
  // Absolute sample position. Monotonic, starts at 0 on processor boot.
  private sampleCount = 0;

  // Internal-clock phase counter [0..periodSamples). When it crosses 0,
  // emit a 1x pulse.
  private internalPhase = 0;

  // External clock detection.
  private lastClockSample = 0;
  // Sample index at which the last external rising edge was observed; -1 = none.
  private lastExternalEdgeAt = -1;
  // Rolling median (4-window) of measured external periods, in samples.
  private periodSamples: number[] = [];
  private lastMeasuredPeriod = 0;
  // Last BPM value posted to the WEB layer (so the card can display the
  // tempo we're actually locked to). Re-posted only when the measured
  // value drifts by >0.1 BPM, so the port traffic stays at most a few
  // messages per second under a steady external clock.
  private lastReportedBpm = 0;
  // Tracks whether the external clock was active last block, so a
  // transition to "no longer active" can post measuredBpm:0 once.
  private wasExternalActive = false;

  // Master pulse counter — every 1x pulse increments. Drives divisors.
  private masterCount = 0;

  // Pending pulses queue (multipliers + swing). Sorted by startSample.
  private pending: PendingPulse[] = [];

  // Pulse index WITHIN THE SWUNG TRAIN. Swing means "hold the off-beats back",
  // so only the ODD-indexed pulses of the source train take the lag; the
  // even-indexed (on-beat) ones fire dead on time. Reset whenever the swing
  // SOURCE changes so which pulses count as off-beats is deterministic from
  // the moment the user picks a source rather than a function of how long the
  // clock happened to be running.
  private swingPulseIndex = 0;
  private lastSwingTarget = -1;

  // Currently-firing pulses: 13 entries (indices 0..11 for the 12 fixed
  // outputs + index 12 for swing, OUT_SWING). The old Int32Array(12)
  // silently dropped every swing write (TypedArray out-of-bounds is a
  // no-op) so the swing gate always read 0. Fixed by sizing to 13.
  private outputPulseEnd = new Int32Array(13);

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: TimelordeParams,
    sr: number,
    post: PostFn,
  ): boolean {
    // We expect 12 outputs, each mono.
    if (outputs.length < 12) return true;
    const blockLen = outputs[0]?.[0]?.length ?? 0;
    if (blockLen === 0) return true;

    const bpm = parameters.bpm[0] ?? 120;
    const swingAmount = parameters.swingAmount[0] ?? 0;
    const swingSourceIdx = Math.max(
      0,
      Math.min(SWING_SOURCES.length - 1, Math.round(parameters.swingSource[0] ?? 0)),
    );
    const muteOutputs = (parameters.muteOutputs[0] ?? 0) >= 0.5;
    const running = (parameters.running[0] ?? 1) >= 0.5;
    const hasExternalClock = (parameters.hasExternalClock[0] ?? 0) >= 0.5;

    // v2 behavior: muteOutputs gates the OUTPUT WAVEFORMS at the end of
    // the block but doesn't stop phase / pending-pulse bookkeeping — so
    // LIVECODE's clocked() subscribers (which subscribe to TIMELORDE-
    // mirrored ticks via the engine-side TickBus) keep firing whether
    // or not the user wants audible gates downstream.
    //
    // running (v3, transport-gate-driven): when 0, the internal clock
    // HALTS. Phase accumulator + sampleCount + pending-pulse processing
    // all freeze. Outputs hold their last-written state (whatever pulse
    // was mid-flight when stop fired keeps its level until process()
    // resumes). On resume the counters pick up from the frozen value —
    // musical position is preserved across a stop, matching DAW
    // transport semantics. Distinct from mute: a stopped clock has no
    // ticks to mute.
    //
    // External clock just means "lock 1x to incoming edges". It no
    // longer overrides mute (the user can mute the rack but still
    // have LIVECODE see the MIDI-clock pulses).
    if (!running) {
      // Hold every output low while halted; the gate state from the
      // last running block (a possibly-still-firing pulse) shouldn't
      // leak through as a stuck-high — the transport is STOPPED.
      // We do NOT advance sampleCount / internalPhase / pending, so on
      // resume the next process() block continues exactly where the
      // halted block would have, modulo this missing block of samples.
      for (let o = 0; o < 13; o++) {
        const ch = outputs[o]?.[0];
        if (!ch) continue;
        for (let i = 0; i < blockLen; i++) ch[i] = 0;
      }
      return true;
    }

    const internalPeriodSamples = Math.max(1, (60 / Math.max(1, bpm)) * sr);

    // Decide effective period for multiplier prediction + swing offset.
    // External wins when an edge has been seen recently (within EXT_DROPOUT_MULT
    // periods of the last measurement); else internal.
    const externalActive =
      hasExternalClock &&
      this.lastExternalEdgeAt >= 0 &&
      this.lastMeasuredPeriod > 0 &&
      this.sampleCount - this.lastExternalEdgeAt <
        EXT_DROPOUT_MULT * this.lastMeasuredPeriod;

    // Transition: external clock stopped (cable removed or pulses dropped
    // out beyond EXT_DROPOUT_MULT). Tell the card to revert its display
    // from the measured tempo back to the internal knob.
    if (this.wasExternalActive && !externalActive && this.lastReportedBpm !== 0) {
      this.lastReportedBpm = 0;
      post({ type: 'measuredBpm', bpm: 0 });
    }
    this.wasExternalActive = externalActive;

    const periodForPrediction =
      externalActive && this.lastMeasuredPeriod > 0
        ? this.lastMeasuredPeriod
        : internalPeriodSamples;

    const swingTargetOut = SWING_SOURCES[swingSourceIdx]!;
    if (swingTargetOut !== this.lastSwingTarget) {
      this.lastSwingTarget = swingTargetOut;
      this.swingPulseIndex = 0;
    }

    // The lag is a fraction of the SWUNG TRAIN's OWN pulse interval, not of the
    // master period. Swing is defined relative to the subdivision being swung —
    // "60° of shuffle on the 16ths" has to mean 60° of a 16th — and reading it
    // off the master instead makes SWING mean something different for every SRC.
    // It is also what keeps the train ordered: swingAmount caps at 90° = 25% of
    // the interval, so a held-back off-beat can never overtake the on-beat that
    // follows it. (Off the master period an 8x source at 90° lagged 6000 samples
    // into a 3000-sample sub-period — two pulses past where it belonged.)
    // For SRC = 1x, the default, the source interval IS the master period, so
    // this is a no-op there and existing 1x-swing patches keep their lag.
    let swingSourceInterval = periodForPrediction;
    for (const d of DIVISOR_DEFS) {
      if (d.out === swingTargetOut) swingSourceInterval = periodForPrediction * d.ratio;
    }
    for (const m of MULTIPLIER_DEFS) {
      if (m.out === swingTargetOut) swingSourceInterval = periodForPrediction / m.factor;
    }
    const swingLagSamples = Math.max(0, (swingAmount / 360) * swingSourceInterval);

    // External clock buffer — read input 0 sample-by-sample and detect edges.
    const clockIn = inputs[0]?.[0];

    const pulseWidthSamples = Math.max(1, Math.round(PULSE_WIDTH_S * sr));

    // Output buffer refs. Default fill: drive each output low; pulses are
    // raised back up below. Collect all 13 outputs (0..12 includes swing).
    const outBufs: Float32Array[] = [];
    for (let o = 0; o < 13; o++) {
      const ch = outputs[o]?.[0];
      if (!ch) return true;
      outBufs.push(ch);
    }

    for (let i = 0; i < blockLen; i++) {
      const absSample = this.sampleCount + i;

      // External edge detection.
      if (clockIn) {
        const c = clockIn[i] ?? 0;
        if (this.lastClockSample < CLOCK_THRESHOLD && c >= CLOCK_THRESHOLD) {
          if (this.lastExternalEdgeAt >= 0) {
            const period = absSample - this.lastExternalEdgeAt;
            if (period > 0) {
              this.periodSamples.push(period);
              if (this.periodSamples.length > 4) this.periodSamples.shift();
              this.lastMeasuredPeriod = median(this.periodSamples);
              // Surface the measured BPM to the WEB layer so the card
              // can display the tempo we're actually locked to. Throttle
              // by change: re-post only when the value drifts >0.1 BPM.
              if (this.lastMeasuredPeriod > 0) {
                const measuredBpm = 60 / (this.lastMeasuredPeriod / sr);
                if (Math.abs(measuredBpm - this.lastReportedBpm) > 0.1) {
                  this.lastReportedBpm = measuredBpm;
                  post({ type: 'measuredBpm', bpm: measuredBpm });
                }
              }
            }
          }
          this.lastExternalEdgeAt = absSample;
          // External edge IS the 1x pulse — fire immediately.
          this.fireMaster(absSample, periodForPrediction, swingLagSamples, swingTargetOut, pulseWidthSamples);
          // Snap internal phase so it stays in sync if external drops.
          this.internalPhase = 0;
        }
        this.lastClockSample = c;
      }

      // Internal-clock phase (only if external isn't actively driving).
      if (!externalActive) {
        this.internalPhase += 1;
        if (this.internalPhase >= internalPeriodSamples) {
          this.internalPhase -= internalPeriodSamples;
          this.fireMaster(absSample, periodForPrediction, swingLagSamples, swingTargetOut, pulseWidthSamples);
        }
      }

      // Drain pending queue: anything whose startSample == absSample begins firing.
      // We sort by startSample so a single pass works.
      while (this.pending.length > 0 && this.pending[0]!.startSample <= absSample) {
        const p = this.pending.shift()!;
        // If p.endSample is in the future, raise the gate; if it's already past
        // (happens when blocks are very long or queue ran behind), skip.
        if (p.endSample > absSample) {
          this.outputPulseEnd[p.outIdx] = p.endSample;
        }
      }

      // Write samples — high if currently within a pulse window, else 0.
      // muteOutputs zeros the WRITE; the pulse bookkeeping above still
      // advances so internal phase + the engine-side tick subscribers
      // (LIVECODE clocked() etc.) keep firing.
      const gateLevel = muteOutputs ? 0 : 1;
      for (let o = 0; o < 13; o++) {
        outBufs[o]![i] = this.outputPulseEnd[o]! > absSample ? gateLevel : 0;
      }
    }

    this.sampleCount += blockLen;

    // External-clock dropout: if it's been too long since the last edge but
    // hasExternalClock is still 1 (cable still patched but upstream stopped),
    // we fall back to internal. The internal phase has been advancing in
    // parallel, so it will pick up smoothly.

    return true;
  }

  /** Master pulse fired (from external edge or internal phase wrap).
   *  Schedules: 1x now, master-counter-driven divisors, predicted multipliers,
   *  and the swing copy of whatever swingSource targets.
   */
  private fireMaster(
    atSample: number,
    periodSamples: number,
    swingLagSamples: number,
    swingTargetOut: number,
    pulseWidthSamples: number,
  ): void {
    this.masterCount++;
    // 1x pulse fires now.
    this.scheduleNow(OUT_1X, atSample, pulseWidthSamples);

    // Divisors: the FIRST master pulse fires every divisor, then every Nth
    // after it. `masterCount` is 1-based, so the test is on (n - 1).
    //
    // This used to read `masterCount % ratio === 0` — which fires on the LAST
    // master of each group, not the first, so every divider was phase-shifted
    // late by (ratio - 1) beats. Measured @120 BPM: 1x first fired at sample
    // 23999, /2 at 47999, /4 at 95999, /8 at 191999 — a "/4 bar clock" landing
    // on beat 4 instead of beat 1, and a /64 output that needs 32 seconds
    // before its first pulse. The comment that used to sit here asserted the
    // conventional first-of-group behaviour, which is what the code did not do.
    for (const d of DIVISOR_DEFS) {
      if ((this.masterCount - 1) % d.ratio === 0) {
        this.scheduleNow(d.out, atSample, pulseWidthSamples);
      }
    }

    // Multipliers: schedule (factor-1) future pulses across [atSample,
    // atSample + period). Predictor lag is inherent — the period we're using
    // is from the LAST master interval.
    for (const m of MULTIPLIER_DEFS) {
      if (periodSamples <= 0) continue;
      const subPeriod = periodSamples / m.factor;
      // Sub-pulse 0 is coincident with the master (already scheduled as 1x
      // for OUT_1X but multipliers need their own pulse on the same tick).
      this.scheduleNow(m.out, atSample, pulseWidthSamples);
      for (let k = 1; k < m.factor; k++) {
        const sample = Math.round(atSample + k * subPeriod);
        this.pending.push({
          outIdx: m.out,
          startSample: sample,
          endSample: sample + pulseWidthSamples,
        });
      }
    }

    // Swing: OUT_SWING shadows whichever train SRC selects, holding the
    // OFF-BEATS back by swingLagSamples. Every pulse of the source train is
    // enumerated in time order through scheduleSwing(), which applies the lag
    // to the odd-indexed ones only.
    //
    // This used to add swingLagSamples to EVERY pulse — sub-pulse 0 included —
    // which is not swing, it is a phase offset: the whole train shifted late
    // and stayed perfectly even. Measured @120 BPM with SRC = 2x, intervals
    // were [12000, 12000, 12000, 12000] at swing 0, 30, 60 AND 90; only the
    // train's absolute position moved (+2000 / +4000 / +6000 samples). Same at
    // SRC = 1x and SRC = /2. `docs.controls.swingAmount` has always said "how
    // far the SWING output's OFF-BEATS are pushed late"; nothing did that.
    if (swingTargetOut === OUT_1X) {
      this.scheduleSwing(atSample, swingLagSamples, pulseWidthSamples);
    } else {
      // Match divisor: only fire swing when the divisor itself fires — same
      // first-of-group phase as the divisor branch above.
      for (const d of DIVISOR_DEFS) {
        if (d.out === swingTargetOut && (this.masterCount - 1) % d.ratio === 0) {
          this.scheduleSwing(atSample, swingLagSamples, pulseWidthSamples);
        }
      }
      // Match multiplier: shadow every sub-pulse, k = 0 (the master-coincident
      // one) included, so the on/off-beat alternation is unbroken across
      // master boundaries.
      for (const m of MULTIPLIER_DEFS) {
        if (m.out !== swingTargetOut || periodSamples <= 0) continue;
        const subPeriod = periodSamples / m.factor;
        for (let k = 0; k < m.factor; k++) {
          this.scheduleSwing(atSample + k * subPeriod, swingLagSamples, pulseWidthSamples);
        }
      }
    }

    // Re-sort pending by startSample.
    this.pending.sort((a, b) => a.startSample - b.startSample);
  }

  /** Schedule the next pulse of the swung train. Even indices are on-beats and
   *  fire dead on `baseSample`; odd indices are the off-beats and are held back
   *  by `swingLagSamples`. That alternation IS the shuffle — a lag applied to
   *  every pulse alike just moves the whole train. */
  private scheduleSwing(
    baseSample: number,
    swingLagSamples: number,
    pulseWidthSamples: number,
  ): void {
    const offBeat = (this.swingPulseIndex & 1) === 1;
    this.swingPulseIndex++;
    const start = Math.round(baseSample + (offBeat ? swingLagSamples : 0));
    this.pending.push({
      outIdx: OUT_SWING,
      startSample: start,
      endSample: start + pulseWidthSamples,
    });
  }

  /** Raise a pulse on outIdx starting at atSample, ending at atSample+width. */
  private scheduleNow(outIdx: number, atSample: number, pulseWidthSamples: number): void {
    this.outputPulseEnd[outIdx] = atSample + pulseWidthSamples;
  }
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}
