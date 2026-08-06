/**
 * 바닥(floor) 이미지를 게임 폴더에 넣는 도구 — 배경 종류 상관없이 처리.
 *   node tools/place_floor.js <원본이미지> <대상이름> [배경제거 허용오차]
 *   예: node tools/place_floor.js ~/Downloads/dungeon.png 2_dungeon_floor 24
 *
 * 하는 일:
 *  1) 배경이 불투명하면 **가장자리에서 flood fill**로 제거 — 안쪽 어두운 부분(나무 기둥·그림자)은 보존.
 *     허용오차 기본 24. 너무 크면 어두운 구조물이 먹히고, 너무 작으면 배경이 남는다.
 *  2) **최대폭 행 = 윗면(상판)의 좌우 꼭짓점**이고 그 중점이 윗면 중심이라는 성질을 이용해
 *     윗면 폭이 1024px(=2:1 아이소)이 되도록 균등 스케일.
 *  3) 엔진이 바닥을 **구역 중심 기준**으로 배치하므로, **윗면 중심이 캔버스 정중앙**에 오도록 패딩.
 *     → 벽·슬래브가 위아래로 튀어나와도 floorOffY 보정 없이 타일 격자와 맞는다.
 *  4) 기존 .meta의 **uuid 유지**, 크기만 갱신 → 기존 참조가 깨지지 않는다.
 *
 * 필요 패키지: jimp (npm i jimp)
 */
const Jimp=require('jimp'), fs=require('fs'), path=require('path');
const FL='C:/Users/Chris/billionaire-game/dungeon-butcher/game/assets/resources/maps/floors';
const TW=1024;
const TOL=Number(process.argv[4]||24); // 윗면 폭 목표 (2:1 → 높이 512)
(async()=>{
const [src,target]=process.argv.slice(2);
const im=await Jimp.read(src);
const {width:W,height:H,data:d}=im.bitmap;
const at=(x,y)=>(y*W+x)*4;
// 1) 배경 제거 — 가장자리에서 flood fill (안쪽 어두운 부분은 보존)
let hasA=false; for(let i=3;i<d.length;i+=4) if(d[i]<250){hasA=true;break;}
if(!hasA){
  const bg=[d[0],d[1],d[2]];
  const near=(i)=>{const dr=d[i]-bg[0],dg=d[i+1]-bg[1],db=d[i+2]-bg[2];return dr*dr+dg*dg+db*db < TOL*TOL;};
  const isBg=new Uint8Array(W*H); const q=[];
  const push=(x,y)=>{const p=y*W+x; if(!isBg[p]&&near(at(x,y))){isBg[p]=1;q.push(p);} };
  for(let x=0;x<W;x++){push(x,0);push(x,H-1);} for(let y=0;y<H;y++){push(0,y);push(W-1,y);}
  for(let h=0;h<q.length;h++){const p=q[h],x=p%W,y=(p/W)|0;
    if(x>0)push(x-1,y); if(x<W-1)push(x+1,y); if(y>0)push(x,y-1); if(y<H-1)push(x,y+1);}
  for(let p=0;p<W*H;p++) if(isBg[p]) d[p*4+3]=0;
  console.log('배경 제거: flood fill', (100*isBg.reduce((a,b)=>a+b,0)/(W*H)).toFixed(1)+'%');
}
const A=(x,y)=>d[at(x,y)+3];
// 2) 내용 bbox + 최대폭 행(= 윗면의 좌우 꼭짓점, 그 중점이 윗면 중심)
let x0=W,x1=-1,y0=H,y1=-1;
for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(A(x,y)>24){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
let wy=y0,wmax=0,wl=0;
for(let y=y0;y<=y1;y++){let l=-1,r=-1;for(let x=x0;x<=x1;x++) if(A(x,y)>24){if(l<0)l=x;r=x;} if(r-l>wmax){wmax=r-l;wy=y;wl=l;}}
const cx=wl+wmax/2; // 윗면 중심 x
// 3) 균등 스케일 (윗면 폭 → 1024). 아이소 2:1 전제
const s=TW/wmax;
im.crop(x0,y0,x1-x0+1,y1-y0+1);
const nw=Math.max(1,Math.round((x1-x0+1)*s)), nh=Math.max(1,Math.round((y1-y0+1)*s));
im.resize(nw,nh);
// 4) 윗면 중심이 캔버스 정중앙에 오도록 패딩 (엔진은 구역 중심 기준 배치)
const ccx=(cx-x0)*s, ccy=(wy-y0)*s;
const padL=Math.max(0,nw-2*ccx), padR=Math.max(0,2*ccx-nw);
const padT=Math.max(0,nh-2*ccy), padB=Math.max(0,2*ccy-nh);
const CW=Math.round(nw+padL+padR), CH=Math.round(nh+padT+padB);
const out=new Jimp(CW,CH,0x00000000);
out.composite(im,Math.round(padL),Math.round(padT));
const file=path.join(FL,target+'.png');
await out.writeAsync(file);
// 5) meta — 기존 uuid 유지, 크기만 갱신
const mp=file+'.meta';
if(fs.existsSync(mp)){
  const m=JSON.parse(fs.readFileSync(mp,'utf8'));
  for(const k of Object.keys(m.subMetas)){const sm=m.subMetas[k]; if(sm.importer!=='sprite-frame')continue;
    const u=sm.userData,hw=CW/2,hh=CH/2;
    Object.assign(u,{width:CW,height:CH,rawWidth:CW,rawHeight:CH});
    u.vertices={rawPosition:[-hw,-hh,0,hw,-hh,0,-hw,hh,0,hw,hh,0],indexes:[0,1,2,2,1,3],
      uv:[0,CH,CW,CH,0,0,CW,0],nuv:[0,0,1,0,0,1,1,1],minPos:[-hw,-hh,0],maxPos:[hw,hh,0]};}
  fs.writeFileSync(mp,JSON.stringify(m,null,2));
}
console.log(`${target}: 윗면 폭 ${wmax}px → ${TW}px (배율 ${s.toFixed(3)})`);
console.log(`  출력 ${CW}x${CH} — 윗면 중심이 캔버스 정중앙 (위 패딩 ${Math.round(padT)}, 아래 ${Math.round(padB)})`);
})();
