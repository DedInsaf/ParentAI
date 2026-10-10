import test from 'node:test';
import assert from 'node:assert/strict';
import {positionsFor} from '../web/core.mjs';
import {defaultPortraitAnchors,portraitAnchorIssue,portraitBodyGeometry,matteBodyGeometry,foreheadScalpGeometry,photoHairPatchGeometry,portraitHairGeometry,portraitEarGeometry} from '../web/portrait-geometry.mjs';
import {fitPortraitAnchors,fitStablePortraitAnchors,combineCategoryMasks} from '../web/portrait-fit.mjs';
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
test('portrait ears overlap the face edge instead of touching it at one point',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),frame={nose:lm[1],aspect:.75,scale:4.2},face=positionsFor(lm,1000,750);
  const left=portraitEarGeometry(lm,a,frame,face,-1),right=portraitEarGeometry(lm,a,frame,face,1);
  const leftXs=left.uv.filter((_,i)=>i%2===0),rightXs=right.uv.filter((_,i)=>i%2===0);
  assert.ok(Math.max(...leftXs)>lm[234].x);
  assert.ok(Math.min(...rightXs)<lm[454].x);
});
test('dense photo hair patch preserves frontal pixels and bends only in depth',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),frame={nose:lm[1],aspect:.75,scale:4.2},face=positionsFor(lm,1000,750);
  const hair=photoHairPatchGeometry(lm,a,frame,face);
  assert.equal(hair.columns,49);assert.equal(hair.rows,33);
  assert.equal(hair.positions.length,hair.columns*hair.rows*3);
  assert.equal(hair.uv.length,hair.columns*hair.rows*2);
  for(let i=0;i<hair.positions.length/3;i++){
    const px=hair.uv[i*2],py=1-hair.uv[i*2+1];
    assert.ok(Math.abs(hair.positions[i*3]-(px-frame.nose.x)*frame.scale)<1e-9);
    assert.ok(Math.abs(hair.positions[i*3+1]+(py-frame.nose.y)*frame.aspect*frame.scale)<1e-9);
  }
  const zs=hair.positions.filter((_,i)=>i%3===2);
  assert.ok(Math.max(...zs)-Math.min(...zs)>(lm[454].x-lm[234].x)*frame.scale*.08);
});

test('dense photo hair carrier follows the measured hairstyle instead of forming a side card',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),frame={nose:lm[1],aspect:.75,scale:4.2},face=positionsFor(lm,1000,750);
  const width=200,height=200,data=new Uint8Array(width*height),alpha=new Float32Array(width*height);
  // A hairstyle whose left edge recedes sharply below the crown used to leave
  // a tall rectangular sheet beside the ear even though its texture was clear.
  for(let y=10;y<72;y++){
    const left=y<38?62:82,right=y<38?140:126;
    for(let x=left;x<right;x++){data[y*width+x]=1;alpha[y*width+x]=1;}
  }
  const hair=photoHairPatchGeometry(lm,a,frame,face,49,33,{segmentation:{data,width,height},matte:{alpha,width,height}});
  const xs=row=>Array.from({length:hair.columns},(_,column)=>hair.uv[(row*hair.columns+column)*2]);
  const crown=xs(4),temple=xs(29);
  assert.ok(Math.min(...temple)>Math.min(...crown)+.03);
  assert.ok(Math.max(...temple)<Math.max(...crown)-.008);
  assert.equal(hair.indices.length,(hair.columns-1)*(hair.rows-1)*6);
});

