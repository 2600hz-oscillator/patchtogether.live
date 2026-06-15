// packages/web/src/lib/grid/grid-device.svelte.ts
//
// monome grid WebSerial device singleton — the browser-native, NO-helper grid
// I/O layer (the clip-launcher's hardware side). One `navigator.serial`
// connection per page (a grid is a singleton peripheral), modeled on the
// MIDI-learn singleton: lazy gesture-gated connect, reconnect handling, a
// per-machine binding (localStorage, NOT Y.Doc), and a simulated-device test
// hook so e2e/unit can drive key presses + assert LED bytes with no hardware.
//
// All I/O here is PER-USER LOCAL — the grid is one person's hardware. The
// clip-player module's clip + playing state syncs via Y.Doc elsewhere; this
// file never touches the synced store. (Plan §5.)
//
// The byte protocol lives in ./mext.ts (pure, golden-vector tested). This file
// is the lifecycle + stream plumbing around it. WebSerial stream details are
// hidden behind GridTransport so the device logic is identical for the real
// FTDI port and the in-memory simulated device.

import {
  FTDI_VENDOR_ID,
  GRID_BAUD_RATE,
  GRID_WIDTH,
  GRID_HEIGHT,
  GRID_CELLS,
  clampLevel,
  encodeLedSet,
  encodeLedAll,
  batchFrames,
  padToPacket,
  createGridRxParser,
  gridFamilyFromId,
  MSG_QUERY,
  MSG_REQUEST_ID,
  MSG_REQUEST_SIZE,
  type GridRxEvent,
} from './mext';

// ---------------------------------------------------------------------------
// Transport abstraction — the only seam that differs between real hardware and
// the simulated test device.
// ---------------------------------------------------------------------------

export interface GridTransport {
  /** Write a byte run to the device (host → grid). */
  write(bytes: Uint8Array): Promise<void> | void;
  /** Register the inbound-byte handler (grid → host). Called once. */
  onData(cb: (bytes: Uint8Array) => void): void;
  /** Tear the connection down (release reader/writer, close the port). */
  close(): Promise<void> | void;
}

