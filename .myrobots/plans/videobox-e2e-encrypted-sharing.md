# VIDEOBOX — end-to-end-encrypted peer-to-peer video file sharing

User ask (2026-05-24 session):

> Whoever SPAWNED a VIDEOBOX in a rack (and ONLY them) sees an "Allow downloads"
> button on that VIDEOBOX. When they click it, every OTHER peer in the rack sees a
> "Download to local" button. A peer clicking it receives the video file over the
> wire, transferred such that the site operator can NEVER decrypt it (true E2E
> encryption).

This is a **security-critical** plan. The explicit, non-negotiable guarantee:
**WE — the site operator running the Hocuspocus relay + Cloudflare infra — must
NEVER be able to see the shared video contents.** Read this end-to-end before
writing code; the slice plan in §5 depends on the architecture in §2 and the
threat model in §3. **RESEARCH + PLAN ONLY — no implementation in this PR.**

---

## 0. Locked decisions (user, 2026-05-24 — SUPERSEDE the analysis below)

These override any contradicting detail in §1–§7. Where the body discusses a
WS-relay-of-ciphertext fallback, treat it as REJECTED per (1).

1. **P2P-ONLY transfer. No WS-relay fallback, no TURN, for the file bytes.**
   The operator's infra (Hocuspocus, Cloudflare) must NEVER carry the content —
   not plaintext, not ciphertext, not transiently. Only the *signaling* (SDP/ICE)
   and the *key-exchange public keys* may transit the relay. If WebRTC cannot
   establish a direct peer connection (symmetric NAT, ~10–15% of users), the
   transfer **fails gracefully** with "couldn't connect directly to peer" — it
   does NOT relay. Rationale: operator-liability posture — the strongest
   "I never host/transit content" position is that content provably never touches
   operator infrastructure in any form. (Removes the §2/§3 relay path entirely:
   PATH B is deleted; the operator never sees ciphertext, only public keys.)

2. **Downloading requires login.** Anonymous / invite-link participants can SEE
   the VIDEOBOX and the share state, but the "Download to local" action is
   auth-gated — show "Sign in to download" to anon users. Every completed
   download is attributable to a real account (accountability + abuse control).
   OPEN: must the *sharer* also be logged in to enable "Allow downloads"? (added
   to §4 questions — recommend yes for symmetry/accountability.)

3. **Operator liability posture** (see new §3a): because of (1)+(2) and the
   existing client-side-only file handling (VIDEOBOX loads from local disk, never
   uploads to operator storage), nothing content-related is ever attributable to
   operator infrastructure. Counsel review (DMCA agent, ToS prohibiting infringing
   use, takedown/abuse path) is recommended before launch but is out of code scope.

---

## 1. Executive summary

We already have, from DOOM multiplayer slice 2, a complete peer-to-peer transport:
`packages/web/src/lib/doom/doom-netcode.ts` opens **WebRTC data channels**
(SDP/ICE signaled over Yjs awareness through Hocuspocus) and **falls back to a
WS-relay** through Hocuspocus when WebRTC can't traverse the NAT. That transport
is the right starting point — but it carries a sharp security caveat for this
feature: **pure WebRTC data channels are DTLS-encrypted directly between the two
browsers, so even our STUN server never sees the payload — BUT the WS-relay
fallback routes every byte THROUGH Hocuspocus, where the operator CAN read it.**
Transport-layer encryption alone is therefore insufficient to honor the
guarantee.

