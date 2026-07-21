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
//     pulses at PPQN·bpm, phase-locked to the AudioContext grid, only while the
//     transport runs. Non-owner instances leave run + clock at 0.
//
// KNOWN QUIRK (deferred, owner): the ES-9 gate class uses the HOLD-on-underrun
// policy (es9.ts), so a browser stream hiccup FREEZES the clock edge at its last
// level rather than continuing the pulse train. Solving that (a bridge-side
// free-running clock) is deferred; documented here so it isn't mistaken for a
// bug.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { openGate, closeGate, GATE_HI } from '$lib/audio/gate-trigger';
import { pulseTimes, CLOCK_PULSE_HIGH_S } from '$lib/audio/cv-buddy/clock-math';
import { allocateCvBuddySlots } from '$lib/audio/cv-buddy/slot-alloc';

/** The discrete PPQN menu the card offers (pulses per quarter note). 24 =
 *  DIN-sync default. */
export const CV_BUDDY_PPQN_CHOICES: readonly number[] = [1, 2, 4, 8, 12, 24, 48];
export const CV_BUDDY_DEFAULT_PPQN = 24;

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
  const ids: string[] = [];
  for (const n of Object.values(livePatch.nodes)) {
    if (n && (n as { type?: string }).type === 'cvBuddy') ids.push((n as { id: string }).id);
  }
  return allocateCvBuddySlots(ids).get(thisId)?.ownsClock === true;
}

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
    // Discrete PPQN menu; the card renders a select over CV_BUDDY_PPQN_CHOICES.
    { id: 'ppqn', label: 'PPQN', defaultValue: CV_BUDDY_DEFAULT_PPQN, min: 1, max: 48, curve: 'discrete' },
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
    const runSrc = ctx.createConstantSource();
    runSrc.offset.value = 0;
    runSrc.start();
    const clockSrc = ctx.createConstantSource();
    clockSrc.offset.value = 0;
    clockSrc.start();

    // ---- params (owner-only in effect) ----
    const savedParams = (node.params ?? {}) as Record<string, number>;
    let ppqn = savedParams.ppqn ?? CV_BUDDY_DEFAULT_PPQN;
    let clockOffsetMs = savedParams.clockOffsetMs ?? 0;

    // ---- clock/run runtime state ----
    let clockThrough = ctx.currentTime; // scheduled the clock grid up to here
    let lastRunLevel = 0; // last value written to runSrc.offset
    let wasClocking = false; // were we scheduling last tick? (owner && running)

    function stopClock(at: number): void {
      clockSrc.offset.cancelScheduledValues(at);
      clockSrc.offset.setValueAtTime(0, at);
      clockThrough = at;
    }
    function setRun(level: number, at: number): void {
      if (level === lastRunLevel) return;
      runSrc.offset.setValueAtTime(level, at);
      lastRunLevel = level;
    }

    function tick(): void {
      try {
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
            const bpm = transportBpm();
            const edges = pulseTimes(bpm, ppqn, clockOffsetMs, winStart, winEnd);
            for (const t of edges) {
              openGate(clockSrc, t);
              closeGate(clockSrc, t + CLOCK_PULSE_HIGH_S);
            }
            clockThrough = winEnd;
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
        ['velocity', { node: velPass, input: 0 }],
      ]),
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ['pitchCv', { node: pitchPass, output: 0 }],
        ['gate', { node: gatePass, output: 0 }],
        ['velCv', { node: velPass, output: 0 }],
        ['run', { node: runSrc, output: 0 }],
        ['clock', { node: clockSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'ppqn') ppqn = value;
        else if (paramId === 'clockOffsetMs') clockOffsetMs = value;
      },
      readParam(paramId) {
        if (paramId === 'ppqn') return ppqn;
        if (paramId === 'clockOffsetMs') return clockOffsetMs;
        return undefined;
      },
      read(key) {
        if (key === 'state') {
          return { ownsClock: ownsTransport(thisId), running: transportRunning(), bpm: transportBpm() };
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
      },
    };
  },
};
