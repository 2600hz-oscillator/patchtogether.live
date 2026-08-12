// scripts/tracked-source-is-greppable.test.ts
//
// A SOURCE FILE THAT `grep` CALLS BINARY RETURNS NOTHING — AND NOTHING IS WHAT
// "THE SYMBOL DOES NOT EXIST" ALSO LOOKS LIKE.
//
// `packages/web/src/lib/video/engine.ts` — the single most-read file in the
// video subsystem — carried ONE raw NUL byte (0x00), inside a template literal
// used as a composite key:
//
//     return `${nodeId}<NUL>${paramId}`;      // written as a raw byte, not \u0000
//
// GNU/BSD grep classify a file as binary the moment they see a NUL (or an
// invalid UTF-8 sequence) and then print NO MATCHES AT ALL. No error. No
// warning. Exit code 1 — identical to a genuine miss. `git diff` renders the
// file as `Bin 20263 -> 20273 bytes` for the same reason. Three agents lost
// time to this in one day, and one was pushed toward a fallback architecture it
// did not need because the symbol it searched for "did not exist".
//
// The byte was never intentional-as-written: in `vfpga/bitstream.test.ts` the
// lone surrogate one property over was spelled `'\uD800'` while the NUL beside
// it was a raw byte. `\u0000` produces a byte-identical RUNTIME string, so
// every fix here is a pure source-encoding change with no behavioural effect.
//
// Measured on the tree that motivated this gate: FIVE tracked source files
// carried raw NULs, not one —
//   packages/web/src/lib/video/engine.ts
//   packages/web/src/lib/graph/snapshot.ts
//   packages/web/src/lib/graph/stereo-autowire.ts
//   packages/web/src/lib/ui/modules/manual-strike-actions.ts
//   packages/web/src/lib/video/vfpga/bitstream.test.ts
//
// ── WHAT THIS GATE CANNOT SEE (stated, per the blind-gates rule) ────────────
//  · Control bytes OTHER than NUL do NOT make grep go binary, so they are NOT
//    flagged. `scripts/webgl-attest.ts` carries a raw ESC (0x1b) inside an
//    ANSI-stripping regex and greps perfectly well (measured: 62 matches for
//    `const`). Widening to all C0 would flag that deliberate byte, so the
//    predicate is pinned to grep's ACTUAL rule — NUL or invalid UTF-8 — and
//    `rejects a NUL but accepts a raw ESC` below asserts that boundary rather
//    than leaving it to prose.
//  · Content is only checked for files git does not DECLARE binary (`-text` in
//    .gitattributes) and whose extension is not in BINARY_EXTENSIONS. A raw NUL
//    inside a genuinely-binary asset is not a defect.
//  · Only TRACKED files are scanned. An untracked working-tree file is out of
//    scope (it is also not something another agent will grep for).
//
// ⚠ The skip set is deliberately NOT git's own content-based binary detection.
// Git decides "binary" with the same NUL heuristic as grep, so using it to
// choose what to scan would skip exactly the files this gate exists to catch —
// a gate structurally unable to see its own bug class. Skips come from
// DECLARATIONS (.gitattributes `-text`) and from a named, anchored extension
// list, never from the bytes.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions whose tracked files are binary ASSETS but are NOT declared
 *  `-text` in .gitattributes (only the LFS-tracked paths are). Deny-by-default:
 *  anything not listed here IS scanned, so a new binary type reddens this gate
 *  until it is declared with a reason rather than silently going unchecked.
 *
 *  ANCHORED — `every declared binary extension still matches a tracked file`
 *  below fails on an entry that no longer resolves, so a stale skip cannot sit
 *  here unwatched. */
const BINARY_EXTENSIONS: { ext: string; why: string }[] = [
  { ext: '.png', why: 'raster images — icons and doc assets outside the LFS-tracked VRT/annotated baseline paths' },
  { ext: '.gif', why: 'raster image — e2e animated-image fixture' },
  { ext: '.wav', why: 'PCM audio — wavetable + e2e audio fixtures outside the LFS-tracked art/ and packages/dsp/ paths' },
  { ext: '.webm', why: 'video fixtures for the e2e video lanes' },
  { ext: '.mp4', why: 'video fixture for the e2e HLS lane' },
  { ext: '.woff2', why: 'compressed webfont binaries' },
  { ext: '.zip', why: 'archive fixture for the cold-load perf e2e' },
  { ext: '.syx', why: 'MIDI System Exclusive dump — DX7 patch bank fixture' },
];

/** grep's ACTUAL binary rule, and the whole subject of this gate: a NUL byte,
 *  or bytes that are not valid UTF-8. Returns a reason, or null for plain text.
 *
 *  Exported so the negative/positive controls below exercise THIS function
 *  rather than a re-typed copy of it — a re-typed copy in the self-test is how
 *  the previous generation of gates in this repo went blind. */
