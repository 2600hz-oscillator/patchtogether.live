// packages/web/src/lib/audio/wavetable-presets.ts
//
// Baked-in wavetable PRESET registry. The 46 .WAV files listed below are
// shipped in packages/web/static/wavetables/ and served at /wavetables/<FILE>
// via SvelteKit's static path (i.e. NOT bundled into the JS chunk — fetched
// on demand the first time a user picks the preset).
//
// (The original spec called this "45 presets" but the enumerated filename
// list actually contains 46 — including all of them.)
//
// All 46 files share the same on-disk shape: 16-bit signed-PCM, mono,
// 44.1 kHz, 16 384 samples total = 64 frames × 256 samples (E352-canonical).
// This matches what existing modules (WAVECEL, WAVESCULPT, WAVVIZ) already
// route through their loadWavetable plumbing.
//
// The parser BELOW is intentionally more lenient than parseE352Wav() so the
// same path can absorb other-format presets in the future (32-bit float,
// stereo via channel-0, sample counts that aren't a clean multiple of 256
// — last frame zero-padded). The 45 currently-bundled files happen to all
// be in the strict E352 shape so neither lenience branch fires today.

/** Default frames-per-row for a wavetable preset. Matches the E352
 *  canonical frame size and the worklet-side wavetable engine. */
export const PRESET_FRAME_SIZE = 256;

export interface WavetablePreset {
  /** Stable storage id (kebab-cased lowercase filename without .WAV). */
  id: string;
  /** Display label (filename without .WAV extension, ALL-CAPS). */
  label: string;
  /** Public URL served by SvelteKit static (NOT bundled in JS). */
  url: string;
}

/** The 46 baked-in preset URLs. Order roughly matches the user's
 *  enumeration; the dropdown shows them in this same order. */
export const WAVETABLE_PRESETS: WavetablePreset[] = [
  { id: 'zap',      label: 'ZAP',      url: '/wavetables/ZAP.WAV' },
  { id: 'window_s', label: 'WINDOW_S', url: '/wavetables/WINDOW_S.WAV' },
  { id: 'wavetrip', label: 'WAVETRIP', url: '/wavetables/WAVETRIP.WAV' },
  { id: 'vps',      label: 'VPS',      url: '/wavetables/VPS.WAV' },
  { id: 'voxsynth', label: 'VOXSYNTH', url: '/wavetables/VOXSYNTH.WAV' },
  { id: 'voice_dr', label: 'VOICE_DR', url: '/wavetables/VOICE_DR.WAV' },
  { id: 'voice_a',  label: 'VOICE_A',  url: '/wavetables/VOICE_A.WAV' },
  { id: 'vocal_fo', label: 'VOCAL_FO', url: '/wavetables/VOCAL_FO.WAV' },
  { id: 'virus_sa', label: 'VIRUS_SA', url: '/wavetables/VIRUS_SA.WAV' },
  { id: 'vincent_', label: 'VINCENT_', url: '/wavetables/VINCENT_.WAV' },
  { id: 'tidyb072', label: 'TIDYB072', url: '/wavetables/TIDYB072.WAV' },
  { id: 'tidyb021', label: 'TIDYB021', url: '/wavetables/TIDYB021.WAV' },
  { id: 'tidal',    label: 'TIDAL',    url: '/wavetables/TIDAL.WAV' },
  { id: 'talking',  label: 'TALKING',  url: '/wavetables/TALKING.WAV' },
  { id: 'table_ti', label: 'TABLE_TI', url: '/wavetables/TABLE_TI.WAV' },
  { id: 'synth_vo', label: 'SYNTH_VO', url: '/wavetables/SYNTH_VO.WAV' },
  { id: 'synlpg08', label: 'SYNLPG08', url: '/wavetables/SYNLPG08.WAV' },
  { id: 'synlp81',  label: 'SYNLP81',  url: '/wavetables/SYNLP81.WAV' },
  { id: 'synlp18',  label: 'SYNLP18',  url: '/wavetables/SYNLP18.WAV' },
  { id: 'synlp154', label: 'SYNLP154', url: '/wavetables/SYNLP154.WAV' },
  { id: 'spectral', label: 'SPECTRAL', url: '/wavetables/SPECTRAL.WAV' },
  { id: 'sohler79', label: 'SOHLER79', url: '/wavetables/SOHLER79.WAV' },
  { id: 'sand_eye', label: 'SAND_EYE', url: '/wavetables/SAND_EYE.WAV' },
  { id: 'rrlyrq7',  label: 'RRLYRQ7',  url: '/wavetables/RRLYRQ7.WAV' },
  { id: 'rrlyrq6',  label: 'RRLYRQ6',  url: '/wavetables/RRLYRQ6.WAV' },
  { id: 'rofl',     label: 'ROFL',     url: '/wavetables/ROFL.WAV' },
  { id: 'retro_sp', label: 'RETRO_SP', url: '/wavetables/RETRO_SP.WAV' },
  { id: 'reso_squ', label: 'RESO_SQU', url: '/wavetables/RESO_SQU.WAV' },
  { id: 'reso_p00', label: 'RESO_P00', url: '/wavetables/RESO_P00.WAV' },
  { id: 'random_n', label: 'RANDOM_N', url: '/wavetables/RANDOM_N.WAV' },
  { id: 'qux_fmy',  label: 'QUX_FMY',  url: '/wavetables/QUX_FMY.WAV' },
  { id: 'quack',    label: 'QUACK',    url: '/wavetables/QUACK.WAV' },
  { id: 'prophet_', label: 'PROPHET_', url: '/wavetables/PROPHET_.WAV' },
  { id: 'piston_h', label: 'PISTON_H', url: '/wavetables/PISTON_H.WAV' },
  { id: 'osmaos',   label: 'OSMAOS',   url: '/wavetables/OSMAOS.WAV' },
  { id: 'organ_di', label: 'ORGAN_DI', url: '/wavetables/ORGAN_DI.WAV' },
  { id: 'morphing', label: 'MORPHING', url: '/wavetables/MORPHING.WAV' },
  { id: 'lsdj_wav', label: 'LSDJ_WAV', url: '/wavetables/LSDJ_WAV.WAV' },
  { id: 'lom_a',    label: 'LOM_A',    url: '/wavetables/LOM_A.WAV' },
  { id: 'lofirise', label: 'LOFIRISE', url: '/wavetables/LOFIRISE.WAV' },
  { id: 'light_ye', label: 'LIGHT_YE', url: '/wavetables/LIGHT_YE.WAV' },
  { id: 'kermiten', label: 'KERMITEN', url: '/wavetables/KERMITEN.WAV' },
  { id: 'keen',     label: 'KEEN',     url: '/wavetables/KEEN.WAV' },
  { id: 'i_heart_', label: 'I_HEART_', url: '/wavetables/I_HEART_.WAV' },
  { id: 'isolde',   label: 'ISOLDE',   url: '/wavetables/ISOLDE.WAV' },
  { id: 'isobelle', label: 'ISOBELLE', url: '/wavetables/ISOBELLE.WAV' },
];

