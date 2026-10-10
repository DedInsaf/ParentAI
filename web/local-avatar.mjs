import {closeFaceOpenings, FACE_OPENINGS, mouthRig, positionsFor} from './core.mjs';
import {skullGeometry, earGeometry, neckGeometry, torsoGeometry, hairGeometry, OVAL} from './head-geometry.mjs';
import {bakeFaceAtlas} from './face-atlas.mjs';
import {mouthInteriorGeometry, mouthInteriorPositions} from './mouth-geometry.mjs';
import {defaultPortraitAnchors, foreheadScalpGeometry, photoHairPatchGeometry, portraitHairGeometry, portraitEarGeometry, matteBodyGeometry} from './portrait-geometry.mjs';
import {portraitCutout,portraitHairCutout,portraitHairUnderlay,portraitHeadCutout} from './portrait-texture.mjs';

const clamp=value=>Math.max(0,Math.min(.999999,value));

function geometry(THREE,data){
  const result=new THREE.BufferGeometry();
  result.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));
  if(data.uv)result.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv,2));
  if(data.colors)result.setAttribute('color',new THREE.Float32BufferAttribute(data.colors,3));
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
function hairVolumeTexture(THREE,view,hairData,fallback){
  const canvas=document.createElement('canvas');canvas.width=hairData.columns;canvas.height=64;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),source=view.canvas.getContext('2d',{willReadFrequently:true});
  const pixels=source.getImageData(0,0,view.canvas.width,view.canvas.height).data,image=ctx.createImageData(canvas.width,canvas.height);
  const fallbackSrgb=fallback.clone().convertLinearToSRGB(),fallbackRgb=[fallbackSrgb.r,fallbackSrgb.g,fallbackSrgb.b].map(value=>Math.round(value*255));
  const mask=view.segmentation,hasMask=Number.isInteger(mask?.width)&&mask.width>0&&Number.isInteger(mask?.height)&&mask.height>0&&mask.data?.length>=mask.width*mask.height;
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const u=y/(canvas.height-1),edge=hairData.outerPoints[Math.min(hairData.outerPoints.length-1,x)],p={x:edge.x*(1-u*.82)+hairData.crown.x*u*.82,y:edge.y*(1-u*.82)+hairData.crown.y*u*.82};
    const sx=Math.max(0,Math.min(view.canvas.width-1,Math.floor(p.x*view.canvas.width))),sy=Math.max(0,Math.min(view.canvas.height-1,Math.floor(p.y*view.canvas.height))),si=(sy*view.canvas.width+sx)*4,di=(y*canvas.width+x)*4;
    const mx=hasMask?Math.max(0,Math.min(mask.width-1,Math.floor(p.x*mask.width))):0,my=hasMask?Math.max(0,Math.min(mask.height-1,Math.floor(p.y*mask.height))):0,hair=!hasMask||mask.data[my*mask.width+mx]===1;
    const shade=.94-.12*u;
    for(let channel=0;channel<3;channel++)image.data[di+channel]=Math.round((hair?pixels[si+channel]:fallbackRgb[channel])*shade);
    image.data[di+3]=255;
  }
  ctx.putImageData(image,0,0);const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;return texture;
}

