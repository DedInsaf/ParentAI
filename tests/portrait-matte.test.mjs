import test from 'node:test';
import assert from 'node:assert/strict';
import {imageToNchw, resampleAlpha, cleanPortraitAlpha, largestCategoryComponent, openedCategoryComponent, silhouetteRows} from '../web/portrait-matte.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`);
function rectangle(alpha, width, left, top, right, bottom, value = 1) {
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) alpha[y * width + x] = value;
}

test('RGB tensor conversion uses independent planar channels and ignores RGBA transparency', () => {
  const result = imageToNchw(new Uint8ClampedArray([0, 127, 255, 0, 255, 64, 0, 255]), 2, 1);
  assert.ok(result instanceof Float32Array);
  assert.equal(result.length, 6);
  near(result[0], -1); near(result[1], 1);
  near(result[2], 127 / 127.5 - 1); near(result[3], 64 / 127.5 - 1);
  near(result[4], 1); near(result[5], -1);
});

test('non-square alpha resize samples pixel centers and keeps edge rows aligned', () => {
  const result = resampleAlpha(new Float32Array([0, 1, .5, 1, 0, .25]), 3, 2, 6, 4);
  assert.equal(result.length, 24);
  near(result[0], 0); near(result[1], .25); near(result[2], .75); near(result[5], .5);
  near(result[6], .25); near(result[7], .375); near(result[23], .25);
  const same = resampleAlpha([-1, 2, NaN, .4], 2, 2, 2, 2);
  assert.deepEqual(Array.from(same).slice(0, 3), [0, 1, 0]); near(same[3], .4);
});

test('matte cleanup removes detached predictions while retaining the soft hair fringe', () => {
  const width = 20, height = 16, alpha = new Float32Array(width * height);
  rectangle(alpha, width, 5, 3, 15, 14);
  alpha[2 * width + 7] = .22; alpha[1 * width + 7] = .04;
  alpha[4 * width + 4] = .37;
  alpha[1 * width + 1] = 1; alpha[1 * width + 2] = .3;
  const original = alpha.slice(), result = cleanPortraitAlpha(alpha, width, height);
  near(result[2 * width + 7], .22); near(result[1 * width + 7], .04); near(result[4 * width + 4], .37);
  assert.equal(result[1 * width + 1], 0); assert.equal(result[1 * width + 2], 0);
  assert.equal(result[8 * width + 10], 1);
  assert.deepEqual(alpha, original);
});

test('hair category cleanup keeps only the connected hairstyle',()=>{
  const width=9,height=7,data=new Uint8Array(width*height);
  rectangle(data,width,2,1,7,5,1);data[0]=1;data[6*width+8]=1;
  const result=largestCategoryComponent(data,width,height,1);
  assert.equal(result.reduce((sum,value)=>sum+value,0),20);
  assert.equal(result[0],0);assert.equal(result[6*width+8],0);assert.equal(result[2*width+4],1);
});

test('hair opening removes a thin connected flyaway and keeps the dense hairstyle',()=>{
  const width=15,height=12,data=new Uint8Array(width*height);
  rectangle(data,width,4,4,11,10,1);
  data[3*width+6]=1;data[2*width+6]=1;data[1*width+7]=1;data[1*width+8]=1;
  const result=openedCategoryComponent(data,width,height,1,1);
  assert.equal(result[1*width+8],0);assert.equal(result[2*width+6],0);assert.equal(result[6*width+7],1);
});

test('matte cleanup fills small interior holes while preserving large holes and open gaps', () => {
  const width = 24, height = 24, alpha = new Float32Array(width * height);
  rectangle(alpha, width, 2, 2, 22, 22);
  alpha[6 * width + 6] = 0; alpha[6 * width + 7] = .1;
  rectangle(alpha, width, 12, 8, 15, 11, 0); // nine-pixel enclosed space is deliberate
  rectangle(alpha, width, 17, 2, 18, 5, 0); // small but open to exterior
  const result = cleanPortraitAlpha(alpha, width, height);
  assert.equal(result[6 * width + 6], 1); assert.equal(result[6 * width + 7], 1);
  assert.equal(result[9 * width + 13], 0); assert.equal(result[3 * width + 17], 0);
});

test('a diagonal opening is still exterior and an empty or wholly soft matte is safe', () => {
  const width = 9, height = 9, alpha = new Float32Array(width * height).fill(1);
  for (let i = 0; i < 4; i++) alpha[i * width + i] = 0;
  const result = cleanPortraitAlpha(alpha, width, height);
  assert.equal(result[3 * width + 3], 0);
  assert.ok(cleanPortraitAlpha(new Float32Array(4), 2, 2).every(value => value === 0));
  assert.ok(cleanPortraitAlpha([.1, .2, .3, .4], 2, 2).every(value => value === 0));
});

test('silhouette rows track the central person and return normalized outer edges', () => {
  const width = 20, height = 10, alpha = new Float32Array(width * height);
  rectangle(alpha, width, 7, 1, 13, 4);
  rectangle(alpha, width, 4, 4, 16, 9);
  rectangle(alpha, width, 0, 1, 2, 9); // disconnected object at the image edge
  const rows = silhouetteRows(alpha, width, height, {startY: .15, endY: .55});
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {y: .15, left: .35, right: .65});
  assert.deepEqual(rows.at(-1), {y: .55, left: .2, right: .8});
  assert.deepEqual(silhouetteRows([1, 1, 1], 3, 1), [{y: .5, left: 0, right: 1}]);
});

test('matte helpers reject malformed dimensions, buffers and sampling options', () => {
  assert.throws(() => imageToNchw([], 0, 1), RangeError);
  assert.throws(() => imageToNchw([1], 1, 1), TypeError);
  assert.throws(() => resampleAlpha([1], 1, 1, 1.5, 2), RangeError);
  assert.throws(() => cleanPortraitAlpha([1], 2, 2), TypeError);
  assert.throws(() => silhouetteRows([1], 1, 1, {startY: .8, endY: .2}), RangeError);
  assert.throws(() => silhouetteRows([1], 1, 1, {threshold: 0}), RangeError);
});
