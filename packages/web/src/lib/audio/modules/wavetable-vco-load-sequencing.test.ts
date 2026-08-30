// packages/web/src/lib/audio/modules/wavetable-vco-load-sequencing.test.ts
//
// THE PERMANENT GATE FOR THE SILENT-RENDER DEFECT — and it is SOURCE-level for a
// measured reason, not by preference.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
//
// The factory used to hand the wavetable to the worklet with an un-acked
// `workletNode.port.postMessage({ type: 'load', … })` AFTER constructing the
// node, and `packages/dsp/src/wavetable-vco.ts` opens `process()` with
// `if (!this.table || this.frameCount === 0) { out.fill(0); return true; }`.
// So the processor emits DIGITAL SILENCE until that message is delivered.
// Nothing sequenced the message against rendering, and an `OfflineAudioContext`
// renders as fast as it can, so leading blocks — sometimes a whole render — came
// out silent, intermittently.
//
// MEASURED on CI, 2026-08-23: `art/scenarios/wavetable-vco/cv-path.test.ts`
// reported `pmAmount must be inert with nothing patched: peak |Δsample| linear
// = 1.3953e+0` against an expected `0`. The output is documented as roughly ±1,
// so ~1.4 is SILENCE-against-SIGNAL, not drift.
//
// ⚠ THE DAMAGE WAS TO THE GREEN RUNS. A render that is silently silent still
// SATISFIES every assertion of the form "this delta is 0" — which is the shape of
// every inertness row in that scenario. The defect could therefore make rows pass
// for entirely the wrong reason, and only announced itself on the one comparison
// it happened to make FAIL.
//
// ── WHY THIS GATE IS SOURCE-LEVEL ───────────────────────────────────────────
//
// ⚠ BECAUSE THE BEHAVIOURAL VERSION DOES NOT DISCRIMINATE, AND THAT WAS MEASURED
// RATHER THAN ASSUMED. The obvious test — "no render block comes out silent" —
// was written first and lives in the ART scenario. It was then negative-controlled
// by reverting the factory to the real pre-fix post-message path: the whole
// scenario still passed, 10/10. The race simply does not reproduce in the local
// offline harness, where the port message happens to be delivered before
// rendering begins; it needed CI load to show itself at all.
//
// So a behavioural gate here would be a test that CANNOT FAIL ON THE DEFECT IT
// EXISTS TO CATCH — green, permanent, and worthless. The property that actually
// broke is structural and greppable: is the initial table delivered at
// CONSTRUCTION, or posted afterwards? A source gate answers exactly that,
// deterministically, on every machine.
//
// The ART scenario's `LOAD SEQUENCING` row is kept as a real assertion about the
// product (no block should be silent) — it is simply not the control, and it says
// so itself.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const FACTORY = new URL('./wavetable-vco.ts', import.meta.url);
const WORKLET = new URL('../../../../../dsp/src/wavetable-vco.ts', import.meta.url);

/**
 * Strip `//` line comments and block comments.
 *
 * ⚠ LOAD-BEARING, NOT TIDINESS. This file's own subject explains the pre-fix
 * shape IN A COMMENT that quotes `port.postMessage({type:'load', …})` verbatim —
 * so an unstripped grep would read the FIXED factory as still carrying the
 * defect. It is the documented "the gate greps source, so it cannot tell code
 * from comment" hazard, and it would fire on the very file that fixed the bug.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s+\/\/.*$/, ''))
    .join('\n');
}

/** Does the worklet node get its table at CONSTRUCTION (processorOptions)? */
function constructionCarriesTable(src: string): boolean {
  const code = stripComments(src);
  const call = code.slice(code.indexOf('createWorkletNode('));
  if (!call) return false;
  // The options object literal passed to createWorkletNode, up to the call's end.
  const opts = call.slice(0, call.indexOf('});') + 3);
  return /processorOptions\s*:/.test(opts) && /table\s*:/.test(opts);
}

