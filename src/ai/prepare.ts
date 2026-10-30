import sharp from 'sharp';
// No libvips cache or file output. One decoder thread; sequential bounded JPEG reads.
sharp.cache(false); sharp.concurrency(1);
export async function prepareImages(images:Buffer[],signal:AbortSignal,nativeCropImages:number[]=[]) {
  const prepared:Buffer[]=[];
  try {
    for(const [index,bytes] of images.entries()){signal.throwIfAborted();
      if(nativeCropImages.includes(index+1)){
        const m=await sharp(bytes,{limitInputPixels:10_000_000}).metadata();
        if(m.format!=='jpeg')throw new Error('Native crop must be JPEG');
        prepared.push(bytes);continue;
      }
      // Preserve aspect ratio and all spatial context. Original NVR bytes/hashes remain unchanged.
      prepared.push(await sharp(bytes,{limitInputPixels:10_000_000,sequentialRead:true}).resize({width:1024,height:768,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer());
    }
    signal.throwIfAborted();return prepared;
  } catch(error){prepared.length=0;throw error;}
}
