// The P2→P4 opener→popup DOM-access + cross-display blit SPIKE.
//
// Run: `task desktop:spike` (owner's dual-monitor rig) — see
// apps/desktop/SPIKE-OPENER-DISPLAY.md for what each result means.
//
// WHAT THIS ANSWERS (plan.md §1.2 "main ↔ output windows", the HIGHEST-RISK
// display assumption): with the shell's real loopback server, real security
// policy (setWindowOpenHandler et al.), and the real /present sink page, does
// a same-origin popup OPENED BY THE MAIN WINDOW'S RENDERER onto a SECOND
// physical display (a) keep opener→popup DOM access, and (b) actually SHOW
// the opener-driven blit — non-black, correct color, advancing — when read
// back from the popup itself? The fallback (captureStream) rendered BLACK on
// exactly this hardware shape, which is why "worked on one display" (the
// 2026-09-03 hour-one probe) does not close the question.
//
// WHAT THIS IS NOT: a test, a gate, or P4. It is a one-command harness the
// owner runs once; it prints PASS/FAIL per step and writes a JSON record to
// apps/desktop/spike-results/. It deliberately reuses the SHELL'S OWN modules
// — server.ts, security.ts, HARDENED_WEB_PREFERENCES, the built preload — so
// the path exercised is the path P4 would ship, minus supervisors/menus/
// bridge, which have no bearing on windows or displays.
//
// HONEST DEGRADE: headless / single-display machines cannot answer the
// question. Real mode refuses loudly and exits non-zero; `--dry-run`
// exercises the full wiring on whatever display exists (verdict() then says
// so and unblocks nothing). The pure display/pixel logic is unit-tested
// separately (`npm run spike:unit`), so the harness is proven correct on the
// machines the spike itself refuses to run on.

import { app, BrowserWindow, screen, session, type WebContents } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startStaticServer } from '../server';
import { HARDENED_WEB_PREFERENCES, installSecurity, installWindowGuards } from '../security';
import {
  counterColor,
  displayContaining,
  HARDWARE_REFUSAL,
  PATTERN,
  approxColor,
  isNonBlack,
  pickTargetDisplay,
  pixelsDiffer,
  popupBoundsOn,
  popupFeatures,
  verdict,
  type DisplayLike,
  type Rect,
  type Rgba,
  type StepResult,
} from './opener-display-logic';

// Same Chromium flag set as main.ts (which applies them at module top level —
// importing it would boot the whole shell). MidiMacUmp is irrelevant to
// displays but kept so the spike's Chromium is configured EXACTLY like the
// shell it speaks for.
app.commandLine.appendSwitch('disable-features', 'MidiMacUmp');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const DRY_RUN = process.argv.includes('--dry-run') || process.env.PT_SPIKE_DRY_RUN === '1';
const CRASH_PROBE = process.argv.includes('--crash-probe') || process.env.PT_SPIKE_CRASH_PROBE === '1';
/** Whole-spike watchdog — a hung step must end in a written FAIL, not a hang. */
const SPIKE_DEADLINE_MS = 150_000;

// Own userData: never collide with a running shell's profile (the spike also
// binds port 0, so the fixed-port single-instance story is not in play).
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pt-spike-')));