test('forehead scalp closes the central gap and tapers away at both temples',()=>{
  const lm=fixture(),face=positionsFor(lm,1000,750),frame={nose:lm[1],aspect:.75,scale:4.2};
  const width=200,height=200,data=new Uint8Array(width*height);
  for(let y=5;y<Math.floor((lm[10].y-.02)*height);y++)for(let x=70;x<130;x++)data[y*width+x]=1;
  const scalp=foreheadScalpGeometry(lm,frame,face,{data,width,height}),rows=scalp.rows;
  assert.equal(scalp.columns,49);assert.equal(rows,5);
  const reach=column=>{const a=column*rows*3,b=(column*rows+rows-1)*3;return Math.hypot(scalp.positions[b]-scalp.positions[a],scalp.positions[b+1]-scalp.positions[a+1]);};
  assert.ok(reach(0)<1e-9);assert.ok(reach(scalp.columns-1)<1e-9);assert.ok(reach(Math.floor(scalp.columns/2))>0);
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

test('multi-pass portrait analysis closes isolated holes and keeps consensus edges',()=>{
  const w=7,h=7,base=new Uint8Array(w*h).fill(1),noisy=base.slice(),dark=base.slice();
  noisy[3*w+3]=0;dark[3*w+3]=0; // two bad passes must not beat three clean passes
  const result=combineCategoryMasks([base,base,base,noisy,dark],w,h);
  assert.equal(result[3*w+3],1);
  assert.ok(result.every(value=>value===1));
});

test('stable portrait fit tolerates a one-pixel segmentation shift',()=>{
  const lm=fixture(),width=200,height=200,data=new Uint8Array(width*height);
  const paint=(x1,x2,y1,y2,value)=>{for(let y=Math.round(y1*height);y<Math.round(y2*height);y++)for(let x=Math.round(x1*width);x<Math.round(x2*width);x++)data[y*width+x]=value;};
  paint(.37,.63,.1,.3,1);paint(.40,.60,.3,.46,3);paint(.43,.57,.46,.53,2);paint(.23,.77,.53,.84,4);
  const direct=fitPortraitAnchors(lm,{data,width,height}),stable=fitStablePortraitAnchors(lm,{data,width,height});
  assert.equal(portraitAnchorIssue(stable,lm),'');
  assert.ok(Math.abs(stable.neckLeft.x-direct.neckLeft.x)<=1/width);
  assert.ok(Math.abs(stable.shoulderRight.x-direct.shoulderRight.x)<=1/width);
});

function bodyMatte(width=200,height=200){
  const alpha=new Float32Array(width*height);
  for(let y=0;y<height;y++){
    const py=(y+.5)/height;if(py<.46||py>=.76)continue;
    const t=Math.max(0,Math.min(1,(py-.52)/.06)),left=.43-.20*t,right=.57+.20*t;
    for(let x=0;x<width;x++)if((x+.5)/width>=left&&(x+.5)/width<=right)alpha[y*width+x]=1;
  }
  // A disconnected false positive in the room cannot become a shoulder.
  for(let y=116;y<152;y++)for(let x=183;x<190;x++)alpha[y*width+x]=1;
  return {alpha,width,height};
}

test('matte body preserves photographed neck, shoulder height and original projection',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),matte=bodyMatte();
  a.neckLeft={x:.43,y:.51};a.neckRight={x:.57,y:.51};
  // Deliberately inaccurate width: the matte, not an average-body estimate,
  // must control the shoulders while these heights remain useful samples.
  a.shoulderLeft={x:.18,y:.60};a.shoulderRight={x:.82,y:.60};
  const face=positionsFor(lm,1000,750),frame={nose:lm[1],aspect:.75,scale:4.2};
  const body=matteBodyGeometry(lm,a,frame,face,matte);
  const span=y=>{
    const xs=[];
    for(let i=0;i<body.uv.length;i+=2)if(Math.abs(1-body.uv[i+1]-y)<1e-9)xs.push(body.uv[i]);
    assert.ok(xs.length>0);return [Math.min(...xs),Math.max(...xs)];
  };
  const pad=1.5/matte.width;
  for(const [actual,expected] of [[span(.51),[.43-pad,.57+pad]],[span(.60),[.23-pad,.77+pad]]]){
    assert.ok(actual.every((value,i)=>Math.abs(value-expected[i])<1e-9));
  }
  const ys=body.uv.filter((_,i)=>i%2===1).map(v=>1-v);
  assert.ok(Math.abs(Math.max(...ys)-.76)<1e-9);
  assert.ok(Math.abs(Math.min(...ys)-(lm[152].y-(lm[152].y-lm[10].y)*.14))<1e-9);
  for(let i=0;i<body.positions.length/3;i++){
    assert.ok(Math.abs(body.positions[i*3]-(body.uv[i*2]-frame.nose.x)*frame.scale)<1e-9);
    assert.ok(Math.abs(body.positions[i*3+1]+(1-body.uv[i*2+1]-frame.nose.y)*frame.aspect*frame.scale)<1e-9);
  }
  assert.ok(Math.max(...body.uv.filter((_,i)=>i%2===0))<.80);
});

