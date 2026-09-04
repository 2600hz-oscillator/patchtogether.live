// Protocol-faithful Node stub of the vst-bridge helper (control plane v1) —
// the harness's Tier-A device layer, spawned through the REAL supervisor via
// injected binary paths (plain node, no Electron). Spec of record:
// patchtogether.nativeapps Sources/VSTBridgeCore/VSTProtocol.swift (session
// model in its header) + vst-protocol.ts. Faithful here:
//
//   - loopback bind + the default Origin allowlist (403 otherwise),
//   - ONE connection = ONE plugin instance (cap 16, over-cap → status 'busy'),
//   - hello → helperInfo + pluginList; mount/unmount; ping → pong,
//   - hello.clientId PARK/ADOPT: on disconnect the instance parks (state
//     intact) for parkMs; a reconnect with the same clientId adopts it and
//     the stub REPLAYS `mounted`,
//   - live-socket eviction: a hello whose clientId is held by a LIVE socket
//     evicts that socket (status 'stopped' — crashed-tab reclaim). No
//     takeover message (that is the es9 single-client policy).
//
// NOT faithful (supervision scope): audio/MIDI rendering — the e2e
// mock-vst-bridge owns audible paths.
//
// Args: --port N (required), --park-ms N (default 90000).
// Orphan guard: exits when stdin closes.

import * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { defaultOriginAllowed } from './origin-policy';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(arg('--port'));
if (!Number.isFinite(PORT)) {
  console.error('vst-stub: --port required');
  process.exit(2);
}
const PARK_MS = Number(arg('--park-ms') ?? 90_000);
const INSTANCE_CAP = 16;

const PLUGINS = [
  {
    id: 'stub:sine',
    name: 'stub sine synth',
    manufacturer: 'patchtogether shell harness',
    version: '1.0',
    kind: 'instrument',
    format: 'au',
  },
] as const;

interface Instance {
  clientId: string | null;
  rate: number;
  mountedId: string | null;
  ws: WebSocket | null;
  parkTimer: NodeJS.Timeout | null;
}

const instances: Instance[] = [];

const server = http.createServer((_req, res) => {
  res.writeHead(404).end();
});
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info: { origin?: string }, cb: (ok: boolean, code?: number, msg?: string) => void) => {
    if (defaultOriginAllowed(info.origin)) cb(true);
    else cb(false, 403, 'Forbidden');
  },
});

function send(ws: WebSocket, obj: unknown): void {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* socket already dead */
  }
}

function mountedMessage(pluginId: string): unknown {
  const p = PLUGINS.find((x) => x.id === pluginId);
  return {
    type: 'mounted',
    plugin: p,
    latencySamples: 0,
    tailSeconds: 0,
    audioInputChannels: 0,
    audioOutputChannels: 2,
    acceptsMidi: true,
  };
}

wss.on('connection', (ws: WebSocket) => {
  let instance: Instance | null = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // rendering is not this stub's job
    let msg: { type?: string; clientId?: unknown; rate?: unknown; pluginId?: unknown; t?: number };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello': {
        const clientId = typeof msg.clientId === 'string' ? msg.clientId : null;
        const rate = typeof msg.rate === 'number' ? msg.rate : 48000;

        // clientId reclaim: adopt a parked instance, or evict a live socket
        // holding the same id (crashed-tab reclaim — status 'stopped').
        let adopted: Instance | null = null;
        if (clientId) {
          const held = instances.find((i) => i.clientId === clientId);
          if (held) {
            if (held.ws && held.ws !== ws) {
              send(held.ws, { type: 'status', state: 'stopped', detail: 'clientId reclaimed by a new session' });
              held.ws.close();
            }
            if (held.parkTimer) clearTimeout(held.parkTimer);
            held.parkTimer = null;
            held.ws = ws;
            held.rate = rate;
            adopted = held;
          }
        }
        if (!adopted) {
          if (instances.filter((i) => i.ws || i.parkTimer).length >= INSTANCE_CAP) {
            send(ws, { type: 'status', state: 'busy', detail: 'instance cap reached' });
            return;
          }
          adopted = { clientId, rate, mountedId: null, ws, parkTimer: null };
          instances.push(adopted);
        }
        instance = adopted;

        send(ws, {
          type: 'helperInfo',
          protocolVersion: 1,
          name: 'vst-stub',
          version: '0.1-shell-harness',
          rate,
          maxBlockFrames: 4096,
          formats: ['au'],
        });
        send(ws, { type: 'pluginList', plugins: PLUGINS });
        // Park adoption replays `mounted` — the reconnect contract.
        if (instance.mountedId) send(ws, mountedMessage(instance.mountedId));
        return;
      }
      case 'mount': {
        if (!instance) return;
        const p = PLUGINS.find((x) => x.id === msg.pluginId);
        if (!p) {
          send(ws, { type: 'mountError', pluginId: msg.pluginId, message: 'no such stub plugin' });
          return;
        }
        instance.mountedId = p.id;
        send(ws, mountedMessage(p.id));
        return;
      }
      case 'unmount':
        if (instance) instance.mountedId = null;
        send(ws, { type: 'unmounted' });
        return;
      case 'ping':
        send(ws, { type: 'pong', t: msg.t ?? 0 });
        return;
    }
  });

  ws.on('close', () => {
    if (!instance || instance.ws !== ws) return;
    instance.ws = null;
    const inst = instance;
    if (inst.clientId) {
      // Park: plugin + state intact for PARK_MS, then the instance dies.
      inst.parkTimer = setTimeout(() => {
        inst.parkTimer = null;
        const idx = instances.indexOf(inst);
        if (idx >= 0 && !inst.ws) instances.splice(idx, 1);
      }, PARK_MS);
    } else {
      // Anonymous session: server-side state dies with the socket.
      const idx = instances.indexOf(inst);
      if (idx >= 0) instances.splice(idx, 1);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`vst-stub listening on 127.0.0.1:${PORT}/ws (park=${PARK_MS}ms)`);
});

process.stdin.on('close', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
