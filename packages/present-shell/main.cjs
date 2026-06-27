// packages/present-shell/main.cjs
//
// patchtogether.live PRESENT SHELL — an Electron kiosk wrapper for live
// multi-projector presentation. It loads the SAME hosted web app (no runtime
// bridge, no forked logic — see the no-native-helper-bridge ethos) in a normal
// operator window, then upgrades every "Present on …" popup the web app opens
// into a BORDERLESS, BORN-FULLSCREEN native window on the target display.
//
// Why this exists: in a normal browser tab the Fullscreen API flashes the
// "<site> is now full screen" overlay on every entry and needs a per-screen
// click, and N≥3 true-fullscreen displays can't be driven from one gesture
// (see the presentation-fullscreen-plan investigation). A window BORN fullscreen
// by the OS has none of those problems. So:
//   • operator window: normal, maximized — the patcher UI on the laptop.
//   • each present popup (window.open '/present' with a features rect from
//     computePopupFeatures): intercepted via setWindowOpenHandler and created as
//     a frameless, fullscreen BrowserWindow at that display's bounds → no
//     overlay, no click, one window per projector.
// The web app's present blit loop (opener → popup <canvas>) works unchanged
// because both windows are same-origin in the shell, exactly as in the browser.
//
// Usage:  PRESENT_URL=https://dev.patchtogether.live npm start
// (defaults to the dev deploy). Packaging / code-signing / auto-update are
// follow-ups — see README.

const { app, BrowserWindow } = require('electron');
const { boundsFromFeatures } = require('./parse-features.cjs');

const TARGET_URL = process.env.PRESENT_URL || 'https://dev.patchtogether.live';

/** Apply the borderless-fullscreen present-window options, placed at `bounds`
 *  (a display rect) when known, else fullscreen on the current display. */
function presentWindowOptions(bounds) {
  const base = {
    frame: false,
    fullscreen: true,
    backgroundColor: '#000000',
    webPreferences: { sandbox: true },
  };
  return bounds ? { ...base, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : base;
}

/** Wire a webContents so any window.open it makes (the web app's "Present on
 *  <display>" popups) becomes a borderless fullscreen window on the target
 *  display. Recurses to child windows so a present popup that itself opens one
 *  is handled too. */
function wirePresentWindows(contents) {
  contents.setWindowOpenHandler(({ features }) => ({
    action: 'allow',
    overrideBrowserWindowOptions: presentWindowOptions(boundsFromFeatures(features)),
  }));
  contents.on('did-create-window', (win) => wirePresentWindows(win.webContents));
}

app.whenReady().then(() => {
  // Operator window: normal chrome, maximized. The patcher lives here.
  const operator = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0a0406',
    webPreferences: { sandbox: true },
  });
  operator.maximize();
  wirePresentWindows(operator.webContents);
  operator.loadURL(TARGET_URL);

  app.on('window-all-closed', () => app.quit());
});

module.exports = { presentWindowOptions };
