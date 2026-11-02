import test from 'node:test';
import assert from 'node:assert/strict';
import {defringeHairEdges,portraitHairCutout,portraitSupportAt,neckOverlapAlpha} from '../web/portrait-texture.mjs';

test('neck overlap has no hard top edge and preserves the visible neck below the jaw',()=>{
  const chin=.6,height=.4,top=chin-height*.14;
  assert.equal(neckOverlapAlpha(top,chin,height),0);
  assert.ok(neckOverlapAlpha(top+.002,chin,height)>0&&neckOverlapAlpha(top+.002,chin,height)<.3);
  assert.equal(neckOverlapAlpha(chin,chin,height),1);
  assert.equal(neckOverlapAlpha(.8,chin,height),1);
});

test('room pixels next to the neck are removed while fine hair keeps its allowance',()=>{
  const width=20,height=20,data=new Uint8Array(width*height);
  for(let y=2;y<19;y++)for(let x=8;x<=11;x++)data[y*width+x]=y<9?1:2;
  const landmarks=Array.from({length:478},()=>({x:.5,y:.5}));landmarks[10].y=.15;landmarks[152].y=.5;
  const view={segmentation:{data,width,height},landmarks};
  assert.equal(portraitSupportAt(view,6.5/width,4.5/height),1);
  assert.equal(portraitSupportAt(view,6.5/width,14.5/height),0);
  assert.equal(portraitSupportAt(view,9.5/width,14.5/height),1);
  assert.ok(Math.abs(portraitSupportAt(view,8/width,14.5/height)-.5)<1e-6);
});

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
