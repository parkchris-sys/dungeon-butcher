/**
 * 생성 영상에서 뽑은 프레임 → 게임 애니메이션 클립 PNG로 변환.
 *   1) ffmpeg로 먼저 프레임을 뽑아둔다:  ffmpeg -i <영상> -vf fps=12 <폴더>/f_%03d.png
 *   2) 아래 SRC 표에 폴더·접두사·배경종류·클립키·쓸 프레임 번호를 적고 실행:  node tools/video_to_clips.js
 *   3) 생성된 PNG에 meta 만들기:  node tools/make_meta.js game/assets/resources/chars/*.png
 *
 * 겪었던 함정들(그래서 이 코드가 이렇게 생겼다):
 *  - 생성 영상에는 **위아래 검은 레터박스**가 있다. 안 자르면 누끼가 통째로 실패한다.
 *  - **흰 배경은 다리 사이처럼 막힌 영역이 안 뚫린다**(가장자리 flood fill이 닿지 못함). 마젠타 배경을 쓰면 색으로 판정해 해결.
 *  - 영상의 마젠타는 **순수 #FF00FF가 아니다**. 배경색을 실측해 기준으로 삼지 않으면 배경이 "반투명 그림자"로 남는다.
 *  - 압축 노이즈로 잡티가 생긴다. 행/열 픽셀수로 거르면 **가는 다리가 잘리므로**, 가장 큰 연결 덩어리만 남긴다.
 *  - 클립이 여러 개면 **같은 배율·같은 캔버스**여야 한다. 애니메이터가 첫 프레임 비율로 표시 크기를 잡아서, 다르면 전환 때 튄다.
 *  - 기본 클립은 **오른쪽 보기**로 저장한다(엔진이 왼쪽 이동 시 자동 반전).
 *
 * 필요 패키지: jimp
 */
const Jimp = require('jimp');
const path = require('path');
const OUT = path.join(__dirname, '..', 'game', 'assets', 'resources', 'chars') + '/';
const TARGET_H = 256;
const pad = n => String(n).padStart(3, '0');

const SRC = [
  // 걷기 재촬영본(마젠타 배경) — 흰 배경 원본은 다리 사이 흰색이 안 빠졌다(가장자리 flood fill이 닿지 못하는 막힌 영역).
  // 마젠타는 색으로 판정하므로 막힌 영역도 자동으로 뚫린다.
  { dir: 'C:/Users/Chris/AppData/Local/Temp/walk2/', pre: 'w_', mode: 'magenta', key: 'chicken_walk', frames: [14, 16, 18, 20, 22, 24] },
  // 원본은 왼쪽을 보고 시작 → 전부 좌우반전해 저장(기본 클립 = 오른쪽 보기).
  // 그래서 원본 "좌→우" 턴은 저장본에서 "우→좌"(왼쪽 보기로 끝남)가 된다.
  { dir: 'C:/Users/Chris/AppData/Local/Temp/turn/', pre: 't_', mode: 'magenta', key: 'chicken_turn_l', frames: [18, 19, 20, 21, 22, 23] },
  { dir: 'C:/Users/Chris/AppData/Local/Temp/turn/', pre: 't_', mode: 'magenta', key: 'chicken_turn_r', frames: [42, 43, 44, 45, 46, 47] },
];

/** 위아래 검은 레터박스 제거 */
function cropLetterbox(im) {
  const { width: W, height: H, data: d } = im.bitmap;
  // 경계가 안티에일리어싱으로 흐려져 있으므로 "어두운 줄"(<60)까지 잘라낸다 — 남으면 bbox가 프레임 전체가 된다
  const black = y => { const i = (y * W + 2) * 4; return d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60; };
  let t = 0, b = H - 1;
  while (t < H && black(t)) t++;
  while (b > t && black(b)) b--;
  return im.crop(0, t, W, b - t + 1);
}

/** 흰 배경 — 가장자리에서 flood fill (밝은 부위가 배경과 붙어있지 않아야 안전) */
function keyWhite(im, tol) {
  const { width: W, height: H, data: d } = im.bitmap, at = (x, y) => (y * W + x) * 4;
  const near = i => { const r = 255 - d[i], g = 255 - d[i + 1], b = 255 - d[i + 2]; return r * r + g * g + b * b < tol * tol; };
  const m = new Uint8Array(W * H), q = [];
  const push = (x, y) => { const p = y * W + x; if (!m[p] && near(at(x, y))) { m[p] = 1; q.push(p); } };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  for (let h = 0; h < q.length; h++) {
    const p = q[h], x = p % W, y = (p / W) | 0;
    if (x > 0) push(x - 1, y); if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1); if (y < H - 1) push(x, y + 1);
  }
  for (let p = 0; p < W * H; p++) if (m[p]) d[p * 4 + 3] = 0;
  return im;
}

