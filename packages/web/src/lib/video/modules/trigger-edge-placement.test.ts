// packages/web/src/lib/video/modules/trigger-edge-placement.test.ts
//
// A SOURCE-LEVEL guard for the "level-read at DRAW time" bug class — the defect
// behind the FREEZEFRAME owner report of 2026-07-31 (a patched trigger updated
// ZERO frames) and its FRAMETABLE sibling (a patched trigger saved NOTHING).
//
// ── WHY THIS GATE HAS TO READ THE SOURCE ──
// Every runtime gate we have is STRUCTURALLY BLIND to this bug:
//   - contract-lock / module-docs-lint read the DEF. The def was correct in both
//     cases — the port said `edge: 'trigger'` and the docs said "fires once per
//     rising edge". The FACTORY disagreed with it.
//   - the pure-function unit tests import the decision functions (shouldCapture,
//     the save latch) and drive them directly. They pass no matter WHERE the
//     factory calls them from — and "where" is the entire bug.
//   - the per-module-per-port sweep asserts an edge MATERIALIZES, not that the
//     module reacted to it.
//   - the e2e that would see it lives in e2e/tests/freezeframe.spec.ts, and the
//     bug shipped while that file ran in NO CI LANE.
// This is the same shape as the backdraft "card silently disagrees with its def"
// hole, and the same remedy the repo already uses for it: grep the source, since
// no runtime gate can see the divergence. (Precedent: the controlFamilies →
// card-testid grep in module-docs-lint.test.ts.)
//
// ── THE RULE ──
// A rising edge on a raw-passthrough (gate/trigger-style) input MUST be detected
// in `setParam`, on the BRIDGE's clock — never by reading `params.<id>` inside
// `draw()`.
//
// The reason is not style, it is the wire protocol. `PatchEngine.
// installGateDispatch` handles any GATE SOURCE patched into an input with no
// non-passthrough `cvScale` — which includes every `type: 'cv'` clock/gate port,
// not just `type: 'gate'` ones. It does NOT stream the waveform. It counts
// rising edges on the audio thread and REPLAYS them on the ~25 ms scheduler tick
// as `setParam(0); setParam(1)` per edge, then `setParam(currentLevel)`.
// Measured byte-for-byte on the live chain (SEQUENCER.clock → FREEZEFRAME.
// gate_in), one trigger arrives as three writes in the SAME MILLISECOND:
//
//     3221:0   3221:1   3221:0
//
// So by the time `draw()` runs, `params.<id>` is back to 0. A detector reading
// the level there observes `0 → 0 → 0`: the rise never existed. The consumer is
// not "flaky" — it is DEAD, deterministically, for every patched trigger.
//
// ── WHAT THIS GATE CANNOT SEE (state it, don't imply completeness) ──
// It matches the DIRECT form `edgeFn(state, params.<id>)`, which is the form
// both real bugs took. An edge read that launders the level through a local
// first —
//     const sample = params[key];  …  detectEdge(state, sample)
// — is NOT matched. `vfpga-runner.ts` (`tickGates`, called from draw) is exactly
// that shape and is therefore invisible here; it is listed in KNOWN_REMAINING
// by hand so it is at least counted. Widening the matcher to arbitrary dataflow
// needs a real AST pass; the direct form is where the value is.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Comments are stripped before scanning: this very file's prose, and the long
 *  explanatory headers the fixes added, mention `detectEdge(` and `params.x` in
 *  English. A gate that matched its own documentation would be self-tripping. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Body of the `{ … }` block that starts at/after `from`, brace-matched. */
function blockAt(src: string, from: number): string {
  const start = src.indexOf('{', from);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i); }
  }
  return src.slice(start);
}

/** Names of functions in `src` whose body reaches `detectEdge` (transitively —
 *  the mirror-gate helpers are one hop away). */
function edgeDetectingFunctions(src: string): Set<string> {
  const names = new Set(['detectEdge']);
  // Three passes is enough for the depths that exist; it also terminates.
  for (let pass = 0; pass < 3; pass++) {
    const re = /(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const body = blockAt(src, m.index);
      for (const n of names) {
        if (new RegExp(`\\b${n}\\s*\\(`).test(body)) { names.add(m[1]!); break; }
      }
    }
  }
  return names;
}

export interface EdgeSite { module: string; param: string; via: string }

