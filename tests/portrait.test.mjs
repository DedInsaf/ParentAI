import test from 'node:test';
import assert from 'node:assert/strict';
import {positionsFor} from '../web/core.mjs';
import {defaultPortraitAnchors,portraitAnchorIssue,portraitBodyGeometry,portraitHairGeometry,portraitEarGeometry} from '../web/portrait-geometry.mjs';
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
      for(let i=0;i<geometry.positions.length/3;i++) {
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
