// Loopback static server for the native shell.
//
// Serves the PT_DESKTOP_BUILD=1 web bundle (adapter-static output) over
// 127.0.0.1 with the same cross-origin-isolation headers production ships via
// packages/web/_headers: COOP same-origin + COEP credentialless (SharedArrayBuffer
// / Faust WASM threads need the isolation; credentialless, NOT require-corp, so
// no-CORP cross-origin media keeps loading — see _headers for the full why).
//
// SPA fallback: /rack (and every other ssr:false route) has no prerendered
// HTML — on Cloudflare Pages the worker renders it; here the adapter-static
// `fallback.html` shell boots the client router instead.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.rff': 'application/octet-stream',
  '.wad': 'application/octet-stream',
  '.data': 'application/octet-stream',
};

function contentType(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Host-header validation — the DNS-rebinding arm.
 *
 * The socket binds 127.0.0.1 only, so a remote host cannot reach it directly.
 * What it CAN do is point a domain it controls at 127.0.0.1 and have a browser
 * on this machine fetch `http://evil.example:9409/…` with `Host: evil.example`
 * — same-origin, from the attacker's origin, against our server. Requiring the
 * Host to name a loopback address closes that with one comparison.
 *
 * `localhost` is allowed alongside `127.0.0.1`: it is genuinely loopback, and
 * it is a DIFFERENT ORIGIN from the shell's — which the harness relies on to
 * negative-control the permission handlers with identical content served from
 * a non-shell origin, no network required.
 */
export function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  // A port in the header must be OUR port; an absent port means :80, which
  // this server never listens on.
  if (parsed.port !== String(port)) return false;
  const host = parsed.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/** Resolve a request path to a file inside webRoot, or null. Tries the exact
 * file, then `<p>.html`, then `<p>/index.html` (matching prerendered output). */
function resolveFile(webRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const base = path.resolve(webRoot);
  const candidates = [
    path.resolve(base, '.' + safe),
    path.resolve(base, '.' + safe + '.html'),
    path.resolve(base, '.' + safe, 'index.html'),
  ];
  for (const c of candidates) {
    // Containment check — no path may escape the web root.
    if (c !== base && !c.startsWith(base + path.sep)) continue;
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export interface StaticServer {
  port: number;
  close: () => Promise<void>;
}

export function startStaticServer(webRoot: string, port: number): Promise<StaticServer> {
  const fallback = path.join(webRoot, 'fallback.html');
  // The port actually bound — `port: 0` (the harness's ephemeral mode) means
  // the requested number is not the one the Host header will carry.
  let boundPort = port;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // Cross-origin isolation on EVERY response (documents need it; keeping it
    // uniform on subresources is harmless and matches the production edge).
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cache-Control', 'no-cache');

    if (!hostAllowed(req.headers.host, boundPort)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    let filePath = resolveFile(webRoot, url.pathname);

    // SvelteKit server-load data for non-prerendered routes. The root
    // +layout.server.ts (Clerk auth state) makes the client router fetch
    // `<route>/__data.json` on every SPA-fallback navigation; on Cloudflare
    // the worker answers, here nothing would → the router renders its 404
    // page instead of /rack. The prerendered root `__data.json` IS the exact
    // signed-out payload that load produces (nodes: [layout, null] — no
    // +page.server.ts anywhere outside prerendered pages), so serve it for
    // any data request that has no prerendered file. Auth routes (/r/[id],
    // /dashboard) are NOT desktop-shell surfaces; this shim is for the
    // client-rendered rack family only.
    if (!filePath && url.pathname.endsWith('/__data.json')) {
      const rootData = path.join(webRoot, '__data.json');
      if (fs.existsSync(rootData)) filePath = rootData;
    }

    // SPA fallback: no asset matched and the request looks like a navigation
    // (no file extension) → serve the client-router shell with 200.
    if (!filePath && !path.extname(url.pathname) && fs.existsSync(fallback)) {
      filePath = fallback;
    }

    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath)
      .on('error', () => {
        res.destroy();
      })
      .pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback ONLY — never expose the shell's server on the network.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
