// e2e/_helpers/mock-vst-bridge.ts
//
// A Node-side MOCK of the vst-bridge native helper, speaking REAL protocol
// v1 over a REAL WebSocket on an ephemeral 127.0.0.1 port — only the PLUGIN
// is faked. The specs point the app at it through the page-injected
// `__vstBridgeUrlOverride` seam (vst/bridge-client.ts), so the entire
// browser-side stack (owner → worker → SAB rings → worklet → CV→MIDI
// conversion) runs unmodified; the mock is what stands where the AU plugin
// host would. Wire codecs are IMPORTED from the app source (relative import,
// the push2-map/pitch-detect precedent) — never duplicated — so a codec
// drift fails here too.
//
// Faked plugins:
//   mock:sine  (instrument) — renders a sine per active MIDI note (0x02
//                             NoteOn/NoteOff on the client's sample clock),
//                             so "clip notes → audible RMS" is provable.
//   mock:mute  (effect)     — outputs silence, so "the helper path is live"
//                             is distinguishable from the local bypass.
//   mock:gain  (effect)     — deliberately NO render branch: falls through to
//                             the echo path while MOUNTED, so a mute→gain swap
//                             is an audible silence→signal flip (the
//                             same-session-load spec drives that transition).
// Nothing mounted ⇒ bit-transparent echo, same as the real bridge.
//
// The mock records every MIDI event per session, keyed by hello.clientId —
// the note-number / velocity / gate-pairing assertions read that log.

// ⚠ `ws` is deliberately declared in the ROOT package.json, NOT
// e2e/package.json: e2e/package.json is a TOOLCHAIN PIN inside the
// webgl-attest basis (scripts/webgl-attest-lib.ts TOOLCHAIN_PIN_FILES — it
// pins @playwright/test, the renderer), so adding a dep there moves the
// WebGL content hash and demands a real-GPU re-attest for a Node-side test
// server that cannot touch a pixel. Root devDependencies resolve here fine
// (Node walks up to the root node_modules) and are outside the basis.
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import {
  decodeBlock,
  decodeMidiBlock,
  encodeBlock,
} from '../../packages/web/src/lib/audio/vst/vst-protocol';

const PLUGINS = [
  {
    id: 'mock:sine',
    name: 'mock sine synth',
    manufacturer: 'patchtogether e2e',
    version: '1.0',
    kind: 'instrument',
    format: 'au',
  },
  {
    id: 'mock:mute',
    name: 'mock mute fx',
    manufacturer: 'patchtogether e2e',
    version: '1.0',
    kind: 'effect',
    format: 'au',
  },
  {
    id: 'mock:gain',
    name: 'mock gain fx',
    manufacturer: 'patchtogether e2e',
    version: '1.0',
    kind: 'effect',
    format: 'au',
  },
] as const;

export interface MockMidiEvent {
  sampleTime: number;
  bytes: number[];
}

export interface MockSession {
  clientId: string | null;
  rate: number;
  mountedId: string | null;
  /** Every 0x02 event received, in arrival order. */
  midi: MockMidiEvent[];
  /** Every setState blob received, in arrival order — the load-adopt spec
   *  asserts a loaded patch's stored state actually reaches the plugin. */
  setStates: string[];
  blocksIn: number;
  lastSampleTime: number;
}

interface Voice {
  phase: number;
  inc: number;
}

export interface MockVstBridge {
  url: string;
  port: number;
  sessions: MockSession[];
  sessionFor(clientId: string): MockSession | undefined;
  close(): Promise<void>;
}

