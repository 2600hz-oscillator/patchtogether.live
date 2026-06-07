// packages/web/src/lib/audio/modules/polyhelm.ts
//
// POLYHELM — HELM with a polyphonic (poly bus) input.
//
// POLYHELM is the HELM polyphonic subtractive synth (algorithm port of Matt
// Tytel's Helm — helm_engine.cpp / helm_voice_handler.cpp / helm_oscillators.cpp
// / helm_lfo.cpp / state_variable_filter.cpp / envelope.cpp / step_generator.cpp,
// originally GPL-3.0, ported to AGPL-3.0-or-later per the project relicense) that
// ALSO accepts the project's 10-channel `polyPitchGate` poly bus (5 lanes of
// pitch+gate) from MIDI LANE / POLYSEQZ / a chord sequencer. Each lane drives one
// of HELM's existing allocator voices (the DX7 pattern — see dx7.ts).
//
// The shipped HELM module (modules/helm.ts) is UNCHANGED. POLYHELM reuses HELM's
// full DSP engine via the shared packages/dsp/src/lib/helm-engine.ts (a faithful
// extraction); the worklet is packages/dsp/src/polyhelm.ts.
//
// Keeps HELM's full param set (voiceCount / 2 oscs / sub / noise / filter /
// 3 ADSRs / 2 LFOs / step sequencer / spread) — POLYHELM is HELM + poly, not a
// stripped variant.
//
// Inputs:
//   poly (polyPitchGate): polyphonic pitch+gate (PREFERRED — up to 5 voices).
//   pitch_cv (cv): mono V/oct fallback (single-voice, used when no poly/MIDI).
//   gate (gate): mono gate fallback.
//   midi_in (cv): visual-only MIDI port (Web MIDI flows via the gear panel).
//   seq_reset (gate): rising edge resets the internal step sequencer.
//
// Outputs:
//   out_l / out_r (audio): stereo mixed voices.
//
// MIDI input + the sequencer transport reuse HELM's bridge verbatim (the pure
// MIDI parsers are imported from modules/helm.ts so there's one source of truth).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  expandChannelSet,
  midiChannelMatches,
  parseHelmMidiEvent,
  type HelmCardApi,
  type HelmMidiState,
  type HelmMidiData,
} from '$lib/audio/modules/helm';
import workletUrl from '@patchtogether.live/dsp/dist/polyhelm.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

// ---------------- Web MIDI minimal shapes (same as helm.ts / midi-cv-buddy.ts) ----------------

export interface MidiEventLike {
  data: Uint8Array;
  timeStamp: number;
}
interface MidiInputLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state: string;
  onmidimessage: ((ev: MidiEventLike) => void) | null;
}
interface MidiAccessLike {
  inputs: Map<string, MidiInputLike>;
  onstatechange: ((ev: { port: MidiInputLike }) => void) | null;
}

function webMidiAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
  );
}

// ---------------- Module def ----------------

