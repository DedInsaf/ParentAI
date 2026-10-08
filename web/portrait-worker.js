// Both networks run inside this worker. No photo is sent to a remote service.
self.onmessage=async ({data:bitmap})=>{
  let segmenter,session;
  const began=performance.now(),progress=message=>self.postMessage({progress:true,message});
  try {
    const {FilesetResolver,ImageSegmenter}=await import('./vendor/vision/vision_bundle.mjs');
    const {imageToNchw,cleanPortraitAlpha}=await import('./portrait-matte.mjs');
    const ort=await import('./vendor/matting/ort.wasm.min.mjs');
    progress('Находим лицо, волосы, шею и одежду…');
    const files=await FilesetResolver.forVisionTasks('/vendor/vision/wasm');
    segmenter=await ImageSegmenter.createFromOptions(files,{baseOptions:{modelAssetPath:'/vendor/vision/selfie_multiclass.tflite',delegate:'CPU'},canvas:new OffscreenCanvas(1,1),runningMode:'IMAGE',outputCategoryMask:true,outputConfidenceMasks:false});
    // Copy masks inside the callback: MediaPipe releases them when it returns.
    const classes=await new Promise((resolve,reject)=>{
      try {segmenter.segment(bitmap,result=>{
        const mask=result.categoryMask;
        resolve({data:mask.getAsUint8Array().slice(),width:mask.width,height:mask.height});
      });} catch(error){reject(error);}
    });
    segmenter.close();segmenter=null;
    progress('Аккуратно отделяем волосы и края плеч от фона…');
    // A single WASM thread works on Safari/iOS without SharedArrayBuffer.
    ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
    ort.env.wasm.wasmPaths=new URL('./vendor/matting/',self.location.href).href;
    session=await ort.InferenceSession.create('/vendor/matting/modnet.onnx',{executionProviders:['wasm'],graphOptimizationLevel:'all'});
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
    await session.release();session=null;
    self.postMessage({...classes,matte:{alpha,width:matteWidth,height:matteHeight},engine:'modnet',analysisMs:performance.now()-began},[classes.data.buffer,alpha.buffer]);
  } catch(error){self.postMessage({error:error.message||'Не удалось отделить фон.'});}
  finally {bitmap.close();segmenter?.close();if(session)await session.release();self.close();}
};
