// packages/dsp/src/analog-logic-maths.ts
//
// ANALOGLOGICMATHS (ALM) worklet processor.
//
// Analog logic mixer inspired by Mystic Instruments ANA. Operates on TWO
// continuous-signal inputs (audio/CV) and emits FIVE simultaneous algebraic
// combinations — the "logic" of analog electronics rather than the digital
// boolean logic of ILLOGIC:
//
//   MIN     = min(a', b')
//   MAX     = max(a', b')
//   DIFF    = a' - b'
//   SUM     = tanh(a' + b')      (soft-clipped: a+b can exceed unity)
//   PRODUCT = tanh(a' * b')      (soft-clipped: same)
//
// where a' = a * attA and b' = b * attB. The attenuverters (-1..+1) let the
// user invert + level each input before the math, so e.g. (-1 * a) + b gives
// `b - a` on the SUM output for free.
//
// ⚠ WHICH JACKS CAN LEAVE THE ±1 RAIL — MEASURED, and it is NOT the pair the
// soft-clip protects. This comment used to read "soft-clip is applied only to
// SUM + PRODUCT (the operations that can leave the [-1, +1] range). MIN / MAX /
// DIFF stay bounded for any in-range pair", and it was wrong in BOTH halves.
// For in-range inputs (|a|,|b| <= 1) at any attenuverter setting, |a'| <= 1 and
// |b'| <= 1, so:
//
//   SUM      a'+b' in [-2,+2]   CAN exceed the rail  -> tanh, bounded under 1
//   PRODUCT  a'*b' in [-1,+1]   CANNOT exceed it     -> tanh anyway: -2.37 dB
//                                                      of distortion at the
//                                                      corner, protecting
//                                                      nothing
//   DIFF     a'-b' in [-2,+2]   CAN exceed the rail  -> NOT CLIPPED. The only
//                                                      jack here that leaves
//                                                      +/-1; it reaches +/-2.00
//                                                      at the shipped defaults
//   MIN/MAX  select one of a', b' — genuinely bounded
//
// The BEHAVIOUR is unchanged and deliberately so: an unclipped difference is
// the correct instrument (a soft-clipped DIFF would stop being a difference),
// and the faceplate prints its live ceiling as `peak`. Measured against this
// compiled worklet in art/scenarios/analog-logic-maths/face-audit.test.ts.
//
// Why a custom JS worklet (no Faust): the math is 5 trivial expressions per
// sample, all stateless. A bare AudioWorkletProcessor is the minimum-surface
// path. Mystic Instruments ANA is hardware-only — no firmware to port — so
// this is a from-spec implementation, not a port.

class AnalogLogicMathsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'attA', defaultValue: 1.0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'attB', defaultValue: 1.0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const aIn = inputs[0]?.[0];
    const bIn = inputs[1]?.[0];
    const minOut = outputs[0]?.[0];
    const maxOut = outputs[1]?.[0];
    const diffOut = outputs[2]?.[0];
    const sumOut = outputs[3]?.[0];
    const prodOut = outputs[4]?.[0];

    const attAArr = parameters.attA;
    const attBArr = parameters.attB;

    const frames =
      minOut?.length ??
      maxOut?.length ??
      diffOut?.length ??
      sumOut?.length ??
      prodOut?.length ??
      0;

    for (let i = 0; i < frames; i++) {
      const a = aIn ? (aIn[i] ?? 0) : 0;
      const b = bIn ? (bIn[i] ?? 0) : 0;
      const attA = attAArr.length > 1 ? (attAArr[i] ?? attAArr[0]) : attAArr[0];
      const attB = attBArr.length > 1 ? (attBArr[i] ?? attBArr[0]) : attBArr[0];
      const ap = a * attA;
      const bp = b * attB;

      if (minOut) minOut[i] = ap < bp ? ap : bp;
      if (maxOut) maxOut[i] = ap > bp ? ap : bp;
      if (diffOut) diffOut[i] = ap - bp;
      // tanh soft-clip. SUM genuinely needs it (a'+b' reaches +/-2); PRODUCT
      // does not for in-range inputs and gets it anyway — see the header.
      if (sumOut) sumOut[i] = Math.tanh(ap + bp);
      if (prodOut) prodOut[i] = Math.tanh(ap * bp);
    }
    return true;
  }
}

registerProcessor('analog-logic-maths', AnalogLogicMathsProcessor);
