// packages/web/src/lib/audio/modules/sm64.test.ts
//
// Unit tests for the SM64 module def + the CV→playerInput mapping. The
// bundle itself is not loaded here (it lives in /sm64js/sm64js.bundle.js
// at runtime); we only test the pure helpers + the def shape.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  sm64Def,
  cvToStickValue,
  composeSm64PlayerInput,
  shouldAutoDownsample,
  SM64_STICK_MAX,
  SM64_IDB_KEY,
} from './sm64';

describe('sm64 module def', () => {
  it('exposes the expected IO surface', () => {
    expect(sm64Def.type).toBe('sm64');
    expect(sm64Def.domain).toBe('audio');
    expect(sm64Def.label).toBe('SM64');
    expect(sm64Def.maxInstances).toBe(1);
    expect(sm64Def.vizPassthrough).toBe(true);
    // One video output port (`out`) — the bundle's #gameCanvas mirrored
    // each video frame via the cross-domain audio→video bridge so users
    // can patch SM64 → VIDEO OUT / BENTBOX / chain modules.
    expect(sm64Def.outputs.length).toBe(1);
    const outPort = sm64Def.outputs.find((p) => p.id === 'out');
    expect(outPort, 'sm64 must expose an `out` video output port').toBeDefined();
    expect(outPort!.type).toBe('video');
    // One param: the per-source OUTPUT fit/fill toggle (0 = letterbox default).
    expect(sm64Def.params.map((p) => p.id)).toEqual(['fillMode']);
    const fillMode = sm64Def.params.find((p) => p.id === 'fillMode')!;
    expect(fillMode.defaultValue).toBe(0);
    expect(fillMode.curve).toBe('discrete');

    const inputIds = sm64Def.inputs.map((p) => p.id).sort();
    expect(inputIds).toEqual(
      [
        'stick_x_cv', 'stick_y_cv',
        'a_gate', 'b_gate', 'z_gate', 'r_gate',
        'c_up_gate', 'c_down_gate', 'c_left_gate', 'c_right_gate',
        'start_gate',
      ].sort(),
    );

    // Sticks are CV, all others gate. (Matches DOOM's 'cv' typing for the
    // gate-shaped CV ports per the project convention.)
    const stickX = sm64Def.inputs.find((p) => p.id === 'stick_x_cv')!;
    const stickY = sm64Def.inputs.find((p) => p.id === 'stick_y_cv')!;
    expect(stickX.type).toBe('cv');
    expect(stickY.type).toBe('cv');
    for (const id of ['a_gate', 'b_gate', 'z_gate', 'r_gate', 'c_up_gate', 'c_down_gate', 'c_left_gate', 'c_right_gate', 'start_gate']) {
      const port = sm64Def.inputs.find((p) => p.id === id)!;
      expect(port.type, `${id} should be 'gate'`).toBe('gate');
    }
  });

  it('declares attribution to the upstream sm64js (WTFPL)', () => {
    expect(sm64Def.ossAttribution?.author).toContain('sm64js');
    expect(sm64Def.ossAttribution?.author).toContain('WTFPL');
  });

  it('lives in the games category for palette grouping', () => {
    expect(sm64Def.category).toBe('games');
  });
});

describe('cvToStickValue', () => {
  it('maps the bipolar CV range to N64 ±64', () => {
    expect(cvToStickValue(0)).toBe(0);
    expect(cvToStickValue(0.5)).toBe(32);
    expect(cvToStickValue(-0.5)).toBe(-32);
    expect(cvToStickValue(1)).toBe(SM64_STICK_MAX);
    expect(cvToStickValue(-1)).toBe(-SM64_STICK_MAX);
  });

  it('clamps overshoot', () => {
    expect(cvToStickValue(2)).toBe(SM64_STICK_MAX);
    expect(cvToStickValue(-2)).toBe(-SM64_STICK_MAX);
    expect(cvToStickValue(99)).toBe(SM64_STICK_MAX);
  });

  it('rounds the per-step CV (no half-units in the N64 stick range)', () => {
    // 0.123 × 64 = 7.872 → 8
    expect(cvToStickValue(0.123)).toBe(8);
    // -0.123 × 64 = -7.872 → -8
    expect(cvToStickValue(-0.123)).toBe(-8);
  });
});

