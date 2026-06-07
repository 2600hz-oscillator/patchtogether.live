// packages/web/src/lib/audio/modules/dx7.ts
//
// DX7-style FM synth module. Pure-TypeScript 6-op AudioWorklet (no Plaits
// dependency). See packages/dsp/src/dx7.ts for the worklet, and
// packages/web/src/lib/audio/dx7-syx.ts for the SYX bank parser.
//
// I/O:
//   inputs:
//     poly      — polyPitchGate (5 voice pairs of pitch+gate). Preferred.
//     pitch_cv  — mono V/oct (legacy single-voice use).
//     gate      — mono gate  (legacy single-voice use).
//   outputs:
//     out       — mono audio.
//
// Params:
//   algorithm   — 1..32 (DX7 algorithm; quantized; live editing OK).
//                 NOT an AudioParam on the worklet — host bridge sends a
//                 fresh patch message via port.postMessage when the knob
//                 moves. The setParam handler MUST check this branch
//                 before the AudioParam-lookup early-out (regression PR
//                 fix/dx7-algorithm-switching).
//   voiceCount  — 1..5 (poly limit). AudioParam.
//   level       — master output level. AudioParam.
//   transpose   — ±24 semitones. AudioParam.
//
// Patch selection (data-side, not AudioParam):
//   node.data.preset  — name of bundled patch (DX7_BUILTIN_BANK).
//   node.data.userPatches — array of DX7Voice loaded from SYX. Lives in
//                           node.data, so it rides the Y.Doc out to every
//                           rack-mate AND is persisted by Hocuspocus snapshots
//                           and the .imp.json export envelope. See
//                           .myrobots/plans/rackspace-persistence.md.
//
// On preset change, the host sends a `{type:'patch', voice}` message to the
// worklet which rebuilds its internal patch state.
//
// Inputs:
//   poly (polyPitchGate): polyphonic pitch+gate (preferred — up to 5 voices).
//   pitch_cv (cv): mono V/oct (legacy single-voice route).
//   gate (gate): mono gate (legacy single-voice route).
//
// Outputs:
//   out (audio): mono mixed voice bus.
//
// Params:
//   algorithm (discrete 1..32, default 5): DX7 algorithm index (live-editable).
//   voiceCount (discrete 1..5, default 5): polyphony cap.
//   level (linear 0..2, default 0.7): output level.
//   transpose (linear -24..24 st, default 0): global transposition.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { DX7Voice } from '$lib/audio/dx7-syx';
import { DX7_BUILTIN_BANK, findBuiltinPatch } from '$lib/audio/dx7-banks';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/dx7.js?url';

const POLL_MS = 100;

// Track of which AudioContexts already have the worklet module loaded.
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Default preset for fresh modules. */
export const DX7_DEFAULT_PRESET = 'E.PIANO 1';

