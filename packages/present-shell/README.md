# @patchtogether.live/present-shell

An **Electron kiosk shell** for live multi-projector presentation. It loads the
**hosted patchtogether.live web app** (no forked logic, no runtime bridge) in a
normal operator window, and turns every **"Present on …"** popup the web app
opens into a **borderless, born-fullscreen** native window on the target display.

## Why
In a normal browser tab the Fullscreen API:
- flashes the **"<site> is now full screen"** overlay on every entry (a browser
  security surface — *not* removable in a tab), and
- needs a **per-screen click**, and can't drive **3+** true-fullscreen displays
  from one gesture.

A window **born fullscreen by the OS** has none of those problems. So this shell
gives venues the clean experience the web build can't: no overlay, no per-screen
click, any number of projectors — while staying the exact same web app.

(See the `presentation-fullscreen-plan` investigation. The web build still ships
the web-native wins: recording no longer drops fullscreen, and "Present on all
displays" fans out popups in one click — this shell just removes the residual
overlay/chrome for serious multi-projector rigs.)

## How it works
- **Operator window** — a normal, maximized `BrowserWindow` loading the live URL.
  The patcher UI lives here (on the laptop).
- **Present windows** — the web app opens each via `window.open('/present', …)`
  with a features string carrying the target display's rect
  (`lib/ui/modules/present-window.ts → computePopupFeatures`). A
  `setWindowOpenHandler` parses that rect (`parse-features.cjs`) and creates a
  `frame:false, fullscreen:true` window at those bounds → one chrome-less,
  overlay-free window per projector. The web app's opener→popup canvas blit
  works unchanged (same-origin, just like the browser).

## Run
```sh
cd packages/present-shell
npm install                 # pulls Electron (NOT installed by the web CI)
PRESENT_URL=https://dev.patchtogether.live npm start
# defaults to the dev deploy if PRESENT_URL is unset
npm test                    # node --test (pure parse-features unit tests)
```

> **Not an npm workspace on purpose.** The repo root `workspaces` lists the web
> packages explicitly so this package's Electron devDependency is **never pulled
> into the web CI's `npm ci`** (Electron's binary is ~200 MB). Install it on its
> own as above.

## Follow-ups (not yet done)
- **Packaging + distribution**: add `electron-builder`, produce signed installers
  (macOS notarization via an Apple Developer cert; a Windows code-signing cert),
  and an **auto-update** feed (`electron-updater`). Pin the Electron version.
- **CI**: a dedicated build job (kept OFF the per-PR web pipeline).
- **Per-display output mapping UX**: today the operator picks outputs via the web
  app's "Present on …" menu; consider a shell-side display chooser.
- **Hardened webPreferences** review before public distribution.
