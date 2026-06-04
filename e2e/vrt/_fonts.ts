// e2e/vrt/_fonts.ts
//
// Deterministic text rendering for the VRT suite.
//
// ── The flake this kills ─────────────────────────────────────────────
// The app's card text resolves through *generic* CSS font stacks:
//   • titles / buttons / body → `--font-ui: 'Inter', system-ui, …`
//     (Inter is the DESIGN font but is NOT bundled — nothing ships an
//      Inter @font-face, so on a machine without Inter installed the
//      stack falls through to `system-ui` / `sans-serif`)
//   • knob / fader / port labels → `ui-monospace, monospace`
//
// On the ubuntu-latest VRT runner there is no Inter, and `system-ui` /
// `ui-monospace` / `monospace` are resolved by **fontconfig** to whatever
// sans / mono face happens to be installed. That selection is NOT stable
// run-to-run (different fontconfig cache state / available faces between
// runner image revisions), so the SAME commit renders card text with
// DIFFERENT glyph shapes AND DIFFERENT metrics on different runs. The
// proof, straight from a failed CI artifact:
//
//   • small cards trip "Expected 400×374, received 400×375" — a +1px
//     height from a fractional title line-box (line-height:normal) whose
//     metric depends on the chosen face; one device pixel taller relands
//     every text row on a new scanline → every glyph diffs.
//   • larger cards trip "Expected 948×552, received 962×561" — +14px
//     WIDTH and +9px HEIGHT: an entirely DIFFERENT, wider face was
//     selected, so the labels measure wider. Playwright hard-fails on the
//     dimension mismatch before it can even compute a diff ratio.
//
// `document.fonts.ready` does NOT help: it only tracks @font-face faces
// the document declares (just Bravura, for SCORE). System generic faces
// are invisible to it, so it resolves instantly and the system-font
// nondeterminism sails right through. (The prior #576 settle-loop fixed
// the 1px LAYOUT jitter only — not the underlying font selection.)
//
// ── The fix ──────────────────────────────────────────────────────────
// Bundle the two intended faces (Inter for the sans/UI stack, JetBrains
// Mono for the mono labels) as self-hosted woff2 under e2e/vrt/fonts/,
// inline them as base64 data: URIs (zero network → zero load-timing
// nondeterminism), and inject — BEFORE first paint, via addInitScript —
// an @font-face + a high-specificity override that pins:
//   • the sans stack (incl. --font-ui / --font-display) → bundled Inter
//   • every `ui-monospace, monospace` usage              → bundled JetBrains Mono
// plus deterministic AA / hinting (-webkit-font-smoothing: antialiased,
// text-rendering: geometricPrecision). After navigation we explicitly
// `document.fonts.load(...)` each weight and `await document.fonts.ready`
// so the faces are decoded + applied before any screenshot.
//
// This removes BOTH failure modes at the root: glyph shapes and text
// metrics are now byte-stable on every platform/run, so the recaptured
// baselines stay byte-equal. Scoped to the VRT page only (injected by the
// spec) — the shipped app is untouched.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

const FONT_DIR = join(import.meta.dirname, 'fonts');

function dataUri(file: string): string {
  const b64 = readFileSync(join(FONT_DIR, file)).toString('base64');
  return `url(data:font/woff2;base64,${b64}) format('woff2')`;
}

// Built once at module load — read the bundled woff2 off disk and inline
// them so the injected stylesheet is fully self-contained (no /fonts/*
// route, no CDN, nothing the dev server has to serve).
const INTER_400 = dataUri('inter-400.woff2');
const INTER_600 = dataUri('inter-600.woff2');
const INTER_700 = dataUri('inter-700.woff2');
const MONO_400 = dataUri('jetbrains-mono-400.woff2');
const MONO_700 = dataUri('jetbrains-mono-700.woff2');

// Family names are VRT-private (the `VRT` prefix guarantees they can't
// collide with anything the app or a skin declares) so this override is
// purely additive and never masks an intentional skin font.
const SANS = 'VRTUISans';
const MONO = 'VRTUIMono';

