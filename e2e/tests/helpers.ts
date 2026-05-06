// e2e/tests/helpers.ts
//
// Shared utilities for the E2E suite.

import type { Page, ConsoleMessage } from '@playwright/test';

/** Capture all console messages and uncaught errors during a test. */
export interface CapturedConsole {
  messages: { type: string; text: string }[];
  errors: string[];
  pageErrors: string[];
}

export function captureConsole(page: Page): CapturedConsole {
  const out: CapturedConsole = { messages: [], errors: [], pageErrors: [] };
  page.on('console', (msg: ConsoleMessage) => {
    out.messages.push({ type: msg.type(), text: msg.text() });
    if (msg.type() === 'error') out.errors.push(msg.text());
  });
  page.on('pageerror', (err) => out.pageErrors.push(err.message));
  return out;
}

/** Read the AudioContext state from the canvas page (available after engine init). */
export async function readEngineState(page: Page) {
  return page.evaluate(() => {
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      // Anything else we want to expose for diagnostics:
      // (the canvas component already shows ctx state in the DOM, this is for raw access)
    };
  });
}

/** Pretty-print a CapturedConsole for AI-readable test output. */
export function formatConsole(cc: CapturedConsole, opts: { maxLines?: number } = {}): string {
  const max = opts.maxLines ?? 20;
  const lines: string[] = [];
  if (cc.pageErrors.length) {
    lines.push(`page errors (${cc.pageErrors.length}):`);
    for (const e of cc.pageErrors.slice(0, max)) lines.push(`  ! ${e}`);
  }
  if (cc.errors.length) {
    lines.push(`console errors (${cc.errors.length}):`);
    for (const e of cc.errors.slice(0, max)) lines.push(`  × ${e}`);
  }
  if (cc.messages.length) {
    const interesting = cc.messages
      .filter((m) => m.type === 'error' || m.type === 'warning' || m.text.includes('[canvas]'))
      .slice(0, max);
    if (interesting.length) {
      lines.push(`relevant console (${interesting.length}/${cc.messages.length}):`);
      for (const m of interesting) lines.push(`  [${m.type}] ${m.text}`);
    }
  }
  return lines.join('\n');
}
