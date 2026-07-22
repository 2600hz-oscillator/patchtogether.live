// packages/web/src/lib/ui/camera-acquire.test.ts
//
// The bare-constraints retry seam (Blackmagic-WDM class devices): rich
// constraints first; NotReadableError + a specific device → one deviceId-only
// retry at the driver's native format; other errors pass through untouched.

import { describe, it, expect, vi } from 'vitest';
import { acquireCameraStream, type GetUserMediaFn } from './camera-acquire';

const noSleep = () => Promise.resolve();

function domErr(name: string): DOMException {
  return Object.assign(new Error(name), { name }) as unknown as DOMException;
}

const FAKE_STREAM = { id: 'fake' } as unknown as MediaStream;

describe('acquireCameraStream', () => {
  it('returns the rich-constraints stream on first success (no retry)', async () => {
    const gum = vi.fn<GetUserMediaFn>().mockResolvedValue(FAKE_STREAM);
    const r = await acquireCameraStream(gum, 'dev-1', noSleep);
    expect(r.stream).toBe(FAKE_STREAM);
    expect(r.usedBareRetry).toBe(false);
    expect(gum).toHaveBeenCalledTimes(1);
    // Rich attempt carries the webcam-friendly hints.
    const c = gum.mock.calls[0]![0].video as MediaTrackConstraints;
    expect(c.deviceId).toEqual({ exact: 'dev-1' });
    expect(c.width).toEqual({ ideal: 640 });
  });

  it('NotReadableError on a specific device → ONE bare deviceId-only retry', async () => {
    const gum = vi
      .fn<GetUserMediaFn>()
      .mockRejectedValueOnce(domErr('NotReadableError'))
      .mockResolvedValueOnce(FAKE_STREAM);
    const r = await acquireCameraStream(gum, 'blackmagic-wdm', noSleep);
    expect(r.stream).toBe(FAKE_STREAM);
    expect(r.usedBareRetry).toBe(true);
    expect(gum).toHaveBeenCalledTimes(2);
    // The retry must be BARE: deviceId only, no format hints for the WDM
    // driver to choke on.
    const retry = gum.mock.calls[1]![0].video as MediaTrackConstraints;
    expect(retry).toEqual({ deviceId: { exact: 'blackmagic-wdm' } });
  });

  it('NotReadableError twice → reports the final error, flagged as post-retry', async () => {
    const gum = vi.fn<GetUserMediaFn>().mockRejectedValue(domErr('NotReadableError'));
    const r = await acquireCameraStream(gum, 'dev-1', noSleep);
    expect(r.stream).toBeNull();
    expect(r.error?.name).toBe('NotReadableError');
    expect(r.usedBareRetry).toBe(true);
    expect(gum).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry without a specific device (nothing exclusive to blame)', async () => {
    const gum = vi.fn<GetUserMediaFn>().mockRejectedValue(domErr('NotReadableError'));
    const r = await acquireCameraStream(gum, null, noSleep);
    expect(r.stream).toBeNull();
    expect(gum).toHaveBeenCalledTimes(1);
    expect(r.usedBareRetry).toBe(false);
  });

  it('does NOT retry on permission/not-found errors (retry cannot cure them)', async () => {
    for (const name of ['NotAllowedError', 'NotFoundError', 'OverconstrainedError']) {
      const gum = vi.fn<GetUserMediaFn>().mockRejectedValue(domErr(name));
      const r = await acquireCameraStream(gum, 'dev-1', noSleep);
      expect(r.stream).toBeNull();
      expect(r.error?.name).toBe(name);
      expect(gum).toHaveBeenCalledTimes(1);
    }
  });

  // ── facingMode (mobile glitch-cam front/back selection) ──

  it('folds facingMode into the rich constraints when NO device is selected (ideal, not exact)', async () => {
    const gum = vi.fn<GetUserMediaFn>().mockResolvedValue(FAKE_STREAM);
    const r = await acquireCameraStream(gum, null, noSleep, 'environment');
    expect(r.stream).toBe(FAKE_STREAM);
    const c = gum.mock.calls[0]![0].video as MediaTrackConstraints;
    // `ideal` so a single-webcam desktop still succeeds instead of
    // OverconstrainedError-ing on a facing it can't report.
    expect(c.facingMode).toEqual({ ideal: 'environment' });
    expect(c.width).toEqual({ ideal: 640 });
    expect(c.deviceId).toBeUndefined();
  });

  it('an explicit deviceId WINS — facingMode is not added on top of an exact device', async () => {
    const gum = vi.fn<GetUserMediaFn>().mockResolvedValue(FAKE_STREAM);
    await acquireCameraStream(gum, 'capture-card-1', noSleep, 'user');
    const c = gum.mock.calls[0]![0].video as MediaTrackConstraints;
    expect(c.deviceId).toEqual({ exact: 'capture-card-1' });
    expect(c.facingMode).toBeUndefined();
  });

  it('omitting facingMode leaves the legacy constraint shape untouched', async () => {
    const gum = vi.fn<GetUserMediaFn>().mockResolvedValue(FAKE_STREAM);
    await acquireCameraStream(gum, null, noSleep);
    const c = gum.mock.calls[0]![0].video as MediaTrackConstraints;
    expect(c.facingMode).toBeUndefined();
    expect(c).toEqual({ width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } });
  });

  it('the bare NotReadableError retry stays deviceId-only even with a facingMode', async () => {
    const gum = vi
      .fn<GetUserMediaFn>()
      .mockRejectedValueOnce(domErr('NotReadableError'))
      .mockResolvedValueOnce(FAKE_STREAM);
    const r = await acquireCameraStream(gum, 'dev-1', noSleep, 'environment');
    expect(r.usedBareRetry).toBe(true);
    const retry = gum.mock.calls[1]![0].video as MediaTrackConstraints;
    expect(retry).toEqual({ deviceId: { exact: 'dev-1' } });
  });
});
