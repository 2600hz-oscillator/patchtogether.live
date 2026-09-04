// patchtogether native shell — the shell's trust boundary, in one place.
//
// WHAT THIS IS NOT: a deny-by-default permission wall. Zero prompts on stage is
// the reason this app exists — ES-9, PTZ, four webcams and four displays must
// come up without a single dialog. Turning the grants off would be a product
// regression wearing a hardening costume.
//
// WHAT THIS IS: the ORIGIN LOCK that makes the grants safe. main.ts used to
// argue "scoping beyond the loopback origin is moot: the shell only ever loads
// 127.0.0.1" — a true-sounding premise that NOTHING enforced. Two holes made it
// false without any compromise at all:
//
//   * setWindowOpenHandler returned `{action:'allow'}` for EVERY url, and a
//     popup inherits the parent's webPreferences — so the rack's ordinary
//     `target="_blank"` links (joinpeertube.org, sepiasearch.org, famelack.com,
//     github.com) opened a REMOTE origin in a window carrying the ptNative
//     preload, sitting under session-wide camera/mic/USB/HID/serial/screen
//     grants. Reachable by clicking, no attacker required.
//   * there was no will-navigate guard at all, so the top-level document could
//     leave 127.0.0.1 and keep every one of those grants.
//
// So: pin the window to the shell origin, then grant everything TO THAT ORIGIN
// and to nothing else. Same device access, no reachable remote origin. Every
// predicate below is pure and exported so the harness can drive it directly
// (apps/desktop/e2e/security.spec.ts) — a grant handler is only worth what its
// REFUSALS are worth, and a refusal you cannot call is a refusal you cannot
// prove.

import { desktopCapturer, shell, type Session, type WebContents, type WebPreferences } from 'electron';

/** about:blank / about:srcdoc inherit the OPENER's origin — they are shell
 *  documents, not a foreign origin, and blocking them breaks ordinary DOM. */
const INTERNAL_URLS = new Set(['about:blank', 'about:srcdoc', '']);

/** The webPreferences the shell PINS. Electron 44 defaults all four to the
 *  safe value already — writing them down is the point: a later convenience
 *  edit ("just turn off webSecurity for this one asset") becomes a visible
 *  line in a diff instead of an invisible flip of an unstated default, and a
 *  pin bump that moves a default reddens the boot spec instead of the show. */
export const HARDENED_WEB_PREFERENCES: WebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
};

/**
 * The origin a URL really speaks for, or null if it has none we trust.
 *
 * `blob:http://127.0.0.1:9409/<uuid>` is a shell-origin URL — `new URL().origin`
 * reports "null" for it, so unwrap the inner URL first. Anything that is not
 * http/https (file:, data:, javascript:, custom schemes) has no origin we are
 * willing to treat as the shell, and returns null → denied everywhere below.
 */
export function effectiveOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const url = rawUrl.startsWith('blob:') ? rawUrl.slice('blob:'.length) : rawUrl;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isShellUrl(url: string | null | undefined, shellOrigin: string): boolean {
  return effectiveOrigin(url) === shellOrigin;
}

/**
 * Permission decision for BOTH session permission handlers.
 *
 * Grant only when every identity signal we were handed names the shell origin.
 * `undefined` signals are ignored (Electron omits `embeddingOrigin` unless a
 * cross-origin subframe asked, and omits `requestingUrl` for exactly those
 * subframes) — but a call with NO usable signal at all is denied, not waved
 * through: fail closed is the whole point of writing this down.
 *
 * Note it is deliberately NOT keyed on isMainFrame. A same-origin subframe of
 * the rack is the shell; restricting to the main frame would be a parity risk
 * for no security gain, because the dangerous case — a REMOTE document — is
 * already excluded by origin, and a popup is its own main frame anyway (which
 * is exactly the check the "restrict to the trusted main frame" prescription
 * would have sailed past).
 */