/** Does the factory rely on a POSTED message to deliver the initial table? */
function postsInitialLoad(src: string): boolean {
  const code = stripComments(src);
  return /port\s*\.\s*postMessage\s*\(\s*\{?[^)]*type\s*:\s*['"]load['"]/.test(code);
}

/** Does the PROCESSOR apply `processorOptions` inside its constructor? */
function processorAppliesConstructionOptions(src: string): boolean {
  const code = stripComments(src);
  const ctor = code.slice(code.indexOf('constructor('));
  const body = ctor.slice(0, ctor.indexOf('\n  process('));
  return /processorOptions/.test(body);
}

describe('wavetable-vco: the table is delivered at CONSTRUCTION, never posted after', () => {
  const factorySrc = readFileSync(FACTORY, 'utf-8');
  const workletSrc = readFileSync(WORKLET, 'utf-8');

  it('ANCHOR: both sources are the real files and still contain their landmarks', () => {
    // Every predicate below is `regex.test(source)`, so a moved or renamed file
    // would report "the defect is present" — a specific, plausible, entirely
    // wrong diagnosis. This makes a bad path say THAT instead.
    expect(factorySrc, 'factory source lost createWorkletNode').toContain('createWorkletNode(');
    expect(workletSrc, 'worklet source lost its process() loop').toContain('process(');
    expect(workletSrc, 'worklet lost the no-table silence branch this gate is about')
      .toContain('out.fill(0)');
  });

  it('the FACTORY passes the table in processorOptions', () => {
    expect(
      constructionCarriesTable(factorySrc),
      'the wavetable is no longer handed to createWorkletNode in `processorOptions`. If it is ' +
        'posted after construction instead, the processor renders SILENCE until the message ' +
        'lands — invisible in realtime, and whole silent renders offline.',
    ).toBe(true);
  });

  it('the FACTORY does not deliver the initial table by port message', () => {
    expect(
      postsInitialLoad(factorySrc),
      'the factory posts a `type: \'load\'` message. That is the pre-fix path: it leaves a ' +
        'window in which process() emits out.fill(0), and an OfflineAudioContext renders faster ' +
        'than the message is delivered.',
    ).toBe(false);
  });

  it('the PROCESSOR applies processorOptions in its constructor', () => {
    // The other half of the contract: passing the option is useless if nothing
    // reads it, and that would fail exactly as silently as the original defect.
    expect(
      processorAppliesConstructionOptions(workletSrc),
      'the processor constructor ignores processorOptions, so the table passed at construction ' +
        'never reaches it and process() falls back to silence',
    ).toBe(true);
  });

  it('POSITIVE CONTROL: the predicates REJECT the shape that actually shipped', () => {
    // ⚠ COPIED FROM THE REAL PRE-FIX FACTORY, not paraphrased. A hand-written
    // "bad" fixture proves only that the predicate dislikes something.
    const shipped = `
      const workletNode = createWorkletNode(node, ctx, 'wavetable-vco', {
        numberOfInputs: 4,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      const table = generateBasicTable();
      const buf = table.buffer;
      workletNode.port.postMessage(
        { type: 'load', table: buf, frameSize: FRAME_SIZE, frameCount: FRAME_COUNT },
        [buf]
      );
    `;
    expect(
      constructionCarriesTable(shipped),
      'the construction predicate reads the SHIPPED post-message factory as carrying the table — ' +
        'it is blind to the very defect it exists to catch',
    ).toBe(false);
    expect(
      postsInitialLoad(shipped),
      'the post-message predicate does not recognise the shipped defect shape',
    ).toBe(true);
  });

  it('NEGATIVE CONTROL: the predicates ACCEPT the fixed shape', () => {
    // The other direction on the SAME predicates, so a "fix" that makes them
    // always-false — and therefore always-green — fails here.
    const fixed = `
      const table = generateBasicTable();
      const workletNode = createWorkletNode(node, ctx, 'wavetable-vco', {
        numberOfInputs: 4,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          type: 'load',
          table: table.buffer,
          frameSize: FRAME_SIZE,
          frameCount: FRAME_COUNT,
        },
      });
    `;
    expect(constructionCarriesTable(fixed), 'a construction-delivered table must read as such').toBe(true);
    expect(postsInitialLoad(fixed), 'the fixed shape posts nothing').toBe(false);

    // And the comment hazard the stripper exists for: prose describing the old
    // call must NOT read as the old call.
    const proseOnly = "// it used to be workletNode.port.postMessage({ type: 'load', … })";
    expect(
      postsInitialLoad(proseOnly),
      'a COMMENT describing the defect reads as the defect — the comment stripper is not working, ' +
        'and this gate would fail on the file that fixed the bug',
    ).toBe(false);
  });
});