/** Every `<edgeFn>( … params.<id> … )` call in a video module def. */
function scanModule(file: string, src: string): EdgeSite[] {
  const out: EdgeSite[] = [];
  const module = file.replace(/\.ts$/, '');
  for (const fn of edgeDetectingFunctions(src)) {
    // One level of nested parens in the arg list is plenty here.
    const re = new RegExp(`\\b${fn}\\s*\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const pm = /params\s*(?:\.\s*([A-Za-z0-9_$]+)|\[)/.exec(m[1] ?? '');
      if (pm) out.push({ module, param: pm[1] ?? '<computed>', via: fn });
    }
  }
  return out;
}

function scanAll(): EdgeSite[] {
  const out: EdgeSite[] = [];
  for (const f of readdirSync(MODULES_DIR).sort()) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const src = stripComments(readFileSync(join(MODULES_DIR, f), 'utf8'));
    if (!src.includes('detectEdge')) continue;
    out.push(...scanModule(f, src));
  }
  return out;
}

const key = (s: EdgeSite): string => `${s.module}.${s.param}`;

/**
 * THE RATCHET. Sites that still read the level at draw time, verified one by one
 * on 2026-08-01. This list may only SHRINK. Every entry is a real defect: a gate
 * SOURCE patched into any of these ports is delivered by installGateDispatch
 * (they are all raw-passthrough — "NO cvScale => raw passthrough" in their own
 * def comments), so a TRIGGER into them does nothing at all. A HELD gate still
 * works, which is why they have gone unnoticed: the level stands across ticks,
 * so the draw-time detector does see that rise.
 *
 * NOT fixed in the FREEZEFRAME PR on purpose — each needs its own behavioural
 * verification, and BACKDRAFT is a look-affecting module under the WebGL attest
 * (owner-preview-before-merge). Tracked as follow-up work; the point of the
 * ratchet is that they are now COUNTED and no new one can join them.
 */
const KNOWN_REMAINING: readonly string[] = [
  // BACKDRAFT — 6 raw-passthrough clock/gate ports, all edge-read in draw().
  'backdraft.delayClock',   // clock-locked delay period measurement
  'backdraft.mirrorXGate',  // rising edge toggles mirror X
  'backdraft.mirrorYGate',  // rising edge toggles mirror Y
  'backdraft.shapeGate',    // rising edge cycles the shape
  'backdraft.pureGeoGate',  // rising edge toggles the masking space
  'backdraft.tvGate',       // rising edge toggles PURE TV
  // B3NTB0X / BENTBOX — the same mirror-gate helper, same placement.
  'b3ntb0x.mirrorXGate',
  'b3ntb0x.mirrorYGate',
  'bentbox.mirrorXGate',
  'bentbox.mirrorYGate',
];

/** Sites this scanner is KNOWN to miss (see the header's blind-spot note).
 *  Listed so the true remaining count is honest, not so the gate can see them. */
const KNOWN_UNMATCHABLE: readonly string[] = [
  // vfpga-runner.ts `tickGates()` — reads `params[gateEvtParam(i+1)]` into a
  // local, then detectEdge(…, sample); called from draw(). Same defect class,
  // invisible to a direct-form matcher.
  'vfpga-runner.gate_evt_N (via a local; scanner blind spot)',
];

describe('video modules: a TRIGGER must be edge-detected in setParam, not read in draw', () => {
  it('finds no NEW level-read-at-draw-time site', () => {
    const found = scanAll();
    const novel = found.filter((s) => !KNOWN_REMAINING.includes(key(s)));
    expect(
      novel.map(key).sort(),
      novel.length === 0
        ? ''
        : [
            '',
            'A video module edge-detects a gate/trigger input by reading `params.<id>` at DRAW time:',
            ...novel.map((s) => `  • ${key(s)}   (via ${s.via})`),
            '',
            'That does not work for a PATCHED TRIGGER. PatchEngine.installGateDispatch replays a',
            'counted edge as `setParam(0); setParam(1); setParam(level)` inside ONE ~25 ms scheduler',
            'tick — all three writes in the SAME MILLISECOND — so by the next draw the level is back',
            'to 0 and the rise is invisible. Measured on the live chain: 0 of 23 rendered frames',
            'updated across 6 triggers (FREEZEFRAME, owner report 2026-07-31).',
            '',
            'FIX: detect the edge inside setParam (it runs on the bridge clock, so a pulse shorter',
            'than a frame cannot be missed), latch a BOOLEAN, and CONSUME the latch in draw().',
            'Worked examples: freezeframe.ts (gate_in) and frametable-core.ts (the save latch).',
            'A LEVEL read in draw is correct ONLY for a true `edge: \'gate\'` port that acts WHILE high.',
          ].join('\n'),
    ).toEqual([]);
  });

  it('the ratchet only shrinks — every known site still exists', () => {
    // If a listed site is gone, someone FIXED it: drop the entry (and the count
    // ceiling below) in the same commit. A ratchet nobody tightens is a comment.
    const found = new Set(scanAll().map(key));
    const stale = KNOWN_REMAINING.filter((k) => !found.has(k));
    expect(
      stale,
      `these ratchet entries no longer exist — they were fixed, so REMOVE them from KNOWN_REMAINING (and lower the ceiling): ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('the known-remaining count is at its ceiling and cannot grow', () => {
    expect(KNOWN_REMAINING.length, 'unfixed level-read-at-draw sites').toBeLessThanOrEqual(10);
    expect(KNOWN_UNMATCHABLE.length, 'sites the scanner cannot see').toBeLessThanOrEqual(1);
  });

  // ---- NEGATIVE CONTROLS: prove the scanner can actually see the bug. ----
  // Without these, a scanner that silently matched NOTHING would report a clean
  // repo forever — the exact failure mode this file exists to prevent.

  it('NEGATIVE CONTROL: the scanner FLAGS the pre-fix FREEZEFRAME shape', () => {
    const preFix = `
      const gateEdge = makeEdgeState();
      const surface = {
        draw(frame) {
          if (detectEdge(gateEdge, params.gateLevel)?.pressed === true) capture();
        },
      };
    `;
    const hits = scanModule('freezeframe.ts', stripComments(preFix));
    expect(hits.map(key)).toEqual(['freezeframe.gateLevel']);
  });

  it('NEGATIVE CONTROL: it flags a one-hop HELPER too, not just detectEdge', () => {
    const viaHelper = `
      export function widgetGateTick(edge, sample) { return detectEdge(edge, sample)?.pressed === true; }
      const surface = { draw(frame) { if (widgetGateTick(g.x, params.someGate)) flip(); } };
    `;
    const hits = scanModule('widget.ts', stripComments(viaHelper));
    expect(hits.map(key)).toEqual(['widget.someGate']);
    expect(hits[0]!.via).toBe('widgetGateTick');
  });

  it('POSITIVE CONTROL: the CORRECT setParam form is NOT flagged', () => {
    const fixed = `
      const gateEdge = makeEdgeState();
      let armed = false;
      const handle = {
        setParam(paramId, value) {
          if (paramId === 'gateLevel' && detectEdge(gateEdge, value)?.pressed === true) armed = true;
        },
        draw(frame) { if (armed) { armed = false; capture(); } },
      };
    `;
    expect(scanModule('freezeframe.ts', stripComments(fixed))).toEqual([]);
  });

  it('the two modules FIXED by this campaign are clean', () => {
    const found = new Set(scanAll().map((s) => s.module));
    expect(found.has('freezeframe'), 'freezeframe still reads a level at draw time').toBe(false);
    expect(found.has('frametable'), 'frametable still reads a level at draw time').toBe(false);
  });
});

// ===========================================================================
// RULE 2 — the DEF-DRIVEN check: a declared trigger input must be edge-detected
// SOMEWHERE IN setParam at all.
//
// Rule 1 above finds edge detection in the WRONG PLACE. It could not have found
// the bug that started this: pre-fix FREEZEFRAME had NO edge detection anywhere
// — `shouldCapture` was a pure LEVEL test — so a detectEdge-shaped scanner sees
// a perfectly clean file. (Verified against the real pre-fix source: Rule 1
// flags frametable's `saveTrig` and reports NOTHING for freezeframe.)
//
// This rule reads the DEF instead: a port that declares `edge: 'trigger'` has
// promised "fires ONCE per rising edge". The only mechanism that can deliver
// that promise across the bridge is edge detection on the setParam clock. So if
// the def declares it, the factory's setParam must do it.
// ===========================================================================

/** Edge-detection idioms in use across the video modules. Deliberately a list of
 *  REAL forms, not a wildcard: freezeframe/frametable use `detectEdge`,
 *  lushgarden a local `gateEdge()`, milkdrop a `createEdgeCounter().scan()`. */
const EDGE_IDIOMS = /(detectEdge|gateEdge|\.scan\(|risingEdge|RisingEdge|EdgeCounter|SaveWrite)/;

/** Modules that deliberately delegate trigger edge-detection to their CARD,
 *  which POLLS readParam. ⚠ This is NOT a clean bill of health — a poller has
 *  the SAME exposure as a draw-time read: the bridge's `0,1,0` lands inside one
 *  millisecond, so any sampler that is not on the setParam clock can miss it.
 *  Listed here to keep this gate honest about what it is NOT asserting, and
 *  tracked as follow-up alongside the KNOWN_REMAINING ratchet above. */
const CARD_OWNED_EDGE_DETECTION: readonly string[] = ['tv-librarian', 'peertube'];

function modulesDeclaringTriggerInputs(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(MODULES_DIR).sort()) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const src = stripComments(readFileSync(join(MODULES_DIR, f), 'utf8'));
    // An INPUT trigger port: `edge: 'trigger'` on a line that also routes to a
    // param (outputs declare `edge` for the glyph but carry no paramTarget).
    if (/edge:\s*'trigger'[^\n]*paramTarget:/.test(src)) out.push(f.replace(/\.ts$/, ''));
  }
  return out;
}

describe("video modules: a port declaring edge:'trigger' must edge-detect in setParam", () => {
  it('every module with a trigger INPUT edge-detects it on the setParam clock', () => {
    const offenders: string[] = [];
    for (const m of modulesDeclaringTriggerInputs()) {
      if (CARD_OWNED_EDGE_DETECTION.includes(m)) continue;
      const src = stripComments(readFileSync(join(MODULES_DIR, `${m}.ts`), 'utf8'));
      const idx = src.search(/setParam\s*\(\s*paramId/);
      if (idx < 0) { offenders.push(`${m} (no setParam at all)`); continue; }
      if (!EDGE_IDIOMS.test(blockAt(src, idx))) offenders.push(`${m} (setParam does not edge-detect)`);
    }
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : [
            '',
            "These modules declare an INPUT port with edge: 'trigger' — a promise that it",
            'FIRES ONCE PER RISING EDGE — but their setParam never edge-detects:',
            ...offenders.map((o) => `  • ${o}`),
            '',
            'A LEVEL read cannot keep that promise. installGateDispatch replays a counted edge',
            'as setParam(0); setParam(1); setParam(level) inside ONE scheduler tick, so the high',
            'is gone before the next draw and a level-reading consumer sees nothing at all.',
            'This is EXACTLY the pre-fix FREEZEFRAME shape (0 of 23 frames updated).',
            '',
            "Either edge-detect the paramTarget in setParam, or change the port's declared",
            "semantic to edge: 'gate' if the LEVEL really is what it reads.",
          ].join('\n'),
    ).toEqual([]);
  });

  it('the card-owned exemption list stays small and cannot silently grow', () => {
    // Each entry is an UNVERIFIED trigger path, not an approved design.
    expect(CARD_OWNED_EDGE_DETECTION.length).toBeLessThanOrEqual(2);
    for (const m of CARD_OWNED_EDGE_DETECTION) {
      expect(modulesDeclaringTriggerInputs(), `${m} no longer declares a trigger input — drop the exemption`)
        .toContain(m);
    }
  });

  it('NEGATIVE CONTROL: a trigger port with a LEVEL-ONLY setParam is caught', () => {
    // The literal pre-fix FREEZEFRAME shape.
    const preFix = stripComments(`
      const def = { inputs: [{ id: 'gate_in', type: 'gate', edge: 'trigger', paramTarget: 'gateLevel' }] };
      const handle = {
        setParam(paramId, value) { if (paramId in params) params[paramId] = value; },
        draw(frame) { if (params.gateLevel >= 0.5) capture(); },
      };
    `);
    expect(/edge:\s*'trigger'[^\n]*paramTarget:/.test(preFix), 'declares a trigger input').toBe(true);
    const idx = preFix.search(/setParam\s*\(\s*paramId/);
    expect(EDGE_IDIOMS.test(blockAt(preFix, idx)), 'and its setParam does NOT edge-detect').toBe(false);
  });
});
