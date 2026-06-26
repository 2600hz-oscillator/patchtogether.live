// packages/web/src/lib/docs/interactive/use-doc-hover.svelte.ts
//
// A Svelte ACTION for the interactive virtual-module doc page. Attached to the
// VirtualModule root, it delegates `mouseover` / `focusin` and resolves the
// hovered SOURCE element to either a PATCH PORT or a FACEPLATE CONTROL, then
// publishes a `$state` `hovered` ref the DocHoverPane reads.
//
// RESOLUTION IS BY SOURCE ELEMENT, NOT GEOMETRY (the overlap of a faceplate
// control and the patch panel is solved by WHICH element you're over):
//   1. An element matching the patch-port attribute (`[data-port-id]` +
//      `[data-direction]` — the real attrs PatchPanel's port rows / back-jacks
//      expose) → a PORT. Looked up in docIndex.inputs / outputs.
//   2. Else the nearest `[data-testid^="control-"]` element → a CONTROL. The
//      testid is `control-<paramId>` (Knob/Fader) or a control-FAMILY member
//      `<prefix>-<id>-<i>`; we resolve it to a docIndex.controls key (a real
//      param id, a `<prefix>-{n}` family template, or a stripped button key)
//      using the SAME conventions as control-doc-resolver, so the pane shows
//      the authored prose the drift gate guarantees.
//
// Because the resolution keys are derived from the SAME control-doc-resolver
// conventions the legacy numbered-face KEY used, the interactive page and the
// static fallback explain identically — no second source of truth.

import type { ActionReturn } from 'svelte/action';
import type { DocIndex } from '$lib/docs/doc-index';
import { staticKey } from '$lib/docs/control-doc-resolver';

/** What the user is hovering. Resolved to a doc-index lookup the pane renders. */
export type HoverRef =
  | { kind: 'control'; key: string }
  | { kind: 'port'; id: string; direction: 'input' | 'output' };

/** The reactive hover state the page binds the pane to. */
export interface DocHoverState {
  /** Current hovered ref, or null (→ the pane's default explanation). */
  hovered: HoverRef | null;
}

export interface DocHoverOptions {
  /** The module's doc index (resolution target). */
  docIndex: DocIndex;
  /** The reactive state object to publish onto (a `$state` instance). */
  state: DocHoverState;
}

/** Family-template control keys in the index (`<prefix>-{n}`), longest-prefix
 *  first so an overlapping shorter prefix never wins (matches resolveLegend). */
function familyPrefixes(docIndex: DocIndex): string[] {
  const out: string[] = [];
  for (const k of Object.keys(docIndex.controls)) {
    const m = k.match(/^(.+)-\{n\}$/);
    if (m) out.push(m[1]);
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * Resolve a `control-…` testid to a docIndex.controls KEY.
 *
 * `control-<paramId>`             → `<paramId>`            (a Knob / Fader)
 * `<prefix>-<id>-<i>`             → `<prefix>-{n}`         (a control family)
 * anything else (a static button) → staticKey(testid)     (nodeId stripped)
 *
 * Returns null when no index key matches (an undocumented / unmapped control).
 */
export function resolveControlKey(testid: string, docIndex: DocIndex): string | null {
  // 1) control-<paramId>
  if (testid.startsWith('control-')) {
    const pid = testid.slice('control-'.length);
    return docIndex.controls[pid] ? pid : null;
  }
  // 2) control family `<prefix>-<id>-<i>` → `<prefix>-{n}`. The runtime nodeId
  //    sits between the prefix and the trailing index; match the prefix + a
  //    trailing integer, tolerating the id segment in between.
  for (const prefix of familyPrefixes(docIndex)) {
    // <prefix>-<anything>-<digits> OR <prefix>-<digits>
    const re = new RegExp(`^${escapeRe(prefix)}-(?:.+-)?\\d+$`);
    if (re.test(testid)) {
      const key = `${prefix}-{n}`;
      return docIndex.controls[key] ? key : null;
    }
  }
  // 3) static button — strip the nodeId segment to the stable doc key.
  const key = staticKey(testid);
  return docIndex.controls[key] ? key : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve a hovered element to a HoverRef (port first, then control). Exported
 *  for unit testing the resolution logic without a live DOM action. */
export function resolveHover(target: Element, docIndex: DocIndex): HoverRef | null {
  // 1) PORT — the nearest element carrying the patch-port attributes.
  const portEl = target.closest<HTMLElement>('[data-port-id][data-direction]');
  if (portEl) {
    const id = portEl.getAttribute('data-port-id');
    const direction = portEl.getAttribute('data-direction');
    if (id && (direction === 'input' || direction === 'output')) {
      const map = direction === 'input' ? docIndex.inputs : docIndex.outputs;
      if (map[id]) return { kind: 'port', id, direction };
    }
  }
  // 2) CONTROL — the nearest element whose testid starts with `control-` OR a
  //    family/button testid. We look at the nearest `[data-testid]` ancestor
  //    and try to resolve it to a control key.
  const tidEl = target.closest<HTMLElement>('[data-testid]');
  if (tidEl) {
    const tid = tidEl.getAttribute('data-testid');
    if (tid) {
      const key = resolveControlKey(tid, docIndex);
      if (key) return { kind: 'control', key };
    }
  }
  return null;
}

/**
 * Svelte action: delegate hover/focus resolution for the VirtualModule.
 *
 * Listens on DOCUMENT (capture) — not just the action node — because the patch
 * panel's chrome PORTALS to <body>, so its hovered port rows are NOT descendants
 * of the card root. A document-level delegated listener catches both the
 * in-card faceplate controls AND the portaled port rows; it only PUBLISHES when
 * a hover resolves to a known control/port (so unrelated page hovers are inert),
 * and clears when the pointer leaves the card root.
 *
 * Usage:
 *   const hover = $state<DocHoverState>({ hovered: null });
 *   <div use:docHover={{ docIndex, state: hover }}> … live card … </div>
 *   <DocHoverPane hovered={hover.hovered} {docIndex} />
 */
export function docHover(
  node: HTMLElement,
  options: DocHoverOptions,
): ActionReturn<DocHoverOptions> {
  let opts = options;

  const onOver = (e: Event) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const ref = resolveHover(target, opts.docIndex);
    // Publish only on a real resolution; an unrelated hover (or blank chrome)
    // leaves the last ref in place (less flicker). Clearing is mouseleave-only.
    if (ref) opts.state.hovered = ref;
  };

  const onLeave = (e: Event) => {
    // Leaving the card root resets to the default explanation. A patch-panel
    // chrome hover never triggers this (the pointer is over the portaled body
    // element, not exiting the card), so an open panel keeps the last port hover
    // until the pointer returns to a different surface.
    if (e.target === node) opts.state.hovered = null;
  };

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('focusin', onOver, true);
  node.addEventListener('mouseleave', onLeave);

  return {
    update(next: DocHoverOptions) {
      opts = next;
    },
    destroy() {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('focusin', onOver, true);
      node.removeEventListener('mouseleave', onLeave);
    },
  };
}
