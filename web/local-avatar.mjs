import {closeFaceOpenings, FACE_OPENINGS, mouthRig, neutralFacePositions} from './core.mjs';
import {skullGeometry, earGeometry, neckGeometry, torsoGeometry, hairGeometry, OVAL} from './head-geometry.mjs';
import {bakeFaceAtlas} from './face-atlas.mjs';
import {mouthInteriorGeometry, mouthInteriorPositions} from './mouth-geometry.mjs';
import {defaultPortraitAnchors, portraitHairGeometry} from './portrait-geometry.mjs';

const clamp=value=>Math.max(0,Math.min(.999999,value));

function geometry(THREE,data){
  const result=new THREE.BufferGeometry();
  result.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));
  if(data.uv)result.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv,2));
  result.setIndex(data.indices);
  for(const group of data.groups||[])result.addGroup(group.start,group.count,group.materialIndex);
  result.computeVertexNormals();return result;
}
function sample(THREE,view,x,y,fallback){
  if(!view?.canvas)return new THREE.Color(fallback);
  const ctx=view.canvas.getContext('2d',{willReadFrequently:true}),w=view.canvas.width,h=view.canvas.height;
  const px=ctx.getImageData(clamp(x)*w|0,clamp(y)*h|0,1,1).data;
  return new THREE.Color().setRGB(px[0]/255,px[1]/255,px[2]/255,THREE.SRGBColorSpace);
}
function categoryPortrait(view,categories,fillColor){
  const canvas=document.createElement('canvas');canvas.width=view.canvas.width;canvas.height=view.canvas.height;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#'+fillColor.getHexString();ctx.fillRect(0,0,canvas.width,canvas.height);
  const mask=view.segmentation;if(!mask?.data?.length)return canvas;
  const allowed=new Set(Array.isArray(categories)?categories:[categories]),size=mask.width*mask.height,seen=new Uint8Array(size);let largest=[];
  for(let start=0;start<size;start++){
    if(seen[start]||!allowed.has(mask.data[start]))continue;
    const queue=[start],component=[];seen[start]=1;
    for(let q=0;q<queue.length;q++){
      const id=queue[q],x=id%mask.width,y=(id/mask.width)|0;component.push(id);
      for(const next of [id-1,id+1,id-mask.width,id+mask.width]){
        if(next<0||next>=size||seen[next]||!allowed.has(mask.data[next]))continue;
        const nx=next%mask.width;if(Math.abs(nx-x)>1)continue;
        seen[next]=1;queue.push(next);
      }
    }
    if(component.length>largest.length)largest=component;
  }
  if(!largest.length)return canvas;
  const selected=new Uint8Array(size);for(const id of largest)selected[id]=1;
  // Extend the nearest valid subject pixels over removed background. This is a
  // small, deterministic content-aware fill: no room pixels and no flat holes.
  const source=view.canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,view.canvas.width,view.canvas.height).data;
  const paint=document.createElement('canvas');paint.width=mask.width;paint.height=mask.height;const pctx=paint.getContext('2d'),filled=pctx.createImageData(mask.width,mask.height),known=selected.slice(),queue=largest.slice();
  for(const id of largest){const x=id%mask.width,y=(id/mask.width)|0,sx=Math.min(view.canvas.width-1,Math.floor((x+.5)/mask.width*view.canvas.width)),sy=Math.min(view.canvas.height-1,Math.floor((y+.5)/mask.height*view.canvas.height)),src=(sy*view.canvas.width+sx)*4,dst=id*4;filled.data[dst]=source[src];filled.data[dst+1]=source[src+1];filled.data[dst+2]=source[src+2];filled.data[dst+3]=255;}
  for(let q=0;q<queue.length;q++){
    const id=queue[q],x=id%mask.width;
    for(const next of [id-1,id+1,id-mask.width,id+mask.width]){
      if(next<0||next>=size||known[next]||Math.abs(next%mask.width-x)>1)continue;
      known[next]=1;const src=id*4,dst=next*4;filled.data[dst]=filled.data[src];filled.data[dst+1]=filled.data[src+1];filled.data[dst+2]=filled.data[src+2];filled.data[dst+3]=255;queue.push(next);
    }
  }
  pctx.putImageData(filled,0,0);ctx.imageSmoothingEnabled=true;ctx.drawImage(paint,0,0,canvas.width,canvas.height);
  let minX=mask.width,maxX=0,minY=mask.height,maxY=0;
  for(const id of largest){const x=id%mask.width,y=(id/mask.width)|0;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  canvas.subjectBounds={x:minX/mask.width,y:minY/mask.height,width:(maxX-minX+1)/mask.width,height:(maxY-minY+1)/mask.height};
  const matte=document.createElement('canvas');matte.width=mask.width;matte.height=mask.height;
  const mctx=matte.getContext('2d'),image=mctx.createImageData(mask.width,mask.height);
  for(const id of largest){
    const x=id%mask.width,y=(id/mask.width)|0;
    // One-pixel erosion removes the room-colored halo common on hair and shoulders.
    if(x===0||y===0||x===mask.width-1||y===mask.height-1||!selected[id-1]||!selected[id+1]||!selected[id-mask.width]||!selected[id+mask.width])continue;
    image.data[id*4]=image.data[id*4+1]=image.data[id*4+2]=255;image.data[id*4+3]=255;
  }
  mctx.putImageData(image,0,0);
  const cut=document.createElement('canvas');cut.width=canvas.width;cut.height=canvas.height;const cctx=cut.getContext('2d');
  cctx.drawImage(view.canvas,0,0);cctx.globalCompositeOperation='destination-in';cctx.imageSmoothingEnabled=true;cctx.drawImage(matte,0,0,canvas.width,canvas.height);
  ctx.drawImage(cut,0,0);return canvas;
}
function projectedUv(data,left,right,top,bottom){
  const xs=data.positions.filter((_,i)=>i%3===0),ys=data.positions.filter((_,i)=>i%3===1),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  data.uv=[];
  for(let i=0;i<data.positions.length;i+=3){
    const tx=(data.positions[i]-minX)/Math.max(.001,maxX-minX),ty=(maxY-data.positions[i+1])/Math.max(.001,maxY-minY);
    data.uv.push(left.x+(right.x-left.x)*tx,1-(top+(bottom-top)*ty));
  }
  return data;
}
function frontNeckSurface(source){
  const positions=[],indices=[],rings=25,segments=32,columns=17;
  // j=0..16 is the camera-facing half of the cylindrical neck.  Keeping the
  // photograph off the rear half prevents a narrow portrait strip from being
  // wrapped and repeated around the whole neck.
  for(let ring=0;ring<rings;ring++)for(let j=0;j<columns;j++){
    const offset=(ring*segments+j)*3;
    positions.push(source.positions[offset],source.positions[offset+1],source.positions[offset+2]+.004);
    if(ring&&j){const a=(ring-1)*columns+j-1,b=a+1,c=ring*columns+j-1,d=c+1;indices.push(a,c,b,b,c,d);}
  }
  return {positions,indices};
}
function segmentedColor(THREE,view,category,fallback){
  const mask=view.segmentation;if(!mask?.data?.length)return new THREE.Color(fallback);
  const ctx=view.canvas.getContext('2d',{willReadFrequently:true}),pixels=ctx.getImageData(0,0,view.canvas.width,view.canvas.height).data;
  let r=0,g=0,b=0,count=0;
  for(let my=0;my<mask.height;my+=2)for(let mx=0;mx<mask.width;mx+=2){
    if(mask.data[my*mask.width+mx]!==category)continue;
    const x=Math.min(view.canvas.width-1,Math.floor((mx+.5)/mask.width*view.canvas.width));
    const y=Math.min(view.canvas.height-1,Math.floor((my+.5)/mask.height*view.canvas.height)),i=(y*view.canvas.width+x)*4;
    r+=pixels[i];g+=pixels[i+1];b+=pixels[i+2];count++;
  }
  return count>12?new THREE.Color().setRGB(r/count/255,g/count/255,b/count/255,THREE.SRGBColorSpace):new THREE.Color(fallback);
}
function faceSkinColor(THREE,view,fallback){
  if(!view?.canvas||!view?.landmarks)return new THREE.Color(fallback);
  const ctx=view.canvas.getContext('2d',{willReadFrequently:true}),pixels=ctx.getImageData(0,0,view.canvas.width,view.canvas.height).data;
  // Stable cheek, temple and chin samples avoid hair, eyes, lips and the deep
  // shadow below the jaw.  This keeps the generated neck attached visually to
  // the photographed face under the user's actual lighting.
  const ids=[50,101,118,123,187,205,280,330,347,352,411,425,152];
  let r=0,g=0,b=0,count=0;
  for(const id of ids){const p=view.landmarks[id];if(!p)continue;const x=clamp(p.x)*view.canvas.width|0,y=clamp(p.y)*view.canvas.height|0,i=(y*view.canvas.width+x)*4;r+=pixels[i];g+=pixels[i+1];b+=pixels[i+2];count++;}
  return count?new THREE.Color().setRGB(r/count/255,g/count/255,b/count/255,THREE.SRGBColorSpace):new THREE.Color(fallback);
}

