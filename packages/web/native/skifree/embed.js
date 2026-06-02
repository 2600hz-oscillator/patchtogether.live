// packages/web/native/skifree/embed.js
//
// Embeddable wrapper around the upstream skifree.js engine (MIT, Daniel
// Hough 2013 — see ./license.md). This is the esbuild ENTRY POINT for our
// committed bundle at packages/web/static/skifree/skifree.bundle.js.
//
// Upstream's own entry (js/main.js) is a single-page app: it grabs a fixed
// `#skifree-canvas` via getElementById at module-eval, sizes the canvas to
// `window.innerWidth/Height`, and wires `mousemove`/`click`/keyboard/Hammer
// listeners directly. None of that suits a modular-synth card where the
// canvas is card-owned, the size is fixed, and the cursor is driven by CV.
//
// So instead of bundling js/main.js, we bundle THIS file, which re-uses the
// upstream's pure game classes (Camera / Skier / Monster / Snowboarder /
// Sprite / Game / InfoBox) verbatim and exposes a small controller API on
// `window.SkiFree`:
//
//   const ctl = window.SkiFree.create({ canvas, width, height,
//                                        spriteBase, onGate });
//   ctl.setCursor(x, y)   // drive the skier (canvas-px) — the CV path
//   ctl.enableMouse(el)   // attach native mousemove/click steering (focus path)
//   ctl.disableMouse()
//   ctl.getState()        // { distance, lives, crashes, lastEvent, gameOver }
//   ctl.reset()
//   ctl.dispose()
//
// `onGate(evt)` fires on a CROSS event ('crash' for tree/rock/etc.) and on
// 'eaten' (the yeti/abominable-snowman catching the skier). The audio
// factory (skifree.ts) pulses its `gate` ConstantSourceNode on each call.
//
// We touch ZERO upstream source files — the classes are imported as-is, so
// re-vendoring a newer skifree.js is a straight copy of the js/ tree + a
// rebuild (see ./README.md).

import Camera from './js/lib/camera.js';
import Monster from './js/lib/monster.js';
import Sprite from './js/lib/sprite.js';
import Snowboarder from './js/lib/snowboarder.js';
import Skier from './js/lib/skier.js';
import InfoBox from './js/lib/infoBox.js';
import Game from './js/lib/game.js';
import sprites from './js/spriteInfo.js';
import { PIXELS_PER_METRE, MONSTER_DISTANCE_THRESHOLD } from './js/lib/constants.js';

const DROP_RATES = { smallTree: 4, tallTree: 2, jump: 1, thickSnow: 1, rock: 1 };
const SPRITE_IMAGE_FILES = ['sprite-characters.png', 'skifree-objects.png'];

