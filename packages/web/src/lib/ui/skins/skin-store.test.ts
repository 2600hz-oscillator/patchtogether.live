// Palette-store unit tests (P0.1 color-only re-tier).
//
// vitest.config.ts runs in `node` (no DOM). The store touches
// `document.documentElement.style` + `localStorage` — tiny surface, so we
// polyfill both inside this file rather than pull in jsdom for one test.
//
// Filename note: deliberately `.test.ts` (not `.svelte.test.ts`) so the
// vite-plugin-svelte loader doesn't try to compile this as a runes module —
// it's a plain test file that imports the runes store from `./skin-store.svelte`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Minimal globals polyfill (must run BEFORE the store import so the
// constructor's DOM probe sees them). ----
class StyleStub {
  private map = new Map<string, string>();
  setProperty(k: string, v: string) { this.map.set(k, v); }
  removeProperty(k: string) { this.map.delete(k); }
  getPropertyValue(k: string): string { return this.map.get(k) ?? ''; }
  clear(): void { this.map.clear(); }
}
const styleStub = new StyleStub();
class StorageStub {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
  get length(): number { return this.map.size; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
}
const storageStub = new StorageStub();

const attrStub: Record<string, string> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).document = {
  documentElement: {
    style: styleStub,
    setAttribute(name: string, value: string) { attrStub[name] = value; },
    getAttribute(name: string): string | null { return attrStub[name] ?? null; },
    removeAttribute(name: string) { delete attrStub[name]; },
  },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = storageStub;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = globalThis;

// Now we can safely import the store + palettes.
const { applyPaletteToRoot, skinStore } = await import('./skin-store.svelte');
const { PALETTES, getPalette } = await import('./index');
const { racklinePalette } = await import('./palettes/rackline');
const { graphitePalette } = await import('./palettes/graphite');
const { midnightPalette } = await import('./palettes/midnight');
const { emberPalette } = await import('./palettes/ember');
const { slatePalette } = await import('./palettes/slate');
const { CABLE_VARS } = await import('./palettes/_cables');

const STORAGE_KEY = 'pt.skin';

beforeEach(() => {
  styleStub.clear();
  storageStub.clear();
  skinStore.setSkin('rackline');
  storageStub.clear();
});

describe('palette types + registry', () => {
  it('exposes 5 in-tree palettes, rackline first', () => {
    expect(PALETTES.length).toBe(5);
    expect(PALETTES[0]?.id).toBe('rackline');
  });

  it('every palette defines every REQUIRED colour token', () => {
    // racklinePalette sets exactly the required PaletteVars keys, so its key
    // set is the required contract. Every palette must be a SUPERSET.
    const required = Object.keys(racklinePalette.vars).sort();
    for (const p of PALETTES) {
      const pk = new Set(Object.keys(p.vars));
      for (const k of required) {
        expect(pk.has(k)).toBe(true);
      }
    }
  });

  it('NO palette sets a structural / sprite token (color-only contract)', () => {
    const forbidden = [
      '--module-radius',
      '--module-stripe-radius',
      '--module-glow',
      '--module-border-color',
      '--control-style',
      '--panel-bg',
      '--fader-track-bg',
      '--font-silkscreen',
    ];
    for (const p of PALETTES) {
      for (const k of forbidden) {
        expect(p.vars).not.toHaveProperty(k);
      }
    }
  });

  it('rackline default reproduces the RACKLINE mock palette (tokens.css seed)', () => {
    // Critical contract: rackline must mirror the tokens.css PALETTE seed so
    // the pre-JS :root fallback matches the inline-applied default.
    expect(racklinePalette.vars['--bg']).toBe('#0e1013');
    expect(racklinePalette.vars['--module-bg']).toBe('#1c1f24');
    expect(racklinePalette.vars['--module-bg-deep']).toBe('#0a0c0f');
    expect(racklinePalette.vars['--surface-1']).toBe('#17191d');
    expect(racklinePalette.vars['--text']).toBe('#eef1f5');
    expect(racklinePalette.vars['--accent']).toBe('#ffb347');
  });

  it('cable token NAMES are stable across all palettes (Canvas contract)', () => {
    // Canvas.svelte builds edge styles via `var(--cable-${e.sourceType})`.
    const required = [
      '--cable-audio',
      '--cable-pitch',
      '--cable-gate',
      '--cable-cv',
      '--cable-polyPitchGate',
      '--cable-keys',
      '--cable-image',
      '--cable-mono-video',
      '--cable-video',
    ] as const;
    for (const p of PALETTES) {
      for (const k of required) {
        expect(p.vars).toHaveProperty(k);
      }
    }
  });

  it('cable/domain hues MATCH THE MOCKS (owner decision #1)', () => {
    // The 5 primary domain hues are the mockup values verbatim.
    expect(CABLE_VARS['--cable-audio']).toBe('#38d3c8'); // teal
    expect(CABLE_VARS['--cable-cv']).toBe('#7bd66a'); // green
    expect(CABLE_VARS['--cable-gate']).toBe('#f2c14e'); // amber
    expect(CABLE_VARS['--cable-video']).toBe('#b57bff'); // violet
    expect(CABLE_VARS['--cable-polyPitchGate']).toBe('#ff7bc2'); // pink
    // Cable language is CONSTANT across every palette.
    for (const p of PALETTES) {
      for (const [k, v] of Object.entries(CABLE_VARS)) {
        expect(p.vars[k as keyof typeof p.vars]).toBe(v);
      }
    }
  });
});

describe('applyPaletteToRoot', () => {
  it('writes every colour var inline on documentElement', () => {
    applyPaletteToRoot(graphitePalette);
    expect(styleStub.getPropertyValue('--bg')).toBe('#101215');
    expect(styleStub.getPropertyValue('--accent')).toBe('#38d3c8');
    expect(styleStub.getPropertyValue('--cable-audio')).toBe('#38d3c8');
  });

  it('overwrites previous palette values when called again', () => {
    applyPaletteToRoot(emberPalette);
    expect(styleStub.getPropertyValue('--accent')).toBe('#ff8a3c');
    applyPaletteToRoot(midnightPalette);
    expect(styleStub.getPropertyValue('--bg')).toBe('#0b0f1a');
    expect(styleStub.getPropertyValue('--accent')).toBe('#5cc8ff');
  });

  it('CLEARS any stale legacy structural / sprite token on apply', () => {
    // Simulate a pre-boot :root or an old structural skin leaving these inline.
    for (const k of [
      '--module-radius',
      '--module-glow',
      '--module-border-color',
      '--control-style',
      '--panel-bg',
      '--font-silkscreen',
    ]) {
      styleStub.setProperty(k, 'STALE');
    }
    applyPaletteToRoot(slatePalette);
    expect(styleStub.getPropertyValue('--module-radius')).toBe('');
    expect(styleStub.getPropertyValue('--module-glow')).toBe('');
    expect(styleStub.getPropertyValue('--module-border-color')).toBe('');
    expect(styleStub.getPropertyValue('--control-style')).toBe('');
    expect(styleStub.getPropertyValue('--panel-bg')).toBe('');
    expect(styleStub.getPropertyValue('--font-silkscreen')).toBe('');
    // …but the colour layer landed.
    expect(styleStub.getPropertyValue('--bg')).toBe('#15181c');
  });

  it('writes data-palette on documentElement', () => {
    applyPaletteToRoot(midnightPalette);
    expect(attrStub['data-palette']).toBe('midnight');
    applyPaletteToRoot(racklinePalette);
    expect(attrStub['data-palette']).toBe('rackline');
  });
});

describe('skinStore', () => {
  it('starts with the rackline default palette', () => {
    expect(skinStore.current).toBe('rackline');
    expect(skinStore.currentSkin.id).toBe('rackline');
  });

  it('setSkin updates current + applies vars + persists', () => {
    skinStore.setSkin('midnight');
    expect(skinStore.current).toBe('midnight');
    expect(styleStub.getPropertyValue('--bg')).toBe('#0b0f1a');
    expect(storageStub.getItem(STORAGE_KEY)).toBe('midnight');
  });

  it('setSkin with persist=false does not write to localStorage', () => {
    storageStub.clear();
    skinStore.setSkin('ember', false);
    expect(skinStore.current).toBe('ember');
    expect(storageStub.getItem(STORAGE_KEY)).toBeNull();
  });

  it('setSkin falls back to default on unknown id', () => {
    // Cast through unknown so we can pass an invalid id without TS griping.
    skinStore.setSkin('nonexistent' as unknown as 'rackline');
    expect(skinStore.current).toBe('rackline');
    expect(storageStub.getItem(STORAGE_KEY)).toBe('rackline');
  });

  it('an old (removed) skin id in storage boots to the default palette', () => {
    // Users who persisted a legacy skin id ('diner', 'default', …) resolve to
    // rackline rather than crashing.
    storageStub.setItem(STORAGE_KEY, 'diner');
    skinStore.setSkin('diner' as unknown as 'rackline');
    expect(skinStore.current).toBe('rackline');
  });

  it('list() returns the same palettes as the PALETTES export', () => {
    const list = skinStore.list();
    expect(list.length).toBe(PALETTES.length);
    expect(list[0]?.id).toBe('rackline');
  });

  it('round-trips through localStorage on reload simulation', () => {
    skinStore.setSkin('graphite');
    expect(storageStub.getItem(STORAGE_KEY)).toBe('graphite');
    styleStub.clear();
    const stored = storageStub.getItem(STORAGE_KEY);
    expect(stored).toBe('graphite');
    if (stored) applyPaletteToRoot(getPalette(stored as 'graphite'));
    expect(styleStub.getPropertyValue('--bg')).toBe('#101215');
  });

  it('setSkin still updates `current` even when localStorage throws', () => {
    const setItem = vi.spyOn(storageStub, 'setItem')
      .mockImplementation(() => { throw new Error('quota'); });
    try {
      skinStore.setSkin('ember');
      expect(skinStore.current).toBe('ember');
      expect(styleStub.getPropertyValue('--bg')).toBe('#14110f');
    } finally {
      setItem.mockRestore();
    }
  });
});
