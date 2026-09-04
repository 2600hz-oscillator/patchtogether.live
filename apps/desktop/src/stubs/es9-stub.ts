// Protocol-faithful Node stub of the es9-bridge helper (control plane v1) —
// the harness's Tier-A device layer, spawned through the REAL supervisor
// state machine via injected binary paths (plain `node dist/stubs/es9-stub.js`,
// no Electron). Spec of record: patchtogether.es9
// Sources/ES9Core/{BridgeProtocol,BridgeService}.swift. Faithful here:
//
//   - loopback bind + the default Origin allowlist (403 otherwise),
//   - SINGLE-CLIENT slot: hello while an incumbent is live → status 'busy'
//     with the takeover hint; {"type":"takeover"} claims the slot and the
//     incumbent gets status 'stopped' + close,
//   - GRACE TAKEOVER: incumbent idle > staleAfter ⇒ a new hello auto-claims
//     (the 423b6f2 behavior — a dead client cannot wedge the slot),
//   - hello → deviceInfo (synthetic 16×16 ES-9), ping → pong, config acked
//     by silence (as the real bridge), 0x01 audio blocks accepted/counted.
//
// NOT faithful (out of scope for supervision): actual audio streaming,
// resampling, meters cadence. The e2e mock layer owns audible paths.
//
// Args: --port N (required), --stale-after-ms N (default 30000).
// Orphan guard: exits when stdin closes (the supervisor pipes stdio, so a
// dead shell tears the stub down on every platform).

import * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { defaultOriginAllowed } from './origin-policy';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(arg('--port'));
if (!Number.isFinite(PORT)) {
  console.error('es9-stub: --port required');
  process.exit(2);
}
const STALE_AFTER_MS = Number(arg('--stale-after-ms') ?? 30_000);

interface Slot {
  ws: WebSocket;
  lastHeardAt: number;
}

let active: Slot | null = null;

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

function deviceInfo(): unknown {
  const labels = (prefix: string) => Array.from({ length: 16 }, (_, i) => `${prefix} ${i + 1}`);
  return {
    type: 'deviceInfo',
    protocolVersion: 1,
    name: 'es9-stub (synthetic)',
    uid: 'stub-es9',
    rate: 48000,
    inputChannels: 16,
    outputChannels: 16,
    bufferFrames: 512,
    inputLabels: labels('in'),
    outputLabels: labels('out'),
  };
}

/** Claim the slot for `ws`. `reply` mirrors the real bridge: a hello gets
 *  deviceInfo back; a bare takeover just rewires the slot (the client
 *  re-hellos afterwards — BridgeService.handleWaitingText sends nothing). */
function claimSlot(ws: WebSocket, reply: boolean): void {
  const evicted = active && active.ws !== ws ? active.ws : null;
  active = { ws, lastHeardAt: Date.now() };
  if (evicted) {
    send(evicted, { type: 'status', state: 'stopped', detail: 'another client took over' });
    evicted.close();
  }
  if (reply) send(ws, deviceInfo());
}

wss.on('connection', (ws: WebSocket) => {
  let attached = false;

  ws.on('message', (data, isBinary) => {
    if (attached && active?.ws === ws) active.lastHeardAt = Date.now();
    if (isBinary) return; // 0x01 blocks accepted; streaming is not this stub's job
    let msg: { type?: string; t?: number };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello': {
        const incumbent = active;
        const idle = incumbent ? Date.now() - incumbent.lastHeardAt : Infinity;
        if (incumbent && incumbent.ws !== ws && idle <= STALE_AFTER_MS) {
          // Slot held by a live client — busy, with the takeover action.
          send(ws, {
            type: 'status',
            state: 'busy',
            detail: `another client is connected (last heard ${Math.round(idle / 1000)}s ago) — send {"type":"takeover"} to claim it`,
          });
          return;
        }
        // Free slot, or GRACE TAKEOVER of a stale incumbent.
        attached = true;
        claimSlot(ws, true);
        return;
      }
      case 'takeover':
        attached = true;
        claimSlot(ws, false);
        return;
      case 'ping':
        send(ws, { type: 'pong', t: msg.t ?? 0 });
        return;
      // config / setLatency etc.: accepted silently, like the real bridge.
    }
  });

  ws.on('close', () => {
    if (active?.ws === ws) active = null;
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`es9-stub listening on 127.0.0.1:${PORT}/ws (staleAfter=${STALE_AFTER_MS}ms)`);
});

process.stdin.on('close', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
