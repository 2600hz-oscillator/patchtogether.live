// Skin-store unit tests.
//
// vitest.config.ts runs in `node` (no DOM). The skin store touches
// `document.documentElement.style` and `localStorage` — tiny surface, so
// we polyfill both inside this file rather than pull in jsdom for one
// test (the project deliberately keeps unit tests dependency-light;
// browser-shaped behaviors live in the e2e Playwright suite).
//
// Filename note: deliberately `.test.ts` (not `.svelte.test.ts`) so
// the @sveltejs/vite-plugin-svelte loader doesn't try to compile this
// as a Svelte runes module — it's a plain test file that imports the
// runes store from `./skin-store.svelte`.

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

// Globals must be in place before the .svelte.ts module is evaluated;
// the module's IIFE constructs the singleton, which probes both.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// Now we can safely import the store + skins.
const { applySkinToRoot, skinStore } = await import('./skin-store.svelte');
const { SKINS, getSkin } = await import('./index');
const { defaultSkin } = await import('./default');
const { terminalGreenSkin } = await import('./terminal-green');
const { brutalistSkin } = await import('./brutalist');
const { vaporwaveSkin } = await import('./vaporwave');
const { vintageSkin } = await import('./vintage');
const { matrixcowboySkin } = await import('./matrixcowboy');
const { dinerSkin } = await import('./diner');

const STORAGE_KEY = 'pt.skin';

beforeEach(() => {
  styleStub.clear();
  storageStub.clear();
  // Re-apply default so the singleton's `current` matches what's on the
  // root after clearing — keeps any test that reads skinStore.current
  // honest about its initial state for THIS test.
  skinStore.setSkin('default');
  // Constructor wrote storage; clear it again so unrelated tests aren't
  // polluted by the boot path.
  storageStub.clear();
});

describe('skin types + registry', () => {
  it('exposes 7 in-tree skins, default first', () => {
    expect(SKINS.length).toBe(7);
    expect(SKINS[0]?.id).toBe('default');
  });

  it('every skin defines every REQUIRED token from the type', () => {
    // defaultSkin sets exactly the required SkinVars keys (no optional
    // shape tokens), so its key set is the required contract. Every skin
    // must be a SUPERSET — it may add the OPTIONAL shape tokens (DINER),
    // but it can never DROP a required one.
    const required = Object.keys(defaultSkin.vars).sort();
    for (const s of SKINS) {
      const sk = new Set(Object.keys(s.vars));
      for (const k of required) {
        expect(sk.has(k)).toBe(true);
      }
    }
  });

  it('only DINER sets the OPTIONAL shape tokens; the six others omit them', () => {
    // The whole point of the optional tokens: `_module-card.css` falls back
    // to the legacy hard-edged values for any skin that doesn't set them, so
    // the six pre-existing skins render byte-identically (VRT baselines hold).
    const optional = [
      '--module-radius',
      '--module-stripe-radius',
      '--module-glow',
      '--module-border-color',
    ] as const;
    for (const s of SKINS) {
      const setsAny = optional.some((k) => k in s.vars);
      if (s.id === 'diner') {
        expect(setsAny).toBe(true);
        for (const k of optional) expect(s.vars).toHaveProperty(k);
      } else {
        expect(setsAny).toBe(false);
      }
    }
  });

  it('default skin values mirror :root global.css surface', () => {
    // Critical contract: switching to `default` must reproduce the
    // baseline visuals byte-for-byte. If this fails, default skin has
    // drifted from global.css and existing snapshots will diverge.
    expect(defaultSkin.vars['--bg']).toBe('#0e1116');
    expect(defaultSkin.vars['--module-bg']).toBe('#1a1d23');
    expect(defaultSkin.vars['--accent']).toBe('#00f0ff');
    expect(defaultSkin.vars['--cable-audio']).toBe('#fbbf24');
    expect(defaultSkin.vars['--cable-pitch']).toBe('#60a5fa');
    expect(defaultSkin.vars['--cable-gate']).toBe('#f87171');
    expect(defaultSkin.vars['--cable-cv']).toBe('#34d399');
  });

  it('cable token NAMES are stable across all skins (Canvas contract)', () => {
    // Canvas.svelte builds edge styles via `var(--cable-${e.sourceType})`.
    // Removing/renaming a cable var would silently break edge colouring.
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
    for (const s of SKINS) {
      for (const k of required) {
        expect(s.vars).toHaveProperty(k);
      }
    }
  });
});

