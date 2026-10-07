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
function colorBytes(color){const hex=color.getHex();return [(hex>>16)&255,(hex>>8)&255,hex&255];}
function cleanedPortrait(view,topColor,bottomColor,boundary){
  const canvas=document.createElement('canvas');canvas.width=view.canvas.width;canvas.height=view.canvas.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(view.canvas,0,0);
  const mask=view.segmentation;if(!mask?.data?.length){ctx.fillStyle='#'+topColor.getHexString();ctx.fillRect(0,0,canvas.width,canvas.height);return canvas;}
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),top=colorBytes(topColor),bottom=colorBytes(bottomColor);
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const mx=Math.min(mask.width-1,Math.floor(x/canvas.width*mask.width)),my=Math.min(mask.height-1,Math.floor(y/canvas.height*mask.height));
    if(mask.data[my*mask.width+mx]!==0)continue;
    const fill=y/canvas.height<boundary?top:bottom,i=(y*canvas.width+x)*4;
    pixels.data[i]=fill[0];pixels.data[i+1]=fill[1];pixels.data[i+2]=fill[2];pixels.data[i+3]=255;
  }
  ctx.putImageData(pixels,0,0);return canvas;
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
    const head=skullGeometry(base),skin=segmentedColor(THREE,portrait,3,0xc58f78);
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
      const clothMaterial=new THREE.MeshStandardMaterial({color:shirt,roughness:1,side:THREE.DoubleSide});
      const neckData=neckGeometry(head),measuredNeck=(anchors.neckRight.x-anchors.neckLeft.x)/portraitWidth;
      const neckScale=Math.max(.78,Math.min(1.28,measuredNeck/.60));
      for(let i=0;i<neckData.positions.length;i+=3)neckData.positions[i]=head.cx+(neckData.positions[i]-head.cx)*neckScale;
      body.add(new THREE.Mesh(geometry(THREE,neckData),skinMaterial));
      const torsoData=torsoGeometry(head),measuredShoulders=(anchors.shoulderRight.x-anchors.shoulderLeft.x)/portraitWidth;
      const torsoScale=Math.max(.78,Math.min(1.25,measuredShoulders/2.24));
      for(let i=0;i<torsoData.positions.length;i+=3)torsoData.positions[i]=head.cx+(torsoData.positions[i]-head.cx)*torsoScale;
      body.add(new THREE.Mesh(geometry(THREE,torsoData),clothMaterial));
      const strands=document.createElement('canvas');strands.width=128;strands.height=128;const sc=strands.getContext('2d');sc.fillStyle='#'+hairSample.getHexString();sc.fillRect(0,0,128,128);
      for(let i=0;i<150;i++){sc.strokeStyle=i%3?'rgba(255,255,255,.04)':'rgba(0,0,0,.11)';sc.beginPath();const x=(i*31.7)%128;sc.moveTo(x,-4);sc.bezierCurveTo(x-8,35,x+7,88,x-4,132);sc.stroke();}
      const strandTexture=new THREE.CanvasTexture(strands);strandTexture.colorSpace=THREE.SRGBColorSpace;
      const rearHair=new THREE.MeshStandardMaterial({map:strandTexture,roughness:1,side:THREE.DoubleSide});
      const hairCanvas=cleanedPortrait(portrait,hairSample,hairSample,1),hairTexture=new THREE.CanvasTexture(hairCanvas);hairTexture.colorSpace=THREE.SRGBColorSpace;
      const hairPhotoMaterial=new THREE.MeshStandardMaterial({map:hairTexture,roughness:1,side:THREE.DoubleSide});
      const fittedHair=portraitHairGeometry(portrait.landmarks,anchors,frame,base),hairSeam=[28,29,30,31,32,33,34,35,0,1,2,3,4,5,6,7,8];
      for(let j=0;j<hairSeam.length;j++){const id=OVAL[hairSeam[j]];fittedHair.positions[j*3]=base[id*3];fittedHair.positions[j*3+1]=base[id*3+1];fittedHair.positions[j*3+2]=base[id*3+2];}
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
