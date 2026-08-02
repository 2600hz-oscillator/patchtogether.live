// packages/web/src/lib/control/push2/push2-display.svelte.ts
//
// Ableton Push 2 — the 960×160 DISPLAY transport (WebUSB). Phase 2 of the Push
// integration, and the sibling of `push2-device.svelte.ts` (which owns the MIDI
// half over Web MIDI). This file is lifecycle + plumbing ONLY: every byte
// decision lives in the pure `./push2-display-frame.ts` codec.
//
// WHY THE TWO HALVES COEXIST: the Push is a composite USB device. The display is
// a VENDOR-SPECIFIC (class 0xFF) interface, which is NOT on Chrome's WebUSB
// blocklist, while the MIDI interface is Audio-class and therefore unclaimable by
// WebUSB and owned by Web MIDI. So `navigator.usb` drives the screen and
// `navigator.requestMIDIAccess` drives the pads, on one page, with no conflict.
//
// GRACEFUL DEGRADATION IS THE CONTRACT. No WebUSB (Safari/Firefox/iOS/CI), a
// dismissed picker, a driver-bound interface (Windows without WinUSB), an
// unplugged cable mid-frame — ALL of them are a `false` return and a status
// string, never a throw and never a broken app. The pads/encoders keep working
// over Web MIDI; a missing display is not an error.
//
// THE INJECTABLE SEAM (no hardware anywhere in the test suite):
//   · `Push2DisplayTransport` — send/close, the only thing the frame pump talks
//     to.
//   · `openPush2Display(device)` — takes a `UsbDeviceLike`, so the REAL
//     open → selectConfiguration → claimInterface → transferOut path is unit-
//     tested against a fake device object, including every failure step.
//   · `installSimulatedPush2Display()` — an in-memory Push display that
//     reassembles the frames it receives and can read pixels back out, driven
//     through that same real path.
//
// TIMERS: the ~30 Hz frame gate and the 500 ms keepalive are the only clocks. In
// unit tests the wall clock is injectable (`__test_setDisplayClock`) and the
// keepalive interval is off, so pacing is asserted deterministically rather than
// by sleeping.

import {
  PUSH2_USB_VENDOR_ID,
  PUSH2_USB_PRODUCT_ID,
  PUSH2_USB_INTERFACE,
  PUSH2_USB_ENDPOINT,
  PUSH2_USB_CONFIGURATION,
  PUSH_DISPLAY_FRAME_BYTES,
  PUSH_DISPLAY_KEEPALIVE_MS,
  PUSH_DISPLAY_MIN_FRAME_MS,
  frameGateDelayMs,
  keepaliveDue,
  packPushFrameInto,
  pushDisplayHeader,
  pushFrameChunks,
  readPushFramePixel,
  solidPushFrame,
} from './push2-display-frame';

// ---------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------

/** The ONE thing the frame pump talks to. A real WebUSB device and the in-memory
 *  simulated display both satisfy it. */
export interface Push2DisplayTransport {
  /** Write one byte run to the bulk OUT endpoint. Rejects/throws on failure. */
  send(bytes: Uint8Array): Promise<void> | void;
  /** Release the interface + close the device. Must not throw. */
  close(): Promise<void> | void;
}

/** The slice of `USBDevice` we use. Declared locally rather than pulling in
 *  `@types/w3c-web-usb` — a 6-method structural type is cheaper than a
 *  dependency, and it doubles as the fake's contract. */
export interface UsbDeviceLike {
  readonly opened?: boolean;
  readonly configuration?: unknown | null;
  readonly vendorId?: number;
  readonly productId?: number;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  /** The real signature takes a `BufferSource`; we only ever hand it a
   *  `Uint8Array`, and narrowing here keeps the frame path free of the
   *  ArrayBuffer/SharedArrayBuffer variance dance svelte-check enforces. */
  transferOut(endpointNumber: number, data: Uint8Array): Promise<{ status?: string } | void>;
}

/** The slice of `navigator.usb` we use. */
export interface UsbLike {
  requestDevice(options: { filters: { vendorId?: number; productId?: number }[] }): Promise<UsbDeviceLike>;
  getDevices(): Promise<UsbDeviceLike[]>;
}

