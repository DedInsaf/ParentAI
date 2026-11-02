// Both networks run inside this worker. No photo is sent to a remote service.
// One worker serves both accepted portraits; reuse the loaded models between them.
let segmenter,session,initialization,visionModule,matteModule,ort;
async function initialize(progress){
  if(!initialization)initialization=(async()=>{
    [visionModule,matteModule,ort]=await Promise.all([
      import('./vendor/vision/vision_bundle.mjs'),
      import('./portrait-matte.mjs'),
      import('./vendor/matting/ort.wasm.min.mjs'),
    ]);
    const {FilesetResolver,ImageSegmenter}=visionModule;
    progress('Загружаем модель обработки снимков…');
    const files=await FilesetResolver.forVisionTasks('/vendor/vision/wasm');
    segmenter=await ImageSegmenter.createFromOptions(files,{baseOptions:{modelAssetPath:'/vendor/vision/selfie_multiclass.tflite',delegate:'CPU'},canvas:new OffscreenCanvas(1,1),runningMode:'IMAGE',outputCategoryMask:true,outputConfidenceMasks:false});
    ort.env.wasm.numThreads=self.crossOriginIsolated?Math.max(2,Math.min(4,self.navigator?.hardwareConcurrency||2)):1;
    ort.env.wasm.proxy=false;
    ort.env.wasm.wasmPaths=new URL('./vendor/matting/',self.location.href).href;
    progress('Загружаем модель точного удаления фона…');
    session=await ort.InferenceSession.create('/vendor/matting/modnet.onnx',{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  })();
  return await initialization;
}
self.onmessage=async ({data:message})=>{
  const bitmap=message?.bitmap||message,accessoriesOnly=!!message?.accessoriesOnly;
  const began=performance.now(),progress=message=>self.postMessage({progress:true,message});
  try {
    await initialize(progress);
    if(message?.warmup){self.postMessage({ready:true});return;}
    const {imageToNchw,cleanPortraitAlpha}=matteModule;
    progress('Находим лицо, волосы, шею и одежду…');
    // Copy masks inside the callback: MediaPipe releases them when it returns.
    const classes=await new Promise((resolve,reject)=>{
      try {segmenter.segment(bitmap,result=>{
        const mask=result.categoryMask;
        resolve({data:mask.getAsUint8Array().slice(),width:mask.width,height:mask.height});
      });} catch(error){reject(error);}
    });
    if(accessoriesOnly){
      self.postMessage({...classes,engine:'mediapipe-accessories'},[classes.data.buffer]);
      return;
    }
    if(message?.landmarks){
      const {portraitAccessoryIssue}=await import('./portrait-fit.mjs');
      const issue=portraitAccessoryIssue(message.landmarks,classes);
      if(issue)throw new Error(issue);
    }
    progress('Аккуратно отделяем волосы и края плеч от фона…');
    // Use the user's accepted processing window for a near-source-resolution
    // matte. Two passes at this size preserve thin hair and the real neckline;
    // the previous 512 px short side was fast but visibly rounded both.
    const factor=Math.min(768/Math.min(bitmap.width,bitmap.height),1024/Math.max(bitmap.width,bitmap.height));
    const width=Math.max(32,Math.round(bitmap.width*factor/32)*32),height=Math.max(32,Math.round(bitmap.height*factor/32)*32);
    const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true});
    const infer=async mirrored=>{
      ctx.save();ctx.clearRect(0,0,width,height);
      if(mirrored){ctx.translate(width,0);ctx.scale(-1,1);}ctx.drawImage(bitmap,0,0,width,height);ctx.restore();
      const tensor=new ort.Tensor('float32',imageToNchw(ctx.getImageData(0,0,width,height).data,width,height),[1,3,height,width]);
      let output;
      try {output=await session.run({[session.inputNames[0]]:tensor});} finally {tensor.dispose();}
      const matte=output[session.outputNames[0]],dims=matte.dims,result=Float32Array.from(matte.data);
      for(const value of Object.values(output))value.dispose();
      const outWidth=dims.at(-1),outHeight=dims.at(-2);
      if(mirrored)for(let y=0;y<outHeight;y++)for(let x=0;x<outWidth/2;x++){
        const a=y*outWidth+x,b=y*outWidth+outWidth-1-x,t=result[a];result[a]=result[b];result[b]=t;
      }
      return {data:result,width:outWidth,height:outHeight};
    };
    const primary=await infer(false);
    progress('Повторно проверяем волосы и края одежды…');
    const mirrored=await infer(true);
    if(primary.width!==mirrored.width||primary.height!==mirrored.height)throw new Error('Не удалось сопоставить проходы удаления фона.');
    const matteWidth=primary.width,matteHeight=primary.height,consensus=new Float32Array(primary.data.length);
    for(let i=0;i<consensus.length;i++)consensus[i]=primary.data[i]*.62+mirrored.data[i]*.38;
    progress('Проверяем цельность лица, шеи и одежды…');
    const alpha=cleanPortraitAlpha(consensus,matteWidth,matteHeight);
    self.postMessage({...classes,matte:{alpha,width:matteWidth,height:matteHeight},engine:'modnet',analysisMs:performance.now()-began},[classes.data.buffer,alpha.buffer]);
  } catch(error){self.postMessage({error:error.message||'Не удалось отделить фон.'});}
  finally {if(!message?.warmup)bitmap.close();}
};
