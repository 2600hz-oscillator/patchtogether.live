// packages/web/src/lib/audio/modules/cofefve.ts
//
// COFEFVE DELAY — a clean-room, OWN-CODE analog BBD/tape-style stereo delay.
// The per-sample DSP is packages/dsp/src/cofefve.ts (wrapping the own-code
// packages/dsp/src/lib/analog-delay-core.ts); NO GPL delay source was read
// while writing it. It REPLACES the retired COCOA DELAY and keeps the same
// I/O + UX surface so the module slots in where a tape/BBD echo is wanted.
//
// Ports:
//   in L / in R  — stereo audio in
//   out L / out R— stereo audio out
//   clock        — gate/clock CV; when patched + tempo-sync != Off, the
//                  delay time locks to the measured pulse period × division.
//   CV inputs    — time, feedback, mix(=wet), drive(=gain), lfoAmt, drift,
//                  pan, duck — the musical continuous params, per the
//                  per-param-CV convention other modules use.
//
// Tempo sync (two pieces):
//   • clockSource (dropdown): SYSTEM (TIMELORDE) vs MIDI (MIDICLOCK). These
//     route to GENUINELY different tempo references:
//       - System → the rack's TIMELORDE `bpm` (read off the live patch graph,
//         same as CLOCKED RUNNER does).
//       - MIDI   → the shared MIDI-clock source (0xF8 @ 24 PPQN → derived BPM).
//     The worklet can't read those singletons (AudioWorkletGlobalScope), so a
//     main-thread loop resolves the chosen source's seconds-per-beat and
//     bridges it via the `syncPeriod` AudioParam.
//   • tempoSync (dropdown): Off → free-running ms (the TIME knob); otherwise
//     a musical division of that beat (1/4, 1/8, dotted, triplet …).
//   • A PATCHED `clock` gate input STILL overrides both sources — the DSP
//     measures the pulse period and uses it directly.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getMidiClockSource } from '$lib/midi/midi-clock-source';
import workletUrl from '@patchtogether.live/dsp/dist/cofefve.js?url';

/** clockSource dropdown indices (must match COFEFVE_CLOCK_SOURCE_OPTIONS). */
const CLOCK_SOURCE_SYSTEM = 0;
const CLOCK_SOURCE_MIDI = 1;

/** Read the rack's TIMELORDE bpm off the live patch graph (mirrors
 *  CLOCKED RUNNER). Returns the default 120 when no TIMELORDE is present. */
export function readTimelordeBpm(nodes: Record<string, { type?: string; params?: Record<string, unknown> } | undefined>): number {
  for (const n of Object.values(nodes)) {
    if (n?.type === 'timelorde') {
      const bpm = n.params?.['bpm'];
      if (typeof bpm === 'number' && bpm > 0) return bpm;
    }
  }
  return 120;
}

/** Resolve seconds-per-beat for the chosen clockSource. MIDI returns null
 *  when no live MIDI clock is being received (caller leaves syncPeriod=0 so
 *  the worklet falls back to the free-running knob until clock arrives). */
export function resolveSyncPeriodS(
  clockSource: number,
  nodes: Record<string, { type?: string; params?: Record<string, unknown> } | undefined>,
  midiBeatPeriodS: number | null,
): number {
  if (clockSource === CLOCK_SOURCE_MIDI) {
    return midiBeatPeriodS !== null && midiBeatPeriodS > 0 ? midiBeatPeriodS : 0;
  }
  // System (default / index 0): TIMELORDE.
  return 60 / readTimelordeBpm(nodes);
}

const loadedContexts = new WeakSet<BaseAudioContext>();

/** Tempo-sync dropdown options (index → label). Index 0 = Off (free ms);
 *  the rest map 1:1 onto SYNC_BEATS in the worklet core. */
export const COFEFVE_TEMPO_SYNC_OPTIONS: readonly string[] = [
  'Off',
  '1', '1/2D', '1/2', '1/2T', '1/4D', '1/4', '1/4T',
  '1/8D', '1/8', '1/8T', '1/16D', '1/16', '1/16T',
  '1/32D', '1/32', '1/32T', '1/64D', '1/64', '1/64T',
];

/** Clock-source dropdown (index → label). */
export const COFEFVE_CLOCK_SOURCE_OPTIONS: readonly string[] = ['System', 'MIDI'];

/** Pan-mode dropdown (index → label). */
export const COFEFVE_PAN_MODE_OPTIONS: readonly string[] = ['Static', 'Ping-Pong', 'Circular'];

