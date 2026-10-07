self.onmessage=async ({data:bitmap})=>{
  let segmenter;
  try {
    const {FilesetResolver,ImageSegmenter}=await import('./vendor/vision/vision_bundle.mjs');
    const {combineCategoryMasks}=await import('./portrait-fit.mjs');
    const files=await FilesetResolver.forVisionTasks('/vendor/vision/wasm');
    // CPU for one photo only. This avoids category-mask GPU bugs on iOS.
    segmenter=await ImageSegmenter.createFromOptions(files,{baseOptions:{modelAssetPath:'/vendor/vision/selfie_multiclass.tflite',delegate:'CPU'},canvas:new OffscreenCanvas(1,1),runningMode:'IMAGE',outputCategoryMask:true,outputConfidenceMasks:false});
    const makeCanvas=(draw)=>{const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');draw(ctx,canvas);return canvas;};
    const variants=[
      {message:'Проверяем основной контур…',image:makeCanvas((ctx)=>ctx.drawImage(bitmap,0,0)),flip:false},
      {message:'Сверяем симметрию волос и ушей…',image:makeCanvas((ctx,c)=>{ctx.translate(c.width,0);ctx.scale(-1,1);ctx.drawImage(bitmap,0,0);}),flip:true},
      {message:'Уточняем границы волос при ярком свете…',image:makeCanvas((ctx)=>{ctx.filter='brightness(1.08) contrast(1.06)';ctx.drawImage(bitmap,0,0);}),flip:false},
      {message:'Проверяем шею и ворот в тенях…',image:makeCanvas((ctx)=>{ctx.filter='brightness(.93) contrast(1.10)';ctx.drawImage(bitmap,0,0);}),flip:false},
      {message:'Сверяем края одежды…',image:makeCanvas((ctx,c)=>ctx.drawImage(bitmap,-c.width*.015,-c.height*.015,c.width*1.03,c.height*1.03)),flip:false},
      {message:'Уточняем левый край волос и плеч…',image:makeCanvas((ctx,c)=>ctx.drawImage(bitmap,-c.width*.025,0,c.width*1.025,c.height)),flip:false},
      {message:'Уточняем правый край волос и плеч…',image:makeCanvas((ctx,c)=>ctx.drawImage(bitmap,0,0,c.width*1.025,c.height)),flip:false},
    ];
    const masks=[];let width=0,height=0;
    for(const variant of variants){
      self.postMessage({progress:true,message:variant.message});
      const output=await new Promise((resolve,reject)=>{try{segmenter.segment(variant.image,result=>resolve(result.categoryMask));}catch(error){reject(error);}});
      width=output.width;height=output.height;const data=output.getAsUint8Array().slice();output.close?.();
      if(variant.flip){const unflipped=new Uint8Array(data.length);for(let y=0;y<height;y++)for(let x=0;x<width;x++)unflipped[y*width+x]=data[y*width+(width-1-x)];masks.push(unflipped);}else masks.push(data);
    }
    self.postMessage({progress:true,message:'Сглаживаем контур и проверяем пропуски…'});
    const data=combineCategoryMasks(masks,width,height);
    self.postMessage({data,width,height},[data.buffer]);
  } catch(error){self.postMessage({error:error.message});}
  finally {bitmap.close();segmenter?.close();self.close();}
};
