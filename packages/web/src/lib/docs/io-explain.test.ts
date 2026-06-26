// packages/web/src/lib/docs/io-explain.test.ts
//
// Unit tests for the pure PortDef/ParamDef → human-text explainer. These
// pin the human sentences the docs I/O section renders, so a wording change
// is a deliberate diff and the "every field maps to text" contract the drift
// gate relies on stays honest.

import { describe, it, expect } from 'vitest';
import {
  explainInputPort,
  explainOutputPort,
  explainPort,
  explainCvScale,
  explainEdge,
  explainParam,
  explainParamRange,
  explainCurve,
  type ExplainPort,
  type ExplainParam,
} from './io-explain';

describe('explainCvScale', () => {
  it('linear = additive offset', () => {
    expect(explainCvScale('linear')).toMatch(/additive offset/);
  });
  it('log = multiplicative / octaves', () => {
    expect(explainCvScale('log')).toMatch(/multiplicative|octaves/);
  });
  it('discrete = integer buckets', () => {
    expect(explainCvScale('discrete')).toMatch(/integer buckets/);
  });
  it('passthrough = summed directly', () => {
    expect(explainCvScale('passthrough')).toMatch(/summed directly/);
  });
  it('unknown mode falls through to the raw token', () => {
    expect(explainCvScale('weird')).toBe('weird');
  });
});

describe('explainEdge', () => {
  it('trigger fires once per rising edge', () => {
    expect(explainEdge('trigger')).toMatch(/once per rising edge/);
  });
  it('gate acts while high + both edges', () => {
    expect(explainEdge('gate')).toMatch(/while the level is high/);
    expect(explainEdge('gate')).toMatch(/both edges/);
  });
});

describe('explainInputPort', () => {
  it('cv + paramTarget ⇒ "modulates X" with the cvScale text', () => {
    const port: ExplainPort = {
      id: 'attack',
      type: 'cv',
      paramTarget: 'attack',
      cvScale: { mode: 'log' },
    };
    const text = explainInputPort(port);
    expect(text).toMatch(/control voltage/);
    expect(text).toMatch(/modulates attack/);
    expect(text).toMatch(/multiplicative/);
  });

  it('cv + paramTarget with NO cvScale defaults to passthrough text', () => {
    const port: ExplainPort = { id: 'cutoff_cv', type: 'cv', paramTarget: 'cutoff' };
    const text = explainInputPort(port);
    expect(text).toMatch(/modulates cutoff/);
    expect(text).toMatch(/summed directly/);
  });

  it('gate edge=gate is described level-sensitively', () => {
    const port: ExplainPort = { id: 'gate', type: 'gate', edge: 'gate' };
    const text = explainInputPort(port);
    expect(text).toMatch(/gate \/ trigger/);
    expect(text).toMatch(/while the level is high/);
  });

  it('gate edge=trigger is described as a one-shot', () => {
    const port: ExplainPort = { id: 'clock', type: 'gate', edge: 'trigger' };
    expect(explainInputPort(port)).toMatch(/once per rising edge/);
  });

  it('polyPitchGate input notes the 10-channel bus', () => {
    const port: ExplainPort = { id: 'poly', type: 'polyPitchGate' };
    expect(explainInputPort(port)).toMatch(/10-channel poly bus/);
  });

  it('accepts list is surfaced', () => {
    const port: ExplainPort = { id: 'probe', type: 'audio', accepts: ['cv', 'pitch', 'gate'] };
    const text = explainInputPort(port);
    expect(text).toMatch(/also accepts/);
    expect(text).toMatch(/V\/oct pitch CV/);
  });

  it('stereo L side notes the auto-duplicate-to-R normaling', () => {
    const port: ExplainPort = { id: 'in_l', type: 'audio' };
    const text = explainInputPort(port, { stereoPair: 'in_r', stereoSide: 'L' });
    expect(text).toMatch(/stereo pair with in_r/);
    expect(text).toMatch(/auto-duplicates to R/);
  });

  it('stereo R side notes the pair but not the normaling', () => {
    const port: ExplainPort = { id: 'in_r', type: 'audio' };
    const text = explainInputPort(port, { stereoPair: 'in_l', stereoSide: 'R' });
    expect(text).toMatch(/stereo pair with in_l/);
    expect(text).not.toMatch(/auto-duplicates/);
  });
});

describe('explainOutputPort', () => {
  it('plain output names its cable type', () => {
    expect(explainOutputPort({ id: 'env', type: 'cv' })).toMatch(/control voltage/);
  });

  it('adoptsUpstreamFrom makes the emitted type transparent', () => {
    const port: ExplainPort = { id: 'out', type: 'audio', adoptsUpstreamFrom: 'in' };
    expect(explainOutputPort(port)).toMatch(/type mirrors whatever is patched into in/);
  });

  it('output edge glyph is described', () => {
    const port: ExplainPort = { id: 'clock_out', type: 'gate', edge: 'trigger' };
    expect(explainOutputPort(port)).toMatch(/once per rising edge/);
  });
});

describe('explainPort (direction-agnostic gate entry point)', () => {
  it('routes input vs output and always returns non-empty', () => {
    expect(explainPort({ id: 'gate', type: 'gate' }, 'input')).toBeTruthy();
    expect(explainPort({ id: 'env', type: 'cv' }, 'output')).toBeTruthy();
  });
});

describe('explainParam', () => {
  const p: ExplainParam = {
    id: 'attack',
    label: 'A',
    defaultValue: 0.005,
    min: 0.001,
    max: 10,
    curve: 'log',
    units: 's',
  };

  it('range formats min..max with units', () => {
    expect(explainParamRange(p)).toBe('0.001..10 s');
  });

  it('range tolerates null bounds', () => {
    expect(explainParamRange({ ...p, min: null, max: null, units: undefined })).toBe('?..?');
  });

  it('curve maps to human text', () => {
    expect(explainCurve('log')).toBe('logarithmic');
    expect(explainCurve('exp')).toBe('exponential');
    expect(explainCurve('discrete')).toBe('stepped');
    expect(explainCurve('linear')).toBe('linear');
  });

  it('full param line carries label, range, curve, default', () => {
    const text = explainParam(p);
    expect(text).toMatch(/^A:/);
    expect(text).toMatch(/0\.001\.\.10 s/);
    expect(text).toMatch(/logarithmic/);
    expect(text).toMatch(/default 0\.005/);
  });

  it('null default renders an em-dash', () => {
    expect(explainParam({ ...p, defaultValue: null })).toMatch(/default —/);
  });
});
