// packages/web/src/lib/control/push2/push2-sysex.test.ts
//
// Golden-vector tests for the PURE Ableton Push 2 User-mode codec. Every byte
// sequence is pinned to the Push 2 MIDI/Display interface spec + ffont/push2-
// python, so a drift in the protocol numbers fails here before it reaches
// hardware.
import { describe, it, expect } from 'vitest';
import {
  PUSH2_MFR_ID,
  PUSH2_DEVICE_MODEL,
  PUSH_WIDTH,
  PUSH_HEIGHT,
  PUSH_PAD_BASE,
  clamp7,
  pushPadNote,
  pushNoteToPad,
  decodeRelativeCc,
  pushColorIndex,
  pushColorHue,
  pushColorTier,
  PUSH_PALETTE_HUES,
  PUSH_BRIGHT_PEAK_MIN,
  encodeSetLiveMode,
  encodeSetUserMode,
  encodeEnterUserMode,
  encodeExitUserMode,
  encodePadColor,
  encodeButtonLed,
  decodePush2Message,
  isPush2Sysex,
} from './push2-sysex';
// Namespace import: the tier sweep reflects over EVERY `RGB_*` this module
// exports, so a colour added later is covered without touching this file.
import * as LPMap from '$lib/control/launchpad/launchpad-map';

describe('Push 2 protocol constants', () => {
  it('uses the Ableton manufacturer id 00 21 1D + device/model 01 01', () => {
    expect([...PUSH2_MFR_ID]).toEqual([0x00, 0x21, 0x1d]);
    expect([...PUSH2_DEVICE_MODEL]).toEqual([0x01, 0x01]);
  });
  it('is an 8×8 grid based at note 36', () => {
    expect(PUSH_WIDTH).toBe(8);
    expect(PUSH_HEIGHT).toBe(8);
    expect(PUSH_PAD_BASE).toBe(36);
  });
});

describe('pushPadNote / pushNoteToPad (36..99, bottom-left origin)', () => {
  it('maps the four corners', () => {
    expect(pushPadNote(0, 0)).toBe(36); // bottom-left
    expect(pushPadNote(7, 0)).toBe(43); // bottom-right
    expect(pushPadNote(0, 7)).toBe(92); // top-left
    expect(pushPadNote(7, 7)).toBe(99); // top-right
  });
  it('round-trips every grid cell', () => {
    for (let y = 0; y < PUSH_HEIGHT; y++) {
      for (let x = 0; x < PUSH_WIDTH; x++) {
        expect(pushNoteToPad(pushPadNote(x, y))).toEqual({ x, y });
      }
    }
  });
  it('rejects non-grid notes', () => {
    expect(pushNoteToPad(35)).toBeNull(); // below the grid
    expect(pushNoteToPad(100)).toBeNull(); // above the grid
    expect(pushNoteToPad(0)).toBeNull();
  });
  it('clamps out-of-range coords defensively', () => {
    expect(pushPadNote(-1, -1)).toBe(36);
    expect(pushPadNote(99, 99)).toBe(99);
  });
});

describe('decodeRelativeCc (relative 2s-complement)', () => {
  it('decodes clockwise (1..63) as positive', () => {
    expect(decodeRelativeCc(1)).toBe(1);
    expect(decodeRelativeCc(63)).toBe(63);
  });
  it('decodes counter-clockwise (64..127) as negative', () => {
    expect(decodeRelativeCc(127)).toBe(-1);
    expect(decodeRelativeCc(65)).toBe(-63);
    expect(decodeRelativeCc(64)).toBe(-64);
  });
  it('zero = no motion', () => {
    expect(decodeRelativeCc(0)).toBe(0);
  });
});

