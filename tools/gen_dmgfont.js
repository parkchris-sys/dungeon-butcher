// 데미지용 이미지 폰트 생성 — 빨간색·입체감·둥근 획 (요청 2026-08-07)
//
// 방식: 글리프를 **획(폴리라인/호)의 거리장**으로 그린다.
//  - 획 중심선까지의 거리 d 가 R 이하면 채움 → 캡·조인이 자동으로 둥글어진다(둥근 느낌의 근원)
//  - 같은 모양을 아래로 D 만큼 밀어 어두운 면으로 깔면 압출된 입체감이 생긴다
//  - 바깥으로 O 만큼 더 나간 띠는 외곽선 (BIBLE §5 "두꺼운 갈색 외곽선")
// 슈퍼샘플링 3x3 으로 계단을 없앤다. 모든 글리프가 같은 캔버스라 자릿수가 흔들리지 않는다.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT_DIR = 'C:/workspace/DungeonButcher/dungeon-butcher/game/assets/resources/fonts';

// ── 규격 (임의) ──
const CANVAS_W = 80, CANVAS_H = 104;   // 전 글리프 공통 — 자릿수 정렬
const OX = 12, OY = 12;                // 획 좌표계 원점
const R = 9;                           // 획 반두께
const O = 4.5;                         // 외곽선 두께
const D = 7;                           // 압출 깊이 (아래로)
const SS = 3;                          // 슈퍼샘플링

// 색 (채색 카툰 톤 — 밝은 채도 + 갈색 외곽선)
const C_FACE_TOP = [255, 138, 110];    // 윗면 밝은 쪽
const C_FACE_BOT = [214, 33, 27];      // 윗면 어두운 쪽
const C_RIM = [255, 214, 196];         // 상단 안쪽 광택
const C_SIDE = [138, 22, 18];          // 압출 측면
const C_LINE = [74, 36, 24];           // 갈색 외곽선

/** 타원 호 샘플링 — a0→a1 (도). y는 위가 +sin (수학 방향), 이미지 좌표로는 위쪽 */
function arc(cx, cy, rx, ry, a0, a1, n = 28) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const a = (a0 + ((a1 - a0) * i) / n) * Math.PI / 180;
        pts.push([cx + rx * Math.cos(a), cy - ry * Math.sin(a)]);
    }
    return pts;
}
const ring = (cx, cy, rx, ry) => arc(cx, cy, rx, ry, 0, 360, 44);

/**
 * 글리프 = 서브패스(폴리라인) 목록. 획 좌표계는 52×68 박스 기준 (y 아래로 증가).
 * 숫자는 굵은 획으로 단순화한 형태 — 작게 떠오르는 팝업이라 디테일보다 가독성 우선.
 */
const GLYPHS = {
    '0': [ring(26, 34, 17, 29)],
    '1': [[[12, 17], [26, 6]], [[26, 6], [26, 62]], [[11, 62], [41, 62]]],
    '2': [arc(26, 21, 17, 15, 195, -35), [[40, 29], [9, 62]], [[9, 62], [44, 62]]],
    '3': [arc(26, 20, 16, 14, 155, -85), arc(26, 47, 18, 17, 85, -160)],
    '4': [[[38, 3], [5, 49]], [[5, 49], [50, 49]], [[38, 3], [38, 62]]], // 카운터(삼각 구멍)가 막히지 않게 넉넉히
    '5': [[[45, 7], [15, 7]], [[15, 7], [15, 31]], arc(26, 45, 18, 17, 105, -155)],
    '6': [arc(26, 32, 18, 26, 65, 250), ring(26, 50, 16, 15)],
    '7': [[[8, 8], [46, 8]], [[46, 8], [21, 62]]],
    '8': [ring(26, 19, 15, 14), ring(26, 48, 17, 17)],
    '9': [ring(26, 19, 16, 15), arc(26, 36, 18, 26, 30, -85)], // 꼬리는 곧게 내려오게 (말리면 8처럼 보임)
    '-': [[[9, 34], [43, 34]]],
};

/** 점 → 선분 최단거리 */
function distSeg(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const wx = px - ax, wy = py - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
    return Math.hypot(dx, dy);
}

/** 점 → 글리프 획 중심선 최단거리 */
function distGlyph(px, py, subpaths) {
    let best = Infinity;
    for (const pts of subpaths) {
        for (let i = 0; i + 1 < pts.length; i++) {
            const d = distSeg(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
            if (d < best) best = d;
        }
    }
    return best;
}

const lerp = (a, b, t) => a + (b - a) * t;

function renderGlyph(subpaths) {
    // 획 y 범위 — 윗면 그라데이션 기준
    let minY = Infinity, maxY = -Infinity;
    for (const pts of subpaths) for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }

    const buf = Buffer.alloc(CANVAS_W * CANVAS_H * 4);
    for (let y = 0; y < CANVAS_H; y++) {
        for (let x = 0; x < CANVAS_W; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const gx = x + (sx + 0.5) / SS - OX;
                    const gy = y + (sy + 0.5) / SS - OY;
                    const dFace = distGlyph(gx, gy, subpaths);
                    const dSide = distGlyph(gx, gy - D, subpaths); // 아래로 밀린 압출면
                    let c = null;
                    if (dFace <= R) {
                        const t = Math.max(0, Math.min(1, (gy - minY) / Math.max(1, maxY - minY)));
                        c = [lerp(C_FACE_TOP[0], C_FACE_BOT[0], t),
                             lerp(C_FACE_TOP[1], C_FACE_BOT[1], t),
                             lerp(C_FACE_TOP[2], C_FACE_BOT[2], t)];
                        // 획 위쪽 안쪽 테두리에 광택 — 둥글게 부푼 느낌
                        if (dFace > R - 3.2 && distGlyph(gx, gy + 2.2, subpaths) < dFace) c = C_RIM;
                    } else if (dSide <= R) {
                        c = C_SIDE;
                    } else if (dFace <= R + O || dSide <= R + O) {
                        c = C_LINE;
                    }
                    if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
                }
            }
            const n = SS * SS;
            const i = (y * CANVAS_W + x) * 4;
            if (a > 0) {
                buf[i] = Math.round(r / (a / 255));      // 커버리지로 나눠 색 보존
                buf[i + 1] = Math.round(g / (a / 255));
                buf[i + 2] = Math.round(b / (a / 255));
                buf[i + 3] = Math.round(a / n);
            }
        }
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

// 글자 → 파일명 (파일명은 영문 스네이크케이스 규약)
const NAME = { '-': 'dmg_dash' };
for (const ch of Object.keys(GLYPHS)) {
    const name = NAME[ch] ?? `dmg_${ch}`;
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
console.log('완료 —', OUT_DIR);
