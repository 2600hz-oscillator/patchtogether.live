// /dev/** is a browser-only playground: every page under it drives Canvas-class
// module UI that cannot run under Node at all (scripts/prove-ssr-identical.sh:
// "any Node-hosted SSR of a Canvas route is therefore a 500"). SSR here only
// ever "worked" by accident of bundling, and it is what put
// dev/video-patch-drop — and the whole chunks/peakstate.js graph behind it —
// into the PRODUCTION Cloudflare Worker as its largest single route (#2094).
//
// One layout flag covers every present AND future /dev route, the same shape
// /rack and /r/[id] already use — a per-page flag would be a new hatch to
// forget on the next playground.
export const ssr = false;
