import { chromium } from '@playwright/test';
const APP = 'http://localhost:5939';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
log('launching');
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-features=MidiMacUmp', '--autoplay-policy=no-user-gesture-required'],
});
log('launched');
const context = await browser.newContext();
await context.grantPermissions(['midi', 'midi-sysex'], { origin: APP });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') log('[page-error]', m.text()); });
page.on('pageerror', (e) => log('[pageerror]', String(e)));
log('goto');
await page.goto(`${APP}/rack?shell=legacy&seed=none`, { waitUntil: 'domcontentloaded', timeout: 60000 });
log('goto done');
await page.waitForFunction(() => typeof globalThis.__ensureEngine === 'function', { timeout: 60000 });
log('__ensureEngine present');
await page.evaluate(async () => { await globalThis.__ensureEngine(); });
log('engine up');
await page.evaluate(() => {
  const w = globalThis;
  w.__ydoc.transact(() => {
    for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
    for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
    w.__patch.nodes['lfo'] = { id: 'lfo', type: 'lfo', domain: 'audio', position: { x: 60, y: 200 }, params: { rate: 0.2, depth: 0.05 } };
    w.__patch.nodes['m'] = { id: 'm', type: 'ptzcam', domain: 'audio', position: { x: 400, y: 200 }, params: {} };
    w.__patch.edges['e-pan'] = { id: 'e-pan', source: { nodeId: 'lfo', portId: 'phase0' }, target: { nodeId: 'm', portId: 'pan_cv' }, sourceType: 'cv', targetType: 'cv' };
  });
});
log('patch written');
await page.waitForSelector('.svelte-flow__node-ptzcam', { timeout: 30000 });
log('card mounted, clicking connect');
await page.locator('[data-testid="ptzcam-connect-m"]').click({ timeout: 15000 });
log('connect clicked');
const readState = () => page.evaluate(() => {
  const eng = globalThis.__engine?.();
  const node = globalThis.__patch.nodes['m'];
  if (!eng || !node) return null;
  return eng.read(node, 'state');
});
for (let i = 0; i < 40; i++) {
  const s = await readState();
  if (s?.status === 'bound') break;
  if (i === 39) {
    log('NOT BOUND. status:', s?.status, 'msg:', await page.locator('[data-testid="ptzcam-status-m"]').textContent());
    await browser.close();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}
log('BOUND. streaming LFO → pan for 12s …');
const s0 = await readState();
await new Promise((r) => setTimeout(r, 12000));
const s1 = await readState();
log('sentFrames:', s0.sentFrames, '→', s1.sentFrames, ' lastSent:', JSON.stringify(s1.lastSent));
await page.evaluate(() => {
  globalThis.__ydoc.transact(() => {
    globalThis.__patch.nodes['lfo'].params.depth = 0;
    globalThis.__patch.nodes['m'].params.pan = 0.02;
  });
});
await new Promise((r) => setTimeout(r, 3000));
const s2 = await readState();
log('after knob write: lastSent:', JSON.stringify(s2.lastSent), 'sentFrames:', s2.sentFrames);
await browser.close();
log('VALIDATION SCRIPT DONE');
