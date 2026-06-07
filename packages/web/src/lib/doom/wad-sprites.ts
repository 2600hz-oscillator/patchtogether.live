// packages/web/src/lib/doom/wad-sprites.ts
//
// PURE WAD lump reader + DOOM picture(patch) decoder + sprite extraction.
//
// GibRibbon renders the actual DOOM marine + imp + former-human sprites as
// its game actors (the line-art-ribbon-vs-real-FPS-sprite contrast is the
// whole point of the module). The DOOM module already obtains DOOM1.WAD
// (shareware, gitignored, fetched in CI — see packages/web/.gitignore +
// .github/workflows/ci.yml + $lib/video/modules/doom.ts loadWad()); here we
// PARSE that same byte buffer into RGBA sprite frames at load time.
//
// Everything in this file is PURE (no GL, no DOM, no fetch) so it unit-tests
// trivially against a tiny hand-built WAD fixture — the same discipline the
// repo applies to cv-gate-edge.ts / doom-death-ports.ts.
//
// ── DOOM WAD format (stable since 1993) ────────────────────────────────────
//
//   Header (12 bytes, little-endian):
//     char[4] identification   "IWAD" or "PWAD"
//     int32   numlumps
//     int32   infotableofs     byte offset of the directory
//
//   Directory: numlumps × filelump_t (16 bytes each):
//     int32   filepos          byte offset of the lump's data
//     int32   size             lump size in bytes
//     char[8] name             NUL-padded, upper-case ASCII
//
//   PLAYPAL lump: 14 palettes × 256 × 3 bytes (R,G,B). We use palette 0.
//
//   Picture (patch_t) lump — DOOM's column-major RLE sprite format:
//     int16 width, int16 height, int16 leftoffset, int16 topoffset
//     int32 columnofs[width]   byte offset (from lump start) of each column
//     per column: a run of "posts":
//       byte topdelta          (0xFF marks end of column)
//       byte length            number of pixels in this post
//       byte unused            (padding)
//       byte pixels[length]    palette indices
//       byte unused            (padding)
//
// ── Sprite lump naming ─────────────────────────────────────────────────────
//
//   <4-char-name><frame-letter><rotation-digit>[<frameB><rotB>]
//
//   The 4-char name identifies the actor; the FRAME letter (A,B,C…) is the
//   animation frame; the ROTATION digit (0..8) is the view angle — 0 = "this
//   one frame is used for all angles", 1 = facing toward viewer, 5 = facing
//   away, 3/7 = side views (the running profile we want for a side-scroller).
//   A single lump can encode TWO (frame,rotation) pairs when the second is a
//   horizontally-MIRRORED reuse (e.g. "TROOA2A8" = frame A rot 2, and frame A
//   rot 8 drawn flipped).
//
//   Actors GibRibbon uses (all in DOOM1.WAD shareware):
//     PLAY*  the green marine   (run / pain / death / firing-pistol)
//     TROO*  the imp            (walk / attack / death "shot to death")
//     POSS*  the zombie/former-human soldier (walk / death)

/** A decoded WAD directory entry. */
export interface WadLump {
  /** Upper-case lump name (NUL trimmed), e.g. "PLAYPAL", "TROOA1". */
  name: string;
  /** Byte offset of the lump data within the WAD buffer. */
  filepos: number;
  /** Lump data length in bytes. */
  size: number;
}

/** A fully-decoded sprite frame as straight RGBA8 (premultiplied-alpha-free:
 *  transparent texels are RGBA 0,0,0,0). Row-major, top-down (DOOM picture
 *  origin is top-left). */
export interface SpriteFrame {
  width: number;
  height: number;
  /** DOOM's leftoffset/topoffset — where the actor's "hot spot" (feet centre)
   *  sits relative to the bitmap. Used to align frames so the marine's feet
   *  stay planted on the ribbon as the run cycle swaps frames. */
  leftOffset: number;
  topOffset: number;
  /** width*height*4 RGBA8, top-down row-major. */
  rgba: Uint8Array;
}

/** A 256-entry RGB palette (PLAYPAL palette 0), flattened R,G,B,R,G,B,… */
export type Palette = Uint8Array; // length 256*3

const HEADER_SIZE = 12;
const DIRENT_SIZE = 16;
const POST_END = 0xff;

/** Read the NUL-padded 8-char lump name at `off`. */
function readLumpName(view: DataView, off: number): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const c = view.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.toUpperCase();
}

