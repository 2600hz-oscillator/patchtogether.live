// packages/web/src/lib/audio/modules/cv-buddy.ts
//
// CV BUDDY — the note-sink half of the ES-9 note-lane bridge (Part A).
//
// You hand-patch a clip lane's pitch / gate / velocity into CV Buddy's inputs;
// CV Buddy passes them straight through to CV/gate OUTPUTS which the CV-Buddy↔
// ES-9 reconciler (graph/cv-buddy-es9-reconcile.ts) auto-routes to the ES-9's
// physical DC-coupled output jacks by slot, and — on the id-smallest instance —
// GENERATES a hardware RUN gate + CLOCK pulse train phase-locked to the rack
// transport (TIMELORDE). So a rack sequence plays a real Eurorack voice: pitch
// → 1 V/oct, gate → +5 V, velocity → CV, plus RUN + DIN-sync CLOCK for Pam's.
//
// CRITICAL CONTRACT (adversarial): the outputs are pitchCv(cv) / gate(gate) /
// velCv(cv) / run(gate) / clock(gate) — NONE typed 'pitch', and there is NO
// poly output. That keeps `isNoteSource(def)` FALSE (patch-convenience.ts), so
// CV Buddy is a note SINK (a clip lane can drive it) and never disqualifies
// itself from RECEIVING note data. The v/oct lives on a `cv` cable; the ES-9's
// per-jack `out{N}_class=pitch` does the 1 V/oct (×0.1) scaling downstream. CV
// Buddy has NO audio-typed output → resolveMainAudioOut() === null → it is
// never a mixer-send island (planSendToMixer never fires) — no suppression
// needed, verified by cv-buddy.test.ts.
//
// PASSTHROUGH: pitch/gate/velocity inputs are unity-gain GainNodes whose output
// IS the corresponding pitchCv/gate/velCv output (no worklet, no scaling — the
// signal is already in app units; the ES-9 class does the volt scaling).
//
// CLOCK + RUN (owner instance only, id-smallest — allocateCvBuddySlots):
//   * RUN — a ConstantSource held HIGH while the transport is playing, LOW when
//     stopped. It FOLLOWS play state; it does NOT pulse.
//   * CLOCK — a ConstantSource onto which the scheduler tick places short GATE
//     pulses at a PHASE ACCUMULATOR running at PPQN·bpm, only while the
//     transport runs. Non-owner instances leave run + clock at 0.
//
// ⚠ THE FORMER "KNOWN QUIRK" IS FIXED — do not re-derive it. This header used
// to record, as deferred, that the ES-9 gate class held its last voltage on an
// underrun and so froze a clock edge HIGH. #1399 gave the gate class the FADE
// policy (es9.ts `es9OutputModes` — cv/pitch still HOLD, because 0 V = C4 would
// be a wrong note; gate and audio both fail LOW), so a stream hiccup now drops
// the clock line rather than welding it high. The same PR replaced the absolute
// t=0 pulse grid with the accumulator above, because a tempo write teleported
// the phase by up to a whole period.
//
// Those were the two SILENT mechanisms behind "Pam's locks to it but not
// flawlessly". Since both were invisible, the counter that tells the remaining
// candidates apart is now part of the contract: `read('state').skips` counts
// pulses a LATE scheduler tick could not place, and the ES-9 card's `xruns`
// counts bridge starvation. Rising skips = main-thread scheduling; rising xruns
// = the jack is starving; neither = look elsewhere. Both are on-screen so the
// next report is a measurement instead of an impression.
//
// ⚠ THE CLOCK IS EMITTED ON THE AUDIO THREAD when the environment has an
// AudioWorklet (every real browser): the SPEEDERR-001 performance (ledger item
// 10) lost exactly ONE pulse to a 200–360 ms main-thread stall against the
// 200 ms lookahead — drop-not-flush held, margin didn't. So the RUN + CLOCK
// jacks are driven by the 'cv-clock' processor (packages/dsp/src/seq-clock.ts
// → lib/cv-clock-core.ts), which renders the same accumulator law per sample
// on the audio thread; a main-thread stall can then starve only the CONFIG
// messages (a tempo edit applies a tick late) and never the pulse train. The
// scheduler tick below KEEPS RUNNING as the config pusher AND as a shadow of
// the old path, so `skips` still measures main-thread stalls — under the
// worklet a rising count means "the audio-thread clock absorbed this", and
// read('clockHealth') says which driver owns the jack. In test/SSR (no
// AudioWorklet) the main-thread path drives the jacks exactly as before, which
// is the path the #2324 invariant suite pins.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { openGate, closeGate, GATE_HI } from '$lib/audio/gate-trigger';
import { createWorkletNode } from '$lib/audio/worklet-guard';
import seqClockWorkletUrl from '@patchtogether.live/dsp/dist/seq-clock.js?url';
import {
  advanceClock,
  idleClockPhase,
  CLOCK_PULSE_HIGH_S,
  type ClockPhase,
} from '$lib/audio/cv-buddy/clock-math';
import {
  allocateCvBuddySlots,
  type CvBuddyKind,
  type CvBuddyInstance,
} from '$lib/audio/cv-buddy/slot-alloc';
import type { ModuleFace, ModuleNode, ParamDef } from '$lib/graph/types';
import { snapToOptions } from '$lib/ui/controls/knob-vocabulary-model';

