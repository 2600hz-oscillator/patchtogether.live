// e2e/vrt/annotate-controls.ts
//
// Numbered-control overlay helper for the docs-overhaul "numbered device-face"
// screenshot pipeline (.myrobots/plans/docs-overhaul-plan-2026-06-23.md §4a).
//
// Given a spawned module card Locator, this:
//   1. enumerates the card's interactive CONTROLS — preferring a stable
//      `[data-testid^="control-"]` (Knob/Fader expose `control-<paramId>`),
//      falling back to ARIA sliders / native form controls / buttons so a card
//      without param testids still numbers,
//   2. measures each control's on-card position (relative to the card, divided
//      by the card's rendered scale so it's invariant to SvelteFlow's
//      zoom/pan transform), assigns a reading-order NUMBER,
//   3. injects a TRANSIENT numbered SVG overlay (numbered circles at control
//      centers) so the screenshot shows ①②③ on the real rendered card,
//   4. returns the number→control map the spec serializes to the legend JSON.
//
// The overlay is removed by removeControlOverlay() after the snap, so it never
// touches prod card code OR the VRT baselines — only the annotated face PNG.
//
// All measurement + injection happens in ONE card.evaluate so positions read
// from getBoundingClientRect() are in a single coordinate space — critical
// because SvelteFlow CSS-transforms the node container (zoom/pan), which would
// otherwise double-offset a Playwright viewport-space boundingBox() against the
// overlay appended INSIDE the transformed node.

import type { Locator } from '@playwright/test';

export interface ControlEntry {
  /** 1-based reading-order number drawn on the face + shown in the legend. */
  n: number;
  /** The control's stable handle — a `data-testid` when present, else a
   *  synthesised `kind:N` key. Maps to a ParamDef.id when it's a
   *  `control-<paramId>` testid (the Knob/Fader convention). */
  testid: string;
  /** What kind of control this is, for the legend ("knob"/"fader"/"button"/…). */
  kind: string;
}

const OVERLAY_ID = 'vrt-control-annotations';

/** Selector for the things we number. data-testid first (the stable contract:
 *  Knob/Fader expose `control-<paramId>`), then ARIA sliders, native form
 *  controls (custom cards use `<input type=range>` / `<select>`), then buttons
 *  — so a control without a `control-` testid is still numbered rather than
 *  silently dropped. */
const CONTROL_SELECTOR = [
  '[data-testid^="control-"]',
  '[role="slider"]',
  'input[type="range"]',
  'input[type="number"]',
  'select',
  'button',
].join(', ');

/** Card-CHROME elements that match CONTROL_SELECTOR but are NOT module
 *  controls — the yellow PATCH PANEL drill-down affordances + the editable
 *  name label. We don't number these (they're the same on every card). Matched
 *  by data-testid prefix/exact. */
const CHROME_TESTIDS = ['patch-trigger', 'patch-trigger-right', 'name-label-button'];

/**
 * Enumerate + number every control on the card, then inject the overlay.
 * Returns the number→control map (sans bbox) for the legend JSON. The caller
 * snaps the screenshot, then calls removeControlOverlay().
 */