/**
 * Parse the WAD header + directory into a lump list. Throws on a malformed
 * header (truncated buffer / bad identification / directory out of range) so
 * the caller surfaces a clean "WAD corrupt" rather than reading garbage.
 */
export function parseWadDirectory(bytes: Uint8Array): WadLump[] {
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error('WAD too small for a header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ident = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (ident !== 'IWAD' && ident !== 'PWAD') {
    throw new Error(`bad WAD identification "${ident}"`);
  }
  const numLumps = view.getInt32(4, true);
  const infoTableOfs = view.getInt32(8, true);
  if (numLumps < 0 || infoTableOfs < 0) throw new Error('negative WAD header field');
  const dirEnd = infoTableOfs + numLumps * DIRENT_SIZE;
  if (dirEnd > bytes.byteLength) throw new Error('WAD directory out of range');

  const lumps: WadLump[] = [];
  for (let i = 0; i < numLumps; i++) {
    const base = infoTableOfs + i * DIRENT_SIZE;
    const filepos = view.getInt32(base, true);
    const size = view.getInt32(base + 4, true);
    const name = readLumpName(view, base + 8);
    lumps.push({ name, filepos, size });
  }
  return lumps;
}

/** Build a name → lump index map. When a name appears more than once (DOOM
 *  reuses markers + flat names) the LAST wins — matching DOOM's own
 *  W_GetNumForName "search from the end" precedence for IWAD-then-PWAD. */
export function indexLumps(lumps: WadLump[]): Map<string, number> {
  const idx = new Map<string, number>();
  for (let i = 0; i < lumps.length; i++) idx.set(lumps[i]!.name, i);
  return idx;
}

/**
 * Read the 256-colour RGB palette (PLAYPAL palette 0). Throws if PLAYPAL is
 * absent or too small. Returns a flat Uint8Array of length 768 (256×3).
 */
export function readPlaypal(bytes: Uint8Array, lumps: WadLump[]): Palette {
  const idx = indexLumps(lumps);
  const li = idx.get('PLAYPAL');
  if (li === undefined) throw new Error('PLAYPAL lump missing');
  const lump = lumps[li]!;
  if (lump.size < 768) throw new Error('PLAYPAL too small');
  // Palette 0 is the first 768 bytes of the lump.
  return bytes.subarray(lump.filepos, lump.filepos + 768);
}

/**
 * Decode a DOOM picture(patch) lump at the given byte offset into an RGBA
 * SpriteFrame using `palette`. Transparent texels (gaps between posts) are
 * left as RGBA 0,0,0,0. Defensive against truncated columns/posts (a bad
 * post just ends the column early) so a corrupt lump degrades to a partial
 * sprite rather than throwing mid-render.
 */
export function decodePicture(
  bytes: Uint8Array,
  filepos: number,
  size: number,
  palette: Palette,
): SpriteFrame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = filepos + size;
  if (filepos + 8 > end) throw new Error('picture header truncated');

  const width = view.getInt16(filepos, true);
  const height = view.getInt16(filepos + 2, true);
  const leftOffset = view.getInt16(filepos + 4, true);
  const topOffset = view.getInt16(filepos + 6, true);
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    throw new Error(`picture has implausible dimensions ${width}x${height}`);
  }

  const rgba = new Uint8Array(width * height * 4); // all-zero = fully transparent

  for (let col = 0; col < width; col++) {
    const colOfsAddr = filepos + 8 + col * 4;
    if (colOfsAddr + 4 > end) break;
    let postAddr = filepos + view.getInt32(colOfsAddr, true);

    // Walk the posts of this column until the 0xFF terminator (or we run off
    // the lump, defensively).
    // Guard against an infinite loop on a malformed lump with a hard cap.
    let guard = 0;
    while (postAddr + 1 <= end && guard++ < 4096) {
      const topdelta = view.getUint8(postAddr);
      if (topdelta === POST_END) break;
      const len = view.getUint8(postAddr + 1);
      // pixels start after topdelta(1)+length(1)+pad(1)
      const pixStart = postAddr + 3;
      if (pixStart + len > end) break;
      for (let row = 0; row < len; row++) {
        const y = topdelta + row;
        if (y < 0 || y >= height) continue;
        const palIdx = view.getUint8(pixStart + row);
        const dst = (y * width + col) * 4;
        rgba[dst] = palette[palIdx * 3]!;
        rgba[dst + 1] = palette[palIdx * 3 + 1]!;
        rgba[dst + 2] = palette[palIdx * 3 + 2]!;
        rgba[dst + 3] = 255;
      }
      // advance past topdelta(1)+length(1)+pad(1)+pixels(len)+pad(1)
      postAddr = pixStart + len + 1;
    }
  }

  return { width, height, leftOffset, topOffset, rgba };
}

