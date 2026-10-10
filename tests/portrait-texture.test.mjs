import test from 'node:test';
import assert from 'node:assert/strict';
import {defringeHairEdges} from '../web/portrait-texture.mjs';

test('soft hair pixels borrow opaque hair colour without losing alpha',()=>{
  const rgba=new Uint8ClampedArray([
    245,245,235,96, 32,22,18,255, 0,0,0,0,
    0,0,0,0,       0,0,0,0,       0,0,0,0,
  ]);
  defringeHairEdges(rgba,3,2,2);
  assert.deepEqual([...rgba.slice(0,4)],[32,22,18,96]);
  assert.deepEqual([...rgba.slice(4,8)],[32,22,18,255]);
  assert.deepEqual([...rgba.slice(8,12)],[0,0,0,0]);
});

test('defringing safely ignores malformed planes and edges without opaque hair',()=>{
  const short=new Uint8ClampedArray([1,2,3,4]);
  assert.equal(defringeHairEdges(short,2,2),short);
  const lone=new Uint8ClampedArray([250,250,250,120]);
  defringeHairEdges(lone,1,1,4);
  assert.deepEqual([...lone],[250,250,250,120]);
});
