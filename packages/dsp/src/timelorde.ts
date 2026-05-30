// packages/dsp/src/timelorde.ts
//
// TIMELORDE — central time source. One AudioWorklet, twelve gate outputs:
//   1x, 4x, 2x, 1/2, 1/3, 1/4, 1/8, 1/12, 1/16, 1/32, 1/64, swing
//
// External clock is auto-detected: if a rising edge arrives on input 0
// within ~2 master periods, we follow it; otherwise the internal BPM
// generator drives 1x. Multiplier outputs (4x, 2x) lag by exactly one
// master period due to a predictor-style scheduler — required because
// "the next pulse will arrive at t+P" is only knowable AFTER the current
// pulse fires. Divider outputs are exact (counter-based, no prediction).
//
// Swing: shifts a copy of `swingSource` (default 1x) forward in time by
// (amount/360) of one master period. amount=0 → swingLagSamples=0 → swing
// fires identically to the source (the spec's normaling guarantee).

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

const CLOCK_THRESHOLD = 0.5;
// Gate pulse width (samples). 10 ms at 48 kHz = 480 samples.
const PULSE_WIDTH_S = 0.01;
// External-clock dropout: if no edge has arrived for >EXT_DROPOUT_MULT *
// last_master_period, fall back to internal BPM.
const EXT_DROPOUT_MULT = 2;

// Output indices — keep in sync with module-registry.ts outputs[] order.
const OUT_1X    = 0;
const OUT_8X    = 1;
const OUT_4X    = 2;
const OUT_2X    = 3;
const OUT_HALF  = 4;
const OUT_THIRD = 5;
const OUT_QTR   = 6;
const OUT_8TH   = 7;
const OUT_12TH  = 8;
const OUT_16TH  = 9;
const OUT_32ND  = 10;
const OUT_64TH  = 11;
const OUT_SWING = 12;

// Swing source encoding: 0 = 1x, 1 = 8x, 2 = 4x, 3 = 2x, 4 = 1/2, ..., 11 = 1/64.
// Maps to the same order as outputs above (sans swing itself).
const SWING_SOURCES = [
  OUT_1X, OUT_8X, OUT_4X, OUT_2X, OUT_HALF, OUT_THIRD, OUT_QTR,
  OUT_8TH, OUT_12TH, OUT_16TH, OUT_32ND, OUT_64TH,
];

// Divisor outputs and their integer ratios (master pulses per emit).
const DIVISOR_DEFS: { out: number; ratio: number }[] = [
  { out: OUT_HALF,  ratio: 2 },
  { out: OUT_THIRD, ratio: 3 },
  { out: OUT_QTR,   ratio: 4 },
  { out: OUT_8TH,   ratio: 8 },
  { out: OUT_12TH,  ratio: 12 },
  { out: OUT_16TH,  ratio: 16 },
  { out: OUT_32ND,  ratio: 32 },
  { out: OUT_64TH,  ratio: 64 },
];

