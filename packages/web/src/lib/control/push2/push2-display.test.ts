// packages/web/src/lib/control/push2/push2-display.test.ts
//
// Push 2 DISPLAY transport — lifecycle, pacing and (above all) GRACEFUL
// DEGRADATION, with no hardware anywhere. Two injection levels are exercised:
//
//   · `openPush2Display(fakeDevice)` — the REAL open → selectConfiguration →
//     claimInterface → transferOut path, driven by a fake `USBDevice`, so the
//     call ORDER and every failure step are asserted directly.
//   · `installSimulatedPush2Display()` — an in-memory panel built on that same
//     path, which reassembles the frames it receives so a test can read the
//     picture back out pixel by pixel.
//
// The contract under test: no WebUSB, a dismissed picker, a driver-bound
// interface, or a cable pulled mid-frame are all a `false` return and a status
// string. Nothing here may throw — the Push's pads/encoders keep working over
// Web MIDI when the screen is unavailable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  usbAvailable,
  attachDisplayTransport,
  displayStatus,
  displayStatusRune,
  displayKeepaliveActive,
  isDisplayConnected,
  openPush2Display,
  connectDisplay,
  reconnectDisplay,
  disconnectDisplay,
  sendFrame,
  sendSolidFrame,
  flushDisplayWrites,
  flushPendingFrame,
  keepaliveTick,
  createFakePush2UsbDevice,
  installSimulatedPush2Display,
  __test_setDisplayClock,
  __test_resetPush2Display,
  type UsbDeviceLike,
} from './push2-display.svelte';
import {
  PUSH_DISPLAY_W,
  PUSH_DISPLAY_H,
  PUSH_DISPLAY_RGBA_BYTES,
  PUSH_DISPLAY_FRAME_BYTES,
  PUSH_DISPLAY_CHUNK_BYTES,
  PUSH2_USB_VENDOR_ID,
  PUSH2_USB_PRODUCT_ID,
  readPushFramePixel,
} from './push2-display-frame';

/** A test image: red at (0,0), green at (959,0), blue at (0,159), else black. */
function markerImage(): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(PUSH_DISPLAY_RGBA_BYTES);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * PUSH_DISPLAY_W + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  };
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
  put(0, 0, 255, 0, 0);
  put(PUSH_DISPLAY_W - 1, 0, 0, 255, 0);
  put(0, PUSH_DISPLAY_H - 1, 0, 0, 255);
  return buf;
}

/** A uniformly-coloured RGBA source. */
function solidImage(r: number, g: number, b: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(PUSH_DISPLAY_RGBA_BYTES);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  }
  return buf;
}

/** Yield past the microtask queue so an in-flight write reaches its park point. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Deterministic clock — the frame gate + keepalive are asserted, not slept on. */
let clock = 0;
const advance = (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  __test_resetPush2Display();
  clock = 100_000;
  __test_setDisplayClock(() => clock);
});

