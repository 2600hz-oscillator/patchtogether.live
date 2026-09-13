// Owner-hardware opener→popup spike. The real /present page owns the drawing
// clock. Canvas pixels, a page capture, and the owner's physical observation
// answer different questions; none is silently substituted for another.
import { app, BrowserWindow, dialog, screen, session, type WebContents } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startStaticServer } from '../server';
import { HARDENED_WEB_PREFERENCES, installSecurity, installWindowGuards } from '../security';
import { approxColor, compositeAdvanced, counterColor, displayContaining, HARDWARE_REFUSAL, isOnDisplay,
  motionAdvanced, PATTERN, pickTargetDisplay, popupBoundsOn, popupFeatures, STEP_ORDER,
  validSample, verdict, type DisplayLike, type StepResult } from './opener-display-logic';
import { canvasCapturePoint, installPattern, observeFrames, type FrameObservation,
  type SpikeFault } from './opener-display-renderer';

app.commandLine.appendSwitch('disable-features', 'MidiMacUmp');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const DRY_RUN = process.argv.includes('--dry-run') || process.env.PT_SPIKE_DRY_RUN === '1';
const CRASH_PROBE = process.argv.includes('--crash-probe') || process.env.PT_SPIKE_CRASH_PROBE === '1';
const FAULT = process.env.PT_SPIKE_TEST_FAULT as SpikeFault | undefined;
const SPIKE_DEADLINE_MS = 150_000;
const FRAME_DEADLINE_MS = 20_000;
const startedAt = new Date().toISOString();
const resultDir = process.env.PT_SPIKE_RESULTS_DIR
  ? path.resolve(process.env.PT_SPIKE_RESULTS_DIR) : path.resolve(__dirname, '../../spike-results');
const resultStem = `opener-display-${startedAt.replace(/[:.]/g, '-')}-${process.pid}`;
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pt-spike-')));

const steps: StepResult[] = [];
const observations: Record<string, unknown> = {};
let displays: DisplayLike[] = [];
let primaryDisplayId: number | null = null;
let crashProbe: Record<string, unknown> | null = null;
let watchdog: NodeJS.Timeout | undefined;
let finished = false;
function setStep(step: StepResult): void {
  const at = steps.findIndex((s) => s.id === step.id);
  if (at < 0) steps.push(step); else steps[at] = step;
}
function stripDisplay(d: Electron.Display): DisplayLike {
  return { id: d.id, bounds: d.bounds, workArea: d.workArea,
    label: d.label, scaleFactor: d.scaleFactor, detected: d.detected };
}
function finish(error?: string): never {
  if (finished) throw new Error('spike-finished');
  finished = true; clearTimeout(watchdog);
  const v = verdict(steps, { dryRun: DRY_RUN, error });
  const record = { schemaVersion: 2, spike: 'opener-display', date: startedAt,
    mode: DRY_RUN ? 'dry-run' : 'real', electron: process.versions.electron,
    platform: `${process.platform} ${os.release()}`, displays, primaryDisplayId,
    steps, observations, crashProbe, verdictLines: v.lines, exitCode: v.exitCode };
  const outFile = path.join(resultDir, resultStem + '.json');
  try {
    fs.mkdirSync(resultDir, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  } catch (writeError) {
    // A recorded hardware result is the deliverable. No file means no PASS.
    console.error(`RESULT WRITE FAILED: ${String(writeError)}`);
    console.error(JSON.stringify({ ...record, exitCode: 1, verdictLines: ['RESULT WRITE FAILED'] }));
    app.exit(1); throw new Error('spike-finished');
  }
  console.log('\n── opener→popup cross-display spike ──');
  for (const line of v.lines) console.log(line);
  console.log(`JSON record: ${outFile}`);
  app.exit(v.exitCode); throw new Error('spike-finished');
}
function fail(id: StepResult['id'], detail: string): never {
  setStep({ id, status: 'FAIL', detail }); return finish();
}
function armWatchdog(): void {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    try { finish(`WATCHDOG TIMEOUT after ${SPIKE_DEADLINE_MS}ms`); } catch { /* exit requested */ }
  }, SPIKE_DEADLINE_MS);
  watchdog.unref();
}
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** One IPC call. Readiness advances in the renderer's frames, not main-process polls. */
async function waitForRenderer<T>(wc: WebContents, expression: string,
  done: (v: T) => boolean, ms: number, label: string): Promise<T> {
  const script = `new Promise((resolve, reject) => {
    const start = performance.now(); let ticks = 0, raf = 0, last;
    const timer = setTimeout(() => { cancelAnimationFrame(raf);
      reject(new Error(${JSON.stringify(label)} + ': ticks=' + ticks + ', elapsedMs='
        + (performance.now() - start) + ', last=' + JSON.stringify(last))); }, ${ms});
    const done = ${done.toString()};
    const tick = () => { ticks++; try { last = (${expression});
      if (done(last)) { clearTimeout(timer); resolve(last); return; }
    } catch (e) { clearTimeout(timer); reject(e); return; }
    raf = requestAnimationFrame(tick); }; tick();
  })`;
  return bounded(wc.executeJavaScript(script) as Promise<T>, ms + 1000, label);
}

