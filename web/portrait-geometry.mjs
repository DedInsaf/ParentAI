import {OVAL} from './head-geometry.mjs';

export const PORTRAIT_HANDLES={crown:'Макушка',templeLeft:'Волосы слева',templeRight:'Волосы справа',earLeft:'Ухо слева',earRight:'Ухо справа',neckLeft:'Шея слева у воротника',neckRight:'Шея справа у воротника',shoulderLeft:'Плечо слева',shoulderRight:'Плечо справа',chestLeft:'Низ туловища слева',chestRight:'Низ туловища справа'};
const clamp=x=>Math.max(.025,Math.min(.975,x));
export function defaultPortraitAnchors(lm) {
  const left=lm[234].x,right=lm[454].x,w=right-left,h=lm[152].y-lm[10].y,cx=lm[152].x;
  const point=(x,y)=>({x:clamp(x),y:clamp(y)});
  return {
    crown:point(lm[10].x,lm[10].y-h*.35),
    templeLeft:point(left-w*.11,lm[234].y-h*.19),templeRight:point(right+w*.11,lm[454].y-h*.19),
    earLeft:point(left-w*.08,lm[234].y),earRight:point(right+w*.08,lm[454].y),
    neckLeft:point(cx-w*.34,lm[152].y+h*.16),neckRight:point(cx+w*.34,lm[152].y+h*.16),
    shoulderLeft:point(cx-w*1.35,lm[152].y+h*.30),shoulderRight:point(cx+w*1.35,lm[152].y+h*.30),
    chestLeft:point(cx-w*1.38,lm[152].y+h*.95),chestRight:point(cx+w*1.38,lm[152].y+h*.95),
  };
}
export function portraitAnchorIssue(a,lm) {
  if(!a || Object.keys(PORTRAIT_HANDLES).some(k=>!a[k] || !Number.isFinite(a[k].x) || !Number.isFinite(a[k].y) || a[k].x<.01 || a[k].x>.99 || a[k].y<.01 || a[k].y>.99))return 'Все точки контура должны быть внутри снимка.';
  if(a.crown.y>=lm[10].y)return 'Переместите макушку выше лба.';
  for(const [left,right] of [['templeLeft','templeRight'],['earLeft','earRight'],['neckLeft','neckRight'],['shoulderLeft','shoulderRight'],['chestLeft','chestRight']]) {
    if(a[left].x>=a[right].x || a[right].x-a[left].x<.015)return 'Левая и правая границы не должны пересекаться.';
  }
  if(a.crown.x<=a.templeLeft.x || a.crown.x>=a.templeRight.x)return 'Макушка должна быть между краями волос.';
  if(a.earLeft.x>=lm[234].x || a.earRight.x<=lm[454].x)return 'Разместите точки ушей за краями лица.';
  if(a.neckLeft.y<=lm[152].y || a.neckRight.y<=lm[152].y)return 'Граница шеи у воротника должна быть ниже подбородка.';
  if(a.shoulderLeft.x>=a.neckLeft.x || a.shoulderRight.x<=a.neckRight.x)return 'Разместите точки плеч за пределами шеи.';
  if(a.shoulderLeft.y<a.neckLeft.y || a.shoulderRight.y<a.neckRight.y)return 'Точки плеч должны быть ниже края шеи.';
  if(a.chestLeft.y<=a.shoulderLeft.y || a.chestRight.y<=a.shoulderRight.y)return 'Нижний край туловища должен быть ниже плеч.';
  return '';
}

