import type { VideoStreamSettings } from '../src/uniview/snapshot-client.js';
export const streamFixture=():VideoStreamSettings=>({Num:4,VideoStreamInfos:[
 {ID:0,MainStreamType:0,Enabled:1,VideoEncodeInfo:{EncodeFormat:2,Resolution:{Width:3840,Height:2160},FrameRate:25,BitRate:8000,BitRateType:0}},
 {ID:1,Enabled:1,VideoEncodeInfo:{EncodeFormat:1,Resolution:{Width:1280,Height:720},FrameRate:5,BitRate:2048,BitRateType:0}},
 {ID:2,Enabled:0,VideoEncodeInfo:{EncodeFormat:2,Resolution:{Width:352,Height:288},FrameRate:25,BitRate:128,BitRateType:1}},
 {ID:0,MainStreamType:1,Enabled:1,VideoEncodeInfo:{EncodeFormat:1,FrameRate:50}},
]});
