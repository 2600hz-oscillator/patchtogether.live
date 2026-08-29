// packages/web/src/lib/audio/modules/tempolock.ts
//
// TEMPOLOCK — beat-tracking clock: a raw onset train in, a STEADY tracked
// quarter-note clock out.
//
// WHY (owner-driven, 2026-08-29): the rack's clock consumers — TIMELORDE's
// CLOCK IN and backdraft's delay_clock — are LAST-INTERVAL FOLLOWERS: they
// lock to the gap between the last two rising edges. That is right for a
// clock cable and wrong for a BEAT cable. SYNESTHESIA's per-band onset
// trigger fires on every kick, and real kick patterns are not
// four-on-the-floor: at 108 BPM with kicks on steps 1,5,7,9,13,15 of a
// 16-step bar the inter-onset gaps run 555.6/277.8/277.8/555.6/277.8/277.8 ms
// and a follower flaps between 216 and 108 BPM. TEMPOLOCK sits between the
// onset source and the clock consumers: it recovers the underlying tempo
// (greatest-common-pulse over the inter-onset intervals, folded into a
// preferred BPM band by octave), locks a phase accumulator to it, and emits
// its OWN steady quarter-note pulses — never a passthrough of input edges.
// Patch SYNESTHESIA.band1_trig → TEMPOLOCK.in → TIMELORDE.clock and the whole
// rack (and the delay) syncs to the detected 108.
//
// All tracking math is pure and tick-based in $lib/audio/tempolock/
// tempolock-tracker.ts (the cv-buddy clock-math discipline), unit-tested
// against the owner's case verbatim AND the owner's real recorded onset train
// (tempolock-tracker.test.ts). This file is only the graph plumbing:
//
//   in  ──gain──analyser──▶ createEdgeCounter (the ONE main-thread seam,
//                            CLAUDE.md "Triggers vs gates") ─▶ tracker.tick()
//                            on every scheduler-clock tick
//   tracker pulses ──▶ ConstantSource `clock` (fireTrigger-style scheduling,
//                      the midiclock/cv-buddy output shape)
//   tracker bpm    ──▶ ConstantSource `bpm` (unipolar CV, see scale below)
//   tracker locked ──▶ ConstantSource `locked` (held level)
//
// Inputs:
//   in (gate, edge='trigger', accepts cv/pitch): the onset train. Rising
//     edges only; the level is never read.
//
// Outputs:
//   clock (gate, trigger): steady quarter-note pulses at the tracked tempo,
//     generated from the internal phase accumulator. Silent until the FIRST
//     lock; free-runs forever after it (a dropout coasts, never stops — the
//     whole rack may be synced to this jack).
//   bpm (cv): the tracked tempo as a unipolar level, bpm/300 (see
//     TEMPOLOCK_BPM_CV_SCALE). 0 until the first lock.
//   locked (gate, level): HIGH while the tracker is confidently locked;
//     drops after ~4 missed expected beats while the clock keeps running.
//
// Params:
//   range (discrete 0..2): the preferred tempo band the detected pulse is
//     folded into by octave — 60-120 / 90-180 (default) / 120-240. The one
//     genuinely musical choice a tracker cannot make for you (the same
//     pattern honestly reads as 87 or 174 depending on the genre). Everything
//     else (tolerances, PLL gains, lock thresholds) ships as constants in the
//     tracker — v1 deliberately exposes no tuning surface; a knob per gain
//     would be five ways to break the lock and no way to improve it.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createEdgeCounter } from '$lib/audio/edge-detect';
import { openGate, closeGate } from '$lib/audio/gate-trigger';
import { snapToOptions } from '$lib/ui/controls/knob-vocabulary-model';
import {
  createTempolockTracker,
  TEMPOLOCK_BANDS,
  TEMPOLOCK_DEFAULT_BAND_INDEX,
  type TempolockMode,
} from '$lib/audio/tempolock/tempolock-tracker';