function resolveWebRoot(): string {
  const fromEnv = process.env.PT_DESKTOP_WEB_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  // __dirname = apps/desktop/dist/spike → repo root is four up.
  return path.resolve(__dirname, '../../../../packages/web/build');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll a renderer with executeJavaScript until `done` or timeout. The code
 *  string must be an expression (or IIFE) returning a JSON-cloneable value. */
async function pollJs<T>(
  wc: WebContents,
  code: string,
  done: (v: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = (await wc.executeJavaScript(code)) as T;
    if (done(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`${label} — timed out after ${timeoutMs}ms; last: ${JSON.stringify(last)}`);
    }
    await sleep(250);
  }
}

interface PixelSample {
  counter: Rgba;
  background: Rgba;
  painted: number;
  w: number;
  h: number;
}

interface SpikeRecord {
  spike: 'opener-display';
  date: string;
  mode: 'real' | 'dry-run';
  electron: string;
  platform: string;
  displays: DisplayLike[];
  primaryDisplayId: number | null;
  steps: StepResult[];
  observations: Record<string, unknown>;
  crashProbe: Record<string, unknown> | null;
  verdictLines: string[];
  exitCode: number;
}

const steps: StepResult[] = [];
const observations: Record<string, unknown> = {};
let crashProbe: Record<string, unknown> | null = null;
let displays: DisplayLike[] = [];
let primaryDisplayId: number | null = null;

function stripDisplay(d: Electron.Display): DisplayLike {
  return { id: d.id, bounds: d.bounds, workArea: d.workArea };
}

function finish(exitCode: number, lines: string[]): never {
  const record: SpikeRecord = {
    spike: 'opener-display',
    date: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'real',
    electron: process.versions.electron ?? 'unknown',
    platform: `${process.platform} ${os.release()}`,
    displays,
    primaryDisplayId,
    steps,
    observations,
    crashProbe,
    verdictLines: lines,
    exitCode,
  };
  const outDir = path.resolve(__dirname, '../../spike-results');
  let outFile = '(unwritten)';
  try {
    fs.mkdirSync(outDir, { recursive: true });
    outFile = path.join(outDir, `opener-display-${record.date.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
  } catch (err) {
    console.error(`[spike] could not write the JSON record: ${String(err)}`);
  }
  console.log('');
  console.log('── opener→popup cross-display spike ──────────────────────────');
  for (const line of lines) console.log(line);
  console.log(`JSON record: ${outFile}`);
  console.log('──────────────────────────────────────────────────────────────');
  app.exit(exitCode);
  // app.exit does not return control to the caller's await chain synchronously.
  throw new Error('unreachable');
}

function fail(step: StepResult['id'], detail: string): never {
  steps.push({ id: step, status: 'FAIL', detail });
  const v = verdict(steps, { dryRun: DRY_RUN });
  finish(v.exitCode, v.lines);
}

async function run(): Promise<void> {
  const webRoot = resolveWebRoot();
  if (!fs.existsSync(path.join(webRoot, 'fallback.html'))) {
    console.error(
      `[spike] no desktop web bundle at ${webRoot} — run \`task desktop:build:web\` first (or set PT_DESKTOP_WEB_ROOT).`,
    );
    app.exit(2);
    return;
  }

  await app.whenReady();

  // ── STEP 1: two displays ─────────────────────────────────────────────────
  displays = screen.getAllDisplays().map(stripDisplay);
  primaryDisplayId = screen.getPrimaryDisplay().id;
  const boundsStr = displays
    .map((d) => `#${d.id}${d.id === primaryDisplayId ? ' (primary)' : ''} ${d.bounds.width}×${d.bounds.height}@${d.bounds.x},${d.bounds.y}`)
    .join(' · ');
  const target = pickTargetDisplay(displays, primaryDisplayId);

  if (!DRY_RUN && !target) {
    console.error(`\n${HARDWARE_REFUSAL}\n`);
    steps.push({ id: 'displays', status: 'FAIL', detail: `only ${displays.length} display(s): ${boundsStr}` });
    for (const id of ['placement', 'domAccess', 'blitPixels', 'motion'] as const) {
      steps.push({ id, status: 'NOT-RUN', detail: 'no second display' });
    }
    const v = verdict(steps, { dryRun: false });
    finish(v.exitCode, [HARDWARE_REFUSAL, ...v.lines]);
  }
  if (target) {
    steps.push({ id: 'displays', status: 'PASS', detail: `${displays.length} displays: ${boundsStr}` });
  } else {
    steps.push({ id: 'displays', status: 'DRY', detail: `single display (${boundsStr}) — wiring only` });
  }
  // Dry-run with one display: exercise the wiring on the primary.
  const primary = displays.find((d) => d.id === primaryDisplayId) ?? displays[0];
  if (!primary) {
    fail('displays', 'Electron reports ZERO displays — nowhere to open a window at all');
  }
  const effectiveTarget = target ?? primary;

  // ── The shell's own serving + security wiring ────────────────────────────
  const server = await startStaticServer(webRoot, 0); // ephemeral: never fight a live shell for 9409
  const shellOrigin = `http://127.0.0.1:${server.port}`;
  installSecurity(session.defaultSession, shellOrigin);

  const openerBounds = popupBoundsOn(primary);
  const opener = new BrowserWindow({
    ...openerBounds,
    backgroundColor: '#000000',
    webPreferences: {
      ...HARDENED_WEB_PREFERENCES,
      preload: path.join(__dirname, '..', 'preload.js'),
      backgroundThrottling: false,
    },
  });
  installWindowGuards(opener.webContents, shellOrigin);

  // Capture the popup BrowserWindow the moment window.open materializes it.
  const popupWindowPromise = new Promise<BrowserWindow>((resolve) => {
    opener.webContents.once('did-create-window', (win) => resolve(win));
  });

  await opener.loadURL(`${shellOrigin}/rack`);

  // The rack painting is context, not a spike step — record it, never gate on
  // it (the window.open path needs a live same-origin document, which loadURL
  // resolving already proves).
  try {
    const painted = await pollJs<boolean>(
      opener.webContents,
      `document.readyState === 'complete' && !!document.querySelector('.svelte-flow')`,
      (v) => v === true,
      45_000,
      'rack paint',
    );
    observations.rackPainted = painted;
  } catch {
    observations.rackPainted = false;
  }

  // ── STEP 2: popup opens on the SECOND display ────────────────────────────
  // The OPENER'S RENDERER calls window.open — the product path through
  // security.ts's setWindowOpenHandler — with the present-window features
  // shape carrying the target display's bounds. userGesture=true mirrors the
  // real click that opens a projector.
  const targetBounds = popupBoundsOn(effectiveTarget);
  const openCode = `
    (() => {
      window.__spikeReady = false;
      window.addEventListener('message', (ev) => {
        if (ev.data && ev.data.type === 'present:ready') window.__spikeReady = true;
      });
      const popup = window.open('/present?slot=spike-opener-display', 'pt-spike-output', '${popupFeatures(targetBounds)}');
      window.__spikePopup = popup;
      return { opened: popup !== null };
    })()
  `;
  const opened = (await opener.webContents.executeJavaScript(openCode, true)) as { opened: boolean };
  if (!opened.opened) {
    fail('placement', 'window.open returned null — setWindowOpenHandler denied the shell-origin popup (security regression, not a display result)');
  }

  const popupWin = await Promise.race([
    popupWindowPromise,
    sleep(15_000).then(() => null),
  ]);
  if (!popupWin) {
    fail('placement', 'no did-create-window within 15s of window.open — the popup never materialized as a BrowserWindow');
  }

  // Where did the features string alone put it? (P4 wants to know how much
  // the display map must do.)
  const initialBounds = popupWin.getBounds() as Rect;
  const initialDisplay = displayContaining(displays, initialBounds);
  const featureStringLanded = initialDisplay?.id === effectiveTarget.id;
  observations.popupInitialBounds = initialBounds;
  observations.featureStringLandedOnTarget = featureStringLanded;

  // MAIN owns final placement — exactly the split P4's display map ships
  // (renderer opens; main places). Correct only if needed, then verify.
  if (!featureStringLanded) {
    popupWin.setBounds(targetBounds);
  }
  let finalDisplay = displayContaining(displays, popupWin.getBounds() as Rect);
  const placeDeadline = Date.now() + 5_000;
  while (finalDisplay?.id !== effectiveTarget.id && Date.now() < placeDeadline) {
    await sleep(250);
    finalDisplay = displayContaining(displays, popupWin.getBounds() as Rect);
  }
  observations.popupFinalBounds = popupWin.getBounds();
  const placementDetail =
    `target display #${effectiveTarget.id}; features-string landed=${featureStringLanded}` +
    `${featureStringLanded ? '' : '; corrected from MAIN via setBounds'}; final display #${finalDisplay?.id ?? 'none'}`;
  if (!target) {
    steps.push({ id: 'placement', status: 'DRY', detail: `single display — ${placementDetail}` });
  } else if (finalDisplay?.id === effectiveTarget.id) {
    steps.push({ id: 'placement', status: 'PASS', detail: placementDetail });
  } else {
    steps.push({ id: 'placement', status: 'FAIL', detail: placementDetail });
    // Keep going: DOM access + blit answers are MORE valuable than placement,
    // and a placement failure alone does not moot them.
  }

  // ── STEP 3: opener→popup DOM access ──────────────────────────────────────
  // From the MAIN window's renderer: reach into the popup document, find the
  // real /present sink canvas, take its 2D context — THE assumption P4 rests
  // on — then install `popup.__presentFrame` as an opener-realm closure, the
  // same shape present-window.ts installs (#2235: the SINK owns the clock and
  // pulls; the closure and the pixels live in the OPENER's realm).
  // `counterColor` is injected from its compiled source so the draw and the
  // unit-tested readback contract cannot drift apart.
  const reachCode = `
    (() => {
      const popup = window.__spikePopup;
      if (!popup) return { state: 'no-popup-handle' };
      if (popup.closed) return { state: 'popup-closed' };
      let doc;
      try {
        doc = popup.document;
      } catch (err) {
        return { state: 'dom-access-threw', error: String(err) };
      }
      if (!doc) return { state: 'no-document' };
      const canvas = doc.querySelector('[data-testid="present-canvas"]');
      if (!canvas) return { state: 'waiting-for-canvas', readyState: doc.readyState };
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return { state: 'no-2d-context' };
      const counterColor = ${counterColor.toString()};
      let frame = 0;
      window.__spikePainted = 0;
      popup.__presentFrame = () => {
        frame++;
        window.__spikePainted = frame;
        const w = canvas.width, h = canvas.height;
        ctx.fillStyle = 'rgb(${PATTERN.background[0]},${PATTERN.background[1]},${PATTERN.background[2]})';
        ctx.fillRect(0, 0, w, h);
        const c = counterColor(frame);
        ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
        ctx.fillRect(0, 0, ${PATTERN.counterSize}, ${PATTERN.counterSize});
        return { protocol: 1, outcome: 'painted', painted: frame, errors: 0, slot: 'spike-opener-display' };
      };
      return {
        state: 'installed',
        sameOrigin: popup.location.origin === window.location.origin,
        canvasW: canvas.width,
        canvasH: canvas.height,
        readyMessageSeen: window.__spikeReady === true,
      };
    })()
  `;
  type Reach = {
    state: string;
    error?: string;
    sameOrigin?: boolean;
    canvasW?: number;
    canvasH?: number;
    readyMessageSeen?: boolean;
  };
  let reach: Reach;
  try {
    reach = await pollJs<Reach>(
      opener.webContents,
      reachCode,
      (v) => v.state === 'installed' || v.state === 'dom-access-threw' || v.state === 'popup-closed',
      20_000,
      'opener→popup DOM reach',
    );
  } catch (err) {
    fail('domAccess', String(err));
  }
  observations.reach = reach;
  if (reach.state !== 'installed') {
    fail(
      'domAccess',
      `opener could NOT use the popup DOM (${reach.state}${reach.error ? `: ${reach.error}` : ''}) — the P4 premise fails; re-plan before any window-manager code`,
    );
  }
  if (reach.sameOrigin !== true) {
    fail('domAccess', 'popup reachable but NOT same-origin with the opener — COOP/handler regression');
  }
  steps.push({
    id: 'domAccess',
    status: 'PASS',
    detail: `opener reached [data-testid=present-canvas] (${reach.canvasW}×${reach.canvasH}) + 2D ctx; __presentFrame installed opener-realm; present:ready seen=${reach.readyMessageSeen}`,
  });

  // ── STEPS 4+5: the blit renders on display 2 — non-black, and MOVING ─────
  // The sink's own rAF pulls the opener's closure; we wait for real pulls
  // (frames, not wall-clock guesses), then read pixels back IN THE POPUP'S
  // RENDERER with getImageData — the captureStream-went-black test, done for
  // the real path, on the display that matters.
  const paintedCode = `window.__spikePainted ?? 0`;
  try {
    await pollJs<number>(opener.webContents, paintedCode, (n) => n >= 5, 20_000, 'sink pulling the opener blit');
  } catch (err) {
    fail('blitPixels', `sink never pulled the opener frame function: ${String(err)}`);
  }

  const sampleCode = `
    (() => {
      const canvas = document.querySelector('[data-testid="present-canvas"]');
      if (!canvas) return { state: 'no-canvas' };
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return { state: 'no-context' };
      const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        state: 'ok',
        counter: px(${PATTERN.counterProbe.x}, ${PATTERN.counterProbe.y}),
        background: px(${PATTERN.backgroundProbe.x}, ${PATTERN.backgroundProbe.y}),
        w: canvas.width,
        h: canvas.height,
      };
    })()
  `;
  const takeSample = async (): Promise<PixelSample> => {
    const s = (await popupWin.webContents.executeJavaScript(sampleCode)) as
      | { state: 'ok'; counter: number[]; background: number[]; w: number; h: number }
      | { state: string };
    if (s.state !== 'ok') throw new Error(`popup-side readback failed: ${s.state}`);
    const ok = s as { counter: number[]; background: number[]; w: number; h: number };
    const painted = (await opener.webContents.executeJavaScript(paintedCode)) as number;
    return { counter: ok.counter, background: ok.background, painted, w: ok.w, h: ok.h };
  };

  let sampleA: PixelSample;
  try {
    sampleA = await takeSample();
  } catch (err) {
    fail('blitPixels', String(err));
  }
  observations.sampleA = sampleA;

  const bgOk = isNonBlack(sampleA.background) && approxColor(sampleA.background, PATTERN.background);
  const where = target ? `on display #${effectiveTarget.id}` : 'single-display (dry-run)';
  if (!bgOk) {
    fail(
      'blitPixels',
      `popup read back [${sampleA.background.join(',')}] where magenta was blitted ${where} — ` +
        (isNonBlack(sampleA.background)
          ? 'non-black but the WRONG color; the pipeline is altering pixels'
          : 'BLACK: the captureStream failure mode reproduced on the DOM path — P4 re-plans'),
    );
  }
  steps.push({
    id: 'blitPixels',
    status: 'PASS',
    detail: `background pixel [${sampleA.background.join(',')}] ≈ magenta ${where} (canvas ${sampleA.w}×${sampleA.h}, painted=${sampleA.painted})`,
  });

  // Motion: the counter square must CHANGE across ≥3 more sink pulls — a
  // frozen first frame (stale-single-frame) cannot pass this.
  try {
    await pollJs<number>(
      opener.webContents,
      paintedCode,
      (n) => n >= sampleA.painted + 3,
      15_000,
      'painted counter advancing',
    );
  } catch (err) {
    fail('motion', `blit painted one frame then stalled: ${String(err)}`);
  }
  let sampleB: PixelSample;
  try {
    sampleB = await takeSample();
  } catch (err) {
    fail('motion', String(err));
  }
  observations.sampleB = sampleB;
  if (!pixelsDiffer(sampleA.counter, sampleB.counter)) {
    fail(
      'motion',
      `counter pixel FROZE: [${sampleA.counter.join(',')}] → [${sampleB.counter.join(',')}] across painted ${sampleA.painted}→${sampleB.painted} — one stale frame, not a live blit`,
    );
  }
  steps.push({
    id: 'motion',
    status: 'PASS',
    detail: `counter pixel [${sampleA.counter.join(',')}] → [${sampleB.counter.join(',')}], painted ${sampleA.painted}→${sampleB.painted}`,
  });

  // ── OPTIONAL crash probe (interruption-matrix §2's free add-on) ──────────
  // Observation ONLY, never a step: what does render-process-gone in the
  // OPENER do to the popup under the shipped bare `{action:'allow'}` (no
  // outlivesOpener)? Recorded for row 1's pending decision. The 3s window is
  // an observation period for a recorded note, not a readiness wait — nothing
  // green/red hangs on it.
  if (CRASH_PROBE) {
    const events: string[] = [];
    popupWin.webContents.on('render-process-gone', (_e, d) => events.push(`popup render-process-gone: ${d.reason}`));
    popupWin.on('closed', () => events.push('popup window closed'));
    opener.webContents.forcefullyCrashRenderer();
    await sleep(3_000);
    let popupRealmAlive = false;
    let popupPainted: unknown = null;
    if (!popupWin.isDestroyed()) {
      try {
        popupPainted = await popupWin.webContents.executeJavaScript(
          `(() => { try { return typeof window.__presentFrame; } catch (e) { return 'threw: ' + e; } })()`,
        );
        popupRealmAlive = true;
      } catch (err) {
        popupPainted = `executeJavaScript failed: ${String(err)}`;
      }
    }
    crashProbe = {
      note: 'opener renderer forcefully crashed AFTER the five steps; shipped handler = bare allow, no outlivesOpener',
      events,
      popupWindowDestroyed: popupWin.isDestroyed(),
      popupRealmAlive,
      popupPresentFrameTypeof: popupPainted,
    };
  }

  const v = verdict(steps, { dryRun: DRY_RUN });
  finish(v.exitCode, v.lines);
}

// Never let a closed window race our explicit exit into a default quit.
app.on('window-all-closed', () => {
  /* the spike exits itself via finish() */
});

const watchdog = setTimeout(() => {
  console.error(`[spike] watchdog: still running after ${SPIKE_DEADLINE_MS}ms — failing loudly`);
  const v = verdict(steps, { dryRun: DRY_RUN });
  try {
    finish(1, [`WATCHDOG TIMEOUT after ${SPIKE_DEADLINE_MS}ms`, ...v.lines]);
  } catch {
    app.exit(1);
  }
}, SPIKE_DEADLINE_MS);
watchdog.unref();

run().catch((err: unknown) => {
  // finish() exits via a thrown 'unreachable' after app.exit — let that
  // through without double-reporting.
  if (err instanceof Error && err.message === 'unreachable') return;
  console.error(`[spike] harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  try {
    const v = verdict(steps, { dryRun: DRY_RUN });
    finish(1, [`HARNESS ERROR: ${String(err)}`, ...v.lines]);
  } catch {
    app.exit(1);
  }
});
