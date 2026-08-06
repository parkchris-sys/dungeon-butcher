/**
 * 마젠타 배경 오브젝트 시트를 낱개 PNG로 잘라 넣는 도구.
 *   node tools/slice_sheet.js <시트이미지> <시작ID> <이름1,이름2,...>
 *   예: node tools/slice_sheet.js ~/Downloads/objs.png 11 rocks_large,rocks_medium,...
 *
 * 하는 일:
 *  1) 마젠타(#FF00FF 계열) 배경을 투명 처리 — 경계 반투명 픽셀의 마젠타 색 번짐(fringe)도 제거
 *  2) 남은 픽셀을 덩어리(연결 요소)로 묶어 오브젝트 개수만큼 분리 — 작은 티끌은 무시
 *  3) 읽는 순서(위→아래, 왼→오른쪽)로 정렬해 이름 목록과 1:1 매칭
 *  4) 각각 여백 2px로 크롭 → resources/maps/objs/{ID}_{이름}.png + .meta(sprite-frame) 생성
 *
 * 그림자는 오브젝트의 일부로 보고 함께 남긴다 (마젠타가 아니므로 자동 보존).
 * 필요 패키지: jimp (npm i jimp)
 */
const Jimp = require('jimp');
const fs = require('fs'), path = require('path');

const OUT = path.join(__dirname, '..', 'game', 'assets', 'resources', 'maps', 'objs');
const PAD = 2;          // 잘라낼 때 남길 여백(px)
const MIN_PIXELS = 400; // 이보다 작은 덩어리는 티끌로 보고 버림

/**
 * 마젠타 "계열"인가 — 빨강≈파랑이고 초록만 크게 낮은 픽셀.
 * 배경(255,0,255)뿐 아니라 그 위에 그려진 그림자(마젠타가 어두워진 색)까지 포함한다.
 */
function isMagentaFamily(r, g, b) {
  return Math.abs(r - b) < 45 && (r - g) > 45 && (b - g) > 45;
}

function writeMeta(file, W, H, name) {
  const u = require('crypto').randomUUID();
  const tex = 'a' + Math.random().toString(16).slice(2, 6), spr = 'b' + Math.random().toString(16).slice(2, 6);
  const hw = W / 2, hh = H / 2;
  const meta = {
    ver: "1.0.27", importer: "image", imported: true, uuid: u, files: [".json", ".png"],
    subMetas: {
      [tex]: {
        importer: "texture", uuid: `${u}@${tex}`, displayName: name, id: tex, name: "texture",
        userData: { wrapModeS: "clamp-to-edge", wrapModeT: "clamp-to-edge", imageUuidOrDatabaseUri: u, isUuid: true, visible: false, minfilter: "linear", magfilter: "linear", mipfilter: "none", anisotropy: 0 },
        ver: "1.0.22", imported: true, files: [".json"], subMetas: {}
      },
      [spr]: {
        importer: "sprite-frame", uuid: `${u}@${spr}`, displayName: name, id: spr, name: "spriteFrame",
        userData: {
          trimThreshold: 1, rotated: false, offsetX: 0, offsetY: 0, trimX: 0, trimY: 0,
          width: W, height: H, rawWidth: W, rawHeight: H,
          borderTop: 0, borderBottom: 0, borderLeft: 0, borderRight: 0,
          packable: true, pixelsToUnit: 100, pivotX: 0.5, pivotY: 0.5, meshType: 0,
          vertices: { rawPosition: [-hw, -hh, 0, hw, -hh, 0, -hw, hh, 0, hw, hh, 0], indexes: [0, 1, 2, 2, 1, 3], uv: [0, H, W, H, 0, 0, W, 0], nuv: [0, 0, 1, 0, 0, 1, 1, 1], minPos: [-hw, -hh, 0], maxPos: [hw, hh, 0] },
          isUuid: true, imageUuidOrDatabaseUri: `${u}@${tex}`, atlasUuid: "", trimType: "auto"
        },
        ver: "1.0.12", imported: true, files: [".json"], subMetas: {}
      }
    },
    userData: { type: "sprite-frame", fixAlphaTransparencyArtifacts: false, hasAlpha: true, redirect: `${u}@${tex}` }
  };
  fs.writeFileSync(file + '.meta', JSON.stringify(meta, null, 2));
}