/**
 * Card-readable shape exposed via `handle.read('state')`, so the Svelte card
 * can paint live clock status without reaching into the engine internals.
 *
 * ⚠ `skips` deliberately rides HERE and not on `readParam`. `readParam` is
 * fronted by the engine's `knobValues` cache, which is seeded for every
 * DECLARED param — a diagnostic counter reads through only because it is not
 * declared, i.e. by accident of a rule that is not about it. Declare `skips`
 * as a param one day and the card would freeze at the seeded value with
 * nothing red. `read()` has no cache in front of it.
 */
export interface CvBuddyClockState {
  /** Is THIS instance the id-smallest one that drives ES-9 jacks 7/8? */
  ownsClock: boolean;
  running: boolean;
  bpm: number;
  /**
   * Cumulative clock pulses a LATE scheduler tick could not place, since the
   * node was materialized. Monotonic; never reset while the node lives, so the
   * card can show a total rather than a per-tick blip that is gone before
   * anyone looks at it.
   */
  skips: number;
}

/**
 * Which mechanism is actually driving the RUN + CLOCK jacks, via
 * `read('clockHealth')` — a SEPARATE key from `read('state')` on purpose:
 * the #2324 invariant suite pins the exact shape of `state`, and the shape it
 * pins is the main-thread contract, which this does not change.
 */
export interface CvBuddyClockHealth {
  /** 'worklet' — the audio-thread cv-clock processor owns the jacks
   *  (stall-immune); 'main' — the scheduler-tick path (test/SSR, or a context
   *  whose AudioWorklet failed to load). */
  driver: 'worklet' | 'main';
  /** The same main-thread late-tick counter as `read('state').skips`. Under
   *  the worklet driver it keeps counting — it measures main-thread stalls the
   *  audio-thread clock ABSORBED, which is still the diagnostic that tells a
   *  UI stall from an ES-9 underrun. */
  skips: number;
  /** Cumulative pulses the worklet has emitted (0 under the main driver) —
   *  the live "the clock is actually running" signal, reported by the
   *  processor itself so a silent worklet cannot present as healthy. */
  workletPulses: number;
  /** Cumulative pulses the worklet dropped-and-counted (config jumps; see
   *  cv-clock-core.ts). Under a healthy clock this stays 0. */
  workletSkips: number;
  /** CONTEXT seconds `workletPulses` covers, from the same health snapshot.
   *  ⚠ The counter is meaningful ONLY against this clock: a null-sink or
   *  contended render thread runs ahead of or behind wall time (CI shard 11
   *  measured both directions), so `pulses ÷ wall-elapsed` compares two
   *  different clocks and reads high AND low with no pulse wrong; `pulses` vs
   *  `renderedS × rate` is exact within ±1 by construction. */
  workletRenderedS: number;
  /** Inter-pulse gap extremes (context s), measured at the emitting sample —
   *  under a constant tempo both sit at one period (±1 sample): min below
   *  period = bunching, max above = a hole. Null until two pulses have fired
   *  within one train. */
  workletMinGapS: number | null;
  workletMaxGapS: number | null;
}

/** Contexts whose audioWorklet already loaded the seq-clock module (which
 *  registers the 'cv-clock' processor) — one addModule per context, the
 *  kickdrum.ts idiom. */
const seqClockModuleLoaded = new WeakSet<BaseAudioContext>();

/** The discrete PPQN menu the card offers (pulses per quarter note). 24 =
 *  DIN-sync default. */
export const CV_BUDDY_PPQN_CHOICES: readonly number[] = [1, 2, 4, 8, 12, 24, 48];
export const CV_BUDDY_DEFAULT_PPQN = 24;

