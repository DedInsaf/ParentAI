import {openedCategoryComponent,resampleAlpha} from './portrait-matte.mjs';
const supportCache=new WeakMap();

// Refine only neck/clothing alpha. RGB and the accepted head placement stay
// untouched, and fine hair above startRow never enters the contour filter.
export function smoothBodyCutoutEdges(rgba,width,height,startRow){
  const count=width*height;
  if(rgba?.length!==count*4||!Number.isInteger(startRow)||startRow>=height)return rgba;
  startRow=Math.max(0,startRow);
  const labels=new Int32Array(count),queue=new Int32Array(count);let label=0,best=0,bestSize=0;
  for(let seed=0;seed<count;seed++){
    if(labels[seed]||rgba[seed*4+3]<8)continue;
    let read=0,size=1;queue[0]=seed;labels[seed]=++label;
    while(read<size){
      const index=queue[read++],x=index%width,y=Math.floor(index/width);
      for(const next of [x>0?index-1:-1,x+1<width?index+1:-1,y>0?index-width:-1,y+1<height?index+width:-1]){
        if(next>=0&&!labels[next]&&rgba[next*4+3]>=8){labels[next]=label;queue[size++]=next;}
      }
    }
    if(size>bestSize){bestSize=size;best=label;}
  }
  const alpha=new Uint8Array(count);
  for(let i=0;i<count;i++)alpha[i]=labels[i]===best?rgba[i*4+3]:0;
  // A one-pixel median misses several-pixel spurs from an enlarged semantic
  // mask. Opening with a small round footprint removes narrow attachments,
  // then restores the broad neck silhouette instead of uniformly shrinking it.
  const radius=Math.max(2,Math.min(3,Math.round(width/480))),offsets=[];
  for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++)if(dx*dx+dy*dy<=radius*radius)offsets.push([dx,dy]);
  const eroded=alpha.slice(),filtered=alpha.slice();
  for(let y=startRow;y<height;y++)for(let x=0;x<width;x++){
    let value=255;
    for(const [dx,dy] of offsets){
      const px=Math.max(0,Math.min(width-1,x+dx)),py=Math.max(startRow,Math.min(height-1,y+dy));
      value=Math.min(value,alpha[py*width+px]);if(value===0)break;
    }
    eroded[y*width+x]=value;
  }
  for(let y=startRow;y<height;y++)for(let x=0;x<width;x++){
    let value=0;
    for(const [dx,dy] of offsets){
      const px=Math.max(0,Math.min(width-1,x+dx)),py=Math.max(startRow,Math.min(height-1,y+dy));
      value=Math.max(value,eroded[py*width+px]);if(value===255)break;
    }
    filtered[y*width+x]=value;
  }
  const opened=filtered.slice(),samples=new Array(9);
  for(let y=Math.max(1,startRow);y<height-1;y++)for(let x=1;x<width-1;x++){
    let n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)samples[n++]=opened[(y+dy)*width+x+dx];
    samples.sort((a,b)=>a-b);filtered[y*width+x]=samples[4];
  }
  for(let y=startRow;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;
    if(!alpha[i]){rgba[i*4+3]=0;continue;}
    let sum=0,weight=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const px=x+dx,py=y+dy;if(px<0||py<startRow||px>=width||py>=height)continue;
      const w=(dx===0?2:1)*(dy===0?2:1);sum+=filtered[py*width+px]*w;weight+=w;
    }
    rgba[i*4+3]=Math.min(alpha[i],Math.round(sum/weight));
  }
  return rgba;
}

function refineBodyEdge(image,view,width,height){
  const chin=view.landmarks?.[152],forehead=view.landmarks?.[10];
  if(chin&&forehead)smoothBodyCutoutEdges(image.data,width,height,Math.floor((chin.y-(chin.y-forehead.y)*.12)*height));
}

// Hair needs a generous semantic allowance; the neck does not. Applying the
// hair allowance to the entire person retained little pieces of the room
// beside the jaw and collar. Return continuous coverage, not a blocky label.
export function portraitSupportAt(view,x,y){
  const mask=view?.segmentation;
  if(!mask?.data?.length)return 1;
  const chin=view.landmarks?.[152],forehead=view.landmarks?.[10];
  const belowJaw=chin&&forehead&&y>chin.y-(chin.y-forehead.y)*.06;
  let planes=supportCache.get(mask);
  if(!planes){
    const tight=Uint8Array.from(mask.data,category=>category>=1&&category<=4?1:0),wide=new Uint8Array(tight.length);
    for(let my=0;my<mask.height;my++)for(let mx=0;mx<mask.width;mx++){
      let found=0;
      for(let dy=-3;dy<=3&&!found;dy++)for(let dx=-3;dx<=3;dx++){
        const px=mx+dx,py=my+dy;
        if(px>=0&&py>=0&&px<mask.width&&py<mask.height&&tight[py*mask.width+px]){found=1;break;}
      }
      wide[my*mask.width+mx]=found;
    }
    planes={tight,wide};supportCache.set(mask,planes);
  }
  const support=belowJaw?planes.tight:planes.wide,sample=(mx,my)=>support[my*mask.width+mx];
  const sx=Math.max(0,Math.min(mask.width-1,x*mask.width-.5)),sy=Math.max(0,Math.min(mask.height-1,y*mask.height-.5));
  const mx=Math.floor(sx),my=Math.floor(sy),tx=sx-mx,ty=sy-my;
  return sample(mx,my)*(1-tx)*(1-ty)+sample(Math.min(mask.width-1,mx+1),my)*tx*(1-ty)+
    sample(mx,Math.min(mask.height-1,my+1))*(1-tx)*ty+sample(Math.min(mask.width-1,mx+1),Math.min(mask.height-1,my+1))*tx*ty;
}

