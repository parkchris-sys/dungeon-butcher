/**
 * 그림을 "진짜 픽셀아트"로 변환한다.
 *   node tools/pixelize.js <입력png> <출력png> [높이] [색수]
 *   예: node tools/pixelize.js in.png out.png 128 24
 *
 * AI 생성물은 픽셀처럼 보여도 실제로는 흐릿하고 픽셀 격자가 안 맞는다.
 * 여기서는 ① 목표 높이로 축소(면적 평균) ② 색을 N개로 줄여 평평한 색 덩어리로 만들고
 * ③ 최근접 확대로 픽셀을 또렷하게 만든다. 알파는 임계값으로 딱 끊어 반투명 가장자리를 없앤다.
 *
 * 필요 패키지: jimp
 */
const Jimp = require('jimp');

/** 자주 쓰는 색부터 N개 뽑아 팔레트 구성 (색 수를 줄여 픽셀아트 느낌을 만든다) */
function buildPalette(data, n) {
  const bucket = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    // 5비트로 뭉쳐서 비슷한 색을 한 칸으로 (너무 잘게 세면 팔레트가 안 모인다)
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    const e = bucket.get(k);
    if (e) { e.n++; e.r += data[i]; e.g += data[i + 1]; e.b += data[i + 2]; }
    else bucket.set(k, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
  }
  return [...bucket.values()]
    .sort((a, b) => b.n - a.n).slice(0, n)
    .map(e => [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)]);
}

function nearest(pal, r, g, b) {
  let best = pal[0], bd = Infinity;
  for (const c of pal) {
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

(async () => {
  const [src, out, hArg, cArg] = process.argv.slice(2);
  const H = parseInt(hArg || '128', 10);
  const COLORS = parseInt(cArg || '24', 10);

  const im = await Jimp.read(src);
  // 투명 여백 제거 후 목표 높이로 축소
  const { width: W0, height: H0, data: d0 } = im.bitmap;
  let x0 = W0, x1 = -1, y0 = H0, y1 = -1;
  for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) if (d0[(y * W0 + x) * 4 + 3] > 24) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 > 0) im.crop(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  im.resize(Jimp.AUTO, H, Jimp.RESIZE_BILINEAR); // 축소는 평균이 자연스럽다

  const d = im.bitmap.data;
  const pal = buildPalette(d, COLORS);
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i + 3] < 128 ? 0 : 255;          // 반투명 가장자리 제거 — 픽셀아트는 알파가 0/1
    if (d[i + 3] === 0) continue;
    const c = nearest(pal, d[i], d[i + 1], d[i + 2]);
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
  }
  await im.writeAsync(out);
  console.log(`${out}  ${im.bitmap.width}x${im.bitmap.height}  색 ${pal.length}개`);
})();