export function grepBinaryReason(buf: Uint8Array): string | null {
  const reasons: string[] = [];
  const nul = buf.indexOf(0);
  if (nul >= 0) reasons.push(`NUL byte (0x00) at offset ${nul}`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    reasons.push('not valid UTF-8');
  }
  return reasons.length ? reasons.join('; ') : null;
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

const trackedFiles: string[] = execFileSync('git', ['ls-files', '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 1 << 28,
})
  .split('\0')
  .filter(Boolean);

/** Paths git DECLARES non-text via a `-text` attribute (every LFS-tracked path
 *  in .gitattributes carries one). Using the declaration rather than the bytes
 *  also makes this gate independent of whether LFS content is materialized in
 *  the checkout — a pointer file and its 16 MB payload are both skipped. */
function declaredNonText(paths: string[]): Set<string> {
  const out = execFileSync('git', ['check-attr', '-z', '--stdin', 'text'], {
    cwd: ROOT,
    input: paths.join('\0'),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  const f = out.split('\0');
  const set = new Set<string>();
  // check-attr -z emits a flat <path> NUL <attr> NUL <value> NUL stream.
  for (let i = 0; i + 2 < f.length; i += 3) if (f[i + 2] === 'unset') set.add(f[i]);
  return set;
}

const DECLARED_BINARY = declaredNonText(trackedFiles);
const SKIP_EXTS = new Set(BINARY_EXTENSIONS.map((b) => b.ext));
const scanned = trackedFiles.filter((p) => !DECLARED_BINARY.has(p) && !SKIP_EXTS.has(extensionOf(p)));

describe('every tracked source file is greppable text', () => {
  it('no tracked source file is binary to grep', () => {
    const offenders: string[] = [];
    for (const rel of scanned) {
      let buf: Buffer;
      try {
        buf = readFileSync(join(ROOT, rel));
      } catch {
        continue; // a tracked path missing from the worktree is not this gate's business
      }
      const reason = grepBinaryReason(buf);
      if (reason) offenders.push(`${rel} — ${reason}`);
    }
    expect(
      offenders,
      'These tracked files contain a NUL byte or invalid UTF-8, so `grep` reports NO MATCHES in ' +
        'them — silently, with exit code 1, indistinguishable from "the symbol does not exist". ' +
        'If the byte is a string value (a composite-key separator, a test fixture), spell it as an ' +
        'ESCAPE (`\\u0000`) — the runtime string is byte-identical. If the file is genuinely a ' +
        'binary asset, declare it: `-text` in .gitattributes, or add its extension to ' +
        'BINARY_EXTENSIONS in this file with a reason.',
    ).toEqual([]);
  });

  it('every declared binary extension still matches a tracked file', () => {
    // Inversion 2 — anchor the ledger to the ARTIFACT. A skip nobody is
    // watching is how a real defect hides behind a stale exemption.
    const stale = BINARY_EXTENSIONS.filter((b) => !trackedFiles.some((p) => extensionOf(p) === b.ext)).map(
      (b) => `${b.ext} (${b.why})`,
    );
    expect(stale, 'BINARY_EXTENSIONS names an extension no tracked file has any more — delete the entry').toEqual([]);
  });

  it('the scan is not vacuous — it reaches real source, anchored to named files', () => {
    // ⚠ A BARE GREEN HERE WOULD BE INDISTINGUISHABLE FROM A SCAN OF ZERO FILES.
    // Anchored to specific artifacts rather than to a count: a population count
    // would be correct when written and wrong the moment a sibling branch
    // merged, and it would tell us nothing about WHICH files got scanned.
    // Long-lived tracked files spanning the extensions that matter, so the
    // anchor also proves the scan is not silently confined to one directory or
    // one file type. (Deliberately NOT this file: it is untracked until it is
    // committed, which would make the gate red on the run that introduces it.)
    const mustScan = [
      'packages/web/src/lib/video/engine.ts', // the file that motivated this gate
      'scripts/webgl-attest.ts', // a scripts/ source — and the raw-ESC file the scope note names
      'CLAUDE.md', // prose is scanned too; a NUL in a doc hides it from grep just the same
    ];
    const missing = mustScan.filter((p) => !scanned.includes(p));
    expect(missing, 'the tracked-file scan no longer reaches these — the enumeration or the skip logic broke').toEqual(
      [],
    );
  });

  it('POSITIVE CONTROL: the predicate flags a REAL tracked binary asset', () => {
    // Proves the offenders list is empty because the SOURCE is clean, not
    // because the predicate cannot recognise binary content. Uses a real file
    // from the tree, so it also proves the skip list (not a blind predicate) is
    // what keeps assets out of the scan.
    const asset = trackedFiles.find((p) => extensionOf(p) === '.woff2');
    expect(asset, 'expected a tracked .woff2 to positive-control against').toBeTruthy();
    expect(grepBinaryReason(readFileSync(join(ROOT, asset!)))).not.toBeNull();
  });

  it('NEGATIVE CONTROL: the predicate fires on each binary form, and only those', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    // Must be flagged.
    expect(grepBinaryReason(enc('const a = `x\u0000y`;'))).toMatch(/NUL byte/);
    expect(grepBinaryReason(Uint8Array.from([0x61, 0xff, 0xfe, 0x62]))).toMatch(/not valid UTF-8/);
    // Must NOT be flagged — otherwise a predicate that returned a reason for
    // everything would pass every assertion above.
    expect(grepBinaryReason(enc('const a = 1;\n\tconst b = 2;\r\n'))).toBeNull();
    expect(grepBinaryReason(enc('// emoji and accents are fine: 🎛️ — café\n'))).toBeNull();
    expect(grepBinaryReason(new Uint8Array(0))).toBeNull();
  });

  it('rejects a NUL but accepts a raw ESC — the scope boundary, asserted', () => {
    // grep goes binary on NUL, NOT on other C0 bytes. scripts/webgl-attest.ts
    // carries a raw ESC inside an ANSI-stripping regex and greps fine, so
    // widening this predicate would produce a false positive on a deliberate
    // byte. Asserted here so the boundary cannot drift silently in either
    // direction.
    expect(grepBinaryReason(Uint8Array.from([0x61, 0x1b, 0x5b, 0x30, 0x6d]))).toBeNull();
    expect(grepBinaryReason(Uint8Array.from([0x61, 0x00]))).not.toBeNull();
  });
});
