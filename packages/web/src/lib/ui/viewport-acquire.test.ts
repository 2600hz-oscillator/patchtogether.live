// packages/web/src/lib/ui/viewport-acquire.test.ts
//
// Unit checks for the LOOPBACK screen-capture acquire seam. No real display
// prompt — the getDisplayMedia dependency is injected as a mock.

import { describe, expect, it, vi } from 'vitest';
import {
  acquireViewportStream,
  isViewportCaptureSupported,
  VIEWPORT_CAPTURE_CONSTRAINTS,
} from './viewport-acquire';

describe('LOOPBACK — viewport-acquire seam', () => {
  it('requests current-tab capture constraints (browser surface, self-include)', () => {
    const v = VIEWPORT_CAPTURE_CONSTRAINTS.video as Record<string, unknown>;
    expect(v.displaySurface).toBe('browser');
    expect((VIEWPORT_CAPTURE_CONSTRAINTS as Record<string, unknown>).preferCurrentTab).toBe(true);
    expect((VIEWPORT_CAPTURE_CONSTRAINTS as Record<string, unknown>).selfBrowserSurface).toBe('include');
    // Never pulls audio (the module is a pure video source).
    expect(VIEWPORT_CAPTURE_CONSTRAINTS.audio).toBe(false);
  });

  it('returns the stream on success', async () => {
    const fakeStream = { id: 'fake' } as unknown as MediaStream;
    const gdm = vi.fn().mockResolvedValue(fakeStream);
    const res = await acquireViewportStream(gdm);
    expect(gdm).toHaveBeenCalledWith(VIEWPORT_CAPTURE_CONSTRAINTS);
    expect(res.stream).toBe(fakeStream);
    expect(res.error).toBeNull();
  });

  it('captures the error (never throws) when the picker is cancelled', async () => {
    const denied = new DOMException('user cancelled', 'NotAllowedError');
    const gdm = vi.fn().mockRejectedValue(denied);
    const res = await acquireViewportStream(gdm);
    expect(res.stream).toBeNull();
    expect(res.error).toBe(denied);
    expect(res.error?.name).toBe('NotAllowedError');
  });

  it('isViewportCaptureSupported is false without a mediaDevices.getDisplayMedia', () => {
    // In the vitest node env there is no navigator.mediaDevices, so the probe
    // is false — the exact "degrade gracefully" branch the card renders.
    expect(isViewportCaptureSupported()).toBe(false);
  });
});
