// packages/web/src/lib/audio/vst/bridge-client.ts
//
// Card-facing wrapper around the VST bridge transport: allocates the THREE
// SharedArrayBuffer rings (audio in, audio out, MIDI out), spawns the
// transport worker, and exposes a typed event surface. Cloned from
// es9/bridge-client.ts; the OWNER (bridge-owner.ts, keyed by graph node id)
// owns this object's lifecycle — one client PER CARD INSTANCE, because the
// helper's session model is one WebSocket = one plugin instance.
//
// URL resolution follows the provider.ts pattern: a build-time env override
// (VITE_VST_BRIDGE_URL) with a literal localhost fallback. 9309 avoids the
// repo's reserved ports (9209/9210 es9, 1234 Bitwig OSC, 1235 Hocuspocus,
// 5173/4173 Vite).

import {
  createMidiRingSpec,
  createRingSpec,
  sharedArrayBufferAvailable,
  type MidiRingSpec,
  type RingSpec,
} from './vst-ring';
import {
  VST_DEFAULT_URL,
  type VstEditor,
  type VstHelperInfo,
  type VstMeters,
  type VstMountError,
  type VstMounted,
  type VstPluginList,
  type VstState,
  type VstStateSet,
} from './vst-protocol';

export type VstConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'busy'
  /** Another tab's hello claimed this clientId — auto-reconnect is OFF
   *  (reconnecting would evict it right back); connect again to reclaim. */
  | 'evicted'
  | 'stopped'
  | 'unsupported';

export interface VstBridgeConfig {
  /** The graph node id — the helper parks/adopts the plugin instance by it. */
  clientId: string;
  /** true = fx card (send audio planes); false = instrument card (send
   *  mask-0 clock blocks — the plugin has no audio input). */
  sendPlanes: boolean;
}

export interface VstBridgeEvents {
  onState?(state: VstConnectionState, detail?: string): void;
  onHelperInfo?(info: VstHelperInfo): void;
  onPluginList?(msg: VstPluginList): void;
  onMounted?(msg: VstMounted): void;
  onMountError?(msg: VstMountError): void;
  onUnmounted?(): void;
  onEditor?(msg: VstEditor): void;
  onPluginState?(msg: VstState): void;
  onStateSet?(msg: VstStateSet): void;
  onMeters?(msg: VstMeters): void;
  onRtt?(ms: number): void;
}

/** Audio ring depth per side (frames per channel; power of two). ~170 ms
 *  @48 k — jitter headroom, not steady-state latency (the worklet slips back
 *  to its ~512-frame target whenever the buffer runs away). */
const RING_FRAMES = 8192;
const CHANNELS = 2;
/** MIDI ring depth in events. 1024 events between 10 ms drains would be a
 *  hostile patch; overflow drops (never blocks the audio thread). */
const MIDI_RING_EVENTS = 1024;

export function vstBridgeUrl(): string {
  // E2E seam: a page-injected override (addInitScript in the mocked-helper
  // specs, so the mock server can bind an ephemeral port) wins, then the
  // build-time env, then the localhost default. Read on the main thread at
  // start() time — the worker receives the resolved URL.
  const g = globalThis as unknown as { __vstBridgeUrlOverride?: string };
  if (typeof g.__vstBridgeUrlOverride === 'string' && g.__vstBridgeUrlOverride.length > 0) {
    return g.__vstBridgeUrlOverride;
  }
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_VST_BRIDGE_URL || VST_DEFAULT_URL;
}

export class VstBridgeClient {
  readonly inRing: RingSpec;
  readonly outRing: RingSpec;
  readonly midiRing: MidiRingSpec;
  private worker: Worker | null = null;
  private readonly events: VstBridgeEvents;
  private lastState: VstConnectionState = 'idle';

  constructor(events: VstBridgeEvents = {}) {
    this.events = events;
    if (!sharedArrayBufferAvailable()) {
      // The /rack routes are crossOriginIsolated (COOP/COEP), so this only
      // trips on unusual embeddings — surface it rather than half-working.
      this.inRing = { header: undefined as never, data: undefined as never, channels: 0, capacity: 0 };
      this.outRing = this.inRing;
      this.midiRing = { header: undefined as never, data: undefined as never, capacity: 0 };
      this.lastState = 'unsupported';
      queueMicrotask(() => events.onState?.('unsupported'));
      return;
    }
    this.inRing = createRingSpec(CHANNELS, RING_FRAMES);
    this.outRing = createRingSpec(CHANNELS, RING_FRAMES);
    this.midiRing = createMidiRingSpec(MIDI_RING_EVENTS);
  }

  get supported(): boolean {
    return this.lastState !== 'unsupported';
  }

  get state(): VstConnectionState {
    return this.lastState;
  }

  start(rate: number, config: VstBridgeConfig, url = vstBridgeUrl()): void {
    if (!this.supported || this.worker) return;
    this.worker = new Worker(new URL('./bridge.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent) => this.handleWorkerMessage(e.data);
    this.worker.postMessage({
      type: 'start',
      url,
      rate,
      clientId: config.clientId,
      inRing: this.inRing,
      outRing: this.outRing,
      midiRing: this.midiRing,
      sendPlanes: config.sendPlanes,
    });
  }

  /** Send one card→bridge control message (mount/unmount/openEditor/
   *  closeEditor/getState/setState/rescanPlugins) — dropped when not
   *  connected. */
  sendControl(msg: Record<string, unknown>): void {
    this.worker?.postMessage({ type: 'control', msg });
  }

  stop(): void {
    this.worker?.postMessage({ type: 'stop' });
    this.worker?.terminate();
    this.worker = null;
    if (this.supported) {
      this.lastState = 'stopped';
      this.events.onState?.('stopped');
    }
  }

  private handleWorkerMessage(data: unknown): void {
    const m = data as { type?: string } & Record<string, unknown>;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'status': {
        const state = String(m.state ?? 'disconnected') as VstConnectionState;
        this.lastState = state;
        this.events.onState?.(state, m.detail as string | undefined);
        break;
      }
      case 'helperInfo':
        this.lastState = 'connected';
        this.events.onState?.('connected');
        this.events.onHelperInfo?.(m.info as VstHelperInfo);
        break;
      case 'pluginList':
        this.events.onPluginList?.(m.msg as VstPluginList);
        break;
      case 'mounted':
        this.events.onMounted?.(m.msg as VstMounted);
        break;
      case 'mountError':
        this.events.onMountError?.(m.msg as VstMountError);
        break;
      case 'unmounted':
        this.events.onUnmounted?.();
        break;
      case 'editor':
        this.events.onEditor?.(m.msg as VstEditor);
        break;
      case 'state':
        this.events.onPluginState?.(m.msg as VstState);
        break;
      case 'stateSet':
        this.events.onStateSet?.(m.msg as VstStateSet);
        break;
      case 'meters':
        this.events.onMeters?.(m.msg as VstMeters);
        break;
      case 'rtt':
        this.events.onRtt?.(m.ms as number);
        break;
    }
  }
}