/** Clock look-ahead window (s) — the cv-buddy step-scheduler discipline:
 *  schedule a window, not a single event, so pulses between ~25 ms ticks are
 *  pre-scheduled. The tracker's phase cursor deduplicates the overlap. */
const CLOCK_LOOKAHEAD_S = 0.2;

/** Emitted clock pulse width. 10 ms per ADR-004's gate convention ("chosen so
 *  a 60fps polling tap can't miss it") rather than the 5 ms TRIGGER_PULSE_S:
 *  this jack's whole purpose is to be consumed by OTHER modules' edge
 *  detectors, including frame-rate video-side taps, and the slowest tracked
 *  clock period (250 ms at the 120-240 band's top) leaves a clean fall
 *  either way. */
export const TEMPOLOCK_CLOCK_PULSE_S = 0.01;

/**
 * THE BPM CV SCALE: `bpm` emits trackedBpm / 300, unipolar 0..1.
 *
 * ADR-004 gives value-carrying CV sources a normalized 0..1 / ±1 range but no
 * tempo unit — nothing else in the registry emits a BPM-valued CV (checked:
 * midiclock's `run` is a 0/1 level; cv-buddy publishes no tempo jack). The
 * full-scale of 300 is TIMELORDE's declared bpm max (TIMELORDE_BPM_MAX), so
 * the one existing tempo authority and this jack agree on what 1.0 means, and
 * every representable band tempo (≤ 240 × the octave-hysteresis stretch)
 * fits with headroom. 0 means "no lock yet", which is also the honest resting
 * CV. The constant is exported so tests and downstream docs derive from it.
 */
export const TEMPOLOCK_BPM_CV_SCALE = 300;

/** Card/face-readable snapshot via `handle.read('state')` (the cv-buddy
 *  CvBuddyClockState shape — read(), never readParam, because readParam is
 *  fronted by the engine's declared-param cache). */
export interface TempolockState {
  mode: TempolockMode;
  locked: boolean;
  /** Tracked quarter-note BPM; null before the first lock ever. */
  bpm: number | null;
  /** A clock rising edge landed within the last ~150 ms (beat lamp). */
  beatRecent: boolean;
  /** Cumulative pulses a late scheduler tick could not place (diagnostic —
   *  the cv-buddy `skips` discipline: countable, never silent). */
  skips: number;
}