// Transparent edge pixels still contain the colour of the photographed room.
// When WebGL blends them over the avatar background that colour becomes a pale
// halo. Borrow RGB from the nearest opaque hair pixel while preserving the
// original soft alpha, so strands remain antialiased without carrying the wall.
export function defringeHairEdges(rgba,width,height,radius=6){
  if(!(rgba instanceof Uint8ClampedArray)||rgba.length!==width*height*4||width<1||height<1)return rgba;
  const source=rgba.slice(),limit=Math.max(1,Math.min(12,Math.round(radius)));
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4,alpha=source[i+3];if(alpha===0||alpha>=250)continue;
    let match=-1;
    for(let r=1;r<=limit&&match<0;r++){
      const left=Math.max(0,x-r),right=Math.min(width-1,x+r),top=Math.max(0,y-r),bottom=Math.min(height-1,y+r);
      for(let px=left;px<=right&&match<0;px++)for(const py of [top,bottom]){const j=(py*width+px)*4;if(source[j+3]>=250){match=j;break;}}
      for(let py=top+1;py<bottom&&match<0;py++)for(const px of [left,right]){const j=(py*width+px)*4;if(source[j+3]>=250){match=j;break;}}
    }
    if(match>=0){rgba[i]=source[match];rgba[i+1]=source[match+1];rgba[i+2]=source[match+2];}
  }
  return rgba;
}

// Keep original RGB, coordinates and soft hair coverage. No pixel flooding,
// category erosion or invented opaque fill outside the person.
export function portraitCutout(view){
  if(!view?.matte?.alpha)throw new Error('Сначала нужно отделить человека от фона.');
  const canvas=document.createElement('canvas');canvas.width=view.canvas.width;canvas.height=view.canvas.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(view.canvas,0,0);
  const image=ctx.getImageData(0,0,canvas.width,canvas.height);
  const alpha=resampleAlpha(view.matte.alpha,view.matte.width,view.matte.height,canvas.width,canvas.height);
  const categories=view?.segmentation;
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const i=y*canvas.width+x;
    image.data[i*4+3]=Math.round(alpha[i]*255*portraitSupportAt(view,(x+.5)/canvas.width,(y+.5)/canvas.height));
  }
  refineBodyEdge(image,view,canvas.width,canvas.height);
  const matteScale=Math.max(canvas.width/view.matte.width,canvas.height/view.matte.height);
  defringeHairEdges(image.data,canvas.width,canvas.height,matteScale*2);
  ctx.putImageData(image,0,0);return canvas;
}

export function neckOverlapAlpha(y,chinY,faceHeight){
  if(!(faceHeight>0))return 1;
  // Finish the fade above the lowered jaw so the visible neck stays opaque.
  const t=Math.max(0,Math.min(1,(y-(chinY-faceHeight*.14))/(faceHeight*.065)));
  return t*t*(3-2*t);
}

export function portraitBodyCutout(view){
  const canvas=portraitCutout(view),chin=view.landmarks?.[152],forehead=view.landmarks?.[10];
  if(!chin||!forehead)return canvas;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),image=ctx.getImageData(0,0,canvas.width,canvas.height);
  for(let y=0;y<canvas.height;y++){
    const weight=neckOverlapAlpha((y+.5)/canvas.height,chin.y,chin.y-forehead.y);
    if(weight===1)break;
    for(let x=0;x<canvas.width;x++)image.data[(y*canvas.width+x)*4+3]=Math.round(image.data[(y*canvas.width+x)*4+3]*weight);
  }
  ctx.putImageData(image,0,0);return canvas;
}

// The semantic mask is deliberately conservative and often removes fine hair
// that MODNet still identifies correctly. Hair geometry already limits where
// this texture can appear, so keep the soft high-resolution matte for the head
// instead of clipping it again to the coarse category cells.
export function portraitHeadCutout(view){
  if(!view?.matte?.alpha)throw new Error('Сначала нужно отделить человека от фона.');
  const canvas=document.createElement('canvas');canvas.width=view.canvas.width;canvas.height=view.canvas.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(view.canvas,0,0);
  const image=ctx.getImageData(0,0,canvas.width,canvas.height);
  const alpha=resampleAlpha(view.matte.alpha,view.matte.width,view.matte.height,canvas.width,canvas.height),categories=view?.segmentation;
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const i=y*canvas.width+x;
    image.data[i*4+3]=Math.round(alpha[i]*255*portraitSupportAt(view,(x+.5)/canvas.width,(y+.5)/canvas.height));
  }
  refineBodyEdge(image,view,canvas.width,canvas.height);
  const matteScale=Math.max(canvas.width/view.matte.width,canvas.height/view.matte.height);
  defringeHairEdges(image.data,canvas.width,canvas.height,matteScale*2);
  ctx.putImageData(image,0,0);return canvas;
}

