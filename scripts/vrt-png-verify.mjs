// scripts/vrt-png-verify.mjs
//
// DECODE-VERIFY PNG FILES; print the paths of the CORRUPT ones.
//
// Why this exists (run 33198943725): the first sharded VRT capture delivered
// one baseline of 59 — mirrorpool-refract.png — whose zlib stream failed its
// Adler-32 check ("incorrect data check"). The file had a valid PNG signature
// and chunk structure, so nothing upstream noticed; the collector committed
// it, and the cable-stripe palette gate then reddened EVERY subsequent CI run
// on the branch while the capture workflow itself reported success. A corrupt
// baseline is strictly worse than a missing one: a missing one stays stale and
// vrt-strict names it, while a corrupt one poisons whichever gate decodes it.
//
// So the collector verifies WHAT IT IS ABOUT TO COMMIT: full signature check,
// chunk walk, and a complete IDAT inflate (the Adler-32 at the stream's tail
// is what catches truncation/bit-rot that CRC-passing chunks can hide). A
// corrupt file's path goes to stdout — the caller un-stages exactly those and
// lands the rest — following the same five-of-six-shards philosophy as the
// collect job itself: never discard good work because a sibling is bad.
//
// Usage:  node scripts/vrt-png-verify.mjs <file.png> [...more]
//         (or newline-separated paths on stdin when no args are given)
// Output: one corrupt path per line on stdout; diagnostics on stderr.
// Exit:   0 always when the verification itself ran (corrupt files are a
//         REPORT, not an error — the caller decides what to do); 2 only for
//         usage/IO failures unrelated to PNG content.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = '89504e470d0a1a0a';

/** Throws with a reason when `buf` is not a fully-decodable PNG. */
export function assertDecodablePng(buf) {
  if (buf.length < 8 || buf.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error('missing PNG signature');
  }
  const idat = [];
  let off = 8;
  let sawEnd = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const dataStart = off + 8;
    if (dataStart + len + 4 > buf.length) {
      throw new Error(`truncated ${type} chunk`);
    }
    if (type === 'IDAT') idat.push(buf.subarray(dataStart, dataStart + len));
    off = dataStart + len + 4; // skip data + CRC
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new Error('no IEND chunk');
  // ⚠ TRAILING BYTES AFTER IEND ARE CORRUPTION, and this check exists because
  // its absence let four of them into the committed set. A PNG ends AT IEND;
  // anything after it is not part of the image. `pngjs` — the decoder
  // Playwright's screenshot comparator uses — refuses such a file outright
  // ("unrecognised content at end of stream"), so a baseline with a tail is
  // unreadable by the one consumer that matters while every structural check
  // above it passes: the signature is right, every chunk CRC is right, and the
  // IDAT inflates with a correct Adler-32. This verifier used to `break` at
  // IEND and report "decodes clean" for exactly those files.
  //
  // MEASURED 2026-09-05 over the 495 committed baselines: 4 carried tails of
  // 720-1610 bytes (adsr-sustain-high, karplus-dark-mallet,
  // wavesculpt-blink-custom-colors, wavesculpt-blink-scopes-trial). Each one
  // failed its capture with "Failed to re-generate expected", because
  // `--update-snapshots` must READ the existing snapshot before it can decide
  // to replace it — so the corruption was also UNREPAIRABLE by the accept
  // loop. The repair is `git rm` + recapture, which is the same one the
  // accept-loop prose already prescribes for an in-tolerance stale baseline.
  if (off !== buf.length) {
    throw new Error(`${buf.length - off} trailing byte(s) after IEND`);
  }
  if (idat.length === 0) throw new Error('no IDAT chunks');
  // The full inflate: zlib's trailing Adler-32 is the integrity check that
  // catches what chunk-structure walking cannot.
  inflateSync(Buffer.concat(idat));
}

function pathsFromArgvOrStdin() {
  const args = process.argv.slice(2);
  if (args.length > 0) return args;
  try {
    return readFileSync(0, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Report-only main: never throws on corrupt content.
if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = pathsFromArgvOrStdin();
  let corrupt = 0;
  for (const p of paths) {
    if (!p.endsWith('.png')) continue;
    let buf;
    try {
      buf = readFileSync(p);
    } catch (e) {
      console.error(`vrt-png-verify: cannot read ${p}: ${e.message}`);
      process.exit(2);
    }
    try {
      assertDecodablePng(buf);
    } catch (e) {
      corrupt++;
      console.error(`vrt-png-verify: CORRUPT ${p} (${e.message})`);
      console.log(p);
    }
  }
  console.error(`vrt-png-verify: checked ${paths.length} file(s), ${corrupt} corrupt`);
}