async function run(): Promise<void> {
  if (FAULT && (!DRY_RUN || !['hidden', 'blank-after-first', 'frozen', 'no-pulls', 'frozen-composite'].includes(FAULT))) {
    finish('Test faults require --dry-run and a known fault name');
  }
  const webRoot = process.env.PT_DESKTOP_WEB_ROOT
    ? path.resolve(process.env.PT_DESKTOP_WEB_ROOT) : path.resolve(__dirname, '../../../../packages/web/build');
  if (!fs.existsSync(path.join(webRoot, 'fallback.html'))) finish(`No desktop web bundle at ${webRoot}; run task desktop:build:web`);
  const displayArg = process.argv.find((s) => s.startsWith('--display-id='));
  const requestedId = displayArg === undefined ? undefined : Number(displayArg.slice('--display-id='.length));
  if (requestedId !== undefined && (!Number.isSafeInteger(requestedId) || displayArg?.endsWith('='))) finish('Invalid --display-id');
  await app.whenReady();
  displays = screen.getAllDisplays().map(stripDisplay);
  primaryDisplayId = screen.getPrimaryDisplay().id;
  console.log('Displays:', JSON.stringify(displays));
  const target = pickTargetDisplay(displays, primaryDisplayId, requestedId);
  if ((!DRY_RUN || requestedId !== undefined) && !target) {
    setStep({ id: 'displays', status: 'FAIL', detail: HARDWARE_REFUSAL + ' No eligible extended target display.' });
    for (const id of STEP_ORDER.filter((id) => id !== 'displays')) setStep({ id, status: 'NOT-RUN', detail: 'no eligible target' });
    finish();
  }
  const primary = displays.find((d) => d.id === primaryDisplayId);
  if (!primary) fail('displays', 'No primary display');
  const primaryId = primary.id;
  const effectiveTarget = target ?? primary;
  setStep({ id: 'displays', status: target ? 'PASS' : 'DRY',
    detail: target ? `extended target #${target.id} (${target.label ?? ''}); operator will confirm physical output`
      : 'single display; wiring only' });
  const server = await startStaticServer(webRoot, 0);
  const origin = `http://127.0.0.1:${server.port}`;
  installSecurity(session.defaultSession, origin);
  const opener = new BrowserWindow({ ...popupBoundsOn(primary), backgroundColor: '#000000',
    webPreferences: { ...HARDENED_WEB_PREFERENCES, preload: path.join(__dirname, '..', 'preload.js'), backgroundThrottling: false } });
  installWindowGuards(opener.webContents, origin);
  await opener.loadURL(`${origin}/rack`);
  try {
    observations.rackPainted = await waitForRenderer(opener.webContents,
      `document.readyState === 'complete' && !!document.querySelector('.svelte-flow')`,
      (v: boolean) => v === true, 45_000, 'rack paint');
  } catch { observations.rackPainted = false; }

  const popupPromise = new Promise<BrowserWindow>((resolve) => opener.webContents.once('did-create-window', resolve));
  const targetBounds = popupBoundsOn(effectiveTarget);
  const opened = await opener.webContents.executeJavaScript(`(() => {
    window.__spikePopup = window.open('/present?slot=spike-opener-display', 'pt-spike-output', ${JSON.stringify(popupFeatures(targetBounds))});
    return window.__spikePopup !== null;
  })()`, true);
  if (!opened) fail('placement', 'window.open returned null');
  const popup = await bounded(popupPromise, 15_000, 'popup creation');
  const initialBounds = popup.getBounds();
  const initiallyOnTarget = isOnDisplay(initialBounds, effectiveTarget);
  observations.popupInitialBounds = initialBounds;
  observations.featureStringLandedOnTarget = initiallyOnTarget;
  if (!initiallyOnTarget) popup.setBounds(targetBounds);

  const reach = await waitForRenderer(opener.webContents,
    `(${installPattern.toString()})(${JSON.stringify({ fault: FAULT, pattern: PATTERN })}, ${counterColor.toString()})`,
    (v: { state: string }) => ['installed', 'popup-closed', 'dom-access-threw', 'no-2d-context'].includes(v.state),
    FRAME_DEADLINE_MS, 'opener DOM access') as { state: string; sameOrigin?: boolean };
  observations.reach = reach;
  if (reach.state !== 'installed' || !reach.sameOrigin) fail('domAccess', JSON.stringify(reach));
  setStep({ id: 'domAccess', status: 'PASS', detail: 'same-origin opener installed the real /present frame callback' });

  async function observe(label: string): Promise<FrameObservation> {
    return bounded(popup.webContents.executeJavaScript(
      `(${observeFrames.toString()})(${JSON.stringify({ fault: FAULT, timeoutMs: FRAME_DEADLINE_MS, pattern: PATTERN })})`),
    FRAME_DEADLINE_MS + 1000, label) as Promise<FrameObservation>;
  }
  function checkFrames(frames: FrameObservation): void {
    const counts = `samples=${frames.samples.length}, ticks=${frames.ticks}, elapsedMs=${Math.round(frames.elapsedMs)}`;
    if (frames.samples.length < 2 || !frames.samples.every(validSample)) fail('blitPixels', `invalid background/counter pixels; ${counts}`);
    setStep({ id: 'blitPixels', status: 'PASS', detail: `every background is magenta and every counter matches its count; ${counts}` });
    if (!motionAdvanced(frames.samples)) fail('motion', `pixels/counts did not advance together; ${counts}`);
    setStep({ id: 'motion', status: 'PASS', detail: `painted ${frames.samples[0]!.painted}→${frames.samples[frames.samples.length - 1]!.painted}; ${counts}` });
  }
  const frames = await observe('frame observation'); observations.frames = frames; checkFrames(frames);

  function checkPlacement(label: string): void {
    const current = screen.getAllDisplays().map(stripDisplay);
    const currentTarget = target ? pickTargetDisplay(current, screen.getPrimaryDisplay().id, target.id)
      : current.find((d) => d.id === primaryId);
    const bounds = popup.getBounds();
    observations[label] = { displays: current, bounds, nativeFullscreen: popup.isFullScreen(),
      matchedDisplay: displayContaining(current, bounds)?.id, visible: popup.isVisible(), minimized: popup.isMinimized() };
    if (!currentTarget || !isOnDisplay(bounds, currentTarget) || !popup.isVisible() || popup.isMinimized()) {
      fail('placement', `${label}: popup is not visibly contained on target #${effectiveTarget.id}`);
    }
    setStep({ id: 'placement', status: target ? 'PASS' : 'DRY', detail: `${label}: popup contained on #${effectiveTarget.id}; features-string landed=${initiallyOnTarget}` });
  }
  checkPlacement('placementAfterFrames');

  // capturePage measures the composited web page, not the physical monitor.
  // That distinction is why a successful real run also needs operator confirmation.
  async function capturePage(suffix: string) {
    const point = await popup.webContents.executeJavaScript(`(${canvasCapturePoint.toString()})(${JSON.stringify(PATTERN)})`) as ReturnType<typeof canvasCapturePoint>;
    const capture = await bounded(popup.webContents.capturePage(), FRAME_DEADLINE_MS, 'page capture');
    if (capture.isEmpty()) fail('composited', 'Page capture is empty');
    const size = capture.getSize();
    const read = (probe: { x: number; y: number }) => {
      const x = Math.floor(probe.x * size.width / point.viewport.width);
      const y = Math.floor(probe.y * size.height / point.viewport.height);
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) fail('composited', 'Canvas probe is outside the captured page');
      const pixel = capture.crop({ x, y, width: 1, height: 1 }).resize({ width: 1, height: 1 }).toBitmap();
      return [pixel[2] ?? -1, pixel[1] ?? -1, pixel[0] ?? -1, pixel[3] ?? -1];
    };
    const result = { background: read(point), counter: read(point.counter), size, point, png: resultStem + suffix + '.png' };
    observations['pageCapture' + suffix] = result;
    fs.mkdirSync(resultDir, { recursive: true });
    fs.writeFileSync(path.join(resultDir, result.png), capture.toPNG(), { flag: 'wx' });
    if (!approxColor(result.background, PATTERN.background)) fail('composited', `Page pixel [${result.background}] is not magenta despite readable canvas pixels`);
    return result;
  }
  const captureA = await capturePage('-a');
  const betweenCaptures = await observe('frames between page captures');
  observations.framesBetweenCaptures = betweenCaptures; checkFrames(betweenCaptures);
  const captureB = await capturePage('-b');
  if (!compositeAdvanced(captureA.counter, captureB.counter)) fail('composited', `Page counter did not advance: [${captureA.counter}]→[${captureB.counter}]`);
  setStep({ id: 'composited', status: 'PASS', detail: `both page captures match magenta and their encoded counters advance; PNGs saved` });
  checkPlacement('placementAfterCapture');

  if (DRY_RUN) {
    setStep({ id: 'operator', status: 'DRY', detail: 'physical display confirmation was not requested in dry-run mode' });
  } else {
    // Keep the live pattern available for inspection without a machine-test timer
    // racing the human. Cancel/close is never interpreted as confirmation.
    clearTimeout(watchdog);
    opener.show(); opener.focus();
    const answer = await dialog.showMessageBox(opener, { type: 'question', title: 'Verify physical display output',
      message: `Inspect target display #${target!.id} (${target!.label ?? 'external display'})`,
      detail: 'Confirm that this physical display shows a magenta background, a moving white marker, and an advancing frame number. A screenshot alone cannot prove what the monitor shows.',
      checkboxLabel: 'I am observing a second physical display with mirroring off', checkboxChecked: false,
      buttons: ['Confirm visible motion', 'Fail / cancel'], defaultId: 1, cancelId: 1 });
    armWatchdog();
    observations.operator = answer;
    if (answer.response !== 0 || !answer.checkboxChecked) fail('operator', 'Physical output was not confirmed');
    setStep({ id: 'operator', status: 'PASS', detail: 'owner confirmed visible motion on the target physical display with mirroring off' });
    // Recheck after the human pause: unplugging/moving/freezing during review
    // cannot leave a green result based only on the earlier samples.
    const afterReview = await observe('post-review frames'); observations.framesAfterReview = afterReview; checkFrames(afterReview);
    checkPlacement('placementAfterReview');
  }

  if (CRASH_PROBE) {
    const events: string[] = [];
    popup.webContents.on('render-process-gone', (_e, d) => events.push(`popup render-process-gone: ${d.reason}`));
    popup.on('closed', () => events.push('popup window closed'));
    opener.webContents.forcefullyCrashRenderer();
    // An observation period for this optional note, never renderer readiness.
    await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    crashProbe = { events, popupWindowDestroyed: popup.isDestroyed() };
    if (!popup.isDestroyed()) {
      try { crashProbe.popupPresentFrameTypeof = await bounded(popup.webContents.executeJavaScript('typeof window.__presentFrame'), 5_000, 'crash observation'); }
      catch (error) { crashProbe.popupReadError = String(error); }
    }
  }
  finish();
}
app.on('window-all-closed', () => { /* finish() owns the result and exit */ });
armWatchdog();
run().catch((error: unknown) => {
  if (finished) return;
  try { finish(error instanceof Error ? error.message : String(error)); } catch { /* exit requested */ }
});
