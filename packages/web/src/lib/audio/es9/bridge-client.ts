// packages/web/src/lib/audio/es9/bridge-client.ts
//
// Card-facing wrapper around the ES-9 bridge transport: allocates the two
// SharedArrayBuffer rings, spawns the transport worker, and exposes a typed
// event surface. The CARD owns this object's lifecycle (spawn on connect,
// dispose on card teardown / disconnect) — mirroring how AudioinCard owns
// its MediaStream. The engine factory only ever sees the ring specs, via
// the module's attach hook.
//
// URL resolution follows the multiplayer provider.ts pattern: a build-time
// env override (VITE_ES9_BRIDGE_URL) with a literal localhost fallback.
// 9209 avoids the repo's reserved ports (1234 Bitwig OSC, 1235 Hocuspocus,
// 5173/4173 Vite).

import { createRingSpec, sharedArrayBufferAvailable, type RingSpec } from './es9-ring';
import { ES9_DEFAULT_URL, type Es9DeviceInfo, type Es9Meters } from './es9-protocol';

export type Es9ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'busy'
  | 'device_lost'
  | 'stopped'
  | 'unsupported';

export interface Es9BridgeConfig {
  /** ES-9 input channels to subscribe (0-based). */
  inputChannels: number[];
  /** ES-9 output channels this client drives (0-based). */
  outputChannels: number[];
  /** Sparse channel → underrun mode for driven outputs ('cv' = hold). */
  outputModes: Record<string, 'audio' | 'cv'>;
}

export interface Es9BridgeEvents {
  onState?(state: Es9ConnectionState, detail?: string): void;
  onDeviceInfo?(info: Es9DeviceInfo): void;
  onMeters?(meters: Es9Meters): void;
  onRtt?(ms: number): void;
}

/** Ring depth per side (frames per channel; power of two). ~170 ms @48 k —
 *  jitter headroom, not steady-state latency (the worklet slips back to its
 *  ~512-frame target whenever the buffer runs away). */
const RING_FRAMES = 8192;
const HW_CHANNELS = 16;

export function es9BridgeUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_ES9_BRIDGE_URL || ES9_DEFAULT_URL;
}

export class Es9BridgeClient {
  readonly inRing: RingSpec;
  readonly outRing: RingSpec;
  private worker: Worker | null = null;
  private readonly events: Es9BridgeEvents;
  private lastState: Es9ConnectionState = 'idle';

  constructor(events: Es9BridgeEvents = {}) {
    this.events = events;
    if (!sharedArrayBufferAvailable()) {
      // The /rack routes are crossOriginIsolated (COOP/COEP for Faust), so
      // this only trips on unusual embeddings — surface it rather than
      // half-working. (Safari additionally blocks ws://localhost from https
      // pages; that surfaces as a normal connect failure.)
      this.inRing = { header: undefined as never, data: undefined as never, channels: 0, capacity: 0 };
      this.outRing = this.inRing;
      this.lastState = 'unsupported';
      queueMicrotask(() => events.onState?.('unsupported'));
      return;
    }
    this.inRing = createRingSpec(HW_CHANNELS, RING_FRAMES);
    this.outRing = createRingSpec(HW_CHANNELS, RING_FRAMES);
  }

  get supported(): boolean {
    return this.lastState !== 'unsupported';
  }

  get state(): Es9ConnectionState {
    return this.lastState;
  }

  start(rate: number, config: Es9BridgeConfig, url = es9BridgeUrl()): void {
    if (!this.supported || this.worker) return;
    this.worker = new Worker(new URL('./bridge.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent) => this.handleWorkerMessage(e.data);
    this.worker.postMessage({
      type: 'start',
      url,
      rate,
      inRing: this.inRing,
      outRing: this.outRing,
      inputChannels: config.inputChannels,
      outputChannels: config.outputChannels,
      outputModes: config.outputModes,
    });
  }

  updateConfig(config: Es9BridgeConfig): void {
    this.worker?.postMessage({
      type: 'config',
      inputChannels: config.inputChannels,
      outputChannels: config.outputChannels,
      outputModes: config.outputModes,
    });
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
        const state = String(m.state ?? 'disconnected') as Es9ConnectionState;
        this.lastState = state;
        this.events.onState?.(state, m.detail as string | undefined);
        break;
      }
      case 'deviceInfo':
        this.lastState = 'connected';
        this.events.onState?.('connected');
        this.events.onDeviceInfo?.(m.info as Es9DeviceInfo);
        break;
      case 'meters':
        this.events.onMeters?.(m.meters as Es9Meters);
        break;
      case 'rtt':
        this.events.onRtt?.(m.ms as number);
        break;
    }
  }
}
