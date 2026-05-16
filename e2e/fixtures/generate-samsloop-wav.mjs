#!/usr/bin/env node
// e2e/fixtures/generate-samsloop-wav.mjs
//
// Generates `samsloop-test.wav` — a tiny, deterministic 440 Hz sine with a
// short fade-in / fade-out envelope. Used by:
//   - e2e/tests/samsloop.spec.ts (file upload smoke)
//   - any local poking-around when developing the SAMSLOOP module
//
// The file is checked into the repo so CI doesn't need to regenerate it.
// Re-run this script if you change the parameters (and commit the result).
//
// Licensing: this script is part of the patchtogether.live repo (MIT),
// and the generated audio is pure synthesised sine — no third-party
// content, so the resulting WAV inherits the repo's MIT license without
// caveat.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 0.25 s at 22.05 kHz, 16-bit mono = 11_069 bytes including the 44-byte RIFF
// header — well under the 250 KB ceiling SAMSLOOP enforces.
const SAMPLE_RATE = 22_050;
const DURATION_S = 0.25;
const FREQ_HZ = 440;
const NUM_SAMPLES = Math.floor(SAMPLE_RATE * DURATION_S);

const samples = new Int16Array(NUM_SAMPLES);
const fadeSamples = Math.floor(NUM_SAMPLES * 0.05); // 5% fade in/out
for (let i = 0; i < NUM_SAMPLES; i++) {
  const t = i / SAMPLE_RATE;
  let env = 1;
  if (i < fadeSamples) env = i / fadeSamples;
  else if (i > NUM_SAMPLES - fadeSamples) env = (NUM_SAMPLES - i) / fadeSamples;
  const v = Math.sin(2 * Math.PI * FREQ_HZ * t) * env * 0.8;
  samples[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
}

// RIFF / WAVE / PCM-16 / mono header. Spec: http://soundfile.sapp.org/doc/WaveFormat/
const dataBytes = samples.length * 2;
const buf = new ArrayBuffer(44 + dataBytes);
const v = new DataView(buf);

function writeStr(off, s) {
  for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
}

writeStr(0, 'RIFF');                          // ChunkID
v.setUint32(4, 36 + dataBytes, true);         // ChunkSize
writeStr(8, 'WAVE');                          // Format
writeStr(12, 'fmt ');                         // Subchunk1ID
v.setUint32(16, 16, true);                    // Subchunk1Size (PCM = 16)
v.setUint16(20, 1, true);                     // AudioFormat (1 = PCM)
v.setUint16(22, 1, true);                     // NumChannels (mono)
v.setUint32(24, SAMPLE_RATE, true);           // SampleRate
v.setUint32(28, SAMPLE_RATE * 2, true);       // ByteRate
v.setUint16(32, 2, true);                     // BlockAlign
v.setUint16(34, 16, true);                    // BitsPerSample
writeStr(36, 'data');                         // Subchunk2ID
v.setUint32(40, dataBytes, true);             // Subchunk2Size

// PCM data — little-endian 16-bit signed.
const data = new Int16Array(buf, 44, samples.length);
data.set(samples);

const outPath = join(__dirname, 'samsloop-test.wav');
writeFileSync(outPath, Buffer.from(buf));
const sizeKb = (buf.byteLength / 1024).toFixed(2);
console.log(`wrote ${outPath} (${buf.byteLength} bytes, ${sizeKb} KB)`);