(async () => {
  const [src, startIdRaw, namesRaw] = process.argv.slice(2);
  const startId = parseInt(startIdRaw, 10);
  const names = namesRaw.split(',').map(s => s.trim()).filter(Boolean);

  const im = await Jimp.read(src);
  const { width: W, height: H, data: d } = im.bitmap;

  // 1) 마젠타 제거 — 배경은 완전 투명, 그림자는 "중성 검정 + 반투명"으로 복원
  //    그림자는 마젠타가 어두워진 색(예: 128,0,128)이라 그냥 두면 보라 얼룩으로 남는다.
  //    어두워진 비율 s로부터 알파(1-s)를 되돌리고 색은 검정으로 바꾼다.
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (isMagentaFamily(r, g, b)) {
      const s = Math.min(1, (r + b) / 510);       // 1=순수 배경, 낮을수록 짙은 그림자
      const a = Math.round(255 * (1 - s));
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0;
      d[i + 3] = a < 10 ? 0 : a;
      continue;
    }
    // 경계 안티에일리어싱에 섞인 마젠타(spill) 제거.
    // 마젠타는 빨강·파랑만 높으므로, 초록을 넘는 만큼(spill)을 빨강·파랑에서 빼면 중성색이 된다.
    // 갈색(r>g>b)·초록·회색은 spill이 0 이하라 건드리지 않는다.
    const spill = Math.min(r, b) - g;
    if (spill > 6) {
      d[i] = r - spill; d[i + 2] = b - spill;
      d[i + 3] = Math.round(d[i + 3] * Math.max(0, 1 - spill / 90)); // 많이 섞였을수록 더 투명하게
    }
  }

  // 2) 연결 요소(덩어리) 라벨링 — 8방향
  const lab = new Int32Array(W * H).fill(-1);
  const boxes = [];
  const stack = [];
  for (let p = 0; p < W * H; p++) {
    if (lab[p] !== -1 || d[p * 4 + 3] <= 16) continue;
    const id = boxes.length;
    let x0 = W, x1 = -1, y0 = H, y1 = -1, n = 0;
    lab[p] = id; stack.push(p);
    while (stack.length) {
      const q = stack.pop(), qx = q % W, qy = (q / W) | 0;
      n++;
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
      if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (lab[np] === -1 && d[np * 4 + 3] > 16) { lab[np] = id; stack.push(np); }
      }
    }
    boxes.push({ x0, x1, y0, y1, n });
  }

  // 3) 티끌 제거 + 읽는 순서 정렬 (행 우선 — 세로 겹침이 크면 같은 행)
  let objs = boxes.filter(b => b.n >= MIN_PIXELS);
  const rowTol = Math.max(...objs.map(b => b.y1 - b.y0)) * 0.5;
  objs.sort((a, b) => (Math.abs(a.y0 - b.y0) > rowTol ? a.y0 - b.y0 : a.x0 - b.x0));
  console.log(`덩어리 ${boxes.length}개 중 오브젝트 ${objs.length}개 (이름 ${names.length}개)`);
  if (objs.length !== names.length) console.warn('⚠ 개수 불일치 — 이름 매칭을 확인할 것');

  // 4) 개별 저장
  for (let i = 0; i < Math.min(objs.length, names.length); i++) {
    const b = objs[i];
    const cx = Math.max(0, b.x0 - PAD), cy = Math.max(0, b.y0 - PAD);
    const cw = Math.min(W - cx, b.x1 - b.x0 + 1 + PAD * 2), ch = Math.min(H - cy, b.y1 - b.y0 + 1 + PAD * 2);
    const name = `${startId + i}_${names[i]}`;
    const file = path.join(OUT, name + '.png');
    await im.clone().crop(cx, cy, cw, ch).writeAsync(file);
    writeMeta(file, cw, ch, name);
    console.log(`  ${name}.png  ${cw}x${ch}`);
  }
})();
