// packages/web/src/lib/graph/textmarquee-editor.test.ts
//
// The PURE half of TEXTMARQUEE's DOM ⇄ model serializer.
//
// ⚠ WHAT THIS FILE CAN AND CANNOT SEE, stated first because the split is the
// whole reason the module is shaped this way. The web unit suite runs in
// `environment: 'node'`: there is no `getComputedStyle`, no `Node`, no
// `document`. So everything here takes RESOLVED STRINGS and asserts the
// decision made from them. What it CANNOT see is which strings a real cascade
// hands over — i.e. exactly the defect the extraction exists to prevent (the
// body inheriting `--text` and stamping `#eef1f5` on every run). That is a
// browser fact and it is covered by the default-shell leg of
// `e2e/tests/textmarquee-face-editor.spec.ts`, which types into the FACE's
// editor and reads the persisted model back out of the store.
//
// The two together are the instrument. Neither is sufficient: this file would
// stay green through a body that never called `applyEditorBaseStyle` at all.

import { describe, expect, it } from 'vitest';
import {
  EDITOR_BASE_STYLE,
  alignFrom,
  rgbToHex,
  runStyleFrom,
} from './textmarquee-editor';

describe('textmarquee editor — rgbToHex', () => {
  it('converts rgb() and rgba() to #rrggbb', () => {
    expect(rgbToHex('rgb(255, 255, 255)')).toBe('#ffffff');
    expect(rgbToHex('rgb(0, 0, 0)')).toBe('#000000');
    expect(rgbToHex('rgba(255, 255, 0, 0.5)')).toBe('#ffff00');
  });

  it('zero-pads each channel (the classic #f0f bug)', () => {
    expect(rgbToHex('rgb(15, 0, 255)')).toBe('#0f00ff');
  });

  it('returns undefined for anything that is not an rgb triple', () => {
    // A run with no resolvable colour must carry NO `color` key at all, so the
    // renderer falls back to `model.fg` rather than to a bogus '#NaNNaNNaN'.
    expect(rgbToHex('')).toBeUndefined();
    expect(rgbToHex('transparent')).toBeUndefined();
    expect(rgbToHex('#ffffff')).toBeUndefined();
  });
});

describe('textmarquee editor — runStyleFrom', () => {
  const plain = {
    fontWeight: 'normal',
    fontStyle: 'normal',
    textDecorationLine: 'none',
    color: 'rgb(255, 255, 255)',
  };

  it('an unstyled run carries only its colour', () => {
    expect(runStyleFrom(plain)).toEqual({ color: '#ffffff' });
  });

  it('numeric font-weight >= 600 is BOLD, 500 is not', () => {
    expect(runStyleFrom({ ...plain, fontWeight: '600' }).bold).toBe(true);
    expect(runStyleFrom({ ...plain, fontWeight: '700' }).bold).toBe(true);
    expect(runStyleFrom({ ...plain, fontWeight: '500' }).bold).toBeUndefined();
  });

  it('the keyword `bold` is BOLD too (execCommand emits both spellings)', () => {
    expect(runStyleFrom({ ...plain, fontWeight: 'bold' }).bold).toBe(true);
  });

  it('italic and underline read off their own properties', () => {
    expect(runStyleFrom({ ...plain, fontStyle: 'italic' }).italic).toBe(true);
    expect(runStyleFrom({ ...plain, textDecorationLine: 'underline' }).underline).toBe(true);
    // Chrome reports a combined value when both are applied.
    expect(
      runStyleFrom({ ...plain, textDecorationLine: 'underline line-through' }).underline,
    ).toBe(true);
  });

  it('false flags are ABSENT, never `false` — the model is sparse by contract', () => {
    const out = runStyleFrom(plain);
    expect('bold' in out).toBe(false);
    expect('italic' in out).toBe(false);
    expect('underline' in out).toBe(false);
  });

  // ⚠ THE REGRESSION THIS MODULE EXISTS FOR, expressed at the only altitude a
  // node-environment test can reach: the resolved colour IS the persisted data.
  // Hand this function the faceplate's `--text` and it writes `#eef1f5` into
  // every run. The FIX is that the editor element sets `color` explicitly, so
  // the cascade never resolves to that in the first place — which is why the
  // next block pins `EDITOR_BASE_STYLE.color` and the e2e leg reads the real
  // page. This test states the hazard; it does not prevent it.
  it('an INHERITED faceplate colour would be written straight into the run', () => {
    expect(runStyleFrom({ ...plain, color: 'rgb(238, 241, 245)' }).color).toBe('#eef1f5');
  });
});

describe('textmarquee editor — alignFrom', () => {
  it('maps the three model alignments', () => {
    expect(alignFrom('left')).toBe('left');
    expect(alignFrom('center')).toBe('center');
    expect(alignFrom('right')).toBe('right');
  });

  it('`end` is right (Chrome reports the logical keyword for justifyRight)', () => {
    expect(alignFrom('end')).toBe('right');
  });

  it('anything else falls back to left, including the empty string', () => {
    expect(alignFrom('start')).toBe('left');
    expect(alignFrom('justify')).toBe('left');
    expect(alignFrom('')).toBe('left');
  });
});

describe('textmarquee editor — the explicit style contract', () => {
  // Every key here is read BACK by the serializer, so the contract is not
  // cosmetic: dropping one re-opens the inheritance hole for that property.
  it('names every property the serializer reads, plus the whitespace mode', () => {
    expect(Object.keys(EDITOR_BASE_STYLE).sort()).toEqual([
      'color',
      'fontStyle',
      'fontWeight',
      'textAlign',
      'textDecoration',
      'whiteSpace',
    ]);
  });

  it('the defaults are the LEGACY CARD\'s, so an existing rack round-trips', () => {
    // `TextmarqueeCard.svelte`'s `.editor` rule has always been white-on-dark
    // with `pre-wrap`; a body that resolved anything else would rewrite the
    // colour of every untouched run in every saved patch the first time
    // somebody opened the dock.
    expect(EDITOR_BASE_STYLE.color).toBe('#ffffff');
    expect(EDITOR_BASE_STYLE.whiteSpace).toBe('pre-wrap');
    expect(EDITOR_BASE_STYLE.fontWeight).toBe('normal');
    expect(EDITOR_BASE_STYLE.textAlign).toBe('left');
  });

  it('the white default survives a round trip through the colour reader', () => {
    // The contract is only worth anything if `runStyleFrom` agrees with it:
    // white in CSS must come back as the same hex the card persisted.
    expect(
      runStyleFrom({
        fontWeight: 'normal',
        fontStyle: 'normal',
        textDecorationLine: 'none',
        color: 'rgb(255, 255, 255)',
      }).color,
    ).toBe(EDITOR_BASE_STYLE.color);
  });
});