// Multiplier outputs and their factors (M-1 sub-pulses scheduled per master).
// 8x: useful for audio-rate clock effects + driving GRIDS-style finely-
// divided patterns. At 120 BPM the master is 2 Hz; 8x = 16 Hz, still
// well under audio rate but fast enough to feel "continuous".
const MULTIPLIER_DEFS: { out: number; factor: number }[] = [
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

class TimelordeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bpm',          defaultValue: 120, minValue: 10,  maxValue: 300, automationRate: 'k-rate' as const },
      { name: 'swingAmount',  defaultValue: 0,   minValue: 0,   maxValue: 90,  automationRate: 'k-rate' as const },
      { name: 'swingSource',  defaultValue: 0,   minValue: 0,   maxValue: 10,  automationRate: 'k-rate' as const },
      // muteOutputs (v2; was isPlaying in v1): 0 = unmuted/audible,
      // 1 = muted. The internal clock generation ALWAYS runs
      // regardless — LIVECODE's clocked() callbacks + any other
      // tick consumers need the clock alive even when gates are off.
      // This is the card's MUTE button (not the external stop gate).
      { name: 'muteOutputs',  defaultValue: 0,   minValue: 0,   maxValue: 1,   automationRate: 'k-rate' as const },
      // running: 1 = clock advances, 0 = clock HALTED (phase
      // accumulator + sample-counter + pending pulses all freeze).
      // Driven by start_in / stop_in transport gates (mirrors a DAW's
      // transport start/stop button). Distinct from muteOutputs:
      // - muteOutputs zeroes the audible gate level but the internal
      //   clock keeps running so LIVECODE's clocked() callbacks fire.
      // - running=0 actually PAUSES the clock; on resume, the
      //   internal phase / counters pick up from where they stopped
      //   (musical position preserved across a stop, matching DAW
      //   transport semantics).
      { name: 'running',      defaultValue: 1,   minValue: 0,   maxValue: 1,   automationRate: 'k-rate' as const },
      // hasExternalClock is set to 1 by the engine factory whenever an edge
      // is patched into input 0 (declarative, not measured). Drives whether
      // the play button is honored or always-on.
      { name: 'hasExternalClock', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

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

  // Currently-firing pulses: one per output (a new pulse that overlaps an
  // existing one truncates it — gates can't be "1.5"). We track each output's
  // pulse-end sample so process() can drop the gate at the right moment.
  private outputPulseEnd = new Int32Array(12);

  // (v1) prevPlaying tracked stop-transition resets; v2 doesn't stop
  // the internal clock, so nothing to track here. Field removed.

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
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
      for (let o = 0; o < 12; o++) {
        const ch = outputs[o]?.[0];
        if (!ch) continue;
        for (let i = 0; i < blockLen; i++) ch[i] = 0;
      }
      return true;
    }

    const internalPeriodSamples = Math.max(1, (60 / Math.max(1, bpm)) * sampleRate);

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
      this.port.postMessage({ type: 'measuredBpm', bpm: 0 });
    }
    this.wasExternalActive = externalActive;

    const periodForPrediction =
      externalActive && this.lastMeasuredPeriod > 0
        ? this.lastMeasuredPeriod
        : internalPeriodSamples;

    const swingLagSamples = Math.max(0, (swingAmount / 360) * periodForPrediction);
    const swingTargetOut = SWING_SOURCES[swingSourceIdx]!;

    // External clock buffer — read input 0 sample-by-sample and detect edges.
    const clockIn = inputs[0]?.[0];

    const pulseWidthSamples = Math.max(1, Math.round(PULSE_WIDTH_S * sampleRate));

    // Output buffer refs. Default fill: drive each output low; pulses are
    // raised back up below.
    const outBufs: Float32Array[] = [];
    for (let o = 0; o < 12; o++) {
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
                const measuredBpm = 60 / (this.lastMeasuredPeriod / sampleRate);
                if (Math.abs(measuredBpm - this.lastReportedBpm) > 0.1) {
                  this.lastReportedBpm = measuredBpm;
                  this.port.postMessage({ type: 'measuredBpm', bpm: measuredBpm });
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
      for (let o = 0; o < 12; o++) {
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

    // Divisors: every Nth master pulse (counter starts at 1 — first pulse
    // fires every divisor too, which is the conventional "pulse at every
    // N-multiple" pattern users expect from a clock divider).
    for (const d of DIVISOR_DEFS) {
      if (this.masterCount % d.ratio === 0) {
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

    // Swing: the source pulse fires at atSample (or whenever its own
    // logic dictates), and a *copy* on OUT_SWING fires at atSample +
    // swingLag. When swingLag = 0 this is a duplicate of the source —
    // perfect normaling. When source = 1x and lag > 0, swing trails 1x.
    //
    // For divisors and multipliers as swing sources we'd need to shadow
    // their schedule logic; v1 implements: the swing pulse fires whenever
    // the source's most-recent pulse fired, plus the lag. We approximate
    // by scheduling a swing pulse aligned with this 1x master if the
    // source IS 1x; for divisors, only when masterCount % ratio === 0;
    // for multipliers, alongside each scheduled sub-pulse.
    const swingStart = atSample + swingLagSamples;
    if (swingTargetOut === OUT_1X) {
      this.pending.push({
        outIdx: OUT_SWING,
        startSample: Math.round(swingStart),
        endSample: Math.round(swingStart) + pulseWidthSamples,
      });
    } else {
      // Match divisor: only fire swing when the divisor itself fires.
      for (const d of DIVISOR_DEFS) {
        if (d.out === swingTargetOut && this.masterCount % d.ratio === 0) {
          this.pending.push({
            outIdx: OUT_SWING,
            startSample: Math.round(swingStart),
            endSample: Math.round(swingStart) + pulseWidthSamples,
          });
        }
      }
      // Match multiplier: schedule sub-pulses with the same swing offset.
      for (const m of MULTIPLIER_DEFS) {
        if (m.out !== swingTargetOut || periodSamples <= 0) continue;
        const subPeriod = periodSamples / m.factor;
        // Sub-pulse 0 = master.
        this.pending.push({
          outIdx: OUT_SWING,
          startSample: Math.round(swingStart),
          endSample: Math.round(swingStart) + pulseWidthSamples,
        });
        for (let k = 1; k < m.factor; k++) {
          const s = Math.round(atSample + k * subPeriod + swingLagSamples);
          this.pending.push({
            outIdx: OUT_SWING,
            startSample: s,
            endSample: s + pulseWidthSamples,
          });
        }
      }
    }

    // Re-sort pending by startSample.
    this.pending.sort((a, b) => a.startSample - b.startSample);
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

registerProcessor('timelorde', TimelordeProcessor);