const FONT_CSS = `
@font-face { font-family:'${SANS}'; font-weight:400; font-style:normal; font-display:block; src:${INTER_400}; }
@font-face { font-family:'${SANS}'; font-weight:500; font-style:normal; font-display:block; src:${INTER_600}; }
@font-face { font-family:'${SANS}'; font-weight:600; font-style:normal; font-display:block; src:${INTER_600}; }
@font-face { font-family:'${SANS}'; font-weight:700; font-style:normal; font-display:block; src:${INTER_700}; }
@font-face { font-family:'${MONO}'; font-weight:400; font-style:normal; font-display:block; src:${MONO_400}; }
@font-face { font-family:'${MONO}'; font-weight:500; font-style:normal; font-display:block; src:${MONO_400}; }
@font-face { font-family:'${MONO}'; font-weight:600; font-style:normal; font-display:block; src:${MONO_700}; }
@font-face { font-family:'${MONO}'; font-weight:700; font-style:normal; font-display:block; src:${MONO_700}; }

/* Repoint the design CSS-vars at the bundled sans so anything reading
 * --font-ui / --font-display (card titles, chrome) is deterministic. The
 * generic-keyword tail is kept only as a paranoia fallback; the bundled
 * face is always first + always loaded before we screenshot. */
:root {
  --font-ui: '${SANS}', system-ui, sans-serif !important;
  --font-display: '${SANS}', system-ui, sans-serif !important;
}

/* Default everything to the bundled sans. !important beats the per-card
 * scoped rules; we then re-assert the bundled MONO on the elements that
 * are *meant* to be monospace so the labels keep their designed look
 * (and stable mono metrics) instead of becoming sans. */
* {
  font-family: '${SANS}', system-ui, sans-serif !important;
  -webkit-font-smoothing: antialiased !important;
  -moz-osx-font-smoothing: grayscale !important;
  text-rendering: geometricPrecision !important;
}

/* Mono labels: knob/fader/port labels + value tags + MIDI badges + the
 * monospace stack wherever it appears. These selectors mirror the app's
 * "font-family: ui-monospace, monospace" usages (Knob/Fader/.port-label/
 * etc.). The attribute selector is a belt: any inline ui-monospace style
 * also gets the bundled mono. */
.mod-card .port-label,
.mod-card .title,
.label,
.value,
.value-tag,
.tick-anchor,
.midi-badge,
.status-label,
[style*="ui-monospace"],
[style*="monospace"] {
  font-family: '${MONO}', ui-monospace, monospace !important;
}

/* The card title is the design sans (Inter), not mono — re-assert sans on
 * it after the mono block above (which matched .mod-card .title for the
 * unskinned "inherit" case). Skin silkscreen fonts set --font-silkscreen
 * and are left alone (those scenes aren't part of the per-card gate). */
.mod-card .title {
  font-family: var(--font-silkscreen, '${SANS}', system-ui, sans-serif) !important;
}
`;

// The page-side loader: re-assert the faces are decoded + applied. Inlined
// as a string so addInitScript runs it in the page context before paint.
const LOAD_FONTS_FN = `() => {
  const faces = [
    ['400','${SANS}'], ['500','${SANS}'], ['600','${SANS}'], ['700','${SANS}'],
    ['400','${MONO}'], ['600','${MONO}'], ['700','${MONO}'],
  ];
  return Promise.all(
    faces.map(([w, f]) => document.fonts.load(w + " 16px '" + f + "'"))
  ).then(() => document.fonts.ready);
}`;

/**
 * Pin every VRT page to the bundled Inter (sans) + JetBrains Mono (mono)
 * faces so card text rasterises byte-identically on every platform/run.
 *
 * MUST be called once per page BEFORE the first navigation — it uses
 * addInitScript so the <style> + @font-face are present before first
 * paint (no FOUT, no fallback flash baked into the screenshot).
 */
export async function pinVrtFonts(page: Page): Promise<void> {
  await page.addInitScript((css: string) => {
    // addInitScript runs at document_start — `document.documentElement`
    // can still be null at that instant (the parser hasn't created <html>
    // yet), so appending directly throws. Inject as soon as the root
    // element exists: try now, and if it's not there yet, poll on
    // microtasks until it is. We still land WELL before first paint (the
    // root element appears in the very first parse chunk), so no fallback
    // face is ever rasterised.
    const inject = () => {
      if (document.getElementById('__vrt-font-pin')) return true;
      const root = document.head ?? document.documentElement;
      if (!root) return false;
      const style = document.createElement('style');
      style.id = '__vrt-font-pin';
      style.textContent = css;
      root.appendChild(style);
      return true;
    };
    if (!inject()) {
      // documentElement isn't up yet. Watch for it with a MutationObserver
      // on `document` (which always exists) rather than a polling loop —
      // a tight microtask/sync poll would starve the HTML parser and stall
      // the `load` event. The observer fires the instant <html> is added,
      // still long before first paint, then disconnects.
      const obs = new MutationObserver(() => {
        if (inject()) obs.disconnect();
      });
      obs.observe(document, { childList: true, subtree: true });
    }
  }, FONT_CSS);
}

/**
 * Force-decode + apply the bundled faces, then await document.fonts.ready.
 * Call AFTER navigation (and again is harmless) so no screenshot is taken
 * while a face is still pending. Returns once every weight is ready.
 */
export async function awaitVrtFonts(page: Page): Promise<void> {
  await page.evaluate(LOAD_FONTS_FN);
}