// A scalp mesh may cover forehead and ear UVs while curving around the head.
// Give it a hair-only alpha mask so those opaque skin pixels cannot become
// floating photo triangles. A one-cell neighbourhood retains thin edge hairs.
export function portraitHairCutout(view,minimumCoverage=.16){
  const canvas=portraitHeadCutout(view),mask=view?.segmentation;
  if(!mask?.data?.length)return canvas;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),image=ctx.getImageData(0,0,canvas.width,canvas.height);
  const connected=openedCategoryComponent(mask.data,mask.width,mask.height,1,1);
  const isHair=(mx,my)=>mx>=0&&my>=0&&mx<mask.width&&my<mask.height&&connected[my*mask.width+mx]===1;
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const mx=Math.min(mask.width-1,Math.floor((x+.5)/canvas.width*mask.width));
    const my=Math.min(mask.height-1,Math.floor((y+.5)/canvas.height*mask.height));
    let neighbours=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(isHair(mx+dx,my+dy))neighbours++;
    // Semantic labels locate hair; MODNet owns the soft photographed edge.
    const alphaIndex=(y*canvas.width+x)*4+3,coverage=image.data[alphaIndex]/255;
    const cutoff=Math.max(0,Math.min(.9,minimumCoverage));
    if(neighbours===0||coverage<Math.min(.08,cutoff))image.data[alphaIndex]=0;
    else {
      const smooth=Math.max(0,Math.min(1,coverage));
      // Preserve soft alpha instead of promoting translucent strands to an
      // opaque slab. Only feather the outermost semantic support cells.
      const edge=Math.min(1,neighbours/3);
      image.data[alphaIndex]=Math.round(255*smooth*edge);
    }
  }
  const pixelScale=Math.max(canvas.width/mask.width,canvas.height/mask.height);
  defringeHairEdges(image.data,canvas.width,canvas.height,pixelScale*2);
  ctx.putImageData(image,0,0);return canvas;
}

// A semantic underlay sits behind the soft photographed hair. It is invisible
// in the frontal view, but prevents a bright room-coloured slit from opening
// between overlapping hair surfaces when the head turns. Dense interior cells
// stay opaque; the one-cell boundary remains soft and borrows interior colour.
export function portraitHairUnderlay(view){
  const canvas=portraitHairCutout(view,.18),mask=view?.segmentation;
  if(!mask?.data?.length)return canvas;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),image=ctx.getImageData(0,0,canvas.width,canvas.height);
  const connected=openedCategoryComponent(mask.data,mask.width,mask.height,1,3);
  const isHair=(mx,my)=>mx>=0&&my>=0&&mx<mask.width&&my<mask.height&&connected[my*mask.width+mx]===1;
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const mx=Math.min(mask.width-1,Math.floor((x+.5)/canvas.width*mask.width));
    const my=Math.min(mask.height-1,Math.floor((y+.5)/canvas.height*mask.height));let neighbours=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(isHair(mx+dx,my+dy))neighbours++;
    image.data[(y*canvas.width+x)*4+3]=neighbours===9?255:neighbours>=4?220:0;
  }
  const pixelScale=Math.max(canvas.width/mask.width,canvas.height/mask.height);
  defringeHairEdges(image.data,canvas.width,canvas.height,Math.max(6,pixelScale*5));
  ctx.putImageData(image,0,0);return canvas;
}

// Gently normalize only the upper neck to the sampled face tone, then fade
// back to the original photograph before the collar. The verification cutout
// stays untouched.
export function portraitAvatarTexture(view,targetRgb){
  const canvas=portraitCutout(view),ctx=canvas.getContext('2d',{willReadFrequently:true}),image=ctx.getImageData(0,0,canvas.width,canvas.height);
  const chin=view.landmarks?.[152],crown=view.landmarks?.[10];
  if(!chin||!crown||!targetRgb?.every(Number.isFinite))return canvas;
  const fh=chin.y-crown.y,start=Math.max(0,chin.y-fh*.025),end=Math.min(1,chin.y+fh*.24);
  for(let y=Math.max(0,Math.floor(start*canvas.height));y<Math.min(canvas.height,Math.ceil(end*canvas.height));y++){
    const t=Math.max(0,Math.min(1,((y+.5)/canvas.height-start)/(end-start))),fade=1-t*t*(3-2*t),amount=.82*fade;
    for(let x=0;x<canvas.width;x++){
      const i=(y*canvas.width+x)*4;if(image.data[i+3]<8)continue;
      for(let c=0;c<3;c++)image.data[i+c]=Math.round(image.data[i+c]*(1-amount)+targetRgb[c]*amount);
    }
  }
  ctx.putImageData(image,0,0);return canvas;
}