afterEach(() => {
  __test_resetPush2Display();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Capability probe + the no-WebUSB path.
// ---------------------------------------------------------------------------

describe('usbAvailable + graceful degradation with NO WebUSB', () => {
  it('is false in the test (node) environment — no navigator.usb', () => {
    expect(usbAvailable()).toBe(false);
  });

  it('connectDisplay resolves FALSE and reports "unsupported" — never throws', async () => {
    await expect(connectDisplay()).resolves.toBe(false);
    expect(displayStatus()).toBe('unsupported');
    expect(isDisplayConnected()).toBe(false);
  });

  it('reconnectDisplay resolves FALSE quietly (no status churn, no prompt)', async () => {
    await expect(reconnectDisplay()).resolves.toBe(false);
    expect(displayStatus()).toBe('idle');
  });

  it('every frame call is a harmless no-op with no display attached', () => {
    expect(sendFrame(markerImage())).toBe(false);
    expect(sendSolidFrame(255, 0, 0)).toBe(false);
    expect(() => flushPendingFrame()).not.toThrow();
    expect(() => keepaliveTick()).not.toThrow();
    expect(isDisplayConnected()).toBe(false);
  });

  it('disconnecting when nothing is connected is a no-op', async () => {
    await expect(disconnectDisplay()).resolves.toBeUndefined();
    expect(displayStatus()).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// The WebUSB open/claim path, against a fake USBDevice.
// ---------------------------------------------------------------------------

describe('openPush2Display — the vendor-specific interface claim', () => {
  it('opens, selects configuration 1, then claims interface 0 — in that order', async () => {
    const dev = createFakePush2UsbDevice();
    const t = await openPush2Display(dev);
    expect(t).not.toBeNull();
    expect(dev.calls).toEqual(['open', 'selectConfiguration(1)', 'claimInterface(0)']);
  });

  it('skips open/select when the device is already open and configured', async () => {
    const dev = createFakePush2UsbDevice({ opened: true, configuration: { configurationValue: 1 } });
    const t = await openPush2Display(dev);
    expect(t).not.toBeNull();
    expect(dev.calls).toEqual(['claimInterface(0)']);
  });

  it('sends on bulk endpoint 1', async () => {
    const dev = createFakePush2UsbDevice();
    const t = await openPush2Display(dev);
    await t!.send(new Uint8Array([1, 2, 3]));
    expect(dev.calls.at(-1)).toBe('transferOut(1)');
    expect([...dev.transfers[0]]).toEqual([1, 2, 3]);
  });

  it('close() releases the interface and closes the device', async () => {
    const dev = createFakePush2UsbDevice();
    const t = await openPush2Display(dev);
    await t!.close();
    expect(dev.calls).toEqual([
      'open',
      'selectConfiguration(1)',
      'claimInterface(0)',
      'releaseInterface(0)',
      'close',
    ]);
  });

  for (const step of ['open', 'selectConfiguration', 'claimInterface'] as const) {
    it(`returns NULL (never throws) when ${step} rejects`, async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const dev = createFakePush2UsbDevice();
      dev.failStep(step);
      await expect(openPush2Display(dev)).resolves.toBeNull();
      // …and it lets go of the device so a retry can start clean.
      expect(dev.calls).toContain('close');
    });
  }

  it('treats a USB STALL as a failed transfer (a resolved non-ok status is NOT success)', async () => {
    const dev = createFakePush2UsbDevice();
    const t = await openPush2Display(dev);
    dev.stallNextTransfer();
    await expect(t!.send(new Uint8Array([0]))).rejects.toThrow(/stall/);
  });

  it('a claimInterface rejection is the Windows/driver-bound case — reported, not fatal', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const dev = createFakePush2UsbDevice();
    dev.failStep('claimInterface');
    expect(await openPush2Display(dev)).toBeNull();
    expect(isDisplayConnected()).toBe(false); // the app carries on
  });
});

// ---------------------------------------------------------------------------
// connectDisplay against a stubbed navigator.usb (picker accept / decline).
// ---------------------------------------------------------------------------

describe('connectDisplay — the picker', () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  const stubUsb = (usb: unknown) => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { usb },
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  });

  it('filters the picker to the Push 2 VID/PID and attaches on accept', async () => {
    const dev = createFakePush2UsbDevice();
    const requestDevice = vi.fn(async () => dev as UsbDeviceLike);
    stubUsb({ requestDevice, getDevices: async () => [] });
    expect(usbAvailable()).toBe(true);

    await expect(connectDisplay()).resolves.toBe(true);
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ vendorId: PUSH2_USB_VENDOR_ID, productId: PUSH2_USB_PRODUCT_ID }],
    });
    expect(isDisplayConnected()).toBe(true);
    expect(displayStatus()).toBe('connected');
  });

  it('a DISMISSED picker is "denied" — false, no throw, and retryable', async () => {
    stubUsb({
      requestDevice: async () => {
        throw new DOMException('No device selected.', 'NotFoundError');
      },
      getDevices: async () => [],
    });
    await expect(connectDisplay()).resolves.toBe(false);
    expect(displayStatus()).toBe('denied');
    expect(isDisplayConnected()).toBe(false);
    // Not latched: the user can press Connect again.
    const dev = createFakePush2UsbDevice();
    stubUsb({ requestDevice: async () => dev, getDevices: async () => [] });
    await expect(connectDisplay()).resolves.toBe(true);
  });

  it('a device that opens but will not be CLAIMED is "failed", not a crash', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const dev = createFakePush2UsbDevice();
    dev.failStep('claimInterface');
    stubUsb({ requestDevice: async () => dev, getDevices: async () => [] });
    await expect(connectDisplay()).resolves.toBe(false);
    expect(displayStatus()).toBe('failed');
  });

  it('reconnectDisplay re-opens a REMEMBERED device with no picker', async () => {
    const dev = createFakePush2UsbDevice();
    const requestDevice = vi.fn();
    stubUsb({ requestDevice, getDevices: async () => [dev] });
    await expect(reconnectDisplay()).resolves.toBe(true);
    expect(requestDevice).not.toHaveBeenCalled();
    expect(isDisplayConnected()).toBe(true);
  });

  it('reconnectDisplay ignores a remembered device that is NOT a Push 2', async () => {
    const other = createFakePush2UsbDevice();
    (other as { vendorId: number }).vendorId = 0x1234;
    stubUsb({ requestDevice: vi.fn(), getDevices: async () => [other] });
    await expect(reconnectDisplay()).resolves.toBe(false);
    expect(isDisplayConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The frame pump, through the simulated panel.
// ---------------------------------------------------------------------------

describe('sendFrame — what actually reaches the panel', () => {
  it('writes a 16-byte header then exactly 20 × 16 KB chunks', async () => {
    const sim = await installSimulatedPush2Display();
    expect(isDisplayConnected()).toBe(true);
    expect(sendFrame(markerImage())).toBe(true);
    await flushDisplayWrites();

    const w = sim.writes();
    expect(w).toHaveLength(21);
    expect([...w[0].slice(0, 4)]).toEqual([0xff, 0xcc, 0xaa, 0x88]);
    expect(w[0].length).toBe(16);
    expect(w.slice(1).every((c) => c.length === PUSH_DISPLAY_CHUNK_BYTES)).toBe(true);
    expect(w.slice(1).reduce((n, c) => n + c.length, 0)).toBe(327680);
    expect(sim.frameCount()).toBe(1);
  });

  it('carries the PICTURE — pixels read back at the right coordinates and colours', async () => {
    const sim = await installSimulatedPush2Display();
    sendFrame(markerImage());
    await flushDisplayWrites();
    expect(sim.pixelAt(0, 0)).toEqual({ r: 255, g: 0, b: 0 });
    expect(sim.pixelAt(PUSH_DISPLAY_W - 1, 0)).toEqual({ r: 0, g: 255, b: 0 });
    expect(sim.pixelAt(0, PUSH_DISPLAY_H - 1)).toEqual({ r: 0, g: 0, b: 255 });
    expect(sim.pixelAt(500, 80)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('sendSolidFrame paints the whole panel one colour', async () => {
    const sim = await installSimulatedPush2Display();
    expect(sendSolidFrame(0, 0, 255)).toBe(true);
    await flushDisplayWrites();
    expect(sim.pixelAt(0, 0)).toEqual({ r: 0, g: 0, b: 255 });
    expect(sim.pixelAt(959, 159)).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('DROPS a mis-sized buffer with a single warning instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sim = await installSimulatedPush2Display();
    expect(sendFrame(new Uint8ClampedArray(1234))).toBe(false);
    expect(sendFrame(new Uint8ClampedArray(1234))).toBe(false);
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1); // warned ONCE, not once per repaint
  });

  it('bumps the status rune on connect so the card re-renders', async () => {
    const before = displayStatusRune();
    await installSimulatedPush2Display();
    expect(displayStatusRune()).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// Pacing: the ~30 Hz gate and the keepalive heartbeat.
// ---------------------------------------------------------------------------

describe('the ~30 Hz frame gate', () => {
  it('coalesces a burst — the second frame is HELD, not sent', async () => {
    const sim = await installSimulatedPush2Display();
    expect(sendFrame(markerImage())).toBe(true);
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(1);

    advance(5); // 5 ms later — inside the 33 ms window
    expect(sendFrame(markerImage())).toBe(false);
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(1); // still one
  });

  it('the held frame LANDS once the window elapses (nothing is lost)', async () => {
    const sim = await installSimulatedPush2Display();
    sendFrame(markerImage());
    await flushDisplayWrites();

    advance(5);
    sendFrame(markerImage()); // held
    advance(40); // now past the 33 ms floor
    flushPendingFrame();
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(2);
  });

  it('sends immediately again once the gate has passed', async () => {
    const sim = await installSimulatedPush2Display();
    sendFrame(markerImage());
    await flushDisplayWrites();
    advance(34);
    expect(sendFrame(markerImage())).toBe(true);
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(2);
  });

  it('keeps the LATEST held frame — a coalesced burst shows the newest picture', async () => {
    const sim = await installSimulatedPush2Display();
    sendFrame(markerImage());
    await flushDisplayWrites();

    advance(2);
    sendSolidFrame(255, 0, 0); // held
    advance(2);
    sendSolidFrame(0, 255, 0); // replaces it
    advance(40);
    flushPendingFrame();
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(2);
    expect(sim.pixelAt(10, 10)).toEqual({ r: 0, g: 255, b: 0 }); // the newest
  });
});

describe('the keepalive heartbeat (the panel blanks after ~2 s of silence)', () => {
  it('does nothing before 500 ms have passed', async () => {
    const sim = await installSimulatedPush2Display();
    sendFrame(markerImage());
    await flushDisplayWrites();
    advance(499);
    keepaliveTick();
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(1);
  });

  it('re-sends the LAST frame after 500 ms of silence, unchanged', async () => {
    const sim = await installSimulatedPush2Display();
    sendFrame(markerImage());
    await flushDisplayWrites();
    advance(500);
    keepaliveTick();
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(2);
    expect(sim.pixelAt(0, 0)).toEqual({ r: 255, g: 0, b: 0 }); // same picture
  });

  it('sends NOTHING when no frame has ever been drawn (an unshaped zero buffer is noise)', async () => {
    const sim = await installSimulatedPush2Display();
    advance(5000);
    keepaliveTick();
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(0);
    // Not one byte — not even the header. (frameCount alone would be satisfied
    // by a half-written frame that then blew up, so assert the writes too.)
    expect(sim.writes()).toHaveLength(0);
    expect(isDisplayConnected()).toBe(true);
  });

  it('prefers a genuinely pending frame over repeating the old one', async () => {
    const sim = await installSimulatedPush2Display();
    sendFrame(markerImage());
    await flushDisplayWrites();
    advance(5);
    sendSolidFrame(0, 0, 255); // held by the gate
    advance(600);
    keepaliveTick();
    await flushDisplayWrites();
    expect(sim.frameCount()).toBe(2);
    expect(sim.pixelAt(0, 0)).toEqual({ r: 0, g: 0, b: 255 }); // the NEW one
  });

  it('is armed for a real device and disarmed on disconnect', async () => {
    await installSimulatedPush2Display({ keepalive: true });
    expect(displayKeepaliveActive()).toBe(true);
    await disconnectDisplay();
    expect(displayKeepaliveActive()).toBe(false);
  });

  it('is OFF in the simulated default so unit pacing stays deterministic', async () => {
    await installSimulatedPush2Display();
    expect(displayKeepaliveActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Double buffering — the tearing hazard a 320 KB transfer creates.
// ---------------------------------------------------------------------------

describe('double buffering', () => {
  it('a repaint arriving MID-TRANSFER does not tear the frame already in flight', async () => {
    // A frame is 21 bulk writes. If the next repaint packed into the SAME buffer
    // the transfer is still walking, the panel would get the top of one picture
    // and the bottom of another — visible, intermittent, and unreproducible.
    const received: Uint8Array[] = [];
    let release!: () => void;
    const parked = new Promise<void>((r) => (release = r));
    let parkedOnce = false;
    attachDisplayTransport(
      {
        async send(bytes: Uint8Array) {
          received.push(bytes.slice()); // a real transferOut copies on arrival too
          if (!parkedOnce && received.length === 3) {
            parkedOnce = true;
            await parked; // hold the cable open mid-frame
          }
        },
        close() {},
      },
      { keepalive: false },
    );

    sendFrame(solidImage(255, 0, 0)); // RED starts going out…
    await tick();
    expect(received).toHaveLength(3); // …and is parked after 2 chunks

    advance(100); // past the frame gate, so this WOULD go out immediately
    expect(sendFrame(solidImage(0, 0, 255))).toBe(false); // BLUE packs, held
    release();
    await flushDisplayWrites();

    // Reassemble the frame that was in flight and read its LAST line — which
    // lives in chunk 19, long after the park point.
    const inFlightFrame = new Uint8Array(PUSH_DISPLAY_FRAME_BYTES);
    let off = 0;
    for (const c of received.slice(1, 21)) {
      inFlightFrame.set(c, off);
      off += c.length;
    }
    expect(off).toBe(PUSH_DISPLAY_FRAME_BYTES);
    expect(readPushFramePixel(inFlightFrame, 0, 0)).toEqual({ r: 255, g: 0, b: 0 });
    expect(readPushFramePixel(inFlightFrame, 0, PUSH_DISPLAY_H - 1)).toEqual({
      r: 255,
      g: 0,
      b: 0, // ← blue here means the buffer was stomped mid-transfer
    });
  });
});

// ---------------------------------------------------------------------------
// The cable comes out.
// ---------------------------------------------------------------------------

describe('a device that goes away mid-frame', () => {
  it('tears down to "failed" and keeps every later call a harmless no-op', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const sim = await installSimulatedPush2Display();
    sim.failNextTransfer();
    sendFrame(markerImage());
    await flushDisplayWrites();

    expect(isDisplayConnected()).toBe(false);
    expect(displayStatus()).toBe('failed');
    expect(sim.frameCount()).toBe(0);
    // The app carries on: pads/encoders are a different transport entirely.
    expect(sendFrame(markerImage())).toBe(false);
    expect(() => keepaliveTick()).not.toThrow();
  });

  it('releases the interface on a deliberate disconnect', async () => {
    const sim = await installSimulatedPush2Display();
    await disconnectDisplay();
    expect(sim.device.calls).toContain('releaseInterface(0)');
    expect(sim.device.calls).toContain('close');
    expect(isDisplayConnected()).toBe(false);
    expect(displayStatus()).toBe('idle');
  });
});