/**
 * Land a PPQN on a legal division — the module's use of the ONE shared
 * `snapToOptions`, so the value the clock runs at and the value the selector
 * shows can never be two different answers.
 *
 * Exported because `cv-buddy-node-lifetime.test.ts` and the vocabulary gate both
 * assert the snap rather than trusting it.
 */
export function snapPpqn(v: number): number {
  return snapToOptions(v, CV_BUDDY_PPQN_PARAM.options ?? []);
}

/** Clock look-ahead window (s). ≥ the 25 ms scheduler tick so pulses BETWEEN
 *  ticks are pre-scheduled (the step-scheduler discipline: schedule a window,
 *  not a single event like the MIDI bridge's SCHED_LOOKAHEAD_S). At the fastest
 *  clock (300 BPM × 48 PPQN ≈ 4.2 ms period) a 25 ms tick would otherwise drop
 *  pulses. */
const CLOCK_LOOKAHEAD_S = 0.2;

/** Read the single TIMELORDE transport node from the live patch (mirrors
 *  clipplayer's transport reads). */
function timelordeNode(): { params?: Record<string, number> } | undefined {
  for (const n of Object.values(livePatch.nodes)) {
    if (n && (n as { type?: string }).type === 'timelorde') {
      return n as { params?: Record<string, number> };
    }
  }
  return undefined;
}
function transportRunning(): boolean {
  const t = timelordeNode();
  if (!t) return true; // no TIMELORDE in rack → free-run (the clip player convention)
  const v = t.params?.running;
  return typeof v === 'number' ? v >= 0.5 : true;
}
function transportBpm(): number {
  const v = timelordeNode()?.params?.bpm;
  return typeof v === 'number' && v > 0 ? v : 120;
}

/** True when THIS node id is the id-smallest CV Buddy — the owner that drives
 *  the RUN + CLOCK jacks. */
function ownsTransport(thisId: string): boolean {
  // BOTH kinds compete for the clock: the id-smallest CV Buddy of either kind
  // owns RUN + CLOCK. Counting only 'cvBuddy' here would let a rack of minis
  // believe nobody owned the transport, and jacks 7/8 would go dead.
  const insts: CvBuddyInstance[] = [];
  for (const n of Object.values(livePatch.nodes)) {
    const t = (n as { type?: string } | undefined)?.type;
    if (t === 'cvBuddy') insts.push({ id: (n as { id: string }).id, kind: 'full' });
    else if (t === 'cvBuddyMini') insts.push({ id: (n as { id: string }).id, kind: 'mini' });
  }
  return allocateCvBuddySlots(insts).get(thisId)?.ownsClock === true;
}

/**
 * The SHARED CV Buddy engine handle, used by BOTH `cvBuddy` and
 * `cvBuddyMini`.
 *
 * ⚠ ONE implementation on purpose. The bulk of this is the RUN + CLOCK
 * generator that the id-smallest instance drives onto ES-9 jacks 7/8 — the
 * thing Pam's locks to. Two copies of that would be two clocks free to drift
 * apart in behaviour, and a timing bug fixed in one would silently survive in
 * the other. `kind` changes exactly one thing: a MINI has no velocity.
 */
