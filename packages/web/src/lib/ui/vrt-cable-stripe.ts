// packages/web/src/lib/ui/vrt-cable-stripe.ts
//
// The CABLE-STRIPE PALETTE CHECKER — the pure half of the gate in
// vrt-cable-stripe.test.ts.
//
// WHY THIS EXISTS (the hole it closes, measured 2026-08-01)
// --------------------------------------------------------
// Every module card paints a 2px `.stripe` across its top whose colour is a
// `--cable-*` design token (`_module-card.css`: `.mod-card .stripe`). #1159
// (2026-07-22) recoloured the whole cable language and re-pinned only a
// handful of VRT baselines. The rest kept the PREVIOUS generation's hue —
// `linux/adsr.png` still paints a salmon `#f87171` where `--cable-gate` is
// now amber `#f2c14e` — and NOTHING went red, on either platform, for weeks.
//
// It is invisible to the VRT gate ITSELF by arithmetic, not by accident:
//   * the stripe is 2 rows of a ~527-row card ⇒ ~0.38 % of the pixels,
//   * `maxDiffPixelRatio` is 0.01 (1 %), even after the 2026-07-31 tightening,
//   * so `toHaveScreenshot` PASSES, and because Playwright only rewrites a
//     snapshot when the comparison FAILS, `--update-snapshots` also refuses
//     to fix it. Invisible AND unfixable — the A2/#1213 pathology, live in
//     the REQUIRED lane.
//
// So the check cannot be a screenshot comparison. It reads the COMMITTED PNG
// BYTES and asserts the stripe equals the CURRENT token — a different
// instrument, sensitive to exactly the dimension `toHaveScreenshot` averages
// away.
//
// INSTRUMENT DISCIPLINE (see CLAUDE.md "VALIDATE THE INSTRUMENT")
//   * The stripe row is located by SATURATION — the most chromatic uniform
//     band in the card's top rows. The locator never looks at the EXPECTED
//     colour, so a stale stripe cannot make it quietly re-aim at some other
//     row and report a match.
//   * PNG decoding is done here, with zlib only. `pngjs` is present in the
//     tree solely as a TRANSITIVE dependency of `pixelmatch`; depending on it
//     would make the gate's ability to run a property of someone else's
//     dependency graph.
//   * The test negative-controls it: perturb a token and the report must go
//     red. A checker that cannot fail is decoration.

import { inflateSync } from 'node:zlib';

/** One decoded baseline row sample. */
export interface StripeBand {
  /** Row index (top of the PNG) the band was found on. */
  y: number;
  /** `#rrggbb` of the row's modal colour. */
  hex: string;
  /** max(r,g,b) − min(r,g,b) of that colour — how the row was chosen. */
  saturation: number;
  /** Fraction of the row's pixels that ARE the modal colour. */
  uniformity: number;
}