/** Where the display connection stands — drives the card's status line.
 *  `unsupported` = no WebUSB at all; `denied` = the user dismissed the picker;
 *  `failed` = the device was there but open/claim/transfer failed (the classic
 *  Windows "interface bound to another driver" case). */
export type Push2DisplayStatus =
  | 'unsupported'
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'denied'
  | 'failed';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let transport: Push2DisplayTransport | null = null;
let status: Push2DisplayStatus = 'idle';

/** Double frame buffers: one may be in flight over USB while the next repaint
 *  packs into the other. Allocated lazily — 2 × 320 KB is not a cost the 99 % of
 *  users without a Push should pay at import time. */
let bufs: [Uint8Array, Uint8Array] | null = null;
/** Index of the buffer the NEXT pack writes into (never the in-flight one). */
let packIdx = 0;
/** Index of the buffer holding the last frame actually sent (keepalive source). */
let sentIdx = -1;
/** Has anything ever been packed? Guards keepalive from shipping a zero buffer
 *  (which is NOT black — an unshaped zero frame is noise on the panel). */
let hasFrame = false;
/** A frame is packed and waiting for the ~30 Hz gate (or the in-flight write). */
let pendingFrame = false;
let inFlight = false;
let lastSentAt = -Infinity;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let writeChain: Promise<void> = Promise.resolve();
let connectStarted = false;
let warnedSize = false;

/** Reactive status counter — bump to notify Svelte UI of connect/disconnect.
 *  Mirrors push2-device's statusRune(). */
let statusVersion = $state(0);
export function displayStatusRune(): number {
  return statusVersion;
}
function bumpStatus(next?: Push2DisplayStatus): void {
  if (next) status = next;
  statusVersion++;
}

/** Injectable clock so the frame gate + keepalive are asserted deterministically
 *  instead of by sleeping. Defaults to Date.now. */
let clockFn: (() => number) | null = null;
function now(): number {
  return clockFn ? clockFn() : Date.now();
}

// ---------------------------------------------------------------------------
// Capability + status
// ---------------------------------------------------------------------------

/** Is WebUSB available? Chromium + secure context only. Gates the whole display
 *  feature so Safari/Firefox/iOS and CI (no hardware) degrade cleanly — the
 *  exact discipline of `webMidiAvailable()` / `serialAvailable()`. */
export function usbAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

function usbApi(): UsbLike | null {
  if (!usbAvailable()) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const u = (navigator as any).usb;
  return u && typeof u.requestDevice === 'function' ? (u as UsbLike) : null;
}

/** Is a display transport attached (real or simulated)? */
export function isDisplayConnected(): boolean {
  return transport !== null;
}

/** Current connection status — for the card's status line. */
export function displayStatus(): Push2DisplayStatus {
  return status;
}

/** Is the keepalive heartbeat armed? (The panel blanks after ~2 s of silence.) */
export function displayKeepaliveActive(): boolean {
  return keepaliveTimer !== null;
}

// ---------------------------------------------------------------------------
// Opening a real device — the WebUSB path, exercised by fakes in unit tests.
// ---------------------------------------------------------------------------

/**
 * Open + claim the Push 2's vendor-specific display interface and return a
 * transport over its bulk OUT endpoint. Returns null (never throws) if ANY step
 * fails — the device is busy, another driver holds interface 0 (Windows without
 * WinUSB), or the cable went away between the picker and the claim.
 *
 * PURE of `navigator`: the device object is injected, so this whole path — call
 * ORDER included — is unit-tested with no hardware.
 */