export async function createCvBuddyHandle(
  ctx: AudioContext,
  node: ModuleNode,
  kind: CvBuddyKind = 'full',
): Promise<AudioDomainNodeHandle> {
  const hasVelocity = kind === 'full';
    const thisId = node.id;

    // ---- unity-gain passthrough for pitch/gate/velocity ----
    const mkPass = () => {
      const g = ctx.createGain();
      g.gain.value = 1;
      return g;
    };
    const pitchPass = mkPass();
    const gatePass = mkPass();
    const velPass = mkPass();

    // ---- generated RUN + CLOCK sources (owner only) ----
    // These main-thread sources ALWAYS run. When the cv-clock worklet is
    // available they are not connected to the jacks — the tick keeps
    // scheduling onto them as a SHADOW of the old path, purely so the `skips`
    // late-tick counter keeps measuring main-thread stalls (see the header).
    const runSrc = ctx.createConstantSource();
    runSrc.offset.value = 0;
    runSrc.start();
    const clockSrc = ctx.createConstantSource();
    clockSrc.offset.value = 0;
    clockSrc.start();

    // ---- the audio-thread clock (the SPEEDERR-001 structural fix) ----
    // Best-effort and NEVER throws: in test/SSR there is no `audioWorklet`, a
    // CSP can refuse the module, an older browser can lack support — in every
    // such case `clockWorklet` stays null and the main-thread path drives the
    // jacks byte-identically to before.
    let clockWorklet: AudioWorkletNode | null = null;
    let workletPulses = 0;
    let workletSkips = 0;
    let workletRenderedS = 0;
    let workletMinGapS: number | null = null;
    let workletMaxGapS: number | null = null;
    try {
      const aw = (ctx as { audioWorklet?: { addModule(u: string): Promise<void> } })
        .audioWorklet;
      if (aw && typeof aw.addModule === 'function') {
        if (!seqClockModuleLoaded.has(ctx)) {
          await aw.addModule(seqClockWorkletUrl);
          seqClockModuleLoaded.add(ctx);
        }
        // output 0 = clock (mono), output 1 = run (mono) — wired straight
        // into the outputs map below, no bus in between.
        clockWorklet = createWorkletNode(node, ctx, 'cv-clock', {
          numberOfInputs: 0,
          numberOfOutputs: 2,
          outputChannelCount: [1, 1],
        });
        clockWorklet.port.onmessage = (e: MessageEvent) => {
          const d = e.data as
            | {
                type?: string;
                pulses?: number;
                skipped?: number;
                renderedS?: number;
                minGapS?: number | null;
                maxGapS?: number | null;
              }
            | undefined;
          if (d?.type === 'health') {
            if (typeof d.pulses === 'number') workletPulses = d.pulses;
            if (typeof d.skipped === 'number') workletSkips = d.skipped;
            if (typeof d.renderedS === 'number') workletRenderedS = d.renderedS;
            if (typeof d.minGapS === 'number' || d.minGapS === null) workletMinGapS = d.minGapS;
            if (typeof d.maxGapS === 'number' || d.maxGapS === null) workletMaxGapS = d.maxGapS;
          }
        };
      }
    } catch (err) {
      console.warn('[cv-buddy] cv-clock worklet unavailable — main-thread clock path drives the jacks', err);
      clockWorklet = null;
    }

    // ---- params (owner-only in effect) ----
    const savedParams = (node.params ?? {}) as Record<string, number>;
    // ⚠ SNAPPED AT THE POINT OF USE, AND DELIBERATELY NOT WRITTEN BACK.
    // `ppqn` declares an EXHAUSTIVE roster, so the clock must divide by a legal
    // number — but a rack saved before that declaration can hold any of the 48
    // positions the old range allowed, and it arrives by routes that pass
    // through no loader at all (an IndexedDB replica restore, a peer's Y update,
    // an undo). Snapping HERE covers every one of them, because it is the point
    // of use rather than a point of arrival.
    //
    // It does NOT repair the stored value: correcting the live node from the
    // engine would be an untagged Y.Doc write, which `momentary-params` refuses
    // by name, and a silent repair of a data-integrity bug is indistinguishable
    // from no bug. So a legacy rack CLOCKS at its nearest legal division and
    // DISPLAYS that same division (the selector and the readout both resolve
    // through the same `nearestByValue`), and the graph is normalized by the
    // first ordinary, tagged, undoable write the player makes.
    let ppqn = snapPpqn(savedParams.ppqn ?? CV_BUDDY_DEFAULT_PPQN);
    let clockOffsetMs = savedParams.clockOffsetMs ?? 0;

    // ---- clock/run runtime state ----
    // The clock is a PHASE ACCUMULATOR, not a t=0 grid — see the header of
    // clock-math.ts for why (a tempo nudge used to teleport the phase by up to
    // a whole pulse period, which is the reported Pam's/Mandala instability).
    let clockPhase: ClockPhase = idleClockPhase();
    let clockThrough = ctx.currentTime; // scheduled the clock out to here
    let lastRunLevel = 0; // last value written to runSrc.offset
    let wasClocking = false; // were we scheduling last tick? (owner && running)
    // Pulses that came due before a late tick could place them. Previously this
    // path was silent, so a scheduling stall and an ES-9 underrun both just
    // looked like "the clock is unstable" at the jack. Surfaced via read().
    let clockSkips = 0;

    // ---- worklet config pusher ----
    // Coalesced on the wire: a message goes out only when a value moved, so
    // the port is silent at rest and carries ~one message per tick during a
    // BPM knob drag (timelorde writes bpm per frame; the worklet applies it
    // from the NEXT pulse — no 200 ms lookahead lag, see cv-clock-core.ts).
    // During a main-thread stall no messages go out at all, and that is the
    // point: the worklet free-runs on its last config.
    let lastWorkletCfgKey = '';
    function pushWorkletConfig(): void {
      if (!clockWorklet) return;
      const running = ownsTransport(thisId) && transportRunning();
      const bpm = transportBpm();
      const key = `${bpm}|${ppqn}|${clockOffsetMs}|${running}`;
      if (key === lastWorkletCfgKey) return;
      lastWorkletCfgKey = key;
      try {
        clockWorklet.port.postMessage({
          type: 'config',
          config: {
            bpm,
            ppqn,
            offsetMs: clockOffsetMs,
            running,
            // The authoritative levels ride along so the dsp package never
            // duplicates web constants (see CvClockConfig).
            runLevel: GATE_HI,
            pulseS: CLOCK_PULSE_HIGH_S,
          },
        });
      } catch {
        /* a torn-down port must not break the tick */
      }
    }
    pushWorkletConfig();

    function stopClock(at: number): void {
      clockSrc.offset.cancelScheduledValues(at);
      clockSrc.offset.setValueAtTime(0, at);
      clockThrough = at;
      // Re-anchor on the next start so the train begins WITH the transport.
      clockPhase = idleClockPhase();
    }
    function setRun(level: number, at: number): void {
      if (level === lastRunLevel) return;
      runSrc.offset.setValueAtTime(level, at);
      lastRunLevel = level;
    }

    function tick(): void {
      try {
        // Feed the audio-thread clock FIRST: its config must never wait on the
        // shadow-path scheduling below. Everything after this line is the
        // unchanged main-thread path — the jack driver in test/SSR, and the
        // `skips` stall-shadow when the worklet owns the jacks.
        pushWorkletConfig();

        const now = ctx.currentTime;
        const owner = ownsTransport(thisId);
        const running = transportRunning();

        // RUN follows play state — high while the transport plays (owner only).
        setRun(owner && running ? GATE_HI : 0, now);

        // CLOCK: schedule the grid over the look-ahead window (owner + running).
        if (owner && running) {
          const winStart = Math.max(clockThrough, now);
          const winEnd = now + CLOCK_LOOKAHEAD_S;
          if (winEnd > winStart) {
            const adv = advanceClock(
              clockPhase,
              transportBpm(),
              ppqn,
              clockOffsetMs,
              winStart,
              winEnd,
            );
            for (const t of adv.pulses) {
              openGate(clockSrc, t);
              closeGate(clockSrc, t + CLOCK_PULSE_HIGH_S);
            }
            clockPhase = adv.phase;
            clockThrough = winEnd;
            if (adv.skipped > 0) {
              clockSkips += adv.skipped;
              console.warn(
                `[cv-buddy] clock tick arrived late — ${adv.skipped} pulse(s) could not be ` +
                  `scheduled (${clockSkips} total). If the ES-9 card also shows rising xruns, ` +
                  'the jack is starving too; if not, this is main-thread scheduling.',
              );
            }
          }
          wasClocking = true;
        } else if (wasClocking) {
          // Transitioned to not-owner / stopped → silence the clock cleanly.
          stopClock(now);
          wasClocking = false;
        } else {
          // Keep the grid anchor from drifting into the past while idle.
          clockThrough = Math.max(clockThrough, now);
        }
      } catch (err) {
        console.error('[cv-buddy] tick error', err);
      }
    }
    const unsubscribeTick = getSchedulerClock().subscribe(tick);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['gate', { node: gatePass, input: 0 }],
        ['pitch', { node: pitchPass, input: 0 }],
        // MINI has no velocity port — omitting the entry is what makes its
        // port set differ, and what keeps its ES-9 cost at two jacks.
        ...(hasVelocity ? [['velocity', { node: velPass, input: 0 }] as const] : []),
      ]),
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ['pitchCv', { node: pitchPass, output: 0 }],
        ['gate', { node: gatePass, output: 0 }],
        ...(hasVelocity ? [['velCv', { node: velPass, output: 0 }] as const] : []),
        // With the cv-clock worklet the jacks are the worklet's own outputs
        // (0 = clock, 1 = run) — sample-accurate and immune to a main-thread
        // stall. Without it (test/SSR/load failure) the ConstantSources drive
        // them exactly as they always have.
        ['run', clockWorklet ? { node: clockWorklet, output: 1 } : { node: runSrc, output: 0 }],
        ['clock', clockWorklet ? { node: clockWorklet, output: 0 } : { node: clockSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        // Snapped on the way in too — a CV/automation/preset write reaches this
        // seam without passing the selector, and the roster is the legal set.
        if (paramId === 'ppqn') ppqn = snapPpqn(value);
        else if (paramId === 'clockOffsetMs') clockOffsetMs = value;
        // A param edit reaches the audio thread NOW, not a tick later.
        if (paramId === 'ppqn' || paramId === 'clockOffsetMs') pushWorkletConfig();
      },
      readParam(paramId) {
        if (paramId === 'ppqn') return ppqn;
        if (paramId === 'clockOffsetMs') return clockOffsetMs;
        // Legacy alias, kept so an existing console poke keeps working. The
        // CARD reads `read('state').skips` — see CvBuddyClockState for why the
        // cached readParam path is the wrong home for a diagnostic.
        if (paramId === 'clockSkips') return clockSkips;
        return undefined;
      },
      read(key) {
        if (key === 'state') {
          const state: CvBuddyClockState = {
            ownsClock: ownsTransport(thisId),
            running: transportRunning(),
            bpm: transportBpm(),
            skips: clockSkips,
          };
          return state;
        }
        if (key === 'clockHealth') {
          const health: CvBuddyClockHealth = {
            driver: clockWorklet ? 'worklet' : 'main',
            skips: clockSkips,
            workletPulses,
            workletSkips,
            workletRenderedS,
            workletMinGapS,
            workletMaxGapS,
          };
          return health;
        }
        return undefined;
      },
      dispose() {
        unsubscribeTick();
        try { runSrc.stop(); } catch { /* already stopped */ }
        try { clockSrc.stop(); } catch { /* already stopped */ }
        for (const g of [pitchPass, gatePass, velPass]) g.disconnect();
        runSrc.disconnect();
        clockSrc.disconnect();
        if (clockWorklet) {
          // A 0-input source processor that returns true lives forever — tell
          // it to stand down (process → false) so the node can be collected
          // (the card-unmount resource rule, #1531 family).
          try { clockWorklet.port.postMessage({ type: 'dispose' }); } catch { /* torn down */ }
          clockWorklet.port.onmessage = null;
          try { clockWorklet.disconnect(); } catch { /* already disconnected */ }
          clockWorklet = null;
        }
      },
    };
}