/** Look up a preset by storage id. */
export function getWavetablePreset(id: string): WavetablePreset | undefined {
  return WAVETABLE_PRESETS.find((p) => p.id === id);
}

// ---------- WAV parser ----------

/** Result of parsing a preset WAV into wire-format frames. */
export interface ParsedPreset {
  /** number[frames][frameSize], values in [-1, +1]. The number[][] shape
   *  matches the existing loadWavetable wire format used by WAVECEL +
   *  WAVESCULPT (structured-clone-safe; Yjs-safe). */
  frames: number[][];
  /** Resolved frame size (defaulted to PRESET_FRAME_SIZE for caller
   *  convenience even though the caller already passed it in). */
  frameSize: number;
  /** Raw WAV sample-rate (44 100 Hz for all 45 baked presets). Tracked
   *  for diagnostics; the loadWavetable consumers are sample-rate-agnostic
   *  (frame layout is what matters). */
  sampleRate: number;
  /** Channels detected in the WAV. For stereo we use channel 0 (the
   *  wavetable convention; channel 1 is discarded). */
  channels: number;
  /** Bits per sample (16 or 32, where 32 = IEEE-754 float). */
  bitsPerSample: number;
}

/**
 * Parse a wavetable preset WAV file at `url` into a number[][] frame array
 * suitable for any worklet's loadWavetable message.
 *
 * WAV format expectations (broader than parseE352Wav):
 *   - PCM (16-bit signed) OR IEEE float (32-bit). Stereo is tolerated —
 *     channel 0 is taken, channel 1 discarded (the wavetable convention).
 *   - Sample count per channel can be any positive integer. If it isn't a
 *     clean multiple of `frameSize` the LAST frame is zero-padded at the
 *     end (chosen over truncation so a hand-crafted irregular table doesn't
 *     silently lose its tail wave).
 *
 * NOTE: we DON'T use AudioContext.decodeAudioData because that resamples to
 * the AudioContext's sampleRate, which would corrupt the sample-positional
 * meaning of a wavetable (each row is exactly `frameSize` samples in the
 * SOURCE rate — resampling shifts that grid). We read the bytes manually
 * via DataView and convert to Float32 with the WAV's native sample format.
 */