test('visible neck follows the soft photographed matte without synthetic narrowing',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),matte=bodyMatte(),face=positionsFor(lm,1000,750),frame={nose:lm[1],aspect:.75,scale:4.2};
  const chin=lm[152],fh=chin.y-lm[10].y,row=Math.round(chin.y*matte.height);
  // Soft MODNet pixels belong to the collar even when their alpha is below .5.
  for(let y=row-2;y<row+50;y++)for(let x=82;x<=117;x++)matte.alpha[y*matte.width+x]=x<86||x>113?.28:1;
  const body=matteBodyGeometry(lm,a,frame,face,matte),spanAt=y=>{
    const xs=[];for(let i=0;i<body.uv.length;i+=2)if(Math.abs(1-body.uv[i+1]-y)<1e-9)xs.push(body.uv[i]);
    return [Math.min(...xs),Math.max(...xs)];
  };
  const chinSpan=spanAt(chin.y),middleSpan=spanAt(chin.y+fh*.08),collarY=(a.neckLeft.y+a.neckRight.y)/2,collarSpan=spanAt(collarY);
  const expectedLeft=82/matte.width-1.5/matte.width,expectedRight=118/matte.width+1.5/matte.width;
  for(const span of [chinSpan,middleSpan,collarSpan]){
    assert.ok(Math.abs(span[0]-expectedLeft)<1e-9);
    assert.ok(Math.abs(span[1]-expectedRight)<1e-9);
  }
  // The root hidden inside the face uses the same carrier width, so no shelf
  // or horizontal cut can appear under the animated jaw.
  const top=chin.y-fh*.14,topSpan=spanAt(top);
  assert.deepEqual(topSpan,chinSpan);
});

test('matte body has complete photo and closed sides/base with its top hidden by the head',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),face=positionsFor(lm,1000,750),frame={nose:lm[1],aspect:.75,scale:4.2};
  a.neckLeft.y=a.neckRight.y=.52;
  const body=matteBodyGeometry(lm,a,frame,face,bodyMatte());
  assert.ok(body.positions.every(Number.isFinite));
  assert.equal(body.uv.length,body.positions.length/3*2);
  assert.ok(body.indices.every(id=>id>=0&&id<body.positions.length/3));
  assert.deepEqual(body.groups.map(g=>g.materialIndex),[0,1,2]);
  assert.equal(body.groups.reduce((sum,g)=>sum+g.count,0),body.indices.length);
  const edges=new Map();
  for(let i=0;i<body.indices.length;i+=3)for(const [x,y] of [[0,1],[1,2],[2,0]]){
    const a=body.indices[i+x],b=body.indices[i+y],key=a<b?`${a}:${b}`:`${b}:${a}`;
    edges.set(key,(edges.get(key)||0)+1);
  }
  const boundary=[...edges.values()].filter(count=>count===1).length;
  assert.equal(boundary,48); // only the deliberately open top ring
  assert.ok([...edges.values()].every(count=>count===1||count===2));
  const zs=body.positions.filter((_,i)=>i%3===2),jaw=Math.min(...[150,149,176,148,152,377,400,378,379,365].map(id=>face[id*3+2]));
  assert.ok(Math.max(...zs)<jaw);
  assert.ok(Math.max(...zs)-Math.min(...zs)>(lm[454].x-lm[234].x)*frame.scale*.5);
});

test('matte body interpolates a missing contour row and rejects absent body data',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),face=positionsFor(lm,1000,750),frame={nose:lm[1],aspect:.75,scale:4.2},matte=bodyMatte();
  matte.alpha.fill(0,120*matte.width,121*matte.width);
  a.shoulderLeft.y=a.shoulderRight.y=.6025;
  const body=matteBodyGeometry(lm,a,frame,face,matte);
  const rowXs=[];for(let i=0;i<body.uv.length;i+=2)if(Math.abs(1-body.uv[i+1]-.6025)<1e-9)rowXs.push(body.uv[i]);
  const pad=1.5/matte.width;
  assert.ok(Math.abs(Math.min(...rowXs)-(.23-pad))<1e-9);assert.ok(Math.abs(Math.max(...rowXs)-(.77+pad))<1e-9);
  assert.throws(()=>matteBodyGeometry(lm,a,frame,face,{alpha:new Float32Array(10),width:10,height:10}),/контур/);
  assert.throws(()=>matteBodyGeometry(lm,a,frame,face,{alpha:new Float32Array(40000),width:200,height:200}),/выделить/);
});

