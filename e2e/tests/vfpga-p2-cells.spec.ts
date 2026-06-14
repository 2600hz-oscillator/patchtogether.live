// e2e/tests/vfpga-p2-cells.spec.ts
//
// vfpga P2 cell-library breadth — REAL-GPU GLSL compile/link coverage. The unit
// tests (cells.test.ts / p2-cells.test.ts) are GL-FREE: they assert the kernel
// <-> metadata contract + place-and-route placement, but jsdom has no GL context
// so they cannot prove the GLSL actually COMPILES. This spec closes that gap: it
// imports each P2 cell's kernel (Node-side — the cell modules only carry type-only
// `$lib` imports, which esbuild strips), then compiles + links each emitted
// fragment in a real WebGL2 context in the browser and asserts LINK_STATUS.
//
// Renderer-tolerant: GLSL ES 3.00 compiles on both a real GPU and CI's SwiftShader
// software renderer, so the assertion is the compile/link STATUS (a boolean), not
// any pixel value — safe on CI (cf. capability-dependent-e2e-local-vs-ci lesson).
// No app module / VFPGA spec is loaded (P2 is engine breadth only); the kernel
// strings come straight from the cell library so they can never drift from prod.

import { test, expect } from '@playwright/test';
import { cellInputUniform } from '../../packages/web/src/lib/video/vfpga/cells/types';
import { addCell } from '../../packages/web/src/lib/video/vfpga/cells/add';
import { multiplyCell } from '../../packages/web/src/lib/video/vfpga/cells/multiply';
import { diffCell } from '../../packages/web/src/lib/video/vfpga/cells/diff';
import { invertCell } from '../../packages/web/src/lib/video/vfpga/cells/invert';
import { gainCell } from '../../packages/web/src/lib/video/vfpga/cells/gain';
import { selectCell } from '../../packages/web/src/lib/video/vfpga/cells/select';
import { lumaCell } from '../../packages/web/src/lib/video/vfpga/cells/luma';
import { hsvShiftCell } from '../../packages/web/src/lib/video/vfpga/cells/hsvshift';
import { conv3x3Cell } from '../../packages/web/src/lib/video/vfpga/cells/conv3x3';
import { macCell } from '../../packages/web/src/lib/video/vfpga/cells/mac';
import { quadDemodCell } from '../../packages/web/src/lib/video/vfpga/cells/quaddemod';
import { lut16Cell } from '../../packages/web/src/lib/video/vfpga/cells/lut16';
import type { VfpgaCell } from '../../packages/web/src/lib/video/vfpga/cells/types';

const P2_CELLS: VfpgaCell[] = [
  addCell, multiplyCell, diffCell, invertCell, gainCell, selectCell, lumaCell,
  hsvShiftCell, conv3x3Cell, macCell, quadDemodCell, lut16Cell,
];

/** Build the frag string for a cell exactly as place-and-route does (same uTexFor
 *  / uniformFor helpers) so we compile the PRODUCTION kernel. */
function fragFor(cell: VfpgaCell): string {
  const knobUniform = new Map(cell.knobs.map((k) => [k.name, k.uniform] as const));
  return cell.kernel({
    uTexFor: (input) => cellInputUniform(input),
    uniformFor: (knob) => knobUniform.get(knob) ?? `u_${knob}`,
  });
}

// The shared passthrough vertex shader the foundation uses (vUv → fragment).
const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

test.describe('vfpga P2 cells compile + link on a real WebGL2 context', () => {
  test('every P2 cell kernel compiles + links', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const cellFrags = P2_CELLS.map((c) => ({ key: `${c.type}:${c.op}`, frag: fragFor(c) }));

    const results = await page.evaluate(
      ({ cells, vert }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const gl = canvas.getContext('webgl2');
        if (!gl) return { supported: false as const, results: [] };

        const vs = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vs, vert);
        gl.compileShader(vs);

        const out: { key: string; ok: boolean; log: string }[] = [];
        for (const { key, frag } of cells) {
          const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
          gl.shaderSource(fs, frag);
          gl.compileShader(fs);
          const fsOk = !!gl.getShaderParameter(fs, gl.COMPILE_STATUS);
          if (!fsOk) {
            out.push({ key, ok: false, log: gl.getShaderInfoLog(fs) ?? '' });
            gl.deleteShader(fs);
            continue;
          }
          const prog = gl.createProgram()!;
          gl.attachShader(prog, vs);
          gl.attachShader(prog, fs);
          gl.linkProgram(prog);
          const linkOk = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
          out.push({ key, ok: linkOk, log: linkOk ? '' : gl.getProgramInfoLog(prog) ?? '' });
          gl.deleteProgram(prog);
          gl.deleteShader(fs);
        }
        return { supported: true as const, results: out };
      },
      { cells: cellFrags, vert: VERT },
    );

    // WebGL2 must be available in the test browser (it is on chromium + CI's
    // SwiftShader); only skip if a runner genuinely lacks WebGL2.
    test.skip(!results.supported, 'no WebGL2 context available in this runner');

    expect(results.results, 'all P2 cells reported').toHaveLength(P2_CELLS.length);
    for (const r of results.results) {
      expect(r.ok, `${r.key} compiles + links${r.log ? `: ${r.log}` : ''}`).toBe(true);
    }
  });
});
