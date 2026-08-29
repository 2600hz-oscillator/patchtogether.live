// packages/web/src/lib/ui/modules/gibribbon-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the rewritten GIBRIBBON surface.
//
// The rewrite rests on claims no shared gate can check, and every one of them
// reads as true whether or not it is:
//
//   1. "The lane tile paints the LIVE GAME." Video domain is the WHOLE
//      condition (`hasVideoSurface`), and `glyph: 'none'` is mandatory — a
//      wrong literal is a trace that can never render.
//   2. "The face adds no resting numbers of its own." The HUD is painted INTO
//      the frame by the module's rasteriser; `face-resting-text-source` names
//      its own blind spot (canvas text + module-owned body markup), so this
//      file plus the dock VRT baseline are the only things that look. NO spec
//      claim that a shared gate holds this line, because none can.
//   3. "ONE clock, one judge." The game advances ONLY in the scheduler tick;
//      draw() renders. A second stepping site is the #635 class returning.
//   4. "The determinism pins can actually pin." A dead pin produces a
//      perfectly plausible picture — a different one per boot.
//   5. "Persistence survives the rewrite." Every pre-rewrite port and param
//      id still exists (the M5 bar), and `autoplay` keeps its id under
//      attract semantics (Q3).
//
// The GAME FEEL itself is pinned in gibribbon-engine.test.ts and the F1
// property in gibribbon-liveness.test.ts — nothing here wiggles a knob.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gibribbonDef } from '$lib/video/modules/gibribbon';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { noUserControlIds } from '$lib/ui/workflow/no-user-control';
import type { NoUserControlDefLike } from '$lib/graph/types';

const FACE = gibribbonDef.face!;
const DECLARED: readonly string[] = gibribbonDef.params.map((p) => p.id);

const ENGINE = readFileSync(
  new URL('../../video/modules/gibribbon-engine.ts', import.meta.url),
  'utf8',
);
const DEF_SRC = readFileSync(new URL('../../video/modules/gibribbon.ts', import.meta.url), 'utf8');
const BODY = readFileSync(new URL('./gibribbon/GibribbonBody.svelte', import.meta.url), 'utf8');
const SCREEN = readFileSync(new URL('./gibribbon/GibribbonScreen.svelte', import.meta.url), 'utf8');
const CARD = readFileSync(new URL('./GibribbonCard.svelte', import.meta.url), 'utf8');

/** Everything between `</script>` and `<style>` — the rendered DOM, as source. */
function markupOf(svelte: string): string {
  const start = svelte.indexOf('</script>');
  const end = svelte.lastIndexOf('<style>');
  expect(start, 'the component must have a script block').toBeGreaterThan(-1);
  return svelte.slice(start + '</script>'.length, end === -1 ? undefined : end);
}

/** The LITERAL TEXT the DOM would contain — tags, comments and Svelte
 *  interpolations removed (the frogger extractor, comments stripped FIRST). */
function literalTextOf(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('gibribbon — promoted and complete', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('gibribbon')).toBe(true);
    expect(migrated('gibribbon')).toBe(true);
  });

  it('ranks the three player controls; every CV-target param is declared noUserControl', () => {
    expect([...FACE.order]).toEqual(['difficulty', 'tempo', 'autoplay']);
    const noControl = noUserControlIds(gibribbonDef as NoUserControlDefLike);
    const orderSet = new Set(FACE.order);
    for (const id of DECLARED) {
      const ranked = orderSet.has(id);
      const declared = noControl.has(id);
      expect(ranked || declared, `param '${id}' must be ranked OR noUserControl`).toBe(true);
      expect(ranked && declared, `param '${id}' must not be BOTH`).toBe(false);
    }
    // 13 jack-written params, every one anchored to a cv-port writer.
    expect(noControl.size).toBe(13);
    for (const e of gibribbonDef.noUserControl ?? []) expect(e.writer).toBe('cv-port');
  });

  it('Q3: the ATTRACT toggle KEEPS the persisted `autoplay` id (label says Attract)', () => {
    const p = gibribbonDef.params.find((x) => x.id === 'autoplay');
    expect(p).toBeTruthy();
    expect(p!.label.toLowerCase()).toContain('attract');
    expect(p!.defaultValue).toBe(1);
  });
});