describe('pushColorIndex (stock-palette, hue + brightness tier)', () => {
  it('snaps the research-confirmed anchors', () => {
    expect(pushColorIndex(0, 0, 0)).toBe(0); // black / off
    expect(pushColorIndex(127, 0, 0)).toBe(127); // red
    expect(pushColorIndex(0, 127, 0)).toBe(126); // green
    expect(pushColorIndex(0, 0, 127)).toBe(125); // blue
    expect(pushColorIndex(127, 127, 127)).toBe(122); // white
  });
  it('a near-black colour maps to the DIM tier of its hue — never to off', () => {
    // REWRITTEN INTENT. This used to read "maps to off/dim, not a bright hue"
    // and accepted `0`, which codified half of the bug the owner reported: going
    // OFF is exactly what a lit-but-dim colour must not do. Only true black is 0.
    expect(pushColorIndex(3, 3, 3)).not.toBe(0);
    expect(pushColorIndex(3, 3, 3)).toBe(1); // the shipped dim neutral
    expect(pushColorTier(3, 3, 3)).toBe('dim');
    // …and it is still not a BRIGHT hue, which is what the old name was after.
    expect(pushColorIndex(3, 3, 3)).not.toBe(pushColorIndex(127, 127, 127));
  });

  it('ONLY true black is off — every non-black colour stays lit', () => {
    expect(pushColorIndex(0, 0, 0)).toBe(0);
    // Sweep the whole cube coarsely; a single non-zero component must light.
    for (let r = 0; r <= 127; r += 1) {
      expect(pushColorIndex(r, 0, 0) === 0).toBe(r === 0);
      expect(pushColorIndex(0, r, 0) === 0).toBe(r === 0);
      expect(pushColorIndex(0, 0, r) === 0).toBe(r === 0);
    }
  });

  it('HUE is preserved across brightness — dim and bright of one colour agree', () => {
    // The property the old flat nearest-anchor search could not hold: it searched
    // hue and brightness together, so dimming a colour walked it onto black.
    for (const h of PUSH_PALETTE_HUES) {
      const [r, g, b] = h.rgb;
      for (const f of [1, 0.6, 0.3, 0.12]) {
        const scaled: [number, number, number] = [
          Math.round(r * f), Math.round(g * f), Math.round(b * f),
        ];
        expect(pushColorHue(...scaled).name, `${h.name} at ${f}× must stay ${h.name}`).toBe(h.name);
        expect(pushColorIndex(...scaled), `${h.name} at ${f}× must stay lit`).not.toBe(0);
      }
    }
  });

  it('the three tiers of a hue are distinct indices', () => {
    for (const h of PUSH_PALETTE_HUES) {
      expect(new Set([h.bright, h.mid, h.dim]).size, `${h.name} tiers must not collide`).toBe(3);
    }
    // …and no two hues share an index, or two different colours would be one LED.
    const all = PUSH_PALETTE_HUES.flatMap((h) => [h.bright, h.mid, h.dim]);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(0); // 0 is reserved for OFF
  });

  // ── THE INSTRUMENT CHECK ────────────────────────────────────────────────
  // The tier cuts (95 / 55) are a claim ABOUT the colours launchpad-map paints,
  // so they are verified against those colours rather than asserted in a comment.
  // Anchored to the ARTIFACT: it reflects over every `RGB_*` the module exports,
  // so a colour added later is swept automatically and a new one that lands on
  // the wrong side of a cut fails here instead of silently reading as its own
  // opposite on the hardware.
  describe('tier cuts, swept over every colour launchpad-map exports', () => {
    const COLOURS = Object.entries(LPMap).filter(
      (e): e is [string, [number, number, number]] =>
        e[0].startsWith('RGB_') &&
        Array.isArray(e[1]) &&
        e[1].length === 3 &&
        e[1].every((n) => typeof n === 'number'),
    );

    it('sweeps a non-trivial number of colours (guards the reflection itself)', () => {
      // If the filter ever stops matching, every assertion below passes vacuously.
      expect(COLOURS.length).toBeGreaterThan(50);
    });

    it('no lit colour is extinguished', () => {
      const dark = COLOURS.filter(([, rgb]) => rgb.some((c) => c > 0) && pushColorIndex(...rgb) === 0);
      expect(dark.map(([n]) => n)).toEqual([]);
    });

    it('every ON/OFF and BRIGHT/DIM pair lands on distinct indices', () => {
      // The named pairs are the ones whose whole purpose is to encode a state.
      const PAIRS: readonly (readonly [string, string])[] = [
        ['RGB_SCENE', 'RGB_SCENE_DIM'],
        ['RGB_STOP_ACTIVE', 'RGB_STOP_IDLE'],
        ['RGB_VIEW_ACTIVE', 'RGB_VIEW_IDLE'],
        ['RGB_SHIFT_HELD', 'RGB_SHIFT_OFF'],
        ['RGB_SYS', 'RGB_SYS_DIM'],
        ['RGB_PATTERN_ARMED', 'RGB_PATTERN'],
        ['RGB_TIMING_ARMED', 'RGB_TIMING'],
        ['RGB_MONO_ON', 'RGB_MONO_OFF'],
        ['RGB_MUTE_ON', 'RGB_MUTE_OFF'],
        ['RGB_FUNC_ON', 'RGB_FUNC'],
        ['RGB_FUNC', 'RGB_FUNC_DIM'],
        ['RGB_DECK_EDIT_ON', 'RGB_DECK_EDIT'],
        ['RGB_DECK_COPY_ON', 'RGB_DECK_COPY'],
        ['RGB_DECK_NOW_ON', 'RGB_DECK_NOW'],
        ['RGB_DECK_LEN_ON', 'RGB_DECK_LEN'],
        ['RGB_DECK_DBL_ON', 'RGB_DECK_DBL'],
        ['RGB_QREC_ARMED', 'RGB_QREC_IDLE'],
        ['RGB_OD_ON', 'RGB_OD'],
        ['RGB_KEYS_REC_HOLD_ON', 'RGB_KEYS_REC_HOLD'],
        ['RGB_KEYS_OD_HOLD_ON', 'RGB_KEYS_OD_HOLD'],
        ['RGB_RECORDING', 'RGB_RECORDING_DIM'],
        ['RGB_PLAYING', 'RGB_PLAYING_DIM'],
        ['RGB_COPY_BUFFER', 'RGB_COPY_BUFFER_DIM'],
        ['RGB_COPY_BUFFER_SCENE', 'RGB_COPY_BUFFER_SCENE_DIM'],
        ['RGB_SONG_ARRANGE', 'RGB_SONG_SESSION'],
        ['RGB_LEN_END', 'RGB_LEN_BLOCK'],
        ['RGB_KEYS_PH_CUR', 'RGB_KEYS_PH_BASE'],
      ];
      const byName = new Map(COLOURS);
      const collisions: string[] = [];
      for (const [onName, offName] of PAIRS) {
        const on = byName.get(onName);
        const off = byName.get(offName);
        // Anchor to the artifact: a pair naming a colour that no longer exists is
        // a RED, not a silent skip.
        expect(on, `${onName} is named here but no longer exported`).toBeDefined();
        expect(off, `${offName} is named here but no longer exported`).toBeDefined();
        const a = pushColorIndex(...on!);
        const b = pushColorIndex(...off!);
        if (a === b) {
          collisions.push(
            `${onName}(peak ${Math.max(...on!)}, ${pushColorTier(...on!)}) === ` +
              `${offName}(peak ${Math.max(...off!)}, ${pushColorTier(...off!)}) → both idx ${a}`,
          );
        }
      }
      expect(collisions).toEqual([]);
    });

    it('the cuts sit in a real gap — moving either one breaks a pair', () => {
      // NEGATIVE CONTROL on the thresholds themselves: prove they are load-bearing
      // rather than two numbers that happen not to fail. A two-tier mapping (no
      // MID) collapses RGB_MONO_ON onto RGB_MONO_OFF, which is why there are three.
      const twoTier = (rgb: readonly [number, number, number]) => {
        const peak = Math.max(...rgb);
        if (peak === 0) return 0;
        const h = pushColorHue(...rgb);
        return peak > PUSH_BRIGHT_PEAK_MIN ? h.bright : h.dim;
      };
      const monoOn = (LPMap.RGB_MONO_ON as [number, number, number]);
      const monoOff = (LPMap.RGB_MONO_OFF as [number, number, number]);
      expect(twoTier(monoOn), 'a two-tier map must collide here').toBe(twoTier(monoOff));
      expect(pushColorIndex(...monoOn), 'the three-tier map must not').not.toBe(
        pushColorIndex(...monoOff),
      );
    });
  });
  it('clamp7 clamps to 0..127', () => {
    expect(clamp7(-5)).toBe(0);
    expect(clamp7(200)).toBe(127);
    expect(clamp7(63.4)).toBe(63);
    expect(clamp7(NaN)).toBe(0);
  });
});

