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
//   * The test negative-controls it AT THE PIXEL LEVEL: it repaints a real
//     baseline's stripe row, re-encodes the PNG, feeds those BYTES back through
//     the same `measure()` path and requires exactly that baseline to go red.
//     Perturbing the TOKEN TABLE instead would be a tautology — with the
//     baselines clean by precondition, "expected moves ⇒ verdict moves" is
//     arithmetic that a stub returning `CABLE_VARS[token]` (an instrument that
//     never reads a pixel) satisfies just as well. Only a PIXEL perturbation
//     can distinguish the two. See `encodePngRgb` below, which exists solely so
//     the control can synthesise the perturbed bytes.

import { deflateSync, inflateSync } from 'node:zlib';

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
  /** `#rrggbb` of the modal colour of the row immediately BELOW the band —
   *  the card body the stripe is composited over. Needed because a stripe
   *  that lands off the device-pixel grid paints a PARTIAL-COVERAGE blend of
   *  its token over this colour rather than the token itself; see
   *  `stripeMatchesToken`. `null` when the band is the last scanned row. */
  bgHex: string | null;
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
  /** Modal colour of one row, or null when the row is below the scan window. */
  const modalOf = (y: number): { hex: string; saturation: number; uniformity: number } | null => {
    const row = rows[y];
    if (!row) return null;
    const counts = new Map<number, number>();
    for (let x = 0; x < width; x++) {
      const key = (row[x * 3] << 16) | (row[x * 3 + 1] << 8) | row[x * 3 + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let modal = 0;
    let n = 0;
    for (const [k, c] of counts) if (c > n) { n = c; modal = k; }
    const r = (modal >> 16) & 0xff;
    const g = (modal >> 8) & 0xff;
    const b = modal & 0xff;
    return {
      hex: rgbToHex(r, g, b),
      saturation: Math.max(r, g, b) - Math.min(r, g, b),
      uniformity: n / width,
    };
  };

  let best: StripeBand | null = null;
  for (let y = 0; y < rows.length; y++) {
    const m = modalOf(y);
    if (!m || m.uniformity < STRIPE_MIN_UNIFORMITY) continue;
    if (!best || m.saturation > best.saturation) {
      best = {
        y,
        saturation: m.saturation,
        uniformity: m.uniformity,
        hex: m.hex,
        bgHex: modalOf(y + 1)?.hex ?? null,
      };
    }
  }
  return best;
}

/** Largest per-channel disagreement in recovered coverage that still counts as
 *  ONE alpha. Both bounds are MEASURED across the full matrix, not chosen:
 *    - ACCEPT side: all 8 real blends spread **0.0097** (they solve to
 *      0.745 / 0.739 / 0.749 — 8-bit quantisation of one alpha, not 3 colours);
 *    - REJECT side: the TIGHTEST retired-vs-current pair in the whole matrix is
 *      `#f472b6` (pre-#1159 video) read as `--cable-polyPitchGate` (`#ff7bc2`),
 *      spreading **0.0494**. Two palette generations can be nearly collinear
 *      from the card body, so this margin is much smaller than it looks.
 *  0.02 sits 2.1× above the noise and 2.5× below the nearest thing it must
 *  reject. */
export const STRIPE_ALPHA_SPREAD = 0.02;
/** A row covered less than this by the stripe is not "the stripe row".
 *  `findStripeBand` picks the most-SATURATED row and coverage is monotone in
 *  saturation, so the picked row is the most-covered one; this floor rejects
 *  the faint shoulder above/below it (measured 0.52 on the quadralogical
 *  scenes, vs 0.744 for the row actually chosen). */
export const STRIPE_MIN_COVERAGE = 0.6;
/**
 * A SECOND, INDEPENDENT axis, because collinearity alone is a thin defence.
 *
 * A near-collinear retired hue does not read as a *dimmed* token — it reads as
 * an ALMOST-COMPLETE cover: `#f472b6` posing as `--cable-polyPitchGate`
 * recovers α = 0.952/0.902/0.924. Genuine partial coverage sits well clear of
 * 1 (measured 0.739–0.749 on every affected scene). So the band 0.95 < α ≤ 1 is
 * the zone where "slightly wrong hue" and "very nearly fully covered" are not
 * distinguishable, and we refuse it.
 *
 * The cost is deliberate and safe-side: a stripe that really is 96–99 % covered
 * fails instead of passing. That is a loud, investigable failure, which is the
 * right direction for a drift gate. The tightest retired pair is now rejected
 * TWICE over — spread 0.0494 > 0.02 AND α 0.952 > 0.95 — so neither axis is
 * load-bearing alone.
 */
export const STRIPE_MAX_COVERAGE = 0.95;

/**
 * Does a stripe row PAINT `token`, allowing for partial pixel coverage?
 *
 * WHY THIS IS NOT A RELAXATION. The gate's original test was `got === token`,
 * which silently assumes the stripe rasterises to at least one FULLY covered
 * row. That is a property of the layout, not of the palette: a ~1px stripe
 * lands on the device-pixel grid at one zoom and straddles two rows at another,
 * and then NO row is the pure token. Measured on this repo when the topbar lost
 * a row and xyflow's fitView zoom went 1.4611 → 1.5500: eight
 * `vrt-quadralogical` baselines went from `#b57bff` at y=2 to `#8e63c8` at y=2,
 * with `#6b4f95` above it — the SAME hue at ~74% and ~30% coverage. Those
 * baselines are correct (a from-scratch recapture reproduces them byte for
 * byte, so regeneration cannot "fix" them); the exact-match premise is what
 * was wrong.
 *
 * The relaxation is DIRECTIONAL, not a tolerance ball, so it cannot admit the
 * drift this gate exists to catch. A partially-covered stripe lies on the
 * straight line from the card body to the token: `got = α·token + (1−α)·bg`.
 * We recover α per channel and require all three to agree. A DIFFERENT hue is
 * not on that line — the retired `--cable-video` (`#f472b6`) over the card body
 * `#1c1f24` recovers α = 1.41/0.90/0.67, a spread of 0.74, ~15× the tolerance.
 * A stale palette generation still fails, which is the whole point.
 */
export function stripeMatchesToken(
  gotHex: string,
  bgHex: string | null,
  tokenHex: string,
): boolean {
  if (gotHex === tokenHex) return true;
  if (!bgHex) return false;
  const got = hexToRgb(gotHex);
  const bg = hexToRgb(bgHex);
  const token = hexToRgb(tokenHex);

  const alphas: number[] = [];
  for (let i = 0; i < 3; i++) {
    const span = token[i] - bg[i];
    // A channel where the token and the body agree carries no information
    // about coverage (any α reproduces it) — skip rather than divide by ~0.
    if (Math.abs(span) < 8) continue;
    alphas.push((got[i] - bg[i]) / span);
  }
  // Need at least two informative channels: one is a line through a point and
  // would accept any colour that happens to match on that single channel.
  if (alphas.length < 2) return false;
  const lo = Math.min(...alphas);
  const hi = Math.max(...alphas);
  // Axis 1 — is it ONE alpha? (collinear with the body→token ray)
  if (hi - lo > STRIPE_ALPHA_SPREAD) return false;
  // Axis 2 — is it unambiguously PARTIAL? (see STRIPE_MAX_COVERAGE)
  return lo >= STRIPE_MIN_COVERAGE && hi <= STRIPE_MAX_COVERAGE;
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`hexToRgb: not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ── PNG ENCODER — exists ONLY for the pixel-side negative control ───────────
//
// The control has to hand `findStripeBand` bytes whose stripe row is a colour
// we chose, so that a blind instrument (one that reports the EXPECTED hue
// instead of the painted one) is forced to disagree with reality. Round-tripping
// through a real PNG keeps the control on the SAME code path as the gate —
// decode, locate, compare — rather than on a shortcut the gate never takes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode 8-bit RGB rows (`width * 3` bytes each) as a non-interlaced PNG. */
export function encodePngRgb(width: number, rows: Uint8Array[]): Uint8Array {
  const stride = width * 3;
  const raw = Buffer.alloc(rows.length * (stride + 1));
  rows.forEach((row, y) => {
    if (row.length !== stride) throw new Error(`row ${y} is ${row.length} bytes, expected ${stride}`);
    raw[y * (stride + 1)] = 0; // filter: None
    Buffer.from(row).copy(raw, y * (stride + 1) + 1);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', new Uint8Array(deflateSync(raw))),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}

/**
 * Return a copy of `pngBytes` whose row `y` is painted a flat `hex`.
 *
 * Only the top `STRIPE_SCAN_ROWS` rows survive — that is the whole window
 * `findStripeBand` looks at, so the re-encoded image is equivalent for the
 * gate's purposes and the control stays cheap.
 */
export function repaintStripeRow(pngBytes: Uint8Array, y: number, hex: string): Uint8Array {
  const { width, rows } = decodePngTopRows(pngBytes, STRIPE_SCAN_ROWS);
  if (y >= rows.length) throw new Error(`row ${y} is outside the ${rows.length}-row scan window`);
  const [r, g, b] = hexToRgb(hex);
  const painted = new Uint8Array(width * 3);
  for (let x = 0; x < width; x++) {
    painted[x * 3] = r;
    painted[x * 3 + 1] = g;
    painted[x * 3 + 2] = b;
  }
  const out = rows.map((row, i) => (i === y ? painted : row));
  return encodePngRgb(width, out);
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

// ── WHICH BASELINE DIRECTORIES THIS GATE CAN READ ──────────────────────────
//
// `e2e/vrt/__screenshots__/<spec>/<platform>/<scene>.png`. Only a spec that
// captures ONE module card (`page.locator('.svelte-flow__node-<type>')`) has a
// card stripe in its top rows; a page-level or composite capture starts with
// the canvas background and a multi-card frame, so the saturation locator has
// no defined answer there.
//
// The first cut of this gate read `vrt.spec.ts` ONLY and called that "the VRT
// baselines" — 191 of 409 committed PNGs, with 18 provably-stale ones sitting
// one directory away in `vrt-clap` / `vrt-karplus-tomtom-states`, invisible.
// A scope limit that nothing states is indistinguishable from full coverage.
// So the scope is now DECLARED, per directory, with a reason — and
// `vrt-cable-stripe.test.ts` fails if a directory appears under
// `__screenshots__` that is in neither table. A new spec forces a decision.

// ── THE SECOND HOLE: AN EXCLUSION NOTHING VALIDATED (measured 2026-08-02) ───
//
// Declaring the scope fixed "a scope limit that nothing states". It did NOT fix
// a scope limit that nothing CHECKS. `NON_CARD_CAPTURE_DIRS` was 21 one-line
// prose claims, and the gate's two instrument controls could not reach a single
// one of them:
//
//   * the spec-agreement test iterates `Object.entries(CARD_CAPTURE_DIRS)` — it
//     validates the INCLUSIONS only;
//   * the pixel negative control re-measures rows `measure()` already returned,
//     and `measure()` does `if (!sceneType) continue` for every excluded dir, so
//     those PNGs are unreachable by the control BY CONSTRUCTION.
//
// So the one scan neither control covered was THE SCAN THAT NEVER HAPPENS. Two
// of the 21 claims were false, and reading their committed pixels proves it:
//
//   * `vrt-aspect-16x9.spec.ts` — declared "canvas-region capture, card chrome
//     cropped out". The spec screenshots
//     `page.locator('.svelte-flow__node-' + sinkCardClass)` — it is a
//     SINGLE-CARD capture of `videoOut`, the exact thing CARD_CAPTURE_DIRS is
//     for. Its band reads `#b57bff` = the CURRENT `--cable-video`.
//   * `vrt-toybox.spec.ts` — declared "captures [data-testid=toybox-canvas],
//     not the card". True about the locator, false about the pixels: the canvas
//     wrapper is `border: 1px solid var(--cable-video)`, so row 0 of every
//     capture is a cable token. 27 baselines split cleanly in two —
//     11 `#b57bff` (current) and 16 `#f472b6` (the pre-#1159 video hue), all at
//     99 % row uniformity. Bimodal on exactly two cable hues is not noise.
//
// INSTRUMENT VALIDATION, because a wrong metric reads exactly like a finding:
// the pixel decode and the CSS are INDEPENDENT instruments and they agree — the
// hue says `--cable-video`, and the stylesheet says `var(--cable-video)` is
// painted on the captured element's frame. The spec's own locator settles
// aspect-16x9 without reference to any pixel.
//
// Those 16 rotted unseen because `vrt-toybox` is blanket-`test.skip`-ed on
// linux and CI renders on linux — nothing has compared them on any CI run.
//
// FIX: exclusions are now VALIDATED like inclusions. A directory the gate
// refuses to read must be shown to carry no cable-token band in the scan
// window (`vrt-cable-stripe.test.ts`, "every NON_CARD_CAPTURE_DIRS claim is
// TRUE"), so a false exclusion is RED instead of silent.

/** Spec dir → scene stem → module type. Every entry is a single-card capture. */
export const CARD_CAPTURE_DIRS: Record<string, (stem: string) => string> = {
  // scene id IS the module type — the registry-driven per-card sweep.
  'vrt.spec.ts': (stem) => stem,
  'vrt-clap.spec.ts': () => 'clap',
  // `.svelte-flow__node-${scene.moduleType}`; stems are `karplus-*` / `tomtom-*`.
  'vrt-karplus-tomtom-states.spec.ts': (stem) => stem.split('-')[0],
  'vrt-posterbox-states.spec.ts': () => 'posterbox',
  'vrt-quadralogical.spec.ts': () => 'quadralogical',
  'vrt-colourofmagic.spec.ts': () => 'colourofmagic',
  'vrt-tidy-vco.spec.ts': () => 'tidyVco',
  'vrt-scope-modes.spec.ts': () => 'scope',
  // `<type>-step-<n>.png` for polyseqz / sequencer / drumseqz.
  'playhead.spec.ts': (stem) => stem.replace(/-step-\d+$/, ''),
  // Captures `.svelte-flow__node-${sinkCardClass}` — a single `videoOut` card.
  // Was declared NON-card until 2026-08-02; see the writeup above.
  'vrt-aspect-16x9.spec.ts': () => 'videoOut',
  // Captures `.svelte-flow__node-synesthesia`. Also mis-declared until
  // 2026-08-02 ("video-surface capture") — it screenshots the CARD, and its
  // baseline still paints the pre-#1159 `--cable-audio`.
  'vrt-synesthesia-video.spec.ts': () => 'synesthesia',
};

// ── THE THIRD HOLE: "CURRENT" IS DEFINED TWICE (measured 2026-08-02) ────────
//
// This gate's entire claim is that a baseline paints the CURRENT value of its
// `--cable-*` token. It resolves CURRENT from `CABLE_VARS`
// (`ui/skins/palettes/_cables.ts`). But the same nine tokens are ALSO declared
// in `styles/tokens.css`, as the pre-JS `:root` seed — and NOTHING in the repo
// compares the two. Verified by grep: no test reads `tokens.css` at all; the
// two "seed mirrors this" tests (`skin-store`, `module-shell-model`) re-type
// their expected values as literals rather than parsing the stylesheet.
//
// MEASURED, the same way the other two holes were: editing `tokens.css` to
// `--cable-video: #00ff00` — a pure-green cable, as loud a change as exists —
// left this suite 11/11 GREEN. Editing `_cables.ts` by a SINGLE LSB
// (`#b57bff` → `#b57bfe`) reddens 46 baselines. So the gate is perfectly sharp
// on one definition of CURRENT and perfectly blind to the other.
//
// Why that is a real fail-open and not bookkeeping: the palette engine writes
// `CABLE_VARS` inline on `documentElement` (`applyPaletteToRoot`), which wins
// over `:root`, so post-boot pixels — and therefore every VRT capture — follow
// `_cables.ts`. A palette change applied ONLY to `tokens.css` (the file whose
// name makes it the obvious place to look) changes the pre-JS paint, changes
// nothing this gate measures, and is invisible to VRT itself for the same
// sub-`maxDiffPixelRatio` reason the stripe always was. Three green gates, one
// wrong colour — the exact shape of the two holes above.
//
// FIX: `parseCssCableTokens` + the "tokens.css and CABLE_VARS agree" assertion
// reconcile the two declarations by NAME and VALUE, so CURRENT has one meaning.

/** `--cable-*: #rrggbb;` declarations parsed out of a CSS source, lowercased.
 *  Used to reconcile the pre-JS `:root` seed in `styles/tokens.css` with
 *  `CABLE_VARS`, the palette-engine values this gate measures baselines
 *  against. Deliberately a dumb declaration scraper: it must see what the
 *  browser's cascade would see, not what a hand-maintained mirror claims. */
export function parseCssCableTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--cable-[A-Za-z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*(?:;|})/g;
  for (let m = re.exec(css); m; m = re.exec(css)) out[m[1]!] = m[2]!.toLowerCase();
  return out;
}

/**
 * Every hue the `--cable-*` language has worn. Used ONLY to falsify an
 * exclusion: a directory this gate refuses to read must not be painting a
 * cable colour in its scan window.
 *
 * BOTH generations, because the stale case is the one that matters —
 * `vrt-synesthesia-video` was excluded while painting `#fbbf24`, and matching
 * only the CURRENT palette would have called that directory clean.
 *
 * A SATURATION THRESHOLD CANNOT DO THIS JOB — measured, not assumed. Excluded
 * dirs legitimately reach saturation 255: `groups` paints `#00f0ff`
 * (`--accent`) and `vrt-wavesculpt-blink` `#ff00ff` (Playwright's `maskColor`).
 * Any threshold separating those from a cable band does not exist. Hue
 * identity does, with zero false positives on all 21 excluded directories.
 *
 * ⚠ A future palette generation appends its predecessor's hues here, the same
 * way `PENDING_PALETTE_REGEN` is drained. Forgetting weakens this validator
 * only — never the main assertion.
 */
export const CABLE_HUES_ALL_GENERATIONS: Record<string, string> = {
  // pre-#1159, retired 2026-07-22
  '#fbbf24': 'pre-#1159 audio', '#f472b6': 'pre-#1159 video', '#f87171': 'pre-#1159 gate',
  '#34d399': 'pre-#1159 cv', '#60a5fa': 'pre-#1159 pitch', '#a78bfa': 'pre-#1159 poly',
  '#c084fc': 'pre-#1159 mono-video',
};

/**
 * Spec dir → a `--cable-*` token painted on the captured element's FRAME.
 *
 * Not a card capture, but not stripe-less either: the screenshot target sits
 * inside chrome that a cable token colours, so the top row IS a cable token and
 * rots exactly like a card stripe. `evidence` is the source-side proof, checked
 * against the card component so the table is a verified claim rather than more
 * prose (the failure mode the whole 2026-08-02 writeup above is about).
 */
export const CABLE_EDGE_DIRS: Record<
  string,
  { type: string; token: string; evidence: RegExp }
> = {
  'vrt-toybox.spec.ts': {
    type: 'toybox',
    token: '--cable-video',
    evidence: /border:\s*1px\s+solid\s+var\(--cable-video\)/,
  },
};

/** Spec dir → why its baselines have no cable-coloured band to read.
 *  ⚠ Every claim here is ASSERTED against the committed pixels — see
 *  "every NON_CARD_CAPTURE_DIRS claim is TRUE". Adding an entry does not
 *  make it true. */
export const NON_CARD_CAPTURE_DIRS: Record<string, string> = {
  'cellshade-composite.spec.ts': 'full-page composite (multiple cards)',
  'cube-adsr-composite.spec.ts': 'full-page composite (multiple cards)',
  'dashboard.spec.ts': 'page chrome, no module card',
  'groups.spec.ts': 'group frame, stripe is var(--accent) not a cable token',
  'interactions.spec.ts': 'menus/palettes, no module card',
  'landing.spec.ts': 'marketing page',
  // NEW DIRECTORY, and it appeared because the platform collapse gave these
  // three scenes their FIRST baseline on any platform: mirrorpool-mirror,
  // -refract and -storm existed on neither darwin nor linux before the
  // single-baseline capture. So this entry is not bookkeeping for a rename —
  // it is classifying genuinely new coverage. Same shape as its six sibling
  // `*-composite` dirs: `spawnPatch` builds a multi-node patch and the assert
  // is `expect(page).toHaveScreenshot(…)`, i.e. the VIEWPORT, so there is no
  // single card stripe band for this gate to sample. (Cables ARE in frame —
  // the scene spawns edges — but this bucket is about the absence of a card
  // BAND to measure, not the absence of cables.)
  'mirrorpool-composite.spec.ts': 'full-page composite (multiple cards)',
  'pentemelodica-composite.spec.ts': 'full-page composite (multiple cards)',
  'topbar.spec.ts': 'page chrome, no module card',
  'vrt-composite-coverage.spec.ts': 'full-page composite (multiple cards)',
  'vrt-composite.spec.ts': 'full-page composite (multiple cards)',
  'vrt-synesthesia-composite.spec.ts': 'full-page composite (multiple cards)',
  'vrt-wavesculpt-blink.spec.ts': 'wavesculpt .stripe is a 3-hex gradient, not a cable token',
  'vrt-wavesculpt-walls.spec.ts': 'wavesculpt .stripe is a 3-hex gradient, not a cable token',
  'workflow-audio-io-composite.spec.ts': 'workflow shell, not a module card',
  'workflow-dock-composite.spec.ts': 'workflow shell, not a module card',
  'workflow-rear-card.spec.ts': 'rear/patch face, no front stripe',
  'workflow-shell-faces.spec.ts': 'workflow shell faces, not a module card',
  'workflow-shell-zoom.spec.ts': 'workflow shell, not a module card',
};