export async function loadWavetablePreset(
  url: string,
  frameSize: number = PRESET_FRAME_SIZE,
): Promise<ParsedPreset> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} → ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return parseWavetablePresetBuffer(buf, frameSize);
}

/** Sync version of `loadWavetablePreset` for an already-fetched buffer.
 *  Exposed so tests can inject a synthetic WAV without touching `fetch`. */
export function parseWavetablePresetBuffer(
  buf: ArrayBuffer,
  frameSize: number = PRESET_FRAME_SIZE,
): ParsedPreset {
  if (!Number.isInteger(frameSize) || frameSize <= 0) {
    throw new Error(`invalid frameSize ${frameSize}`);
  }
  if (buf.byteLength < 44) {
    throw new Error(`WAV too short: ${buf.byteLength} bytes`);
  }
  const view = new DataView(buf);

  const riff = readAscii(view, 0, 4);
  if (riff !== 'RIFF') throw new Error(`expected 'RIFF', got '${riff}'`);
  const wave = readAscii(view, 8, 4);
  if (wave !== 'WAVE') throw new Error(`expected 'WAVE', got '${wave}'`);

  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = -1;

  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id = readAscii(view, off, 4);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      audioFormat = view.getUint16(off + 8, true);
      numChannels = view.getUint16(off + 10, true);
      sampleRate = view.getUint32(off + 12, true);
      bitsPerSample = view.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOffset = off + 8;
      dataLength = size;
      break;
    }
    off += 8 + size + (size & 1);
  }

  if (dataOffset < 0) throw new Error("missing 'data' chunk");
  if (numChannels < 1) throw new Error(`expected ≥1 channel, got ${numChannels}`);

  // Choose decoder for the WAV's sample format.
  // - audioFormat 1, bps 16 → signed PCM (the 45 baked presets are all here).
  // - audioFormat 3, bps 32 → IEEE-754 little-endian float (newer wavetable tools).
  // Everything else we reject — silently coercing 24-bit or A-law would lie about
  // the user's data.
  let bytesPerSample: number;
  let readSample: (i: number) => number;
  if (audioFormat === 1 && bitsPerSample === 16) {
    bytesPerSample = 2;
    readSample = (i) => {
      const v = view.getInt16(dataOffset + i * bytesPerSample, true);
      // Asymmetric scale: -32768 → -1, +32767 → +1. Matches parseE352Wav.
      return v < 0 ? v / 32768 : v / 32767;
    };
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    bytesPerSample = 4;
    readSample = (i) => view.getFloat32(dataOffset + i * bytesPerSample, true);
  } else {
    throw new Error(
      `unsupported WAV format: audioFormat=${audioFormat} bitsPerSample=${bitsPerSample}` +
        ' (expected 1/16 PCM or 3/32 float)',
    );
  }

  const totalSampleSlots = Math.floor(dataLength / bytesPerSample);
  if (totalSampleSlots <= 0) throw new Error('empty data chunk');
  // For stereo (or higher), one "channel-0 sample" advances by numChannels slots.
  const channel0Samples = Math.floor(totalSampleSlots / numChannels);
  if (channel0Samples <= 0) throw new Error('no samples after channel split');

  // Slice channel 0 into frames of `frameSize`. PAD the trailing partial
  // frame with zeros (documented choice — see header).
  const frameCount = Math.ceil(channel0Samples / frameSize);
  const frames: number[][] = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const frame: number[] = new Array(frameSize);
    for (let s = 0; s < frameSize; s++) {
      const ch0Index = f * frameSize + s;
      if (ch0Index < channel0Samples) {
        // Stride by numChannels; we always take channel 0.
        let v = readSample(ch0Index * numChannels);
        // Float WAVs are usually already in [-1, +1] but clamp defensively.
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        frame[s] = v;
      } else {
        frame[s] = 0; // zero-pad tail
      }
    }
    frames[f] = frame;
  }

  return {
    frames,
    frameSize,
    sampleRate,
    channels: numChannels,
    bitsPerSample,
  };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}