describe('mode set (golden vectors)', () => {
  it('LIVE = F0 00 21 1D 01 01 0A 00 F7 (last data byte 00 = Live — the default we bind)', () => {
    expect([...encodeSetLiveMode()]).toEqual([0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01, 0x0a, 0x00, 0xf7]);
  });
  it('USER = F0 00 21 1D 01 01 0A 01 F7 (last data byte 01 = User — reserved future toggle)', () => {
    expect([...encodeSetUserMode()]).toEqual([0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01, 0x0a, 0x01, 0xf7]);
  });
  it('the deprecated aliases mirror the mode setters', () => {
    expect([...encodeExitUserMode()]).toEqual([...encodeSetLiveMode()]);
    expect([...encodeEnterUserMode()]).toEqual([...encodeSetUserMode()]);
  });
});

describe('LED encoders (golden vectors)', () => {
  it('encodePadColor = Note-On <note> <paletteIndex>', () => {
    expect([...encodePadColor(36, 126)]).toEqual([0x90, 36, 126]);
    expect([...encodePadColor(99, 0)]).toEqual([0x90, 99, 0]);
  });
  it('encodeButtonLed = CC <cc> <value>', () => {
    expect([...encodeButtonLed(85, 127)]).toEqual([0xb0, 85, 127]);
  });
  it('clamps LED values', () => {
    expect([...encodePadColor(36, 999)]).toEqual([0x90, 36, 127]);
  });
});

