// These functions execute in the indicated renderer via their compiled source.
// Keep them self-contained: the observer must read pixels and counts in one
// renderer turn, without a main-process sampling loop driving the subject.
import type { PATTERN, PixelSample } from './opener-display-logic';

export type SpikeFault = 'hidden' | 'blank-after-first' | 'frozen' | 'no-pulls' | 'frozen-composite';

export function installPattern(options: { fault?: SpikeFault; pattern: typeof PATTERN }, color: (frame: number) => [number, number, number]) {
  const host = window as Window & { __spikePopup?: Window; __spikePainted?: number };
  const popup = host.__spikePopup as (Window & {
    __presentFrame?: () => unknown; __spikeBlank?: boolean; __spikeFreeze?: boolean;
  }) | undefined;
  if (!popup || popup.closed) return { state: 'popup-closed' };
  let doc: Document;
  try { doc = popup.document; } catch (error) { return { state: 'dom-access-threw', error: String(error) }; }
  const canvas = doc.querySelector<HTMLCanvasElement>('[data-testid="present-canvas"]');
  if (!canvas) return { state: 'waiting-for-canvas' };
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return { state: 'no-2d-context' };
  if (options.fault === 'hidden') canvas.style.opacity = '0';
  let frame = 0;
  host.__spikePainted = 0;
  popup.__presentFrame = () => {
    if (options.fault === 'no-pulls') return { painted: 0, errors: 0 };
    if (popup.__spikeFreeze) return { painted: frame, errors: 0 };
    frame++;
    host.__spikePainted = frame;
    if (!popup.__spikeBlank) {
      const w = canvas.width, h = canvas.height;
      ctx.fillStyle = 'rgb(' + options.pattern.background.join(',') + ')';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgb(' + color(frame).join(',') + ')';
      ctx.fillRect(0, 0, options.pattern.counterSize, options.pattern.counterSize);
      // Obvious motion for the human check, away from both pixel probes.
      ctx.fillStyle = '#fff';
      ctx.fillRect((frame * 5) % Math.max(1, w - 80), Math.max(128, h * 0.6), 80, 40);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, Math.max(128, h - 80), w, 80);
      ctx.fillStyle = '#fff';
      ctx.font = '32px sans-serif';
      ctx.fillText('DISPLAY SPIKE  •  frame ' + frame, 24, h - 28);
    }
    return { protocol: 1, outcome: 'painted', painted: frame, errors: 0, slot: 'spike-opener-display' };
  };
  return { state: 'installed', sameOrigin: popup.location.origin === window.location.origin };
}

export interface FrameObservation {
  samples: PixelSample[];
  ticks: number;
  elapsedMs: number;
  geometryResets: number;
}

/** Independent popup rAF observer. The sink remains the only driver of draws.
 * Geometry changes restart the observation so fullscreen/DPR transitions don't
 * make a just-resized canvas look like a broken steady-state blit. */
export function observeFrames(options: { fault?: SpikeFault; timeoutMs: number; pattern: typeof PATTERN }): Promise<FrameObservation> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let ticks = 0, stable = 0, geometryResets = 0, raf = 0, geometry = '';
    let samples: PixelSample[] = [];
    const timer = setTimeout(() => done(new Error('No complete frame observation: ticks=' + ticks
      + ', samples=' + samples.length + ', elapsedMs=' + (performance.now() - start))), options.timeoutMs);
    function done(error?: Error) {
      clearTimeout(timer); cancelAnimationFrame(raf);
      if (error) reject(error);
      else resolve({ samples, ticks, elapsedMs: performance.now() - start, geometryResets });
    }
    function sample() {
      ticks++;
      try {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="present-canvas"]');
        if (!canvas) throw new Error('Present canvas disappeared');
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('Present canvas has no 2D context');
        const nextGeometry = canvas.width + 'x' + canvas.height;
        if (geometry !== nextGeometry) {
          if (geometry) geometryResets++;
          geometry = nextGeometry; stable = 0; samples = [];
        }
        stable++;
        const painted = (window.opener as { __spikePainted?: number } | null)?.__spikePainted ?? 0;
        if (stable >= 3 && painted >= 5 && canvas.width > options.pattern.backgroundProbe.x && canvas.height > options.pattern.backgroundProbe.y) {
          samples.push({ counter: Array.from(ctx.getImageData(options.pattern.counterProbe.x, options.pattern.counterProbe.y, 1, 1).data),
            background: Array.from(ctx.getImageData(options.pattern.backgroundProbe.x, options.pattern.backgroundProbe.y, 1, 1).data),
            painted, w: canvas.width, h: canvas.height });
          if (options.fault === 'blank-after-first' && samples.length === 1) {
            (window as Window & { __spikeBlank?: boolean }).__spikeBlank = true;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
          if (options.fault === 'frozen' && samples.length === 1) {
            (window as Window & { __spikeFreeze?: boolean }).__spikeFreeze = true;
          }
          if (samples.length >= 12) {
            if (options.fault === 'frozen-composite' && !document.querySelector('[data-spike-frozen]')) {
              const image = document.createElement('canvas');
              image.width = canvas.width; image.height = canvas.height;
              image.getContext('2d')!.drawImage(canvas, 0, 0);
              image.dataset.spikeFrozen = 'true';
              image.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:999999';
              document.body.append(image);
            }
            done(); return;
          }
        }
      } catch (error) { done(error instanceof Error ? error : new Error(String(error))); return; }
      raf = requestAnimationFrame(sample);
    }
    raf = requestAnimationFrame(sample);
  });
}

export function canvasCapturePoint(pattern: typeof PATTERN) {
  const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="present-canvas"]');
  if (!canvas || canvas.width <= pattern.backgroundProbe.x || canvas.height <= pattern.backgroundProbe.y) throw new Error('No usable canvas for capture');
  const rect = canvas.getBoundingClientRect();
  return { counter: { x: rect.left + (pattern.counterProbe.x + 0.5) * rect.width / canvas.width,
    y: rect.top + (pattern.counterProbe.y + 0.5) * rect.height / canvas.height }, x: rect.left + (pattern.backgroundProbe.x + 0.5) * rect.width / canvas.width,
    y: rect.top + (pattern.backgroundProbe.y + 0.5) * rect.height / canvas.height,
    viewport: { width: innerWidth, height: innerHeight },
    fullscreen: !!document.fullscreenElement };
}
