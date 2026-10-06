self.onmessage=async ({data:bitmap})=>{
  let segmenter;
  try {
    const {FilesetResolver,ImageSegmenter}=await import('./vendor/vision/vision_bundle.mjs');
    const files=await FilesetResolver.forVisionTasks('/vendor/vision/wasm');
    // CPU for one photo only. This avoids category-mask GPU bugs on iOS.
    segmenter=await ImageSegmenter.createFromOptions(files,{baseOptions:{modelAssetPath:'/vendor/vision/selfie_multiclass.tflite',delegate:'CPU'},canvas:new OffscreenCanvas(1,1),runningMode:'IMAGE',outputCategoryMask:true,outputConfidenceMasks:false});
    segmenter.segment(bitmap,result=>{
      const mask=result.categoryMask,data=mask.getAsUint8Array().slice();
      self.postMessage({data,width:mask.width,height:mask.height},[data.buffer]);
    });
  } catch(error){self.postMessage({error:error.message});}
  finally {bitmap.close();segmenter?.close();self.close();}
};
