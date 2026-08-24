// TEMPORARY visual-proof spec — deleted before the PR. Drives the owner's real
// path and screenshots what each right-click actually produces.
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'serial' });

test('PROOF: what the owner sees now', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'tl', type: 'timelorde', position: { x: 40, y: 40 }, domain: 'audio' },
    { id: 'cp', type: 'clipplayer', position: { x: 420, y: 40 }, domain: 'audio' },
  ]);
  await expect(page.locator('[data-clip="0"]')).toBeVisible();

  // Make a clip the way a user does, and draw a note.
  await page.locator('[data-clip="0"]').dblclick();
  await expect(page.getByTestId('clipplayer-pianoroll')).toBeVisible();
  const cell = page.getByTestId('clipplayer-cell-6-4');
  await cell.click();

  // RIGHT-CLICK THE NOTE.
  await cell.click({ button: 'right' });
  await page.screenshot({ path: 'proof-01-note-menu.png' });
  const noteMenu = page.getByTestId('clipplayer-prob-menu-cp');
  console.log('NOTE MENU:', JSON.stringify(await noteMenu.innerText()));
  await page.getByTestId('clipplayer-sub-note-cp').click();
  await page.screenshot({ path: 'proof-02-note-flyout.png' });
  await page.getByTestId('clipplayer-menu-clear-cp').click();

  // Back to the launcher grid, right-click a clip pad (the owner's screenshot).
  await page.getByTestId('clipplayer-strip-2-cp').click();
  await page.getByTestId('clipplayer-strip-6-cp').click(); // undo the clear
  await expect(page.locator('[data-clip="0"]')).toHaveAttribute('data-state', 'loaded');
  await page.locator('[data-clip="0"]').click({ button: 'right' });
  await page.screenshot({ path: 'proof-03-pad-menu.png' });
  const clipMenu = page.getByTestId('clipplayer-clip-prob-menu-cp');
  console.log('CLIP MENU:', JSON.stringify(await clipMenu.innerText()));

  // Expand each of the three on the PAD menu.
  await page.getByTestId('clipplayer-sub-note-cp').click();
  await page.screenshot({ path: 'proof-04-pad-note-prob.png' });
  console.log('PAD note-prob flyout:', (await page.getByTestId('clipplayer-submenu-note-cp').innerText()).slice(0, 60).replace(/\n/g, ' | '));
  await page.getByTestId('clipplayer-sub-pitch-cp').click();
  await page.screenshot({ path: 'proof-05-pad-pitch-prob.png' });
  await page.getByTestId('clipplayer-sub-skip-cp').click();
  await page.screenshot({ path: 'proof-06-pad-skip-every.png' });
  console.log('PAD skip-every flyout:', (await page.getByTestId('clipplayer-submenu-skip-cp').innerText()).replace(/\n/g, ' | '));

  // An EMPTY pad: same shape, only paste is live (and it is disabled with an
  // empty clipboard).
  await page.keyboard.press('Escape');
  await page.getByTestId('clipplayer-menu-clear-cp').press('Escape').catch(() => {});
  await page.locator('.prob-menu-backdrop').click();
  await page.locator('[data-clip="5"]').click({ button: 'right' });
  await page.screenshot({ path: 'proof-07-empty-pad.png' });
  console.log('EMPTY PAD MENU:', JSON.stringify(await page.getByTestId('clipplayer-clip-prob-menu-cp').innerText()));
});
