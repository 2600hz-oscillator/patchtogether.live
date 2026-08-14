// e2e/fixtures/generate-lobby-clip-long.mjs
//
// One-time generator for `lobby-clip-long.webm` — the LONG video-only fixture
// that removes the hidden 4-second deadline from collapse-keeps-playing
// (#1553/#1577).
//
// `lobby-clip.webm` is 4.004 s. collapse-keeps-playing's own bounds (play
// confirm 30 s + pre-collapse progress cap 30 s + dock-gone 20 s +
// post-collapse progress cap 30 s = 110 s of wall time during which the media
// clock may advance) exceed it by ~27×, so the spec had to inject
// `el.loop = true` + a rewind to keep the clip alive — and for VIDEOBOX that
// injection FIGHTS the card's own wall-clock drift correction: the element
// wraps to 0, the drift loop yanks it back to duration−0.05, ~4 Hz, decoding
// ~270 fps against a 30 fps clip for the rest of the spec (#1577's trace). A
// fixture longer than the spec's own worst case needs no loop and no rewind,
// so the module runs in the state a user actually produces.
//
// 120 s ≥ the 110 s derivable worst case; the spec asserts that inequality
// against its OWN constants rather than trusting this comment.
//
// ffmpeg isn't in this toolchain, so the clip is synthesized in headless
// Chromium via MediaRecorder (same recipe as generate-av-clip.mjs): an
// animated <canvas> captureStream muxed to VP8. Video-only, like the fixture
// it succeeds. Bitrate is CAPPED EXPLICITLY (#1577: "size is the thing to
// watch") — 150 kbps × 120 s ≈ 2.3 MB committed.
//
//   flox activate -- node e2e/fixtures/generate-lobby-clip-long.mjs
//
// ⚠ MediaRecorder is REALTIME: this takes ~2 minutes to run. Run once, commit
// the result.

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── WEBM DURATION PATCH ─────────────────────────────────────────────────────
// MediaRecorder streams its output, so the Segment Info it writes has NO
// Duration element — chromium then reports `video.duration === Infinity` at
// loadedmetadata and only resolves it after a seek. That Infinity leaks into
// every consumer: the spec's derived-headroom assertion would pass vacuously,
// and card transport code that clamps to `duration - ε` clamps to nothing.
// This is the standard fix-webm-duration approach: walk the EBML to Segment →
// Info, append a Duration element (value in TimecodeScale units), and re-encode
// Info's size vint. The generator then RE-READS the patched bytes in the same
// page and refuses to write a file whose duration did not come out finite.

const vintLen = (b) => {
  for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1;
  throw new Error('bad vint');
};
const readSize = (buf, pos) => {
  const len = vintLen(buf[pos]);
  let v = buf[pos] & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + buf[pos + i];
  // all-ones payload = "unknown size" (streaming Segment)
  const allOnes = v === 2 ** (7 * len) - 1;
  return { len, value: v, unknown: allOnes };
};
const idAt = (buf, pos) => {
  const len = vintLen(buf[pos]);
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { len, id };
};
const encodeVint = (value, width) => {
  const out = new Uint8Array(width);
  let v = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (width - 1);
  return out;
};

