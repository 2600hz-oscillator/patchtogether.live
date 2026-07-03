// e2e/fixtures/generate-gif.mjs
//
// One-time generator for `animated-test.gif` — a TINY (~few hundred bytes),
// 4-frame animated GIF used by picturebox-gif.spec.ts to prove PICTUREBOX
// preserves + PLAYS animated gifs (the output pixels change over time).
//
// The frames alternate solid WHITE / solid BLACK so a renderer-tolerant mean-luma
// probe on the downstream VIDEO-OUT canvas swings hard between frames (SwiftShader
// safe — no sub-pixel precision needed). We hand-roll a minimal GIF89a with an
// "uncompressed" LZW stream (a CLEAR code before the dictionary ever grows, so the
// code width stays fixed — simple + always decodable) and then VALIDATE the bytes
// with the SAME WebCodecs ImageDecoder the app uses, in headless Chromium, so the
// committed fixture is guaranteed to decode to 4 visually-distinct frames.
//
// Run once, commit the result:
//   flox activate -- node e2e/fixtures/generate-gif.mjs

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const OUT = fileURLToPath(new URL('./animated-test.gif', import.meta.url));

const W = 16;
const H = 16;
const DELAY_CS = 8; // centiseconds per frame (80ms)
// Palette index per frame: 1 = white, 0 = black. 4 frames, strongly alternating.
const FRAME_COLORS = [1, 0, 1, 0];

// --- minimal GIF89a writer ---------------------------------------------------
const bytes = [];
const u8 = (b) => bytes.push(b & 0xff);
const u16 = (n) => { u8(n & 0xff); u8((n >> 8) & 0xff); };
const str = (s) => { for (const c of s) u8(c.charCodeAt(0)); };

/** "Uncompressed" GIF LZW: emit a CLEAR before the code table would ever need a
 *  wider code, so codeSize stays at minCodeSize+1 and the stream is trivially
 *  correct. LSB-first bit packing (the GIF convention). */
function lzwUncompressed(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const codeSize = minCodeSize + 1;
  const out = [];
  let bitBuf = 0;
  let bitCnt = 0;
  const emit = (code) => {
    bitBuf |= code << bitCnt;
    bitCnt += codeSize;
    while (bitCnt >= 8) { out.push(bitBuf & 0xff); bitBuf >>= 8; bitCnt -= 8; }
  };
  emit(clearCode);
  let entries = clearCode + 2; // codes 0..clearCode-1 + clear + eoi
  for (const p of indices) {
    emit(p);
    entries++;
    // Before the table reaches 2^codeSize (which would force a wider code),
    // reset with a CLEAR so the width never grows.
    if (entries >= (1 << codeSize) - 1) {
      emit(clearCode);
      entries = clearCode + 2;
    }
  }
  emit(eoiCode);
  if (bitCnt > 0) out.push(bitBuf & 0xff);
  return out;
}

/** Write an LZW byte array as GIF image-data sub-blocks (≤255 each, 0-terminated). */
function writeSubBlocks(data) {
  let i = 0;
  while (i < data.length) {
    const chunk = data.slice(i, i + 255);
    u8(chunk.length);
    for (const b of chunk) u8(b);
    i += 255;
  }
  u8(0x00); // block terminator
}

// Header + Logical Screen Descriptor (2-entry Global Colour Table).
str('GIF89a');
u16(W); u16(H);
u8(0x80); // GCT present, 2 entries (size bits 0 → 2^1)
u8(0x00); // background colour index
u8(0x00); // pixel aspect ratio
// Global Colour Table: 0 = black, 1 = white.
u8(0x00); u8(0x00); u8(0x00);
u8(0xff); u8(0xff); u8(0xff);

// NETSCAPE2.0 application extension → loop forever.
u8(0x21); u8(0xff); u8(0x0b);
str('NETSCAPE2.0');
u8(0x03); u8(0x01); u16(0x0000); // loop count 0 = infinite
u8(0x00);

const minCodeSize = 2; // >= 2 required by the GIF spec even for a 2-colour table
for (const color of FRAME_COLORS) {
  // Graphic Control Extension (frame delay).
  u8(0x21); u8(0xf9); u8(0x04);
  u8(0x00); // no disposal, no transparency
  u16(DELAY_CS);
  u8(0x00); // transparent colour index (unused)
  u8(0x00); // block terminator
  // Image Descriptor.
  u8(0x2c); u16(0); u16(0); u16(W); u16(H); u8(0x00);
  // Image data: min code size + LZW sub-blocks.
  u8(minCodeSize);
  const indices = new Array(W * H).fill(color);
  writeSubBlocks(lzwUncompressed(indices, minCodeSize));
}
u8(0x3b); // trailer

const gif = Buffer.from(bytes);
writeFileSync(OUT, gif);
console.log(`wrote ${OUT} (${gif.length} bytes, ${FRAME_COLORS.length} frames)`);

// --- validate with the SAME WebCodecs ImageDecoder the app uses --------------
// WebCodecs ImageDecoder needs a SECURE CONTEXT — about:blank isn't one, but
// http://localhost IS ("potentially trustworthy"). Serve a blank page.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset="utf-8"><title>gif-validate</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/`);
  const b64 = gif.toString('base64');
  const result = await page.evaluate(async (b64) => {
    if (typeof ImageDecoder === 'undefined') return { error: 'no ImageDecoder' };
    if (!(await ImageDecoder.isTypeSupported('image/gif'))) return { error: 'gif unsupported' };
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const dec = new ImageDecoder({ type: 'image/gif', data });
    await dec.tracks.ready;
    const frameCount = dec.tracks.selectedTrack.frameCount;
    // Decode frame 0 and frame 1, draw each to a canvas, read mean luma.
    const luma = [];
    for (let i = 0; i < Math.min(frameCount, 2); i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const cv = new OffscreenCanvas(image.displayWidth || 16, image.displayHeight || 16);
      const ctx = cv.getContext('2d');
      ctx.drawImage(image, 0, 0);
      image.close();
      const { data: px } = ctx.getImageData(0, 0, cv.width, cv.height);
      let sum = 0;
      for (let j = 0; j < px.length; j += 4) sum += (px[j] + px[j + 1] + px[j + 2]) / 3;
      luma.push(sum / (px.length / 4));
    }
    dec.close();
    return { frameCount, luma };
  }, b64);

  if (result.error) throw new Error(`validation failed: ${result.error}`);
  if (result.frameCount !== FRAME_COLORS.length) {
    throw new Error(`expected ${FRAME_COLORS.length} frames, decoder saw ${result.frameCount}`);
  }
  const delta = Math.abs(result.luma[0] - result.luma[1]);
  if (delta < 100) throw new Error(`frames not distinct enough (luma ${result.luma.join(', ')})`);
  console.log(`validated: ${result.frameCount} frames, frame0/1 luma = ${result.luma.map((n) => n.toFixed(0)).join(' / ')} (Δ${delta.toFixed(0)})`);
} finally {
  await browser.close();
  server.close();
}
