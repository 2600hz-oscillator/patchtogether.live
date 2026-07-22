// Push2Docs — SSR render + drift-guard test. The doc page's control→action
// tables are GENERATED from the REAL push2-map CC constants, so this asserts the
// rendered page carries those exact numbers: a change to a Push CC in the map
// flips this red instead of letting the doc drift silently (the Push analogue of
// launchpad-docs.test's paint drift-guard). Pure unit — no browser.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Push2Docs from './Push2Docs.svelte';
import {
  PUSH_CC_PLAY,
  PUSH_CC_SHIFT,
  PUSH_CC_DPAD_UP,
  PUSH_CC_DPAD_LEFT,
  PUSH_CC_ABOVE_DISPLAY_BASE,
  PUSH_CC_ENCODER_BASE,
  PUSH_CC_ENCODER_TEMPO,
  PUSH_CC_ENCODER_SWING,
  PUSH_CC_ENCODER_MASTER,
} from '$lib/control/push2/push2-map';

const html = () => render(Push2Docs as never, { props: {} } as never).body;

describe('Push2Docs', () => {
  it('renders the parity + additive reference tables', () => {
    const out = html();
    expect(out).toContain('Push 2 control');
    expect(out).toContain('data-testid="push2-parity-table"');
    expect(out).toContain('data-testid="push2-additive-table"');
    // The three additive features are named.
    expect(out).toContain('Select channel 1–8');
    expect(out).toContain('MixMasters ch1–8 volume');
    expect(out).toContain('CLIP-view pitch window');
  });

  it('documents START/STOP moving to the Play button', () => {
    const out = html();
    expect(out).toContain('START / STOP');
    expect(out).toContain(`CC ${PUSH_CC_PLAY}`);
  });

  it('the rendered CC numbers MATCH the real push2-map constants (no doc drift)', () => {
    const out = html();
    // A change to any of these map constants must show up in the doc — the
    // generated tables pull them directly, so the page must carry them.
    expect(out, 'Play CC').toContain(`CC ${PUSH_CC_PLAY}`);
    expect(out, 'Shift CC').toContain(`CC ${PUSH_CC_SHIFT}`);
    expect(out, 'channel-select base CC').toContain(`CC ${PUSH_CC_ABOVE_DISPLAY_BASE}`);
    expect(out, 'encoder base CC').toContain(`CC ${PUSH_CC_ENCODER_BASE}`);
    expect(out, 'Tempo (send1) CC').toContain(`CC ${PUSH_CC_ENCODER_TEMPO}`);
    expect(out, 'Swing (send2) CC').toContain(`CC ${PUSH_CC_ENCODER_SWING}`);
    expect(out, 'Master CC').toContain(`CC ${PUSH_CC_ENCODER_MASTER}`);
    expect(out, 'D-Pad up CC').toContain(`CC ${PUSH_CC_DPAD_UP}`);
    expect(out, 'D-Pad left CC').toContain(`CC ${PUSH_CC_DPAD_LEFT}`);
  });

  it('flags the Phase-1 hardware-confirm + WebUSB-deferred caveats', () => {
    const out = html();
    expect(out).toContain('data-testid="push2-hardware-note"');
    expect(out).toContain('Phase 2'); // the on-device display is deferred
    expect(out).toContain('stock Push palette');
  });
});
