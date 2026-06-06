// packages/web/src/lib/qbert/rom-zip.ts
//
// Tiny in-browser ZIP extractor for the QBERT module's ROM file.
// Uses `fflate` (MIT, ~4 KB minified) so the QBERT bundle stays small.
//
// The MAME `qbert` set is a zip containing several Z80 + I8039 ROM
// binaries; we don't care which subset is present here — `parseRomZip`
// returns the full filename→bytes map and the engine bootstrap (in
// qbert-runtime.ts) picks the ones it needs (`qb-rom0.bin`...`qb-rom2.bin`
// for the main Z80, `qb-snd0.bin` / `qb-snd1.bin` for the sound CPU).
//
// Pure + uses ONLY the fflate function-form API (`unzipSync`) so the
// helper is safe to call inside the video module factory's load path
// (no DOM / no Worker requirement).
//
// Errors:
//   - empty buffer → "QBERT ROM zip is empty"
//   - corrupt zip → "QBERT ROM zip is corrupt: <fflate-error>"
//   - empty zip (zero files) → "QBERT ROM zip contains no files"

import { unzipSync } from 'fflate';

export interface QbertRomMap {
  /** Filename → raw bytes. Keys are the in-zip filenames verbatim (e.g.
   *  `qb-rom0.bin`); subdirectories are flattened to filename-only. */
  roms: Map<string, Uint8Array>;
}

/**
 * Synchronously extract every entry in a Q*Bert ROM zip.
 *
 * Throws on empty input, corrupt zip data, or a zip with zero files —
 * the caller surfaces the message as the "ROM missing" overlay reason.
 */
export function parseRomZip(buf: ArrayBuffer | Uint8Array): QbertRomMap {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length === 0) {
    throw new Error('QBERT ROM zip is empty');
  }
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`QBERT ROM zip is corrupt: ${msg}`);
  }
  const roms = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(extracted)) {
    if (data.length === 0) continue; // skip zero-byte entries (often directory markers)
    // Flatten any internal directory: zips from various MAME mirrors
    // sometimes nest under `qbert/qb-rom0.bin`; the engine only cares
    // about the bare filename.
    const name = path.split('/').pop() ?? path;
    roms.set(name, data);
  }
  if (roms.size === 0) {
    throw new Error('QBERT ROM zip contains no files');
  }
  return { roms };
}