describe('decodePush2Message (RX)', () => {
  it('decodes a pad press → (x,y) + velocity', () => {
    expect(decodePush2Message([0x90, 36, 100])).toEqual({ type: 'pad', x: 0, y: 0, s: 1, velocity: 100 });
    expect(decodePush2Message([0x90, 99, 64])).toEqual({ type: 'pad', x: 7, y: 7, s: 1, velocity: 64 });
  });
  it('decodes a pad release (Note-Off + Note-On vel 0)', () => {
    expect(decodePush2Message([0x80, 43, 0])).toEqual({ type: 'pad', x: 7, y: 0, s: 0, velocity: 0 });
    expect(decodePush2Message([0x90, 43, 0])).toEqual({ type: 'pad', x: 7, y: 0, s: 0, velocity: 0 });
  });
  it('decodes a CC (button / encoder) with its raw value + press flag', () => {
    expect(decodePush2Message([0xb0, 85, 127])).toEqual({ type: 'cc', cc: 85, s: 1, value: 127 });
    expect(decodePush2Message([0xb0, 71, 1])).toEqual({ type: 'cc', cc: 71, s: 1, value: 1 }); // encoder +1
    expect(decodePush2Message([0xb0, 85, 0])).toEqual({ type: 'cc', cc: 85, s: 0, value: 0 });
  });
  it('returns null for malformed / uninteresting messages', () => {
    expect(decodePush2Message([0x90, 36])).toBeNull(); // too short
    expect(decodePush2Message([0xf8])).toBeNull(); // a clock byte
    expect(decodePush2Message([0x90, 35, 100])).toBeNull(); // note below the grid
  });
});

describe('isPush2Sysex', () => {
  it('matches our device header only', () => {
    expect(isPush2Sysex(encodeEnterUserMode())).toBe(true);
    expect(isPush2Sysex([0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x0e, 0x01, 0xf7])).toBe(false); // a Launchpad frame
    expect(isPush2Sysex([0xf0, 0x00, 0x00])).toBe(false);
    expect(isPush2Sysex([0x90, 36, 100])).toBe(false); // not even SysEx
  });
});