export const tempolockDef: AudioModuleDef = {
  type: 'tempolock',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'tempolock',
  category: 'utility',
  // Declared on the def (the rack-sizes.ts stated preference for NEW modules,
  // the stereovca/dockscope shape): the legacy card is the SampleHoldCard
  // layout at 220 px wide — one knob group over the PatchPanel — so it sits on
  // the 1u tile at 2 hp (sampleHold itself is 1u/2 at 260 px; 220 px rounds to
  // 1 hp but the 4-port PatchPanel row wants the second tile's width).
  size: '1u',
  hp: 2,
  inputs: [
    // The onset train. edge: 'trigger' — rising edges only, the level is
    // never read. `accepts` widens the jack to cv/pitch cables the same way
    // GATEMAIDEN's converter input does: the canonical source is SYNESTHESIA's
    // band trigger (a gate), but an LFO square or any pulsy CV is a perfectly
    // good tempo source and the tracker only ever sees edges.
    { id: 'in', type: 'gate', edge: 'trigger', accepts: ['cv', 'pitch'] },
  ],
  outputs: [
    // Order is deliberate: `clock` is the module's product and the jack the
    // whole rack syncs from; `bpm` and `locked` are telemetry about it.
    { id: 'clock',  type: 'gate', edge: 'trigger' },
    { id: 'bpm',    type: 'cv' },
    // Level-semantic gate: HIGH while locked, not a pulse.
    { id: 'locked', type: 'gate', edge: 'gate' },
  ],
  params: [
    // The preferred tempo band for the octave fold. A discrete roster rather
    // than a free knob: the fold bands are the module's whole vocabulary and
    // a continuous "centre BPM" would invite dialing the tracker off its own
    // evidence. Labels are ASCII (the gatemaiden VRT-font rule).
    {
      id: 'range',
      label: 'Band',
      defaultValue: TEMPOLOCK_DEFAULT_BAND_INDEX,
      min: 0,
      max: 2,
      curve: 'discrete',
      options: [
        {
          value: 0,
          label: '60-120',
          title: 'Fold the detected pulse into 60-120 BPM — downtempo / half-time reads.',
        },
        {
          value: 1,
          label: '90-180',
          title: 'Fold the detected pulse into 90-180 BPM (default) — the owner\'s 108 case and most dance-floor tempi.',
        },
        {
          value: 2,
          label: '120-240',
          title: 'Fold the detected pulse into 120-240 BPM — footwork / DnB reads of the same pattern.',
        },
      ],
    },
  ],

  docs: {
    explanation:
      "A beat-tracking clock: patch a messy, musical onset train in (SYNESTHESIA's per-band beat trigger firing on every kick is the canonical source) and TEMPOLOCK works out the underlying tempo and emits its OWN steady quarter-note clock at it — never a copy of the input edges. It exists because the rack's clock inputs (TIMELORDE's CLOCK IN, backdraft's delay clock) follow the gap between the last two edges, which is right for a clock cable and wrong for a beat: real kick patterns mix quarter and eighth gaps, so a follower flaps between double and single tempo (108 vs 216 on the owner's pattern). TEMPOLOCK instead treats the gaps between onsets as whole-number multiples of one underlying pulse, finds that pulse, folds it into your preferred BPM band by halving/doubling, and locks a phase accumulator to it — onsets near predicted beats or half-beats gently nudge the clock's phase (a PLL), onsets far off-grid are ignored, and the tempo follows gradual changes smoothly. Once locked it NEVER stops: if the input goes silent the clock free-runs at the last tempo (the whole rack may be synced to it) while LOCKED drops after about four missed beats, and it relocks cleanly when onsets return. From cold it is silent until the first confident lock — about four consistent intervals — so patching it in never injects a made-up tempo. Chain: SYNESTHESIA.band1_trig → TEMPOLOCK.in, TEMPOLOCK.clock → TIMELORDE.clock, and the whole rack syncs to the detected tempo.",
    inputs: {
      in:
        "The onset train to track — any gate/trigger (or pulsy CV/pitch) whose rising edges land on the music's beat grid: SYNESTHESIA's band triggers, a drum machine's accent out, an envelope follower's gate. Only rising edges are read. The gaps between them are treated as whole-number multiples of one base pulse, so the pattern does NOT need to be four-on-the-floor — kicks on quarters and eighths, with a beat skipped here and there, still lock. Onsets closer than ~70 ms apart are treated as one strike (detector double-fires), and a gap longer than ~3 s is treated as a dropout rather than a tempo.",
    },
    outputs: {
      clock:
        "The tracked clock: steady quarter-note pulses (10 ms wide) at the detected tempo, generated by the module's own phase accumulator — the input edges are never passed through. Silent from cold until the first lock (the first pulse IS the lock announcement); after that it free-runs forever, straight through input dropouts, so everything synced to it keeps time. Patch into TIMELORDE's CLOCK IN to sync the whole rack, or any clock input that expects an even pulse.",
      bpm:
        "The tracked tempo as a unipolar CV level: BPM divided by 300 (TIMELORDE's own bpm ceiling), so 108 BPM reads 0.36 and 1.0 would mean 300. Holds 0 until the first lock, then follows the tracked tempo smoothly — including while the clock is coasting through an input dropout. A telemetry level, not a pulse: patch it wherever a slowly-moving tempo-proportional CV is useful.",
      locked:
        "Confidence gate, level-semantic: HIGH while the tracker is confidently locked to the incoming onsets, LOW from cold and again after about four expected beats pass with nothing landing on the predicted grid (the clock itself keeps running — this jack is how you know it is coasting on memory rather than following live input). Goes HIGH again once returning onsets line back up.",
    },
    controls: {
      range:
        "BAND — the octave the detected tempo is folded into: 60-120, 90-180 (default) or 120-240 BPM. A pulse train cannot say which octave it means (eighth-note kicks at 108 measure identically to quarter-note kicks at 216), so the tracker halves/doubles the detected pulse until it lands in this band — the owner's mixed pattern reads 216 at the pulse level and folds to 108. Switching the band while locked re-folds the current tempo immediately; near a band edge the tracker prefers staying in the octave it is already locked to (hysteresis), so a tempo drifting across the boundary does not flip octaves mid-performance.",
    },
  },

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // One ranked control (the band selector) over a status body carrying the
  // LOCK and BEAT lamps — the smallest honest surface for a module whose
  // whole job is a judgement ("what tempo is this?") that params cannot show.
  //
  // MERIT: the one param is a genuine performance choice (which octave the
  // rack runs at), and the two lamps are the module's only observable state
  // that no jack can show at a glance — `locked` is on a cable, but a cable
  // needs something patched to read it. The tracked BPM VALUE is deliberately
  // NOT painted anywhere at rest: a readout is derived-state text, the exact
  // shape the resting-text rulings deleted fleet-wide (#1957 and the
  // 2026-08-19 four; TIMELORDE's own face dropped its BPM footer for the same
  // reason). It lives on the LOCK lamp's `detail` — aria-label/title —
  // speakable, assertable, hoverable, unpainted (tempolock-status-model.ts).
  //
  // `glyph: 'none'` is FORCED, not chosen: `primaryAudioOutPortId` matches
  // `type === 'audio'` and this def's outputs are gate/cv/gate, so every
  // other literal resolves `{kind:'static'}` and reddens the dead-glyph
  // clause (the gatemaiden situation, port for port). The face renders
  // `.faceplate.gate` — the class comes from the CABLE TYPE.
  //
  // TIER LADDER AS A SENTENCE: every tier shows BAND (one control is under
  // every cap); the dock adds the lamp body (dock-only by
  // dockFullViewHeadPlan — a 192 px lane tile cannot carry a status strip,
  // the cvBuddy precedent).
  face: {
    order: ['range'],
    glyph: 'none',
    extension: 'tempolock',
    pages: [
      {
        id: 'band',
        label: 'tempo band',
        hint:
          'Which octave the detected tempo is folded into. A beat pattern cannot say whether it means 108 or 216 — eighth-note kicks measure identically — so the tracker halves/doubles the detected pulse until it lands in this band. Near a band edge it prefers the octave it is already locked to, so a drifting tempo does not flip mid-performance.',
        controls: ['range'],
      },
    ],
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ── input tap: gain → analyser, silence keep-alive, shared edge counter ─
    const inGain = ctx.createGain();
    inGain.gain.value = 1;
    const inAna = ctx.createAnalyser();
    // 16384 samples ≈ 341 ms @ 48 kHz — the #229 stall headroom TIMELORDE's
    // transport taps use: a canvas-drag main-thread stall must not overwrite
    // onsets before the next poll drains them.
    inAna.fftSize = 16384;
    inAna.smoothingTimeConstant = 0;
    inGain.connect(inAna);
    const inSilence = ctx.createConstantSource();
    inSilence.offset.value = 0;
    inSilence.start();
    inSilence.connect(inGain);
    const counter = createEdgeCounter({ ctx, analyser: inAna });

    // ── outputs: one ConstantSource per jack (the midiclock shape) ──────────
    const clockSrc = ctx.createConstantSource();
    clockSrc.offset.value = 0;
    clockSrc.start();
    const bpmSrc = ctx.createConstantSource();
    bpmSrc.offset.value = 0;
    bpmSrc.start();
    const lockedSrc = ctx.createConstantSource();
    lockedSrc.offset.value = 0;
    lockedSrc.start();

    // ── params ──────────────────────────────────────────────────────────────
    const rangeParam = tempolockDef.params[0]!;
    function snapRange(v: number): number {
      // The point of use, not a point of arrival (the midiclock snapDivisor
      // discipline): a peer's Y update or an undo can deliver any number.
      return snapToOptions(v, rangeParam.options ?? []);
    }
    let range = snapRange((node.params ?? {})[rangeParam.id] ?? (rangeParam.defaultValue as number));

    // ── the tracker ─────────────────────────────────────────────────────────
    const tracker = createTempolockTracker({ band: TEMPOLOCK_BANDS[range]! });

    let lastBpmLevel = 0;
    let lastLockedLevel = 0;
    let lastPulseAt: number | null = null;
    let skips = 0;
    let lastResult: { bpm: number | null; locked: boolean; mode: TempolockMode } = {
      bpm: null,
      locked: false,
      mode: 'cold',
    };

    function tick(): void {
      try {
        const now = ctx.currentTime;
        const onsets = counter.poll(now);
        const res = tracker.tick({ nowS: now, onsets, winEnd: now + CLOCK_LOOKAHEAD_S });
        for (const t of res.pulses) {
          openGate(clockSrc, t);
          closeGate(clockSrc, t + TEMPOLOCK_CLOCK_PULSE_S);
          if (t <= now + CLOCK_LOOKAHEAD_S) lastPulseAt = t;
        }
        if (res.skipped > 0) {
          skips += res.skipped;
          console.warn(
            `[tempolock] clock tick arrived late — ${res.skipped} pulse(s) could not be ` +
              `scheduled (${skips} total).`,
          );
        }
        const bpmLevel = res.bpm === null ? 0 : Math.min(1, Math.max(0, res.bpm / TEMPOLOCK_BPM_CV_SCALE));
        if (Math.abs(bpmLevel - lastBpmLevel) > 1e-4) {
          lastBpmLevel = bpmLevel;
          bpmSrc.offset.setValueAtTime(bpmLevel, now);
        }
        const lockedLevel = res.locked ? 1 : 0;
        if (lockedLevel !== lastLockedLevel) {
          lastLockedLevel = lockedLevel;
          lockedSrc.offset.setValueAtTime(lockedLevel, now);
        }
        lastResult = { bpm: res.bpm, locked: res.locked, mode: res.mode };
      } catch (err) {
        console.error('[tempolock] tick error', err);
      }
    }
    const unsubscribeTick = getSchedulerClock().subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map([['in', { node: inGain, input: 0 }]]),
      outputs: new Map([
        ['clock', { node: clockSrc, output: 0 }],
        ['bpm', { node: bpmSrc, output: 0 }],
        ['locked', { node: lockedSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'range') {
          range = snapRange(value);
          tracker.setBand(TEMPOLOCK_BANDS[range]!);
        }
      },
      readParam(paramId) {
        if (paramId === 'range') return range;
        return undefined;
      },
      read(key) {
        if (key === 'state') {
          const now = ctx.currentTime;
          const state: TempolockState = {
            mode: lastResult.mode,
            locked: lastResult.locked,
            bpm: lastResult.bpm,
            beatRecent: lastPulseAt !== null && now - lastPulseAt >= 0 && now - lastPulseAt < 0.15,
            skips,
          };
          return state;
        }
        return undefined;
      },
      dispose() {
        unsubscribeTick();
        try { inSilence.stop(); } catch { /* already stopped */ }
        try { clockSrc.stop(); } catch { /* already stopped */ }
        try { bpmSrc.stop(); } catch { /* already stopped */ }
        try { lockedSrc.stop(); } catch { /* already stopped */ }
        inSilence.disconnect();
        inGain.disconnect();
        inAna.disconnect();
        clockSrc.disconnect();
        bpmSrc.disconnect();
        lockedSrc.disconnect();
      },
    };
  },
};
