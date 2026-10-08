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
