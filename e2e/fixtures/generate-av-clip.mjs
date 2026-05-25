// e2e/fixtures/generate-av-clip.mjs
//
// One-time generator for `av-clip.webm` — a tiny moving-picture + audible-tone
// WebM used by multi-video-playback.spec.ts to prove BOTH that each source's
// decode runs (frame-to-frame change downstream) AND that audio is produced
// when the user patches audio_l / audio_r downstream (peak/rms > floor).
//
// The committed `lobby-clip.webm` is VIDEO-ONLY (VP9, no audio track), so it
// can't exercise the audio path. ffmpeg isn't available in this toolchain, so
// we synthesize the clip in headless Chromium via MediaRecorder: an animated
// <canvas> (captureStream) + an OscillatorNode (MediaStreamDestination),
// muxed into one VP8/Opus WebM. Run once, commit the result:
//
//   flox activate -- node e2e/fixtures/generate-av-clip.mjs
//
// Deterministic enough for tests: ~2s, 320x180, a sweeping bar (movement) +
// a steady 220 Hz tone (audio energy).

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./av-clip.webm', import.meta.url));

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto('about:blank');

const base64 = await page.evaluate(async () => {
  const W = 320, H = 180, DURATION_MS = 2000;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Audible 220 Hz tone -> MediaStreamDestination (the audio track).
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  osc.frequency.value = 220;
  const dst = ac.createMediaStreamDestination();
  const g = ac.createGain();
  g.gain.value = 0.5;
  osc.connect(g).connect(dst);
  osc.start();

  // Animated canvas (a sweeping vertical bar) -> video track.
  const vStream = canvas.captureStream(30);
  const combined = new MediaStream([
    ...vStream.getVideoTracks(),
    ...dst.stream.getAudioTracks(),
  ]);

  const chunks = [];
  const rec = new MediaRecorder(combined, { mimeType: 'video/webm' });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  let raf = 0;
  const start = performance.now();
  const draw = () => {
    const t = (performance.now() - start) / DURATION_MS;
    ctx.fillStyle = '#101830';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `hsl(${(t * 360) % 360}, 80%, 60%)`;
    const x = (t * W * 2) % W;
    ctx.fillRect(x, 0, 40, H);
    raf = requestAnimationFrame(draw);
  };
  draw();

  rec.start();
  await new Promise((r) => setTimeout(r, DURATION_MS));
  cancelAnimationFrame(raf);
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  osc.stop();

  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
});

writeFileSync(OUT, Buffer.from(base64, 'base64'));
console.log(`wrote ${OUT} (${Buffer.from(base64, 'base64').length} bytes)`);
await browser.close();