export async function openPush2Display(dev: UsbDeviceLike): Promise<Push2DisplayTransport | null> {
  try {
    if (!dev.opened) await dev.open();
    // Chrome sometimes has the device already configured; re-selecting a live
    // configuration can throw, so only select when there isn't one.
    if (!dev.configuration) await dev.selectConfiguration(PUSH2_USB_CONFIGURATION);
    await dev.claimInterface(PUSH2_USB_INTERFACE);
  } catch (err) {
    logInfo('[push2] display open/claim failed', err);
    try {
      await dev.close();
    } catch {
      /* already gone */
    }
    return null;
  }
  return {
    async send(bytes: Uint8Array) {
      const res = await dev.transferOut(PUSH2_USB_ENDPOINT, bytes);
      // WebUSB resolves with { status: 'ok' | 'stall' | 'babble' } — a stall is
      // a FAILED transfer that does not reject, so it must be checked.
      if (res && typeof res === 'object' && 'status' in res && res.status && res.status !== 'ok') {
        throw new Error(`push2 display: bulk transfer ${res.status}`);
      }
    },
    async close() {
      try {
        await dev.releaseInterface(PUSH2_USB_INTERFACE);
      } catch {
        /* already released / device gone */
      }
      try {
        await dev.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Connect to the Push 2 display via the WebUSB picker. MUST be called from a
 * USER GESTURE (Chrome requires one for `requestDevice`). Returns false — never
 * throws — when WebUSB is missing, the user dismisses the picker, or the claim
 * fails. After the one-time grant, `reconnectDisplay()` works with no gesture on
 * return visits.
 */
export async function connectDisplay(): Promise<boolean> {
  if (transport) return true;
  const usb = usbApi();
  if (!usb) {
    bumpStatus('unsupported');
    return false;
  }
  if (connectStarted) return false;
  connectStarted = true;
  bumpStatus('connecting');
  let dev: UsbDeviceLike | null = null;
  try {
    dev = await usb.requestDevice({
      filters: [{ vendorId: PUSH2_USB_VENDOR_ID, productId: PUSH2_USB_PRODUCT_ID }],
    });
  } catch {
    // The user dismissed the picker, or there was no matching device to pick.
    connectStarted = false;
    bumpStatus('denied');
    return false;
  }
  if (!dev) {
    connectStarted = false;
    bumpStatus('denied');
    return false;
  }
  const t = await openPush2Display(dev);
  connectStarted = false;
  if (!t) {
    bumpStatus('failed');
    return false;
  }
  attachDisplayTransport(t);
  return true;
}

/**
 * Silent reconnect on a return visit: WebUSB remembers the grant, so
 * `getDevices()` finds the Push with NO picker and NO gesture. Returns false
 * quietly when there is no remembered device — that is the normal first-visit
 * case, not a failure, so the status is left alone.
 */
export async function reconnectDisplay(): Promise<boolean> {
  if (transport) return true;
  const usb = usbApi();
  if (!usb || typeof usb.getDevices !== 'function') return false;
  let devs: UsbDeviceLike[] = [];
  try {
    devs = (await usb.getDevices()) ?? [];
  } catch {
    return false;
  }
  const dev = devs.find(
    (d) => d.vendorId === PUSH2_USB_VENDOR_ID && d.productId === PUSH2_USB_PRODUCT_ID,
  );
  if (!dev) return false;
  const t = await openPush2Display(dev);
  if (!t) {
    bumpStatus('failed');
    return false;
  }
  attachDisplayTransport(t);
  return true;
}

/** Wire a transport up + arm the keepalive. The seam the simulated display and
 *  any future transport (a worker-side one, say) attach through. */
export function attachDisplayTransport(
  t: Push2DisplayTransport,
  opts: { keepalive?: boolean } = {},
): void {
  const prev = transport;
  if (prev && prev !== t) {
    // Re-attaching over a live transport must not leak the old claim.
    void Promise.resolve(prev.close()).catch(() => {});
  }
  transport = t;
  hasFrame = false;
  pendingFrame = false;
  inFlight = false;
  sentIdx = -1;
  packIdx = 0;
  lastSentAt = -Infinity;
  writeChain = Promise.resolve();
  if (opts.keepalive !== false) armKeepalive();
  bumpStatus('connected');
}

/** Release the display: stop the heartbeat, release the interface, close the
 *  device. The panel is NOT explicitly blanked — the device self-blanks after
 *  ~2 s without a frame, and writing to a cable that may already be gone is a
 *  worse trade than a two-second afterimage. */
export async function disconnectDisplay(reason: Push2DisplayStatus = 'idle'): Promise<void> {
  const t = transport;
  transport = null;
  clearFlush();
  clearKeepalive();
  pendingFrame = false;
  hasFrame = false;
  inFlight = false;
  connectStarted = false;
  if (t) {
    try {
      await t.close();
    } catch {
      /* already gone */
    }
  }
  bumpStatus(reason);
}

// ---------------------------------------------------------------------------
// The frame pump
// ---------------------------------------------------------------------------

function ensureBuffers(): [Uint8Array, Uint8Array] {
  if (!bufs) {
    bufs = [new Uint8Array(PUSH_DISPLAY_FRAME_BYTES), new Uint8Array(PUSH_DISPLAY_FRAME_BYTES)];
  }
  return bufs;
}

/**
 * Pack + queue a 960×160 RGBA buffer (canvas `ImageData.data`) for the display.
 * Returns true if it went out immediately, false if it was coalesced behind the
 * ~30 Hz gate (it still lands — a timer flushes it), or if there is no display.
 * NEVER throws: a wrong-sized buffer warns once and is dropped.
 */
export function sendFrame(rgba: ArrayLike<number>): boolean {
  if (!transport) return false;
  const b = ensureBuffers();
  try {
    packPushFrameInto(rgba, b[packIdx]);
  } catch (err) {
    if (!warnedSize) {
      warnedSize = true;
      logWarn('[push2] display frame dropped', err);
    }
    return false;
  }
  hasFrame = true;
  return pump();
}

/** Paint the panel a solid colour (default black) — the blank/idle payload. */
export function sendSolidFrame(r = 0, g = 0, b = 0): boolean {
  if (!transport) return false;
  const buf = ensureBuffers();
  solidPushFrame(r, g, b, buf[packIdx]);
  hasFrame = true;
  return pump();
}

/** Send the packed frame if the gate allows, else hold it and arm a flush. */
function pump(): boolean {
  if (!transport || !hasFrame) return false;
  if (inFlight) {
    // At most ONE frame in flight: the other buffer stays free to pack into.
    pendingFrame = true;
    return false;
  }
  const wait = frameGateDelayMs(now(), lastSentAt, PUSH_DISPLAY_MIN_FRAME_MS);
  if (wait > 0) {
    pendingFrame = true;
    armFlush(wait);
    return false;
  }
  pendingFrame = false;
  clearFlush();
  lastSentAt = now();
  const idx = packIdx;
  sentIdx = idx;
  packIdx = 1 - idx; // the next repaint packs elsewhere — no torn frame
  queueWrite(ensureBuffers()[idx]);
  return true;
}

/** Re-send the last frame (keepalive) without re-packing. */
function repeatLastFrame(): void {
  if (!transport || sentIdx < 0 || inFlight) return;
  lastSentAt = now();
  queueWrite(ensureBuffers()[sentIdx]);
}

function queueWrite(frame: Uint8Array): void {
  inFlight = true;
  writeChain = writeChain.then(() => writeFrame(frame));
}

/** Header + 20 × 16 KB bulk chunks. A failed transfer means the device went
 *  away → tear down so pads/encoders carry on and a reconnect can re-claim. */
async function writeFrame(frame: Uint8Array): Promise<void> {
  const t = transport;
  if (!t) {
    inFlight = false;
    return;
  }
  try {
    await t.send(pushDisplayHeader());
    for (const chunk of pushFrameChunks(frame)) await t.send(chunk);
  } catch (err) {
    inFlight = false;
    logInfo('[push2] display transfer failed — releasing', err);
    await disconnectDisplay('failed');
    return;
  }
  inFlight = false;
  // A repaint that arrived mid-transfer is waiting in the other buffer.
  if (pendingFrame) armFlush(frameGateDelayMs(now(), lastSentAt, PUSH_DISPLAY_MIN_FRAME_MS));
}

/** Await every queued transfer (tests + any caller needing the panel painted). */
export function flushDisplayWrites(): Promise<void> {
  return writeChain;
}

/** Send a frame held back by the ~30 Hz gate. Idempotent; safe when nothing is
 *  pending. Exposed for the frame-gate tests + the flush timer. */
export function flushPendingFrame(): void {
  if (!pendingFrame) return;
  pump();
}

/** One keepalive beat: prefer a genuinely pending frame, else repeat the last
 *  one so the panel doesn't blank after ~2 s of silence. */
export function keepaliveTick(): void {
  if (!transport) return;
  if (pendingFrame) {
    pump();
    return;
  }
  if (keepaliveDue(now(), lastSentAt, PUSH_DISPLAY_KEEPALIVE_MS)) repeatLastFrame();
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

function armFlush(delayMs: number): void {
  clearFlush();
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPendingFrame();
  }, Math.max(0, delayMs));
  unref(flushTimer);
}

function clearFlush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function armKeepalive(): void {
  clearKeepalive();
  keepaliveTimer = setInterval(keepaliveTick, PUSH_DISPLAY_KEEPALIVE_MS);
  unref(keepaliveTimer);
}

function clearKeepalive(): void {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

/** Node's timers keep the process alive; the browser's have no unref. Never let
 *  a display heartbeat hold a vitest worker open. */
function unref(t: unknown): void {
  const maybe = t as { unref?: () => void } | null;
  if (maybe && typeof maybe.unref === 'function') maybe.unref();
}

function logInfo(msg: string, err?: unknown): void {
  try {
    if (err === undefined) console.info(msg);
    else console.info(msg, err);
  } catch {
    /* non-fatal diagnostic */
  }
}
function logWarn(msg: string, err?: unknown): void {
  try {
    if (err === undefined) console.warn(msg);
    else console.warn(msg, err);
  } catch {
    /* non-fatal diagnostic */
  }
}

// ---------------------------------------------------------------------------
// Simulated display — an in-memory Push panel, driven through the REAL
// open/claim/transfer path so the tests exercise the shipping code.
// ---------------------------------------------------------------------------

export interface SimulatedPush2Display {
  /** Every byte run written to the bulk endpoint, in order (headers included). */
  writes(): Uint8Array[];
  /** How many COMPLETE frames the panel received. */
  frameCount(): number;
  /** The most recent complete frame (packed bytes), or null. */
  lastFrame(): Uint8Array | null;
  /** Read a pixel back out of the most recent complete frame (un-XOR + unpack). */
  pixelAt(x: number, y: number): { r: number; g: number; b: number };
  /** Make the next transferOut reject — an unplug mid-frame. */
  failNextTransfer(): void;
  /** The fake USB device, for asserting lifecycle calls. */
  device: FakePush2UsbDevice;
}

/** The fake `USBDevice` the simulated display is built on — also exported so a
 *  test can drive `openPush2Display` directly and assert the call order. */
export interface FakePush2UsbDevice extends UsbDeviceLike {
  /** open/selectConfiguration/claimInterface/transferOut/releaseInterface/close. */
  calls: string[];
  /** Every byte run handed to transferOut. */
  transfers: Uint8Array[];
  /** Force a specific step to reject once. */
  failStep(step: 'open' | 'selectConfiguration' | 'claimInterface' | 'transferOut'): void;
  /** Report a non-'ok' status from the next transferOut (a USB stall). */
  stallNextTransfer(): void;
}

/** Build a fake Push 2 USB device. No hardware, no navigator. */
export function createFakePush2UsbDevice(
  init: { opened?: boolean; configuration?: unknown } = {},
): FakePush2UsbDevice {
  const failing = new Set<string>();
  let stall = false;
  const dev: FakePush2UsbDevice = {
    vendorId: PUSH2_USB_VENDOR_ID,
    productId: PUSH2_USB_PRODUCT_ID,
    opened: init.opened ?? false,
    configuration: init.configuration ?? null,
    calls: [],
    transfers: [],
    failStep(step) {
      failing.add(step);
    },
    stallNextTransfer() {
      stall = true;
    },
    async open() {
      dev.calls.push('open');
      if (failing.delete('open')) throw new Error('open failed');
      (dev as { opened: boolean }).opened = true;
    },
    async close() {
      dev.calls.push('close');
      (dev as { opened: boolean }).opened = false;
    },
    async selectConfiguration(v: number) {
      dev.calls.push(`selectConfiguration(${v})`);
      if (failing.delete('selectConfiguration')) throw new Error('selectConfiguration failed');
      (dev as { configuration: unknown }).configuration = { configurationValue: v };
    },
    async claimInterface(n: number) {
      dev.calls.push(`claimInterface(${n})`);
      if (failing.delete('claimInterface')) throw new Error('claimInterface failed');
    },
    async releaseInterface(n: number) {
      dev.calls.push(`releaseInterface(${n})`);
    },
    async transferOut(endpoint: number, data: Uint8Array) {
      dev.calls.push(`transferOut(${endpoint})`);
      if (failing.delete('transferOut')) throw new Error('transferOut failed');
      dev.transfers.push(data.slice()); // COPY — the transport reuses its buffers
      if (stall) {
        stall = false;
        return { status: 'stall' };
      }
      return { status: 'ok' };
    },
  };
  return dev;
}

let simInstalled: SimulatedPush2Display | null = null;

/**
 * Install an in-memory Push 2 display: a fake USB device opened through the real
 * `openPush2Display`, attached as the live transport, with frame reassembly so a
 * test can assert what actually reached the panel. The keepalive interval is
 * OFF (call `keepaliveTick()` yourself) so pacing stays deterministic.
 */
export async function installSimulatedPush2Display(
  opts: { keepalive?: boolean } = {},
): Promise<SimulatedPush2Display> {
  if (simInstalled) return simInstalled;
  const dev = createFakePush2UsbDevice();
  const t = await openPush2Display(dev);
  if (!t) throw new Error('installSimulatedPush2Display: fake device failed to open');

  const writes: Uint8Array[] = [];
  const frames: Uint8Array[] = [];
  let acc: Uint8Array | null = null;
  let accLen = 0;
  let failNext = false;
  const header = pushDisplayHeader();

  const isHeader = (b: Uint8Array): boolean =>
    b.length === header.length && header.every((v, i) => b[i] === v);

  const wrapped: Push2DisplayTransport = {
    async send(bytes: Uint8Array) {
      if (failNext) {
        failNext = false;
        throw new Error('simulated push2 display: device went away');
      }
      await t.send(bytes);
      writes.push(bytes.slice());
      if (isHeader(bytes)) {
        acc = new Uint8Array(PUSH_DISPLAY_FRAME_BYTES);
        accLen = 0;
        return;
      }
      if (!acc) return; // payload with no header — ignore (never happens in-band)
      const room = Math.min(bytes.length, PUSH_DISPLAY_FRAME_BYTES - accLen);
      acc.set(bytes.subarray(0, room), accLen);
      accLen += room;
      if (accLen === PUSH_DISPLAY_FRAME_BYTES) {
        frames.push(acc);
        acc = null;
        accLen = 0;
      }
    },
    close: () => t.close(),
  };

  attachDisplayTransport(wrapped, { keepalive: opts.keepalive === true });

  simInstalled = {
    writes: () => writes.slice(),
    frameCount: () => frames.length,
    lastFrame: () => frames[frames.length - 1] ?? null,
    pixelAt: (x, y) => {
      const f = frames[frames.length - 1];
      return f ? readPushFramePixel(f, x, y) : { r: 0, g: 0, b: 0 };
    },
    failNextTransfer: () => {
      failNext = true;
    },
    device: dev,
  };
  return simInstalled;
}

/** Override the wall clock (frame gate + keepalive). null restores Date.now. */
export function __test_setDisplayClock(fn: (() => number) | null): void {
  clockFn = fn;
}

/** Reset ALL singleton state — test isolation between cases. */
export function __test_resetPush2Display(): void {
  clearFlush();
  clearKeepalive();
  transport = null;
  status = 'idle';
  bufs = null;
  packIdx = 0;
  sentIdx = -1;
  hasFrame = false;
  pendingFrame = false;
  inFlight = false;
  lastSentAt = -Infinity;
  writeChain = Promise.resolve();
  connectStarted = false;
  warnedSize = false;
  simInstalled = null;
  clockFn = null;
}
