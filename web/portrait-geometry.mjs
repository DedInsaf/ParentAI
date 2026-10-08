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
function ringSurface(sections,frame,frontZ,depth,options={}) {
  const positions=[],uv=[],indices=[],groups=[],segments=48;
  sections.forEach(([left,right],row)=>{
    const rowDepth=options.depthForRow?.(row,sections[row])??depth;
    for(let j=0;j<segments;j++) {
      const angle=j/segments*Math.PI*2,s=Math.cos(angle),t=(s+1)/2;
      const p={x:left.x*(1-t)+right.x*t,y:left.y*(1-t)+right.y*t};
      // Front is gently curved; the back is closed and deeper, never a photo plane.
      const z=frontZ-rowDepth*.5+rowDepth*.5*Math.sin(angle);
      positions.push(...portraitPoint(p,frame,z));uv.push(p.x,1-p.y);
      if(row){const b=(row-1)*segments+j,c=(row-1)*segments+(j+1)%segments,d=row*segments+j,e=row*segments+(j+1)%segments;
        const start=indices.length;indices.push(b,d,c,c,d,e);
        groups.push({start,count:6,materialIndex:j<segments/2?0:(options.rearMaterial?.(row)??(row<=16?1:2))});
      }
    }
  });
  const [left,right]=sections.at(-1),center=positions.length/3,p={x:(left.x+right.x)/2,y:(left.y+right.y)/2};
  const lastDepth=options.depthForRow?.(sections.length-1,sections.at(-1))??depth;
  positions.push(...portraitPoint(p,frame,frontZ-lastDepth*.5));uv.push(p.x,1-p.y);
  for(let j=0;j<segments;j++)indices.push((sections.length-1)*segments+j,(sections.length-1)*segments+(j+1)%segments,center);
  groups.push({start:indices.length-segments*3,count:segments*3,materialIndex:2});
  if(options.capTop){
    const [topLeft,topRight]=sections[0],topCenter=positions.length/3,top={x:(topLeft.x+topRight.x)/2,y:(topLeft.y+topRight.y)/2};
    const topDepth=options.depthForRow?.(0,sections[0])??depth;
    positions.push(...portraitPoint(top,frame,frontZ-topDepth*.5));uv.push(top.x,1-top.y);
    const start=indices.length;
    for(let j=0;j<segments;j++)indices.push(j,topCenter,(j+1)%segments);
    groups.push({start,count:indices.length-start,materialIndex:1});
  }
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

// Keep the photographed neck, collar and shoulders in their original image
// coordinates. The matte defines the outline; anchors only identify the collar
// on the unphotographed rear surface and preserve useful sampling heights.
export function matteBodyGeometry(lm,a,frame,face,matte) {
  const {alpha,width,height}=matte||{};
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||alpha?.length!==width*height){
    throw new Error('Не удалось прочитать контур шеи и плеч.');
  }
  const chin=lm[152],fw=lm[454].x-lm[234].x,fh=chin.y-lm[10].y;
  if(!(fw>0&&fh>0))throw new Error('Не удалось измерить пропорции лица.');
  const center=(a?.neckLeft?.x+a?.neckRight?.x)/2||chin.x;
  const minimumWidth=fw*.2,gapLimit=Math.max(1,Math.floor(width*.003)),silhouetteThreshold=.25;
  const firstRow=Math.max(0,Math.floor(chin.y*height)),lastRow=Math.min(height-1,Math.floor(.97*height));
  const rows=new Array(height).fill(null);
  // Use the span connected through the centre of the person. Tiny mask islands
  // beside a shoulder must not pull the silhouette out into the room.
  for(let y=firstRow;y<=lastRow;y++){
    const spans=[];let start=-1,end=-1;
    for(let x=0;x<width;x++){
      // MODNet's soft boundary is part of the photographed neck and clothing.
      // A hard .5 cut removed several real edge pixels on each side after the
      // texture itself had already been cut out correctly.
      if(alpha[y*width+x]>=silhouetteThreshold){
        if(start<0)start=x;
        else if(x-end-1>gapLimit){spans.push([start,end]);start=x;}
        end=x;
      }
    }
    if(start>=0)spans.push([start,end]);
    let best=null,distance=Infinity;
    for(const [left,right] of spans){
      const l=left/width,r=(right+1)/width;
      if(r-l<minimumWidth)continue;
      const d=Math.max(l-center,center-r,0);
      if(d<distance){distance=d;best={left:l,right:r};}
    }
    if(best&&distance<fw*.15)rows[y]=best;
  }
  const visible=[];for(let y=firstRow;y<=lastRow;y++)if(rows[y])visible.push(y);
  if(visible.length<4)throw new Error('На снимке не удалось выделить шею и плечи.');
  const bottom=Math.min(.97,(visible.at(-1)+1)/height,chin.y+fh*1.25),top=chin.y-fh*.14;
  if(bottom<chin.y+fh*.25)throw new Error('На снимке должно быть видно больше шеи и футболки.');
  const filtered=rows.map((row,y)=>{
    if(!row||!rows[y-1]||!rows[y+1])return row;
    return {left:rows[y-1].left*.125+row.left*.75+rows[y+1].left*.125,right:rows[y-1].right*.125+row.right*.75+rows[y+1].right*.125};
  });
  const boundsAt=y=>{
    const row=Math.max(firstRow,Math.min(lastRow,Math.round(y*height-.5)));
    if(filtered[row])return filtered[row];
    let before=row,after=row;
    while(before>=firstRow&&!filtered[before])before--;
    while(after<=lastRow&&!filtered[after])after++;
    if(before<firstRow)return filtered[after];
    if(after>lastRow)return filtered[before];
    const t=(row-before)/(after-before);
    return {left:filtered[before].left*(1-t)+filtered[after].left*t,right:filtered[before].right*(1-t)+filtered[after].right*t};
  };
  const neckStart=chin.y+fh*.035,neck=boundsAt(neckStart);
  const collarY=Math.max(chin.y+fh*.16,Math.min(bottom,(a?.neckLeft?.y+a?.neckRight?.y)/2||chin.y+fh*.30));
  const collar=boundsAt(collarY),upperCenter=(neck.left+neck.right)/2,upperWidth=Math.min(neck.right-neck.left,fw*.52);
  const collarCenter=(collar.left+collar.right)/2,collarWidth=collar.right-collar.left;
  const ys=new Set(Array.from({length:65},(_,i)=>top+(bottom-top)*i/64));
  for(const y of [chin.y,neckStart,chin.y+fh*.08,a?.neckLeft?.y,a?.neckRight?.y,a?.shoulderLeft?.y,a?.shoulderRight?.y]){
    if(Number.isFinite(y)&&y>top&&y<bottom)ys.add(y);
  }
  const sections=[...ys].sort((x,y)=>x-y).map(y=>{
    let cx,half;
    if(y<chin.y){
      // A compact hidden root sits behind the jaw. It reaches the anatomical
      // upper-neck width at the chin instead of ending in a flat wide cap.
      const t=Math.max(0,Math.min(1,(y-top)/(chin.y-top))),e=t*t*(3-2*t);
      cx=upperCenter;half=upperWidth*(.82+.18*e)*.5;
    }else if(y<collarY){
      // Human necks widen gradually toward the collar. Using the full matte
      // span immediately below the chin produced the rectangular column.
      const t=(y-chin.y)/(collarY-chin.y),e=t*t*(3-2*t);
      cx=upperCenter*(1-e)+collarCenter*e;half=(upperWidth*(1-e)+collarWidth*e)*.5;
    }else{
      const bounds=boundsAt(y);cx=(bounds.left+bounds.right)/2;half=(bounds.right-bounds.left)*.5;
    }
    return [{x:cx-half,y},{x:cx+half,y}];
  });
  const jawBack=Math.min(...[150,149,176,148,152,377,400,378,379,365].map(id=>face[id*3+2]));
  return ringSurface(sections,frame,jawBack-fw*frame.scale*.02,fw*frame.scale*.38,{
    // The head covers this opening. A triangulated top cap faced the camera
    // and looked like a flat horizontal slice through the neck.
    capTop:false,
    rearMaterial:row=>sections[row][0].y<=collarY?1:2,
    depthForRow:(_,section)=>fw*frame.scale*(.38+Math.min(.20,Math.max(0,(section[1].x-section[0].x)/fw-.65)*.10)),
  });
}

