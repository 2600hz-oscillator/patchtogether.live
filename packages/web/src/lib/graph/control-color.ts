// packages/web/src/lib/graph/control-color.ts
//
// CONTROL COLOR — the pure resolver that answers "what colour is this module's
// control?". It is the SINGLE SOURCE OF TRUTH read LIVE everywhere a control is
// proxied: the Control Surface stripe, the ElectraControl stripe, and the
// generated Electra One preset. None of those surfaces STORE the colour — they
// each call resolveControlColor(sourceNode) at render / generate time, exactly
// the way they already read the source param's live VALUE. This is the whole
// "passthrough, not a copy" principle: the colour identifies the SOURCE, so the
// same control shows the same colour everywhere it appears, and there is no
// per-binding/per-surface copy that can drift.
//
//   - Storage (source module only): node.data.controlColor?: string — a 6-digit
//     UPPERCASE hex (e.g. 'F45C51'), matching the Electra preset colour format.
//   - When unset, defaultColorFor() derives a stable, distinct colour from the
//     node id (per INSTANCE) so a control is auto colour-coded by source the
//     moment it lands on a surface; "Assign control color" just overrides it.
//
// All three functions are PURE (no Yjs, no DOM) so they're snapshot-unit-
// testable and safe to call inside a Svelte $derived / the pure preset
// generator.

/** The minimal node shape the resolver needs — just an id + optional data. */
interface ColorSourceNode {
  id: string;
  data?: Record<string, unknown>;
}

/**
 * The resolved control colour for a source module, as a 6-digit UPPERCASE hex
 * (no `#`). Returns the user-assigned `data.controlColor` if set, else the
 * stable auto-default derived from the node id.
 *
 * @param node    the SOURCE module node (the module whose control is proxied).
 * @param paramId OPTIONAL — reserved for the future per-knob override layer.
 *   v1 is per-MODULE only, so this is currently unused, but the resolver takes
 *   it NOW so the override layer drops in with no call-site refactor. The
 *   future layer will read `node.data.controlColors?.[paramId]` FIRST, then fall
 *   back to the per-module colour below. (See plan Decision C.)
 */
export function resolveControlColor(
  node: ColorSourceNode | undefined,
  // TODO(per-knob-override): when v2 lands, read
  //   node.data.controlColors?.[paramId]
  // before the per-module color. Kept in the signature now so no call-site
  // changes when the override layer is added.
  paramId?: string,
): string {
  void paramId; // reserved (see TODO above)
  if (!node) return DEFAULT_FALLBACK;
  const assigned = node.data?.controlColor;
  if (typeof assigned === 'string') {
    const norm = normalizeHex(assigned);
    if (norm) return norm;
  }
  return defaultColorFor(node);
}

/**
 * The stable, distinct AUTO default colour for a source module (per INSTANCE,
 * so two of the same module TYPE are still distinguishable). Deterministic: the
 * same node id always yields the same colour. Derived by hashing the id → a hue
 * spread around the wheel, then snapped to a fixed mid saturation/lightness so
 * the result is RGB565-legible — never near-white, near-black, or muddy. (See
 * plan Decision A.)
 */
export function defaultColorFor(node: ColorSourceNode | undefined): string {
  const id = node?.id ?? '';
  // 32-bit FNV-1a hash of the id — cheap, deterministic, well-distributed.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const u = h >>> 0;

  // Hue: spread the full 0..360 wheel. A second hash byte nudges saturation +
  // lightness within a SAFE band (kept clear of near-white / near-black /
  // washed-out) so every auto colour is a readable, saturated mid-tone.
  const hue = u % 360;
  const sat = 0.62 + ((u >>> 9) % 18) / 100; // 0.62..0.79
  const light = 0.50 + ((u >>> 17) % 12) / 100; // 0.50..0.61
  const hex = hslToHex(hue, sat, light);
  // Round-trip through RGB565 so the on-screen swatch matches the hardware.
  return quantizeToRgb565(hex);
}

/**
 * Round-trip a 24-bit hex through RGB565 (5-6-5 bit) and back to a 24-bit hex,
 * so a UI preview swatch shows what the Electra One hardware (which renders in
 * RGB565) will ACTUALLY display. Idempotent: quantizing an already-565-aligned
 * colour returns it unchanged.
 */
export function quantizeToRgb565(hex: string): string {
  const norm = normalizeHex(hex);
  if (!norm) return DEFAULT_FALLBACK;
  const r = parseInt(norm.slice(0, 2), 16);
  const g = parseInt(norm.slice(2, 4), 16);
  const b = parseInt(norm.slice(4, 6), 16);
  // Drop to 5/6/5 bits, then expand back to 8 bits replicating the high bits
  // into the low (the standard 565→888 expansion, so 0x1F → 0xFF not 0xF8).
  const r5 = r >> 3;
  const g6 = g >> 2;
  const b5 = b >> 3;
  const r8 = (r5 << 3) | (r5 >> 2);
  const g8 = (g6 << 2) | (g6 >> 4);
  const b8 = (b5 << 3) | (b5 >> 2);
  return toHexByte(r8) + toHexByte(g8) + toHexByte(b8);
}

/**
 * Normalize a colour string to a 6-digit UPPERCASE hex (no `#`), or null if it
 * isn't a parseable hex. Accepts `#rrggbb`, `rrggbb`, and `#rgb`/`rgb`
 * shorthand. Used by the resolver + the picker's custom-hex input.
 */
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    // Expand shorthand rgb → rrggbb.
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toUpperCase();
}

// A neutral mid-grey fallback for the (never-expected) case of a null node /
// unparseable colour. RGB565-aligned so it round-trips cleanly.
const DEFAULT_FALLBACK = '848484';

function toHexByte(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).toUpperCase().padStart(2, '0');
}

/** HSL (h in 0..360, s/l in 0..1) → 6-digit UPPERCASE hex. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return (
    toHexByte(Math.round((r + m) * 255)) +
    toHexByte(Math.round((g + m) * 255)) +
    toHexByte(Math.round((b + m) * 255))
  );
}

/**
 * A curated palette of distinct, RGB565-friendly swatches for the assign menu —
 * the Electra One's 6 quick page colours plus a spread of saturated mid-tones
 * that survive the device's 565 banding. Each is a 6-digit UPPERCASE hex.
 *
 * These are stored VERBATIM (NOT pre-quantized): the Electra quick colours match
 * the device's own palette exactly, and the curated extras are already chosen to
 * be 565-legible. The 565 round-trip preview is reserved for the CUSTOM-hex path
 * (a user-entered arbitrary colour), where it warns what the hardware will
 * actually render. (Plan Decision B.)
 */
export const CONTROL_COLOR_PALETTE: ReadonlyArray<{ hex: string; name: string }> = [
  // Electra's 6 quick colours.
  { hex: 'FFFFFF', name: 'White' },
  { hex: 'F45C51', name: 'Red' },
  { hex: 'F49500', name: 'Orange' },
  { hex: 'FFD940', name: 'Yellow' },
  { hex: '529DEC', name: 'Blue' },
  { hex: '03A598', name: 'Teal' },
  // A few more distinct, saturated, 565-legible additions.
  { hex: '7ED957', name: 'Green' },
  { hex: 'B06FE0', name: 'Purple' },
  { hex: 'FF7FBF', name: 'Pink' },
  { hex: '00C2D6', name: 'Cyan' },
  { hex: 'C0A060', name: 'Tan' },
  { hex: '9AA0A6', name: 'Grey' },
];