/** Filter-mode dropdown (index → label). */
export const COFEFVE_FILTER_MODE_OPTIONS: readonly string[] = ['1-pole', '2-pole', '4-pole', 'State-var'];

export const cofefveDelayDef: AudioModuleDef = {
  type: 'cofefve',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'cofefve delay',
  category: 'effects',
  schemaVersion: 1,
  stereoPairs: [['inL', 'inR'], ['outL', 'outR']],

  inputs: [
    { id: 'inL', type: 'audio' },
    { id: 'inR', type: 'audio' },
    // External clock for tempo sync (TIMELORDE or MIDICLOCK).
    { id: 'clock', type: 'gate', edge: 'trigger' },
    // Per-param CV (range standard per .myrobots/plans/cv-range-standard.md).
    { id: 'time_cv',     type: 'cv', paramTarget: 'delayTime', cvScale: { mode: 'log' } },
    { id: 'feedback_cv', type: 'cv', paramTarget: 'feedback',  cvScale: { mode: 'linear' } },
    { id: 'mix_cv',      type: 'cv', paramTarget: 'wetVolume', cvScale: { mode: 'linear' } },
    { id: 'drive_cv',    type: 'cv', paramTarget: 'driveGain', cvScale: { mode: 'linear' } },
    { id: 'lfo_cv',      type: 'cv', paramTarget: 'lfoAmount', cvScale: { mode: 'linear' } },
    { id: 'drift_cv',    type: 'cv', paramTarget: 'driftAmount', cvScale: { mode: 'linear' } },
    { id: 'pan_cv',      type: 'cv', paramTarget: 'pan',       cvScale: { mode: 'linear' } },
    { id: 'duck_cv',     type: 'cv', paramTarget: 'duckAmount', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'outL', type: 'audio' },
    { id: 'outR', type: 'audio' },
  ],
  params: [
    // DELAY / TIME
    { id: 'delayTime',   label: 'Time',     defaultValue: 0.2,  min: 0.001, max: 2.0,  curve: 'log',      units: 's' },
    { id: 'tempoSync',   label: 'Sync',     defaultValue: 0,    min: 0,     max: 19,   curve: 'discrete' },
    { id: 'clockSource', label: 'Clk Src',  defaultValue: 0,    min: 0,     max: 1,    curve: 'discrete' },
    // Bridged from the WEB layer each frame (System=TIMELORDE / MIDI=MIDICLOCK
    // seconds-per-beat). Not user-facing — no card control. 0 = none.
    { id: 'syncPeriod',  label: 'SyncPer',  defaultValue: 0,    min: 0,     max: 30,   curve: 'linear', units: 's' },
    // LFO
    { id: 'lfoAmount',    label: 'LFO Amt',  defaultValue: 0.0,  min: 0.0,   max: 0.5,  curve: 'linear' },
    { id: 'lfoFrequency', label: 'LFO Freq', defaultValue: 2.0,  min: 0.1,   max: 10.0, curve: 'log',   units: 'hz' },
    // DRIFT
    { id: 'driftAmount', label: 'Drift Amt', defaultValue: 0.001, min: 0.0,  max: 0.05, curve: 'linear' },
    { id: 'driftSpeed',  label: 'Drift Spd', defaultValue: 1.0,   min: 0.1,  max: 10.0, curve: 'log' },
    // FEEDBACK
    { id: 'feedback',     label: 'Feedback', defaultValue: 0.5,  min: -1.0,  max: 1.0,  curve: 'linear' },
    { id: 'stereoOffset', label: 'Stereo',   defaultValue: 0.0,  min: -0.5,  max: 0.5,  curve: 'linear' },
    { id: 'pan',          label: 'Pan',      defaultValue: 0.0,  min: -Math.PI * 0.5, max: Math.PI * 0.5, curve: 'linear' },
    { id: 'panMode',      label: 'Pan Mode', defaultValue: 0,    min: 0,     max: 2,    curve: 'discrete' },
    // DUCKING
    { id: 'duckAmount',  label: 'Duck Amt', defaultValue: 0.0,  min: 0.0,   max: 10.0, curve: 'linear' },
    { id: 'duckAttack',  label: 'Attack',   defaultValue: 10.0, min: 0.1,   max: 100.0, curve: 'log' },
    { id: 'duckRelease', label: 'Release',  defaultValue: 10.0, min: 0.1,   max: 100.0, curve: 'log' },
    // FILTER (in feedback path)
    { id: 'filterMode', label: 'Filt Mode', defaultValue: 0,    min: 0,     max: 3,    curve: 'discrete' },
    { id: 'lowCut',     label: 'Low Cut',   defaultValue: 0.75, min: 0.01,  max: 1.0,  curve: 'linear' },
    { id: 'highCut',    label: 'High Cut',  defaultValue: 0.001, min: 0.001, max: 0.99, curve: 'linear' },
    // DRIVE
    { id: 'driveGain',       label: 'Gain',  defaultValue: 0.1,  min: 0.0,   max: 10.0, curve: 'linear' },
    { id: 'driveMix',        label: 'D.Mix', defaultValue: 1.0,  min: 0.0,   max: 1.0,  curve: 'linear' },
    { id: 'driveCutoff',     label: 'D.Filt',defaultValue: 1.0,  min: 0.01,  max: 1.0,  curve: 'linear' },
    { id: 'driveIterations', label: 'Iters', defaultValue: 1,    min: 1,     max: 16,   curve: 'discrete' },
    // DRY / WET
    { id: 'dryVolume', label: 'Dry', defaultValue: 1.0, min: 0.0, max: 2.0, curve: 'linear' },
    { id: 'wetVolume', label: 'Wet', defaultValue: 0.5, min: 0.0, max: 2.0, curve: 'linear' },
  ],

  docs: {
    explanation: "A clean-room, own-code analog BBD/tape-style stereo delay (the replacement for the retired Cocoa Delay — its own DSP, no GPL lineage). Audio is written into a 10-second stereo delay line and read back at a fractional, modulated position with 4-point Catmull-Rom cubic interpolation. The read time is the base delay (free-running TIME, or a musical division of a clock beat when SYNC is on), warped per-sample by a WOW sine LFO and a slow random FLUTTER drift, with bipolar feedback feeding the echoes back through an in-loop multi-mode TONE filter and a stateful tanh DRIVE saturator; a STEREO offset skews the L/R read times to widen the image, PAN modes spread the wet signal, DUCKING sidechains the wet level off the dry input, and DRY/WET set the final mix. Mental model: one tape/bucket-brigade echo where almost every knob is also voltage-controllable, and where a patched CLK pulse or the rack/MIDI tempo can lock the delay to the beat. The read pointer eases toward its target so TIME changes glide like a tape motor rather than clicking.",
    inputs: {
      inL: "Left audio into the delay — together with inR this is the dry signal that is written to the delay line, tapped through the wet path, and summed back into the output.",
      inR: "Right audio into the delay; an independent channel that normals to inL when left unpatched (a mono source into inL alone feeds both channels). Patch both inL and inR for a true stereo input, or use the module's stereo auto-wire.",
      clock: "External clock/trigger: when SYNC is on, the delay measures the samples between rising edges (level crossing up through ~0.5) of pulses here and locks the delay time to that measured period times the chosen division — it takes two rising edges to establish a period, so the lock engages on the second pulse. A patched clock ALWAYS wins over both the rack SYSTEM tempo and MIDI clock; when SYNC is Off this input has no audible effect and TIME is free-running.",
      time_cv: "CV modulation of the TIME knob (delayTime), summed into it with a log-scaled response so a -1..+1 CV sweeps the base delay across its full log range; sweeping it gives classic tape pitch-bend / smear on the echoes.",
      feedback_cv: "CV modulation of FEEDBACK, summed into the knob (linear). Pushes the regeneration amount up or down per-sample; since feedback is bipolar (-1..+1), CV can drive it negative to flip the polarity of each repeat.",
      mix_cv: "CV modulation of the WET output level (targets wetVolume, linear). Use it to fade the echoes in and out under control voltage; the dry level is unaffected.",
      drive_cv: "CV modulation of the in-loop saturation amount (targets driveGain, linear). Raises or lowers how hard the feedback path is pushed into the stateful tanh saturator per-sample.",
      lfo_cv: "CV modulation of the LFO (WOW) AMOUNT (lfoAmount, linear) — the depth with which the internal time LFO wobbles the delay read position. It does not change the LFO rate, only how much it warps the time.",
      drift_cv: "CV modulation of DRIFT (FLUTTER) AMOUNT (driftAmount, linear), the depth of the slow random tape-drift walk applied to the read time. More CV = more wow/flutter wander.",
      pan_cv: "CV modulation of the PAN angle (pan, linear). Its audible effect depends on PAN MODE: it rotates the static placement, biases the ping-pong, or drives the circular wet-image rotation.",
      duck_cv: "CV modulation of DUCK AMOUNT (duckAmount, linear) — how strongly the wet level is pulled down by the envelope follower riding the dry input. More CV = the echoes get out of the way harder when dry signal is present.",
    },
    outputs: {
      outL: "Left of the stereo output: dry × DRY level + ducked/panned wet × WET level, the left half of the combined dry+echo signal.",
      outR: "Right of the stereo output: dry × DRY level + ducked/panned wet × WET level, the right half of the combined dry+echo signal.",
    },
    controls: {
      delayTime: "TIME — the base delay length in seconds (0.001–2.0 s, log). Used directly when SYNC is Off; when SYNC is on it is only the fallback if no clock/tempo is available. WOW, FLUTTER and STEREO offset all warp this value before the line is read, and the read pointer eases toward it so changes glide.",
      tempoSync: "SYNC — Off (index 0) means TIME is free-running; any other setting locks the delay to a musical division of one beat (1, dotted/triplet variants… down to 1/64T). The beat comes from a patched clock pulse, else the chosen CLK SRC tempo.",
      clockSource: "CLK SRC — picks which tempo reference SYNC follows when no clock cable is patched: SYSTEM reads the rack's TIMELORDE BPM, MIDI follows incoming MIDI clock (0xF8). Selecting MIDI is what first requests browser MIDI access; SYSTEM never prompts. A patched CLK input overrides either.",
      syncPeriod: "Internal, not on the card: the seconds-per-beat the main thread bridges in for the selected CLK SRC (SYSTEM/MIDI), since the audio worklet can't read those sources directly. 0 means none available, in which case it falls back to the free-running TIME.",
      lfoAmount: "WOW (LFO AMOUNT) — depth of the internal sine LFO that warps the delay read time (0–0.5). At 0 the LFO does nothing; higher values give pitch wobble / chorus-like movement on the echoes.",
      lfoFrequency: "WOW RATE (LFO FREQUENCY) — rate of the time-warp LFO (0.1–10 Hz, log). Sets how fast the delay-time wobble cycles.",
      driftAmount: "FLUTTER (DRIFT AMOUNT) — depth of a slow random walk on the delay time (0–0.05), the tape wow/flutter character. Higher = more wandering, less stable pitch on the echoes. The walk is a fixed-seed PRNG so renders are deterministic.",
      driftSpeed: "FLUTTER SPEED (DRIFT SPEED) — how quickly the random drift walk picks new targets (0.1–10, log). Faster gives jittery flutter, slower gives long lazy pitch drift.",
      feedback: "FEEDBACK — bipolar regeneration amount (-1..+1, default 0.5). Higher magnitude = more/longer repeats; negative values invert the polarity of each fed-back repeat for a hollower tone. Internally clamped just below unity so the loop stays stable.",
      stereoOffset: "STEREO — skews the left and right read times apart (-0.5..+0.5) by shortening one channel's delay and lengthening the other, widening the stereo image of the echoes. 0 keeps both channels at the same delay (L and R identical).",
      pan: "PAN — wet-image rotation angle (-π/2..+π/2). What it does depends on PAN MODE: static placement, ping-pong bias, or the amount of circular rotation applied to the wet signal.",
      panMode: "PAN MODE — Static (a fixed rotation by PAN), Ping-Pong (crosses the feedback so repeats bounce side to side), or Circular (continuously rotates the wet stereo image at a rate set by PAN).",
      duckAmount: "DUCK AMOUNT — how strongly the wet level is ducked by an envelope follower on the dry input sum (0–10). At 0 there is no ducking; higher values make the echoes recede whenever dry signal is playing.",
      duckAttack: "DUCK ATTACK — how fast the ducking envelope clamps the wet down when dry signal arrives (0.1–100 ms, log).",
      duckRelease: "DUCK RELEASE — how fast the wet level recovers after the dry signal falls away (0.1–100 ms, log).",
      filterMode: "FILTER MODE — the topology of the in-feedback-loop tone filter: 1-pole, 2-pole, 4-pole (cascaded one-poles), or State-variable. Steeper poles darken the repeats more; the state-variable mode adds a mild resonant character.",
      lowCut: "LOW CUT — the in-loop low-pass cutoff applied to each repeat (0.01–1.0, normalized; default 0.75, where 1.0 is wide open). Lower values darken successive echoes as they regenerate. (Despite the 'low cut' label it is the LP stage in the loop, matching the classic tape-echo tone control.)",
      highCut: "HIGH CUT — the in-loop high-pass cutoff applied to each repeat (0.001–0.99, normalized; default 0.001 ≈ off). Raising it thins out the lows of successive echoes. (Label/role: this is the HP stage in the loop.)",
      driveGain: "DRIVE GAIN — how hard the feedback path is pushed into the stateful tanh saturator (0–10). 0 bypasses drive entirely (clean loop); higher adds progressively dirtier saturation that builds up over repeats.",
      driveMix: "DRIVE MIX — wet/dry blend across the saturator (0–1), how much of the saturated signal replaces the clean one inside the loop.",
      driveCutoff: "DRIVE FILTER — post-saturator low-pass cutoff (0.01–1.0, normalized; default 1.0 = open) that tames the harshness the drive adds.",
      driveIterations: "DRIVE ITERATIONS — how many times the saturate-then-filter stage runs in series per sample (1–16). More iterations stack more saturation and filtering for a thicker, more compressed drive.",
      dryVolume: "DRY — level of the unprocessed input passed straight to the output (0–2.0, default 1.0). Set to 0 for a fully wet send/return.",
      wetVolume: "WET — level of the delayed/echo signal in the output (0–2.0, default 0.5), the amount ducking pulls down and what mix_cv modulates.",
    },
  },
  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'cofefve', {
      numberOfInputs: 3, // L, R, clock
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Keep the node alive when nothing is patched in.
    const silenceL = ctx.createConstantSource();
    const silenceR = ctx.createConstantSource();
    const silenceClk = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceR.offset.value = 0;
    silenceClk.offset.value = 0;
    silenceL.start();
    silenceR.start();
    silenceClk.start();
    silenceL.connect(workletNode, 0, 0);
    silenceR.connect(workletNode, 0, 1);
    silenceClk.connect(workletNode, 0, 2);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of cofefveDelayDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // --- sync-period bridge ---------------------------------------------
    // The worklet can't read TIMELORDE / the MIDI-clock singleton (it's in
    // AudioWorkletGlobalScope). Resolve the chosen clockSource's beat period
    // on the main thread and feed it to the worklet via the `syncPeriod`
    // AudioParam. ~60 Hz is plenty (tempo changes are gestural); a patched
    // `clock` gate still overrides this inside the DSP.
    //
    // The MIDI clock source is constructed here (cheap, no I/O) but we ONLY
    // READ it (getBeatPeriodS) when the user has actually selected MIDI as the
    // clockSource. Reading is what triggers navigator.requestMIDIAccess(), so
    // spawning a COFEFVE DELAY on the default System clock must NOT touch the
    // MIDI source — that would pop the browser permission prompt unprompted.
    const syncPeriodParam = params.get('syncPeriod');
    const nodeId = node.id;
    const midiClock = getMidiClockSource();
    let syncTimer: ReturnType<typeof setInterval> | null = null;
    function pushSyncPeriod(): void {
      if (!syncPeriodParam) return;
      const live = livePatch.nodes[nodeId];
      const clockSource = Math.round(
        (typeof live?.params?.['clockSource'] === 'number'
          ? (live.params['clockSource'] as number)
          : (node.params?.['clockSource'] as number | undefined)) ?? 0,
      );
      // Only read the MIDI tempo (and thus request MIDI access) when MIDI is
      // the selected clock. System keeps null and never prompts.
      const midiBeatPeriodS =
        clockSource === CLOCK_SOURCE_MIDI ? midiClock.getBeatPeriodS() : null;
      const period = resolveSyncPeriodS(
        clockSource,
        livePatch.nodes,
        midiBeatPeriodS,
      );
      syncPeriodParam.setValueAtTime(period, ctx.currentTime);
    }
    pushSyncPeriod();
    syncTimer = setInterval(pushSyncPeriod, 16);

    return {
      domain: 'audio',
      inputs: new Map([
        ['inL',         { node: workletNode, input: 0 }],
        ['inR',         { node: workletNode, input: 1 }],
        ['clock',       { node: workletNode, input: 2 }],
        ['time_cv',     { node: workletNode, input: 0, param: params.get('delayTime')! }],
        ['feedback_cv', { node: workletNode, input: 0, param: params.get('feedback')! }],
        ['mix_cv',      { node: workletNode, input: 0, param: params.get('wetVolume')! }],
        ['drive_cv',    { node: workletNode, input: 0, param: params.get('driveGain')! }],
        ['lfo_cv',      { node: workletNode, input: 0, param: params.get('lfoAmount')! }],
        ['drift_cv',    { node: workletNode, input: 0, param: params.get('driftAmount')! }],
        ['pan_cv',      { node: workletNode, input: 0, param: params.get('pan')! }],
        ['duck_cv',     { node: workletNode, input: 0, param: params.get('duckAmount')! }],
      ]),
      outputs: new Map([
        ['outL', { node: workletNode, output: 0 }],
        ['outR', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        if (syncTimer !== null) clearInterval(syncTimer);
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        try { silenceClk.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        silenceClk.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