The fix is **application-level end-to-end encryption**, layered ON TOP of
whichever transport we get: the two browsers perform an **X25519 ECDH** key
agreement (ephemeral keypairs, public keys exchanged over awareness), derive a
shared **AES-256-GCM** key via HKDF, and the sharer encrypts the file in chunks
before it ever touches a data channel or the relay. The operator relays only
ciphertext + public keys; it cannot derive the shared secret (ECDH's whole point)
and cannot decrypt the chunks. The single residual hole — an **active
man-in-the-middle** where a malicious operator swaps the relayed public keys — is
addressed by a **Short Authentication String (SAS)** that the two humans compare
out-of-band; see §3.

**One-line recommendation:** *Ephemeral-X25519-ECDH → HKDF → AES-256-GCM chunked
encryption of the file at the sender, transported over the existing WebRTC
data channel (WS-relay fallback carries only ciphertext), key exchange over Yjs
awareness with an optional human-compared SAS to defeat operator MITM. The
operator only ever touches ciphertext + public keys.*

---

## 2. Recommended architecture

### One-line summary

**App-level E2E crypto (X25519 ECDH + HKDF + AES-256-GCM, ephemeral per-transfer)
over a reused `doom-netcode`-style WebRTC data channel with WS-relay-of-ciphertext
fallback; permission gated on `node.data.creatorId`; key exchange + SAS over
awareness.**

### Data-flow diagram — where plaintext vs ciphertext lives

```
 ┌──────────────── SHARER  (spawned the VIDEOBOX; data.creatorId === me) ───────────────┐
 │                                                                                       │
 │  [PLAINTEXT]  the picked File / Blob (already in memory as the object-URL source)     │
 │       │                                                                               │
 │       │  1. user clicks "Allow downloads" → set data.downloadsAllowed = true          │
 │       │     (the FLAG is public — operator + all peers see it; that's fine)           │
 │       │                                                                               │
 │       │  2. a downloader requests → run ECDH:                                         │
 │       │       generateKey(X25519)  →  myPriv, myPub                                   │
 │       │       publish myPub over awareness   ───────────────►  [operator sees PUB]    │
 │       │       receive peerPub over awareness  ◄──────────────  [operator sees PUB]    │
 │       │       deriveBits(ECDH, myPriv, peerPub) → sharedSecret  [NEVER leaves browser] │
 │       │       HKDF(sharedSecret, salt, info)  → AES-256-GCM key [NEVER leaves browser] │
 │       │                                                                               │
 │       │  3. (optional, recommended) compute SAS = first 5 digits of                   │
 │       │     SHA-256(myPub‖peerPub); show to BOTH humans; they verbally confirm match  │
 │       │                                                                               │
 │       │  4. chunk the file (256 KB plaintext slices):                                 │
 │       │       for each chunk i:                                                       │
 │       │         iv_i      = 12-byte counter/random (unique per chunk)                 │
 │       │         cipher_i  = AES-GCM-encrypt(key, iv_i, plaintext_i)  [auth tag incl.] │
 │       ▼                                                                               │
 │  ┌─────────────────────── encryptedChunk envelope ───────────────────────┐           │
 │  │  { seq:i, iv:iv_i, total, ct: cipher_i }  ── ALL CIPHERTEXT ──         │           │
 │  └────────────────────────────────────────────────────────────────────────┘         │
 │       │                                                                               │
 │       ▼  send over transport (with backpressure on channel.bufferedAmount)            │
 └───────┼───────────────────────────────────────────────────────────────────────────┘
         │
         ▼  TRANSPORT (two possible paths)
   ┌─────────────────────────────────────────────────────────────────────────────────┐
   │  PATH A — WebRTC data channel (P2P, DTLS):                                         │
   │     bytes go browser→browser; operator's STUN server sees NOTHING (not even ct).   │
   │                                                                                    │
   │  PATH B — WS-relay fallback through Hocuspocus (when WebRTC fails):                │
   │     bytes ride awareness/relay field; operator SEES the ciphertext envelope —      │
   │     but it is AES-GCM ciphertext + the operator lacks the key → opaque. ACCEPTABLE.│
   └─────────────────────────────────────────────────────────────────────────────────┘
         │
 ┌───────┼─────────────── DOWNLOADER  (clicked "Download to local") ─────────────────────┐
 │       ▼                                                                               │
 │   receive encryptedChunk envelopes (ciphertext only)                                  │
 │       │  AES-GCM-decrypt(key, iv_i, ct_i) → plaintext_i  [auth tag verified;          │
 │       │                                       a tampered/wrong-key chunk THROWS]      │
 │       ▼                                                                               │
 │   reassemble chunks in seq order → Blob([...])  [PLAINTEXT, in downloader's browser]  │
 │       │                                                                               │
 │       ▼                                                                               │
 │   save to disk (download anchor)  OR  auto-load into the downloader's own VIDEOBOX    │
 │   (object-URL → <video>.src, same path as a local file pick)  — see Q4               │
 └───────────────────────────────────────────────────────────────────────────────────┘
```

**Proof the operator only ever touches ciphertext:** the only data that crosses
the operator's infrastructure (Hocuspocus awareness fields, the WS-relay, the
STUN server) are (1) the boolean `downloadsAllowed` flag, (2) X25519 **public**
keys, (3) AES-GCM **ciphertext** envelopes, and (4) signaling SDP/ICE + the SAS
nonces. The AES key and the ECDH shared secret are computed inside
`SubtleCrypto` and never serialized to any wire field. Decryption only happens
in the downloader's browser. There is no server-side code path that has both the
ciphertext and the key.

### Permission model — "only the spawner"

- **The flag:** `node.data.downloadsAllowed: boolean` (Yjs-CRDT, default false).
  When the sharer sets it, every peer reactively sees it (same path
  VideoboxCard already uses for `isPlaying` / `fileMeta`).
- **Who may set it:** the card shows the "Allow downloads" button only when
  `node.data.creatorId === localUserId`. We already stamp `creatorId` at spawn
  for PICTUREBOX + SAMSLOOP (`Canvas.svelte` `spawnFromPalette`, line ~2721); we
  extend that stamping to VIDEOBOX. The matching cap/attribution pattern lives in
  `lib/multiplayer/samsloop-limits.ts` (`countSamsloopsByCreator`).
- **The honest caveat (stated in the brief):** client-side gating of the button
  is NOT a hard security boundary — a hostile client could set the flag anyway.
  **The real boundary is that the SHARER's client only RUNS the encrypt+send
  loop when the sharer chose to share, and the key is only ever derived with the
  specific peer the sharer is transferring to.** A peer that fakes the flag still
  gets nothing, because no sharer client will encrypt+send to them. The flag is a
  UI affordance + intent signal, not an access-control gate.

### Why this combination?