/**
 * THE PPQN PARAM, declared ONCE and shared by both kinds.
 *
 * ⚠ `cvBuddy` and `cvBuddyMini` are the same module minus a jack, and they
 * render ONE shared body. Two copies of this declaration would be two rosters
 * free to drift — and the drift would be invisible until a user noticed one
 * card offering a division the other refused, which is the exact argument
 * `CvBuddyBody.svelte`'s own header makes for sharing the component.
 */
export const CV_BUDDY_PPQN_PARAM: ParamDef = {
  id: 'ppqn',
  label: 'PPQN',
  defaultValue: CV_BUDDY_DEFAULT_PPQN,
  min: 1,
  max: 48,
  curve: 'discrete',
  // ── LEGAL SETTINGS ONLY (owner ruling, 2026-08-20) ────────────────────
  // This param declared `1..48 discrete` with NO roster, so 48 positions
  // were reachable and only SEVEN were legal — the card's `<select>` could
  // not produce the other forty-one, and nothing rejected them
  // (`setParam` fed the value straight to the clock scheduler). A face made
  // it visible: the resolver returned `knob` at every tier, i.e. a
  // 48-position dial over a seven-position control (#2024).
  //
  // ⚠ THE ROSTER IS THE LEGAL SET, not a naming of the steps — see
  // `optionsExhaustive` below. Derived from the same exported constant the
  // card's menu is built from, so the two cannot disagree.
  options: CV_BUDDY_PPQN_CHOICES.map((n) => ({
    value: n,
    label: String(n),
    title:
      n === CV_BUDDY_DEFAULT_PPQN
        ? `${n} pulses per quarter note — the DIN-sync standard`
        : `${n} pulse${n === 1 ? '' : 's'} per quarter note`,
  })),
  optionsExhaustive: {
    why:
      'a clock divides by a whole number of pulses per quarter note, and these seven are the divisions the '
      + 'generator and the downstream gear share (24 is DIN-sync). The forty-one integers in between are not '
      + 'unnamed states — they are values this module has no meaning for: the card could never produce them, '
      + 'the scheduler would accept them, and a rack holding one would clock Pam\'s at a rate nothing else in '
      + 'the room agrees on.',
  },
};