describe('composeSm64PlayerInput', () => {
  const ALL_OFF = {
    downA: false, downB: false, downZ: false, downStart: false,
    downCl: false, downCr: false, downCu: false, downCd: false, downRt: false,
    pressedA: false, pressedB: false, pressedZ: false, pressedStart: false,
    pressedCl: false, pressedCr: false, pressedCu: false, pressedCd: false, pressedRt: false,
  };

  it('passes through stick values + computes magnitude', () => {
    const input = composeSm64PlayerInput(32, -32, ALL_OFF);
    expect(input.stickX).toBe(32);
    expect(input.stickY).toBe(-32);
    expect(input.stickMag).toBeCloseTo(Math.sqrt(32 * 32 + 32 * 32), 5);
  });

  it('all buttons off → all four banks false', () => {
    const input = composeSm64PlayerInput(0, 0, ALL_OFF);
    expect(input.buttonDownA).toBe(false);
    expect(input.buttonDownB).toBe(false);
    expect(input.buttonPressedA).toBe(false);
    expect(input.buttonPressedStart).toBe(false);
  });

  it('A held → buttonDownA true, buttonPressedA only true on rising edge tick', () => {
    // Frame 1: edge detected → both pressed AND down.
    const frame1 = composeSm64PlayerInput(0, 0, { ...ALL_OFF, downA: true, pressedA: true });
    expect(frame1.buttonDownA).toBe(true);
    expect(frame1.buttonPressedA).toBe(true);

    // Frame 2: still held → down stays true, pressed (edge) clears.
    const frame2 = composeSm64PlayerInput(0, 0, { ...ALL_OFF, downA: true, pressedA: false });
    expect(frame2.buttonDownA).toBe(true);
    expect(frame2.buttonPressedA).toBe(false);

    // Frame 3: released → both false.
    const frame3 = composeSm64PlayerInput(0, 0, ALL_OFF);
    expect(frame3.buttonDownA).toBe(false);
    expect(frame3.buttonPressedA).toBe(false);
  });

  it('maps every gate to its N64 button counterpart', () => {
    const allOn = {
      downA: true, downB: true, downZ: true, downStart: true,
      downCl: true, downCr: true, downCu: true, downCd: true, downRt: true,
      pressedA: true, pressedB: true, pressedZ: true, pressedStart: true,
      pressedCl: true, pressedCr: true, pressedCu: true, pressedCd: true, pressedRt: true,
    };
    const input = composeSm64PlayerInput(0, 0, allOn);
    // 9 down + 9 pressed = 18 button banks; assert each side end-to-end.
    expect(input.buttonDownA).toBe(true);
    expect(input.buttonDownB).toBe(true);
    expect(input.buttonDownZ).toBe(true);
    expect(input.buttonDownStart).toBe(true);
    expect(input.buttonDownCl).toBe(true);
    expect(input.buttonDownCr).toBe(true);
    expect(input.buttonDownCu).toBe(true);
    expect(input.buttonDownCd).toBe(true);
    expect(input.buttonDownRt).toBe(true);
    expect(input.buttonPressedA).toBe(true);
    expect(input.buttonPressedB).toBe(true);
    expect(input.buttonPressedZ).toBe(true);
    expect(input.buttonPressedStart).toBe(true);
    expect(input.buttonPressedCl).toBe(true);
    expect(input.buttonPressedCr).toBe(true);
    expect(input.buttonPressedCu).toBe(true);
    expect(input.buttonPressedCd).toBe(true);
    expect(input.buttonPressedRt).toBe(true);
  });
});

