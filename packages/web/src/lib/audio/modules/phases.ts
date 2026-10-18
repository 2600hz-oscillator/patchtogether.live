import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleNode } from '$lib/graph/types';
import { createWorkletNode } from '$lib/audio/worklet-guard';
import { getDefaultSnapshotBus } from '$lib/graph/snapshot';
import { registerPhasesRuntimeMode } from '$lib/audio/phases-runtime';
import workletUrl from '@patchtogether.live/dsp/dist/phases.js?url';
import {
  sanitizePhasesVertices,
  type PhasesVertex,
} from '../../../../../dsp/src/lib/phases-dsp';

export interface PhasesRuntimeState {
  type: 'state';
  position: number;
  playing: boolean;
  loop: boolean;
  reverse: boolean;
  effectiveLength: number;
  lengthCvPatched: boolean;
  modeRevision?: number;
}

const loadedContexts = new WeakSet<BaseAudioContext>();

export const phasesDef: AudioModuleDef = {
  type: 'phases',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'phases',
  category: 'modulation',
  size: '2u',
  hp: 2,
  inputs: [
    { id: 'trigger', label: 'Trigger', type: 'gate', edge: 'trigger' },
    { id: 'phase_trigger', label: 'Phase Trigger', type: 'gate', edge: 'trigger' },
    { id: 'loop', label: 'Loop', type: 'gate', edge: 'trigger' },
    { id: 'reverse', label: 'Reverse', type: 'gate', edge: 'trigger' },
    // This is a raw, presence-sensitive override, never an additive AudioParam.
    { id: 'length_cv', label: 'Length', type: 'cv' },
  ],
  outputs: [
    { id: 'phase_cv', label: 'Phase CV', type: 'cv' },
  ],
  params: [
    // Literal bounds keep the source-parsed docs manifest complete; the factory
    // test pins them to the DSP constants and the UI reads this ParamDef.
    { id: 'length', label: 'Length', defaultValue: 0.05, min: 0.05, max: 30,
      curve: 'log', units: 's' },
    { id: 'loop', label: 'Loop', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      format: (value) => value >= 0.5 ? 'Loop' : '1-shot' },
    { id: 'polarity', label: 'Polarity', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      format: (value) => value >= 0.5 ? 'Bipolar' : 'Unipolar' },
    { id: 'reverse', label: 'Reverse', defaultValue: 0, min: 0, max: 1, curve: 'discrete',
      format: (value) => value >= 0.5 ? 'Reverse' : 'Forward' },
  ],
  face: {
    order: ['length', 'loop', 'polarity', 'reverse'],
    pages: [{ id: 'envelope', label: 'Playback', controls: ['length', 'loop', 'polarity', 'reverse'] }],
    glyph: 'none',
    extension: 'phases',
    tileBodyHeight: 52,
    rear: {
      groups: [{ id: 'voice', label: 'Gates', ports: ['trigger', 'phase_trigger', 'loop', 'reverse'] }],
      audioRate: ['length_cv'],
    },
  },
  docs: {
    explanation:
      'A drawable complex envelope with up to 24 phases. It starts as a straight horizontal line at the bottom of the grid. Click the envelope line to insert a vertex, then drag that vertex vertically to set its level; its horizontal position fixes its share of the total time. Click a section between vertices to select that phase in pale red and turn Phase Shape: fully left is linear, noon is concave, and fully right is convex. Each phase keeps its own shape. Right-click an interior vertex and choose Delete vertex to join its neighboring phases; the merged phase inherits the original left phase’s shape. Length scales the whole envelope from 0.05 to 30 seconds without moving its normalized playback position. A blue dot tracks the actual audio playhead. Trigger restarts from the current direction’s beginning; Loop repeats continuously and Reverse changes direction in place. Unipolar maps the unchanged drawing to 0…1 CV; Bipolar maps it to −1…+1 CV with a red zero line across the middle. Vertices and shapes are saved and shared with the rack; playback runs in the audio worklet even when the editor is closed.',
    inputs: {
      trigger:
        'Each rising edge crossing the 0.5 gate threshold restarts playback from the envelope’s beginning: the left endpoint when forward, the right endpoint when reversed. A held gate triggers once and does not hold or repeatedly restart the envelope.',
      phase_trigger:
        'Each rising edge crossing 0.5 restarts the current phase from its entry point in the current playback direction. In reverse this is that phase’s right-hand vertex. Also starts playback if stopped; a held gate fires only once.',
      loop:
        'Each rising edge crossing 0.5 toggles between one-shot and loop playback. A held gate toggles once. Enabling Loop starts an idle envelope from its current position, wrapping to the direction’s beginning if it already reached the terminal endpoint. Disabling Loop allows the current pass to finish.',
      reverse:
        'Each rising edge crossing 0.5 toggles the playback direction. The playhead stays at its current position and continues the other way; a held gate toggles only once. Changing direction while stopped does not start playback.',
      length_cv:
        'Patching this input replaces the Length knob completely. Raw 0 CV selects 0.05 seconds and +1 CV selects 30 seconds, with a linear mapping between them; negative values clamp to the minimum and values above +1 clamp to the maximum. Even a patched zero signal has priority. Unpatching restores the knob. Read per sample; changing the time never seeks or restarts the playhead.',
    },
    outputs: {
      phase_cv:
        'The envelope’s current level as one continuous CV output. Unipolar maps the grid bottom to 0 and top to +1; Bipolar maps bottom to −1, center to 0, and top to +1. A stopped one-shot holds its terminal value. Phase retrigger, full retrigger, or loop wrapping can introduce an intentional level discontinuity.',
    },
    controls: {
      length:
        'The duration of one complete pass, from 0.05 seconds at the minimum and default to 30 seconds at maximum, on a logarithmic knob. Phase durations are proportional to their horizontal widths. Changes take effect during playback without relocating the playhead. A patched Length CV fully overrides the knob and the live readout follows the effective time.',
      loop:
        'Switch between one-shot and repeated playback. Enabling Loop starts an idle envelope; disabling it finishes the current pass and holds the final voltage. The button shows the effective mode, including changes caused by the Loop gate.',
      polarity:
        'Unipolar (default): the grid spans 0…+1 CV. Bipolar: the same grid spans −1…+1, with a thin red zero line at the center. Switching changes only the voltage interpretation: vertices, phase shapes, and the playhead remain exactly where they were.',
      reverse:
        'Switch between forward and reverse playback without moving the playhead. Forward travels left to right; Reverse travels right to left. A new Trigger begins at the corresponding entry endpoint. The button shows the effective direction, including changes caused by the Reverse gate.',
    },
  },
  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const initialParams = Object.fromEntries(phasesDef.params.map((def) => [
      def.id, node.params[def.id] ?? def.defaultValue,
    ]));
    const worklet = createWorkletNode(node, ctx, 'phases', {
      numberOfInputs: 5,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      parameterData: initialParams,
    });
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    for (const [id, value] of Object.entries(initialParams)) {
      params.get(id)?.setValueAtTime(value, ctx.currentTime);
    }
    let manualLength = initialParams.length;
    let state: PhasesRuntimeState = {
      type: 'state', position: 0, playing: false,
      loop: initialParams.loop >= 0.5,
      reverse: initialParams.reverse >= 0.5,
      effectiveLength: initialParams.length,
      lengthCvPatched: false,
    };
    let disposed = false;
    let requestedModeRevision = 0;
    worklet.port.onmessage = ({ data }: MessageEvent) => {
      if (disposed || data?.type !== 'state') return;
      const incoming = data as PhasesRuntimeState;
      // A queued pre-click frame must not undo the value the player just set.
      // Once acknowledged, gate-driven modes flow through normally again.
      state = (incoming.modeRevision ?? 0) < requestedModeRevision
        ? { ...incoming, loop: state.loop, reverse: state.reverse }
        : incoming;
    };

    let vertices: PhasesVertex[] = [];
    function sendVertices(raw: unknown): void {
      if (disposed) return;
      const next = sanitizePhasesVertices(raw);
      if (next.length === vertices.length && next.every((v, i) =>
        v.x === vertices[i].x && v.y === vertices[i].y && v.shape === vertices[i].shape)) return;
      vertices = next;
      worklet.port.postMessage({ type: 'vertices', vertices });
    }
    sendVertices(node.data?.vertices);

    // The reconciler does not forward node.data changes. This factory-owned
    // subscription covers undo, collaboration and same-id reloads without UI.
    let previousNode: ModuleNode | undefined;
    const unsubscribe = getDefaultSnapshotBus().subscribe((snapshot) => {
      const current = snapshot.nodes.find((n) => n.id === nodeId && n.type === 'phases');
      if (!current || current === previousNode) return;
      previousNode = current;
      sendVertices(current.data?.vertices);
    });

    function setMode(name: 'loop' | 'reverse', value: boolean): void {
      if (disposed) return;
      params.get(name)?.setValueAtTime(value ? 1 : 0, ctx.currentTime);
      state = { ...state, [name]: value };
      // Explicit intent is necessary even if an AudioParam is unchanged:
      // an input gate may have toggled the effective mode in the meantime.
      worklet.port.postMessage({ type: 'mode', name, value, revision: ++requestedModeRevision });
    }
    const unregisterMode = registerPhasesRuntimeMode(nodeId, setMode);
    function readEffectiveParam(id: string): number | undefined {
      if (id === 'length') return state.lengthCvPatched ? state.effectiveLength : manualLength;
      if (id === 'loop' || id === 'reverse') return state[id] ? 1 : 0;
      return undefined;
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['trigger', { node: worklet, input: 0 }],
        ['phase_trigger', { node: worklet, input: 1 }],
        ['loop', { node: worklet, input: 2 }],
        ['reverse', { node: worklet, input: 3 }],
        ['length_cv', { node: worklet, input: 4 }],
      ]),
      outputs: new Map([['phase_cv', { node: worklet, output: 0 }]]),
      setParam(id, value) {
        if (disposed) return;
        if (id === 'loop' || id === 'reverse') {
          setMode(id, value >= 0.5);
          return;
        }
        params.get(id)?.setValueAtTime(value, ctx.currentTime);
        if (id === 'length') {
          manualLength = value;
          if (!state.lengthCvPatched) state = { ...state, effectiveLength: value };
        }
      },
      readParam(id) {
        return readEffectiveParam(id) ?? params.get(id)?.value;
      },
      readEffectiveParam,
      read(key) {
        return key === 'state' ? state : undefined;
      },
      write(key, value) {
        if (disposed) return;
        if (key === 'trigger') worklet.port.postMessage({ type: 'trigger' });
        else if (key === 'phaseTrigger') worklet.port.postMessage({ type: 'phase-trigger' });
        else if (key === 'mode' && value && typeof value === 'object') {
          const mode = value as { name?: unknown; value?: unknown };
          if ((mode.name === 'loop' || mode.name === 'reverse') && typeof mode.value === 'boolean') {
            setMode(mode.name, mode.value);
          }
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        unregisterMode();
        worklet.port.onmessage = null;
        worklet.port.postMessage({ type: 'dispose' });
        worklet.disconnect();
        worklet.port.close();
      },
    };
  },
};