describe('gibribbon — CLAIM 1: the lane tile is the LIVE GAME (video domain)', () => {
  it('the def is VIDEO-domain, which is the WHOLE lane-picture condition', () => {
    expect(gibribbonDef.domain).toBe('video');
    expect(hasVideoSurface(gibribbonDef)).toBe(true);
    expect(laneGlyphFor(gibribbonDef)).toBe('picture');
  });

  it('NEGATIVE CONTROL: the predicate is the domain and only the domain', () => {
    expect(hasVideoSurface({ domain: 'audio' } as never)).toBe(false);
  });

  it('`glyph: "none"` is declared — any other literal is a trace that can never render', () => {
    // `laneGlyphFor` takes the hasVideoSurface branch BEFORE consulting
    // face.glyph, so a declared scope/meter would be dead data (the nibbles
    // §2.1 rule).
    expect(FACE.glyph).toBe('none');
  });

  it('the extension carries the game screen to the dock, and monitor mode is declared', () => {
    expect(FACE.extension).toBe('gibribbon');
    expect(FACE.monitor?.why).toContain('video output');
  });
});

describe('gibribbon — CLAIM 2: the face adds NO resting numbers of its own', () => {
  // ⚠ THE RULING AND ITS ENFORCEMENT GAP, STATED HONESTLY (GAMES.md §1):
  // score/combo INSIDE the playfield canvas are the game's own artwork —
  // allowed; a chrome row beside it is the refused hero-readout shape.
  // `face-resting-text-source` cannot see either (its stated blind spot), so
  // THIS block and the dock VRT baseline are the only things that look.
  it('the HUD is painted by the MODULE, into the frame (score, combo, ATTRACT, GAME OVER)', () => {
    expect(DEF_SRC).toMatch(/drawText\(score,/);
    expect(DEF_SRC).toMatch(/`SCORE \$\{state\.score\}`/);
    expect(DEF_SRC).toMatch(/drawText\(t, .*ATTRACT|'ATTRACT'/);
    expect(DEF_SRC).toContain("const t = 'ATTRACT';");
    expect(DEF_SRC).toContain("const t = 'GAME OVER';");
  });

  it('body + screen render ONLY control captions as literal text', () => {
    const bodyText = literalTextOf(markupOf(BODY));
    // SCREEN ON/OFF + MONITOR are the body's captions (state word comes from
    // the {ternary} interpolation, stripped here).
    expect(bodyText).toBe('SCREEN MONITOR');
    const screenText = literalTextOf(markupOf(SCREEN));
    expect(
      screenText,
      'the only text beside the playfield must be the RESET caption and the WAD lamp caption — '
        + 'a score pill, a health word or a combo readout here is the refused hero-readout shape',
    ).toBe('RESET WAD');
  });

  it('NEGATIVE CONTROL: the extractor can SEE an added chrome row', () => {
    const withRow = markupOf(SCREEN).replace(
      '<div class="controls nodrag">',
      '<span>SCORE 1240</span><div class="controls nodrag">',
    );
    expect(literalTextOf(withRow)).toContain('SCORE 1240');
  });

  it('no element carries a score-like class anywhere on either surface', () => {
    for (const [name, src] of [['body', BODY], ['screen', SCREEN], ['card', CARD]] as const) {
      expect(markupOf(src), `${name}: no .score/.hud chrome element`).not.toMatch(/class="[^"]*\b(score|hud|combo|health)\b/);
    }
  });

  it('the derived numbers reach the a11y tree ONLY, never the DOM as content', () => {
    const markup = markupOf(SCREEN);
    expect(markup).toMatch(/aria-label=\{ariaLabel\}/);
    expect(markup).not.toMatch(/>\s*\{ariaLabel\}/);
    expect(markup).not.toMatch(/aria-valuetext/);
  });
});

describe('gibribbon — CLAIM 3: ONE clock — the scheduler tick steps, draw renders', () => {
  it('the game is stepped from the FACTORY scheduler subscription only', () => {
    expect(DEF_SRC).toMatch(/getSchedulerClock\(\)\.subscribe\(tick\)/);
    // Exactly ONE call site of the stepper in the shell.
    const calls = DEF_SRC.match(/\bstep\(state,/g) ?? [];
    // step(state, IDLE_INPUTS, …) in the pin + step(state, inputs, …) in the
    // tick — and NOTHING else. draw() must never appear near a step call.
    expect(calls.length).toBe(2);
    expect(DEF_SRC).toMatch(/draw\(frame\) \{\n\s+\/\/ ⚠ RENDER ONLY/);
  });

  it('setParam is a sampling seam, not a second clock — edges are QUEUED', () => {
    expect(DEF_SRC).toMatch(/pendingClockEdges \+= 1/);
    expect(DEF_SRC).toMatch(/pendingButtons\.push/);
    // The old design's defect shape: judging or ticking inside setParam.
    const setParamBlock = DEF_SRC.slice(DEF_SRC.indexOf('setParam(paramId, value)'));
    expect(setParamBlock).not.toMatch(/judgePress\(/);
    expect(setParamBlock).not.toMatch(/courseTick\(/);
  });

  it('the ENGINE has no wall clock and no ambient randomness (the determinism floor)', () => {
    // Comments stripped: the header PROSE names Math.random precisely to say
    // it is absent, and a raw grep would read that as a violation.
    const code = stripSourceComments(ENGINE);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/performance\.now/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/requestAnimationFrame/);
  });

  it('the surfaces only READ — no write path into the engine from a picture', () => {
    for (const [name, src] of [['body', BODY], ['screen', SCREEN]] as const) {
      expect(src, `${name}: no eng.write`).not.toMatch(/eng\.write\(/);
      expect(src, `${name}: no eng.setParam`).not.toMatch(/eng\.setParam\(/);
    }
    // The screen's input path goes through extras.pushButton/pushRestart —
    // the same judge path a patched cable uses.
    expect(SCREEN).toMatch(/pushButton\(/);
    expect(SCREEN).toMatch(/pushRestart\(\)/);
  });
});

describe('gibribbon — CLAIM 4: the determinism pins can actually pin', () => {
  it('the factory reads seed + tick pin at CONSTRUCTION *and* in the tick — both harnesses', () => {
    const ctorAt = DEF_SRC.indexOf('const bootPin = readVrtTicks();');
    const tickAt = DEF_SRC.indexOf('const latePin = readVrtTicks();');
    expect(ctorAt, 'construction read (the face simPin path)').toBeGreaterThan(-1);
    expect(tickAt, 'tick read (the card afterSpawn path)').toBeGreaterThan(-1);
    expect(ctorAt).toBeGreaterThan(tickAt >= 0 ? -1 : 0);
  });

  it('the pin SUPPRESSES the sim rather than freezing it, and returns before the step', () => {
    expect(DEF_SRC).toMatch(/if \(vrtPinned\) return;/);
    const pinReturnAt = DEF_SRC.indexOf('if (vrtPinned) return;');
    const stepAt = DEF_SRC.indexOf('step(state, inputs, stepParams());');
    expect(stepAt).toBeGreaterThan(-1);
    expect(pinReturnAt).toBeLessThan(stepAt);
  });

  it('the module-side __videoEngineFreezeTime early-return exists — the ONLY hold mechanism', () => {
    // The scheduler clock is a Web Worker interval: no audio suspend and no
    // rAF gate can stop it (GAMES.md §4.1). The module's own early return is
    // the whole mechanism, and it must sit before the step.
    expect(DEF_SRC).toMatch(/if \(engineFrozen\(\)\) return;/);
    const frozenAt = DEF_SRC.indexOf('if (engineFrozen()) return;');
    const stepAt = DEF_SRC.indexOf('step(state, inputs, stepParams());');
    expect(frozenAt).toBeGreaterThan(-1);
    expect(frozenAt).toBeLessThan(stepAt);
  });

  it('NOTHING in the app ever sets the pin globals — test-only seams', () => {
    for (const g of ['__gibribbonVrtSeed', '__gibribbonVrtTicks', '__gibribbonVrtNoWad']) {
      expect(DEF_SRC).toContain(g);
      expect(DEF_SRC, `${g} must never be assigned in app code`).not.toMatch(
        new RegExp(`${g}\\s*=[^=]`),
      );
    }
  });
});

describe('gibribbon — CLAIM 5: persistence survives the rewrite (M5)', () => {
  const LEGACY_INPUTS = [
    'cv1', 'cv2', 'cv3', 'cv4', 'clock', 'gate', 'x', 'y', 'a', 'b', 'x_btn', 'y_btn',
  ];
  const LEGACY_OUTPUTS = [
    'out', 'evt_hit', 'evt_miss', 'evt_fire', 'evt_kill', 'evt_gameover', 'health_cv',
  ];
  const LEGACY_PARAMS = [
    'cv1', 'cv2', 'cv3', 'cv4', 'clock', 'gate', 'autoplay', 'axis_x', 'axis_y',
    'btn_a', 'btn_b', 'btn_x', 'btn_y',
  ];

  it('every pre-rewrite port id survives — saved racks keep their cables', () => {
    const ins = new Set(gibribbonDef.inputs.map((p) => p.id));
    const outs = new Set(gibribbonDef.outputs.map((p) => p.id));
    for (const id of LEGACY_INPUTS) expect(ins.has(id), `input '${id}'`).toBe(true);
    for (const id of LEGACY_OUTPUTS) expect(outs.has(id), `output '${id}'`).toBe(true);
  });

  it('every pre-rewrite param id survives — saved settings keep their values', () => {
    const params = new Set(DECLARED);
    for (const id of LEGACY_PARAMS) expect(params.has(id), `param '${id}'`).toBe(true);
  });

  it('the additions are exactly: the restart input + difficulty/tempo/restart_btn params', () => {
    const newInputs = gibribbonDef.inputs.map((p) => p.id).filter((id) => !LEGACY_INPUTS.includes(id));
    expect(newInputs).toEqual(['restart']);
    const newParams = DECLARED.filter((id) => !LEGACY_PARAMS.includes(id));
    expect(newParams.sort()).toEqual(['difficulty', 'restart_btn', 'tempo']);
    // Outputs unchanged in both directions (Q4: no score_cv in v1).
    expect(gibribbonDef.outputs.map((p) => p.id).sort()).toEqual([...LEGACY_OUTPUTS].sort());
  });

  it('the restart port routes through a paramTarget like every other gate input', () => {
    const restart = gibribbonDef.inputs.find((p) => p.id === 'restart');
    expect(restart).toMatchObject({ type: 'gate', edge: 'trigger', paramTarget: 'restart_btn' });
  });
});

describe('gibribbon — the surfaces share ONE playfield (the frogger one-painter rule)', () => {
  it('both the body and the card mount GibribbonScreen, and neither owns a second canvas', () => {
    expect(BODY).toMatch(/import GibribbonScreen from '\.\/GibribbonScreen\.svelte'/);
    expect(CARD).toMatch(/import GibribbonScreen from '\.\/gibribbon\/GibribbonScreen\.svelte'/);
    expect(markupOf(BODY)).not.toMatch(/<canvas/);
    expect(markupOf(CARD)).not.toMatch(/<canvas/);
    expect(markupOf(SCREEN)).toMatch(/<canvas/);
  });

  it('SCREEN OFF unmounts the playfield — the blit stops, keyboard capture releases', () => {
    // The screen switch gates the MOUNT of the shared component; the game
    // itself runs in the factory on the scheduler clock (asserted above), so
    // OFF cannot stop the module.
    expect(BODY).toMatch(/\{#if !previewCollapsed\}/);
    expect(BODY).toMatch(/data\?\.previewCollapsed/);
    expect(BODY).toMatch(/\.data\.previewCollapsed = next/);
  });

  it('MONITOR mode is drivable from the body (the face-monitor-source contract)', () => {
    expect(BODY).toMatch(/data\?\.hideControls/);
    expect(BODY).toMatch(/\.data\.hideControls = next/);
    expect(markupOf(BODY).match(/<button/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('the keyboard canon: handled keys only, ESC untouched, focus-gated', () => {
    expect(SCREEN).toMatch(/if \(!hasFocus\) return;/);
    expect(SCREEN, 'ESC must pass through to the host').not.toMatch(/[Ee]scape/);
    // The handled set is exactly ABXY + R (arrows alias ABXY).
    expect(SCREEN).toMatch(/case 'f': case 'arrowleft':/);
    expect(SCREEN).toMatch(/'r'/);
  });
});