/** A grid key press/release as the rest of the app sees it. */
export interface GridKeyEvent {
  x: number;
  y: number;
  s: 0 | 1; // 1 = down, 0 = up
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let transport: GridTransport | null = null;
let connectStarted = false;
let family: 'mext' | 'series' = 'mext';
let gridW = GRID_WIDTH;
let gridH = GRID_HEIGHT;
let deviceId = '';

/** Local LED frame (levels 0-15, row-major idx = y*gridW + x). Render state —
 *  never synced. setFrame diffs against this to emit only changed cells. */
const ledFrame = new Uint8Array(GRID_CELLS);

const keyListeners = new Set<(e: GridKeyEvent) => void>();
const rxParser = createGridRxParser();

/** Serialize writes — a WritableStream writer can't have overlapping writes. */
let writeChain: Promise<void> = Promise.resolve();

/** Reactive status counter — bump to notify Svelte UI of connect/disconnect.
 *  (Mirrors midi-learn's version-rune pattern; read via connectedRune().) */
let statusVersion = $state(0);
function bumpStatus() {
  statusVersion++;
}

// ---------------------------------------------------------------------------
// Capability + status
// ---------------------------------------------------------------------------

/** Is the WebSerial API available? Chromium-only; gates the whole feature so
 *  Safari/Firefox/iOS + CI (no hardware) degrade cleanly. */
export function serialAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function isConnected(): boolean {
  return transport !== null;
}

/** Reactive accessor — touch this in a $derived/$effect to re-run on
 *  connect/disconnect. Returns a monotonically increasing version. */
export function connectedRune(): number {
  return statusVersion;
}

export function gridFamily(): 'mext' | 'series' {
  return family;
}

export function gridSize(): { width: number; height: number } {
  return { width: gridW, height: gridH };
}

export function gridDeviceId(): string {
  return deviceId;
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

/**
 * Connect to a real grid over WebSerial. MUST be called from a user gesture
 * (the picker prompt requires it). Returns false (never throws) if WebSerial
 * is unavailable, the user dismisses the picker, or the port fails to open.
 */
export async function connect(): Promise<boolean> {
  if (transport) return true;
  if (!serialAvailable()) return false;
  if (connectStarted) return false;
  connectStarted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serial = (navigator as any).serial;
    const port = await serial.requestPort({
      filters: [{ usbVendorId: FTDI_VENDOR_ID }],
    });
    await port.open({ baudRate: GRID_BAUD_RATE });
    const t = createWebSerialTransport(port);
    await attachTransport(t);
    return true;
  } catch {
    connectStarted = false;
    return false;
  }
}

/** Wire a transport up: install the RX handler, send the handshake, repaint. */
async function attachTransport(t: GridTransport): Promise<void> {
  transport = t;
  rxParser.reset();
  t.onData((bytes) => {
    for (const ev of rxParser.push(bytes)) dispatchRx(ev);
  });
  // Handshake: identify (→ codec family), size, query. Best-effort — we assume
  // a 16×8 mext grid and refine when the responses land.
  await rawWrite(MSG_QUERY);
  await rawWrite(MSG_REQUEST_ID);
  await rawWrite(MSG_REQUEST_SIZE);
  // Blank the grid to a known state, then the bound module repaints.
  ledFrame.fill(0);
  await rawWrite(padToPacket(encodeLedAll(0)));
  bumpStatus();
}

export async function disconnect(): Promise<void> {
  const t = transport;
  transport = null;
  connectStarted = false;
  rxParser.reset();
  if (t) {
    try {
      await t.close();
    } catch {
      /* already gone */
    }
  }
  bumpStatus();
}

// ---------------------------------------------------------------------------
// RX dispatch
// ---------------------------------------------------------------------------

function dispatchRx(ev: GridRxEvent): void {
  switch (ev.type) {
    case 'key':
      for (const cb of keyListeners) cb({ x: ev.x, y: ev.y, s: ev.s });
      break;
    case 'id':
      deviceId = ev.id;
      family = gridFamilyFromId(ev.id);
      bumpStatus();
      break;
    case 'size':
      if (ev.x > 0 && ev.y > 0) {
        gridW = ev.x;
        gridH = ev.y;
        bumpStatus();
      }
      break;
    case 'query':
      break;
  }
}

/** Subscribe to grid key events. Returns an unsubscribe fn. The clip-player
 *  binding uses this to route presses to launch/note actions. */
export function onKey(cb: (e: GridKeyEvent) => void): () => void {
  keyListeners.add(cb);
  return () => keyListeners.delete(cb);
}

// ---------------------------------------------------------------------------
// LED output
// ---------------------------------------------------------------------------

function cellIndex(x: number, y: number): number {
  return y * gridW + x;
}

/** Set one LED (x,y) to a varibright level (0-15). No-op + no write if the
 *  cell is already at that level (diffed against the local frame). */
export function setLed(x: number, y: number, level: number): void {
  if (x < 0 || x >= gridW || y < 0 || y >= gridH) return;
  const lvl = clampLevel(level);
  const idx = cellIndex(x, y);
  if (ledFrame[idx] === lvl) return;
  ledFrame[idx] = lvl;
  void rawWrite(padToPacket(encodeLedSet(x, y, lvl)));
}

/**
 * Push a full LED frame (levels for all cells, row-major). Diffs against the
 * current frame and writes only changed cells, batched into one padded packet
 * run (the rare full-repaint case — connect, mode switch, scene change). A
 * 128-cell repaint is ~512 bytes ≈ 44 ms at 115200 baud.
 */
export function setFrame(next: Uint8Array): void {
  const changed: Uint8Array[] = [];
  const n = Math.min(next.length, ledFrame.length);
  for (let i = 0; i < n; i++) {
    const lvl = clampLevel(next[i]);
    if (ledFrame[i] === lvl) continue;
    ledFrame[i] = lvl;
    const x = i % gridW;
    const y = Math.floor(i / gridW);
    changed.push(encodeLedSet(x, y, lvl));
  }
  if (changed.length === 0) return;
  void rawWrite(padToPacket(batchFrames(changed)));
}

/** Blank every LED. */
export function clearLeds(): void {
  ledFrame.fill(0);
  void rawWrite(padToPacket(encodeLedAll(0)));
}

/** Read the current local LED frame (a copy) — for UI mirrors + tests. */
export function currentLedFrame(): Uint8Array {
  return ledFrame.slice();
}

/** Await all writes queued so far (LED writes are fire-and-forget). For tests
 *  + any caller that needs the grid painted before proceeding. */
export function flushWrites(): Promise<void> {
  return writeChain;
}

/** Serialized write through the active transport. Silently no-ops if not
 *  connected (so callers don't have to guard every paint). */
function rawWrite(bytes: Uint8Array): Promise<void> {
  if (!transport) return Promise.resolve();
  const t = transport;
  writeChain = writeChain.then(async () => {
    try {
      await t.write(bytes);
    } catch {
      // Write failed → the device likely vanished; tear down so a reconnect
      // can re-handshake cleanly.
      await disconnect();
    }
  });
  return writeChain;
}

// ---------------------------------------------------------------------------
// Real WebSerial transport
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
function createWebSerialTransport(port: any): GridTransport {
  let writer: any = null;
  let reader: any = null;
  let dataCb: ((bytes: Uint8Array) => void) | null = null;
  let alive = true;

  async function readLoop() {
    try {
      reader = port.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && dataCb) dataCb(value as Uint8Array);
      }
    } catch {
      /* disconnected mid-read */
    }
  }

  return {
    write(bytes: Uint8Array) {
      if (!alive) return;
      if (!writer) writer = port.writable.getWriter();
      return writer.write(bytes);
    },
    onData(cb) {
      dataCb = cb;
      void readLoop();
    },
    async close() {
      alive = false;
      try {
        await reader?.cancel();
      } catch {
        /* noop */
      }
      try {
        reader?.releaseLock();
      } catch {
        /* noop */
      }
      try {
        await writer?.close();
      } catch {
        /* noop */
      }
      try {
        writer?.releaseLock();
      } catch {
        /* noop */
      }
      try {
        await port.close();
      } catch {
        /* noop */
      }
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Simulated-device test hook
// ---------------------------------------------------------------------------
//
// Installs an in-memory grid so an e2e (or unit test) can drive key presses +
// assert the LED bytes the device emitted, with no hardware and no WebSerial
// permission prompt — exactly like installSimulatedMidiDevice. The handle's
// senders push through the SAME rxParser/dispatch path real hardware uses, and
// its `writes()` captures every byte run the device wrote.

export interface SimulatedGrid {
  /** Simulate a key down at (x,y). */
  press(x: number, y: number): void;
  /** Simulate a key up at (x,y). */
  release(x: number, y: number): void;
  /** Feed raw inbound bytes (e.g. an id/size handshake response). */
  feed(bytes: number[] | Uint8Array): void;
  /** Every byte run the device has written to the grid, in order. */
  writes(): Uint8Array[];
  /** The current LED level the device believes cell (x,y) holds. */
  ledAt(x: number, y: number): number;
}

let simInstalled: SimulatedGrid | null = null;

export async function installSimulatedGrid(): Promise<SimulatedGrid> {
  if (simInstalled) return simInstalled;
  const writes: Uint8Array[] = [];
  let dataCb: ((bytes: Uint8Array) => void) | null = null;
  const t: GridTransport = {
    write(bytes) {
      writes.push(bytes.slice());
    },
    onData(cb) {
      dataCb = cb;
    },
    close() {
      dataCb = null;
    },
  };
  connectStarted = true;
  await attachTransport(t);

  const send = (cmd: 0x20 | 0x21, x: number, y: number) => {
    if (dataCb) dataCb(new Uint8Array([cmd, x, y]));
  };
  simInstalled = {
    press: (x, y) => send(0x21, x, y),
    release: (x, y) => send(0x20, x, y),
    feed: (bytes) => {
      if (dataCb) dataCb(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    },
    writes: () => writes.slice(),
    ledAt: (x, y) => ledFrame[cellIndex(x, y)] ?? 0,
  };
  return simInstalled;
}

/** Reset ALL singleton state — for test isolation between cases. */
export function __test_resetGrid(): void {
  transport = null;
  connectStarted = false;
  simInstalled = null;
  family = 'mext';
  gridW = GRID_WIDTH;
  gridH = GRID_HEIGHT;
  deviceId = '';
  ledFrame.fill(0);
  keyListeners.clear();
  rxParser.reset();
  writeChain = Promise.resolve();
}
