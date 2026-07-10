// packages/web/src/lib/audio/es9/bridge.worker.ts
//
// The ES-9 bridge transport worker. Owns the WebSocket to the es9-bridge
// native app and shuttles audio between the socket and the two
// SharedArrayBuffer rings shared with the 'es9-bridge' AudioWorklet — so
// neither direction ever touches the (jank-prone) main thread:
//
//   WS binary (ES-9 inputs) ──decode──▶ inRing SAB ──▶ worklet outputs
//   worklet inputs ──▶ outRing SAB ──drain (10 ms)──▶ WS binary (ES-9 outs)
//
// Control-plane (JSON) messages are forwarded to the main thread for the
// card UI (deviceInfo / meters / status / rtt). Reconnects with backoff
// while enabled; the far side's underrun policy + the worklet's own
// hold/fade policy make connection gaps click-free.
//
// Vite module worker: created via
//   new Worker(new URL('./bridge.worker.ts', import.meta.url), { type: 'module' })

import { RingIO, type RingSpec } from './es9-ring';
import {
  decodeBlock,
  encodeBlock,
  channelsToMask,
  ES9_MAX_BLOCK_FRAMES,
} from './es9-protocol';

interface StartMsg {
  type: 'start';
  url: string;
  /** AudioContext rate — sent in hello; the bridge resamples to/from it. */
  rate: number;
  inRing: RingSpec;   // hardware → graph (this worker WRITES)
  outRing: RingSpec;  // graph → hardware (this worker READS)
  inputChannels: number[];   // ES-9 input channels to subscribe
  outputChannels: number[];  // ES-9 output channels we drive
  /** Sparse channel → 'audio' | 'cv' underrun mode for driven outputs. */
  outputModes: Record<string, 'audio' | 'cv'>;
}
interface ConfigMsg {
  type: 'config';
  inputChannels: number[];
  outputChannels: number[];
  outputModes: Record<string, 'audio' | 'cv'>;
}
interface StopMsg {
  type: 'stop';
}
type InMsg = StartMsg | ConfigMsg | StopMsg;

const DRAIN_INTERVAL_MS = 10;
const PING_INTERVAL_MS = 2000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;

let ws: WebSocket | null = null;
let enabled = false;
let url = '';
let rate = 48000;
let inRing: RingIO | null = null;
let outRing: RingIO | null = null;
let inputChannels: number[] = [];
let outputChannels: number[] = [];
let outputModes: Record<string, 'audio' | 'cv'> = {};
let configured = false;
let seq = 0;
let sampleTime = 0;
let reconnectMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let drainTimer: ReturnType<typeof setInterval> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

function post(msg: unknown): void {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
}

function sendJSON(obj: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendConfig(): void {
  sendJSON({
    type: 'config',
    inputMask: channelsToMask(inputChannels),
    outputMask: channelsToMask(outputChannels),
    outputModes,
  });
  configured = true;
}

function connect(): void {
  if (!enabled) return;
  post({ type: 'status', state: 'connecting' });
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => {
    reconnectMs = RECONNECT_MIN_MS;
    sendJSON({ type: 'hello', rate, name: 'patchtogether es9 module' });
  };

  socket.onmessage = (e: MessageEvent) => {
    if (typeof e.data === 'string') {
      handleControl(e.data);
      return;
    }
    const block = decodeBlock(e.data as ArrayBuffer);
    if (!block || !inRing || !configured) return;
    // Full-width write: subscribed channels take the received plane,
    // everything else stays 0 for this span. Short writes drop the tail —
    // the worklet slips/fills, and a persistently-full ring means the
    // graph side is gone anyway.
    inRing.write(block.frameCount, (ch, i) => block.planes.get(ch)?.[i] ?? 0);
  };

  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
      configured = false;
      post({ type: 'status', state: enabled ? 'disconnected' : 'stopped' });
      scheduleReconnect();
    }
  };
  socket.onerror = () => {
    // onclose always follows; nothing to do here (avoids double-reconnect).
  };
}

function handleControl(text: string): void {
  let msg: { type?: string } & Record<string, unknown>;
  try {
    msg = JSON.parse(text) as typeof msg;
  } catch {
    return;
  }
  switch (msg.type) {
    case 'deviceInfo':
      post({ type: 'deviceInfo', info: msg });
      sendConfig();
      break;
    case 'meters':
      post({ type: 'meters', meters: msg });
      break;
    case 'status':
      // Bridge-side lifecycle (busy / device_lost / …) — surface to the card.
      post({ type: 'status', state: String(msg.state ?? 'unknown'), detail: msg.detail });
      if (msg.state === 'busy') {
        // Another client owns the bridge; back off to slow retries.
        reconnectMs = RECONNECT_MAX_MS;
      }
      break;
    case 'pong':
      if (typeof msg.t === 'number') {
        post({ type: 'rtt', ms: performance.now() - msg.t });
      }
      break;
  }
}

function scheduleReconnect(): void {
  if (!enabled || reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectMs);
}

function drain(): void {
  if (!outRing || !configured || !ws || ws.readyState !== WebSocket.OPEN) {
    // Not sendable: keep the ring from backing up (the worklet keeps
    // writing 128-frame blocks whether or not we're connected).
    outRing?.skip(outRing.occupancy);
    return;
  }
  if (outputChannels.length === 0) {
    outRing.skip(outRing.occupancy);
    return;
  }
  while (outRing.occupancy > 0) {
    const n = Math.min(outRing.occupancy, ES9_MAX_BLOCK_FRAMES);
    // Stage the span once, then encode the driven channels from the stage.
    const stage: Float32Array[] = [];
    for (let c = 0; c < outRing.channels; c++) stage.push(new Float32Array(n));
    const got = outRing.read(n, (ch, i, v) => {
      const p = stage[ch];
      if (p) p[i] = v;
    });
    if (got <= 0) break;
    const buf = encodeBlock(seq++, sampleTime, outputChannels, got,
      (ch, i) => stage[ch]?.[i] ?? 0);
    sampleTime += got;
    ws.send(buf);
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as InMsg;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'start':
      enabled = true;
      url = m.url;
      rate = m.rate;
      inRing = new RingIO(m.inRing);
      outRing = new RingIO(m.outRing);
      inputChannels = m.inputChannels;
      outputChannels = m.outputChannels;
      outputModes = m.outputModes;
      seq = 0;
      sampleTime = 0;
      if (drainTimer === null) drainTimer = setInterval(drain, DRAIN_INTERVAL_MS);
      if (pingTimer === null) {
        pingTimer = setInterval(() => sendJSON({ type: 'ping', t: performance.now() }), PING_INTERVAL_MS);
      }
      connect();
      break;
    case 'config':
      inputChannels = m.inputChannels;
      outputChannels = m.outputChannels;
      outputModes = m.outputModes;
      if (ws && ws.readyState === WebSocket.OPEN && configured) sendConfig();
      break;
    case 'stop':
      enabled = false;
      configured = false;
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (drainTimer !== null) { clearInterval(drainTimer); drainTimer = null; }
      if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
      try { ws?.close(); } catch { /* already closed */ }
      ws = null;
      post({ type: 'status', state: 'stopped' });
      break;
  }
};
