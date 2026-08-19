// packages/web/src/lib/ui/workflow/mandelbulb-glyph-tap.test.ts
//
// THE PERMANENT PROOF that `mandelbulb` must declare `glyph: 'none'`, and that
// the reason is NOT the one every other video module has.
//
// ⚠ THIS IS #1748'S CLASS IN ITS PUREST FORM: a live-looking readout of nothing,
// which is worse than a static one BECAUSE NOTHING CAN NOTICE.
//
// The faceplate skill's rule for video defs is *"a video def must declare
// `glyph: 'none'`"*, and its stated MECHANISM is that `primaryAudioOutPortId`
// matches `type === 'audio'` and a video def has none — so any other glyph
// resolves to `{kind:'static'}` and reddens the dead-glyph clause.
//
// `mandelbulb` is the ONE video module in the fleet with a `type: 'audio'`
// output. So that mechanism does not fire, and following the apparent licence
// would ship a glyph that:
//
//   * is NOT `{kind:'static'}`, so `module-face-lint`'s dead-glyph clause is
//     GREEN;
//   * is NOT `'none'`, so the video rule reads as satisfied;
//   * binds to a REAL, LIVE signal through a seam that is STRUCTURALLY UNABLE
//     to see it — and therefore flatlines forever.
//
// EVERY DEF-READING GATE IN THE FLEET PASSES ON THAT. This file is the gate
// that does not, and it asserts BOTH halves, because either alone is
// misleading: the first is what makes this module look different from every
// other video candidate, and the second is why it isn't.
//
// THE MECHANISM, read out of the shipping code rather than assumed:
//   1. `mandelbulb.ts` declares `domain: 'video'` and an `audio_out` of
//      `type: 'audio'`.
//   2. `primaryAudioOutPortId` is `outputs.find(o => o.type === 'audio')?.id`,
//      so it returns `'audio_out'` — not null.
//   3. `glyphBinding` therefore takes the `any glyph + a primary AUDIO output`
//      arm and returns `{ kind: 'live-audio', portId: 'audio_out' }`.
//   4. `createShellGlyphTap` resolves that through
//      `engine.getDomain('audio').getOutputNode(nodeId, portId)`.
//   5. `AudioEngine.getOutputNode` is `this.nodes.get(nodeId)` — and
//      `PatchEngine.addNode` does `this.getDomain(node.domain).addNode(node)`,
//      so a `domain: 'video'` node is added to the VIDEO engine and NEVER
//      enters the audio engine's map at all.
//   6. → `getOutputNode` returns null → `detach()` → `getLevel()` is 0, forever.
//
// The cross-domain path for a video module's audio is
// `VideoEngine.getAudioSource`, which this tap does not call. Wiring one is a
// platform change, not a face change.

import { describe, expect, it } from 'vitest';
import { mandelbulbDef } from '$lib/video/modules/mandelbulb';
import {
  createShellGlyphTap,
  glyphBinding,
  primaryAudioOutPortId,
} from '$lib/ui/workflow/shell-glyph-live';

describe('mandelbulb — the trap: it LOOKS like a live-glyph candidate', () => {
  it('is a VIDEO-domain def that nonetheless publishes an AUDIO output', () => {
    expect(mandelbulbDef.domain).toBe('video');
    const audioOuts = (mandelbulbDef.outputs ?? []).filter((o) => o.type === 'audio');
    expect(audioOuts.map((o) => o.id)).toEqual(['audio_out']);
  });

  it('⚠ primaryAudioOutPortId returns a REAL PORT — it is NOT null', () => {
    // This single line is why the video rule's stated mechanism does not fire
    // here, and therefore why this file exists.
    expect(primaryAudioOutPortId(mandelbulbDef)).toBe('audio_out');
  });

  it('⚠ a live glyph would bind LIVE-AUDIO, not static — so the lint stays GREEN', () => {
    for (const glyph of ['meter', 'waveform'] as const) {
      const binding = glyphBinding({ ...mandelbulbDef, face: { order: [], glyph } });
      expect(
        binding,
        `glyph '${glyph}' must resolve LIVE (that is the trap), not {kind:'static'}`,
      ).toEqual({ kind: 'live-audio', portId: 'audio_out' });
    }
  });

  it('and the SHIPPED def declares `none`, which is the whole point', () => {
    // If this ever flips to a live kind, the two legs below are what say why
    // that is wrong.
    expect(mandelbulbDef.face?.glyph ?? 'none').toBe('none');
    expect(glyphBinding(mandelbulbDef)).toEqual({ kind: 'none' });
  });
});