test('matte hair uses a smooth cap, closes at the temples and keeps a recessed rear volume',()=>{
  const lm=fixture(),a=defaultPortraitAnchors(lm),width=400,height=400,alpha=new Float32Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const px=(x+.5)/width,py=(y+.5)/height,d=(px-.5)/.14,top=.09+.08*d*d+.035*Math.max(0,d);
    if(px>=.36&&px<=.64&&py>=top-.012&&py<top)alpha[y*width+x]=.08;
    if(px>=.36&&px<=.64&&py>=top&&py<=.46)alpha[y*width+x]=1;
    // An ear-sized extension must not become a lower-temple hair lock.
    if(px>.64&&px<.69&&py>.29&&py<.36)alpha[y*width+x]=1;
  }
  const matte={alpha,width,height},frame={nose:lm[1],aspect:.75,scale:4.2},face=positionsFor(lm,1000,750);
  const fitted=portraitHairGeometry(lm,a,frame,face,matte),estimated=portraitHairGeometry(lm,a,frame,face),outer=j=>({x:fitted.uv[(10*fitted.columns+j)*2],y:1-fitted.uv[(10*fitted.columns+j)*2+1]});
  assert.equal(fitted.columns,97);assert.equal(fitted.frontRows,11);assert.equal(fitted.photoRearRows,2);assert.equal(fitted.seam.length,97);
  assert.ok(outer(48).y<outer(24).y);assert.ok(outer(48).y<outer(72).y);
  assert.ok(Math.abs(outer(72).y-(1-estimated.uv[(10*17+12)*2+1]))>.01);
  let longestEdge=0;
  for(let j=0;j<fitted.columns;j++){
    const p=outer(j);assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
    const {leftId,rightId,amount}=fitted.seam[j];
    for(let axis=0;axis<3;axis++)assert.ok(Math.abs(fitted.positions[j*3+axis]-(face[leftId*3+axis]*(1-amount)+face[rightId*3+axis]*amount))<1e-9);
    if(j){const before=outer(j-1);longestEdge=Math.max(longestEdge,Math.hypot(p.x-before.x,p.y-before.y));}
  }
  assert.ok(longestEdge<(lm[454].x-lm[234].x)*.10);
  assert.ok(Math.abs(outer(0).x-lm[234].x)<.002);assert.ok(Math.abs(outer(96).x-lm[454].x)<.002);
  assert.ok(fitted.groups.some(g=>g.materialIndex===1));
  const photo=fitted.groups.find(g=>g.materialIndex===0),photoIds=new Set(fitted.indices.slice(photo.start,photo.start+photo.count));
  for(let row=11;row<=12;row++)for(let j=0;j<fitted.columns;j++){
    const id=row*fitted.columns+j;
    assert.ok(photoIds.has(id));
    assert.ok(Math.abs(fitted.positions[id*3]-(fitted.uv[id*2]-frame.nose.x)*frame.scale)<1e-9);
    assert.ok(Math.abs(fitted.positions[id*3+1]+(1-fitted.uv[id*2+1]-frame.nose.y)*frame.aspect*frame.scale)<1e-9);
  }
  const rear=fitted.groups.find(g=>g.materialIndex===1),rearIds=new Set(fitted.indices.slice(rear.start,rear.start+rear.count));
  for(const id of rearIds){
    const px=fitted.positions[id*3]/frame.scale+frame.nose.x,py=frame.nose.y-fitted.positions[id*3+1]/frame.aspect/frame.scale;
    const x=Math.max(0,Math.min(width-1,Math.floor(px*width))),y=Math.max(0,Math.min(height-1,Math.floor(py*height)));
    assert.ok(alpha[y*width+x]>=.5);
  }
  assert.ok(Math.max(...fitted.positions.filter((_,i)=>i%3===2))-Math.min(...fitted.positions.filter((_,i)=>i%3===2))>(lm[454].x-lm[234].x)*frame.scale*.6);
});