export async function annotateControlsOnCard(card: Locator): Promise<ControlEntry[]> {
  return card.evaluate(
    (el, { selector, chromeTestids, overlayId }) => {
      const NS = 'http://www.w3.org/2000/svg';
      const doc = el.ownerDocument;
      const win = doc.defaultView!;

      // The card's rendered scale = the SvelteFlow zoom baked into its (or an
      // ancestor's) CSS transform. getBoundingClientRect already includes it,
      // so to express positions in the card's UNTRANSFORMED local space (which
      // is what the appended SVG uses) we divide the on-screen delta by the
      // measured scale (cardRect.width / card.offsetWidth).
      const cardRect = el.getBoundingClientRect();
      const scale = cardRect.width / (el as HTMLElement).offsetWidth || 1;

      const kindOf = (c: Element): string => {
        const role = c.getAttribute('role');
        const cls = typeof c.className === 'string' ? c.className : '';
        if (cls.includes('fader') || cls.includes('track')) return 'fader';
        if (cls.includes('knob')) return 'knob';
        if (role === 'slider') return 'slider';
        const tag = c.tagName.toLowerCase();
        if (tag === 'input') return (c.getAttribute('type') || 'input') + '-input';
        return tag;
      };

      interface Box {
        testid: string;
        kind: string;
        cx: number;
        cy: number;
        h: number;
        y: number;
        x: number;
      }
      const boxes: Box[] = [];
      const seen = new Set<string>();
      let anon = 0;
      for (const c of Array.from(el.querySelectorAll(selector))) {
        const r = c.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const explicit = c.getAttribute('data-testid');
        if (explicit && chromeTestids.includes(explicit)) continue;
        const kind = kindOf(c);
        const testid = explicit ?? `${kind}:${anon++}`;
        if (seen.has(testid)) continue;
        seen.add(testid);
        // Center + height in the card's local (untransformed) coordinate space.
        const cx = (r.left + r.width / 2 - cardRect.left) / scale;
        const cy = (r.top + r.height / 2 - cardRect.top) / scale;
        const h = r.height / scale;
        boxes.push({ testid, kind, cx, cy, h, x: cx, y: cy });
      }

      // Reading order: top→bottom, then left→right (row-major) with a small
      // vertical tolerance so controls on the same visual row sort by x.
      const ROW_TOL = 16;
      boxes.sort((a, b) => (Math.abs(a.y - b.y) > ROW_TOL ? a.y - b.y : a.x - b.x));

      // Inject the overlay (absolute, anchored to the card's local space).
      doc.getElementById(overlayId)?.remove();
      const localW = (el as HTMLElement).offsetWidth;
      const localH = (el as HTMLElement).offsetHeight;
      const svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('id', overlayId);
      svg.setAttribute('width', String(localW));
      svg.setAttribute('height', String(localH));
      Object.assign(svg.style, {
        position: 'absolute',
        left: '0px',
        top: '0px',
        width: `${localW}px`,
        height: `${localH}px`,
        pointerEvents: 'none',
        zIndex: '99999',
      });
      const cs = win.getComputedStyle(el);
      if (cs.position === 'static') (el as HTMLElement).style.position = 'relative';

      // CALLOUT style (not a circle ON the control — that hid buttons and
      // covered sliders). For each control: a tiny anchor dot ON it, a thin
      // leader line down to a numbered circle rendered just BELOW the control.
      // If a control sits too close to the card's bottom edge for the circle to
      // fit, the callout flips ABOVE instead, so it never spills off the face.
      const R = 9; // numbered-circle radius
      const LEADER = 8; // gap between the control edge and the circle
      boxes.forEach((b, i) => {
        const g = doc.createElementNS(NS, 'g');
        const half = b.h / 2;
        const ctrlBottom = b.cy + half;
        const ctrlTop = b.cy - half;
        // Prefer BELOW; flip ABOVE when the circle wouldn't fit before the edge.
        let circleCy = ctrlBottom + LEADER + R;
        let anchorY = ctrlBottom;
        if (circleCy + R > localH - 1) {
          circleCy = ctrlTop - LEADER - R;
          anchorY = ctrlTop;
        }
        const below = circleCy > b.cy;
        const circleCx = Math.max(R + 1, Math.min(localW - R - 1, b.cx));
        // Thin leader line: control edge → circle edge.
        const line = doc.createElementNS(NS, 'line');
        line.setAttribute('x1', String(b.cx));
        line.setAttribute('y1', String(anchorY));
        line.setAttribute('x2', String(circleCx));
        line.setAttribute('y2', String(below ? circleCy - R : circleCy + R));
        line.setAttribute('stroke', '#ff2d6f');
        line.setAttribute('stroke-width', '1.5');
        // Small dot ON the control marking what the number points at.
        const dot = doc.createElementNS(NS, 'circle');
        dot.setAttribute('cx', String(b.cx));
        dot.setAttribute('cy', String(anchorY));
        dot.setAttribute('r', '2.5');
        dot.setAttribute('fill', '#ff2d6f');
        dot.setAttribute('stroke', '#ffffff');
        dot.setAttribute('stroke-width', '1');
        // The numbered circle, offset clear of the control.
        const circle = doc.createElementNS(NS, 'circle');
        circle.setAttribute('cx', String(circleCx));
        circle.setAttribute('cy', String(circleCy));
        circle.setAttribute('r', String(R));
        circle.setAttribute('fill', '#ff2d6f');
        circle.setAttribute('stroke', '#ffffff');
        circle.setAttribute('stroke-width', '2');
        const text = doc.createElementNS(NS, 'text');
        text.setAttribute('x', String(circleCx));
        text.setAttribute('y', String(circleCy + 0.5));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('font-family', 'monospace');
        text.setAttribute('font-size', '11');
        text.setAttribute('font-weight', '700');
        text.setAttribute('fill', '#ffffff');
        text.textContent = String(i + 1);
        g.appendChild(line);
        g.appendChild(dot);
        g.appendChild(circle);
        g.appendChild(text);
        svg.appendChild(g);
      });
      el.appendChild(svg);

      return boxes.map((b, i) => ({ n: i + 1, testid: b.testid, kind: b.kind }));
    },
    { selector: CONTROL_SELECTOR, chromeTestids: CHROME_TESTIDS, overlayId: OVERLAY_ID },
  );
}

/** Remove the transient overlay (leave the card pristine). */
export async function removeControlOverlay(card: Locator): Promise<void> {
  await card.evaluate((el, overlayId) => {
    el.ownerDocument.getElementById(overlayId)?.remove();
  }, OVERLAY_ID);
}
