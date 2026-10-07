import test from 'node:test';
import assert from 'node:assert/strict';
import {positionsFor} from '../web/core.mjs';
import {defaultPortraitAnchors,portraitAnchorIssue,portraitBodyGeometry,portraitHairGeometry,portraitEarGeometry} from '../web/portrait-geometry.mjs';
import {fitPortraitAnchors} from '../web/portrait-fit.mjs';
import {OVAL} from '../web/head-geometry.mjs';

function fixture() {
  const lm=Array.from({length:478},()=>({x:.5,y:.3,z:0}));
  OVAL.forEach((id,i)=>{const angle=i/OVAL.length*Math.PI*2;lm[id]={x:.5+Math.sin(angle)*.10,y:.32-Math.cos(angle)*.14,z:.03};});
  lm[234]={x:.40,y:.3,z:.025};lm[454]={x:.60,y:.3,z:.025};
  return lm;
}
test('portrait uses a single photo scale and preserves adjusted neck/shoulder measurements',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm);
  a.neckLeft={x:.438,y:.51};a.neckRight={x:.571,y:.52};
  a.shoulderLeft={x:.19,y:.59};a.shoulderRight={x:.84,y:.57};
  a.chestLeft={x:.20,y:.83};a.chestRight={x:.83,y:.83};
  assert.equal(portraitAnchorIssue(a,lm),'');
  for(const aspect of [.75,1.5]) {
    const frame={nose:lm[1],aspect,scale:4.2},face=positionsFor(lm,1000,aspect*1000);
    const body=portraitBodyGeometry(lm,a,frame,face);
    for(const geometry of [body,portraitHairGeometry(lm,a,frame,face),portraitEarGeometry(lm,a,frame,face,-1),portraitEarGeometry(lm,a,frame,face,1)]) {
      assert.ok(geometry.positions.every(Number.isFinite));
      assert.equal(geometry.uv.length,geometry.positions.length/3*2);
      assert.ok(geometry.indices.every(i=>i>=0&&i<geometry.positions.length/3));
      // Photo UV and projected vertices must agree, regardless of camera aspect ratio.
      const projected=geometry===body?Array.from({length:geometry.positions.length/3},(_,i)=>i):geometry.groups?[...new Set(geometry.groups.filter(g=>g.materialIndex===0).flatMap(g=>geometry.indices.slice(g.start,g.start+g.count)))]:Array.from({length:geometry.positions.length/3},(_,i)=>i);
      for(const i of projected) {
        assert.ok(Math.abs(geometry.positions[i*3]-(geometry.uv[i*2]-lm[1].x)*4.2)<1e-9);
        assert.ok(Math.abs(geometry.positions[i*3+1]-(1-geometry.uv[i*2+1]-lm[1].y)*-aspect*4.2)<1e-9);
      }
    }
    const has=p=>body.uv.some((u,i)=>i%2===0&&Math.abs(u-p.x)<1e-9&&Math.abs(body.uv[i+1]-(1-p.y))<1e-9);
    for(const p of [a.neckLeft,a.neckRight,a.shoulderLeft,a.shoulderRight,a.chestLeft,a.chestRight])assert.ok(has(p));
    const zs=body.positions.filter((_,i)=>i%3===2);assert.ok(Math.max(...zs)-Math.min(...zs)>.1);
    const jawDepths=[150,149,176,148,152,377,400,378,379,365].map(id=>face[id*3+2]);
    assert.ok(Math.max(...zs)<Math.min(...jawDepths)); // neck is occluded by the jaw
    assert.ok(body.positions[1]>face[152*3+1]); // upper neck starts inside the jaw outline
  }
});
test('portrait rejects crossed contours and keeps automatic estimates explicitly editable',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),original=structuredClone(a);
  assert.equal(portraitAnchorIssue(a,lm),'');
  a.neckLeft.x=a.neckRight.x;assert.match(portraitAnchorIssue(a,lm),/пересек/);
  Object.assign(a,structuredClone(original));a.crown.y=lm[10].y;assert.match(portraitAnchorIssue(a,lm),/макушку/);
  Object.assign(a,structuredClone(original));a.earLeft.x=.5;assert.match(portraitAnchorIssue(a,lm),/краями лица/);
  Object.assign(a,structuredClone(original));a.chestRight.y=a.shoulderRight.y;assert.match(portraitAnchorIssue(a,lm),/ниже плеч/);
  Object.assign(a,structuredClone(original));a.shoulderLeft.x=NaN;assert.match(portraitAnchorIssue(a,lm),/внутри снимка/);
});

test('hair has rear volume and reserves the portrait texture for the front',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),frame={nose:lm[1],aspect:.75,scale:4.2},face=positionsFor(lm,1000,750);
  const hair=portraitHairGeometry(lm,a,frame,face),body=portraitBodyGeometry(lm,a,frame,face);
  const zs=hair.positions.filter((_,i)=>i%3===2),width=(lm[454].x-lm[234].x)*4.2;
  assert.ok(Math.max(...zs)-Math.min(...zs)>width*.6);
  assert.ok(hair.groups.some(g=>g.materialIndex===1));
  assert.equal(hair.groups.length,2);assert.equal(body.groups.length,3);
  assert.equal(portraitEarGeometry(lm,a,frame,face,-1).groups.length,2);
  assert.equal(hair.groups.reduce((sum,g)=>sum+g.count,0),hair.indices.length);
  assert.equal(body.groups.reduce((sum,g)=>sum+g.count,0),body.indices.length);
  assert.ok(body.groups.some(g=>g.materialIndex===1));assert.ok(body.groups.some(g=>g.materialIndex===2));
  // Front rows keep the forehead seam depth fixed when adding volume behind it.
  for(let j=0;j<17;j++){const id=OVAL[[28,29,30,31,32,33,34,35,0,1,2,3,4,5,6,7,8][j]];assert.equal(hair.positions[j*3+2],face[id*3+2]);}
});
test('measured skin and clothing preserve a broad neck despite an open V-neck shirt',()=>{
  const lm=fixture(),width=200,height=200,data=new Uint8Array(width*height);
  const paint=(x1,x2,y1,y2,value)=>{for(let y=Math.round(y1*height);y<Math.round(y2*height);y++)for(let x=Math.round(x1*width);x<Math.round(x2*width);x++)data[y*width+x]=value;};
  paint(.37,.63,.1,.3,1);paint(.40,.60,.3,.46,3);
  paint(.43,.57,.46,.51,2);paint(.47,.53,.51,.56,2); // exposed chest tapers
  paint(.23,.77,.56,.84,4);
  const a=fitPortraitAnchors(lm,{data,width,height});
  assert.equal(portraitAnchorIssue(a,lm),'');
  assert.ok(a.neckRight.x-a.neckLeft.x>.12);assert.ok(a.neckLeft.y<.515);
  assert.ok(a.shoulderLeft.x<.26);assert.ok(a.crown.y<.12);
});
test('unusable segmentation falls back to an editable valid contour',()=>{
  const lm=fixture(),a=fitPortraitAnchors(lm,{data:new Uint8Array(100),width:10,height:10});
  assert.deepEqual(a,defaultPortraitAnchors(lm));
});