| Decision | Choice | Why |
|---|---|---|
| Transport | Reuse the `doom-netcode` WebRTC + WS-relay layer | Already built, tested, NAT-proven. We don't reinvent signaling. Large-file streaming wants reliable-ordered channels (unlike DOOM's unreliable tics) — we open the data channel with `{ ordered: true }` (no `maxRetransmits`), so it's TCP-like. |
| Crypto layer | App-level AES-256-GCM over X25519-ECDH, INDEPENDENT of transport | The WS-relay path is operator-visible; only app-level E2E makes BOTH paths opaque. DTLS alone fails the guarantee. |
| Key agreement | X25519 ECDH via WebCrypto `deriveBits` + HKDF | Standard, fast, in every modern browser's `SubtleCrypto`. Ephemeral keypairs per transfer = forward secrecy (Q7). |
| Symmetric cipher | AES-256-GCM, per-chunk IV, 128-bit auth tag | AEAD: confidentiality + integrity in one. Per-chunk authentication means a tampered chunk fails `decrypt()` loudly rather than producing garbage. |
| Chunk size | 256 KB plaintext | Below typical data-channel `maxMessageSize` (~256 KB on Chrome SCTP; some browsers 64 KB — we probe `pc.sctp.maxMessageSize` and clamp). Keeps per-chunk memory bounded; enables progress + backpressure. |
| Reassembly | Collect decrypted chunks → `new Blob(parts, {type})` | Browser handles the multi-hundred-MB Blob in backing store, not a single contiguous ArrayBuffer; avoids OOM on large files (Q2). |
| Permission attribution | `node.data.creatorId` (existing pattern) | Already stamped + grandfathered for other modules; deterministic; no new identity infra. |
| MITM mitigation | SAS (human-compared short string), default ON, dismissible | Pragmatic: zero extra infra, defeats a key-swapping operator, matches WhatsApp/Signal "safety number" UX. TOFU as a lighter alternative (§3). |

### What we reuse from `doom-netcode.ts`

- The `RTCPeerConnection` creation + `iceServers` config (`DEFAULT_ICE_SERVERS`,
  STUN-only, no TURN — same committed decision).
- The awareness-as-signaling pattern (`signalFieldFor`, offer/answer/ICE
  envelopes with monotonic `seq` dedupe).
- The WS-relay fallback (`relayFieldFor`, base64 envelopes, per-peer seq dedupe)
  — but for file bytes, NOT DOOM packets.
- The arbiter-free peer mapping is NOT needed here (this is a directed 1:1 or
  1:N transfer, not a star lockstep); we generalize the per-peer
  `RTCPeerConnection` plumbing into a transport we can drive for arbitrary binary
  payloads. **Recommendation: extract a `rtc-transport.ts` shared module rather
  than coupling to DOOM** (see slice 1).

### What we add (new code, all in `packages/web/src/lib/video/share/` proposed)

- `videobox-crypto.ts` — pure WebCrypto helpers: `genEphemeralKeyPair`,
  `deriveSharedKey`, `encryptChunk`, `decryptChunk`, `computeSAS`. Pure +
  unit-testable with Node's `webcrypto`.
- `videobox-transfer.ts` — the send/receive state machine over the transport:
  chunking, backpressure, progress, reassembly, key-exchange handshake.
- `rtc-transport.ts` (extracted from doom-netcode) — transport-agnostic binary
  channel with WebRTC + WS-relay.
- VideoboxCard wiring: the two buttons, the SAS modal, the progress UI.

---

## 3. Threat model

### What the operator CAN see / do

- **The permission flag** `downloadsAllowed` (public boolean on the node). Fine.
- **`fileMeta`** (filename + duration) — already public today on `node.data`.
  Note: this LEAKS the filename + rough size to the operator even when downloads
  are off. (See Q8 — do we want to keep metadata public?)
- **Both peers' X25519 public keys** (relayed over awareness). Public keys are
  public by definition; knowing them does not let the operator derive the shared
  secret.
- **The ciphertext** of every chunk, IF the transfer falls back to the WS-relay
  path. The operator sees AES-GCM ciphertext + IVs but lacks the key → cannot
  decrypt. The operator also learns **transfer size + timing** (a metadata leak:
  how big the file is, when it was shared, between which two peers). Padding is
  out of scope for v1.
- **Signaling traffic** (SDP/ICE). Standard; reveals IPs/NAT topology to the
  operator (already true for DOOM MP).
- **Denial of service:** the operator could DROP relayed packets or refuse to
  relay signaling, breaking the transfer. The operator can always deny service —
  that is not a confidentiality break and is out of scope to prevent.

### What the operator CANNOT see / do (the guarantee)

- **Cannot read the plaintext video.** It never crosses the operator's
  infrastructure unencrypted. On the WebRTC path the operator sees nothing at
  all (DTLS P2P); on the relay path it sees only AES-GCM ciphertext.
- **Cannot derive the AES key** from the relayed public keys (the hardness of
  the X25519 discrete-log / computational Diffie-Hellman assumption).
- **Cannot silently decrypt past or future transfers** even if it later
  compromises a long-term identity — because the keys are **ephemeral per
  transfer** (forward secrecy, Q7). There is no long-term key to steal.

### The MITM caveat — stated plainly

**The one thing a *malicious* operator CAN do is an active man-in-the-middle on
the key exchange.** Because the operator relays the awareness messages carrying
the public keys, a hostile operator could, in principle:

1. Intercept the sharer's public key `A_pub`, substitute the operator's own
   `M_pub` toward the downloader.
