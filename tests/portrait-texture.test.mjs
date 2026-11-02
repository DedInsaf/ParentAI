import test from 'node:test';
import assert from 'node:assert/strict';
import {defringeHairEdges,portraitHairCutout} from '../web/portrait-texture.mjs';

test('hair texture preserves translucent strands instead of cutting them at fifty percent',()=>{
  const width=9,height=9,rgba=new Uint8ClampedArray(width*height*4).fill(100),alpha=new Float32Array(width*height).fill(.35);
  const data=new Uint8Array(width*height).fill(1),previous=globalThis.document;
  globalThis.document={createElement:()=>{const context={drawImage(){},getImageData(){return {data:(this.result||rgba).slice()};},putImageData(image){this.result=image.data;}};return {width,height,getContext:()=>context};}};
  try {
    const canvas=portraitHairCutout({canvas:{width,height},segmentation:{width,height,data},matte:{width,height,alpha}},.5);
    const result=canvas.getContext('2d').result;
    assert.ok(result[(4*width+4)*4+3]>80&&result[(4*width+4)*4+3]<100);
  } finally {globalThis.document=previous;}
});

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