export class LocalAvatar {
  static create(THREE,views,topology){
    const front=views.find(v=>v.role==='front'),portrait=views.find(v=>v.role==='portrait');
    if(!front)throw new Error('Не хватает фронтального снимка.');
    // One portrait coordinate system and one photograph own the whole visible
    // person. Warping the close first frame onto the final portrait created
    // seams whenever distance, light, expression or hairstyle changed.
    const bust=portrait?.matte&&portrait.anchors?portrait:front;
    if(!bust?.matte)throw new Error('Не удалось выделить волосы, шею и одежду.');
    const bodyView=bust;
    const indices=[];
    for(let i=0;i<topology.length;i+=3){const tri=[topology[i].start,topology[i].end,topology[i+1].end];if(tri.every(n=>n<468))indices.push(...tri);}
    const filled=closeFaceOpenings(bust.landmarks,indices,false),points=filled.points;
    // The portrait scan already enforces a frontal, level pose. Keeping its
    // original projection makes the face share exact pixels with the photographed
    // hair, jaw and neck instead of opening seams during a second neutralisation.
    const base=new Float32Array(positionsFor(points,bust.canvas.width,bust.canvas.height));
    const faceGeometry=new THREE.BufferGeometry();
    faceGeometry.setAttribute('position',new THREE.BufferAttribute(base.slice(),3));
    faceGeometry.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(points.flatMap(p=>[p.x,1-p.y])),2));
    faceGeometry.setIndex(filled.indices);faceGeometry.computeVertexNormals();
    const atlas=bakeFaceAtlas(bust,views,filled.indices);
    const texture=new THREE.CanvasTexture(atlas);texture.colorSpace=THREE.SRGBColorSpace;
    const face=new THREE.Mesh(faceGeometry,new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide}));
    const rig=mouthRig(points),mouthWidth=Math.abs(base[308*3]-base[78*3]),cavityIds=FACE_OPENINGS[2];
    const cavityData=mouthInteriorGeometry(base,cavityIds,mouthWidth),cavityGeometry=geometry(THREE,cavityData);
    const cavity=new THREE.Mesh(cavityGeometry,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide}));
    const head=skullGeometry(base),skin=faceSkinColor(THREE,bust,0xc58f78);
    const shellGeometry=geometry(THREE,head),colors=[],ctx=bust.canvas.getContext('2d',{willReadFrequently:true});
    for(let i=0;i<head.positions.length/3;i++){
      const p=bust.landmarks[OVAL[i%OVAL.length]],rgb=ctx.getImageData(clamp(p.x)*bust.canvas.width|0,clamp(p.y)*bust.canvas.height|0,1,1).data;
      const color=new THREE.Color().setRGB(rgb[0]/255,rgb[1]/255,rgb[2]/255,THREE.SRGBColorSpace).lerp(skin,1-head.rim[i]);colors.push(color.r,color.g,color.b);
    }
    shellGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
    const skinMaterial=new THREE.MeshBasicMaterial({color:skin,side:THREE.FrontSide});
    const shell=new THREE.Mesh(shellGeometry,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide}));
    const group=new THREE.Group(),pivot=new THREE.Group(),body=new THREE.Group();pivot.add(shell);
    const hairSample=segmentedColor(THREE,bust,1,0x37261c);
    const anchors=bust.anchors||defaultPortraitAnchors(bust.landmarks);
    if(bust.anchors){
      const portraitWidth=Math.max(.01,Math.abs(bust.landmarks[454].x-bust.landmarks[234].x)),portraitHeight=Math.max(.01,Math.abs(bust.landmarks[152].y-bust.landmarks[10].y));
      const scale=Math.abs(base[454*3]-base[234*3])/portraitWidth,vertical=Math.abs(base[152*3+1]-base[10*3+1])/portraitHeight;
      const aspect=vertical/scale,nose=bust.landmarks[1];
      const frame={nose:{x:nose.x-base[1*3]/scale,y:nose.y+base[1*3+1]/vertical},aspect,scale};
      // Face, hair, neck and shirt now use this exact frame. Keeping one scale,
      // centre and exposure preserves the continuous photographed silhouette.
      const bodyFrame=frame;
      const headTexture=new THREE.CanvasTexture(portraitHeadCutout(bust));headTexture.colorSpace=THREE.SRGBColorSpace;
      const headMaterial=new THREE.MeshBasicMaterial({map:headTexture,side:THREE.DoubleSide,transparent:true,alphaTest:.06});
      const foreheadBridge=foreheadScalpGeometry(bust.landmarks,frame,base,bust.segmentation);
      const photoHair=photoHairPatchGeometry(bust.landmarks,anchors,frame,base,65,41,{segmentation:bust.segmentation,matte:bust.matte});
      const hairTexture=new THREE.CanvasTexture(portraitHairCutout(bust,.18));hairTexture.colorSpace=THREE.SRGBColorSpace;hairTexture.generateMipmaps=false;hairTexture.minFilter=THREE.LinearFilter;
      const hairPhotoMaterial=new THREE.MeshBasicMaterial({map:hairTexture,side:THREE.DoubleSide,transparent:true,alphaTest:.01});
      const denseHairTexture=new THREE.CanvasTexture(portraitHairCutout(bust,.50));denseHairTexture.colorSpace=THREE.SRGBColorSpace;denseHairTexture.generateMipmaps=false;denseHairTexture.minFilter=THREE.LinearFilter;
      const denseHairMaterial=new THREE.MeshBasicMaterial({map:denseHairTexture,side:THREE.FrontSide,transparent:true,alphaTest:.01,depthWrite:false});
      const bodyTexture=new THREE.CanvasTexture(portraitCutout(bodyView));bodyTexture.colorSpace=THREE.SRGBColorSpace;
      const bodyMaterial=new THREE.MeshBasicMaterial({map:bodyTexture,side:THREE.DoubleSide,transparent:true,alphaTest:.02});
      // The photographed front half already curves around the torso. Opaque
      // inner faces used to show through its transparent room gaps as straight
      // bars beside the neck. Keep those closure faces depth-neutral here.
      const hiddenRearSkin=new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,colorWrite:false});
      const hiddenRearCloth=hiddenRearSkin.clone();
      const bodyData=matteBodyGeometry(bodyView.landmarks,bodyView.anchors,bodyFrame,base,bodyView.matte);
      body.add(new THREE.Mesh(geometry(THREE,bodyData),[bodyMaterial,hiddenRearSkin,hiddenRearCloth]));
      pivot.add(new THREE.Mesh(geometry(THREE,foreheadBridge),headMaterial));
      // Photo hair and rear hair volume share the exact upper face seam.  A
      // single connected mesh prevents the forehead crack that appeared when
      // two independently projected surfaces rotated by different depths.
      const hairData=portraitHairGeometry(bust.landmarks,anchors,frame,base,bust.matte);
      const volumeTexture=hairVolumeTexture(THREE,bust,hairData,hairSample);
      // The rear cap is visible around the side of a turned head. It now keeps
      // the captured colour variation instead of becoming a smooth solid cap.
      const hairVolumeMaterial=new THREE.MeshStandardMaterial({map:volumeTexture,roughness:.95,side:THREE.BackSide});
      const hairUnderlayTexture=new THREE.CanvasTexture(portraitHairUnderlay(bust));hairUnderlayTexture.colorSpace=THREE.SRGBColorSpace;hairUnderlayTexture.generateMipmaps=false;hairUnderlayTexture.minFilter=THREE.LinearFilter;
      const hairUnderlayMaterial=new THREE.MeshBasicMaterial({map:hairUnderlayTexture,side:THREE.DoubleSide,transparent:true,alphaTest:.01,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});
      const invisibleHairRear=new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,colorWrite:false});
      const hairUnderlayMesh=new THREE.Mesh(geometry(THREE,hairData),[hairUnderlayMaterial,invisibleHairRear]);hairUnderlayMesh.renderOrder=0;
      pivot.add(hairUnderlayMesh);
      // Both visible hair layers use the semantic hair matte. A full-person
      // alpha left a pale rectangular sheet beside the real hairstyle.
      const hairMesh=new THREE.Mesh(geometry(THREE,hairData),[hairPhotoMaterial,hairVolumeMaterial]);hairMesh.renderOrder=1;
      pivot.add(hairMesh);
      // A dense photo-aligned front layer preserves the true width and top
      // silhouette of the hairstyle. The connected mesh underneath supplies
      // volume during a turn; this layer supplies the exact frontal pixels.
      const photoHairMesh=new THREE.Mesh(geometry(THREE,photoHair),denseHairMaterial);photoHairMesh.renderOrder=2;
      pivot.add(photoHairMesh);
      for(const side of [-1,1]){
        const earData=portraitEarGeometry(bust.landmarks,anchors,frame,base,side);
        pivot.add(new THREE.Mesh(geometry(THREE,earData),[headMaterial,skinMaterial]));
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
    // A bust should continue below the frame like a camera portrait. Showing
    // the mesh base creates an artificial horizontal cut through the shirt.
    center.y+=h*.07;
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