/**
 * THE FACE, declared ONCE and shared by both kinds — the same argument
 * `CV_BUDDY_PPQN_PARAM` above makes, one level up.
 *
 * ⚠ IT IS THE SAME OBJECT, not two identical literals, and the difference is
 * the whole point: `cvBuddyDef.face === cvBuddyMiniDef.face` is asserted BY
 * IDENTITY in `cv-buddy-face-model.test.ts`. Two copies would be two faces free
 * to drift — one gaining a band, one keeping an old label — and the drift would
 * be invisible until a player noticed two plates for one module disagreeing,
 * which is exactly what `CvBuddyBody.svelte`'s header says about the card.
 *
 * The face is legal for both because the two defs differ ONLY in ports: the
 * params are the same two (`ppqn`, `clockOffsetMs`, both from the shared
 * declarations above), and `face.order` names params, never ports.
 *
 * ⚠ BOTH PARAMS ARE CLOCK PARAMS, so the single band IS the whole control
 * surface — which is why `rackStatus` below could not be a shell-only feature.
 * Suppressing this band on a non-primary instance leaves NOTHING but the
 * module's own status body, and `rackStatusPlan` refuses to suppress at all
 * unless that body is painting.
 */
export const CV_BUDDY_FACE: ModuleFace = {
  order: ['ppqn', 'clockOffsetMs'],

  // No glyph. `primaryAudioOutPortId` resolves nothing here — every output is
  // cv/gate — so `'meter'` would give a static tap and twelve segments that can
  // never light (the marbles defect), and there is no waveform to draw either:
  // this module PASSES a note through and emits a pulse train. The picture on
  // this plate is the status body's lamps, which are pictures of the RACK.
  glyph: 'none',

  // The module's own rack-global status surface at the head of the dock view:
  // the slot NAME plus the ROUTED / LATE lamps. See the directory's
  // shell-extension.ts for why both kinds resolve to one extension.
  extension: 'cvBuddy',

  rackStatus: {
    why:
      'RUN and CLOCK are SINGLE-SOURCE: ES-9 jacks 7 and 8 are driven by the id-smallest CV Buddy '
      + 'of either kind, and every other instance is a note voice only. So on a non-primary '
      + 'instance PPQN and CLOCK OFFSET are dials wired to nothing — the scheduler they configure '
      + 'belongs to a different node — and the legacy card has hidden them since the module '
      + 'shipped, telling the player instead that "PPQN / clock is driven by the first CV Buddy". '
      + 'That sentence cannot be painted on a faceplate, and the ruling it falls under is also '
      + 'the reason it does not need to be: removing the band IS the statement, and it is '
      + 'structure rather than text. Nothing else on this face can express the fact, because it '
      + 'is not a property of this node at all — it changes when a DIFFERENT CV Buddy is added '
      + 'or deleted, which no ParamDef can represent.',
    peers: ['cvBuddy', 'cvBuddyMini'],
    primaryOnlyBands: ['clock'],
  },

  pages: [
    {
      id: 'clock',
      label: 'clock',
      hint:
        'PPQN is how many pulses the CLOCK jack emits per quarter note — 24 is DIN-sync and what '
        + "most gear expects; drop to 4 or 8 for a Pam's-style divided clock, raise to 48 for "
        + 'finer resolution. OFFSET is a manual timing trim in milliseconds: nudge it negative to '
        + 'send the pulse train early when downstream gear is triggering late. Both belong to the '
        + 'clock-owner instance, which is the id-smallest CV Buddy of either kind on this rack; '
        + 'on any other instance this band is not shown, because it would configure a clock that '
        + 'node does not drive.',
      controls: ['ppqn', 'clockOffsetMs'],
    },
  ],
};

