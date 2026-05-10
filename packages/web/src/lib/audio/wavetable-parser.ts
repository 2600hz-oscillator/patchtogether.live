// packages/web/src/lib/audio/wavetable-parser.ts
//
// Parses an E352 Cloud Terrarium-format wavetable WAV.
//
// Format reference (Synthesis Technology E352, MakeNoise/Befaco/etc. share
// the convention): a single mono 16-bit-PCM WAV whose audio payload is a
// power-of-two count of frames concatenated end-to-end, each frame being
// 256 samples. Standard frame counts: 32, 64, 128, 256. Sample rate is
// usually 44100 Hz but the parser doesn't enforce it — frame layout is
// what matters for wavetable playback.
//
// Returns Float32 frames in -1..+1. Throws on malformed RIFF/WAVE,
// non-PCM, non-mono, or audio length not divisible by 256.

export const E352_FRAME_SIZE = 256;

export interface ParsedWavetable {
  frames: Float32Array[];
  sampleRate: number;
  samplesPerFrame: number;
  bitsPerSample: number;
}

export function parseE352Wav(buf: ArrayBuffer): ParsedWavetable {
  if (buf.byteLength < 44) {
    throw new Error(`WAV too short: ${buf.byteLength} bytes`);
  }
  const view = new DataView(buf);

  const riff = readAscii(view, 0, 4);
  if (riff !== 'RIFF') throw new Error(`expected 'RIFF', got '${riff}'`);
  const wave = readAscii(view, 8, 4);
  if (wave !== 'WAVE') throw new Error(`expected 'WAVE', got '${wave}'`);

  let fmtAudioFormat = 0;
  let fmtNumChannels = 0;
  let fmtSampleRate = 0;
  let fmtBitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = -1;

  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id = readAscii(view, off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmtAudioFormat = view.getUint16(off + 8, true);
      fmtNumChannels = view.getUint16(off + 10, true);
      fmtSampleRate = view.getUint32(off + 12, true);
      fmtBitsPerSample = view.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOffset = off + 8;
      dataLength = size;
      break;
    }
    off += 8 + size + (size & 1);
  }

  if (dataOffset < 0) throw new Error("missing 'data' chunk");
  if (fmtAudioFormat !== 1) throw new Error(`expected PCM (1), got format ${fmtAudioFormat}`);
  if (fmtNumChannels !== 1) throw new Error(`expected mono, got ${fmtNumChannels} channels`);
  if (fmtBitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${fmtBitsPerSample}-bit`);

  const bytesPerSample = fmtBitsPerSample / 8;
  const totalSamples = Math.floor(dataLength / bytesPerSample);
  if (totalSamples <= 0) throw new Error('empty data chunk');
  if (totalSamples % E352_FRAME_SIZE !== 0) {
    throw new Error(
      `sample count ${totalSamples} not divisible by ${E352_FRAME_SIZE} ` +
      `(remainder ${totalSamples % E352_FRAME_SIZE})`,
    );
  }

  const frameCount = totalSamples / E352_FRAME_SIZE;
  const frames: Float32Array[] = new Array(frameCount);
  const i16View = new DataView(buf, dataOffset, totalSamples * bytesPerSample);
  for (let f = 0; f < frameCount; f++) {
    const frame = new Float32Array(E352_FRAME_SIZE);
    for (let s = 0; s < E352_FRAME_SIZE; s++) {
      const byteOff = (f * E352_FRAME_SIZE + s) * bytesPerSample;
      const i16 = i16View.getInt16(byteOff, true);
      frame[s] = i16 < 0 ? i16 / 32768 : i16 / 32767;
    }
    frames[f] = frame;
  }

  return {
    frames,
    sampleRate: fmtSampleRate,
    samplesPerFrame: E352_FRAME_SIZE,
    bitsPerSample: fmtBitsPerSample,
  };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

/** Encode `frames` as a synthetic E352-format mono PCM16 WAV ArrayBuffer.
 *  Round-trips with `parseE352Wav` — used by the unit test to validate
 *  parsing against an in-memory reference. Public so other tooling can
 *  produce E352 WAVs from synthesized waveforms if needed. */
export function encodeE352Wav(frames: Float32Array[], sampleRate = 44100): ArrayBuffer {
  if (frames.length === 0) throw new Error('cannot encode 0 frames');
  for (const f of frames) {
    if (f.length !== E352_FRAME_SIZE) {
      throw new Error(`frame length ${f.length} != ${E352_FRAME_SIZE}`);
    }
  }
  const totalSamples = frames.length * E352_FRAME_SIZE;
  const dataLen = totalSamples * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLen, true);
  let off = 44;
  for (const frame of frames) {
    for (let s = 0; s < E352_FRAME_SIZE; s++) {
      const v = Math.max(-1, Math.min(1, frame[s] ?? 0));
      const i16 = Math.round(v < 0 ? v * 32768 : v * 32767);
      view.setInt16(off, i16, true);
      off += 2;
    }
  }
  return buf;
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
