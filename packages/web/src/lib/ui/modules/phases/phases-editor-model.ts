import {
  evaluatePhasesShape,
  type PhasesVertex,
} from '../../../../../../dsp/src/lib/phases-dsp';

export const PHASES_PLOT = { left: 12, top: 10, width: 296, height: 120 } as const;
export const PHASES_VIEWBOX = '0 0 320 140';
export const PHASES_COMPACT_PLOT = { left: 12, top: 5, width: 296, height: 40 } as const;
export const PHASES_COMPACT_VIEWBOX = '0 0 320 50';
type PhasesPlot = { left: number; top: number; width: number; height: number };

export const phasesX = (x: number, plot: PhasesPlot = PHASES_PLOT): number => plot.left + x * plot.width;
export const phasesY = (y: number, plot: PhasesPlot = PHASES_PLOT): number => plot.top + (1 - y) * plot.height;

/** The drawing samples the same curve the worklet evaluates, at fixed geometry. */
export function phasesSegmentPath(left: PhasesVertex, right: PhasesVertex, plot: PhasesPlot = PHASES_PLOT): string {
  const steps = Math.max(8, Math.ceil((right.x - left.x) * plot.width / 2));
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = phasesX(left.x + (right.x - left.x) * t, plot);
    const y = phasesY(left.y + (right.y - left.y) * evaluatePhasesShape(t, left.shape), plot);
    points.push(`${i ? 'L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`);
  }
  return points.join(' ');
}

export function phasesShapeName(value: number): string {
  if (value === 0 || value === 0.75) return 'Linear';
  if (value === 0.5) return 'Concave';
  if (value === 1) return 'Convex';
  return `${value < 0.75 ? 'Concave' : 'Convex'} · ${Math.round(value * 100)}%`;
}
