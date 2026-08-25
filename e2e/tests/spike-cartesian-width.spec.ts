// THROWAWAY WIDTH SPIKE — deleted before this branch is pushed.
//
// Measures what one cartesian pad row (4 x [entry + toggle + selector]) costs
// in CSS px against the 1220 px dock capture box, BEFORE the other three rows
// are written. See the #1509 scope report.

import { test, expect } from '@playwright/test';
import {
  bootWithFace,
  frameMember,
  openDock,
  unfoldDockPane,
  readFoldGeometry,
  foldViewportFor,
} from '../vrt/_shell-faces';

test('SPIKE: typed input reaches the graph, and an invalid one does NOT', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(foldViewportFor('cartesian'));
  const memberId = await bootWithFace(page, 'cartesian');
  await frameMember(page, memberId, 0.7, 'full');
  await openDock(page, memberId, 3);
  await unfoldDockPane(page);

  const read = () =>
    page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { cells?: Array<{ midi: number | null }> } }> };
      };
      return w.__patch.nodes[id]?.data?.cells?.[0]?.midi ?? null;
    }, memberId);

  // Scoped to the DOCK: the same cell also paints in the lane tile, so an
  // unscoped locator is a strict-mode violation rather than a defect.
  const field = page
    .getByTestId('faceplate-editor')
    .locator('[data-cell-key="cart-pad0-pitch-{n}"] input[data-role="entry"]');
  await field.waitFor();

  // POSITIVE: a valid note commits.
  await field.focus();
  await field.fill('c#3');
  await field.blur();
  await expect.poll(read, { message: 'a typed note reaches the graph' }).toBe(49);
  await expect(field).toHaveValue('c#3');

  // NEGATIVE: an out-of-range note is REFUSED and writes NOTHING — not clamped
  // to c8, not rounded, not partially applied.
  await field.focus();
  await field.fill('c9');
  await field.blur();
  await expect.poll(read, { message: 'a REFUSED note must not move the graph' }).toBe(49);
  await expect(field, 'and the field reverts to the stored value').toHaveValue('c#3');

  // A REST is an accepted value, not a rejection.
  await field.focus();
  await field.fill('');
  await field.blur();
  await expect.poll(read, { message: 'clearing the box is a REST' }).toBe(null);
});

test('SPIKE: cartesian dock width', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(foldViewportFor('cartesian'));
  const memberId = await bootWithFace(page, 'cartesian');
  await frameMember(page, memberId, 0.7, 'full');
  await openDock(page, memberId, 3);
  await unfoldDockPane(page);

  const g = await readFoldGeometry(page);
  const cells = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="dock-full-view"]') as HTMLElement | null;
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>('[data-cell-key]')).map((n) => {
      const r = n.getBoundingClientRect();
      return {
        key: n.getAttribute('data-cell-key') ?? '?',
        control: n.getAttribute('data-cell-control') ?? '?',
        w: Math.round(r.width * 10) / 10,
      };
    });
  });
  const rows = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="dock-full-view"]') as HTMLElement | null;
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>('[data-testid="face-page"]')).map((n) => {
      const r = n.getBoundingClientRect();
      return { id: n.getAttribute('data-face-page') ?? '?', w: Math.round(r.width), h: Math.round(r.height) };
    });
  });

  const byKind = new Map<string, number[]>();
  for (const c of cells) {
    if (!byKind.has(c.control)) byKind.set(c.control, []);
    byKind.get(c.control)!.push(c.w);
  }

  console.log('\n===== CARTESIAN WIDTH SPIKE =====');
  console.log(`contentW=${g.contentW}  bodyW=${g.bodyW}  plateW=${g.plateW}`);
  console.log(`hiddenX=${g.hiddenX}  scrollW=${g.scrollW}  clientW=${g.clientW}`);
  console.log(`hiddenY=${g.hiddenY}  scrollH=${g.scrollH}  clientH=${g.clientH}`);
  console.log(`cells rendered: ${cells.length}`);
  for (const [kind, ws] of [...byKind].sort()) {
    const min = Math.min(...ws);
    const max = Math.max(...ws);
    const sum = Math.round(ws.reduce((a, b) => a + b, 0) * 10) / 10;
    console.log(`  ${kind.padEnd(10)} n=${String(ws.length).padStart(2)}  ${min}..${max} px  sum=${sum}`);
  }
  console.log('bands:');
  for (const r of rows) console.log(`  ${r.id.padEnd(8)} ${r.w} x ${r.h}`);
  console.log('=================================\n');
});
