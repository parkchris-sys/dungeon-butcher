/**
 * 검은 외곽선을 "인접 색의 어두운 톤"으로 바꾼다 — 데이브 더 다이버 방식.
 *   node tools/deoutline.js <png경로> [<png경로> ...]
 *
 * 왜 필요한가: 외곽선이 두꺼우면 캐릭터가 배경 위에 얹힌 스티커처럼 보인다.
 * 실측 예 — 우리 붓처는 실루엣 경계의 95%가 검정이었고, 데이브 더 다이버는 0%였다.
 * 실루엣 크기는 그대로 두고 색만 바꾸므로 형태가 줄어들지 않는다.
 */
const Jimp = require('jimp');
const fs = require('fs');
function deOutline(im,{lumMax=62,mul=0.55}={}){
  const{width:W,height:H,data:d}=im.bitmap;
  const lum=i=>0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
  const isOut=new Uint8Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const p=y*W+x,i=p*4;
    if(!d[i+3]||lum(i)>=lumMax)continue;
    // 실루엣 바깥과 닿아 있는 어두운 픽셀 = 외곽선
    let touches=false;
    for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
      const nx=x+dx,ny=y+dy;
      if(nx<0||ny<0||nx>=W||ny>=H||!d[(ny*W+nx)*4+3]){touches=true;break;}}
    if(touches) isOut[p]=1;}
  const src=Buffer.from(d);
  let n=0;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const p=y*W+x;if(!isOut[p])continue;
    // 가장 가까운 '외곽선이 아닌 내부 색' 찾기
    let found=null;
    for(let r=1;r<=4&&!found;r++)
      for(let dy=-r;dy<=r&&!found;dy++)for(let dx=-r;dx<=r&&!found;dx++){
        const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=W||ny>=H)continue;
        const q=ny*W+nx;if(isOut[q]||!src[q*4+3])continue;
        const j=q*4; if(0.299*src[j]+0.587*src[j+1]+0.114*src[j+2]<lumMax)continue;
        found=[src[j],src[j+1],src[j+2]];}
    if(!found)continue;
    const i=p*4;
    d[i]=Math.round(found[0]*mul);d[i+1]=Math.round(found[1]*mul);d[i+2]=Math.round(found[2]*mul);
    n++;}
  return n;
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.log('사용법: node tools/deoutline.js <png> [<png> ...]'); return; }
  for (const f of files) {
    const im = await Jimp.read(f);
    const n = deOutline(im);
    await im.writeAsync(f);
    console.log('  ' + f.split(/[\/]/).pop() + '  외곽선 ' + n + 'px 변환');
  }
})();