export class LocalAvatar {
  static create(THREE,views,topology){
    const front=views.find(v=>v.role==='front'),portrait=views.find(v=>v.role==='portrait');
    if(!front||!portrait)throw new Error('Не хватает фронтального снимка или кадра с плечами.');
    const indices=[];
    for(let i=0;i<topology.length;i+=3){const tri=[topology[i].start,topology[i].end,topology[i+1].end];if(tri.every(n=>n<468))indices.push(...tri);}
    const filled=closeFaceOpenings(front.landmarks,indices,false),points=filled.points;
    // Remove the tiny yaw/roll left in a real capture before fitting the skull.
    // This prevents a slightly off-centre scan from becoming a permanently skewed head.
    const base=new Float32Array(neutralFacePositions(points,front.canvas.width,front.canvas.height));
    const faceGeometry=new THREE.BufferGeometry();
    faceGeometry.setAttribute('position',new THREE.BufferAttribute(base.slice(),3));
    faceGeometry.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(points.flatMap(p=>[p.x,1-p.y])),2));
    faceGeometry.setIndex(filled.indices);faceGeometry.computeVertexNormals();
    const atlas=bakeFaceAtlas(front,views.filter(v=>v.role!=='portrait'),filled.indices);
    const texture=new THREE.CanvasTexture(atlas);texture.colorSpace=THREE.SRGBColorSpace;
    const face=new THREE.Mesh(faceGeometry,new THREE.MeshStandardMaterial({map:texture,roughness:1,metalness:0,side:THREE.DoubleSide}));
    const rig=mouthRig(points),mouthWidth=Math.abs(base[308*3]-base[78*3]),cavityIds=FACE_OPENINGS[2];
    const cavityData=mouthInteriorGeometry(base,cavityIds,mouthWidth),cavityGeometry=geometry(THREE,cavityData);
    const cavity=new THREE.Mesh(cavityGeometry,new THREE.MeshBasicMaterial({color:0x241218,side:THREE.DoubleSide}));
    const head=skullGeometry(base),skin=faceSkinColor(THREE,front,0xc58f78);
    const shellGeometry=geometry(THREE,head),colors=[],ctx=front.canvas.getContext('2d',{willReadFrequently:true});
    for(let i=0;i<head.positions.length/3;i++){
      const p=front.landmarks[OVAL[i%OVAL.length]],rgb=ctx.getImageData(clamp(p.x)*front.canvas.width|0,clamp(p.y)*front.canvas.height|0,1,1).data;
      const color=new THREE.Color().setRGB(rgb[0]/255,rgb[1]/255,rgb[2]/255,THREE.SRGBColorSpace).lerp(skin,1-head.rim[i]);colors.push(color.r,color.g,color.b);
    }
    shellGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
    const skinMaterial=new THREE.MeshStandardMaterial({color:skin,roughness:1,side:THREE.DoubleSide});
    const shell=new THREE.Mesh(shellGeometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,side:THREE.DoubleSide}));
    const group=new THREE.Group(),pivot=new THREE.Group(),body=new THREE.Group();pivot.add(shell);
    const hairSample=segmentedColor(THREE,portrait,1,0x37261c);
    const anchors=portrait.anchors||defaultPortraitAnchors(portrait.landmarks);
    if(portrait.anchors){
      const portraitWidth=Math.max(.01,Math.abs(portrait.landmarks[454].x-portrait.landmarks[234].x)),portraitHeight=Math.max(.01,Math.abs(portrait.landmarks[152].y-portrait.landmarks[10].y));
      const scale=Math.abs(base[454*3]-base[234*3])/portraitWidth,vertical=Math.abs(base[152*3+1]-base[10*3+1])/portraitHeight;
      const aspect=vertical/scale,nose=portrait.landmarks[1];
      const frame={nose:{x:nose.x-base[1*3]/scale,y:nose.y+base[1*3+1]/vertical},aspect,scale};
      const shirt=segmentedColor(THREE,portrait,4,0x365064);
      const shirtCanvas=categoryPortrait(portrait,4,shirt),shirtTexture=new THREE.CanvasTexture(shirtCanvas);shirtTexture.colorSpace=THREE.SRGBColorSpace;
      const clothMaterial=new THREE.MeshStandardMaterial({map:shirtTexture,roughness:1,side:THREE.DoubleSide});
      const neckData=neckGeometry(head),measuredNeck=(anchors.neckRight.x-anchors.neckLeft.x)/portraitWidth;
      const neckScale=Math.max(.96,Math.min(1.28,measuredNeck/.60));
      for(let i=0;i<neckData.positions.length;i+=3)neckData.positions[i]=head.cx+(neckData.positions[i]-head.cx)*neckScale;
      body.add(new THREE.Mesh(geometry(THREE,neckData),skinMaterial));
      const neckFront=frontNeckSurface(neckData);
      const neckInset=(anchors.neckRight.x-anchors.neckLeft.x)*.22;
      projectedUv(neckFront,{x:anchors.neckLeft.x+neckInset},{x:anchors.neckRight.x-neckInset},portrait.landmarks[152].y,Math.max(anchors.neckLeft.y,anchors.neckRight.y));
      const neckCanvas=categoryPortrait(portrait,[2,3],skin),neckTexture=new THREE.CanvasTexture(neckCanvas);neckTexture.colorSpace=THREE.SRGBColorSpace;
      body.add(new THREE.Mesh(geometry(THREE,neckFront),new THREE.MeshStandardMaterial({map:neckTexture,roughness:1,side:THREE.DoubleSide})));
      const torsoData=torsoGeometry(head),measuredShoulders=(anchors.shoulderRight.x-anchors.shoulderLeft.x)/portraitWidth;
      const torsoScale=Math.max(.78,Math.min(1.25,measuredShoulders/2.24));
      for(let i=0;i<torsoData.positions.length;i+=3)torsoData.positions[i]=head.cx+(torsoData.positions[i]-head.cx)*torsoScale;
      const shoulderY=Math.min(anchors.shoulderLeft.y,anchors.shoulderRight.y),chestY=Math.max(anchors.chestLeft.y,anchors.chestRight.y);
      projectedUv(torsoData,anchors.shoulderLeft,anchors.shoulderRight,shoulderY+(chestY-shoulderY)*.24,chestY);
      body.add(new THREE.Mesh(geometry(THREE,torsoData),clothMaterial));
      const strands=document.createElement('canvas');strands.width=128;strands.height=128;const sc=strands.getContext('2d');sc.fillStyle='#'+hairSample.getHexString();sc.fillRect(0,0,128,128);
      for(let i=0;i<150;i++){sc.strokeStyle=i%3?'rgba(255,255,255,.04)':'rgba(0,0,0,.11)';sc.beginPath();const x=(i*31.7)%128;sc.moveTo(x,-4);sc.bezierCurveTo(x-8,35,x+7,88,x-4,132);sc.stroke();}
      const strandTexture=new THREE.CanvasTexture(strands);strandTexture.colorSpace=THREE.SRGBColorSpace;
      const rearHair=new THREE.MeshStandardMaterial({map:strandTexture,roughness:1,side:THREE.DoubleSide});
      const hairCanvas=categoryPortrait(portrait,1,hairSample),hairCtx=hairCanvas.getContext('2d');hairCtx.globalAlpha=.10;hairCtx.drawImage(strands,0,0,hairCanvas.width,hairCanvas.height);hairCtx.globalAlpha=1;
      const hairTexture=new THREE.CanvasTexture(hairCanvas);hairTexture.colorSpace=THREE.SRGBColorSpace;
      const hairPhotoMaterial=new THREE.MeshStandardMaterial({map:hairTexture,roughness:1,side:THREE.DoubleSide});
      const fittedHair=portraitHairGeometry(portrait.landmarks,anchors,frame,base),hairSeam=[28,29,30,31,32,33,34,35,0,1,2,3,4,5,6,7,8];
      const hairLift=Math.abs(base[454*3]-base[234*3])*.018;
      for(let row=0;row<=10;row++)for(let j=0;j<hairSeam.length;j++)fittedHair.positions[(row*hairSeam.length+j)*3+2]+=hairLift;
      for(let j=0;j<hairSeam.length;j++){const id=OVAL[hairSeam[j]];fittedHair.positions[j*3]=base[id*3];fittedHair.positions[j*3+1]=base[id*3+1];fittedHair.positions[j*3+2]=base[id*3+2]+hairLift;}
      pivot.add(new THREE.Mesh(geometry(THREE,fittedHair),[hairPhotoMaterial,rearHair]));
      for(const side of [-1,1]){
        const earData=earGeometry(head,side),ear=geometry(THREE,earData),colors=earData.shade.flatMap(value=>[skin.r*value,skin.g*value,skin.b*value]);
        ear.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
        pivot.add(new THREE.Mesh(ear,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,side:THREE.DoubleSide})));
      }
    }else{
      const hairData=hairGeometry(head,'short');
      if(hairData.positions.length)pivot.add(new THREE.Mesh(geometry(THREE,hairData),new THREE.MeshStandardMaterial({color:hairSample,roughness:.95,side:THREE.DoubleSide})));
      for(const side of [-1,1])pivot.add(new THREE.Mesh(geometry(THREE,earGeometry(head,side)),skinMaterial.clone()));
      body.add(new THREE.Mesh(geometry(THREE,neckGeometry(head)),skinMaterial));
      const shirt=sample(THREE,portrait,.5,Math.min(.95,portrait.landmarks[152].y+.25),0x365064);
      body.add(new THREE.Mesh(geometry(THREE,torsoGeometry(head)),new THREE.MeshStandardMaterial({color:shirt,roughness:1,side:THREE.DoubleSide})));
    }
    pivot.add(cavity,face);group.add(pivot,body);
    const {cx,cy,edgeZ,depth,width,height}=head;group.position.set(cx,cy,edgeZ-depth*.32);
    const joint=new THREE.Vector3(cx,base[152*3+1]+height*.08,edgeZ-width*.23);
    pivot.position.copy(joint).sub(group.position);for(const child of pivot.children)child.position.sub(joint);for(const child of body.children)child.position.sub(group.position);
    return new LocalAvatar(THREE,{group,pivot,face,cavity,base,weights:rig.weights,mouthWidth,cavityIds});
  }
  constructor(THREE,data){Object.assign(this,data);this.THREE=THREE;this.object=this.group;this.rest=this.group.position.clone();this.restUv=this.face.geometry.getAttribute('uv').array.slice();this.box=new THREE.Box3().setFromObject(this.group);}
  fit(camera,aspect){
    this.box.setFromObject(this.group);const center=this.box.getCenter(new this.THREE.Vector3()),h=this.box.max.y-this.box.min.y,w=this.box.max.x-this.box.min.x,half=Math.max(h/2,w/(2*aspect))*1.12;
    camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;camera.position.set(center.x,center.y,5);camera.lookAt(center.x,center.y,0);camera.updateProjectionMatrix();
  }
  update(pose,opening,cue,blink){
    const target=(cue==='closed'||cue==='silence'?opening*.04:cue==='teeth'?opening*.2:opening)*this.mouthWidth*.13;
    this.jaw=(this.jaw||0)+(target-(this.jaw||0))*.25;
    const shape=cue==='round'?-.18:cue==='wide'?.09:0,pucker=cue==='round'?this.mouthWidth*.03:0,pos=this.face.geometry.getAttribute('position');
    const mouthX=(this.base[61*3]+this.base[291*3])/2,mouthY=(this.base[13*3+1]+this.base[14*3+1])/2;
    const eyes=FACE_OPENINGS.slice(0,2).map(ring=>{const ex=ring.reduce((s,id)=>s+this.base[id*3],0)/ring.length;return {ey:ring.reduce((s,id)=>s+this.base[id*3+1],0)/ring.length,ex,half:Math.max(...ring.map(id=>Math.abs(this.base[id*3]-ex)))};});
    for(let i=0;i<this.weights.length;i++){
      const x=this.base[i*3],y=this.base[i*3+1],z=this.base[i*3+2],near=Math.exp(-(((x-mouthX)/(this.mouthWidth*.55))**2)-((y-mouthY)/(this.mouthWidth*.25))**2);
      pos.array[i*3]=x+(x-mouthX)*shape*near;pos.array[i*3+1]=y-this.weights[i]*this.jaw;pos.array[i*3+2]=z+pucker*near;
      for(const eye of eyes)if(Math.abs(x-eye.ex)<eye.half&&Math.abs(y-eye.ey)<eye.half*.45)pos.array[i*3+1]-=(y-eye.ey)*blink;
    }
    pos.needsUpdate=true;mouthInteriorPositions(pos.array,this.cavityIds,this.mouthWidth,this.cavity.geometry.getAttribute('position').array);this.cavity.geometry.getAttribute('position').needsUpdate=true;
    this.group.rotation.set(0,pose.preview+pose.bodyYaw,pose.bodyRoll);this.group.position.copy(this.rest);this.group.position.y+=pose.breath;
    this.pivot.rotation.set(pose.pitch,pose.yaw,pose.roll);this.face.geometry.computeVertexNormals();
  }
  dispose(){const geometries=new Set(),materials=new Set(),textures=new Set();this.group.traverse(item=>{if(item.geometry)geometries.add(item.geometry);for(const material of(Array.isArray(item.material)?item.material:[item.material]).filter(Boolean)){materials.add(material);for(const value of Object.values(material))if(value?.isTexture)textures.add(value);}});textures.forEach(x=>x.dispose());materials.forEach(x=>x.dispose());geometries.forEach(x=>x.dispose());}
}
