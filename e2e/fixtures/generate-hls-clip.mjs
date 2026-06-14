// e2e/fixtures/generate-hls-clip.mjs
//
// One-time generator for `hls-clip.mp4` — a tiny AVC + AAC MP4 with an audible
// 440 Hz tone, used by tv-librarian-audio.spec.ts to prove the TV LIBRARIAN
// audio path end-to-end: a tuned HLS stream's audio_l / audio_r reach the
// AUDIO OUT terminal (the operator-reported "video module = no audio" bug).
//
// WHY AN MP4 (not the existing av-clip.webm): TV LIBRARIAN tunes via hls.js,
// which demuxes HLS segments (fMP4 / MPEG-TS), NOT WebM. hls.js 1.6 happily
// plays a plain MediaRecorder-produced AVC+AAC MP4 referenced as both the
// EXT-X-MAP init AND the single media segment of a one-segment fMP4 playlist
// (validated: MANIFEST_PARSED → playing → readyState 4 → MediaElementSource
// carries audible energy when the element is UN-muted). The spec routes a
// mock `.m3u8` (built in-page) + this committed segment via page.route, so CI
// never contacts a live TV CDN and never needs a runtime H.264/AAC encoder.
//
// ffmpeg / WebCodecs aren't available in this toolchain, so we synthesize the
// clip in headless Chromium via MediaRecorder (an animated <canvas> +
// OscillatorNode → MediaStreamDestination), exactly like generate-av-clip.mjs.
// Run once, commit the result:
//
//   flox activate -- node e2e/fixtures/generate-hls-clip.mjs
//
// Deterministic enough for tests: ~1.6s, 128×72, a sweeping bar (movement) +
// a steady 440 Hz tone (audio energy). The container is video/mp4;codecs=
// avc1.42E01E,mp4a.40.2.

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./hls-clip.mp4', import.meta.url));
const MIME = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto('about:blank');

const supported = await page.evaluate(
  (mime) => window.MediaRecorder?.isTypeSupported?.(mime) ?? false,
  MIME,
);
if (!supported) {
  console.error(`MediaRecorder cannot encode ${MIME} on this Chromium — cannot generate the fixture here.`);
  await browser.close();
  process.exit(1);
}

const base64 = await page.evaluate(async (mime) => {
  const W = 128, H = 72, DURATION_MS = 1600;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Audible 440 Hz tone -> MediaStreamDestination (the audio track).
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  osc.frequency.value = 440;
  const dst = ac.createMediaStreamDestination();
  const g = ac.createGain();
  g.gain.value = 0.6;
  osc.connect(g).connect(dst);
  osc.start();

  // Animated canvas (a sweeping vertical bar) -> video track.
  const vStream = canvas.captureStream(15);
  const combined = new MediaStream([
    ...vStream.getVideoTracks(),
    ...dst.stream.getAudioTracks(),
  ]);

  const chunks = [];
  const rec = new MediaRecorder(combined, { mimeType: mime });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  let raf = 0;
  const start = performance.now();
  const draw = () => {
    const t = (performance.now() - start) / DURATION_MS;
    ctx.fillStyle = '#101830';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `hsl(${(t * 360) % 360}, 80%, 60%)`;
    const x = (t * W * 2) % W;
    ctx.fillRect(x, 0, 20, H);
    raf = requestAnimationFrame(draw);
  };
  draw();

  rec.start();
  await new Promise((r) => setTimeout(r, DURATION_MS));
  cancelAnimationFrame(raf);
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  osc.stop();

  const blob = new Blob(chunks, { type: 'video/mp4' });
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}, MIME);

writeFileSync(OUT, Buffer.from(base64, 'base64'));
console.log(`wrote ${OUT} (${Buffer.from(base64, 'base64').length} bytes)`);
await browser.close();
