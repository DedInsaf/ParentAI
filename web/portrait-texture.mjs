import {openedCategoryComponent,resampleAlpha} from './portrait-matte.mjs';

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
    const i=y*canvas.width+x;let supported=true;
    if(categories?.data?.length){
      const mx=Math.min(categories.width-1,Math.floor((x+.5)/canvas.width*categories.width));
      const my=Math.min(categories.height-1,Math.floor((y+.5)/canvas.height*categories.height));supported=false;
      // A one-cell allowance retains antialiased hair and clothing edges while
      // rejecting MODNet haze over the room beside the neck.
      for(let dy=-1;dy<=1&&!supported;dy++)for(let dx=-1;dx<=1;dx++){
        const px=mx+dx,py=my+dy;if(px>=0&&py>=0&&px<categories.width&&py<categories.height&&categories.data[py*categories.width+px]!==0){supported=true;break;}
      }
    }
    image.data[i*4+3]=supported?Math.round(alpha[i]*255):0;
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
  const alpha=resampleAlpha(view.matte.alpha,view.matte.width,view.matte.height,canvas.width,canvas.height);
  for(let i=0;i<alpha.length;i++)image.data[i*4+3]=Math.round(alpha[i]*255);
  ctx.putImageData(image,0,0);return canvas;
}

// A scalp mesh may cover forehead and ear UVs while curving around the head.
// Give it a hair-only alpha mask so those opaque skin pixels cannot become
// floating photo triangles. A one-cell neighbourhood retains thin edge hairs.
export function portraitHairCutout(view){
  const canvas=portraitCutout(view),mask=view?.segmentation;
  if(!mask?.data?.length)return canvas;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),image=ctx.getImageData(0,0,canvas.width,canvas.height);
  const connected=openedCategoryComponent(mask.data,mask.width,mask.height,1,3);
  const isHair=(mx,my)=>mx>=0&&my>=0&&mx<mask.width&&my<mask.height&&connected[my*mask.width+mx]===1;
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const mx=Math.min(mask.width-1,Math.floor((x+.5)/canvas.width*mask.width));
    const my=Math.min(mask.height-1,Math.floor((y+.5)/canvas.height*mask.height));
    let neighbours=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(isHair(mx+dx,my+dy))neighbours++;
    // A stable local majority removes isolated flyaway predictions which would
    // otherwise be magnified into a long triangle by the curved scalp mesh.
    if(neighbours<4)image.data[(y*canvas.width+x)*4+3]=0;
  }
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
