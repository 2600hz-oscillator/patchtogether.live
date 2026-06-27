// packages/present-shell/parse-features.test.cjs — run with `node --test`.
const test = require('node:test');
const assert = require('node:assert');
const { parseFeatures, boundsFromFeatures } = require('./parse-features.cjs');

test('parses a real web-app popup features string into bounds', () => {
  assert.deepStrictEqual(
    parseFeatures('popup,left=1920,top=0,width=1280,height=720'),
    { left: 1920, top: 0, width: 1280, height: 720 },
  );
});

test('empty / sizeless → zeros (caller falls back to fullscreen current display)', () => {
  assert.deepStrictEqual(parseFeatures(''), { left: 0, top: 0, width: 0, height: 0 });
  assert.deepStrictEqual(parseFeatures('popup'), { left: 0, top: 0, width: 0, height: 0 });
  assert.strictEqual(boundsFromFeatures('popup'), null);
});

test('preserves a negative left (display positioned left of the primary)', () => {
  assert.strictEqual(parseFeatures('left=-1920,top=0,width=1920,height=1080').left, -1920);
});

test('boundsFromFeatures maps left/top→x/y when a real size is present', () => {
  assert.deepStrictEqual(
    boundsFromFeatures('popup,left=2560,top=-100,width=1920,height=1080'),
    { x: 2560, y: -100, width: 1920, height: 1080 },
  );
});

test('ignores non-numeric / unknown keys', () => {
  assert.deepStrictEqual(
    parseFeatures('popup,left=abc,foo=5,width=800,height=600'),
    { left: 0, top: 0, width: 800, height: 600 },
  );
});
