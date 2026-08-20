// packages/web/src/lib/audio/vst/bridge.worker.ts
//
// The VST bridge transport worker — one PER CARD INSTANCE (the helper's
// session model is one WebSocket = one plugin instance). Owns the socket to
// the vst-bridge native helper and shuttles blocks between it and the three
// SharedArrayBuffer rings shared with the 'vst-bridge' AudioWorklet, so
// neither direction ever touches the (jank-prone) main thread:
//
//   WS 0x01 (plugin out)   ──decode──▶ inRing SAB ──▶ worklet outputs
//   worklet inputs ──▶ outRing SAB ──drain (10 ms)──▶ WS 0x01 (planes for
//                                       the fx card / mask-0 CLOCK blocks
//                                       for the instrument card)
//   worklet MIDI  ──▶ midiRing SAB ──drain (BEFORE audio)──▶ WS 0x02
//
// Control-plane (JSON) messages are forwarded to the main thread for the
// card UI; card→bridge control (mount/unmount/editor/state/rescan) arrives
// as 'control' messages and goes out verbatim. Reconnects with backoff
// while enabled. Cloned from es9/bridge.worker.ts with the §6 deltas:
// hello carries clientId (the graph node id — parked-instance reattach);
// no config/takeover/single-client machinery; a bridge-side 'stopped'
// status is an EVICTION (another tab claimed this clientId) and disables
// auto-reconnect so two tabs cannot fight over the instance.

import { MidiRingIO, RingIO, type MidiRingSpec, type RingSpec } from './vst-ring';
import { closeStateAfter } from '../es9/bridge-state';
import {
  VST_MAX_BLOCK_FRAMES,
  VST_MAX_MIDI_EVENTS,
  decodeBlock,
  encodeBlock,
  encodeMidiBlock,
  type VstMidiEventIn,
} from './vst-protocol';

interface StartMsg {
  type: 'start';
  url: string;
  /** AudioContext rate — the bridge renders AT this rate (no resampling). */
  rate: number;
  /** The graph node id: parks/adopts the plugin instance across reconnects. */
  clientId: string;
  inRing: RingSpec;      // bridge → graph (this worker WRITES)
  outRing: RingSpec;     // graph → bridge (this worker READS)
  midiRing: MidiRingSpec; // worklet MIDI → bridge (this worker READS)
  /** true = encode planes 0/1 (fx card); false = mask-0 clock blocks
   *  (instrument card — the plugin has no audio input; blocks only pull). */
  sendPlanes: boolean;
}
interface ControlMsg {
  type: 'control';
  /** Card→bridge JSON control message, sent verbatim once OPEN
   *  (mount / unmount / openEditor / closeEditor / getState / setState /
   *  rescanPlugins). Dropped silently when not connected. */
  msg: Record<string, unknown>;
}
interface StopMsg {
  type: 'stop';
}
type InMsg = StartMsg | ControlMsg | StopMsg;

const DRAIN_INTERVAL_MS = 10;
const PING_INTERVAL_MS = 2000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;

let ws: WebSocket | null = null;
let enabled = false;
let url = '';
let rate = 48000;
let clientId = '';
let inRing: RingIO | null = null;
let outRing: RingIO | null = null;
let midiRing: MidiRingIO | null = null;
let sendPlanes = true;
let accepted = false;
let seq = 0;
let midiSeq = 0;
let sampleTime = 0;
let reconnectMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let drainTimer: ReturnType<typeof setInterval> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
/** Most recent bridge status state on the CURRENT socket (null once
 *  helperInfo proves acceptance) — read at close time by closeStateAfter. */
let lastControlState: string | null = null;
let lastControlDetail: string | undefined;
/** Staging for the audio drain (allocated per start, reused per tick). */
let stage: [Float32Array, Float32Array] = [new Float32Array(0), new Float32Array(0)];
const midiStage: VstMidiEventIn[] = [];

function post(msg: unknown): void {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
}