export function permissionAllowed(args: {
  shellOrigin: string;
  /** Frame URL (`details.requestingUrl`). */
  requestingUrl?: string | null;
  /** Origin string (`requestingOrigin` / `securityOrigin` / `details.origin`). */
  requestingOrigin?: string | null;
  /** Set only for cross-origin subframes. */
  embeddingOrigin?: string | null;
  /** Top-level document of the WebContents that asked. */
  topLevelUrl?: string | null;
}): boolean {
  const { shellOrigin } = args;
  const signals = [args.requestingUrl, args.requestingOrigin, args.embeddingOrigin, args.topLevelUrl]
    .filter((s): s is string => typeof s === 'string' && s.length > 0 && !INTERNAL_URLS.has(s));
  if (signals.length === 0) return false;
  return signals.every((s) => isShellUrl(s, shellOrigin));
}

export type WindowOpenDecision = 'allow' | 'external' | 'deny';

/**
 * window.open / target="_blank".
 *
 *   allow    — the shell origin (and about:blank, which inherits it). P4's
 *              output windows and the rack's own `/present` + `/docs/…` popups
 *              live here, WITH opener→popup DOM access intact: that access is
 *              what P4's blit design rests on (the captureStream fallback
 *              rendered BLACK on real dual-monitor hardware).
 *   external — any other http(s) url: hand it to the user's real browser via
 *              shell.openExternal. The PeerTube / archive.org / GitHub links
 *              keep working; they simply stop opening inside a privileged
 *              Electron window.
 *   deny     — everything else (file:, data:, javascript:, custom schemes).
 */
export function windowOpenDecision(url: string, shellOrigin: string): WindowOpenDecision {
  if (INTERNAL_URLS.has(url)) return 'allow';
  if (isShellUrl(url, shellOrigin)) return 'allow';
  try {
    const proto = new URL(url).protocol;
    if (proto === 'http:' || proto === 'https:') return 'external';
  } catch {
    /* unparseable */
  }
  return 'deny';
}

/** Navigation (top-level AND subframe) is confined to the shell origin. There
 *  are zero iframes in packages/web today (`git grep "<iframe"` is empty), so
 *  this costs nothing now; if an embed lands later, relax it HERE, for that
 *  origin, rather than by dropping the guard. */
export function navigationAllowed(url: string, shellOrigin: string): boolean {
  return INTERNAL_URLS.has(url) || isShellUrl(url, shellOrigin);
}

/** IPC gate: every `ipcMain.handle` callback runs this on its event first.
 *  A renderer that is not the shell origin gets no commands at all. */
export function ipcSenderAllowed(
  event: { senderFrame?: { url?: string } | null },
  shellOrigin: string,
): boolean {
  return isShellUrl(event.senderFrame?.url, shellOrigin);
}

/**
 * Install every session- and window-level guard. Call AFTER the loopback
 * server has a port — the whole policy is "=== shellOrigin", so it cannot be
 * installed before the origin exists.
 */
