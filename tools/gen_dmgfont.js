// 데미지용 이미지 폰트 생성 — **픽셀아트판** (재생성 2026-08-07, BIBLE §5 픽셀아트 전환 반영)
//
// 이전 버전은 거리장 + 슈퍼샘플링으로 매끈한(안티에일리어싱) 글리프를 뽑았는데,
// 아트 방향이 픽셀아트로 확정되면서 톤이 어긋나 **하드 픽셀**로 다시 만들었다.
//
// 방식: 숫자를 **5×7 비트맵**으로 직접 찍고 오른쪽 아래로 **1px 드롭섀도**만 둔다.
//  - 사방 외곽선을 두르면 5×7에서는 밝은 면이 다 먹혀 어두워진다 → 그림자만으로 입체감
//  - 캔버스 6×8 → 표시 높이 40px = **정확히 5배** (정수 배율이라 픽셀 크기가 균일하다)
//  - 안티에일리어싱 없음 (알파는 0 또는 255) — nearest 필터와 함께 픽셀이 또렷하게 보인다
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT_DIR = 'C:/workspace/DungeonButcher/dungeon-butcher/game/assets/resources/fonts';

// ── 규격 ── (표시 40px = 5배. 바꾸면 IngameBootstrap.DMG_PX도 8의 배수로 맞출 것)
const GW = 5, GH = 7;           // 숫자 본체 픽셀 크기
const CANVAS_W = 6, CANVAS_H = 8; // 드롭섀도 1px 여유 포함
const OX = 0, OY = 0;           // 본체 위치 (그림자가 오른쪽 아래로 나가므로 원점)

// 팔레트 (임의 — 어두운 던전 바닥에서도 읽히게 밝은 붉은 2톤 + 진한 그림자)
const C_FACE_HI = [255, 176, 130]; // 윗부분 (밝게)
const C_FACE_LO = [232, 52, 43];   // 아랫부분
const C_SHADE = [74, 16, 8];       // 1px 드롭섀도 (오른쪽 아래)

/** 5×7 숫자 비트맵 — '#'=칠함 */
const GLYPHS = {
    '0': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '#####'],
    '2': ['.###.', '#...#', '....#', '..##.', '.#...', '#....', '#####'],
    '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
    '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    '7': ['#####', '....#', '...#.', '..#..', '..#..', '..#..', '..#..'],
    '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};

function renderGlyph(rows) {
    const face = new Set(), shade = new Set();
    const key = (x, y) => `${x},${y}`;
    for (let gy = 0; gy < GH; gy++) {
        for (let gx = 0; gx < GW; gx++) {
            if (rows[gy][gx] !== '#') continue;
            face.add(key(OX + gx, OY + gy));
        }
    }
    // 드롭섀도: 본체를 오른쪽 아래로 1px 밀어 본체가 아닌 칸
    for (const k of face) {
        const [x, y] = k.split(',').map(Number);
        const s2 = key(x + 1, y + 1);
        if (!face.has(s2)) shade.add(s2);
    }

    const buf = Buffer.alloc(CANVAS_W * CANVAS_H * 4);
    const put = (x, y, c) => {
        if (x < 0 || y < 0 || x >= CANVAS_W || y >= CANVAS_H) return;
        const i = (y * CANVAS_W + x) * 4;
        buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
    };
    for (const k of shade) { const [x, y] = k.split(',').map(Number); put(x, y, C_SHADE); }
    for (const k of face) {
        const [x, y] = k.split(',').map(Number);
        put(x, y, y - OY < 2 ? C_FACE_HI : C_FACE_LO); // 위 2줄만 밝게 (붉은 정체성 유지)
    }
    return { w: CANVAS_W, h: CANVAS_H, data: buf };
}

// ── PNG 인코드 ──
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const tb = Buffer.from(t); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tb, d]))); return Buffer.concat([l, tb, d, cr]); };
function encodePng(w, h, rgba) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
    const raw = Buffer.alloc(h * (1 + w * 4));
    for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4); }
    return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const uuid4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
for (const ch of Object.keys(GLYPHS)) {
    const name = `dmg_${ch}`;
    const img = renderGlyph(GLYPHS[ch]);
    fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), encodePng(img.w, img.h, img.data));
    const metaPath = path.join(OUT_DIR, `${name}.png.meta`);
    if (!fs.existsSync(metaPath)) { // uuid 보존 — 이미 있으면 건드리지 않는다
        fs.writeFileSync(metaPath, JSON.stringify({
            ver: '1.0.27', importer: 'image', imported: false, uuid: uuid4(),
            files: [], subMetas: {}, userData: { type: 'sprite-frame' },
        }, null, 2));
    }
    console.log(`${name}.png (${img.w}x${img.h})`);
}
console.log('완료 — 표시 40px = 5배 정수 배율,', OUT_DIR);