export const cvBuddyDef: AudioModuleDef = {
  type: 'cvBuddy',
  palette: { top: 'Audio modules', sub: 'I/O' },
  domain: 'audio',
  label: 'cv buddy',
  category: 'output',
  // Taller tier for the slot readout + owner clock section + ES-9 mirror; 2 tiles
  // wide (~the midi-buddy footprint). Owner-tunable in the look preview.
  size: '3u',
  hp: 2,

  // INPUTS mirror midiOutBuddy: cv-typed pitch/velocity so a poly-splitter's
  // voice-0 (from a clip lane's `pitch{n}` polyPitchGate) feeds them; a gate.
  inputs: [
    { id: 'gate', type: 'gate', edge: 'gate' },
    { id: 'pitch', type: 'cv' },
    { id: 'velocity', type: 'cv' },
  ],
  // OUTPUTS: cv/gate ONLY — never 'pitch'-typed, never poly (keeps
  // isNoteSource false). The ES-9 out{N}_class does the volt scaling.
  outputs: [
    { id: 'pitchCv', type: 'cv' },
    { id: 'gate', type: 'gate', edge: 'gate' },
    { id: 'velCv', type: 'cv' },
    { id: 'run', type: 'gate', edge: 'gate' },
    { id: 'clock', type: 'gate', edge: 'trigger' },
  ],
  params: [
    CV_BUDDY_PPQN_PARAM,
    // Manual clock latency trim, ±20 ms.
    { id: 'clockOffsetMs', label: 'Clock offset', defaultValue: 0, min: -20, max: 20, curve: 'linear', units: 'ms' },
  ],

  // Lane note-sink (Part-B tap planner) + a hardware AUDIO RETURN via the ES-9
  // input pair — `returnsAudio` makes CV Buddy a lane HEAD-source candidate so
  // its return audio wires at the column's chain root. See ChainWiring.
  chainWiring: {
    role: 'noteSink',
    laneTap: { pitchIn: 'pitch', gateIn: 'gate', velIn: 'velocity' },
    returnsAudio: true,
  },

  // ⚠ THE SAME OBJECT the mini declares. See CV_BUDDY_FACE.
  face: CV_BUDDY_FACE,

  docs: {
    explanation:
      "CV BUDDY sends a clip lane out to a real Eurorack system through an ES-9. Hand-patch a lane's PITCH, GATE and VELOCITY into its three inputs and CV Buddy passes them straight through to CV/gate outputs; the CV-Buddy↔ES-9 reconciler then AUTO-ROUTES those outputs to the ES-9's physical output jacks by slot (id-smallest instance → jacks 1-3, second instance → jacks 4-6) and writes each jack's voltage class (pitch → 1 V/oct, gate → +5 V, velocity → ±5 V CV). The pitch is carried on a plain CV cable, NOT a pitch/poly cable, so CV Buddy stays a note SINK a lane can drive — the 1 V/octave scaling happens on the ES-9 jack, not here. The id-smallest ('owner') instance additionally GENERATES two transport signals on jacks 7 and 8: RUN, a gate held high while the rack transport (TIMELORDE) is playing and low when stopped, and CLOCK, a DIN-sync pulse train at a selectable PPQN, phase-locked to the transport — patch RUN + CLOCK into a Pam's New Workout to slave it to the rack. A second CV Buddy takes the next free note set (jacks 4-6); a third and beyond sit inert (no free ES-9 jacks). With no ES-9 in the rack CV Buddy is harmless and idle — add an ES-9 module and run the es9-bridge helper to hear it at the jacks. Note there is no audio output, so CV Buddy never appears as a mixer send.",
    inputs: {
      gate:
        "The note gate from a clip lane: while this level is high the lane is holding a note, and CV Buddy passes the gate through to its GATE output (and on to the ES-9 gate jack as +5 V). Hand-patch the lane's gate here.",
      pitch:
        "The note pitch as CV (0 V = C4), passed straight through to the PITCH CV output. It rides a plain CV cable; the ES-9 jack's pitch class turns it into 1 V/octave downstream. Patch the lane's pitch (a poly cable's voice-0 is taken automatically).",
      velocity:
        "The note velocity as 0..1 CV, passed through to the VEL CV output and out the ES-9's ±5 V CV jack. Patch the lane's velocity; leave it unpatched for a steady 0.",
    },
    outputs: {
      pitchCv:
        "The pitch input passed through unchanged on a CV cable — the reconciler wires it to the ES-9 pitch jack (class pitch → 1 V/octave, 0 V = C4).",
      gate:
        "The gate input passed through — a gate that stays high while a note is held; the reconciler wires it to the ES-9 gate jack (+5 V while high).",
      velCv:
        "The velocity input passed through on a CV cable — routed to the ES-9 velocity jack (±5 V CV).",
      run:
        "A RUN gate driven only by the owner (id-smallest) instance: held HIGH the whole time the rack transport is playing and LOW while it is stopped (it follows play state; it does not pulse). Wired to ES-9 jack 7. Patch it to a Pam's RUN/STOP input.",
      clock:
        "A generated CLOCK — short gate pulses that fire at the selected PPQN times the transport tempo, phase-locked to TIMELORDE, driven only by the owner instance while the transport runs. Wired to ES-9 jack 8. Patch it to a Pam's clock input for DIN-sync.",
    },
    controls: {
      ppqn:
        "Clock resolution in pulses per quarter note (1, 2, 4, 8, 12, 24, 48; default 24 = DIN-sync). Sets how many CLOCK pulses fire per beat. Only the clock-owner instance uses it; on other instances it is inert.",
      clockOffsetMs:
        "A manual timing trim for the CLOCK, ±20 ms, to nudge the pulse train earlier or later against downstream gear. Only the clock-owner instance uses it.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    return createCvBuddyHandle(ctx, node, 'full');
  },
};