/** Horizontally mirror a SpriteFrame (DOOM stores one side + a flip bit; we
 *  bake the flip so the renderer never has to). leftOffset mirrors to
 *  (width - 1 - leftOffset) so the hot spot stays correct after the flip. */
export function flipSpriteFrame(f: SpriteFrame): SpriteFrame {
  const { width, height, rgba } = f;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = (y * width + (width - 1 - x)) * 4;
      out[dst] = rgba[src]!;
      out[dst + 1] = rgba[src + 1]!;
      out[dst + 2] = rgba[src + 2]!;
      out[dst + 3] = rgba[src + 3]!;
    }
  }
  return {
    width,
    height,
    leftOffset: width - 1 - f.leftOffset,
    topOffset: f.topOffset,
    rgba: out,
  };
}

/**
 * Resolve a sprite frame by ACTOR + frame letter + rotation, decoding the
 * picture (and baking a horizontal flip when only the mirrored half exists).
 *
 * DOOM lump naming for a frame: `<actor><frame><rot>` (rot 0 = all-angles),
 * and a single lump may carry TWO (frame,rot) pairs as
 * `<actor><frameA><rotA><frameB><rotB>` where the SECOND pair is the mirror
 * of the first. We search in this precedence:
 *   1. exact `<actor><frame><rot>`
 *   2. exact `<actor><frame>0` (all-angles single frame)
 *   3. a 6-char dual lump whose FIRST pair matches → decode as-is
 *   4. a 6-char dual lump whose SECOND pair matches → decode + flip
 *
 * Returns null when no lump matches (so the caller can fall back to a
 * placeholder rather than crash).
 */
export function resolveSpriteFrame(
  bytes: Uint8Array,
  lumps: WadLump[],
  palette: Palette,
  actor: string,
  frame: string,
  rotation: number,
): SpriteFrame | null {
  const idx = indexLumps(lumps);
  const A = actor.toUpperCase();
  const F = frame.toUpperCase();
  const rot = String(rotation);

  const tryDecode = (name: string, flip: boolean): SpriteFrame | null => {
    const li = idx.get(name);
    if (li === undefined) return null;
    const lump = lumps[li]!;
    try {
      const f = decodePicture(bytes, lump.filepos, lump.size, palette);
      return flip ? flipSpriteFrame(f) : f;
    } catch {
      return null;
    }
  };

  // 1. exact <actor><frame><rot>
  let f = tryDecode(`${A}${F}${rot}`, false);
  if (f) return f;
  // 2. all-angles single
  f = tryDecode(`${A}${F}0`, false);
  if (f) return f;

  // 3/4. scan for a 6-char dual lump for this actor+frame.
  for (const lump of lumps) {
    const n = lump.name;
    if (n.length !== 8 && n.length !== 6) continue; // <name(4)><F><r><F><r> = 8 chars total
    // 8-char dual: ACTOR(4) + frameA(1)+rotA(1)+frameB(1)+rotB(1)
    if (n.length === 8 && n.slice(0, 4) === A) {
      const fA = n[4], rA = n[5], fB = n[6], rB = n[7];
      if (fA === F && rA === rot) return tryDecode(n, false);
      if (fB === F && rB === rot) return tryDecode(n, true);
    }
  }
  return null;
}

/** Names of the actor sprite roots GibRibbon pulls from DOOM1.WAD. */
export const GIB_ACTORS = {
  MARINE: 'PLAY',
  IMP: 'TROO',
  ZOMBIE: 'POSS',
} as const;

/**
 * Frame-letter sets per actor role. These are the well-known DOOM sprite
 * frame letters; we pick SIDE rotations (3 = facing left in screen terms,
 * resolveSpriteFrame falls back through flips/all-angles when a given
 * rotation isn't authored). Kept as a const map so the parent (Phase 2) can
 * re-tune which frames animate without touching the decoder.
 *
 *   marineRun:   PLAY A B C D  (the 4-step walk/run cycle)
 *   marineFire:  PLAY E F      (attack frames — the pistol/rifle fire pose)
 *   marinePain:  PLAY G        (flinch)
 *   marineDie:   PLAY H I J K L M N  (death → gib sequence)
 *   impWalk:     TROO A B C D
 *   impDie:      TROO H I J K L M  (the "shot to death" death sequence)
 *   zombieWalk:  POSS A B C D
 *   zombieDie:   POSS H I J K L M
 */