/** Append a Duration element to Segment→Info. Returns a NEW buffer. */
function patchWebmDuration(bytes, durationSec) {
  let pos = 0;
  // EBML header element
  let { len: idl, id } = idAt(bytes, pos);
  if (id !== 0x1a45dfa3) throw new Error('not EBML');
  let sz = readSize(bytes, pos + idl);
  pos += idl + sz.len + sz.value;
  // Segment (unknown size, streamed)
  ({ len: idl, id } = idAt(bytes, pos));
  if (id !== 0x18538067) throw new Error('no Segment');
  sz = readSize(bytes, pos + idl);
  let p = pos + idl + sz.len;
  // walk Segment children to Info (0x1549A966)
  for (;;) {
    const child = idAt(bytes, p);
    const csz = readSize(bytes, p + child.len);
    if (child.id === 0x1549a966) {
      const payloadStart = p + child.len + csz.len;
      const payloadEnd = payloadStart + csz.value;
      // TimecodeScale (0x2AD7B1), default 1_000_000 ns
      let ts = 1_000_000;
      let q = payloadStart;
      while (q < payloadEnd) {
        const e = idAt(bytes, q);
        const es = readSize(bytes, q + e.len);
        if (e.id === 0x2ad7b1) {
          ts = 0;
          for (let i = 0; i < es.value; i++) ts = ts * 256 + bytes[q + e.len + es.len + i];
        }
        if (e.id === 0x4489) throw new Error('Duration already present');
        q += e.len + es.len + es.value;
      }
      const durationUnits = (durationSec * 1e9) / ts; // Duration is in TimecodeScale units
      const dur = new Uint8Array(11);
      dur.set([0x44, 0x89, 0x88]);
      new DataView(dur.buffer).setFloat64(3, durationUnits);
      const newSize = csz.value + dur.length;
      // re-encode Info's size at minimal width that fits (shifting is fine:
      // the streamed Segment's own size is "unknown" and needs no update)
      let width = 1;
      while (newSize >= 2 ** (7 * width) - 1) width++;
      const out = new Uint8Array(bytes.length - csz.len + width + dur.length);
      out.set(bytes.subarray(0, p + child.len), 0);
      out.set(encodeVint(newSize, width), p + child.len);
      out.set(bytes.subarray(payloadStart, payloadEnd), p + child.len + width);
      out.set(dur, p + child.len + width + csz.value);
      out.set(bytes.subarray(payloadEnd), p + child.len + width + csz.value + dur.length);
      return out;
    }
    if (csz.unknown) throw new Error(`unknown-size child 0x${child.id.toString(16)} before Info`);
    p += child.len + csz.len + csz.value;
  }
}

const OUT = fileURLToPath(new URL('./lobby-clip-long.webm', import.meta.url));
const DURATION_MS = 120_000;

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto('about:blank');

console.log(`recording ${DURATION_MS / 1000}s of synthetic video (realtime — hold on)…`);
const base64 = await page.evaluate(async (durationMs) => {
  const W = 320;
  const H = 180;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // A sweeping bar + a frame counter: cheap, compresses well, and every frame
  // differs from the last (so decode-progress checks downstream see motion).
  const vStream = canvas.captureStream(30);
  const rec = new MediaRecorder(vStream, {
    mimeType: 'video/webm;codecs=vp8',
    videoBitsPerSecond: 150_000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  rec.start(1000);

  const t0 = performance.now();
  let frame = 0;
  await new Promise((resolve) => {
    const draw = () => {
      const t = performance.now() - t0;
      if (t >= durationMs) return resolve(undefined);
      ctx.fillStyle = '#101418';
      ctx.fillRect(0, 0, W, H);
      const x = ((t / 20) | 0) % W;
      ctx.fillStyle = '#3fd0c9';
      ctx.fillRect(x, 0, 24, H);
      ctx.fillStyle = '#eef1f5';
      ctx.font = '16px monospace';
      ctx.fillText(String(frame++), 12, 24);
      requestAnimationFrame(draw);
    };
    draw();
  });
  rec.stop();
  await done;

  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}, DURATION_MS);

const raw = Buffer.from(base64, 'base64');

// Resolve the TRUE duration (chromium reports Infinity until a seek forces it).
const trueDuration = await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const v = document.createElement('video');
  v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; });
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e9;
    await new Promise((r) => { v.onseeked = r; setTimeout(r, 10_000); });
  }
  return v.duration;
}, base64);
if (!Number.isFinite(trueDuration) || trueDuration < DURATION_MS / 1000 - 5) {
  throw new Error(`recording came out ${trueDuration}s — expected ~${DURATION_MS / 1000}s`);
}

const patched = patchWebmDuration(new Uint8Array(raw), trueDuration);

// REFUSE to write a fixture whose patched header does not read back finite —
// the whole point of the patch is what consumers SEE at loadedmetadata.
const readBack = await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const v = document.createElement('video');
  v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; });
  return v.duration;
}, Buffer.from(patched).toString('base64'));
if (!Number.isFinite(readBack) || Math.abs(readBack - trueDuration) > 1) {
  throw new Error(`patched header reads back ${readBack} (true ${trueDuration}) — refusing to write`);
}

writeFileSync(OUT, patched);
console.log(`wrote ${OUT} (${patched.length} bytes, duration ${readBack.toFixed(3)}s at loadedmetadata)`);
await browser.close();