export function portraitHairContour(a,t) {
  const side=t<.5?a.templeLeft:a.templeRight,angle=Math.abs(t-.5)*Math.PI;
  return {x:a.crown.x+(side.x-a.crown.x)*Math.sin(angle),y:a.crown.y+(side.y-a.crown.y)*(1-Math.cos(angle))};
}
export function portraitHairGeometry(lm,a,frame,face,matte) {
  const contour=[28,29,30,31,32,33,34,35,0,1,2,3,4,5,6,7,8];
  const usableMatte=Number.isInteger(matte?.width)&&Number.isInteger(matte?.height)&&matte.width>1&&matte.height>1&&matte.alpha?.length===matte.width*matte.height;
  const positions=[],uv=[],indices=[],groups=[],fw=(lm[454].x-lm[234].x)*frame.scale,columns=usableMatte?97:contour.length;
  const ids=contour.map(index=>OVAL[index]),arc=[0];
  for(let j=1;j<ids.length;j++){
    const p=lm[ids[j-1]],q=lm[ids[j]];
    arc.push(arc.at(-1)+Math.hypot((q.x-p.x)*(matte?.width||1),(q.y-p.y)*(matte?.height||frame.aspect)));
  }
  const seam=Array.from({length:columns},(_,j)=>{
    if(!usableMatte)return {leftId:ids[j],rightId:ids[j],amount:0};
    const distance=arc.at(-1)*j/(columns-1);let segment=0;
    while(segment<ids.length-2&&arc[segment+1]<distance)segment++;
    const amount=(distance-arc[segment])/Math.max(.000001,arc[segment+1]-arc[segment]);
    return {leftId:ids[segment],rightId:ids[segment+1],amount};
  });
  const seamPoints=seam.map(({leftId,rightId,amount})=>mix(lm[leftId],lm[rightId],amount));
  const seamDepth=seam.map(({leftId,rightId,amount})=>face[leftId*3+2]*(1-amount)+face[rightId*3+2]*amount);
  const headCenter={x:(lm[234].x+lm[454].x)/2,y:(lm[10].y+lm[152].y)/2};
  const alphaAt=(p)=>{
    if(p.x<0||p.x>1||p.y<0||p.y>1)return 0;
    const x=Math.min(matte.width-1,Math.floor(p.x*matte.width)),y=Math.min(matte.height-1,Math.floor(p.y*matte.height));
    return matte.alpha[y*matte.width+x];
  };
  const edges=seamPoints.map((point,j)=>{
    if(!usableMatte){const outer=portraitHairContour(a,j/(columns-1));return {outer,inner:outer};}
    const dx=(point.x-headCenter.x)*matte.width;
    // Low temple rays must travel slightly upwards. A horizontal ray would
    // select the ear outline and turn it into an invented lock of hair.
    const rawDy=(point.y-headCenter.y)*matte.height,t=j/(columns-1);
    const dy=t<.12||t>.88?Math.min(rawDy,-Math.abs(dx)*.35):rawDy,length=Math.hypot(dx,dy);
    if(length<.001)return {outer:{x:point.x,y:point.y},inner:{x:point.x,y:point.y}};
    const stepX=dx/length/matte.width*.5,stepY=dy/length/matte.height*.5;
    const steps=Math.ceil(Math.hypot(matte.width,matte.height)*2),fringe=Math.max(3,Math.min(matte.width,matte.height)*.02);
    const pixelCenter=p=>({x:(Math.min(matte.width-1,Math.floor(p.x*matte.width))+.5)/matte.width,y:(Math.min(matte.height-1,Math.floor(p.y*matte.height))+.5)/matte.height});
    let outer={x:point.x,y:point.y},inner={...outer},lastStrong=-Infinity,background=0;
    for(let i=0;i<=steps;i++){
      const p={x:point.x+stepX*i,y:point.y+stepY*i},alpha=alphaAt(p);
      if(alpha>=.5){lastStrong=i*.5;inner=pixelCenter(p);}
      if(alpha>=.02&&i*.5-lastStrong<=fringe){
        // Use the accepted pixel's centre, so UV rounding cannot move the
        // outer vertex back across a sharp background boundary.
        outer=pixelCenter(p);background=0;
      }
      else if(alpha<.02&&++background>=4)break;
    }
    return {outer,inner};
  });
  const outerPoints=edges.map(edge=>edge.outer),innerPoints=edges.map(edge=>edge.inner);
  const crown=usableMatte?outerPoints.reduce((best,p)=>p.y<best.y?p:best):a.crown;
  const edgeZ=seamDepth.reduce((sum,z)=>sum+z,0)/columns;
  const connect=(row,materialIndex)=>{
    const start=indices.length;
    for(let j=1;j<columns;j++){const b=(row-1)*columns+j-1,c=b+1,d=row*columns+j-1,e=d+1;indices.push(b,d,c,c,d,e);}
    groups.push({start,count:indices.length-start,materialIndex});
  };
  // Front texture is projected once onto a curved scalp, in the same photo scale.
  for(let row=0;row<=10;row++)for(let j=0;j<columns;j++) {
    const t=j/(columns-1),outer=outerPoints[j],amount=row/10,p=mix(seamPoints[j],outer,amount);
    const arch=Math.sin(t*Math.PI),outerZ=edgeZ-fw*.18*arch;
    const z=seamDepth[j]*(1-amount)+outerZ*amount+fw*.08*Math.sin(amount*Math.PI)*arch;
    positions.push(...portraitPoint(p,frame,z));uv.push(p.x,1-p.y);
    if(j===columns-1&&row)connect(row,0);
  }
  const centerY=(lm[10].y+lm[152].y)*.5;
  // A real rear volume, with small clumps following the head contour. The photo
  // does not wrap around the back or get stretched into an invented side view.
  for(let ring=1;ring<=12;ring++)for(let j=0;j<columns;j++) {
    const t=j/(columns-1),photoTransition=usableMatte&&ring<=2;
    const u=photoTransition?ring/2:usableMatte?(ring-2)/10:ring/12,k=Math.cos(u*Math.PI/2);
    const edge=usableMatte?innerPoints[j]:outerPoints[j];
    const p=photoTransition?mix(outerPoints[j],edge,u):{x:crown.x+(edge.x-crown.x)*k,y:centerY+(edge.y-centerY)*k};
    const arch=Math.sin(t*Math.PI),rib=(.5+.5*Math.sin(j*3.7+u*4))*fw*.006*Math.sin(u*Math.PI);
    const rearDrop=photoTransition?fw*.10*u:usableMatte?fw*.10+fw*.56*Math.sin(u*Math.PI/2):fw*.66*Math.sin(u*Math.PI/2);
    const z=edgeZ-fw*.18*arch-rearDrop+rib;
    positions.push(...portraitPoint(p,frame,z));
    if(photoTransition)uv.push(p.x,1-p.y);else uv.push(t,u);
    // The soft fringe keeps the photo alpha on both sides. Opaque rear hair
    // starts only after the ray has returned inside its dense >= .5 contour.
    if(j===columns-1)connect(10+ring,photoTransition?0:1);
  }
  return {...surface(positions,uv,indices,groups),columns,frontRows:11,photoRearRows:usableMatte?2:0,seam};
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