export function installSecurity(ses: Session, shellOrigin: string): void {
  const deny = (what: string, who: string | null | undefined): void => {
    console.error(`[shell:security] denied ${what} to non-shell origin: ${who ?? '(none)'}`);
  };

  // Both handlers, deliberately. setPermissionRequestHandler alone is the
  // classic gap: getUserMedia goes through the REQUEST handler, but
  // navigator.permissions.query and several silent re-checks go through the
  // CHECK handler, which defaults to "ask Chromium" and would answer for an
  // origin the request handler never saw.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ok = permissionAllowed({
      shellOrigin,
      requestingUrl: details?.requestingUrl,
      requestingOrigin: (details as { securityOrigin?: string } | undefined)?.securityOrigin,
      topLevelUrl: wc?.getURL(),
    });
    if (!ok) deny(`permission '${permission}'`, details?.requestingUrl ?? wc?.getURL());
    callback(ok);
  });

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const ok = permissionAllowed({
      shellOrigin,
      requestingUrl: details?.requestingUrl,
      requestingOrigin: requestingOrigin || details?.securityOrigin,
      embeddingOrigin: details?.embeddingOrigin,
      topLevelUrl: wc?.getURL(),
    });
    if (!ok) deny(`permission check '${permission}'`, requestingOrigin);
    return ok;
  });

  // WebUSB / Web Serial / WebHID: `details.origin` is the asking origin.
  ses.setDevicePermissionHandler((details) => {
    const ok = permissionAllowed({ shellOrigin, requestingOrigin: details.origin });
    if (!ok) deny(`device '${details.deviceType}'`, details.origin);
    return ok;
  });

  // Device CHOOSERS have no picker UI in Electron. Auto-pick for the shell —
  // that is the zero-prompt behaviour ES-9/PTZ depend on — and hand back an
  // empty selection to anyone else. `preventDefault()` still runs in both
  // arms: without it Electron falls back to its own (nonexistent) chooser and
  // the request hangs instead of failing.
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const frameUrl = details.frame?.url;
    if (!isShellUrl(frameUrl, shellOrigin)) {
      deny('usb chooser', frameUrl);
      callback(undefined);
      return;
    }
    callback(details.deviceList[0]?.deviceId);
  });
  ses.on('select-serial-port', (event, portList, wc, callback) => {
    event.preventDefault();
    const url = wc?.getURL();
    if (!isShellUrl(url, shellOrigin)) {
      deny('serial chooser', url);
      callback('');
      return;
    }
    callback(portList[0]?.portId ?? '');
  });
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const frameUrl = details.frame?.url;
    if (!isShellUrl(frameUrl, shellOrigin)) {
      deny('hid chooser', frameUrl);
      callback('');
      return;
    }
    callback(details.deviceList[0]?.deviceId ?? '');
  });

  // Without a display-media handler getDisplayMedia FAILS OUTRIGHT in Electron
  // — so the handler stays, picker-free, for the shell origin. P4's output
  // windows extend this same seam.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const frameUrl = request.frame?.url;
    const ok = permissionAllowed({
      shellOrigin,
      requestingUrl: frameUrl,
      requestingOrigin: request.securityOrigin,
    });
    if (!ok) {
      deny('display capture', request.securityOrigin || frameUrl);
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        const first = sources[0];
        callback(first ? { video: first } : {});
      })
      .catch(() => callback({}));
  });
}

/** Window-level guards: navigation confinement + the window.open allowlist. */
export function installWindowGuards(contents: WebContents, shellOrigin: string): void {
  const block = (event: { preventDefault: () => void }, url: string): void => {
    console.error(`[shell:security] blocked navigation off the shell origin: ${url}`);
    event.preventDefault();
  };

  contents.on('will-navigate', (event, url) => {
    if (!navigationAllowed(url, shellOrigin)) block(event, url);
  });
  // will-navigate covers the main frame only; this covers subframes too.
  contents.on('will-frame-navigate', (details) => {
    if (!navigationAllowed(details.url, shellOrigin)) block(details, details.url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    switch (windowOpenDecision(url, shellOrigin)) {
      case 'allow':
        // Same origin → a real popup, with opener DOM access (P4 needs it).
        // It inherits this window's webPreferences, which is now SAFE only
        // because the url is ours.
        return { action: 'allow' };
      case 'external':
        // The rack's outbound links open where they belong: the user's browser.
        void shell.openExternal(url);
        return { action: 'deny' };
      default:
        console.error(`[shell:security] refused window.open for an unsupported url: ${url}`);
        return { action: 'deny' };
    }
  });

  // A popup is its own WebContents: give it the same guards, or the allowlist
  // stops one hop short of where it matters.
  contents.on('did-create-window', (win) => {
    installWindowGuards(win.webContents, shellOrigin);
  });
}