export const dx7Def: AudioModuleDef = {
  type: 'dx7',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'dx7',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    // poly: 10-channel polyPitchGate; lane i drives voice i.
    { id: 'poly',     type: 'polyPitchGate' },
    // mono fallbacks for legacy single-voice patching:
    { id: 'pitch_cv', type: 'cv' },
    { id: 'gate',     type: 'gate' },
  ],
  outputs: [
    { id: 'out', type: 'audio' },
  ],

  params: [
    { id: 'algorithm',  label: 'Algorithm',   defaultValue: 5,   min: 1,   max: 32, curve: 'discrete' },
    { id: 'voiceCount', label: 'Voices',      defaultValue: 5,   min: 1,   max: 5,  curve: 'discrete' },
    { id: 'level',      label: 'Level',       defaultValue: 0.7, min: 0,   max: 2,  curve: 'linear' },
    { id: 'transpose',  label: 'Transpose',   defaultValue: 0,   min: -24, max: 24, curve: 'linear', units: 'st' },
    // Per-voice master OUTPUT-VCA ADSR (per-voice-ADSR feature) — a player-dialable
    // amplitude swell/long-release on top of the SYX operator EGs. Defaults are
    // ~pass-through so loaded patches sound identical until you touch these.
    { id: 'attack',  label: 'Atk', defaultValue: 0.001, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'decay',   label: 'Dec', defaultValue: 0.1,   min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'sustain', label: 'Sus', defaultValue: 1,     min: 0,     max: 1, curve: 'linear' },
    { id: 'release', label: 'Rel', defaultValue: 0.005, min: 0.001, max: 5, curve: 'log', units: 's' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'dx7', {
      // 3 inputs: poly (10ch) + pitch_cv (mono) + gate (mono).
      // The poly input port is 10 channels; mono inputs are 1 channel each.
      // Web Audio honors per-input channelCount via the source's connection
      // shape (the engine connects a 10-channel source to input 0). The
      // worklet reads inputs[0][channel] for each lane, so no special config
      // needed here — channelCountMode on AudioWorkletNode defaults to
      // 'max' which lets multi-channel sources pass through cleanly.
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    } as AudioWorkletNodeOptions);

    // Apply initial param values.
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of dx7Def.params) {
      if (def.id === 'algorithm') continue; // applied via patch message
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // Track currently-applied preset name + algorithm. We poll
    // livePatch.nodes[id].data.preset so Card-driven preset changes flow
    // through to the worklet without a custom engine API.
    function readUserPatches(): DX7Voice[] {
      const live = livePatch.nodes[node.id];
      const arr = (live?.data as Record<string, unknown> | undefined)?.userPatches;
      return Array.isArray(arr) ? (arr as DX7Voice[]) : [];
    }
    function readPresetName(): string {
      const live = livePatch.nodes[node.id];
      const p = (live?.data as Record<string, unknown> | undefined)?.preset;
      return typeof p === 'string' && p.length > 0 ? p : DX7_DEFAULT_PRESET;
    }

    let currentPresetName = readPresetName();
    let currentAlgo = (node.params?.algorithm ?? 5) as number;

    function findPatch(name: string): DX7Voice {
      const user = readUserPatches();
      return (
        user.find((p) => p.name === name) ??
        findBuiltinPatch(name) ??
        DX7_BUILTIN_BANK[0]!
      );
    }

    function sendPatch(voice: DX7Voice, algoOverride?: number): void {
      const a = algoOverride ?? voice.algorithm;
      // BUG-FIX (PR fix/dx7-syx-bank-loading): SYX-loaded voices live in the
      // SyncedStore (Yjs Y.Doc). Reading `node.data.userPatches[i]` returns
      // a Yjs PROXY (not a plain object): the operators are Y.Map proxies
      // and `op.r`/`op.l` are Y.Array proxies. Passing those through
      // `port.postMessage` triggers structuredClone, which throws
      // "[object Array] could not be cloned" on Yjs proxies — so the
      // worklet never sees the new patch and keeps playing whatever it last
      // received (the bundled E.PIANO 1 sent on factory init).
      //
      // Fix: deep-unwrap to plain JS before posting. We hand-build the
      // payload (rather than JSON-roundtrip the whole voice) so we stay
      // explicit about which fields cross the boundary, and so primitive
      // arrays (`r`, `l`) are forced to plain Array<number>.
      const ops = voice.operators.map((o) => ({
        r: [Number(o.r[0]), Number(o.r[1]), Number(o.r[2]), Number(o.r[3])] as [number, number, number, number],
        l: [Number(o.l[0]), Number(o.l[1]), Number(o.l[2]), Number(o.l[3])] as [number, number, number, number],
        ratio: Number(o.ratio),
        detune: Number(o.detune),
        detuneFactor: Number(o.detuneFactor),
        level: Number(o.level),
        fixedMode: Boolean(o.fixedMode),
        velocitySens: Number(o.velocitySens),
      }));
      workletNode.port.postMessage({
        type: 'patch',
        voice: {
          name: String(voice.name ?? ''),
          algorithm: a,
          feedback: Number(voice.feedback),
          operators: ops,
          transpose: Number(voice.transpose),
        },
      });
    }

    // Initial patch send.
    {
      const v = findPatch(currentPresetName);
      // If the saved patch had an algorithm value, prefer it; otherwise use
      // the preset's stored algorithm.
      const initialAlgo =
        node.params?.algorithm !== undefined ? (node.params.algorithm as number) : v.algorithm;
      currentAlgo = Math.max(1, Math.min(32, Math.round(initialAlgo)));
      sendPatch(v, currentAlgo);
      // Note: 'algorithm' is host-tracked, not an AudioParam. The Card's
      // motorized live-read goes through readParam('algorithm') below which
      // returns `currentAlgo`.
    }

    // Poll for preset changes. Yjs syncs node.data updates from remote
    // collaborators (and local Card edits), so this captures both.
    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    function pollPresetChange(): void {
      if (!alive) return;
      const name = readPresetName();
      if (name !== currentPresetName) {
        currentPresetName = name;
        const v = findPatch(name);
        // Adopt the patch's algorithm on preset change. We deliberately do
        // NOT write back to node.params.algorithm — that would loop through
        // Yjs and conflict with the Card→engine knob path. The Card's
        // motorized live-read picks up the change via readParam('algorithm').
        currentAlgo = v.algorithm;
        sendPatch(v, currentAlgo);
      }
      pollTimer = setTimeout(pollPresetChange, POLL_MS);
    }
    pollTimer = setTimeout(pollPresetChange, POLL_MS);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['poly',     { node: workletNode, input: 0 }],
        ['pitch_cv', { node: workletNode, input: 1 }],
        ['gate',     { node: workletNode, input: 2 }],
      ]),
      outputs: new Map([['out', { node: workletNode, output: 0 }]]),
      setParam(paramId, value) {
        // BUG-FIX (PR fix/dx7-algorithm-switching): `algorithm` is NOT an
        // AudioParam on the worklet — only `voiceCount`, `level`, and
        // `transpose` are. Algorithm changes flow through the patch-message
        // channel (worklet.port.postMessage) instead. So we MUST handle
        // 'algorithm' BEFORE the `if (!p) return` early-out — otherwise
        // moving the algo knob silently no-ops (the visible bug fixed here).
        if (paramId === 'algorithm') {
          const a = Math.max(1, Math.min(32, Math.round(value)));
          if (a !== currentAlgo) {
            currentAlgo = a;
            // Re-send current preset with overridden algorithm. The worklet
            // re-binds its routing graph from `this.patch.algorithm` on the
            // next render block, so this takes effect within ~3ms.
            const base = findPatch(currentPresetName);
            sendPatch(base, a);
          }
          return;
        }
        const p = params.get(paramId);
        if (!p) return;
        p.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        // 'algorithm' has no AudioParam (see setParam comment) — return the
        // host-tracked value so the Knob's motorized live-read can render
        // the current algo.
        if (paramId === 'algorithm') return currentAlgo;
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'preset') return currentPresetName;
        if (key === 'algorithm') return currentAlgo;
        return undefined;
      },
      dispose() {
        alive = false;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        try { workletNode.port.close(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};

