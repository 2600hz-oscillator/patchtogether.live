// packages/web/src/lib/video/milkdrop-preset-loader.ts
//
// Browser-side `.milk` → butterchurn-JSON loader + a tiny preset-name resolver,
// both pulled OUT of MilkdropCard so they can be unit-tested without mounting the
// card or booting WebGL.
//
// `convertMilkPreset` lazy-imports `milkdrop-preset-converter` (MIT) — a ~770 KB
// webpack bundle that compiles a classic Milkdrop `.milk` (INI + EEL + HLSL) into
// butterchurn's preset JSON (the exact format `visualizer.loadPreset` consumes,
// the same converter butterchurn's own preset editor uses). It is pulled behind a
// dynamic import() ONLY when the user actually picks a file, so it forms its own
// lazy chunk and never lands in the main bundle (mirrors how milkdrop.ts
// lazy-loads the engine + the curated preset pack). The package bundles its own
// Buffer polyfill, so it is browser-safe.

/** The shape `milkdrop-preset-converter` exposes (no types ship with it). */
interface MilkdropPresetConverterModule {
  convertPreset(milkText: string): Promise<unknown>;
}

/** A butterchurn preset always carries `baseVals` + the equation strings. We
 *  only narrow enough to reject a non-object / non-preset result. */
function looksLikeButterchurnPreset(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return 'baseVals' in o || 'frame_eqs_str' in o || 'pixel_eqs_str' in o;
}

/**
 * Convert a classic Milkdrop `.milk` preset (raw INI text) into a butterchurn
 * preset object suitable for `visualizer.loadPreset(preset, blendSeconds)`.
 * Throws if the converter can't be loaded or the result isn't a preset.
 */
export async function convertMilkPreset(milkText: string): Promise<unknown> {
  const mod = (await import('milkdrop-preset-converter')) as unknown as
    | MilkdropPresetConverterModule
    | { default: MilkdropPresetConverterModule };
  const convert =
    typeof (mod as MilkdropPresetConverterModule).convertPreset === 'function'
      ? (mod as MilkdropPresetConverterModule).convertPreset
      : (mod as { default?: MilkdropPresetConverterModule }).default?.convertPreset;
  if (typeof convert !== 'function') {
    throw new Error('milkdrop-preset-converter: convertPreset export missing');
  }
  const preset = await convert(milkText);
  if (!looksLikeButterchurnPreset(preset)) {
    throw new Error('milkdrop-preset-converter: result is not a butterchurn preset');
  }
  return preset;
}

/**
 * Resolve the list of names the card picker shows: the engine's LIVE list once
 * the preset pack has loaded (curated + any in-session customs, in presetList
 * order), else the static curated fallback so the dropdown is populated
 * immediately (before the lazy pack chunk resolves).
 */
export function resolvePresetNames(
  liveNames: readonly string[] | undefined,
  curatedFallback: readonly string[],
): string[] {
  if (liveNames && liveNames.length > 0) return [...liveNames];
  return [...curatedFallback];
}
