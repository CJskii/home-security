import sharp from 'sharp';
export interface FrameOptions { variant?: 'focused'|'full'; contextFactor?: number }
export function frameLayout(width:number,height:number,boxes:readonly number[][],options:FrameOptions={}) {
    if (!width||!height||boxes.length<1||boxes.length>8) throw Error('invalid_annotation');
    for(const b of boxes)if(b.length!==4||b.some(v=>!Number.isInteger(v)||v<0||v>10000)||b[0]!>=b[2]!||b[1]!>=b[3]!)throw Error('invalid_annotation');
    const factor=options.contextFactor??1.8;
    if(!Number.isFinite(factor)||factor<1||factor>5)throw Error('invalid_context_factor');
    let left=0,top=0,cropWidth=width,cropHeight=height;
    if(options.variant!=='full'){
        const x0=Math.min(...boxes.map(b=>b[0]!))*width/10000,y0=Math.min(...boxes.map(b=>b[1]!))*height/10000;
        const x1=Math.max(...boxes.map(b=>b[2]!))*width/10000,y1=Math.max(...boxes.map(b=>b[3]!))*height/10000;
        let w=Math.max((x1-x0)*factor,Math.min(320,width)),h=Math.max((y1-y0)*factor,Math.min(180,height));
        w=Math.max(w,h*16/9);h=w*9/16;
        if(w>width){w=width;h=w*9/16;}if(h>height){h=height;w=h*16/9;}
        // If a very broad/tall union cannot fit a 16:9 crop, retain the whole scene.
        if(w>=x1-x0&&h>=y1-y0){cropWidth=Math.min(width,Math.ceil(w));cropHeight=Math.min(height,Math.ceil(h));left=Math.max(0,Math.min(width-cropWidth,Math.round((x0+x1-cropWidth)/2)));top=Math.max(0,Math.min(height-cropHeight,Math.round((y0+y1-cropHeight)/2)));}
    }
    const targetWidth=Math.min(1280,cropWidth*2),targetHeight=Math.round(cropHeight*targetWidth/cropWidth);
    return {left,top,width:cropWidth,height:cropHeight,targetWidth,targetHeight,rectangles:boxes.map(b=>({x:(b[0]!*width/10000-left)*targetWidth/cropWidth,y:(b[1]!*height/10000-top)*targetHeight/cropHeight,width:(b[2]!-b[0]!)*width/10000*targetWidth/cropWidth,height:(b[3]!-b[1]!)*height/10000*targetHeight/cropHeight}))};
}
// Verified originals in, bounded RAM-only derivative out. Rendering never runs in
// the initial webhook path. All boxes belong to this exact source frame.
let active=0;
export async function annotatedFrame(original:Buffer,boxes:number[][],options:FrameOptions={}):Promise<Buffer>{
    if(active>=2)throw Error('annotation_busy');active++;
    try{
        const image=sharp(original,{limitInputPixels:40000000}),{width,height}=await image.metadata();
        const layout=frameLayout(width!,height!,boxes,options);
        const rectangles=layout.rectangles.map(r=>`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="#000" stroke-width="12"/><rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="none" stroke="#ff2020" stroke-width="8"/>`).join('');
        const overlay=Buffer.from(`<svg width="${layout.targetWidth}" height="${layout.targetHeight}" xmlns="http://www.w3.org/2000/svg">${rectangles}</svg>`);
        return await image.extract({left:layout.left,top:layout.top,width:layout.width,height:layout.height}).resize(layout.targetWidth,layout.targetHeight).composite([{input:overlay}]).jpeg({quality:85}).toBuffer();
    }finally{active--;}
}