export const polyhelmDef: AudioModuleDef = {
  type: 'polyhelm',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'polyhelm',
  category: 'sources',
  schemaVersion: 1,
  ossAttribution: { author: 'Matt Tytel' },

  // poly is the preferred polyphonic input (10-channel polyPitchGate; lane i →
  // voice i). pitch_cv/gate are the mono single-voice fallback (HELM parity).
  // midi_in is a visual-only marker (MIDI flows via the Web MIDI API, not a
  // cable). seq_reset resets the internal step sequencer.
  inputs: [
    { id: 'poly',     type: 'polyPitchGate' },
    { id: 'pitch_cv', type: 'cv' },
    { id: 'gate',     type: 'gate' },
    { id: 'midi_in',  type: 'cv' },
    { id: 'seq_reset',type: 'gate' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],

  // The full HELM v1 param surface (identical to helmDef.params).
  params: [
    { id: 'voiceCount',  label: 'Voices',      defaultValue: 6,    min: 1,    max: 8,     curve: 'discrete' },
    { id: 'volume',      label: 'Vol',         defaultValue: 0.7,  min: 0,    max: 2,     curve: 'linear' },

    // OSC 1
    { id: 'osc1Wave',    label: 'O1 Wav',      defaultValue: 0,    min: 0,    max: 3,     curve: 'discrete' },
    { id: 'osc1Trans',   label: 'O1 Tr',       defaultValue: 0,    min: -24,  max: 24,    curve: 'linear', units: 'st' },
    { id: 'osc1Tune',    label: 'O1 Tu',       defaultValue: 0,    min: -100, max: 100,   curve: 'linear', units: 'c' },
    { id: 'osc1Unison',  label: 'O1 Uni',      defaultValue: 1,    min: 1,    max: 7,     curve: 'discrete' },
    { id: 'osc1Detune',  label: 'O1 Det',      defaultValue: 10,   min: 0,    max: 50,    curve: 'linear', units: 'c' },
    { id: 'osc1Vol',     label: 'O1 Vol',      defaultValue: 0.8,  min: 0,    max: 1,     curve: 'linear' },

    // OSC 2
    { id: 'osc2Wave',    label: 'O2 Wav',      defaultValue: 1,    min: 0,    max: 3,     curve: 'discrete' },
    { id: 'osc2Trans',   label: 'O2 Tr',       defaultValue: 0,    min: -24,  max: 24,    curve: 'linear', units: 'st' },
    { id: 'osc2Tune',    label: 'O2 Tu',       defaultValue: 7,    min: -100, max: 100,   curve: 'linear', units: 'c' },
    { id: 'osc2Unison',  label: 'O2 Uni',      defaultValue: 1,    min: 1,    max: 7,     curve: 'discrete' },
    { id: 'osc2Detune',  label: 'O2 Det',      defaultValue: 10,   min: 0,    max: 50,    curve: 'linear', units: 'c' },
    { id: 'osc2Vol',     label: 'O2 Vol',      defaultValue: 0.6,  min: 0,    max: 1,     curve: 'linear' },

    // Sub + Noise
    { id: 'subWave',     label: 'Sub W',       defaultValue: 3,    min: 0,    max: 3,     curve: 'discrete' },
    { id: 'subVol',      label: 'Sub V',       defaultValue: 0.4,  min: 0,    max: 1,     curve: 'linear' },
    { id: 'noiseVol',    label: 'Noise',       defaultValue: 0,    min: 0,    max: 1,     curve: 'linear' },

    // Filter
    { id: 'filterCutoff',  label: 'Cut',       defaultValue: 4000, min: 20,   max: 20000, curve: 'log', units: 'Hz' },
    { id: 'filterRes',     label: 'Res',       defaultValue: 1.0,  min: 0.5,  max: 16,    curve: 'linear' },
    { id: 'filterBlend',   label: 'Mode',      defaultValue: 0,    min: 0,    max: 2,     curve: 'linear' }, // 0=LP,1=BP,2=HP
    { id: 'filterStyle',   label: 'Pole',      defaultValue: 0,    min: 0,    max: 1,     curve: 'discrete' },
    { id: 'filterDrive',   label: 'Drv',       defaultValue: 1.0,  min: 0.5,  max: 6,     curve: 'linear' },
    { id: 'filterKeyTrack',label: 'Key',       defaultValue: 0.0,  min: -1,   max: 1,     curve: 'linear' },

    // Amp env
    { id: 'ampAttack',   label: 'A A',         defaultValue: 0.005, min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'ampDecay',    label: 'A D',         defaultValue: 0.2,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'ampSustain',  label: 'A S',         defaultValue: 0.6,   min: 0,   max: 1,     curve: 'linear' },
    { id: 'ampRelease',  label: 'A R',         defaultValue: 0.3,   min: 0,   max: 8,     curve: 'linear', units: 's' },

    // Filter env
    { id: 'filAttack',   label: 'F A',         defaultValue: 0.005, min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'filDecay',    label: 'F D',         defaultValue: 0.5,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'filSustain',  label: 'F S',         defaultValue: 0.0,   min: 0,   max: 1,     curve: 'linear' },
    { id: 'filRelease',  label: 'F R',         defaultValue: 0.3,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'filEnvDepth', label: 'F Dpth',      defaultValue: 0,     min: -1,  max: 1,     curve: 'linear' },

    // Mod env
    { id: 'modAttack',   label: 'M A',         defaultValue: 0.005, min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'modDecay',    label: 'M D',         defaultValue: 0.5,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'modSustain',  label: 'M S',         defaultValue: 0.0,   min: 0,   max: 1,     curve: 'linear' },
    { id: 'modRelease',  label: 'M R',         defaultValue: 0.3,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'modEnvDepth', label: 'M Dpth',      defaultValue: 0,     min: -1,  max: 1,     curve: 'linear' },

    // LFOs
    { id: 'lfo1Wave',    label: 'L1 W',        defaultValue: 3,     min: 0,   max: 3,     curve: 'discrete' },
    { id: 'lfo1Freq',    label: 'L1 Hz',       defaultValue: 1.0,   min: 0.01,max: 30,    curve: 'log', units: 'Hz' },
    { id: 'lfo1Amp',     label: 'L1 Amt',      defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },

    { id: 'lfo2Wave',    label: 'L2 W',        defaultValue: 3,     min: 0,   max: 3,     curve: 'discrete' },
    { id: 'lfo2Freq',    label: 'L2 Hz',       defaultValue: 4.0,   min: 0.01,max: 30,    curve: 'log', units: 'Hz' },
    { id: 'lfo2Amp',     label: 'L2 Amt',      defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },

    // Step sequencer
    { id: 'stepNumSteps',label: 'Steps',       defaultValue: 8,     min: 1,   max: 16,    curve: 'discrete' },
    { id: 'stepRate',    label: 'St Hz',       defaultValue: 4.0,   min: 0.1, max: 30,    curve: 'log', units: 'Hz' },
    { id: 'stepSmooth',  label: 'St Smth',     defaultValue: 0.0,   min: 0,   max: 1,     curve: 'linear' },
    { id: 'stepDepth',   label: 'St Dpth',     defaultValue: 0,     min: -1,  max: 1,     curve: 'linear' },

    // Stereo
    { id: 'spread',      label: 'Spr',         defaultValue: 0.3,   min: 0,   max: 1,     curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'polyhelm', {
      // 5 inputs: poly (10ch) + pitch_cv + gate + midi_in (no-op) + seq_reset.
      // channelCountMode defaults to 'max', letting the 10-channel poly source
      // pass through cleanly on input 0 (same as dx7).
      numberOfInputs: 5,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    } as AudioWorkletNodeOptions);

    // ---------------- Apply initial param values ----------------
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of polyhelmDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // Stereo splitter so the engine can address out_l / out_r individually.
    const splitter = ctx.createChannelSplitter(2);
    workletNode.connect(splitter);

    // ---------------- MIDI state ----------------
    const savedData = ((node.data ?? {}) as Partial<HelmMidiData>);
    let selectedDeviceId: string | null = savedData.lastDeviceId ?? null;
    let channelsSelected: number[] | null = savedData.channels ?? null;
    const activeNotes = new Set<number>();
    let lastNote: number | null = null;
    let access: MidiAccessLike | null = null;
    let permissionDenied = false;
    let settingsOpen = false;
    let subscriber: ((s: HelmMidiState) => void) | null = null;
    let channelSet: Set<number> | null = expandChannelSet(channelsSelected);
    let seqOn = savedData.seqOn === true;
    let currentStep = -1;

    // Initial step pattern from node.data.steps if present.
    {
      const data = node.data as { steps?: number[] } | undefined;
      if (data && Array.isArray(data.steps)) {
        workletNode.port.postMessage({ type: 'set-steps', steps: data.steps.slice(0, 16) });
      }
    }
    workletNode.port.postMessage({ type: 'set-seq-on', on: seqOn });

    // Listen for step-tick messages from the worklet.
    workletNode.port.onmessage = (e: MessageEvent<{ type: string; step?: number }>) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'step-tick' && typeof m.step === 'number') {
        currentStep = m.step;
        notify();
      }
    };

    function snapshot(): HelmMidiState {
      const devices: HelmMidiState['devices'] = [];
      if (access) {
        for (const [id, inp] of access.inputs) {
          devices.push({ id, name: inp.name ?? id, state: inp.state });
        }
      }
      return {
        connected: access !== null,
        permissionDenied,
        devices,
        selectedDeviceId,
        channels: channelsSelected,
        lastNote,
        activeNotes: Array.from(activeNotes).sort((a, b) => a - b),
        settingsOpen,
        seqOn,
        currentStep,
      };
    }
    function notify(): void { subscriber?.(snapshot()); }

    function handleMidiMessage(ev: MidiEventLike): void {
      const data = ev.data;
      if (data.length < 1) return;
      const status = data[0]!;
      if ((status & 0x80) && (status & 0xf0) <= 0xe0) {
        if (!midiChannelMatches(status, channelSet)) return;
      }
      const ne = parseHelmMidiEvent(data);
      if (!ne) return;
      if (ne.kind === 'note-on') {
        activeNotes.add(ne.note);
        lastNote = ne.note;
        workletNode.port.postMessage({
          type: 'note-on',
          note: ne.note,
          velocity: ne.velocity,
          channel: ne.channel,
        });
        notify();
      } else if (ne.kind === 'note-off') {
        activeNotes.delete(ne.note);
        workletNode.port.postMessage({ type: 'note-off', note: ne.note, channel: ne.channel });
        notify();
      } else if (ne.kind === 'all-off') {
        activeNotes.clear();
        workletNode.port.postMessage({ type: 'all-off' });
        notify();
      }
    }

    function attachToDevice(deviceId: string | null): void {
      if (!access) return;
      for (const inp of access.inputs.values()) {
        inp.onmidimessage = null;
      }
      if (deviceId === null) return;
      const inp = access.inputs.get(deviceId);
      if (!inp) return;
      inp.onmidimessage = handleMidiMessage;
    }

    function pickDefaultDevice(): string | null {
      if (!access) return null;
      if (selectedDeviceId && access.inputs.has(selectedDeviceId)) return selectedDeviceId;
      const first = access.inputs.values().next();
      if (first.done) return null;
      return first.value.id;
    }

    async function connect(): Promise<boolean> {
      if (access) return true;
      if (!webMidiAvailable()) {
        permissionDenied = true;
        notify();
        return false;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = await (navigator as any).requestMIDIAccess({ sysex: false });
        access = a as MidiAccessLike;
        access.onstatechange = () => {
          if (!selectedDeviceId) {
            selectedDeviceId = pickDefaultDevice();
            attachToDevice(selectedDeviceId);
          }
          notify();
        };
        selectedDeviceId = pickDefaultDevice();
        attachToDevice(selectedDeviceId);
        notify();
        return true;
      } catch {
        permissionDenied = true;
        notify();
        return false;
      }
    }

    function selectDevice(deviceId: string | null): void {
      selectedDeviceId = deviceId;
      attachToDevice(deviceId);
      notify();
    }

    function setChannels(channels: number[] | null): void {
      channelsSelected = channels;
      channelSet = expandChannelSet(channels);
      if (activeNotes.size > 0) {
        workletNode.port.postMessage({ type: 'all-off' });
        activeNotes.clear();
      }
      notify();
    }

    function setSettingsOpen(open: boolean): void {
      settingsOpen = open;
      notify();
    }

    function setSteps(steps: number[]): void {
      workletNode.port.postMessage({ type: 'set-steps', steps: steps.slice(0, 16) });
    }

    function setSeqOn(on: boolean): void {
      seqOn = !!on;
      workletNode.port.postMessage({ type: 'set-seq-on', on: seqOn });
      notify();
    }

    function resetSeq(): void {
      currentStep = -1;
      workletNode.port.postMessage({ type: 'seq-reset' });
      notify();
    }

    const cardApi: HelmCardApi = {
      connect,
      selectDevice,
      setChannels,
      setSettingsOpen,
      setSteps,
      setSeqOn,
      resetSeq,
      getState: snapshot,
      subscribe(cb) {
        subscriber = cb;
        cb(snapshot());
        return () => { if (subscriber === cb) subscriber = null; };
      },
    };

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['poly',      { node: workletNode, input: 0 }],
        ['pitch_cv',  { node: workletNode, input: 1 }],
        ['gate',      { node: workletNode, input: 2 }],
        ['midi_in',   { node: workletNode, input: 3 }],
        ['seq_reset', { node: workletNode, input: 4 }],
      ]),
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ['out_l', { node: splitter, output: 0 }],
        ['out_r', { node: splitter, output: 1 }],
      ]),
      setParam(paramId, value) {
        const p = params.get(paramId);
        if (!p) return;
        p.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'card-api') return cardApi;
        if (key === 'state') return snapshot();
        return undefined;
      },
      dispose() {
        if (access) {
          for (const inp of access.inputs.values()) inp.onmidimessage = null;
          access.onstatechange = null;
          access = null;
        }
        subscriber = null;
        try { workletNode.port.onmessage = null; } catch { /* */ }
        try { workletNode.port.close(); } catch { /* */ }
        try { splitter.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