describe('shouldAutoDownsample', () => {
  it('downsamples on narrow viewport', () => {
    expect(shouldAutoDownsample(16, true)).toBe(true);  // narrow wins regardless of cores
    expect(shouldAutoDownsample(4, true)).toBe(true);
  });

  it('downsamples on low core count', () => {
    expect(shouldAutoDownsample(4, false)).toBe(true);
    expect(shouldAutoDownsample(7, false)).toBe(true);
  });

  it('stays at full res on a wide viewport with 8+ cores', () => {
    expect(shouldAutoDownsample(8, false)).toBe(false);
    expect(shouldAutoDownsample(16, false)).toBe(false);
  });
});

describe('Sm64Card bridge wiring (regression: post-extract white-screen)', () => {
  // The audio-domain factory in this file calls `bridge.autoStart()` to drive
  // the bundle's #startbutton click after the ROM lands in IDB. If the card
  // gates `autoStart` assignment behind a condition that's false at prod
  // runtime (it once gated it on a rAF-capture probe that only matched an
  // UNMINIFIED upstream bundle — our prod bundle is minified so the probe
  // never fired, leaving autoStart undefined and Extract → white-screen), the
  // factory has nothing to call and the game never starts.
  //
  // This test asserts the source-code contract: `__sm64.autoStart` is wired
  // UNCONDITIONALLY (no surrounding `if (capturedOnAnimFrame)` or
  // equivalent guard) so the post-Extract auto-start path always works.
  const CARD_SRC = fs.readFileSync(
    path.resolve(__dirname, '../../ui/modules/Sm64Card.svelte'),
    'utf8',
  );

  it('assigns bridge.autoStart unconditionally (no rAF-capture guard)', () => {
    // Locate the autoStart assignment.
    const idx = CARD_SRC.indexOf('w.__sm64.autoStart =');
    expect(idx, 'card must assign __sm64.autoStart').toBeGreaterThan(0);

    // The 400 chars immediately preceding the assignment must NOT contain a
    // runtime guard on `capturedOnAnimFrame` (the rAF probe that fails on a
    // minified bundle). Comments mentioning it are fine; we strip block
    // comments + line comments before searching.
    const window = CARD_SRC.slice(Math.max(0, idx - 400), idx);
    const codeWindow = window
      .replace(/\/\*[\s\S]*?\*\//g, '')         // strip /* ... */
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');   // strip // line comments
    expect(
      codeWindow.includes('capturedOnAnimFrame'),
      'autoStart must NOT be inside a capturedOnAnimFrame conditional — that '
        + 'condition is false on the minified prod bundle, leaving autoStart '
        + 'undefined and Extract → white-screen.',
    ).toBe(false);
  });

  it('flips bridge.gameStarted when autoStart fires', () => {
    // After clicking #startbutton the bundle is in the "running game" state.
    // The audio factory's snapshot.read('snapshot') reflects gameStarted from
    // __sm64.gameStarted — the card must set it true inside autoStart so the
    // snapshot + e2e contract holds.
    const startblock = CARD_SRC.indexOf('w.__sm64.autoStart =');
    expect(startblock).toBeGreaterThan(0);
    // Look forward through the autoStart block (well past the docstring
    // that landed with the autoStartedOnce mirror). Strip comments first
    // so a comment mentioning the assignment can't mask a missing one.
    const tail = CARD_SRC.slice(startblock, startblock + 2000)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
    expect(
      /__sm64\.gameStarted\s*=\s*true/.test(tail),
      'autoStart must set __sm64.gameStarted = true so the engine snapshot '
        + 'reports the running-game state.',
    ).toBe(true);
  });

  it('flips bridge.autoStartedOnce when autoStart fires (one-shot boot guard)', () => {
    // The factory now consults `autoStartedOnce` (NOT `gameStarted`) as
    // the re-click guard. The card must set it true inside autoStart so
    // the very first synthetic-boot START edge clicks #startbutton and
    // every subsequent edge skips the click + flows through
    // playerInput.buttonPressedStart for the in-game title-advance path.
    const startblock = CARD_SRC.indexOf('w.__sm64.autoStart =');
    expect(startblock).toBeGreaterThan(0);
    const tail = CARD_SRC.slice(startblock, startblock + 2000)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
    expect(
      /__sm64\.autoStartedOnce\s*=\s*true/.test(tail),
      'autoStart must set __sm64.autoStartedOnce = true so the factory\'s '
        + 'one-shot guard prevents location.reload() on every post-boot '
        + 'START gate edge.',
    ).toBe(true);
  });

  it('wires bridge.gameCanvas so the audio factory can plumb video out', () => {
    // The sm64 factory's drawFrame() (videoSources `out` entry) reads
    // from `window.__sm64.gameCanvas` each video frame. The card must
    // assign the gameCanvasEl ref into the bridge after the bundle loads
    // (the canvas binding fires before onMount, so the ref is live by
    // the time loadBundle finishes).
    expect(
      CARD_SRC.includes('__sm64.gameCanvas = gameCanvasEl')
        || CARD_SRC.includes('w.__sm64.gameCanvas = gameCanvasEl'),
      'card must wire __sm64.gameCanvas = gameCanvasEl so the sm64 factory '
        + 'drawFrame() can blit each frame into the cross-domain video '
        + 'bridge for the `out` (video) output port.',
    ).toBe(true);
  });
});

describe('sm64 factory: start_gate fires #startbutton EXACTLY ONCE (autoStartedOnce guard)', () => {
  // Regression for the title→gameplay "Start doesn't advance Mario" bug.
  //
  // The bundle's `#startbutton` click handler is:
  //   addEventListener('click', () => gameStarted ? location.reload() : startGame())
  // Once startGame() has run (the boot auto-start after ROM extract), the
  // bundle's internal `gameStarted` flips true. Any subsequent click —
  // including a synthetic one fired from our factory tick on a START gate
  // edge — calls `location.reload()`, which in our embedded card context
  // reloads the entire patchtogether app.
  //
  // PR #424 guarded `bridge.autoStart()` behind `bridge.gameStarted !== true`,
  // which fixed the reload-crash but ALSO broke the user's title→gameplay
  // transition: the boot autoStart set `gameStarted = true`, so the user's
  // first manual START edge was blocked entirely → Mario's title head
  // stayed, no level loaded.
  //
  // Fix: separate `autoStartedOnce` flag for the ONE-SHOT boot click;
  // `gameStarted` is now a pure UI-snapshot mirror that does NOT gate
  // re-clicks. The bundle's title-advance / pause logic reads
  // `playerInput.buttonPressedStart` directly (independent of the HTML
  // button), so the user's manual START edges flow through
  // `bridge.setPlayerInput` and reach the in-game Start path without
  // any #startbutton re-click.
  const FACTORY_SRC = fs.readFileSync(
    path.resolve(__dirname, './sm64.ts'),
    'utf8',
  );

  it('guards the bridge.autoStart() call with `autoStartedOnce !== true`', () => {
    // Strip comments so a comment containing "autoStart" doesn't match.
    const code = FACTORY_SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');

    // The factory should have EXACTLY one `bridge.autoStart()` call (the
    // start_gate edge handler). If a future refactor adds a second one,
    // this test fails loudly and the refactor needs to re-check both for
    // the autoStartedOnce guard.
    const calls = code.match(/bridge\.autoStart\(\)/g) ?? [];
    expect(calls.length, 'expected exactly one bridge.autoStart() call site').toBe(1);

    // Find the call and look at the 350 chars immediately preceding it.
    // That window must contain an `autoStartedOnce !== true` (or
    // equivalent `!autoStartedOnce`) guard so the click fires exactly
    // once — on boot — and never again on post-boot START edges.
    const idx = code.indexOf('bridge.autoStart()');
    expect(idx).toBeGreaterThan(0);
    const window = code.slice(Math.max(0, idx - 350), idx);
    const hasGuard =
      /autoStartedOnce\s*!==\s*true/.test(window) ||
      /!\s*bridge[?.]*\.autoStartedOnce/.test(window) ||
      /!\s*w[?.]*__sm64[?.]*\.autoStartedOnce/.test(window);
    expect(
      hasGuard,
      'bridge.autoStart() MUST be guarded by `autoStartedOnce !== true` (or !autoStartedOnce) — '
        + 'one-shot boot click only. The user\'s manual START gate edges advance '
        + 'the title via playerInput.buttonPressedStart (in-game logic), NOT '
        + 'via a #startbutton re-click (which would location.reload()).',
    ).toBe(true);
  });

  it('does NOT consult `gameStarted` as a re-click guard (post-#424 regression)', () => {
    const code = FACTORY_SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
    const idx = code.indexOf('bridge.autoStart()');
    expect(idx).toBeGreaterThan(0);
    const window = code.slice(Math.max(0, idx - 350), idx);
    // The previous (PR #424) guard `bridge.gameStarted !== true` ended up
    // blocking every post-boot START gate edge because the boot autoStart
    // also flipped `gameStarted = true`. Forbid that exact text shape from
    // returning to the call site.
    expect(
      /bridge\??\.gameStarted\s*!==\s*true/.test(window),
      'bridge.gameStarted must NOT gate the autoStart() call (PR #424 '
        + 'regression: boot autoStart flipped gameStarted=true → user\'s '
        + 'first manual START edge was incorrectly blocked → Mario title '
        + 'never advanced). Use autoStartedOnce instead.',
    ).toBe(false);
  });

  it('still surfaces buttonPressedStart through playerInput on every START edge', () => {
    // Sanity: the START → N64 button mapping is independent of the
    // autoStart guard. composeSm64PlayerInput preserves buttonPressedStart
    // unconditionally so the bundle's `intro_regular` (window.playerInput.
    // buttonPressedStart) advances the title even after gameStarted=true.
    const ALL_OFF = {
      downA: false, downB: false, downZ: false, downStart: false,
      downCl: false, downCr: false, downCu: false, downCd: false, downRt: false,
      pressedA: false, pressedB: false, pressedZ: false, pressedStart: false,
      pressedCl: false, pressedCr: false, pressedCu: false, pressedCd: false, pressedRt: false,
    };
    const pressedStart = composeSm64PlayerInput(0, 0, { ...ALL_OFF, downStart: true, pressedStart: true });
    expect(pressedStart.buttonPressedStart).toBe(true);
    expect(pressedStart.buttonDownStart).toBe(true);
  });
});

describe('sm64 factory: video output (videoSources `out`)', () => {
  // The factory's `out` (video) port flows through the cross-domain
  // audio→video bridge as a `videoSources` entry with a `drawFrame`
  // callback that blits the bundle's #gameCanvas onto the bridge canvas
  // each video frame. The bridge then uploads the painted canvas to a GL
  // texture for downstream video consumers (VIDEO OUT, BENTBOX, ...).
  it('source-level: factory wires videoSources `out` with a drawFrame', () => {
    const FACTORY_SRC = fs.readFileSync(
      path.resolve(__dirname, './sm64.ts'),
      'utf8',
    );
    // The factory must build a videoSources Map keyed by 'out'.
    expect(
      /videoSources:\s*new\s+Map\([\s\S]*?\['out'/.test(FACTORY_SRC),
      'factory must populate videoSources.out so the cross-domain bridge '
        + 'picks up the SM64 frame as a patchable video source.',
    ).toBe(true);
    // And it must pass a drawFrame callback (not just an analyser-only
    // entry — the bundle's framebuffer is a DOM canvas, not an audio
    // analyser).
    expect(
      /\['out',\s*\{[^}]*drawFrame/.test(FACTORY_SRC),
      'videoSources.out must include a drawFrame callback so the bridge '
        + 'reads SM64\'s painted #gameCanvas instead of running the GL '
        + 'waveform renderer (which would only show silence).',
    ).toBe(true);
  });
});

describe('SM64 constants', () => {
  it('matches the upstream IDB key', () => {
    // The upstream's romTextureLoader.js stores ROM-extracted assets at
    // `IDB.set('assets', msgpack.encode(data))`. Drift here would silently
    // break the auto-start arming + the e2e fixture-seed path.
    expect(SM64_IDB_KEY).toBe('assets');
  });

  it('SM64_STICK_MAX is the N64-native 64', () => {
    expect(SM64_STICK_MAX).toBe(64);
  });
});