// One projection for every part. There is no independent head/neck/body scale.
export function portraitPoint(p,frame,z=0) {
  return [(p.x-frame.nose.x)*frame.scale,-(p.y-frame.nose.y)*frame.aspect*frame.scale,z];
}
function surface(positions,uv,indices,groups) {
  // One draw pass per material, not one draw call per tiny quad on a phone.
  const batches=new Map();
  for(const group of groups){
    if(!batches.has(group.materialIndex))batches.set(group.materialIndex,[]);
    batches.get(group.materialIndex).push(...indices.slice(group.start,group.start+group.count));
  }
  const ordered=[],packed=[];
  for(const [materialIndex,batch] of [...batches].sort((a,b)=>a[0]-b[0])){
    packed.push({start:ordered.length,count:batch.length,materialIndex});
    // Avoid spreading a whole model into function arguments on mobile Safari.
    for(const id of batch)ordered.push(id);
  }
  return {positions,uv,indices:ordered,groups:packed};
}
function ringSurface(sections,frame,frontZ,depth) {
  const positions=[],uv=[],indices=[],groups=[],segments=48;
  sections.forEach(([left,right],row)=>{
    for(let j=0;j<segments;j++) {
      const angle=j/segments*Math.PI*2,s=Math.cos(angle),t=(s+1)/2;
      const p={x:left.x*(1-t)+right.x*t,y:left.y*(1-t)+right.y*t};
      // Front is gently curved; the back is closed and deeper, never a photo plane.
      const z=frontZ-depth*.5+depth*.5*Math.sin(angle);
      positions.push(...portraitPoint(p,frame,z));uv.push(p.x,1-p.y);
      if(row){const b=(row-1)*segments+j,c=(row-1)*segments+(j+1)%segments,d=row*segments+j,e=row*segments+(j+1)%segments;
        const start=indices.length;indices.push(b,d,c,c,d,e);
        groups.push({start,count:6,materialIndex:j<segments/2?0:row<=16?1:2});
      }
    }
  });
  const [left,right]=sections.at(-1),center=positions.length/3,p={x:(left.x+right.x)/2,y:(left.y+right.y)/2};
  positions.push(...portraitPoint(p,frame,frontZ-depth*.5));uv.push(p.x,1-p.y);
  for(let j=0;j<segments;j++)indices.push((sections.length-1)*segments+j,(sections.length-1)*segments+(j+1)%segments,center);
  groups.push({start:indices.length-segments*3,count:segments*3,materialIndex:2});
  return surface(positions,uv,indices,groups);
}
const mix=(a,b,t)=>({x:a.x*(1-t)+b.x*t,y:a.y*(1-t)+b.y*t});
export function portraitBodyGeometry(lm,a,frame,face) {
  const sections=[],chin=lm[152],fw=lm[454].x-lm[234].x,fh=chin.y-lm[10].y;
  const center=(a.neckLeft.x+a.neckRight.x)/2,half=(a.neckRight.x-a.neckLeft.x)*.45;
  // Start underneath the wider part of the jaw, not at its pointed tip.
  // Otherwise the top ring appears as a rectangular tab beside the chin.
  const topLeft={x:center-half,y:chin.y-fh*.16},topRight={x:center+half,y:chin.y-fh*.16};
  const transitions=[[topLeft,topRight,a.neckLeft,a.neckRight,16],[a.neckLeft,a.neckRight,a.shoulderLeft,a.shoulderRight,10],[a.shoulderLeft,a.shoulderRight,a.chestLeft,a.chestRight,18]];
  for(const [part,[left,right,nextLeft,nextRight,rows]] of transitions.entries())for(let i=sections.length?1:0;i<=rows;i++) {
    const t=i/rows,e=t*t*(3-2*t);
    if(part===1){
      // Trapezius and shoulders: broad near the collar, rounding down at the arm.
      const tx=1-(1-t)**2,ty=t**3;
      sections.push([{x:left.x*(1-tx)+nextLeft.x*tx,y:left.y*(1-ty)+nextLeft.y*ty},{x:right.x*(1-tx)+nextRight.x*tx,y:right.y*(1-ty)+nextRight.y*ty}]);
    } else sections.push([mix(left,nextLeft,e),mix(right,nextRight,e)]);
  }
  const jawBack=Math.min(...[150,149,176,148,152,377,400,378,379,365].map(id=>face[id*3+2]));
  return ringSurface(sections,frame,jawBack-fw*frame.scale*.02,fw*frame.scale*.38);
}

