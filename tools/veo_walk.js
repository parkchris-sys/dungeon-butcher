/**
 * Veo 걷기 영상 → 플레이어 walk 스프라이트 8장.
 *   node tools/veo_walk.js <프레임폴더> <출력폴더> [시작프레임] [주기]
 *
 * 함정 정리 (다음 사람이 또 안 밟게):
 *  1) 영상 마젠타는 #FF00FF가 아니다. 여기선 실측 대신 "색상(hue)"으로 판정한다 —
 *     마젠타 계열(r>g, b>g)이면 배경. 캐릭터 외곽선은 중성 검정이라 b>g가 아니라서 살아남는다.
 *     거리(distance) 기준으로 하면 외곽선이 통째로 날아간다.
 *  2) 바닥 그림자도 "어두운 마젠타"라 같은 규칙으로 함께 지워진다.
 *  3) 위아래 레터박스(검은 띠)는 잘라내되, 경계 몇 줄은 검정↔마젠타 블렌드라 안쪽으로 6px 물러난다.
 *  4) bbox를 프레임마다 따로 잡으면 크기가 튄다. 반드시 전 프레임 "합집합 bbox" 하나로 자른다.
 *  5) 픽셀 밀도를 몬스터(64px급)에 맞춰 낮춘다. 안 그러면 주인공만 정교해서 따로 논다.
 */
const Jimp = require('jimp');
const fs = require('fs'), path = require('path');

const isBG = (r, g, b) => (r - g) > 22 && (b - g) > 12;

/** 가장 큰 연결 성분만 남긴다 (잡티·떨어진 그림자 조각 제거) */
function keepLargest(im) {
  const { width: W, height: H, data: d } = im.bitmap;
  const lab = new Int32Array(W * H).fill(-1), st = [];
  let best = -1, bn = 0;
  for (let s = 0; s < W * H; s++) {
    if (lab[s] !== -1 || d[s * 4 + 3] === 0) continue;
    let n = 0; lab[s] = s; st.push(s);
    while (st.length) {
      const c = st.pop(); n++;
      const x = c % W, y = (c / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (lab[q] !== -1 || d[q * 4 + 3] === 0) continue;
        lab[q] = s; st.push(q);
      }
    }
    if (n > bn) { bn = n; best = s; }
  }
  for (let s = 0; s < W * H; s++) if (lab[s] !== best) d[s * 4 + 3] = 0;
}

/** 검은 레터박스 구간을 찾아 안쪽으로 물러난 [y0,y1] 반환 */
function band(im) {
  const { width: W, height: H, data: d } = im.bitmap;
  const bright = y => { let s = 0; for (let x = 0; x < W; x += 4) { const i = (y * W + x) * 4; s += d[i] + d[i + 1] + d[i + 2]; } return s / (W / 4 * 3); };
  let y0 = 0, y1 = H - 1;
  while (y0 < H && bright(y0) < 60) y0++;
  while (y1 > y0 && bright(y1) < 60) y1--;
  return [y0 + 6, y1 - 6];
}

(async () => {
  const [SRC, OUT, sArg, pArg] = process.argv.slice(2);
  const START = parseInt(sArg || '30', 10), PERIOD = parseInt(pArg || '19', 10), N = 8;
  const H_TARGET = 60; // 64px급 — 코카트리스(56)와 같은 결

  const idx = Array.from({ length: N }, (_, i) => START + Math.round(i * PERIOD / N));
  const ims = [], boxes = [];
  for (const n of idx) {
    const im = await Jimp.read(path.join(SRC, 'f_' + String(n).padStart(3, '0') + '.png'));
    const [by0, by1] = band(im);
    im.crop(0, by0, im.bitmap.width, by1 - by0 + 1);
    const { width: W, height: H, data: d } = im.bitmap;
    for (let i = 0; i < d.length; i += 4) d[i + 3] = isBG(d[i], d[i + 1], d[i + 2]) ? 0 : 255;
    keepLargest(im);
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    ims.push(im); boxes.push([x0, y0, x1, y1]);
  }
  const ux0 = Math.min(...boxes.map(b => b[0])), uy0 = Math.min(...boxes.map(b => b[1]));
  const ux1 = Math.max(...boxes.map(b => b[2])), uy1 = Math.max(...boxes.map(b => b[3]));
  const cw = ux1 - ux0 + 1, ch = uy1 - uy0 + 1;
  const outW = Math.round(cw * H_TARGET / ch);
  fs.mkdirSync(OUT, { recursive: true });
  for (let i = 0; i < N; i++) {
    const im = ims[i];
    im.crop(ux0, uy0, cw, ch);
    im.resize(outW, H_TARGET, Jimp.RESIZE_BILINEAR);
    const d = im.bitmap.data;
    for (let k = 0; k < d.length; k += 4) d[k + 3] = d[k + 3] < 120 ? 0 : 255; // 픽셀아트는 알파 0/1
    await im.writeAsync(path.join(OUT, 'walk_' + (i + 1) + '.png'));
  }
  console.log(`합집합 ${cw}x${ch} → ${outW}x${H_TARGET}, ${N}장`);
})();