/** 마젠타 배경 — 색으로 판정하므로 밝은 몸통으로 새지 않는다. 그림자는 검정 반투명으로 복원 */
function keyMagenta(im) {
  const { width: W, data: d } = im.bitmap;
  // 배경 마젠타가 항상 #FF00FF는 아니다(영상은 어두운 자주색일 수 있음).
  // 실제 배경색을 가장자리에서 실측해 기준으로 삼지 않으면, 배경이 "반투명 그림자"로 오인돼 남는다.
  const bgi = (Math.floor(im.bitmap.height / 2) * W + 2) * 4;
  const REF = Math.max(1, d[bgi] + d[bgi + 2]);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.abs(r - b) < 70 && (r - g) > 40 && (b - g) > 40) {
      const s = Math.min(1, (r + b) / REF);
      // 배경과 거의 같은 밝기(비네팅 포함)는 완전 투명. 뚜렷하게 어두운 것만 그림자로 남긴다
      const a = s > 0.85 ? 0 : Math.round(255 * (1 - s));
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = a < 10 ? 0 : a;
      continue;
    }
    const spill = Math.min(r, b) - g;
    if (spill > 6) {
      d[i] = r - spill; d[i + 2] = b - spill;
      d[i + 3] = Math.round(d[i + 3] * Math.max(0, 1 - spill / 90));
    }
  }
  return im;
}

/**
 * 가장 큰 덩어리(= 닭)만 남기고 나머지는 지운다.
 * 행/열 픽셀수 임계값으로 잡티를 거르면 **가는 다리가 같이 잘린다** — 다리 행은 픽셀이 20~40개뿐이라
 * 압축 노이즈 행(30여 개)과 구분이 안 되기 때문. 연결 요소로 거르면 다리를 지키면서 잡티만 사라진다.
 */
function keepLargest(im) {
  const { width: W, height: H, data: d } = im.bitmap;
  const lab = new Int32Array(W * H).fill(-1);
  let best = -1, bestN = 0;
  const stack = [];
  for (let p0 = 0; p0 < W * H; p0++) {
    if (lab[p0] !== -1 || d[p0 * 4 + 3] <= 24) continue;
    const id = p0; let n = 0;
    lab[p0] = id; stack.push(p0);
    while (stack.length) {
      const q = stack.pop(), qx = q % W, qy = (q / W) | 0; n++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (lab[np] === -1 && d[np * 4 + 3] > 24) { lab[np] = id; stack.push(np); }
      }
    }
    if (n > bestN) { bestN = n; best = id; }
  }
  for (let p = 0; p < W * H; p++) if (lab[p] !== best) d[p * 4 + 3] = 0;
  return im;
}

/** 불투명 영역의 bbox (keepLargest 이후라 임계값 없이 안전) */
function bbox(im) {
  const { width: W, height: H, data: d } = im.bitmap;
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 24) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

(async () => {
  for (const g of SRC) {
    g.ims = [];
    let U = null;
    for (const n of g.frames) {
      const raw = cropLetterbox(await Jimp.read(g.dir + g.pre + pad(n) + '.png'));
      const im = keepLargest(g.mode === 'magenta' ? keyMagenta(raw) : keyWhite(raw, 45));
      const b = bbox(im);
      g.ims.push(im);
      U = U ? { x0: Math.min(U.x0, b.x0), x1: Math.max(U.x1, b.x1), y0: Math.min(U.y0, b.y0), y1: Math.max(U.y1, b.y1) } : b;
    }
    g.U = { ...U, w: U.x1 - U.x0 + 1, h: U.y1 - U.y0 + 1 };
    console.log(g.key, 'union bbox', g.U.w + 'x' + g.U.h);
  }

  // 모든 클립 공통 배율·공통 캔버스 — 클립이 바뀔 때 크기·위치가 튀지 않게
  const s = TARGET_H / Math.max(...SRC.map(g => g.U.h));
  const CW = Math.ceil(Math.max(...SRC.map(g => g.U.w)) * s);
  const CH = Math.ceil(Math.max(...SRC.map(g => g.U.h)) * s);
  console.log(`공통 배율 ${s.toFixed(3)} · 공통 캔버스 ${CW}x${CH}`);

  for (const g of SRC) {
    for (let i = 0; i < g.ims.length; i++) {
      const im = g.ims[i].crop(g.U.x0, g.U.y0, g.U.w, g.U.h)
        .resize(Math.round(g.U.w * s), Math.round(g.U.h * s))
        .flip(true, false); // 기본 클립 = 오른쪽 보기 (엔진이 왼쪽 이동 시 자동 반전)
      const canvas = new Jimp(CW, CH, 0x00000000);
      canvas.composite(im, Math.round((CW - im.bitmap.width) / 2), CH - im.bitmap.height);
      await canvas.writeAsync(`${OUT}${g.key}_${i + 1}.png`);
    }
    console.log('  저장', g.key + `_1~${g.ims.length}`);
  }
})();