2. Intercept the downloader's `B_pub`, substitute `M_pub'` toward the sharer.
3. Now the operator shares one AES key with the sharer and a different one with
   the downloader, decrypting + re-encrypting in the middle. **It would see the
   plaintext.**

This is the classic unauthenticated-DH MITM, and it is **inherent to any system
where the key-exchange channel is controlled by the same party you're trying to
hide from.** It cannot be fully eliminated without an authentication channel the
operator does not control. Our mitigations, in order of strength:

- **SAS (recommended default):** derive a short string (e.g. 5 decimal digits or
  4 words) from `SHA-256(sortedPubA ‖ sortedPubB)`, show it on BOTH cards, and
  ask the two humans to compare it over a channel the operator doesn't control
  (voice, in person, another chat). If a MITM swapped keys, the two SAS strings
  DIFFER and the humans notice. Same model as Signal "safety numbers" / WhatsApp
  "verify security code." Cheap, zero infra, defeats the attack **if users
  actually compare.** Residual risk: users skip the comparison.
- **TOFU (trust-on-first-use, lighter):** remember a peer's public-key
  fingerprint across transfers; warn loudly if it ever changes. Doesn't protect
  the FIRST transfer, but flags a later attack. Weaker than SAS but zero user
  friction after the first time.
- **None (v1-fastest, NOT recommended):** ship unauthenticated ECDH and document
  the residual MITM risk. Honest but weak; a malicious operator wins silently.

**Recommended v1 stance:** ship **SAS, ON by default, with a "skip verification"
escape hatch** for users who trust the operator (i.e. trust us). Document the
residual risk in the docs page. We are the operator, so for most users "trust
the operator" is the realistic threat model — but offering SAS means a
security-conscious user CAN get a real guarantee, and we can honestly say the
feature supports true E2E with out-of-band verification. **This is the single
biggest caveat the user must accept or mitigate** (see §9 decision log).

### Out of scope for v1 (named so we don't pretend otherwise)

- **Traffic-analysis resistance** (size/timing padding).
- **Anti-replay across separate transfers** (within a transfer, per-chunk IV +
  seq covers ordering/replay; the GCM key is single-use per transfer).
- **Malicious-peer content scanning** (a downloader could receive malware
  disguised as video; we are a pipe, not an AV — note in docs).
- **Protecting against a compromised endpoint** (if the downloader's browser is
  malware, E2E can't help; that's true of all E2E systems).

---

## 4. Open questions for the user

Numbered so we can reference them in PR threads.

1. **MITM trust model — SAS vs TOFU vs none for v1?** I recommend **SAS, on by
   default, skippable**. It's the only option that gives a security-conscious
   user a real guarantee against a hostile operator, costs zero infra, and is the
   familiar Signal/WhatsApp pattern. TOFU is lower-friction but doesn't protect
   the first transfer. "None" is honest-but-weak. Your call — and if SAS, do you
   want **5 digits**, **4 emoji**, or **a 4-word phrase** (bip39-style) as the
   compare string? (Words are easiest for humans to read aloud.)

2. **Max file size cap?** VIDEOBOX files can be many MB. A 2 GB file chunked at
   256 KB = ~8000 chunks; reassembled as a Blob the browser can handle it, but
   memory + transfer time get ugly, and the WS-relay fallback would hammer
   Hocuspocus. I recommend a **soft cap with a confirm dialog at ~500 MB and a
   hard cap at ~2 GB** (configurable). What limits do you want? Should the
   WS-relay path have a LOWER cap (e.g. refuse relay-of-ciphertext above 100 MB,
   to protect Hocuspocus) and require true WebRTC for big files?

3. **What identifies "the spawner" reliably across reconnects?** This is the
   thorniest. `creatorId` is stamped from `currentUserId` at spawn — but **anon
   users get a `sessionStorage`-backed `anon-<uuid>` that is LOST on page
   refresh / new tab / reconnect** (see `presence.ts getOrCreateAnonTabId`).
   So an anon spawner who refreshes BECOMES A DIFFERENT USER and loses the
   "Allow downloads" button on their own card. Options:
   - (a) **Accept it for anon** — only authed (Clerk) users get durable spawner
     identity; anon spawners lose control on refresh. Simple, honest.
   - (b) **Promote anon id to `localStorage`** so it survives refresh within the
     same browser (but still lost across browsers / incognito). Mild improvement.
   - (c) **Allow ANY peer to toggle downloads** (drop the spawner restriction) —
     contradicts the spec but sidesteps the identity problem.
   I recommend **(a) for v1**, with **(b)** as a cheap follow-up. Your call?

4. **Save-to-disk vs auto-load into the downloader's own VIDEOBOX?** When a peer
   finishes downloading, do we (a) trigger a browser "Save As" download, (b)
   auto-load the decrypted Blob into THAT peer's VIDEOBOX `<video>` element
   (object-URL, same path as a local file pick — so they immediately play it in
   sync), or (c) **both** (save + load)? I recommend **(c) both**, defaulting to
   load-into-card with a "save a copy" secondary button. Your call?

5. **Multiple simultaneous downloaders — broadcast or per-peer sessions?** If
   three peers all click "Download to local," do we (a) run **3 independent
   per-peer ECDH sessions** (3 keys, 3 encryptions of the same file — simple,
   each peer gets its own SAS, but 3× the sender CPU + bandwidth), or (b)
   **broadcast one ciphertext** encrypted under a single ephemeral content key,
   then wrap that content key separately for each downloader (1× encryption,
   N× tiny key-wraps — efficient, but more crypto complexity + a shared content
   key means losing per-pair forward secrecy granularity)? I recommend **(a) per-
   peer for v1** (simpler, cleaner security story, fine for a 4-peer-max rack);
   **(b)** is the optimization if N grows. Your call?

6. **What happens if the sharer leaves mid-transfer?** The transfer dies; the
   downloader has a partial, useless set of chunks. Options: (a) **abort + toast**
   "sharer left, download incomplete" and discard partial data (recommended;
   simplest, and resuming would need the same ephemeral key which is gone with
   the sharer); (b) **resume from another peer who already downloaded** (turns
   this into a mini-swarm — much more complex, deferred). I recommend **(a)**.
   Confirm?

7. **Forward secrecy — ephemeral keys per transfer?** I **strongly recommend
   YES**: generate a fresh X25519 keypair for every transfer session, discard
   after. This means a future key compromise can't decrypt past captured
   ciphertext, and there's no long-term key for a malicious operator to target.
   The only cost is one `generateKey` per transfer (microseconds). Any reason NOT
   to? (I can't think of one — confirming for the record.)

8. **`fileMeta` (filename + duration) is PUBLIC on the node today** — the
   operator + all peers see it even with downloads OFF. Is that acceptable, or do
   you want filename/duration hidden until/unless downloads are allowed? (E2E
   protects file CONTENTS; the filename is currently metadata-in-the-clear.) I
   recommend leaving it public (it's needed for the "peer loaded X" UI), but
   flagging it so you can decide.

9. **TURN server for symmetric-NAT P2P, or accept WS-relay-of-ciphertext?** When
   both peers are behind symmetric NAT (~10-15%), WebRTC P2P fails and we fall
   back to relaying CIPHERTEXT through Hocuspocus. That's still E2E-safe (operator
   sees only ciphertext), but it costs server bandwidth — a 500 MB video relayed
   through Hocuspocus is 500 MB of egress we pay for. Do we (a) **accept WS-relay-
   of-ciphertext** for the NAT-blocked minority (recommended for v1, consistent
   with the DOOM no-TURN decision), or (b) **stand up coturn** for true P2P? Note:
   even with a TURN server, a TURN relay we operate would see only DTLS-encrypted
   (and additionally AES-GCM-encrypted) bytes, so TURN doesn't weaken E2E — it's
   purely a cost/performance question. I recommend **(a)**, with a per-transfer
   relay size cap (Q2) to bound cost. Your call?

10. **Should "Allow downloads" be per-peer-targeted or all-or-nothing?** The spec
    says clicking it shows the button to "every OTHER peer." Is that always
    all-other-peers, or do you want the sharer to pick WHICH peers may download
    (e.g. a checklist)? I recommend **all-other-peers for v1** (matches the spec
    literally); per-peer ACLs are a follow-up. Confirm?

---

## 5. Slice breakdown

Each slice = one PR, ordered for incremental value. Slice 0 is a no-op refactor
that ships even if nothing else does; slice 1 is the first user-visible button;
slice 4 is "shipped" for v1.

| # | Title | LOC est | Days | Depends on | User-visible |
|---|---|---|---|---|---|
| 0 | Extract `rtc-transport.ts` from `doom-netcode.ts` (shared WebRTC + WS-relay binary channel); stamp `creatorId` on VIDEOBOX spawn | ~400 | 2 | — | No |
| 1 | Permission UI: "Allow downloads" (spawner-only) + "Download to local" (peers) buttons + `data.downloadsAllowed` flag; no transfer yet (button is inert / "coming soon") | ~250 | 2 | 0 | Yes — buttons appear |
| 2 | Crypto core (`videobox-crypto.ts`): X25519 ECDH + HKDF + AES-GCM chunk encrypt/decrypt + SAS; pure, fully unit-tested with Node webcrypto. No UI. | ~350 | 3 | — | No |
| 3 | Key-exchange handshake over awareness + SAS modal: clicking download negotiates keys, both cards show the SAS, humans confirm; still no bytes transferred | ~400 | 3 | 1, 2 | Yes — SAS verification flow |
| 4 | Chunked encrypted transfer + backpressure + progress UI + reassembly + save/load-into-card | ~500 | 4 | 3 | Yes — files actually move |
| 5 | Robustness + docs: sharer-leaves abort, file-size caps, multi-downloader (per-peer sessions), Playwright 2-context e2e, docs page | ~450 e2e + ~150 docs | 3 | 4 | Yes — shipping bar |

**Total**: ~2850 LOC net-new. **Wall time**: ~17 working days, sequential.

### Slice 0 — Extract shared transport + stamp creatorId

- Refactor the WebRTC-dial + WS-relay-fallback machinery out of
  `doom-netcode.ts` into `packages/web/src/lib/net/rtc-transport.ts`: a class
  that, given `{ provider, channelId, localUserId, peerUserId }`, gives you an
  `onBinary(cb)` + `send(bytes)` over WebRTC-or-relay, transport-agnostic. DOOM
  keeps working by consuming this (regression-tested by the existing DOOM unit
  suite + e2e — do NOT change DOOM behavior).
- Open the data channel **reliable-ordered** (`{ ordered: true }`, no
  `maxRetransmits`) — files need every byte, unlike DOOM tics.
- In `Canvas.svelte spawnFromPalette`, add `videobox` to the `creatorId`-stamping
  set (alongside PICTUREBOX + SAMSLOOP). Extend `VideoboxData` with
  `creatorId?: string` + `downloadsAllowed?: boolean` (defaults in
  `VIDEOBOX_DATA_DEFAULTS`).
- **Acceptance:** DOOM MP unit + e2e suites still green; spawning a VIDEOBOX
  stamps `data.creatorId` when authed; `rtc-transport.ts` has unit tests
  (stubbed `RTCPeerConnection` + mocked awareness, same harness style as
  `doom-netcode`) proving WebRTC send + relay fallback + binary round-trip.

### Slice 1 — Permission UI (inert)

- VideoboxCard: render an **"Allow downloads"** toggle button ONLY when
  `node.data.creatorId === localUserId`. Clicking writes
  `data.downloadsAllowed = !current` inside a `ydoc.transact`.
- When `downloadsAllowed === true` AND `creatorId !== localUserId`, render a
  **"Download to local"** button on every peer's card. (Inert in this slice — a
  toast "transfer coming soon" — so we ship the permission surface + test the
  creator gating independent of crypto.)
- **Acceptance:** 2-context Playwright — user A spawns VIDEOBOX (sees "Allow
  downloads", not "Download"); user B sees neither until A toggles, then B sees
  "Download to local" and A still only sees "Allow downloads". Toggling off
  removes B's button.

### Slice 2 — Crypto core (pure, no UI)

- `videobox-crypto.ts` exporting (all `async`, all `SubtleCrypto`):
  - `genEphemeralKeyPair()` → `CryptoKeyPair` (X25519).
  - `exportPublicKey(pub)` / `importPublicKey(raw)` → raw bytes ↔ `CryptoKey`.
  - `deriveSharedKey(myPriv, peerPub, salt, info)` → AES-256-GCM `CryptoKey`
    (ECDH `deriveBits` → HKDF-SHA-256 → `importKey('AES-GCM', 256)`).
  - `encryptChunk(key, seq, plaintext)` → `{ iv, ct }`.
  - `decryptChunk(key, iv, ct)` → plaintext (throws on auth failure).
  - `computeSAS(pubA, pubB)` → human string (digits/words per Q1).
- **Acceptance:** unit tests with Node `webcrypto`: two independent keypairs
  derive the SAME AES key; a wrong peer key derives a DIFFERENT key; encrypt→
  decrypt round-trips; a flipped ciphertext byte makes `decryptChunk` THROW
  (auth-tag check); SAS is symmetric (`computeSAS(A,B) === computeSAS(B,A)` after
  canonical sort) + differs for swapped keys (the MITM-detection property).

### Slice 3 — Key exchange + SAS modal

- Define awareness key-exchange envelopes (namespaced per node + transfer id,
  reusing the `doom-netcode` `signalFieldFor`/seq-dedupe pattern): downloader
  raises a `download-request` with its ephemeral `pub`; sharer responds with its
  `pub` + a fresh `transferId` + `salt`. Both derive the key + compute the SAS.
- SAS modal on BOTH cards: show the string, "Does this match the other person's
  screen?" → Confirm / Cancel. On mutual confirm, mark the session
  `verified`. (Per Q1, a "skip" path may exist.) No bytes yet.
- **Acceptance:** 2-context e2e — B clicks Download, both A and B see the SAME
  SAS string; confirming on both advances to a "ready to transfer" state; a unit
  test simulating a key-swap shows the two SAS strings DIFFER (proving humans
  would catch the MITM).

### Slice 4 — Chunked encrypted transfer

- `videobox-transfer.ts` send loop: read the File/Blob in 256 KB slices
  (`Blob.slice` + `arrayBuffer()` — never load the whole file into one buffer),
  encrypt each, send over `rtc-transport`, **respecting backpressure**: pause
  when `channel.bufferedAmount > HIGH_WATER` (e.g. 4 MB), resume on
  `bufferedamountlow`. Emit progress (bytes sent / total).
- Receive loop: collect `{seq, iv, ct}` envelopes, decrypt in order, push
  plaintext slices into an array; on the final chunk build
  `new Blob(parts, { type })`. Emit progress.
- On completion: per Q4, create object-URL → load into the downloader's
  VIDEOBOX `<video>` (reuse the `loadFile` path) and/or trigger a save.
- Progress UI on both cards (sender: "uploading 42%", receiver: "downloading
  42%").
- **Acceptance:** 2-context e2e transfers a small fixture video A→B; B's
  `<video>` plays it; assert B's decrypted Blob byte-length === original;
  assert the relay-path variant (force WebRTC off) ALSO succeeds and that the
  relayed awareness payloads are ciphertext (no plaintext magic bytes). Unit
  test: backpressure pauses when `bufferedAmount` high, resumes on low.

### Slice 5 — Robustness + docs

- Sharer-leaves-mid-transfer → downloader aborts + toast (Q6).
- File-size soft/hard caps + confirm dialog (Q2); optional lower cap on relay
  path (Q9).
- Multi-downloader: independent per-peer sessions (Q5a).
- Docs page `docs/src/content/modules/videobox-sharing.md`: how it works, the E2E
  guarantee, the SAS verification step, the honest MITM caveat, "we never see
  your video."
- **Acceptance:** e2e covers sharer-leave abort + a too-large-file rejection +
  two simultaneous downloaders each getting the file with their own SAS. Docs
  page renders.

---

## 6. Risks

### Crypto pitfalls

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| IV reuse under the same key (catastrophic for GCM — leaks plaintext XOR + forges) | Medium if hand-rolled | Critical | Per-transfer key is single-use; IV = 96-bit counter (seq-derived) OR random-per-chunk with a hard assertion that no IV repeats; unit test asserts uniqueness across all chunks. |
| Using ECDH shared bits DIRECTLY as the AES key (raw DH output isn't uniformly random) | Medium | High | ALWAYS run the shared secret through HKDF-SHA-256 before `importKey`. Encoded in `deriveSharedKey`; reviewed in slice 2. |
| Unauthenticated DH → operator MITM | Inherent | Critical (silent plaintext) | SAS (§3, Q1). The headline caveat. |
| Forgetting auth-tag verification (using AES-CTR or ignoring GCM tag) | Low | High | AES-GCM `decrypt` verifies the tag automatically + throws; we never use CTR; test asserts a tampered byte throws. |
| Non-constant-time SAS comparison or homemade crypto primitives | Low | Med | Use only `SubtleCrypto` primitives; SAS comparison is human-eyeball, not code; no custom crypto. |
| Weak randomness for keys/IVs | Low | Critical | `crypto.getRandomValues` / `generateKey` only; never `Math.random`. |

### File-size / memory

| Risk | Mitigation |
|---|---|
| Loading a 1 GB file into one ArrayBuffer → OOM tab crash | Stream via `Blob.slice(start,end).arrayBuffer()` per chunk; never materialize the whole plaintext at once on the SENDER. |
| Reassembling N chunks into one giant ArrayBuffer on the RECEIVER → OOM | Reassemble into a `Blob` (browser backs it on disk for large sizes), not a concatenated ArrayBuffer. |
| Data-channel `maxMessageSize` smaller than our chunk (Firefox/Safari quirks) | Probe `pc.sctp?.maxMessageSize`; clamp chunk size to `min(256 KB, maxMessageSize - overhead)`. |
| Slow transfer for huge files frustrates users | Show ETA + bytes/s; allow cancel; cap size (Q2). |

### NAT / transport

| Risk | Mitigation |
|---|---|
| Symmetric NAT → WebRTC fails → relay-of-ciphertext hammers Hocuspocus egress | Per-transfer relay size cap (Q9/Q2); show "slow path (relayed)" indicator; consider TURN later. |
| Data channel stalls / closes mid-transfer | Reliable-ordered channel + an app-level per-chunk ACK + resend window (or simply abort + retry the whole transfer for v1 — simpler; files aren't latency-critical like DOOM tics). |
| Awareness-as-signaling 30s GC drops a slow handshake | Keep the transfer-session alive with periodic awareness heartbeats; re-publish pub key if it ages out. |

### Abuse

| Risk | Mitigation |
|---|---|
| Sharing copyrighted / illegal content P2P-E2E (we literally cannot see it) | This is the flip side of the guarantee: true E2E means we cannot moderate content. **Surface this to the user (Q + legal/ToS).** Mitigations are policy, not technical: ToS prohibition, abuse-report flow keyed on the (public) sharer identity, rate limits. |
| Malware delivered as "video" | We're a pipe; document it; the receiver runs their own AV. The Blob is loaded as a `<video>` source, not executed. |
| A peer spamming download requests to DoS the sharer's CPU | Sharer-side rate-limit + the sharer must accept (the SAS/confirm step is a natural gate); ignore unrequested-by-UI download envelopes. |
| Relay-bandwidth DoS (huge file forced down the relay path) | Relay size cap (Q9). |

---

## 7. WebCrypto API specifics

All via `globalThis.crypto.subtle` (browser) / Node `import { webcrypto } from 'crypto'`
in tests. **X25519** support: Chrome 110+, Firefox, Safari 17+, Node 18+ — all
our targets. (If a target lacks X25519, fall back to ECDH on P-256 via the same
`deriveBits` shape — note in slice 2.)

### Key generation (ephemeral, per transfer — forward secrecy)

```ts
const kp = await crypto.subtle.generateKey(
  { name: 'X25519' },               // or { name:'ECDH', namedCurve:'P-256' } fallback
  true,                             // extractable: we export the PUBLIC key only
  ['deriveBits'],
) as CryptoKeyPair;
// publish the PUBLIC key over awareness:
const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
```

### Import peer public key + derive shared secret + HKDF → AES key

```ts
const peerPub = await crypto.subtle.importKey(
  'raw', rawPeerPub, { name: 'X25519' }, false, [],
);
// 1) ECDH → raw shared bits (DO NOT use directly as a key)
const sharedBits = await crypto.subtle.deriveBits(
  { name: 'X25519', public: peerPub }, kp.privateKey, 256,
);
// 2) HKDF-SHA-256 over the shared bits → a real AES key
const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
const aesKey = await crypto.subtle.deriveKey(
  { name: 'HKDF', hash: 'SHA-256', salt /* 16+ random bytes from sharer */,
    info: new TextEncoder().encode(`videobox-share|${transferId}`) },
  hkdfKey,
  { name: 'AES-GCM', length: 256 },
  false,                            // non-extractable: the key never leaves SubtleCrypto
  ['encrypt', 'decrypt'],
);
```

### Per-chunk encrypt / decrypt (AES-256-GCM, unique IV, 128-bit tag)

```ts
// IV = 12 bytes. Counter-based keeps uniqueness provable + saves shipping it
// (derive from seq) OR random-per-chunk + ship it. We ship it for clarity:
function ivForChunk(seq: number): Uint8Array {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, seq, false); // seq in last 4 bytes; rest 0
  return iv;                                        // unique while seq unique
}
const ct = new Uint8Array(await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv, tagLength: 128 }, aesKey, plaintextChunk,
));
// receiver:
const pt = new Uint8Array(await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv, tagLength: 128 }, aesKey, ct,   // THROWS if tampered / wrong key
));
```

### SAS (MITM-detection short string)

```ts
async function computeSAS(pubA: Uint8Array, pubB: Uint8Array): Promise<string> {
  // canonical order so both sides hash the same input regardless of role
  const [x, y] = compareBytes(pubA, pubB) <= 0 ? [pubA, pubB] : [pubB, pubA];
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(x, y)));
  // 5 decimal digits from the first 4 bytes (or map to a 4-word bip39 list per Q1)
  const n = new DataView(h.buffer).getUint32(0, false) % 100000;
  return n.toString().padStart(5, '0');
}
```

### Chunking the file (sender, streaming — never whole-file in RAM)

```ts
const CHUNK = 256 * 1024;
for (let seq = 0, off = 0; off < file.size; seq++, off += CHUNK) {
  const slice = file.slice(off, Math.min(off + CHUNK, file.size)); // Blob slice (lazy)
  const buf = new Uint8Array(await slice.arrayBuffer());           // only this chunk in RAM
  const { iv, ct } = await encryptChunk(aesKey, seq, buf);
  await transport.sendBackpressured({ seq, iv, ct, total: chunkCount });
}
```

### Reassembly (receiver, Blob-backed — never whole-file in one ArrayBuffer)

```ts
const parts: Uint8Array[] = new Array(total);
// ...on each decrypted chunk: parts[seq] = pt;
const blob = new Blob(parts, { type: fileMeta.mimeType ?? 'video/mp4' });
const url = URL.createObjectURL(blob);   // → <video>.src (Q4) and/or save anchor
```

---

## 8. Appendix A — relevant existing code

To save future-you a `grep`:

- **Transport candidate:** `packages/web/src/lib/doom/doom-netcode.ts` — WebRTC
  data channel (`dialPeer`, `wireChannel`, `DEFAULT_ICE_SERVERS` STUN-only) +
  WS-relay fallback (`relaySend`, `drainInboundRelay`, base64 envelopes) +
  awareness signaling (`signalFieldFor`, offer/answer/ICE + monotonic seq dedupe).
  **Slice 0 extracts the reusable transport from here.**
- **VIDEOBOX engine:** `packages/web/src/lib/video/modules/videobox.ts` — the
  factory holds NO file bytes; the CARD owns the `<video>` + object-URL.
- **VIDEOBOX card:** `packages/web/src/lib/ui/modules/VideoboxCard.svelte` —
  `loadFile()` (the path we reuse to auto-load a received Blob), `fileMeta` write,
  the `node.data` sync pattern (`isPlaying`/`lastSyncTime`). **The File/Blob the
  sharer must encrypt is the `File` passed to `loadFile`; today only its
  `objectUrl` is retained — slice 4 must also keep a reference to the `File`/`Blob`
  itself so we can `slice()` it for chunked encryption.**
- **Spawner identity:** `Canvas.svelte spawnFromPalette` (~line 2702) stamps
  `data.creatorId = currentUserId` for PICTUREBOX + SAMSLOOP; `creatorId` is
  read in `lib/multiplayer/samsloop-limits.ts` (`countSamsloopsByCreator`).
  **VIDEOBOX joins this set in slice 0.**
- **Anon identity fragility (Q3):** `lib/multiplayer/presence.ts`
  `getOrCreateAnonTabId()` — anon ids are `sessionStorage`-backed, so they DO NOT
  survive a refresh; an anon spawner loses their spawner identity on reload.
- **Awareness model:** `lib/multiplayer/presence.ts` (`AwarenessUserState`,
  `initAwareness`); `doom-netcode.ts` shows how to ride binary + JSON envelopes
  on per-module awareness fields with seq dedupe.

---

## 9. Decision log

- **2026-05-24** — plan v1 drafted. Recommended architecture: ephemeral-X25519-
  ECDH → HKDF → AES-256-GCM chunked encryption performed at the SENDER, over the
  existing `doom-netcode` WebRTC data channel with WS-relay-of-ciphertext
  fallback; permission gated on `node.data.creatorId`; key exchange + an
  optional human-compared SAS over Yjs awareness. The operator only ever touches
  ciphertext + public keys.
- **Headline caveat (requires user sign-off):** the key-exchange channel is
  relayed by the operator, so an *active malicious operator* could MITM the ECDH
  by swapping public keys. This is inherent to E2E over an operator-controlled
  signaling channel. Mitigation: **SAS (human-compared safety string), on by
  default, skippable.** Without SAS verification, the guarantee holds only
  against a *passive* operator, not an *active* one. **The user must decide:
  SAS-on-by-default (recommended) vs TOFU vs none.** (Open question #1.)
- **10 open questions** documented in §4 for user review.