/** Start the mock on an ephemeral port. Close it in afterAll. */
export function startMockVstBridge(): Promise<MockVstBridge> {
  return new Promise((resolve, reject) => {
    const sessions: MockSession[] = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('error', reject);
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `ws://127.0.0.1:${port}/ws`,
        port,
        sessions,
        // LATEST session for the id — a reconnect (or a later test's page)
        // makes a new session with the same clientId; assertions want the
        // live one.
        sessionFor: (clientId) =>
          [...sessions].reverse().find((s) => s.clientId === clientId),
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          }),
      });
    });

    wss.on('connection', (ws: WebSocket) => {
      const session: MockSession = {
        clientId: null,
        rate: 48000,
        mountedId: null,
        midi: [],
        setStates: [],
        blocksIn: 0,
        lastSampleTime: -1,
      };
      sessions.push(session);
      /** MIDI events not yet applied to the synth voices. */
      const pending: MockMidiEvent[] = [];
      /** Active note → oscillator state. */
      const voices = new Map<number, Voice>();

      const sendJSON = (obj: unknown) => ws.send(JSON.stringify(obj));

      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          handleControl(String(data));
          return;
        }
        const buf = toArrayBuffer(data);
        const first = new Uint8Array(buf)[0];
        if (first === 0x02) {
          const block = decodeMidiBlock(buf);
          if (!block) return;
          for (const ev of block.events) {
            session.midi.push(ev);
            pending.push(ev);
          }
          return;
        }
        const block = decodeBlock(buf);
        if (!block) return;
        session.blocksIn++;
        session.lastSampleTime = block.sampleTime;
        ws.send(renderReply(block.seq, block.sampleTime, block.frameCount, block.planes));
      });

      function handleControl(text: string): void {
        let msg: { type?: string } & Record<string, unknown>;
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'hello':
            session.clientId = typeof msg.clientId === 'string' ? msg.clientId : null;
            session.rate = typeof msg.rate === 'number' ? msg.rate : 48000;
            sendJSON({
              type: 'helperInfo',
              protocolVersion: 1,
              name: 'mock-vst-bridge',
              version: '0.0-e2e',
              rate: session.rate,
              maxBlockFrames: 4096,
              formats: ['au'],
            });
            sendJSON({ type: 'pluginList', plugins: PLUGINS });
            break;
          case 'mount': {
            const p = PLUGINS.find((x) => x.id === msg.pluginId);
            if (!p) {
              sendJSON({ type: 'mountError', pluginId: msg.pluginId, message: 'no such mock plugin' });
              return;
            }
            session.mountedId = p.id;
            voices.clear();
            sendJSON({
              type: 'mounted',
              plugin: p,
              latencySamples: 0,
              tailSeconds: 0,
              audioInputChannels: p.kind === 'instrument' ? 0 : 2,
              audioOutputChannels: 2,
              acceptsMidi: p.kind === 'instrument',
            });
            break;
          }
          case 'unmount':
            session.mountedId = null;
            voices.clear();
            sendJSON({ type: 'unmounted' });
            break;
          case 'openEditor':
            sendJSON({ type: 'editor', open: true, custom: true });
            break;
          case 'closeEditor':
            sendJSON({ type: 'editor', open: false, custom: true });
            break;
          case 'getState':
            sendJSON({
              type: 'state',
              pluginId: session.mountedId ?? '',
              data: Buffer.from('mock-state').toString('base64'),
            });
            break;
          case 'setState':
            session.setStates.push(typeof msg.data === 'string' ? msg.data : '');
            sendJSON({ type: 'stateSet', ok: true });
            break;
          case 'rescanPlugins':
            sendJSON({ type: 'pluginList', plugins: PLUGINS });
            break;
          case 'ping':
            sendJSON({ type: 'pong', t: msg.t });
            break;
        }
      }

      /** Render one reply block (always stereo 0b11, SAME sampleTime as the
       *  pulling block — the real bridge's alignment guarantee). */
      function renderReply(
        seq: number,
        sampleTime: number,
        frames: number,
        planes: Map<number, Float32Array>,
      ): ArrayBuffer {
        if (session.mountedId === 'mock:sine') {
          // Apply every event scheduled inside (or before) this block at the
          // block head — the "late events clamp to offset 0" simplification;
          // sample-exact placement is the REAL helper's job, not the mock's.
          const blockEnd = sampleTime + frames;
          for (let i = pending.length - 1; i >= 0; i--) {
            const ev = pending[i]!;
            if (ev.sampleTime < blockEnd) {
              const status = (ev.bytes[0] ?? 0) & 0xf0;
              const note = ev.bytes[1] ?? 0;
              if (status === 0x90 && (ev.bytes[2] ?? 0) > 0) {
                const hz = 440 * Math.pow(2, (note - 69) / 12);
                voices.set(note, { phase: 0, inc: (2 * Math.PI * hz) / session.rate });
              } else if (status === 0x80 || status === 0x90) {
                voices.delete(note);
              }
              pending.splice(i, 1);
            }
          }
          const out = new Float32Array(frames);
          for (const v of voices.values()) {
            for (let i = 0; i < frames; i++) {
              out[i]! += 0.3 * Math.sin(v.phase);
              v.phase += v.inc;
            }
          }
          return encodeBlock(seq, sampleTime, [0, 1], frames, (_ch, i) => out[i] ?? 0);
        }
        if (session.mountedId === 'mock:mute') {
          return encodeBlock(seq, sampleTime, [0, 1], frames, () => 0);
        }
        // Nothing mounted: bit-transparent echo (clock blocks echo silence).
        return encodeBlock(seq, sampleTime, [0, 1], frames, (ch, i) => planes.get(ch)?.[i] ?? 0);
      }
    });
  });
}

function toArrayBuffer(data: RawData): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (Array.isArray(data)) {
    const total = data.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of data) {
      out.set(b, off);
      off += b.length;
    }
    return out.buffer;
  }
  // Buffer: copy the exact view (its underlying ArrayBuffer may be pooled).
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
