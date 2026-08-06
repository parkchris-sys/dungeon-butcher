/**
 * 기존 바닥(floor) 이미지를 새 그림으로 교체하는 도구.
 *   node tools/replace_floor.js <원본이미지> <대상이름>
 *   예: node tools/replace_floor.js ~/Downloads/village.png 1_village_floor
 *
 * make_floor.js와 다른 점:
 *  - **윗면(상판)만** 정확히 1024x512(2:1)이 되게 맞춘다 — 아래 슬래브(옆면 두께)는 별도로 인식
 *  - 엔진이 바닥 이미지를 **구역 중심 기준**으로 배치하므로, 위쪽에 슬래브만큼 투명 패딩을 넣어
 *    **윗면이 캔버스 정중앙**에 오게 한다 → floorOffY 보정 없이 타일 격자와 맞는다
 *  - 기존 .meta의 **uuid를 유지**하고 크기만 갱신 → 맵/씬의 기존 참조가 깨지지 않는다
 *
 * 필요 패키지: jimp (npm i jimp)
 */
const Jimp=require('jimp'), fs=require('fs'), path=require('path');
const FL='C:/Users/Chris/billionaire-game/dungeon-butcher/game/assets/resources/maps/floors';
const TW=1024, TH=512; // 윗면(상판) 목표 — 2:1 아이소
(async()=>{
const [src,target]=process.argv.slice(2);
const im=await Jimp.read(src);
const {width:W,height:H,data:d}=im.bitmap;
const A=(x,y)=>d[(y*W+x)*4+3];
let x0=W,x1=-1,y0=H,y1=-1;
for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(A(x,y)>8){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
const bw=x1-x0+1, bh=y1-y0+1;
let wy=y0,wmax=0;
for(let y=y0;y<=y1;y++){let l=-1,r=-1;for(let x=x0;x<=x1;x++) if(A(x,y)>8){if(l<0)l=x;r=x;} if(r-l>wmax){wmax=r-l;wy=y;}}
const faceH=(wy-y0)*2;              // 윗면 높이(상단꼭짓점~좌우꼭짓점 대칭)
const slab=Math.max(0,(y1-y0+1)-faceH); // 아래 슬래브(옆면) 두께
im.crop(x0,y0,bw,bh);
const sy=TH/faceH, outH=Math.round(bh*sy), slabS=Math.max(0,outH-TH);
im.resize(TW,outH);                  // 윗면이 정확히 1024x512가 되도록
// 윗면을 캔버스 정중앙에 두기 위해 위쪽에 슬래브만큼 투명 패딩 (엔진이 중심 기준 배치)
const canvasH=TH+slabS*2;
const out=new Jimp(TW,canvasH,0x00000000);
out.composite(im,0,slabS);
const file=path.join(FL,target+'.png');
await out.writeAsync(file);
// 기존 .meta의 uuid 유지 + 크기만 갱신 (참조 깨짐 방지)
const mp=file+'.meta';
const m=JSON.parse(fs.readFileSync(mp,'utf8'));
for(const k of Object.keys(m.subMetas)){
  const sm=m.subMetas[k];
  if(sm.importer!=='sprite-frame') continue;
  const u=sm.userData, hw=TW/2, hh=canvasH/2;
  Object.assign(u,{width:TW,height:canvasH,rawWidth:TW,rawHeight:canvasH});
  u.vertices={rawPosition:[-hw,-hh,0,hw,-hh,0,-hw,hh,0,hw,hh,0],indexes:[0,1,2,2,1,3],
    uv:[0,canvasH,TW,canvasH,0,0,TW,0],nuv:[0,0,1,0,0,1,1,1],minPos:[-hw,-hh,0],maxPos:[hw,hh,0]};
}
fs.writeFileSync(mp, JSON.stringify(m,null,2));
console.log(`${target}: 원본 내용 ${bw}x${bh} (윗면 ${wmax}x${faceH}, 슬래브 ${slab})`);
console.log(`  → 출력 ${TW}x${canvasH} — 윗면 ${TW}x${TH} 정중앙, 슬래브 ${slabS}px, uuid 유지`);
})();