export const GIB_FRAMES = {
  marineRun: ['A', 'B', 'C', 'D'],
  marineFire: ['E', 'F'],
  marinePain: ['G'],
  marineDie: ['H', 'I', 'J', 'K', 'L', 'M', 'N'],
  impWalk: ['A', 'B', 'C', 'D'],
  impDie: ['H', 'I', 'J', 'K', 'L', 'M'],
  zombieWalk: ['A', 'B', 'C', 'D'],
  zombieDie: ['H', 'I', 'J', 'K', 'L', 'M'],
} as const;

/** A decoded animation = an ordered list of frames (may be shorter than the
 *  requested letters when the WAD doesn't author them all). */
export type SpriteAnimation = SpriteFrame[];

/** The full decoded sprite set GibRibbon needs for one game. Any animation may
 *  be empty if the WAD lacks those lumps (the renderer then falls back to a
 *  line-art placeholder so the game still plays). */
export interface GibSprites {
  marineRun: SpriteAnimation;
  marineFire: SpriteAnimation;
  marinePain: SpriteAnimation;
  marineDie: SpriteAnimation;
  impWalk: SpriteAnimation;
  impDie: SpriteAnimation;
  zombieWalk: SpriteAnimation;
  zombieDie: SpriteAnimation;
}

/** Default view rotation for the side-scroller. 3 = the actor's left-side
 *  profile in DOOM's angle convention; resolveSpriteFrame falls back through
 *  the all-angles / mirrored lumps when an actor doesn't author rotation 3. */
const SIDE_ROTATION = 3;

function decodeAnimation(
  bytes: Uint8Array,
  lumps: WadLump[],
  palette: Palette,
  actor: string,
  frames: readonly string[],
  rotation = SIDE_ROTATION,
): SpriteAnimation {
  const out: SpriteAnimation = [];
  for (const fr of frames) {
    const f = resolveSpriteFrame(bytes, lumps, palette, actor, fr, rotation);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Top-level entry: parse DOOM1.WAD bytes → the full GibRibbon sprite set.
 * Pure (no GL / fetch). Throws only on a structurally-broken WAD (bad header /
 * missing PLAYPAL); a merely-incomplete WAD yields empty animations the
 * renderer tolerates.
 */
export function extractGibSprites(bytes: Uint8Array): GibSprites {
  const lumps = parseWadDirectory(bytes);
  const palette = readPlaypal(bytes, lumps);
  const { MARINE, IMP, ZOMBIE } = GIB_ACTORS;
  // SIDE_ROTATION (3) is the actor's LEFT-facing profile in screen terms. The
  // enemies (imp/zombie) ride IN from the right edge toward the marine, so a
  // left-facing profile already points them in their direction of travel — keep
  // them as-is. The MARINE, however, RUNS to the RIGHT (toward the upcoming
  // obstacles/markers), so its left-facing profile reads backwards. Flip every
  // marine animation horizontally (run cycle + fire/pain/death) so the runner
  // faces FORWARD in its direction of travel. Pure flip via flipSpriteFrame.
  const flipAll = (anim: SpriteAnimation): SpriteAnimation => anim.map(flipSpriteFrame);
  return {
    marineRun: flipAll(decodeAnimation(bytes, lumps, palette, MARINE, GIB_FRAMES.marineRun)),
    marineFire: flipAll(decodeAnimation(bytes, lumps, palette, MARINE, GIB_FRAMES.marineFire)),
    marinePain: flipAll(decodeAnimation(bytes, lumps, palette, MARINE, GIB_FRAMES.marinePain)),
    marineDie: flipAll(decodeAnimation(bytes, lumps, palette, MARINE, GIB_FRAMES.marineDie)),
    impWalk: decodeAnimation(bytes, lumps, palette, IMP, GIB_FRAMES.impWalk),
    impDie: decodeAnimation(bytes, lumps, palette, IMP, GIB_FRAMES.impDie),
    zombieWalk: decodeAnimation(bytes, lumps, palette, ZOMBIE, GIB_FRAMES.zombieWalk),
    zombieDie: decodeAnimation(bytes, lumps, palette, ZOMBIE, GIB_FRAMES.zombieDie),
  };
}