// ─────────────── the tap itself: it cannot see a video-domain node ───────────

interface StubOut { node: { connect: () => void; disconnect: () => void }; output: number }

/**
 * An audio domain modelling `AudioEngine.getOutputNode` exactly: a map lookup
 * that returns null for any node id it does not hold. A `domain: 'video'` node
 * is never added to that map (`PatchEngine.addNode` routes by `node.domain`),
 * so the absence below IS the product's behaviour, not a convenience.
 */
function stubEngine(registered: Record<string, StubOut>, samples: number) {
  const buf = new Float32Array(2048).fill(samples);
  const analyser = {
    fftSize: 2048,
    smoothingTimeConstant: 0,
    getFloatTimeDomainData: (out: Float32Array) => out.set(buf.subarray(0, out.length)),
  };
  return {
    // ⚠ REQUIRED, AND ITS ABSENCE IS WHAT THE POSITIVE CONTROL CAUGHT.
    // `ensureAttached` bails on `!engine.hasDomain('audio')` BEFORE it ever
    // reaches `getOutputNode`. The first draft of this stub omitted it, so the
    // "blind" leg below returned 0 for the WRONG REASON — the audio domain
    // looked absent rather than the NODE looking absent — and the negative leg
    // passed while proving nothing. That is exactly the failure the positive
    // control exists to expose, and it exposed it here.
    hasDomain: (d: string) => d === 'audio',
    getDomain: (d: string) => {
      if (d !== 'audio') throw new Error(`no domain ${d}`);
      return {
        ctx: { createAnalyser: () => analyser },
        getOutputNode: (nodeId: string) => registered[nodeId] ?? null,
      };
    },
  };
}

const stubNode = (): StubOut => ({ node: { connect: () => {}, disconnect: () => {} }, output: 0 });

describe('mandelbulb — the tap that binding resolves to reads NOTHING, forever', () => {
  it('⚠ getLevel() is 0 and attached() is false, and STAYS that way', () => {
    // The node id is present in the patch and absent from the AUDIO engine —
    // which is exactly the state a spawned mandelbulb is in.
    const engine = stubEngine({}, 0.9);
    const tap = createShellGlyphTap(() => engine as never, 'mandelbulb-1', 'audio_out');

    // Read repeatedly: a tap that attached late would show up here.
    for (let i = 0; i < 25; i++) {
      expect(tap.getLevel(), `getLevel() on read ${i + 1} (units: RMS, 0..1)`).toBe(0);
      expect(tap.getSamples()).toBeUndefined();
      expect(tap.attached()).toBe(false);
    }
  });

  it('POSITIVE CONTROL: the SAME tap reads NON-ZERO when the node IS in the audio map', () => {
    // ⚠ WITHOUT THIS LEG, "0 forever" is indistinguishable from a broken probe
    // — the exact failure mode CLAUDE.md names, and the reason a passing
    // negative control is not enough on its own. Same tap, same port id, same
    // analyser; the ONLY difference is whether the audio engine knows the node.
    const engine = stubEngine({ 'mandelbulb-1': stubNode() }, 0.5);
    const tap = createShellGlyphTap(() => engine as never, 'mandelbulb-1', 'audio_out');

    const level = tap.getLevel();
    expect(level, 'the probe CAN move (units: RMS, 0..1)').toBeGreaterThan(0);
    expect(level).toBeCloseTo(0.5, 6);
    expect(tap.attached()).toBe(true);
    expect(tap.getSamples()).toBeDefined();
  });

  it('the difference is the AUDIO ENGINE\'S MAP, not the port id or the glyph', () => {
    // Narrow the cause to one variable. Everything else is held constant.
    const blind = createShellGlyphTap(() => stubEngine({}, 0.5) as never, 'n', 'audio_out');
    const seeing = createShellGlyphTap(
      () => stubEngine({ n: stubNode() }, 0.5) as never,
      'n',
      'audio_out',
    );
    expect(blind.getLevel()).toBe(0);
    expect(seeing.getLevel()).toBeGreaterThan(0);
  });
});