export function portraitHairContour(a,t) {
  const side=t<.5?a.templeLeft:a.templeRight,angle=Math.abs(t-.5)*Math.PI;
  return {x:a.crown.x+(side.x-a.crown.x)*Math.sin(angle),y:a.crown.y+(side.y-a.crown.y)*(1-Math.cos(angle))};
}
export function portraitHairGeometry(lm,a,frame,face) {
  const contour=[28,29,30,31,32,33,34,35,0,1,2,3,4,5,6,7,8];
  const positions=[],uv=[],indices=[],groups=[],fw=(lm[454].x-lm[234].x)*frame.scale,columns=contour.length;
  const edgeZ=contour.reduce((sum,i)=>sum+face[OVAL[i]*3+2],0)/columns;
  const connect=(row,materialIndex)=>{
    const start=indices.length;
    for(let j=1;j<columns;j++){const b=(row-1)*columns+j-1,c=b+1,d=row*columns+j-1,e=d+1;indices.push(b,d,c,c,d,e);}
    groups.push({start,count:indices.length-start,materialIndex});
  };
  // Front texture is projected once onto a curved scalp, in the same photo scale.
  for(let row=0;row<=10;row++)for(let j=0;j<columns;j++) {
    const id=OVAL[contour[j]],t=j/(columns-1),outer=portraitHairContour(a,t),amount=row/10,p=mix(lm[id],outer,amount);
    const arch=Math.sin(t*Math.PI),outerZ=edgeZ-fw*.18*arch;
    const z=face[id*3+2]*(1-amount)+outerZ*amount+fw*.08*Math.sin(amount*Math.PI)*arch;
    positions.push(...portraitPoint(p,frame,z));uv.push(p.x,1-p.y);
    if(j===columns-1&&row)connect(row,0);
  }
  const centerY=(lm[10].y+lm[152].y)*.5;
  // A real rear volume, with small clumps following the head contour. The photo
  // does not wrap around the back or get stretched into an invented side view.
  for(let ring=1;ring<=12;ring++)for(let j=0;j<columns;j++) {
    const t=j/(columns-1),outer=portraitHairContour(a,t),u=ring/12,k=Math.cos(u*Math.PI/2);
    const p={x:a.crown.x+(outer.x-a.crown.x)*k,y:centerY+(outer.y-centerY)*k};
    const arch=Math.sin(t*Math.PI),rib=(.5+.5*Math.sin(j*3.7+u*4))*fw*.006*Math.sin(u*Math.PI);
    const z=edgeZ-fw*.18*arch-fw*.66*Math.sin(u*Math.PI/2)+rib;
    positions.push(...portraitPoint(p,frame,z));uv.push(t,u);
    if(j===columns-1)connect(10+ring,1);
  }
  return surface(positions,uv,indices,groups);
}

export function portraitEarGeometry(lm,a,frame,face,side) {
  const id=side<0?234:454,tip=side<0?a.earLeft:a.earRight;
  const root=lm[id],cx=(root.x+tip.x)/2,cy=tip.y,rx=Math.abs(tip.x-root.x)/2,ry=(lm[152].y-lm[10].y)*.135;
  const positions=[],uv=[],indices=[],groups=[],segments=32,fw=(lm[454].x-lm[234].x)*frame.scale;
  const rimZ=face[id*3+2]-rx*frame.scale*.2;
  for(let row=0;row<=12;row++)for(let j=0;j<segments;j++) {
    const angle=j/segments*Math.PI*2,r=row<=6?row/6:1-(row-6)/6;
    const p={x:cx+rx*r*Math.cos(angle),y:cy+ry*r*Math.sin(angle)};
    const z=row<=6?rimZ+fw*.018*Math.sin(Math.PI*r):rimZ-fw*.045*Math.sin((1-r)*Math.PI/2);
    positions.push(...portraitPoint(p,frame,z));uv.push(p.x,1-p.y);
    if(row){const b=(row-1)*segments+j,c=(row-1)*segments+(j+1)%segments,d=row*segments+j,e=row*segments+(j+1)%segments;
      const start=indices.length;indices.push(b,d,c,c,d,e);groups.push({start,count:6,materialIndex:row<=6?0:1});}
  }
  return surface(positions,uv,indices,groups);
}