function createController(opts) {
  const {
    canvas,
    width = 320,
    height = 320,
    // Base URL (no trailing slash) the two sprite-sheet PNGs are served from.
    // The card passes '/skifree'; the sheets live at
    // static/skifree/{sprite-characters,skifree-objects}.png.
    spriteBase = '/skifree',
    // Fired on every cross/eaten event. evt = { type: 'crash'|'eaten',
    //   distance, lives }. Used by the audio factory to pulse the gate.
    onGate = () => {},
    // Optional: extra device-pixel-ratio for crisp backing store.
    dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
  } = opts || {};

  if (!canvas) throw new Error('SkiFree.create: a `canvas` is required');

  // Fixed card-owned sizing — NOT window.innerWidth. Logical (CSS) size is
  // width×height; backing store is scaled by dpr so the pixel art stays crisp.
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  // skier.js touches navigator.vibrate; guard non-browser (test) contexts.
  if (typeof navigator !== 'undefined' && !('vibrate' in navigator)) {
    try { navigator.vibrate = () => false; } catch (_e) { /* read-only in some envs */ }
  }

  const ctx2d = canvas.getContext('2d');
  const camera = Camera.create(ctx2d);
  ctx2d.scale(dpr, dpr);
  ctx2d.imageSmoothingEnabled = false;

  const state = {
    livesLeft: 5,
    distanceTravelled: 0,
    // Total cross/eaten events since spawn — handy for the e2e assertion.
    crashes: 0,
    eaten: 0,
    lastEvent: null, // 'crash' | 'eaten' | null
    gameOver: false,
  };

  let player;
  let startSign;
  let infoBox;
  let game;
  let disposed = false;
  // Set true for the duration of the monster-eat behaviour so the shared
  // hasHitObstacle callback can label the event 'eaten' vs 'crash'.
  let eatingInProgress = false;

  function emitGate(type) {
    state.lastEvent = type;
    if (type === 'crash') state.crashes += 1;
    else if (type === 'eaten') state.eaten += 1;
    try {
      onGate({ type, distance: state.distanceTravelled, lives: state.livesLeft });
    } catch (_e) { /* a buggy listener must never break the game loop */ }
  }

  function monsterHitsSkierBehaviour(monster, skier) {
    eatingInProgress = true;
    skier.isEatenBy(monster, () => {
      state.livesLeft -= 1;
      monster.isFull = true;
      monster.isEating = false;
      skier.isBeingEaten = false;
      monster.setSpeed(skier.getSpeed());
      monster.stopFollowing();
      const above = camera.getRandomMapPositionAboveViewport();
      monster.setMapPositionTarget(above[0], above[1]);
      eatingInProgress = false;
    });
  }

  function detectEnd() {
    if (!game.isPaused()) {
      state.gameOver = true;
      infoBox.setLines(['Game over!', 'Hit reset to restart']);
      game.pause();
      game.cycle();
      game.draw();
    }
  }

  function spawnMonster() {
    const m = new Monster(sprites.monster);
    const pos = camera.getRandomMapPositionAboveViewport();
    m.setMapPosition(pos[0], pos[1]);
    m.follow(player);
    m.setSpeed(player.getStandardSpeed());
    m.onHitting(player, monsterHitsSkierBehaviour);
    game.addMovingObject(m, 'monster');
  }

  function spawnBoarder() {
    const b = new Snowboarder(sprites.snowboarder);
    const above = camera.getRandomMapPositionAboveViewport();
    const below = camera.getRandomMapPositionBelowViewport();
    b.setMapPosition(above[0], above[1]);
    b.setMapPositionTarget(below[0], below[1]);
    b.onHitting(player, sprites.snowboarder.hitBehaviour.skier);
    game.addMovingObject(b);
  }

  function randomlySpawnNPC(spawnFn, dropRate) {
    const rateModifier = Math.max(800 - camera.logicalWidth(), 0);
    if (Math.floor(Math.random() * (1001 + rateModifier)) <= dropRate) spawnFn();
  }

  function spawnTerrain() {
    if (!player.isMoving) return [];
    return Sprite.createObjects([
      { sprite: sprites.smallTree, dropRate: DROP_RATES.smallTree },
      { sprite: sprites.tallTree, dropRate: DROP_RATES.tallTree },
      { sprite: sprites.jump, dropRate: DROP_RATES.jump },
      { sprite: sprites.thickSnow, dropRate: DROP_RATES.thickSnow },
      { sprite: sprites.rock, dropRate: DROP_RATES.rock },
    ], {
      rateModifier: Math.max(800 - camera.logicalWidth(), 0),
      position: () => camera.getRandomMapPositionBelowViewport(),
      player,
    });
  }

  function tickNPCs() {
    randomlySpawnNPC(spawnBoarder, 0.1);
    state.distanceTravelled = parseFloat(
      player.getPixelsTravelledDownMountain() / PIXELS_PER_METRE,
    ).toFixed(1);
    if (state.distanceTravelled > MONSTER_DISTANCE_THRESHOLD) {
      randomlySpawnNPC(spawnMonster, 0.001);
    }
  }

  function updateHUD() {
    infoBox.setLines([
      'SkiFree',
      `Travelled ${state.distanceTravelled}m`,
      `Skiers left: ${state.livesLeft}`,
    ]);
  }

  function buildGame() {
    player = new Skier(sprites.skier);
    player.setMapPosition(0, 0);
    player.setMapPositionTarget(0, -10);

    // THE GATE HOOK: hasHitObstacle() fires this for tree / rock / snowboarder
    // crashes AND (via isEatenBy → hasHitObstacle) for the yeti eat. We label
    // the event using the `eatingInProgress` flag set in the monster behaviour.
    player.setHitObstacleCb(() => {
      emitGate(eatingInProgress ? 'eaten' : 'crash');
    });

    game = new Game(camera, player);

    startSign = new Sprite(sprites.signStart);
    game.addStaticObject(startSign);
    startSign.setMapPosition(-50, 0);

    infoBox = new InfoBox({
      initialLines: ['SkiFree', 'Travelled 0m', `Skiers left: ${state.livesLeft}`],
      position: { top: 8, right: 8 },
    });

    game.beforeCycle(() => {
      game.addStaticObjects(spawnTerrain());
      if (!game.isPaused()) {
        tickNPCs();
        updateHUD();
      }
    });
    game.afterCycle(() => {
      if (state.livesLeft === 0) detectEnd();
    });
    game.addUIElement(infoBox);

    player.isMoving = false;
    player.setDirection(270);
    game.start();
  }

  // ── Image loading ──────────────────────────────────────────────────────
  // The card calls start() once the images resolve; until then the canvas
  // stays blank (transparent), matching every other game module's pre-load
  // idle look.
  function loadImagesThen(next) {
    let loaded = 0;
    SPRITE_IMAGE_FILES.forEach((file) => {
      const im = new Image();
      im.onload = () => {
        loaded += 1;
        if (loaded === SPRITE_IMAGE_FILES.length && !disposed) next();
      };
      im.onerror = () => {
        // Count it anyway so a missing sheet doesn't wedge boot; the game
        // just renders without that sheet's sprites.
        loaded += 1;
        if (loaded === SPRITE_IMAGE_FILES.length && !disposed) next();
      };
      // spriteInfo.js stores `$imageFile: 'sprite-characters.png'`; the
      // upstream keys getLoadedImage(...) by that bare filename, so we MUST
      // store under the bare name (not the URL).
      im.src = `${spriteBase}/${file}`;
      camera.storeLoadedImage(file, im);
    });
  }

  // ── Native mouse steering (focus path) ───────────────────────────────────
  // Engaged only when CV x/y are unpatched AND the card is focused (the card
  // calls enableMouse on focus, disableMouse on blur or when x/y get patched).
  let mouseTarget = null;
  const onMouseMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    setCursor(e.clientX - rect.left, e.clientY - rect.top);
  };
  const onClick = (e) => {
    const rect = canvas.getBoundingClientRect();
    setCursor(e.clientX - rect.left, e.clientY - rect.top);
  };
  function enableMouse(el) {
    disableMouse();
    mouseTarget = el || canvas;
    mouseTarget.addEventListener('mousemove', onMouseMove);
    mouseTarget.addEventListener('click', onClick);
  }
  function disableMouse() {
    if (!mouseTarget) return;
    mouseTarget.removeEventListener('mousemove', onMouseMove);
    mouseTarget.removeEventListener('click', onClick);
    mouseTarget = null;
  }

  // ── Cursor → skier steering (the shared CV + mouse path) ─────────────────
  // Coordinates are in canvas LOGICAL (CSS) pixels. The game converts the
  // cursor to a map position each cycle and steers the skier toward it. We
  // also un-stick the skier so a fresh cursor starts it moving.
  function setCursor(x, y) {
    if (!game || disposed) return;
    game.setMouseX(x);
    game.setMouseY(y);
    player.resetDirection();
    player.startMovingIfPossible();
  }

  function reset() {
    state.livesLeft = 5;
    state.distanceTravelled = 0;
    state.gameOver = false;
    state.lastEvent = null;
    eatingInProgress = false;
    if (!game) return;
    game.reset();
    game.addStaticObject(startSign);
  }

  function dispose() {
    disposed = true;
    disableMouse();
    try { if (game) game.pause(); } catch (_e) { /* */ }
  }

  // Boot.
  loadImagesThen(buildGame);

  return {
    setCursor,
    enableMouse,
    disableMouse,
    reset,
    dispose,
    getState() { return { ...state }; },
    // Test/diagnostic hooks — let a spec deterministically force a crash or
    // an eat without waiting for random terrain (the gate path is identical).
    _forceCrash() {
      if (!player) return;
      player.hasHitObstacle(new Sprite(sprites.rock));
    },
    _forceEaten() {
      if (!player) return;
      const m = new Monster(sprites.monster);
      monsterHitsSkierBehaviour(m, player);
    },
    get canvas() { return canvas; },
  };
}

const SkiFree = { create: createController };

// Expose on window for the <script>-tag load path used by the card, AND as
// the bundle's IIFE return is unused — the card reads window.SkiFree.
if (typeof window !== 'undefined') {
  window.SkiFree = SkiFree;
}

export default SkiFree;
