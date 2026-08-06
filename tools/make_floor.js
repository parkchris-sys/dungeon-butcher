/**
 * 바닥(floor) 이미지를 게임 규격으로 변환해 넣는 도구.
 *   node tools/make_floor.js <원본이미지> <출력이름>
 *   예: node tools/make_floor.js ~/Downloads/field.png 5_field_dungeon
 *
 * 하는 일:
 *  1) 알파 기준으로 내용 영역만 잘라냄 (투명 여백 제거)
 *  2) 1024x512 = 2:1 아이소 다이아몬드로 정규화 — 게임 타일(128x64)이 2:1이라 이 비율이어야 격자와 맞음
 *  3) Cocos용 .meta 생성 (type=sprite-frame — 없으면 게임에서 로드 실패)
 *
 * 마젠타 배경 원본이면 먼저 투명 처리 후 사용할 것 (현재는 투명 PNG 전제).
 * 필요 패키지: jimp (npm i jimp)
 */
const Jimp = require('jimp');
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const OUT='C:/Users/Chris/billionaire-game/dungeon-butcher/game/assets/resources/maps/floors';
const W=1024,H=512;
(async()=>{
const src=process.argv[2], name=process.argv[3];
const im=await Jimp.read(src);
const {width:IW,height:IH,data:d}=im.bitmap;
const A=(x,y)=>d[(y*IW+x)*4+3];
// 알파 기준 내용 bbox
let x0=IW,x1=-1,y0=IH,y1=-1;
for(let y=0;y<IH;y++)for(let x=0;x<IW;x++) if(A(x,y)>8){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
im.crop(x0,y0,x1-x0+1,y1-y0+1);
// 2:1 아이소 다이아로 정규화 (비균등 리사이즈)
im.resize(W,H);
const out=path.join(OUT,name+'.png');
await im.writeAsync(out);
// .meta 생성 (sprite-frame — 없으면 게임에서 로드 실패)
const u=crypto.randomUUID();
const tex=Math.random().toString(16).slice(2,7), spr=Math.random().toString(16).slice(2,7);
const hw=W/2, hh=H/2;
const meta={ver:"1.0.27",importer:"image",imported:true,uuid:u,files:[".json",".png"],subMetas:{
 [tex]:{importer:"texture",uuid:`${u}@${tex}`,displayName:name,id:tex,name:"texture",userData:{wrapModeS:"clamp-to-edge",wrapModeT:"clamp-to-edge",imageUuidOrDatabaseUri:u,isUuid:true,visible:false,minfilter:"linear",magfilter:"linear",mipfilter:"none",anisotropy:0},ver:"1.0.22",imported:true,files:[".json"],subMetas:{}},
 [spr]:{importer:"sprite-frame",uuid:`${u}@${spr}`,displayName:name,id:spr,name:"spriteFrame",userData:{trimThreshold:1,rotated:false,offsetX:0,offsetY:0,trimX:0,trimY:0,width:W,height:H,rawWidth:W,rawHeight:H,borderTop:0,borderBottom:0,borderLeft:0,borderRight:0,packable:true,pixelsToUnit:100,pivotX:0.5,pivotY:0.5,meshType:0,
  vertices:{rawPosition:[-hw,-hh,0,hw,-hh,0,-hw,hh,0,hw,hh,0],indexes:[0,1,2,2,1,3],uv:[0,H,W,H,0,0,W,0],nuv:[0,0,1,0,0,1,1,1],minPos:[-hw,-hh,0],maxPos:[hw,hh,0]},
  isUuid:true,imageUuidOrDatabaseUri:`${u}@${tex}`,atlasUuid:"",trimType:"auto"},ver:"1.0.12",imported:true,files:[".json"],subMetas:{}}},
 userData:{type:"sprite-frame",fixAlphaTransparencyArtifacts:false,hasAlpha:true,redirect:`${u}@${tex}`}};
fs.writeFileSync(out+'.meta', JSON.stringify(meta,null,2));
console.log('생성:', out);
console.log('원본 내용', (x1-x0+1)+'x'+(y1-y0+1), '→', W+'x'+H, '(2:1 정규화)');
})();