describe('applySkinToRoot', () => {
  it('writes every var inline on documentElement', () => {
    applySkinToRoot(terminalGreenSkin);
    expect(styleStub.getPropertyValue('--bg')).toBe('#000000');
    expect(styleStub.getPropertyValue('--text')).toBe('#7fff7f');
    expect(styleStub.getPropertyValue('--accent')).toBe('#00ffaa');
  });

  it('overwrites previous skin values when called again', () => {
    applySkinToRoot(brutalistSkin);
    expect(styleStub.getPropertyValue('--text')).toBe('#ffffff');
    applySkinToRoot(vaporwaveSkin);
    expect(styleStub.getPropertyValue('--text')).toBe('#f0e8ff');
    expect(styleStub.getPropertyValue('--accent')).toBe('#ff7ce0');
  });
});

describe('skinStore', () => {
  it('starts with the default skin', () => {
    // beforeEach resets to default. Verify the contract.
    expect(skinStore.current).toBe('default');
    expect(skinStore.currentSkin.id).toBe('default');
  });

  it('setSkin updates current + applies vars + persists', () => {
    skinStore.setSkin('vaporwave');
    expect(skinStore.current).toBe('vaporwave');
    expect(styleStub.getPropertyValue('--bg')).toBe('#0a0521');
    expect(storageStub.getItem(STORAGE_KEY)).toBe('vaporwave');
  });

  it('setSkin with persist=false does not write to localStorage', () => {
    storageStub.clear();
    skinStore.setSkin('brutalist', false);
    expect(skinStore.current).toBe('brutalist');
    expect(storageStub.getItem(STORAGE_KEY)).toBeNull();
  });

  it('setSkin falls back to default on unknown id', () => {
    // Cast through unknown so we can pass an invalid id without TS griping.
    skinStore.setSkin('nonexistent' as unknown as 'default');
    expect(skinStore.current).toBe('default');
    expect(storageStub.getItem(STORAGE_KEY)).toBe('default');
  });

  it('list() returns the same skins as the SKINS export', () => {
    const list = skinStore.list();
    expect(list.length).toBe(SKINS.length);
    expect(list[0]?.id).toBe('default');
  });

  it('round-trips through localStorage on reload simulation', () => {
    skinStore.setSkin('terminal-green');
    expect(storageStub.getItem(STORAGE_KEY)).toBe('terminal-green');
    // Simulate a reload by reading the persisted value + applying.
    styleStub.clear();
    const stored = storageStub.getItem(STORAGE_KEY);
    expect(stored).toBe('terminal-green');
    if (stored) {
      const skin = getSkin(stored as 'terminal-green');
      applySkinToRoot(skin);
    }
    expect(styleStub.getPropertyValue('--bg')).toBe('#000000');
  });

  it('setSkin still updates `current` even when localStorage throws', () => {
    const setItem = vi.spyOn(storageStub, 'setItem')
      .mockImplementation(() => { throw new Error('quota'); });
    try {
      skinStore.setSkin('brutalist');
      expect(skinStore.current).toBe('brutalist');
      expect(styleStub.getPropertyValue('--bg')).toBe('#000000');
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('vintage skin + sprite extension', () => {
  it('loads cleanly with every required sprite field populated', () => {
    expect(vintageSkin.id).toBe('vintage');
    expect(vintageSkin.controlStyle).toBe('sprite');
    // All sprite hooks present + non-empty.
    expect(vintageSkin.faderHandleSvg).toMatch(/<svg/);
    expect(vintageSkin.faderTrackBg).toMatch(/^url\(/);
    expect(vintageSkin.panelBg).toMatch(/^url\(/);
    expect(vintageSkin.silkscreenFontFamily).toMatch(/Plex/);
    expect(vintageSkin.silkscreenFontStylesheet).toMatch(/^https:/);
  });

  it('legacy 4 skins keep controlStyle undefined (CSS path)', () => {
    expect(defaultSkin.controlStyle).toBeUndefined();
    expect(terminalGreenSkin.controlStyle).toBeUndefined();
    expect(brutalistSkin.controlStyle).toBeUndefined();
    expect(vaporwaveSkin.controlStyle).toBeUndefined();
  });

  it('matrixcowboy stays on the CSS path but ships a monospace font', () => {
    // MATRIXCOWBOY reuses the silkscreen-font hook for IBM Plex Mono but
    // does NOT opt into sprite-based controls — chrome stays CSS-rendered
    // so the CRT scanline overlay reads cleanly across every module card.
    expect(matrixcowboySkin.controlStyle).toBeUndefined();
    expect(matrixcowboySkin.silkscreenFontFamily).toMatch(/Plex Mono/);
    expect(matrixcowboySkin.silkscreenFontStylesheet).toMatch(/^https:/);
  });

  it('applying a skin writes data-skin on documentElement', () => {
    applySkinToRoot(matrixcowboySkin);
    expect(attrStub['data-skin']).toBe('matrixcowboy');
    applySkinToRoot(defaultSkin);
    expect(attrStub['data-skin']).toBe('default');
  });

  it('diner is a fancy sprite skin that ships the optional shape tokens', () => {
    expect(dinerSkin.id).toBe('diner');
    expect(dinerSkin.controlStyle).toBe('sprite');
    // Sprite hooks (like Vintage).
    expect(dinerSkin.faderHandleSvg).toMatch(/<svg/);
    expect(dinerSkin.faderTrackBg).toMatch(/^url\(/);
    expect(dinerSkin.panelBg).toMatch(/^url\(/);
    expect(dinerSkin.silkscreenFontFamily).toMatch(/Orbitron/);
    expect(dinerSkin.silkscreenFontStylesheet).toMatch(/^https:.*Orbitron/);
    // Optional shape tokens (the curved-edges + neon-border contract).
    expect(dinerSkin.vars['--module-radius']).toBe('14px');
    expect(dinerSkin.vars['--module-glow']).toMatch(/rgba/);
    expect(dinerSkin.vars['--module-border-color']).toBe('#c46af0');
  });

  it('applySkinToRoot applies DINER shape tokens, then CLEARS them on switch-away', () => {
    applySkinToRoot(dinerSkin);
    expect(styleStub.getPropertyValue('--module-radius')).toBe('14px');
    expect(styleStub.getPropertyValue('--module-glow')).toMatch(/rgba/);
    expect(styleStub.getPropertyValue('--module-border-color')).toBe('#c46af0');
    expect(styleStub.getPropertyValue('--control-style')).toBe('sprite');

    // Switching to a skin that doesn't define them must REMOVE them so the
    // legacy CSS fallback (hard corners, no glow) kicks back in.
    applySkinToRoot(defaultSkin);
    expect(styleStub.getPropertyValue('--module-radius')).toBe('');
    expect(styleStub.getPropertyValue('--module-stripe-radius')).toBe('');
    expect(styleStub.getPropertyValue('--module-glow')).toBe('');
    expect(styleStub.getPropertyValue('--module-border-color')).toBe('');
  });

  it('applySkinToRoot writes sprite-extension vars only for vintage', () => {
    applySkinToRoot(vintageSkin);
    expect(styleStub.getPropertyValue('--control-style')).toBe('sprite');
    expect(styleStub.getPropertyValue('--panel-bg')).toMatch(/^url\(/);
    expect(styleStub.getPropertyValue('--fader-track-bg')).toMatch(/^url\(/);
    expect(styleStub.getPropertyValue('--font-silkscreen')).toMatch(/Plex/);

    // Switching back to default CLEARS the sprite-extension vars so the
    // legacy CSS path isn't contaminated by a stale panel texture.
    applySkinToRoot(defaultSkin);
    expect(styleStub.getPropertyValue('--control-style')).toBe('');
    expect(styleStub.getPropertyValue('--panel-bg')).toBe('');
    expect(styleStub.getPropertyValue('--fader-track-bg')).toBe('');
    expect(styleStub.getPropertyValue('--font-silkscreen')).toBe('');
  });
});