/** Minimal PNG reader: 8-bit, non-interlaced, colour type 0/2/4/6. */
export function decodePngTopRows(
  bytes: Uint8Array,
  maxRows: number,
): { width: number; height: number; rows: Uint8Array[] } {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new Error('not a PNG (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      bitDepth = bytes[off + 16];
      colorType = bytes[off + 17];
      if (bytes[off + 20] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType as 0 | 2 | 4 | 6];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  const stride = width * channels;
  const want = Math.min(maxRows, height);
  const rows: Uint8Array[] = [];
  let prev = new Uint8Array(stride);
  for (let y = 0; y < want; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const x = src[i];
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
    rows.push(cur);
    prev = cur;
  }
  return { width, height, rows: rows.map((r) => toRgb(r, channels, width)) };
}

function toRgb(row: Uint8Array, channels: number, width: number): Uint8Array {
  if (channels === 3) return row;
  const out = new Uint8Array(width * 3);
  for (let x = 0; x < width; x++) {
    if (channels === 1 || channels === 2) {
      const g = row[x * channels];
      out[x * 3] = g; out[x * 3 + 1] = g; out[x * 3 + 2] = g;
    } else {
      out[x * 3] = row[x * 4];
      out[x * 3 + 1] = row[x * 4 + 1];
      out[x * 3 + 2] = row[x * 4 + 2];
    }
  }
  return out;
}

/** How far down the card the stripe can sit before we stop looking. */
export const STRIPE_SCAN_ROWS = 12;
/** A row must be this uniform to count as a band (sub-pixel AA blurs edges). */
export const STRIPE_MIN_UNIFORMITY = 0.5;

/**
 * Find the card's colour stripe in a baseline PNG.
 *
 * The band is picked by SATURATION, never by proximity to an expected hue:
 * the card chrome (border `#2c3037`, panel `#1c1f24`, page `#121212`) is
 * near-grey at saturation ≤ 16, and every cable token is ≥ 100, so the stripe
 * separates from the chrome by an order of magnitude with no knowledge of
 * which cable it is supposed to be.
 */
export function findStripeBand(pngBytes: Uint8Array): StripeBand | null {
  const { width, rows } = decodePngTopRows(pngBytes, STRIPE_SCAN_ROWS);
  let best: StripeBand | null = null;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    const counts = new Map<number, number>();
    for (let x = 0; x < width; x++) {
      const key = (row[x * 3] << 16) | (row[x * 3 + 1] << 8) | row[x * 3 + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let modal = 0;
    let n = 0;
    for (const [k, c] of counts) if (c > n) { n = c; modal = k; }
    const uniformity = n / width;
    if (uniformity < STRIPE_MIN_UNIFORMITY) continue;
    const r = (modal >> 16) & 0xff;
    const g = (modal >> 8) & 0xff;
    const b = modal & 0xff;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    if (!best || saturation > best.saturation) {
      best = { y, saturation, uniformity, hex: rgbToHex(r, g, b) };
    }
  }
  return best;
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ── source-side half: which token is a card's stripe pinned to? ─────────────

export type StripeSource =
  | { kind: 'token'; token: string; via: 'inline' | 'scoped-css' | 'vcard-default' }
  | { kind: 'not-token-pinned'; reason: string };

/**
 * Read a card component's source and report the `--cable-*` token its `.stripe`
 * is pinned to, if any.
 *
 * Deliberately SOURCE-level, for the reason CLAUDE.md gives for the
 * `controlFamilies`→card-testid grep: no runtime gate sees a card, so the only
 * place this contract can be held is the text of the card itself.
 */
export function stripeSourceToken(cardSource: string): StripeSource {
  const inlineCable = cardSource.match(
    /class="stripe"[^>]*style="[^"]*background:\s*var\((--cable-[A-Za-z-]+)/,
  );
  if (inlineCable) return { kind: 'token', token: inlineCable[1], via: 'inline' };

  if (/class="stripe"[^>]*style="[^"]*background:\s*\{/.test(cardSource)) {
    return { kind: 'not-token-pinned', reason: 'inline background is a dynamic {expression}' };
  }
  const inlineOther = cardSource.match(
    /class="stripe"[^>]*style="[^"]*background:\s*(var\(--[A-Za-z-]+|#[0-9a-fA-F]{3,8})/,
  );
  if (inlineOther) {
    return { kind: 'not-token-pinned', reason: `inline background is ${inlineOther[1]}` };
  }
  if (!/class="stripe"/.test(cardSource)) {
    return { kind: 'not-token-pinned', reason: 'card renders no .stripe element' };
  }
  for (const rule of cardSource.matchAll(/([^{}]*\.stripe[^{}]*)\{([^}]*)\}/g)) {
    const body = rule[2];
    const cable = body.match(/background(?:-color)?:\s*var\((--cable-[A-Za-z-]+)/);
    if (cable) return { kind: 'token', token: cable[1], via: 'scoped-css' };
    const other = body.match(/background(?:-color)?:\s*([^;]+)/);
    if (other) {
      return { kind: 'not-token-pinned', reason: `scoped .stripe background is ${other[1].trim().slice(0, 48)}` };
    }
  }
  // No scoped rule paints it: the global `.vcard .stripe` in _module-card.css
  // supplies `background: var(--cable-video)` for every video card.
  if (/class="[^"]*\bvcard\b/.test(cardSource)) {
    return { kind: 'token', token: '--cable-video', via: 'vcard-default' };
  }
  return { kind: 'not-token-pinned', reason: 'no .stripe background found in card or globals' };
}

/** Convention shared with modules-card-map.ts: module type → card basename. */
export function conventionalCardBasename(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1) + 'Card';
}
