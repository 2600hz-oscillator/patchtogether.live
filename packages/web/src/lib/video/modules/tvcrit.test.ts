// TEMPORARY measurement harness for CRITICAL — deleted before the PR.
import { describe, it } from 'vitest';
import { simulateBackdraftTv, backdraftTvDriveGain, BACKDRAFT_TV_NOISE } from './backdraft';

/** Pearson correlation between two frames, on the red channel, mean-removed. */
function corr(a: Float32Array, b: Float32Array): number {
  let ma = 0, mb = 0, n = 0;
  for (let i = 0; i < a.length; i += 3) { ma += a[i]!; mb += b[i]!; n++; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i += 3) {
    const da = a[i]! - ma, db = b[i]! - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return sab / Math.sqrt(Math.max(1e-12, saa * sbb));
}
function meanAbsDiff(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}
function stats(a: Float32Array): { mean: number; sd: number } {
  let m = 0, n = 0;
  for (let i = 0; i < a.length; i += 3) { m += a[i]!; n++; }
  m /= n;
  let v = 0;
  for (let i = 0; i < a.length; i += 3) v += (a[i]! - m) ** 2;
  return { mean: m, sd: Math.sqrt(v / n) };
}

/** Run and capture snapshots at the given frame indices. */
function run(opts: Record<string, unknown>, snaps: number[]): { snap: Map<number, Float32Array>; last: Float32Array } {
  const snap = new Map<number, Float32Array>();
  const r = simulateBackdraftTv({
    size: 128, frames: Math.max(...snaps) + 1, ...opts,
    onFrame: (n, f) => { if (snaps.includes(n)) snap.set(n, f.slice()); },
  } as never);
  return { snap, last: r.frame };
}

describe('CRITICAL measurement', () => {
  it('drive law', () => {
    for (const d of [0, 0.1, 0.147, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.956, 1])
      console.log(' drive', d.toFixed(3), 'lambda', backdraftTvDriveGain(d).toFixed(4));
  });

  it('sweep2: lag mechanisms + BLURRED (large-scale) correlation', () => {
    const SN = [200, 240, 300, 380];
    // 4x4 block-average: kills pixel noise, keeps travelling annuli.
    const blur = (f: Float32Array, W: number, H: number): Float32Array => {
      const bw = Math.floor(W / 4), bh = Math.floor(H / 4);
      const o = new Float32Array(bw * bh * 3);
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        let s = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) s += f[((by * 4 + y) * W + bx * 4 + x) * 3]!;
        o[(by * bw + bx) * 3] = s / 16;
      }
      return o;
    };
    const cases: [string, Record<string, unknown>][] = [];
    for (const fill of [1.0, 1.05, 1.1]) {
      for (const phos of [0, 0.5, 0.8, 1.0]) {
        for (const drive of [0.5, 0.6, 0.7]) {
          cases.push([`fill=${fill} phos=${phos} drv=${drive} dly=1`, { fill, phosphor: phos, drive, rotate: 3, delayFrames: 1 }]);
        }
      }
    }
    cases.push(['fill=1.05 phos=0.8 drv=0.6 noise=0.03', { fill: 1.05, phosphor: 0.8, drive: 0.6, rotate: 3, noise: 0.03 }]);
    cases.push(['fill=1.05 phos=0.8 drv=0.6 rot=0     ', { fill: 1.05, phosphor: 0.8, drive: 0.6, rotate: 0 }]);
    cases.push(['CTRL contraction phos=0.8 drv=0.6    ', { fill: 0.75, phosphor: 0.8, drive: 0.6, rotate: 3 }]);
    cases.push(['CTRL fill=1.05 phos=0.8 drv=0.0      ', { fill: 1.05, phosphor: 0.8, drive: 0.0, rotate: 3 }]);
    for (const [label, o] of cases) {
      const { snap } = run({ critical: true, ...o }, SN);
      const a = snap.get(200)!, b = snap.get(240)!, c = snap.get(300)!, e = snap.get(380)!;
      const [W, H] = [128, Math.round(128 / (4 / 3))];
      const ba = blur(a, W, H), bb = blur(b, W, H), bc = blur(c, W, H), be = blur(e, W, H);
      console.log(
        'S2', label.padEnd(38),
        '| raw 1-c40', (1 - corr(a, b)).toExponential(2),
        '| BLUR 1-c40', (1 - corr(ba, bb)).toExponential(2),
        '| BLUR 1-c100', (1 - corr(ba, bc)).toExponential(2),
        '| BLUR 1-c(300,380)', (1 - corr(bc, be)).toExponential(2),
        '| mean', stats(e).mean.toFixed(3),
      );
    }
  }, 900_000);

  it('sweep: where do the dynamics live?', () => {
    const SN = [200, 220, 260, 300, 380];
    for (const fill of [0.75, 1.0, 1.05, 1.1, 1.2]) {
      for (const dly of [1, 2, 3, 4, 6, 10]) {
        for (const drive of [0.5, 0.7, 0.9]) {
          const { snap } = run({ critical: true, drive, rotate: 3, fill, delayFrames: dly }, SN);
          const a = snap.get(200)!, b = snap.get(220)!, c = snap.get(260)!, e = snap.get(300)!, f = snap.get(380)!;
          const st = stats(f);
          console.log(
            `SWEEP fill=${fill.toFixed(2)} dly=${String(dly).padStart(2)} drive=${drive}`,
            '| mad', meanAbsDiff(a, b).toExponential(2),
            '| c20', corr(a, b).toFixed(4),
            '| c60', corr(a, c).toFixed(4),
            '| c100', corr(a, e).toFixed(4),
            '| c300-380', corr(e, f).toFixed(4),
            '| mean', st.mean.toFixed(3), 'sd', st.sd.toFixed(3),
          );
        }
      }
    }
  }, 600_000);

  it('does CRITICAL sustain motion?', () => {
    const SN = [120, 140, 160, 180, 200];
    const cases: [string, Record<string, unknown>][] = [
      ['PURE TV       (contraction, no noise)', { critical: false }],
      ['contraction + noise (CONTROL)        ', { critical: false, noise: BACKDRAFT_TV_NOISE }],
      ['CRITICAL d=0.5 rot=0                 ', { critical: true, drive: 0.5 }],
      ['CRITICAL d=0.5 rot=3 (phi=18)        ', { critical: true, drive: 0.5, rotate: 3 }],
      ['CRITICAL d=0.7 rot=3                 ', { critical: true, drive: 0.7, rotate: 3 }],
      ['CRITICAL d=0.9 rot=3                 ', { critical: true, drive: 0.9, rotate: 3 }],
      ['CRITICAL d=1.0 rot=0                 ', { critical: true, drive: 1.0 }],
      ['CRITICAL d=0.7 rot=3 delay=4         ', { critical: true, drive: 0.7, rotate: 3, delayFrames: 4 }],
      ['CRITICAL d=0.9 rot=3 delay=8         ', { critical: true, drive: 0.9, rotate: 3, delayFrames: 8 }],
      ['CRITICAL d=0.9 rot=3 phos=0.8        ', { critical: true, drive: 0.9, rotate: 3, phosphor: 0.8 }],
      // EXPANDING regime — fill >= 1: the picture overfills the frame, the
      // boundary data is pushed off-frame and lost, so the loop CLOSES.
      ['EXPAND fill=1.00 d=0.5 rot=3         ', { critical: true, drive: 0.5, rotate: 3, fill: 1.0 }],
      ['EXPAND fill=1.05 d=0.5 rot=3         ', { critical: true, drive: 0.5, rotate: 3, fill: 1.05 }],
      ['EXPAND fill=1.05 d=0.7 rot=3         ', { critical: true, drive: 0.7, rotate: 3, fill: 1.05 }],
      ['EXPAND fill=1.10 d=0.7 rot=3         ', { critical: true, drive: 0.7, rotate: 3, fill: 1.10 }],
      ['EXPAND fill=1.15 d=0.7 rot=5         ', { critical: true, drive: 0.7, rotate: 5, fill: 1.15 }],
      ['EXPAND fill=1.15 d=0.9 rot=5         ', { critical: true, drive: 0.9, rotate: 5, fill: 1.15 }],
      ['EXPAND fill=1.25 d=0.9 rot=5         ', { critical: true, drive: 0.9, rotate: 5, fill: 1.25 }],
      ['EXPAND fill=1.10 d=0.4 rot=3 (CTRL)  ', { critical: true, drive: 0.4, rotate: 3, fill: 1.10 }],
      ['EXPAND fill=1.10 d=0.0 rot=3 (CTRL)  ', { critical: true, drive: 0.0, rotate: 3, fill: 1.10 }],
      ['EXPAND fill=1.10 d=0.7 rot=3 dly=4   ', { critical: true, drive: 0.7, rotate: 3, fill: 1.10, delayFrames: 4 }],
      ['EXPAND fill=1.10 d=0.7 rot=3 noNoise ', { critical: true, drive: 0.7, rotate: 3, fill: 1.10, noise: 0 }],
    ];
    for (const [label, o] of cases) {
      const { snap } = run(o, SN);
      const f120 = snap.get(120)!, f140 = snap.get(140)!, f160 = snap.get(160)!, f200 = snap.get(200)!;
      const st = stats(f200);
      console.log(
        label,
        '| mad(120,140)', meanAbsDiff(f120, f140).toExponential(2),
        '| corr(120,140)', corr(f120, f140).toFixed(4),
        '| corr(120,160)', corr(f120, f160).toFixed(4),
        '| corr(120,200)', corr(f120, f200).toFixed(4),
        '| mean', st.mean.toFixed(3), 'sd', st.sd.toFixed(3),
      );
    }
  }, 120_000);
});