function sendJSON(obj: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
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
    sendJSON({ type: 'hello', rate, name: 'patchtogether vst card', clientId });
  };

  socket.onmessage = (e: MessageEvent) => {
    if (typeof e.data === 'string') {
      handleControl(e.data);
      return;
    }
    const block = decodeBlock(e.data as ArrayBuffer);
    if (!block || !inRing) return;
    // Plugin output is always stereo mask 0b11. Short writes drop the tail —
    // the worklet slips/fills, and a persistently-full ring means the graph
    // side is gone anyway.
    inRing.write(block.frameCount, (ch, i) => block.planes.get(ch)?.[i] ?? 0);
  };

  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
      accepted = false;
      if (lastControlState === 'stopped') {
        // EVICTED: another tab's hello claimed this clientId. Reconnecting
        // would evict it right back — a two-tab fight. Stay down until the
        // user explicitly reconnects.
        enabled = false;
        post({ type: 'status', state: 'evicted', detail: lastControlDetail });
        return;
      }
      post({
        type: 'status',
        state: closeStateAfter(lastControlState, enabled),
        detail: lastControlDetail,
      });
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
    case 'helperInfo':
      // Genuine acceptance — a later close is a real disconnect, not the
      // busy-close handshake.
      lastControlState = null;
      lastControlDetail = undefined;
      accepted = true;
      post({ type: 'helperInfo', info: msg });
      break;
    case 'pluginList':
    case 'mounted':
    case 'mountError':
    case 'unmounted':
    case 'editor':
    case 'state':
    case 'stateSet':
    case 'meters':
      // Forward the control surface verbatim; the owner fans it to views.
      post({ type: msg.type, msg });
      break;
    case 'status':
      lastControlState = String(msg.state ?? 'unknown');
      lastControlDetail = msg.detail as string | undefined;
      post({ type: 'status', state: lastControlState, detail: lastControlDetail });
      if (msg.state === 'busy') {
        // Instance cap reached — back off to slow retries.
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
  const sendable = accepted && ws !== null && ws.readyState === WebSocket.OPEN;
  if (!sendable) {
    // Keep the rings from backing up (the worklet keeps writing whether or
    // not we're connected; disconnected MIDI events are stale by definition).
    // The skip STILL advances sampleTime: the worklet's frame counter (the
    // MIDI stamp domain) advances for every frame it writes, drained or
    // skipped — falling behind here would stamp reconnect-era audio blocks
    // in the worklet's past and strand its MIDI in the bridge's future.
    if (outRing) sampleTime += outRing.skip(outRing.occupancy);
    midiRing?.read(midiRing.occupancy, () => {});
    return;
  }

  // MIDI BEFORE AUDIO (§5c): an event must go out no later than the audio
  // block that contains its sampleTime.
  if (midiRing && midiRing.occupancy > 0) {
    while (midiRing.occupancy > 0) {
      midiStage.length = 0;
      midiRing.read(VST_MAX_MIDI_EVENTS, (t, d0, d1, d2, len) => {
        midiStage.push({ sampleTime: t, d0, d1, d2, len });
      });
      if (midiStage.length === 0) break;
      ws!.send(encodeMidiBlock(midiSeq++, midiStage));
    }
  }

  if (outRing) {
    while (outRing.occupancy > 0) {
      const n = Math.min(outRing.occupancy, VST_MAX_BLOCK_FRAMES);
      if (stage[0].length < n) stage = [new Float32Array(n), new Float32Array(n)];
      const got = outRing.read(n, (ch, i, v) => {
        const p = stage[ch];
        if (p) p[i] = v;
      });
      if (got <= 0) break;
      const buf = encodeBlock(
        seq++,
        sampleTime,
        sendPlanes ? [0, 1] : [],
        got,
        (ch, i) => stage[ch]?.[i] ?? 0,
      );
      sampleTime += got;
      ws!.send(buf);
    }
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as InMsg;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'start': {
      enabled = true;
      url = m.url;
      rate = m.rate;
      clientId = m.clientId;
      inRing = new RingIO(m.inRing);
      outRing = new RingIO(m.outRing);
      midiRing = new MidiRingIO(m.midiRing);
      sendPlanes = m.sendPlanes;
      seq = 0;
      midiSeq = 0;
      // The sampleTime domain is the WORKLET's outgoing-frame counter (MIDI
      // stamps use it directly). The ring's tail counter IS that counter as
      // of everything drained so far, so a restarted worker (manual
      // reconnect reuses the same rings) resumes the same clock instead of
      // restarting at 0 and stranding queued MIDI in the far future.
      // (Int32 ring counters wrap after ~12.4 h @48 k; a manual reconnect
      // after that long re-bases the epoch — the plugin remount on adopt
      // clears any stale queue, so this degrades to one flushed queue.)
      sampleTime = new Int32Array(m.outRing.header)[1] ?? 0;
      lastControlState = null;
      lastControlDetail = undefined;
      if (drainTimer === null) drainTimer = setInterval(drain, DRAIN_INTERVAL_MS);
      if (pingTimer === null) {
        pingTimer = setInterval(() => sendJSON({ type: 'ping', t: performance.now() }), PING_INTERVAL_MS);
      }
      connect();
      break;
    }
    case 'control':
      sendJSON(m.msg);
      break;
    case 'stop':
      enabled = false;
      accepted = false;
      lastControlState = null;
      lastControlDetail = undefined;
      if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (drainTimer !== null) { clearInterval(drainTimer); drainTimer = null; }
      if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
      try { ws?.close(); } catch { /* already closed */ }
      ws = null;
      post({ type: 'status', state: 'stopped' });
      break;
  }
};
