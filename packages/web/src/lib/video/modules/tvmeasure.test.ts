// TEMPORARY measurement harness — deleted before the PR.
import { describe, it } from 'vitest';
import {
  simulateBackdraftTv,
  backdraftTvFill,
  backdraftTvBezel,
  backdraftTvDepth,
  backdraftTvLevelBrightness,
  backdraftTvGain,
  backdraftTvOpNorm,
  BACKDRAFT_TV_GLASS,
  BACKDRAFT_FLICKER_KNEE,
} from './backdraft';

/** Dark-bezel band centres along the centre row, walking right from centre. */
function bands(r: { frame: Float32Array; width: number; height: number }): number[] {
  const { frame, width: W, height: H } = r;
  const y = Math.floor(H / 2);
  const row: number[] = [];
  for (let x = 0; x < W; x++) row.push(frame[(y * W + x) * 3]!);
  const half = row.slice(Math.floor(W / 2));
  // local minima that dip >= 40% below the mean of the flanking local maxima
  const out: number[] = [];
  for (let i = 1; i < half.length - 1; i++) {
    if (!(half[i]! <= half[i - 1]! && half[i]! < half[i + 1]!)) continue;
    let l = i; while (l > 0 && half[l - 1]! >= half[l]!) l--;
    let rr = i; while (rr < half.length - 1 && half[rr + 1]! >= half[rr]!) rr++;
    const flank = (half[l]! + half[rr]!) / 2;
    if (flank > 1e-6 && half[i]! <= 0.6 * flank) out.push(i);
  }
  return out;
}

describe('PURE TV measurement', () => {
  it('measures the nest at the defaults', () => {
    const s = backdraftTvFill(1);
    const tb = backdraftTvBezel(0.4);
    console.log('fill', s, 'bezelTb', tb);
    const opNorm = backdraftTvOpNorm({ r: 1, g: 1, b: 1, luma: 1, chroma: 1 });
    const gain = backdraftTvGain(opNorm, 0.85, 1);
    console.log('opNorm', opNorm, 'gEff', gain);
    console.log('depth@1024', backdraftTvDepth({ fill: s, gain, widthPx: 1024, bezelTb: tb }));

    for (const size of [256, 512]) {
      const r = simulateBackdraftTv({ size, frames: 90, quantize: true });
      const b = bands(r);
      const ratios: string[] = [];
      // band radii measured from centre (the fixed point at offset 0)
      for (let i = 1; i < b.length; i++) ratios.push((b[i - 1]! / b[i]!).toFixed(3));
      console.log(`size=${size} bands=${b.length} radii=${b.join(',')}`);
      console.log(`  ratios(outer/inner)=${ratios.join(' ')}  lastDelta=${r.lastDelta}`);
      console.log(`  depth=${JSON.stringify(backdraftTvDepth({ fill: s, gain, widthPx: size, bezelTb: tb }))}`);
    }

    // brightness ladder: annulus means between successive bezels
    const r = simulateBackdraftTv({ size: 512, frames: 90, quantize: false });
    const b = bands(r);
    const y = Math.floor(r.height / 2);
    const cx = r.width / 2;
    const ladder: string[] = [];
    // Analytic annulus geometry: picture edge at level k is s^(k+1)*W/2 px from
    // centre; the bezel's outer edge is s^(k+1)*(W/2 + tb*W/a).
    const pic = (k: number) => Math.pow(s, k + 1) * (r.width / 2);
    const bez = (k: number) => Math.pow(s, k + 1) * (r.width / 2 + (tb * r.width) / r.aspect);
    for (let k = 1; k <= 8; k++) {
      const x0 = cx + bez(k) + 1, x1 = cx + pic(k - 1) - 1;
      let sum = 0, n = 0;
      for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) { sum += r.frame[(y * r.width + x) * 3]!; n++; }
      ladder.push(n > 0 ? (sum / n).toFixed(3) : '--');
    }
    const roomX = r.width - 4;
    console.log('room value', r.frame[(y * r.width + roomX) * 3]);
    console.log('annulus ladder (outer->inner, red ch):', ladder.join(' '));
    const P = BACKDRAFT_TV_GLASS * 1;
    console.log('predicted no-shoulder:', [0, 1, 2, 3, 4, 5, 6].map((k) => backdraftTvLevelBrightness(k, gain, P, 1, 1).toFixed(3)).join(' '));
    console.log('predicted w/ shoulder:', [0, 1, 2, 3, 4, 5, 6].map((k) => backdraftTvLevelBrightness(k, gain, P, 1, BACKDRAFT_FLICKER_KNEE).toFixed(3)).join(' '));

    // (a) knee=1 (the design doc's own no-shoulder assumption) must reproduce
    //     the published 1.000/0.880/0.778/... table.
    const rn = simulateBackdraftTv({ size: 512, frames: 90, knee: 1 });
    const lad2: string[] = [];
    for (let k = 1; k <= 6; k++) {
      const x0 = cx + bez(k) + 1, x1 = cx + pic(k - 1) - 1;
      let sum = 0, n = 0;
      for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) { sum += rn.frame[(y * rn.width + x) * 3]!; n++; }
      lad2.push(n > 0 ? (sum / n).toFixed(3) : '--');
    }
    console.log('measured knee=1 ladder:', lad2.join(' '));

    // (b) dim rooms: the shoulder is the identity below 0.55, so §1.7's table
    //     should be exact.
    for (const rm of [0.5, 0.3, 0.15]) {
      const rr = simulateBackdraftTv({ size: 512, frames: 90, room: rm });
      const l: string[] = [];
      for (let k = 1; k <= 5; k++) {
        const x0 = cx + bez(k) + 1, x1 = cx + pic(k - 1) - 1;
        let sum = 0, n = 0;
        for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) { sum += rr.frame[(y * rr.width + x) * 3]!; n++; }
        l.push(n > 0 ? (sum / n).toFixed(4) : '--');
      }
      console.log(`room=${rm} ladder:`, rm.toFixed(4), l.join(' '),
        ' predicted:', [1, 2, 3, 4, 5].map((k) => backdraftTvLevelBrightness(k, gain, BACKDRAFT_TV_GLASS * rm, rm, BACKDRAFT_FLICKER_KNEE).toFixed(4)).join(' '));
    }
  });
});
