import {resampleAlpha} from './portrait-matte.mjs';

// Keep original RGB, coordinates and soft hair coverage. No pixel flooding,
// category erosion or invented opaque fill outside the person.
export function portraitCutout(view){
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
  const lm=view.landmarks,a=view.anchors,faceWidth=lm[454].x-lm[234].x,faceHeight=lm[152].y-lm[10].y;
  const cx=(lm[234].x+lm[454].x)/2,left=a?.templeLeft?.x??lm[234].x-faceWidth*.16,right=a?.templeRight?.x??lm[454].x+faceWidth*.16;
  const top=Math.min(a?.crown?.y??1,lm[10].y-faceHeight*.26),bottom=Math.max(a?.templeLeft?.y??0,a?.templeRight?.y??0,lm[234].y,lm[454].y);
  const isHair=(mx,my)=>mx>=0&&my>=0&&mx<mask.width&&my<mask.height&&mask.data[my*mask.width+mx]===1;
  let red=0,green=0,blue=0,samples=0;
  for(let y=0;y<canvas.height;y+=4)for(let x=0;x<canvas.width;x+=4){
    const mx=Math.min(mask.width-1,Math.floor((x+.5)/canvas.width*mask.width)),my=Math.min(mask.height-1,Math.floor((y+.5)/canvas.height*mask.height));
    if(!isHair(mx,my))continue;const i=(y*canvas.width+x)*4;red+=image.data[i];green+=image.data[i+1];blue+=image.data[i+2];samples++;
  }
  const fill=samples?[red/samples,green/samples,blue/samples]:[55,38,28];
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const mx=Math.min(mask.width-1,Math.floor((x+.5)/canvas.width*mask.width));
    const my=Math.min(mask.height-1,Math.floor((y+.5)/canvas.height*mask.height));
    let neighbours=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(isHair(mx+dx,my+dy))neighbours++;
    // A stable local majority removes isolated flyaway predictions which would
    // otherwise be magnified into a long triangle by the curved scalp mesh.
    const px=(x+.5)/canvas.width,py=(y+.5)/canvas.height;
    const q=px<cx?(px-cx)/Math.max(.001,cx-left):(px-cx)/Math.max(.001,right-cx);
    const capTop=top+(bottom-top)*(1-Math.sqrt(Math.max(0,1-q*q)));
    const i=(y*canvas.width+x)*4,inside=Math.abs(q)<=1&&py>=capTop&&py<=bottom+faceHeight*.15;
    if(!inside)image.data[i+3]=0;
    else {
      // Fill only holes inside the fitted scalp with the measured hair tone.
      // This keeps photographic strands while making the curved surface one
      // continuous layer, so the rear mesh cannot show through as triangles.
      if(neighbours<4){image.data[i]=fill[0];image.data[i+1]=fill[1];image.data[i+2]=fill[2];}
      const sideFade=Math.max(0,Math.min(1,(.82-Math.abs(q))/.20));
      image.data[i+3]=Math.round(255*sideFade*sideFade*(3-2*sideFade));
    }
  }
  ctx.putImageData(image,0,0);return canvas;
}

// The face and body photos are captured at different moments and exposure.
// Gently match only the upper neck to the face tone, then fade back to the
// original portrait before the collar. The verification cutout stays untouched.
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
